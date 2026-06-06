import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchSalesEconomics } from "../lib/sales-economics-client.js";
import {
  fetchPublicWorkflows,
  fetchPublicCosts,
  fetchPublicEmailStats,
} from "../lib/public-stats-clients.js";
import { buildUpgradeChains, aggregateAcrossChains } from "./public.js";

const router = Router();

// Target closes/month used to size the recommended budget (recommendedBudgetUsd = TARGET × best cpc).
const TARGET_CLOSES_PER_MONTH = 10;

type Objective = "meeting-booked" | "self-serve";

// Brand sales-economics as decimals (brand-service stores percentages 0–100).
interface BrandEcon {
  ltv: number; // lifetime revenue per close (USD)
  r2m: number; // P(meeting | positive reply)
  v2m: number; // P(meeting | click/visit)
  m2c: number; // P(close | meeting)
  v2c: number; // P(close | click/visit) — direct, self-serve path
}

interface Projection {
  replies: number | null;
  visits: number | null;
  meetings: number | null;
  closes: number | null;
  revenue: number | null;
  cacPct: number | null;
  cacAbs: number | null;
}

interface WorkflowProjection {
  workflowDynastySlug: string;
  workflowDynastyName: string | null;
  replyUsd: number | null;
  clickUsd: number | null;
  costPerCloseUsd: number | null;
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
 * Cost-per-close + (optional) budget projection for one workflow, given its unit costs and the
 * brand's economics. Same funnel rule as the revenue engine — the two engagement routes (reply +
 * click) are SUMMED, funded by the same budget — but here at the population/expected-count level,
 * so route volumes ADD (linearity of expectation), they are not OR'd as the per-lead engine does.
 *
 *   meeting-booked: closesPerBudget = m2c · ((1/replyUsd)·r2m + (1/clickUsd)·v2m)
 *   self-serve:     closesPerBudget = (1/clickUsd)·v2c
 *
 * A route with a null unit cost contributes 0. closesPerBudget ≤ 0 → no usable data → both null.
 */
function project(
  objective: Objective,
  replyUsd: number | null,
  clickUsd: number | null,
  econ: BrandEcon,
  budgetUsd: number | null,
): { costPerCloseUsd: number | null; projection: Projection | null } {
  const isMeeting = objective === "meeting-booked";

  const closesPerBudget = isMeeting
    ? ((replyUsd != null ? (1 / replyUsd) * econ.r2m : 0) +
        (clickUsd != null ? (1 / clickUsd) * econ.v2m : 0)) * econ.m2c
    : clickUsd != null ? (1 / clickUsd) * econ.v2c : 0;

  if (closesPerBudget <= 0) return { costPerCloseUsd: null, projection: null };
  const costPerCloseUsd = 1 / closesPerBudget;

  if (budgetUsd == null || budgetUsd <= 0) return { costPerCloseUsd, projection: null };

  const replies = isMeeting && replyUsd != null ? budgetUsd / replyUsd : null;
  const visits = clickUsd != null ? budgetUsd / clickUsd : null;
  const meetings = isMeeting ? (replies ?? 0) * econ.r2m + (visits ?? 0) * econ.v2m : null;
  const closes = budgetUsd * closesPerBudget;
  const revenue = closes * econ.ltv;
  const cacPct = revenue > 0 ? (budgetUsd / revenue) * 100 : null;
  const cacAbs = closes > 0 ? budgetUsd / closes : null;

  return { costPerCloseUsd, projection: { replies, visits, meetings, closes, revenue, cacPct, cacAbs } };
}

// ── GET /features/:featureSlug/workflow-projection ───────────────────────────
//
// Ranks a brand's workflows by combined cost-per-close (reply + click routes funded by one budget)
// for an objective, and — when budgetUsd is given — projects that budget through the funnel. Inputs:
// per-workflow unit costs (cost / positive reply, cost / click) are GLOBAL workflow efficiency
// (cross-org, feature-scoped, same source as /public/stats/best); the conversion rates + LTR come
// from the brand's saved sales-economics. features-service computes; the dashboard renders.

router.get("/features/:featureSlug/workflow-projection", apiKeyAuth, async (req, res) => {
  const { featureSlug } = req.params;
  const { orgId, userId, runId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;
  const brandId = req.query.brandId as string | undefined;
  const objectiveParam = req.query.objective as string | undefined;
  const budgetRaw = req.query.budgetUsd as string | undefined;

  if (!brandId) {
    return res.status(400).json({ error: "brandId query parameter is required" });
  }
  if (objectiveParam !== "meeting-booked" && objectiveParam !== "self-serve") {
    return res.status(400).json({ error: "objective query parameter is required and must be 'meeting-booked' or 'self-serve'" });
  }
  const objective: Objective = objectiveParam;
  const budgetUsd = budgetRaw != null && budgetRaw !== "" ? Number(budgetRaw) : null;

  try {
    const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
    if (!feature) {
      return res.status(404).json({ error: "Feature not found" });
    }

    // Per-workflow GLOBAL unit costs (cross-org) + brand-scoped economics, fetched together.
    const [workflows, costGroups, emailStats, economics] = await Promise.all([
      fetchPublicWorkflows(featureSlug, "all"),
      fetchPublicCosts(featureSlug, "workflowSlug"),
      fetchPublicEmailStats(featureSlug, "workflowSlug"),
      fetchSalesEconomics(brandId, { orgId, userId, runId, featureSlug: headerFeatureSlug }),
    ]);

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
        }
      : null;

    const projections: WorkflowProjection[] = [];
    for (const [activeSlug, cost] of costMap) {
      const wf = workflowBySlug.get(activeSlug);
      const outcomes = aggregatedOutcomes.get(activeSlug) ?? {};
      const costUsd = cost.totalCostInUsdCents / 100;
      const replies = outcomes.recipientsRepliesPositive ?? 0;
      const clicks = outcomes.recipientsClicked ?? 0;

      const replyUsd = replies > 0 && costUsd > 0 ? costUsd / replies : null;
      const clickUsd = clicks > 0 && costUsd > 0 ? costUsd / clicks : null;

      const { costPerCloseUsd, projection } = econ
        ? project(objective, replyUsd, clickUsd, econ, budgetUsd)
        : { costPerCloseUsd: null, projection: null };

      projections.push({
        workflowDynastySlug: wf?.workflowDynastySlug ?? activeSlug,
        workflowDynastyName: wf?.workflowDynastyName ?? null,
        replyUsd,
        clickUsd,
        costPerCloseUsd,
        projection,
      });
    }

    // Recommendation: the workflow with the LOWEST usable cost-per-close.
    let recommended: WorkflowProjection | null = null;
    for (const p of projections) {
      if (p.costPerCloseUsd == null) continue;
      if (recommended == null || p.costPerCloseUsd < recommended.costPerCloseUsd!) recommended = p;
    }

    const response: WorkflowProjectionResponse = {
      featureSlug,
      objective,
      workflows: projections,
      recommendedWorkflowDynastySlug: recommended?.workflowDynastySlug ?? null,
      recommendedBudgetUsd: recommended != null ? TARGET_CLOSES_PER_MONTH * recommended.costPerCloseUsd! : null,
    };
    res.json(response);
  } catch (error) {
    console.error("[features-service] Workflow projection error:", error);
    res.status(502).json({ error: "Failed to compute workflow projection" });
  }
});

export default router;
