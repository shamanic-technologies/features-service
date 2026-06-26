import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchEffectiveEconomics } from "../lib/sales-economics-client.js";
import { projectOutcomeCosts } from "../lib/funnel-registry.js";
import {
  fetchPublicWorkflows,
  fetchPublicCosts,
  fetchPublicEmailStats,
} from "../lib/public-stats-clients.js";
import { buildUpgradeChains, aggregateAcrossChains } from "./public.js";

const router = Router();

// Target outcomes/month used to size the recommended budget (recommendedBudgetUsd = TARGET × best metric).
const TARGET_OUTCOMES_PER_MONTH = 10;

type Objective = "meeting-booked" | "self-serve" | "signup" | "purchase";

// Brand sales-economics as decimals (brand-service stores percentages 0–100).
interface BrandEcon {
  ltv: number; // lifetime revenue per close (USD)
  r2m: number; // P(meeting | positive reply)
  v2m: number; // P(meeting | click/visit)
  m2c: number; // P(close | meeting)
  v2c: number; // P(close | click/visit) — direct, self-serve path
  v2s: number; // P(signup | click/visit) — self-serve signup
}

interface Projection {
  contactedLeads: number | null;
  replies: number | null;
  visits: number | null;
  signups: number | null;
  meetings: number | null;
  closes: number | null;
  revenue: number | null;
  cacPct: number | null;
  cacAbs: number | null;
}

interface WorkflowProjection {
  workflowDynastySlug: string;
  workflowDynastyName: string | null;
  contactedUsd: number | null;
  replyUsd: number | null;
  clickUsd: number | null;
  costPerSignupUsd: number | null;
  costPerCloseUsd: number | null;
  costPerMeetingBookedUsd: number | null;
  /**
   * Lifetime ROI multiple for this workflow = LTR / costPerCloseUsd (revenue returned per dollar spent
   * to acquire one close). Budget-independent (= 100 / cacPct), so present even without budgetUsd. The
   * dashboard renders this verbatim instead of inverting cacPct (100/cacPct) in the browser. Null when
   * economics are absent or costPerCloseUsd is null/0. (features-service#396)
   */
  roiMultiple: number | null;
  projection: Projection | null;
}

interface WorkflowProjectionResponse {
  featureSlug: string;
  objective: Objective;
  workflows: WorkflowProjection[];
  recommendedWorkflowDynastySlug: string | null;
  recommendedBudgetUsd: number | null;
}

/**
 * Cost-per-outcome + (optional) budget projection for one workflow, given its unit costs and the
 * brand's economics. Same funnel as the revenue engine:
 *   - a click closes via TWO independent (non-exclusive) routes — direct self-serve (v2c, "buy
 *     without a meeting") OR via a booked meeting (v2m·m2c) — combined with orP:
 *       pCloseClick = orP(v2c, v2m·m2c)
 *   - a positive reply closes via a meeting: pCloseReply = r2m·m2c
 * At the population/expected-count level the click-volume and reply-volume channels ADD by linearity
 * of expectation (distinct from the per-lead engine, which OR-combines click vs reply):
 *   closesPerBudget = (1/clickUsd)·pCloseClick + (1/replyUsd)·pCloseReply
 *
 * Signups are click-only: (1/clickUsd)·v2s.
 * Meetings stop one stage earlier than closes: (1/clickUsd)·v2m + (1/replyUsd)·r2m.
 * A route with a null unit cost contributes 0. perBudget ≤ 0 → no usable data → null for that metric.
 */
function project(
  contactedUsd: number | null,
  replyUsd: number | null,
  clickUsd: number | null,
  econ: BrandEcon,
  budgetUsd: number | null,
): { costPerSignupUsd: number | null; costPerCloseUsd: number | null; costPerMeetingBookedUsd: number | null; projection: Projection | null } {
  // Outcome costs are single-sourced from the shared projection helper (same EV funnel as the
  // public cost-projection endpoint, candidates endpoint, and revenue engine).
  const { costPerSignupUsd, costPerPurchaseUsd, costPerMeetingBookedUsd } = projectOutcomeCosts(econ, { clickUsd, replyUsd });
  const costPerCloseUsd = costPerPurchaseUsd;

  if (budgetUsd == null || budgetUsd <= 0) return { costPerSignupUsd, costPerCloseUsd, costPerMeetingBookedUsd, projection: null };

  const contactedLeads = contactedUsd != null ? budgetUsd / contactedUsd : null;
  const replies = replyUsd != null ? budgetUsd / replyUsd : null;
  const visits = clickUsd != null ? budgetUsd / clickUsd : null;
  const signups = visits != null ? visits * econ.v2s : null;
  // Meetings come from BOTH routes (reply→meeting and click→meeting), regardless of objective.
  const meetings = (replies ?? 0) * econ.r2m + (visits ?? 0) * econ.v2m;
  const closes = costPerCloseUsd != null ? budgetUsd / costPerCloseUsd : null; // = budgetUsd × closesPerBudget
  const revenue = closes != null ? closes * econ.ltv : null;
  const cacPct = revenue != null && revenue > 0 ? (budgetUsd / revenue) * 100 : null;
  const cacAbs = closes != null && closes > 0 ? budgetUsd / closes : null;

  return { costPerSignupUsd, costPerCloseUsd, costPerMeetingBookedUsd, projection: { contactedLeads, replies, visits, signups, meetings, closes, revenue, cacPct, cacAbs } };
}

// ── GET /features/:featureSlug/workflow-projection ───────────────────────────
//
// Ranks a brand's workflows by the requested objective's cost-per-outcome (reply + click routes
// funded by one budget) and — when budgetUsd is given — projects that budget through the funnel.
// Inputs: per-workflow unit costs (cost /
// positive reply, cost / click) are GLOBAL workflow efficiency (cross-org, feature-scoped, same
// source as /public/stats/best); the conversion rates + LTR come from the brand's EFFECTIVE
// sales-economics (its own saved set, or the cross-brand-average when unset — brand-service owns the
// defaulting; null only at cold start). features-service computes; the dashboard renders.

router.get("/features/:featureSlug/workflow-projection", apiKeyAuth, async (req, res) => {
  const { featureSlug } = req.params;
  const { orgId, userId, runId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;
  const brandId = req.query.brandId as string | undefined;
  const objectiveParam = req.query.objective as string | undefined;
  const budgetRaw = req.query.budgetUsd as string | undefined;

  if (!brandId) {
    return res.status(400).json({ error: "brandId query parameter is required" });
  }
  // Default meeting-booked when absent/invalid for response back-compat.
  const objective: Objective =
    objectiveParam === "self-serve" || objectiveParam === "signup" || objectiveParam === "purchase"
      ? objectiveParam
      : "meeting-booked";
  const budgetUsd = budgetRaw != null && budgetRaw !== "" ? Number(budgetRaw) : null;

  try {
    const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
    if (!feature) {
      return res.status(404).json({ error: "Feature not found" });
    }

    // Per-workflow GLOBAL unit costs (cross-org) + brand-scoped EFFECTIVE economics, fetched together.
    // brand-service OWNS the null→cross-brand-average defaulting (source "user" = the brand's own saved
    // set; "cross-brand-average" = the org-wide estimate). economics is null ONLY at cold start (no brand
    // has saved economics yet) → cost-per-close genuinely incomputable → null budget. features-service
    // reimplements no averaging — it just consumes whatever brand-service deems effective.
    const [workflows, costGroups, emailStats, effective] = await Promise.all([
      fetchPublicWorkflows(featureSlug, "all"),
      fetchPublicCosts(featureSlug, "workflowSlug"),
      fetchPublicEmailStats(featureSlug, "workflowSlug"),
      fetchEffectiveEconomics(brandId, { orgId, userId, runId, featureSlug: headerFeatureSlug }),
    ]);
    const economics = effective.economics;

    // Aggregate per-version cost + outcomes into the active workflow (dynasty upgrade chain),
    // exactly as /public/stats/best|ranked do — so a workflow's stats include its predecessors'.
    const chains = buildUpgradeChains(workflows);
    const { costMap, aggregatedOutcomes } = aggregateAcrossChains(chains, costGroups, emailStats, "workflowSlug");
    const workflowBySlug = new Map(workflows.map((w) => [w.workflowSlug, w]));

    const econ: BrandEcon | null = economics
      ? {
          ltv: economics.lifetimeRevenueUsd,
          r2m: economics.replyToMeetingPct / 100,
          v2m: economics.visitToMeetingPct / 100,
          m2c: economics.meetingToClosePct / 100,
          v2c: economics.visitToClosePct / 100,
          v2s: economics.visitToSignupPct / 100,
        }
      : null;

    const projections: WorkflowProjection[] = [];
    for (const [activeSlug, cost] of costMap) {
      const wf = workflowBySlug.get(activeSlug);
      const outcomes = aggregatedOutcomes.get(activeSlug) ?? {};
      const costUsd = cost.totalCostInUsdCents / 100;
      const contacted = outcomes.recipientsContacted ?? 0;
      const replies = outcomes.recipientsRepliesPositive ?? 0;
      const clicks = outcomes.recipientsClicked ?? 0;

      const contactedUsd = Number.isFinite(contacted) && contacted > 0 && costUsd > 0 ? costUsd / contacted : null;
      const replyUsd = replies > 0 && costUsd > 0 ? costUsd / replies : null;
      const clickUsd = clicks > 0 && costUsd > 0 ? costUsd / clicks : null;

      const { costPerSignupUsd, costPerCloseUsd, costPerMeetingBookedUsd, projection } = econ
        ? project(contactedUsd, replyUsd, clickUsd, econ, budgetUsd)
        : { costPerSignupUsd: null, costPerCloseUsd: null, costPerMeetingBookedUsd: null, projection: null };

      // ROI multiple = revenue per acquisition dollar = LTR / costPerClose. Budget-independent
      // (= 100 / cacPct). The dashboard renders this instead of inverting cacPct client-side.
      const roiMultiple =
        econ && costPerCloseUsd != null && costPerCloseUsd > 0 ? econ.ltv / costPerCloseUsd : null;

      projections.push({
        workflowDynastySlug: wf?.workflowDynastySlug ?? activeSlug,
        workflowDynastyName: wf?.workflowDynastyName ?? null,
        contactedUsd,
        replyUsd,
        clickUsd,
        costPerSignupUsd,
        costPerCloseUsd,
        costPerMeetingBookedUsd,
        roiMultiple,
        projection,
      });
    }

    const recommendedMetric = (p: WorkflowProjection): number | null => {
      if (objective === "meeting-booked") return p.costPerMeetingBookedUsd;
      if (objective === "purchase") return p.costPerCloseUsd;
      return p.costPerSignupUsd;
    };

    // Recommendation: the workflow with the LOWEST usable cost-per-outcome for the requested objective.
    let recommended: WorkflowProjection | null = null;
    for (const p of projections) {
      const metric = recommendedMetric(p);
      if (metric == null) continue;
      const current = recommended == null ? null : recommendedMetric(recommended);
      if (current == null || metric < current) recommended = p;
    }

    const recommendedCost = recommended == null ? null : recommendedMetric(recommended);
    const response: WorkflowProjectionResponse = {
      featureSlug,
      objective,
      workflows: projections,
      recommendedWorkflowDynastySlug: recommended?.workflowDynastySlug ?? null,
      recommendedBudgetUsd: recommendedCost != null ? TARGET_OUTCOMES_PER_MONTH * recommendedCost : null,
    };
    res.json(response);
  } catch (error) {
    console.error("[features-service] Workflow projection error:", error);
    res.status(502).json({ error: "Failed to compute workflow projection" });
  }
});

export default router;
