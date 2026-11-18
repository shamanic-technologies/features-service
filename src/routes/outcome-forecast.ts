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
import { readCampaignPairBins, readCurrentSilverSweep, readSilverStats } from "../lib/outcome-silver-io.js";
import { delayDistributionOf, FLEET_SCOPE_ID, SILVER_RULE, type DelayDistribution, type TransitionStat } from "../lib/outcome-silver.js";
import { campaignForecastOf, FORECAST_RULE } from "../lib/outcome-forecast.js";

/**
 * What a milestone with NO count means for the forecast (FORECAST-NO-TARGET-YET-1118). A milestone the ledger simply has
 * not seen yet is a measured ZERO on its card since FORECAST-FRESH-EVIDENCE-1118 (count 0), so it is projected like any
 * other. A null count is one the ledger CANNOT count, and is left out:
 *  - `ledger_unreadable`: we could not read the ledger now (it clears by itself);
 *  - `outcome_not_declared_in_ledger`: the brand's runs CONSUMED this outcome and no run declared producing it;
 *  - `no_producer_declares_outcome`: no run of the fleet ever declared this outcome;
 *  - any other reason: unknown is never read as zero.
 */
/** Why a milestone holding zero Units is left out of the chain: no rate is measured or planned to or from it. */
export const ZERO_MIDDLE_LEFT_OUT = "zero_units_and_no_rate_around_it";
/** The reasons a Target the ledger cannot count refuses the forecast under (the closed list the page words). */
export const TARGET_REFUSAL_REASONS = ["target_ledger_unreadable", "target_outcome_not_declared_in_ledger", "target_no_producer_declares_outcome", "target_not_counted_in_ledger"] as const;
export function targetRefusalOf(reason: string | null): (typeof TARGET_REFUSAL_REASONS)[number] {
  const named = `target_${reason ?? ""}`;
  return (TARGET_REFUSAL_REASONS as readonly string[]).includes(named) ? (named as (typeof TARGET_REFUSAL_REASONS)[number]) : "target_not_counted_in_ledger";
}

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
  // The measured cost of one Unit per outcome (the ledger's stated production cost), brand and fleet (FORECAST-LEAD-DEALS-1118).
  const unitCosts = new Map<string, { units: number; meanUsd: number }>();
  for (const r of [...campaign, ...brand, ...fleet]) {
    if (r.body.kind === "transition") stats.set(`${r.scope}\u0000${r.fromKey}\u0000${r.toKey}`, r.body.stat);
    else if (r.scope !== "campaign") unitCosts.set(`${r.scope}\u0000${r.toKey}`, { units: r.body.stat.units, meanUsd: r.body.stat.costUsd.mean });
  }
  const needed = new Map(basis.milestoneBasis.map((m) => [m.step, m]));
  // FORECAST-NO-TARGET-YET-1118: a milestone the ledger simply has not SEEN yet holds ZERO Units and is projected like
  // any other (a young campaign with no Target yet is exactly what a forecast is for). Only a milestone the ledger
  // CANNOT count is left out, and a Target it cannot count refuses the forecast under its own reason.
  const projected = (m: { count: number | null }) => m.count !== null;
  const target = basis.row.milestones.find((m) => m.isTarget) ?? null;
  const targetCounted = target !== null && projected(target);
  // FORECAST-FRESH-EVIDENCE-1118: for each transition between two neighbouring milestones that Silver holds no campaign
  // row for (a campaign younger than the last sweep), the delay the campaign measured ITSELF, read live off the links
  // (its own Units only; nothing swept). Unreadable = none: the brand's or the fleet's curve censors, logged.
  const liveDelays = new Map<string, DelayDistribution | null>();
  const counted = basis.row.milestones.filter(projected);
  const unitCampaignIds = row.units.map((u) => u.campaignId);
  if (silverComputedAt !== null)
    for (let k = 0; k + 1 < counted.length; k++)
      for (const a of needed.get(counted[k]!.step)?.ledgerKeys ?? [])
        for (const b of needed.get(counted[k + 1]!.step)?.ledgerKeys ?? []) {
          if (stats.has(`campaign\u0000${a}\u0000${b}`) || !stats.has(`fleet\u0000${a}\u0000${b}`)) continue;
          const pairs = await readCampaignPairBins(unitCampaignIds, a, b).catch((err: Error) => {
            console.error(`[features-service] outcome forecast: live pairs of ${row.id} ${a} -> ${b} unreadable (another scope's curve censors): ${err.message}`);
            return null;
          });
          liveDelays.set(`${a}\u0000${b}`, pairs ? delayDistributionOf(pairs.bins, pairs.sumHours, pairs.samplesHours) : null);
        }
  const forecastOver = (chain: typeof basis.row.milestones) =>
    campaignForecastOf({
      now,
      salesFunnelCampaignId: row.id,
      hasTarget: basis.row.target !== null && targetCounted,
      milestones: chain.map((m) => ({ step: m.step, label: m.label, ledgerKeys: needed.get(m.step)?.ledgerKeys ?? [], unitsByDay: m.past.filter((p) => p.outcomes !== 0).map((p) => ({ date: p.date, units: p.outcomes })), neededPerTarget: needed.get(m.step)?.neededPerTarget ?? null })),
      spendByDay: basis.input.spendByDay,
      capacity: basis.input.capacity,
      spendPerDayUsd: basis.row.projection.spendPerDayUsd,
      spendPerDaySource: basis.row.projection.spendPerDaySource,
      plan: { costPerTargetUsd: basis.row.projection.costPerTargetUsd, basis: basis.row.projection.costPerTargetBasis },
      targetValueUsd: basis.input.targetValueUsd,
      transition: (scope, x, y) => stats.get(`${scope}\u0000${x}\u0000${y}`) ?? null,
      liveCampaignDelay: (x, y) => liveDelays.get(`${x}\u0000${y}`) ?? null,
      unitCost: (scope, key) => unitCosts.get(`${scope}\u0000${key}`) ?? null,
      silverComputedAt,
    });
  // A milestone the ledger cannot count holds no Units to project from: the chain keeps the others.
  let chain = basis.row.milestones.filter(projected);
  let body = forecastOver(chain);
  // A zero milestone in the MIDDLE with no rate measured or planned to or from it would refuse a forecast its neighbours
  // can carry: the chain then goes on without it (as it did before it was kept), and it is listed as left out.
  if (body.unavailableReason?.startsWith("yield_unmeasured:")) {
    const without = chain.filter((m, k) => m.isTarget || k === 0 || m.count !== 0);
    if (without.length < chain.length) {
      const retry = forecastOver(without);
      if (retry.unavailableReason === null) {
        chain = without;
        body = retry;
      }
    }
  }
  const inChain = new Set(chain.map((m) => m.step));
  return {
    brandId,
    name: row.salesFunnelName,
    target: basis.row.target,
    pricing,
    costBasis: "charged" as const,
    // The milestones left OUT of the projection (the ledger cannot count them), each with why.
    uncountedMilestones: basis.row.milestones.filter((m) => !inChain.has(m.step)).map((m) => ({ step: m.step, label: m.label, reason: m.count === null ? m.countUnavailableReason : ZERO_MIDDLE_LEFT_OUT })),
    ...body,
    unavailableReason: basis.row.target !== null && !targetCounted ? targetRefusalOf(target?.countUnavailableReason ?? null) : body.unavailableReason,
  };
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
      scopeKey: buildScopeKey(row.id, { orgId: auth.orgId, brandId, pricing, silver: sweep?.sweptAt ?? "none", rule: SILVER_RULE, gold: FORECAST_RULE, units: row.units.map((u) => u.campaignId).sort().join("+"), target: row.target ?? "" }),
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
