import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchEffectiveEconomics } from "../lib/sales-economics-client.js";
import { projectOutcomeCosts, orP, singleStepRateDecimal, formSubmissionRatesDecimal, type ProjectionEconomics } from "../lib/funnel-registry.js";
import { isGoal, matchSingleStepGoal, matchFormSubmissionGoal, type Goal } from "../lib/goals.js";
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
  /** The conversion rate carries provenance (grain) but NO numeric sample: it comes from the brand's
   *  saved sales-economics (brand-service), which expose no per-grain observation count
   *  (brand-service#242). Always null here. The empirical sample behind a candidate lives ENTIRELY on
   *  the COST side (`cost.sampleSize`, at `cost.grain`) — do NOT read the cost sample as the
   *  conversion sample. */
  sampleSize: null;
}

/** The sample behind a candidate's COST evidence, AT `cost.grain`. */
interface CostSampleSize {
  /** Completed runs behind the cost evidence (chain-aggregated for goal-global, audience-scoped for audience). */
  runs: number;
  contacted: number;
  clicks: number;
  replies: number;
}

interface CostEvidence {
  /** Cost per contacted lead (USD). Null when there is no contacted-lead denominator. */
  costPerLeadUsd: number | null;
  clickUsd: number | null;
  replyUsd: number | null;
  /** Cost-evidence grain: "goal-global" = cross-org workflow unit costs (same source as
   *  /public/stats/best); "audience" = audience-attributed cost (same source as /audience-stats). */
  grain: "goal-global" | "audience";
  /** The sample behind THIS cost evidence, at `grain` above. On coarse rows `grain` is "goal-global"
   *  → this is the CROSS-ORG cost population (thousands of contacted, tens of thousands of runs), NOT
   *  the brand's own activity. On audience rows `grain` is "audience" → the audience's own attributed
   *  slice. The sample lives here (not at the candidate top level) precisely so a fresh brand's
   *  cross-org cost sample is never mis-read as that brand's own evidence. */
  sampleSize: CostSampleSize;
}

interface Candidate {
  /** Audience lever — null until this endpoint reads real audience-grain producer evidence. */
  audienceId: string | null;
  workflow: { workflowDynastySlug: string; workflowDynastyName: string | null };
  goal: Goal;
  /** SUMMARY label: the FINEST grain reached across this candidate's evidence components
   *  (audience > brand-goal > goal-global). It does NOT describe the sample, and the two evidence
   *  components can resolve at DIFFERENT grains — read `conversion.grain` for the conversion rate's
   *  provenance and `cost.grain` + `cost.sampleSize` for the cost evidence's provenance and size.
   *  On a coarse row this can read "brand-goal" (the brand's own economics) while `cost.grain` is
   *  "goal-global" (cross-org cost sample). */
  grain: Grain;
  /** The goal metric: cost per goal-outcome (USD). Null when economics are absent (cold start). */
  costPerOutcomeUsd: number | null;
  /** Cost to acquire one paying client (cost per close = cost per PURCHASE), at this row's grain.
   *  Same definition/source as workflow-projection's costPerCloseUsd (projectOutcomeCosts →
   *  costPerPurchaseUsd). Null when economics are absent (cold start) or no usable close projection. */
  costPerCloseUsd: number | null;
  /** Lifetime ROI multiple = lifetime-revenue-per-client / costPerCloseUsd (= 100 / cacPct),
   *  budget-independent, at this row's grain. Same definition as workflow-projection's roiMultiple.
   *  Null when economics are absent or costPerCloseUsd is null/0. */
  roiMultiple: number | null;
  /** CAC as a share of lifetime revenue (%) = costPerCloseUsd / lifetime-revenue-per-client × 100
   *  (= 100 / roiMultiple), budget-independent, at this row's grain. Same definition as
   *  workflow-projection's cacPct. Null when economics are absent or costPerCloseUsd is null/0. */
  cacPct: number | null;
  conversion: ConversionEvidence;
  cost: CostEvidence;
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
    case "websiteVisit":
      // P(paid client | visit) — single step. econ.v2pc is set fail-loud in the handler for this goal.
      if (econ.v2pc == null) throw new Error("v2pc unset while resolving websiteVisit conversion rate");
      return econ.v2pc;
    case "positiveReply":
      // P(paid client | positive reply) — single step. Reply-route rate, not click-route, but exposed
      // as this goal's conversion signal alongside its cost.
      if (econ.r2pc == null) throw new Error("r2pc unset while resolving positiveReply conversion rate");
      return econ.r2pc;
    case "formSubmission":
      // P(form submission | click) — two-step self-serve micro-conversion (click route), the signal
      // the form_submissions goal ranks on. econ.v2fs is set fail-loud in the handler for this goal.
      if (econ.v2fs == null) throw new Error("v2fs unset while resolving formSubmission conversion rate");
      return econ.v2fs;
  }
}

/**
 * Cost-per-close (cost per PURCHASE, the paying-client acquisition cost), the lifetime ROI multiple
 * (LTR / costPerClose = 100 / cacPct), and its inverse CAC-as-share-of-lifetime-revenue (cacPct =
 * 100 / roiMultiple), at this candidate's grain. Mirrors the workflow-projection definitions EXACTLY,
 * single-sourced through `projectOutcomeCosts` over the SAME unit costs the rest of the row uses (so
 * audience rows resolve audience-grain unit costs, coarse rows cross-org). All null when economics
 * are absent (cold start) or there is no usable close projection. cacPct is derived from roiMultiple
 * so the two stay consistent by construction (roiMultiple === 100 / cacPct).
 */
function closeEconomicsForCandidate(
  econ: ProjectionEconomics | null,
  ltrUsd: number | null,
  unitCosts: { clickUsd: number | null; replyUsd: number | null },
): { costPerCloseUsd: number | null; roiMultiple: number | null; cacPct: number | null } {
  if (!econ) return { costPerCloseUsd: null, roiMultiple: null, cacPct: null };
  const costPerCloseUsd = projectOutcomeCosts(econ, unitCosts).costPerPurchaseUsd;
  const roiMultiple =
    ltrUsd != null && costPerCloseUsd != null && costPerCloseUsd > 0 ? ltrUsd / costPerCloseUsd : null;
  const cacPct = roiMultiple != null && roiMultiple > 0 ? 100 / roiMultiple : null;
  return { costPerCloseUsd, roiMultiple, cacPct };
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
    case "websiteVisit":
      return projected.costPerVisitPaidClientUsd;
    case "positiveReply":
      return projected.costPerReplyPaidClientUsd;
    case "formSubmission":
      return projected.costPerFormSubmissionUsd;
  }
}

// ── GET /features/:featureSlug/candidates ────────────────────────────────────
//
// Serves the (audienceId, workflow) CANDIDATE SET for runtime per-lead selection — each
// candidate with its OWN cost-per-outcome evidence, CONVERSION and COST evidence kept separate (each
// labelled with its own grain), and the SAMPLE SIZE living WITH the cost evidence it describes
// (`cost.sampleSize` at `cost.grain`) so a coarse row's cross-org cost sample is never mis-read as the
// brand's own activity. The conversion rate carries provenance but no count. Deliberately does NOT collapse to a single
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
  // Normalise the single-step goal's fleet spellings (snake/kebab → canonical camel) before validating;
  // legacy goals pass through unchanged. campaign-service forwards the brand's `currentGoal` verbatim.
  const normalizedGoal = goalParam
    ? (matchSingleStepGoal(goalParam) ?? matchFormSubmissionGoal(goalParam) ?? goalParam)
    : undefined;
  if (!isGoal(normalizedGoal)) {
    return res.status(400).json({ error: "goal query parameter is required and must be one of: signup, meetingBooked, purchase, websiteVisit, positiveReply, formSubmission" });
  }
  const goal: Goal = normalizedGoal;

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
    // Lifetime revenue per paying client — the ROI numerator (roiMultiple = ltrUsd / costPerCloseUsd).
    // Null only at cold start (no economics); econ is non-null iff economics is, so ltr is present then.
    const ltrUsd = economics?.lifetimeRevenueUsd ?? null;

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
          // Single-step rate resolved (fail-loud on genuinely-absent field) ONLY for the requested
          // single-step goal — the legacy goals never read v2pc / r2pc.
          ...(goal === "websiteVisit" ? { v2pc: singleStepRateDecimal(economics, "websiteVisit") } : {}),
          ...(goal === "positiveReply" ? { r2pc: singleStepRateDecimal(economics, "positiveReply") } : {}),
          // Two-step form-submission rates resolved (fail-loud) ONLY for the form_submissions goal.
          ...(goal === "formSubmission" ? formSubmissionRatesDecimal(economics) : {}),
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
      const { costPerCloseUsd, roiMultiple, cacPct } = closeEconomicsForCandidate(econ, ltrUsd, { clickUsd, replyUsd });

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
        costPerCloseUsd,
        roiMultiple,
        cacPct,
        conversion: { rate: conversionRate, grain: conversionGrain, sampleSize: null },
        cost: {
          costPerLeadUsd: contactedUsd,
          clickUsd,
          replyUsd,
          grain: "goal-global",
          sampleSize: { runs: cost.completedRuns, contacted, clicks, replies },
        },
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
      const { costPerCloseUsd: aCostPerCloseUsd, roiMultiple: aRoiMultiple, cacPct: aCacPct } = closeEconomicsForCandidate(econ, ltrUsd, { clickUsd: aClickUsd, replyUsd: aReplyUsd });

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
          costPerCloseUsd: aCostPerCloseUsd,
          roiMultiple: aRoiMultiple,
          cacPct: aCacPct,
          conversion: { rate: aConversionRate, grain: conversionGrain, sampleSize: null },
          cost: {
            costPerLeadUsd: aContactedUsd,
            clickUsd: aClickUsd,
            replyUsd: aReplyUsd,
            grain: "audience",
            sampleSize: { runs: ev.completedRuns, contacted: ev.contacted, clicks: ev.clicks, replies: ev.replies },
          },
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
