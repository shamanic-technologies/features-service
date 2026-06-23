import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchEffectiveEconomics } from "../lib/sales-economics-client.js";
import { projectOutcomeCosts, orP, type ProjectionEconomics } from "../lib/funnel-registry.js";
import { isGoal, type Goal } from "../lib/goals.js";
import {
  fetchPublicWorkflows,
  fetchPublicCosts,
  fetchPublicEmailStats,
} from "../lib/public-stats-clients.js";
import { fetchAudienceCandidateEvidence } from "../lib/candidates-audience.js";
import { buildUpgradeChains, aggregateAcrossChains } from "./public.js";

const router = Router();

// ── Fallback grain ladder ────────────────────────────────────────────────────
//
// Finest → coarsest evidence grain (per features-service#298):
//   "audience"     = brandId × goal × audienceId (audience-grain attributed evidence)
//   "brand-goal"  = brandId × goal (drop the audience dimension)
//   "goal-global" = goal / cross-org global (workflow evidence only)
//
// The "audience" rung is LIVE: for each ACTIVE human-service audience that has runs-attributed
// (audienceId × workflowDynastySlug) couples, this endpoint emits one audience-grain candidate
// per couple — `audienceId` populated, cost + sampleSize scoped to the audience slice (same
// source as /audience-stats). Couples with no audience-level evidence still resolve through the
// coarser ladder below (audienceId stays null), so existing per-workflow consumers see no change.
type Grain = "audience" | "brand-goal" | "goal-global";

interface ConversionEvidence {
  /** P(goal-outcome | engaged click), from the brand's effective sales-economics. Null at cold start. */
  rate: number | null;
  /** Provenance of the conversion rate: "brand-goal" = the brand's own saved economics; "goal-global"
   *  = the cross-org average fallback; null when no economics exist yet (cold start). */
  grain: Exclude<Grain, "audience"> | null;
}

interface CostEvidence {
  /** Cost per contacted lead (USD). Null when there is no contacted-lead denominator. */
  costPerLeadUsd: number | null;
  clickUsd: number | null;
  replyUsd: number | null;
  /** Cost-evidence grain: "goal-global" = cross-org workflow unit costs (same source as
   *  /public/stats/best); "audience" = audience-attributed cost (same source as /audience-stats). */
  grain: "goal-global" | "audience";
}

interface SampleSize {
  /** Completed runs behind this candidate's cost evidence (chain-aggregated). */
  runs: number;
  contacted: number;
  clicks: number;
  replies: number;
}

interface Candidate {
  /** Audience lever — null until this endpoint reads real audience-grain producer evidence. */
  audienceId: string | null;
  workflow: { workflowDynastySlug: string; workflowDynastyName: string | null };
  goal: Goal;
  /** Finest grain at which this candidate's evidence resolved. */
  grain: Grain;
  /** The goal metric: cost per goal-outcome (USD). Null when economics are absent (cold start). */
  costPerOutcomeUsd: number | null;
  conversion: ConversionEvidence;
  cost: CostEvidence;
  sampleSize: SampleSize;
}

interface CandidatesResponse {
  featureSlug: string;
  brandId: string;
  goal: Goal;
  /** Brand-profile-version context echoed back. */
  brandProfileId: string | null;
  candidates: Candidate[];
}

/**
 * Per-click conversion probability for the goal, from the brand's economics. Exposed so the
 * consumer can reason about the CONVERSION signal separately from the COST signal (the goal is a
 * ratio: $/outcome = cost-per-lead / conversion-rate). Click-route based: the click is the
 * per-lead self-serve lever the cost denominators (clickUsd) are measured against.
 */
function conversionRateForGoal(goal: Goal, econ: ProjectionEconomics): number {
  switch (goal) {
    case "signup":
      return econ.v2s; // P(signup | click)
    case "meetingBooked":
      return econ.v2m; // P(meeting | click)
    case "purchase":
      return orP(econ.v2c, econ.v2m * econ.m2c); // P(close | click): self-serve OR via meeting
  }
}

function costPerOutcomeForGoal(
  goal: Goal,
  econ: ProjectionEconomics,
  unitCosts: { clickUsd: number | null; replyUsd: number | null },
): number | null {
  const projected = projectOutcomeCosts(econ, unitCosts);
  switch (goal) {
    case "signup":
      return projected.costPerSignupUsd;
    case "meetingBooked":
      return projected.costPerMeetingBookedUsd;
    case "purchase":
      return projected.costPerPurchaseUsd;
  }
}

// ── GET /features/:featureSlug/candidates ────────────────────────────────────
//
// Serves the (audienceId, workflow) CANDIDATE SET for runtime per-lead selection — each
// candidate with its OWN cost-per-outcome evidence, the SAMPLE SIZE behind it, CONVERSION and COST
// evidence kept separate, and a labelled fallback GRAIN. Deliberately does NOT collapse to a single
// "best": the consumer (campaign-service) owns the uncertainty-aware selection policy (Thompson-style
// draw). features-service owns stats + counts + fallback resolution only (features-service#298).
//
// Reuses the workflow-projection data path (global per-workflow unit costs aggregated over the
// upgrade chain + brand-scoped effective economics) for the coarse "brand-goal"/"goal-global" rungs,
// AND reads audience-attributed evidence (active human-service audiences × runs-service
// groupBy=audienceId couples + read-time membership outcomes) to emit the finest "audience" rung.
router.get("/features/:featureSlug/candidates", apiKeyAuth, async (req, res) => {
  const { featureSlug } = req.params;
  const { orgId, userId, runId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;
  const brandId = req.query.brandId as string | undefined;
  const goalParam = req.query.goal as string | undefined;
  const brandProfileId = (req.query.brandProfileId as string | undefined) ?? null;

  if (!brandId) {
    return res.status(400).json({ error: "brandId query parameter is required" });
  }
  if (!isGoal(goalParam)) {
    return res.status(400).json({ error: "goal query parameter is required and must be one of: signup, meetingBooked, purchase" });
  }
  const goal: Goal = goalParam;

  try {
    const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
    if (!feature) {
      return res.status(404).json({ error: "Feature not found" });
    }

    // Global per-workflow unit costs (cross-org) + outcomes + brand-scoped EFFECTIVE economics.
    // brand-service OWNS the null→cross-brand-average defaulting; features-service consumes it.
    const [workflows, costGroups, emailStats, effective, audienceEvidence] = await Promise.all([
      fetchPublicWorkflows(featureSlug, "all"),
      fetchPublicCosts(featureSlug, "workflowSlug"),
      fetchPublicEmailStats(featureSlug, "workflowSlug"),
      fetchEffectiveEconomics(brandId, { orgId, userId, runId, featureSlug: headerFeatureSlug }),
      fetchAudienceCandidateEvidence(brandId, featureSlug, { orgId, userId, runId, featureSlug: headerFeatureSlug }),
    ]);
    const economics = effective.economics;

    // Aggregate per-version cost + outcomes into the active workflow (dynasty upgrade chain),
    // exactly as workflow-projection / /public/stats do.
    const chains = buildUpgradeChains(workflows);
    const { costMap, aggregatedOutcomes } = aggregateAcrossChains(chains, costGroups, emailStats, "workflowSlug");
    const workflowBySlug = new Map(workflows.map((w) => [w.workflowSlug, w]));

    const econ: ProjectionEconomics | null = economics
      ? {
          r2m: economics.replyToMeetingPct / 100,
          v2m: economics.visitToMeetingPct / 100,
          m2c: economics.meetingToClosePct / 100,
          v2c: economics.visitToClosePct / 100,
          v2s: economics.visitToSignupPct / 100,
        }
      : null;

    // Conversion grain follows brand-service's economics provenance: "user" = the brand's own saved
    // set (brand-local) → "brand-goal"; "cross-brand-average" = org-wide fallback → "goal-global".
    const conversionGrain: ConversionEvidence["grain"] =
      effective.source === "user" ? "brand-goal" : effective.source === "cross-brand-average" ? "goal-global" : null;

    const candidates: Candidate[] = [];
    for (const [activeSlug, cost] of costMap) {
      const wf = workflowBySlug.get(activeSlug);
      const outcomes = aggregatedOutcomes.get(activeSlug) ?? {};
      const costUsd = cost.totalCostInUsdCents / 100;
      const contacted = outcomes.recipientsContacted ?? 0;
      const clicks = outcomes.recipientsClicked ?? 0;
      const replies = outcomes.recipientsRepliesPositive ?? 0;

      const contactedUsd = contacted > 0 && costUsd > 0 ? costUsd / contacted : null;
      const clickUsd = clicks > 0 && costUsd > 0 ? costUsd / clicks : null;
      const replyUsd = replies > 0 && costUsd > 0 ? costUsd / replies : null;

      const costPerOutcomeUsd = econ ? costPerOutcomeForGoal(goal, econ, { clickUsd, replyUsd }) : null;
      const conversionRate = econ ? conversionRateForGoal(goal, econ) : null;

      // Coarse rung — workflow evidence is cross-org (no audience attribution on this row), so
      // audienceId stays null. Brand-local economics → "brand-goal"; otherwise "goal-global".
      // The audience-attributed "audience" rows are appended after this loop.
      const audienceId: string | null = null;
      const grain: Grain = conversionGrain === "brand-goal" ? "brand-goal" : "goal-global";

      candidates.push({
        audienceId,
        workflow: {
          workflowDynastySlug: wf?.workflowDynastySlug ?? activeSlug,
          workflowDynastyName: wf?.workflowDynastyName ?? null,
        },
        goal,
        grain,
        costPerOutcomeUsd,
        conversion: { rate: conversionRate, grain: conversionGrain },
        cost: { costPerLeadUsd: contactedUsd, clickUsd, replyUsd, grain: "goal-global" },
        sampleSize: { runs: cost.completedRuns, contacted, clicks, replies },
      });
    }

    // ── "audience" rung — one candidate per (audienceId, workflowDynastySlug) couple that ran ──
    //
    // Cost + sampleSize are AUDIENCE-grain (coherent single grain: cost from runs
    // groupBy=audienceId, outcomes from read-time membership — same source as /audience-stats),
    // so cost-per-click / cost-per-reply stay self-consistent. Conversion is still the brand's
    // economics ladder (brand-service has no per-audience economics), so conversion.grain stays
    // brand-goal/goal-global; the audience's empirical tally rides in sampleSize for the consumer.
    const dynastyNameBySlug = new Map(workflows.map((w) => [w.workflowDynastySlug, w.workflowDynastyName]));
    for (const ev of audienceEvidence) {
      const costUsd = ev.totalCostInUsdCents / 100;
      const aContactedUsd = ev.contacted > 0 && costUsd > 0 ? costUsd / ev.contacted : null;
      const aClickUsd = ev.clicks > 0 && costUsd > 0 ? costUsd / ev.clicks : null;
      const aReplyUsd = ev.replies > 0 && costUsd > 0 ? costUsd / ev.replies : null;
      const aCostPerOutcomeUsd = econ ? costPerOutcomeForGoal(goal, econ, { clickUsd: aClickUsd, replyUsd: aReplyUsd }) : null;
      const aConversionRate = econ ? conversionRateForGoal(goal, econ) : null;

      for (const dynastySlug of ev.workflowDynastySlugs) {
        candidates.push({
          audienceId: ev.audienceId,
          workflow: {
            workflowDynastySlug: dynastySlug,
            workflowDynastyName: dynastyNameBySlug.get(dynastySlug) ?? null,
          },
          goal,
          grain: "audience",
          costPerOutcomeUsd: aCostPerOutcomeUsd,
          conversion: { rate: aConversionRate, grain: conversionGrain },
          cost: { costPerLeadUsd: aContactedUsd, clickUsd: aClickUsd, replyUsd: aReplyUsd, grain: "audience" },
          sampleSize: { runs: ev.completedRuns, contacted: ev.contacted, clicks: ev.clicks, replies: ev.replies },
        });
      }
    }

    const response: CandidatesResponse = { featureSlug, brandId, goal, brandProfileId, candidates };
    res.json(response);
  } catch (error) {
    console.error("[features-service] Candidates evidence error:", error);
    res.status(502).json({ error: "Failed to compute candidate evidence" });
  }
});

export default router;
