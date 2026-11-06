/**
 * OUTCOME-RUNG-AND-TARGET-1106: `GET /brands/:brandId/campaign-targets[?pricing=]` (customer Today page, one row of cards
 * per ongoing funnel campaign, on its Target). Composes reads the campaign already has: its funnel people (activity Gold
 * cell), its pipes' dated outcomes and its spend (spend charts Gold cell, net by default), its stored plan line (the
 * factory pass: the projection's cost per Target and the Target's value) and its daily budget (billing caps). Pure rule
 * in `lib/campaign-targets.ts`.
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import type { DownstreamHeaders } from "./revenue.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { parsePricing, type Pricing } from "../lib/pricing.js";
import { fetchSalesFunnelCampaigns, type SalesFunnelCampaignRow } from "../lib/sales-funnel-campaigns-client.js";
import { funnelCampaignActivity } from "./sales-funnel-campaign-activity.js";
import { funnelCampaignSpendCharts } from "./spend-charts.js";
import { readPlan } from "../lib/factory-shadow-store.js";
import { listOutcomeRungs } from "../lib/outcome-rungs-store.js";
import { fetchFunnelCampaignDailyBudgetUsd } from "../lib/funnel-campaign-budget-client.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { campaignTargetRowOf, sumCumulativeDays, type CampaignTargetRow } from "../lib/campaign-targets.js";

const router = Router();

interface StoredPlanFigures {
  costPerTargetUsd?: number | null;
  basis?: string | null;
  unavailableReason?: string | null;
  targetValueUsd?: number | null;
}
interface StoredPlanBody {
  plan?: {
    target?: string;
    mode?: "proactive" | "reactive";
    running?: { funnelId?: string; reachesTarget?: boolean; unavailableReason?: string; figures?: StoredPlanFigures | null } | null;
    shadow?: { funnelId?: string; figures?: StoredPlanFigures | null } | null;
    shadowUnavailableReason?: string | null;
  } | null;
}

const titleOf = (key: string) => key.split("_").map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");

async function rowFor(row: SalesFunnelCampaignRow, brandId: string, headers: DownstreamHeaders, pricing: Pricing, rungs: ReadonlyMap<string, string>, now: string): Promise<CampaignTargetRow> {
  const [activity, charts, stored, dailyBudgetUsd] = await Promise.all([
    funnelCampaignActivity(row, brandId, headers, pricing),
    funnelCampaignSpendCharts(row, brandId, pricing, headers),
    readPlan(row.id),
    fetchFunnelCampaignDailyBudgetUsd(brandId, row, headers).catch((err: Error) => {
      console.error(`[features-service] campaign targets: daily budget of ${row.id} unreadable (projection on its spend pace): ${err.message}`);
      return null;
    }),
  ]);
  const plan = stored && stored.orgId === headers.orgId ? (stored.body as StoredPlanBody).plan ?? null : null;
  const funnelSteps = (activity.funnel?.steps ?? []).filter((s) => s.kind === "step");
  const targetKey = row.target ?? plan?.target ?? funnelSteps[funnelSteps.length - 1]?.key ?? null;
  const stepRow = targetKey ? funnelSteps.find((s) => s.key === targetKey) : undefined;

  // The past: the Target outcomes of the campaign's pipes landing on it, dated (never the plan's).
  const landing = targetKey ? charts.pipes.filter((p) => p.outcomeStep === targetKey && p.outcomeUnavailableReason === null) : [];
  const targetDays = landing.length > 0 ? sumCumulativeDays(landing.map((p) => p.daily.map((d) => ({ date: d.date, cumulativeOutcomes: d.cumulativeOutcomes })))) : null;

  // The plan line this projection reads: the running line when it reaches the Target, else the plan's own line.
  const running = plan?.running?.reachesTarget ? plan.running : null;
  const line = running ?? plan?.shadow ?? null;
  const figures = line?.figures ?? null;
  return campaignTargetRowOf({
    salesFunnelCampaignId: row.id,
    name: row.salesFunnelName,
    offerId: row.offerId,
    mode: row.mode ?? plan?.mode ?? null,
    target: targetKey ? { key: targetKey, label: stepRow?.label ?? titleOf(targetKey), lifecycleRung: rungs.get(targetKey) ?? null } : null,
    targetDays,
    undatedTargetCount: stepRow?.people ?? null,
    spentUsd: charts.campaign.totals.spendUsd,
    spendByDay: charts.campaign.daily.map((d) => ({ date: d.date, spendUsd: d.spendUsd })),
    targetValueUsd: figures?.targetValueUsd ?? null,
    targetValueUnavailableReason: plan === null ? "plan_not_computed_yet" : figures === null ? "plan_has_no_line_to_target" : "target_has_no_value",
    plan: plan
      ? {
          computedAt: stored!.computedAt,
          funnelId: line?.funnelId ?? null,
          costPerTargetUsd: figures?.costPerTargetUsd ?? null,
          basis: figures?.basis ?? null,
          unavailableReason: figures?.unavailableReason ?? plan.running?.unavailableReason ?? plan.shadowUnavailableReason ?? null,
        }
      : null,
    dailyBudgetUsd,
    now,
  });
}

router.get("/brands/:brandId/campaign-targets", apiKeyAuth, async (req, res) => {
  try {
    const auth = req as AuthenticatedRequest & { params: { brandId: string } };
    const { brandId } = auth.params;
    // $ per outcome on NET pricing by default (owner brief): what the client pays, discounts applied.
    const pricing = req.query.pricing === undefined ? "net" : parsePricing(req.query.pricing);
    if (pricing === null) return void res.status(400).json({ error: "pricing must be one of: gross, net", reason: "pricing_unrecognised" });
    const headers: DownstreamHeaders = { orgId: auth.orgId, userId: auth.userId, runId: auth.runId, featureSlug: undefined };
    const [rows, , rungs] = await Promise.all([fetchSalesFunnelCampaigns(brandId, null, headers), assertBrandHeld(brandId, headers), listOutcomeRungs()]);
    const ongoing = rows.filter((r) => r.status === "ongoing").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const now = new Date().toISOString();
    const targets = await mapWithConcurrency(ongoing, 3, (r) => rowFor(r, brandId, headers, pricing, rungs, now));
    res.json({ brandId, pricing, costBasis: "charged", computedAt: now, targets });
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error("[features-service] campaign targets error:", err);
    res.status(502).json({ error: "Failed to read the brand's campaign Targets" });
  }
});

export default router;
