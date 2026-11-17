/**
 * OUTCOME-FORECAST-1117, GOLD: `GET /brands/:brandId/sales-funnel-campaigns/:salesFunnelCampaignId/outcome-forecast[?pricing=]`.
 * One campaign's milestones projected to its Target: median + p10-p90 tunnel per day, spend ahead, expected revenue, when the
 * next Target is due, at its budget and at alternative budgets, EVERY hypothesis named (pure `lib/outcome-forecast.ts`).
 *
 * Built on the campaign page's own figures (`campaignTargetBasis`: same milestones, counts, spend, caps, plan line) and on
 * Silver's stored distributions (`outcome_silver_stats`); nothing is measured here. A Gold cell on its own route's shape:
 * the simulation runs in the view refresher, the stored body answers every read and is recomputed behind it at most every
 * 10 minutes, and on each Silver sweep (the sweep stamp is in the key).
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import type { DownstreamHeaders } from "./revenue.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { parsePricing, type Pricing } from "../lib/pricing.js";
import { fetchSalesFunnelCampaigns, type SalesFunnelCampaignRow } from "../lib/sales-funnel-campaigns-client.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { routeResponseShapeFingerprint } from "../lib/response-shape.js";
import { campaignTargetBasis } from "./campaign-targets.js";
import { readCurrentSilverSweep, readSilverStats } from "../lib/outcome-silver-io.js";
import { FLEET_SCOPE_ID, SILVER_RULE, type TransitionStat } from "../lib/outcome-silver.js";
import { campaignForecastOf } from "../lib/outcome-forecast.js";

const router = Router();
const PATH = "/brands/{brandId}/sales-funnel-campaigns/{salesFunnelCampaignId}/outcome-forecast";
const TTL_MS = 10 * 60_000;

export async function computeOutcomeForecast(brandId: string, row: SalesFunnelCampaignRow, headers: DownstreamHeaders, pricing: Pricing, silverComputedAt: string | null) {
  const now = new Date().toISOString();
  const [basis, campaign, brand, fleet] = await Promise.all([
    campaignTargetBasis(brandId, row, headers, pricing, now),
    // No sweep on today's rule = nothing measured to read (stats stored under an older rule are never served).
    silverComputedAt === null ? [] : readSilverStats("campaign", row.id),
    silverComputedAt === null ? [] : readSilverStats("brand", brandId),
    silverComputedAt === null ? [] : readSilverStats("fleet", FLEET_SCOPE_ID),
  ]);
  const stats = new Map<string, TransitionStat>();
  for (const r of [...campaign, ...brand, ...fleet]) if (r.body.kind === "transition") stats.set(`${r.scope}\u0000${r.fromKey}\u0000${r.toKey}`, r.body.stat);
  const needed = new Map(basis.milestoneBasis.map((m) => [m.step, m]));
  // The Target's own card must be counted by the ledger: with no count there is nothing to project to.
  const targetCounted = basis.row.milestones.some((m) => m.isTarget && m.count !== null);
  const body = campaignForecastOf({
    now,
    salesFunnelCampaignId: row.id,
    hasTarget: basis.row.target !== null && targetCounted,
    // A milestone the ledger cannot count holds no Units to project from: the chain keeps the counted ones.
    milestones: basis.row.milestones
      .filter((m) => m.count !== null)
      .map((m) => ({ step: m.step, label: m.label, ledgerKeys: needed.get(m.step)?.ledgerKeys ?? [], unitsByDay: m.past.filter((p) => p.outcomes !== 0).map((p) => ({ date: p.date, units: p.outcomes })), neededPerTarget: needed.get(m.step)?.neededPerTarget ?? null })),
    spendByDay: basis.input.spendByDay,
    capacity: basis.input.capacity,
    spendPerDayUsd: basis.row.projection.spendPerDayUsd,
    spendPerDaySource: basis.row.projection.spendPerDaySource,
    plan: { costPerTargetUsd: basis.row.projection.costPerTargetUsd, basis: basis.row.projection.costPerTargetBasis },
    targetValueUsd: basis.input.targetValueUsd,
    transition: (scope, a, b) => stats.get(`${scope}\u0000${a}\u0000${b}`) ?? null,
    silverComputedAt,
  });
  return { brandId, name: row.salesFunnelName, target: basis.row.target, pricing, costBasis: "charged" as const, uncountedMilestones: basis.row.milestones.filter((m) => m.count === null).map((m) => ({ step: m.step, label: m.label, reason: m.countUnavailableReason })), ...body, unavailableReason: basis.row.target !== null && !targetCounted ? "target_not_counted_in_ledger" : body.unavailableReason };
}

router.get("/brands/:brandId/sales-funnel-campaigns/:salesFunnelCampaignId/outcome-forecast", apiKeyAuth, async (req, res) => {
  try {
    const auth = req as AuthenticatedRequest & { params: { brandId: string; salesFunnelCampaignId: string } };
    const { brandId, salesFunnelCampaignId } = auth.params;
    const pricing = req.query.pricing === undefined ? "net" : parsePricing(req.query.pricing);
    if (pricing === null) return void res.status(400).json({ error: "pricing must be one of: gross, net", reason: "pricing_unrecognised" });
    const headers: DownstreamHeaders = { orgId: auth.orgId, userId: auth.userId, runId: auth.runId, featureSlug: undefined };
    const [rows] = await Promise.all([fetchSalesFunnelCampaigns(brandId, null, headers), assertBrandHeld(brandId, headers)]);
    const row = rows.find((r) => r.id === salesFunnelCampaignId);
    if (!row) return void res.status(404).json({ error: "No sales funnel campaign with this id on this brand", reason: "sales_funnel_campaign_not_found" });
    const sweep = await readCurrentSilverSweep();
    const body = await servedCached({
      view: "campaign-outcome-forecast",
      scopeKey: buildScopeKey(row.id, { orgId: auth.orgId, brandId, pricing, silver: sweep?.sweptAt ?? "none", rule: SILVER_RULE, units: row.units.map((u) => u.campaignId).sort().join("+"), target: row.target ?? "" }),
      orgId: auth.orgId,
      ttlMs: TTL_MS,
      responseShape: routeResponseShapeFingerprint(PATH),
      compute: () => computeOutcomeForecast(brandId, row, headers, pricing, sweep?.sweptAt ?? null),
    });
    res.json(body);
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error("[features-service] outcome forecast error:", err);
    res.status(502).json({ error: "Failed to read the campaign's outcome forecast" });
  }
});

export default router;
