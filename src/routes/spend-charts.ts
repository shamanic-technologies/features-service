/**
 * WHY A DAY COSTS WHAT IT COSTS, AND WHETHER IT IS CONVERGING (owner 2026-10-19, SPEND-CHARTS-1019).
 *
 *   GET /brands/:brandId/sales-funnel-campaigns/:salesFunnelCampaignId/spend-charts[?pricing=]
 *       -> the campaign's chart + one chart per pipe (unit campaign) of it
 *   GET /offers/:offerId/spend-charts?brandId=[&pricing=]
 *       -> the offer's chart (every sales funnel campaign of the offer)
 *
 * Each chart (`lib/spend-charts.ts`): one point per UTC day since the scope's first activity, with the measured cost
 * per outcome (served while Learning), the conversion by entry cohort, the Learning and cohort-maturity flags, what
 * the day's spend bought per action, and the expected values beside. Same rule for every channel and pipe. Gold
 * cached per scope (this route's response shape), refreshed behind a stale read.
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import type { DownstreamHeaders } from "./revenue.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { parsePricing, type Pricing } from "../lib/pricing.js";
import { fetchSalesFunnelCampaigns, type SalesFunnelCampaignRow, type SalesFunnelUnitRow } from "../lib/sales-funnel-campaigns-client.js";
import { funnelCopiesFor } from "./agent-catalogue.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { routeResponseShapeFingerprint } from "../lib/response-shape.js";
import { expectedReturnForCampaign, expectedReturnForFunnelCampaign, expectedReturnForOffer, type ExpectedReturn } from "../lib/expected-return.js";
import { getBrandEffectiveRates } from "../lib/effective-conversion-rates.js";
import { computeSpendChart, fetchFollowupActionRows, type ChartLeg, type ChartScope, type SpendChart } from "../lib/spend-charts-io.js";
import type { FollowupActionRow } from "../lib/followup-actions-client.js";

const router = Router();

/** How long a chart read waits on a cold expected model (it is computed once per offer, then memoized). */
const EXPECTED_COLD_WAIT_MS = 25_000;

type PipeSteps = ReadonlyMap<string, { fromStep: string | null; toStep: string }>;

export interface PipeChart extends SpendChart {
  campaignId: string;
  pipeId: string;
  featureSlug: string;
  legKey: string;
  status: string;
}

export interface FunnelCampaignSpendChartsBody {
  salesFunnelCampaignId: string;
  brandId: string;
  offerId: string;
  pricing: Pricing;
  costBasis: "charged";
  campaign: SpendChart;
  pipes: PipeChart[];
}

export interface OfferSpendChartsBody {
  offerId: string;
  brandId: string;
  pricing: Pricing;
  costBasis: "charged";
  salesFunnelCampaignIds: string[];
  offer: SpendChart;
}

const legOf = (u: SalesFunnelUnitRow, steps: PipeSteps): ChartLeg | null => {
  const s = steps.get(u.pipeId);
  return s ? { channelSlug: u.featureSlug, legKey: u.legKey, fromStep: s.fromStep, toStep: s.toStep } : null;
};

/**
 * PURE. A funnel campaign's units in PATH order: from the unit leaving Start (else the one leaving a step no other unit
 * produces: a reactive funnel's head), each next unit leaving the step the previous one produced; leftovers last.
 */
export function unitsInPathOrder(units: readonly SalesFunnelUnitRow[], steps: PipeSteps): SalesFunnelUnitRow[] {
  const produced = new Set(units.map((u) => steps.get(u.pipeId)?.toStep).filter(Boolean));
  const head =
    units.find((u) => steps.get(u.pipeId)?.fromStep === null) ??
    units.find((u) => {
      const from = steps.get(u.pipeId)?.fromStep;
      return from !== undefined && from !== null && !produced.has(from);
    });
  const out: SalesFunnelUnitRow[] = [];
  let cur = head;
  while (cur && !out.includes(cur)) {
    out.push(cur);
    const to = steps.get(cur.pipeId)?.toStep;
    cur = units.find((u) => !out.includes(u) && steps.get(u.pipeId)?.fromStep === to);
  }
  return [...out, ...units.filter((u) => !out.includes(u))];
}

/** PURE. The leg a campaign is charted on: its first pipe (path order) that does not only FIND people, else its first. */
export function leadingUnit(units: readonly SalesFunnelUnitRow[], steps: PipeSteps): SalesFunnelUnitRow | null {
  const ordered = unitsInPathOrder(units, steps);
  return ordered.find((u) => steps.has(u.pipeId) && steps.get(u.pipeId)!.toStep !== "lead_found") ?? ordered[0] ?? null;
}

/** PURE. One pipe's scope: its own spend; its people (a sourcing pipe's = what the campaign's other units were served). */
export function pipeScope(row: SalesFunnelCampaignRow, u: SalesFunnelUnitRow, steps: PipeSteps): ChartScope {
  const leg = legOf(u, steps);
  const finds = leg?.toStep === "lead_found";
  return {
    campaignIds: [u.campaignId],
    featureSlugs: [u.featureSlug],
    personCampaignIds: finds ? row.units.filter((x) => x.campaignId !== u.campaignId).map((x) => x.campaignId) : [u.campaignId],
    actingCampaignIds: [u.campaignId],
    leg,
    pipe: { campaignId: u.campaignId, featureSlug: u.featureSlug },
  };
}

/** PURE. A set of funnel campaigns as ONE scope (a campaign, an offer), charted on `leg`. */
export function groupScope(rows: readonly SalesFunnelCampaignRow[], leg: ChartLeg | null): ChartScope {
  const units = rows.flatMap((r) => r.units);
  const ids = [...new Set(units.map((u) => u.campaignId))].sort();
  return {
    campaignIds: ids,
    featureSlugs: [...new Set(units.map((u) => u.featureSlug))].sort(),
    personCampaignIds: ids,
    actingCampaignIds: ids,
    leg,
    pipe: null,
  };
}

/** PURE. The offer's leg: the leading leg most of its funnel campaigns run (ties: the most recent campaign's). */
export function offerLeg(rows: readonly SalesFunnelCampaignRow[], steps: PipeSteps): ChartLeg | null {
  const counts = new Map<string, { leg: ChartLeg; n: number; latest: string }>();
  for (const r of rows) {
    const u = leadingUnit(r.units, steps);
    const leg = u ? legOf(u, steps) : null;
    if (!leg) continue;
    const key = `${leg.channelSlug}|${leg.legKey}`;
    const c = counts.get(key);
    counts.set(key, { leg, n: (c?.n ?? 0) + 1, latest: c && c.latest > r.createdAt ? c.latest : r.createdAt });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || b.latest.localeCompare(a.latest))[0]?.leg ?? null;
}

interface ChartContext {
  brandId: string;
  handedRows: FollowupActionRow[];
  fleetConversions: ReadonlyMap<string, number>;
  brandRateOf: (legKey: string) => { ratePct: number | null; source: string | null } | null;
  pricing: Pricing;
  headers: DownstreamHeaders;
}

async function chartContext(brandId: string, unitIds: readonly string[], pricing: Pricing, headers: DownstreamHeaders): Promise<ChartContext> {
  const { fleetLegConversionRatesFromOutcomePrices } = await import("./public.js");
  const handedRows = unitIds.length > 0 ? await fetchFollowupActionRows(brandId, unitIds) : [];
  const [rates] = await Promise.all([
    getBrandEffectiveRates(brandId, headers.orgId).catch((err: Error) => {
      console.error(`[features-service] spend charts: brand rates unreadable for brand ${brandId} (expected conversion of later legs null): ${err.message}`);
      return null;
    }),
  ]);
  const byLeg = new Map((rates?.legs ?? []).filter((l) => l.legKey).map((l) => [l.legKey!, { ratePct: l.effectiveRatePct, source: l.source }] as const));
  return { brandId, handedRows, fleetConversions: fleetLegConversionRatesFromOutcomePrices(), brandRateOf: (k) => byLeg.get(k) ?? null, pricing, headers };
}

const chartOf = (ctx: ChartContext, scope: ChartScope, expected: ExpectedReturn): Promise<SpendChart> =>
  computeSpendChart({ brandId: ctx.brandId, scope, handedRows: ctx.handedRows, expected, fleetConversions: ctx.fleetConversions, brandRateOf: ctx.brandRateOf, pricing: ctx.pricing, headers: ctx.headers });

export async function computeFunnelCampaignSpendCharts(row: SalesFunnelCampaignRow, pricing: Pricing, headers: DownstreamHeaders): Promise<FunnelCampaignSpendChartsBody> {
  const brandId = row.brandId;
  const identity = { orgId: headers.orgId, userId: headers.userId, runId: headers.runId };
  const [{ pipeSteps }, ctx] = await Promise.all([funnelCopiesFor([row.salesFunnelId]), chartContext(brandId, row.units.map((u) => u.campaignId), pricing, headers)]);
  const lead = leadingUnit(row.units, pipeSteps);
  const ordered = unitsInPathOrder(row.units, pipeSteps);
  const [campaign, pipes] = await Promise.all([
    expectedReturnForFunnelCampaign(identity, brandId, row.offerId, row.salesFunnelId, null, EXPECTED_COLD_WAIT_MS).then((e) =>
      chartOf(ctx, groupScope([row], lead ? legOf(lead, pipeSteps) : null), e),
    ),
    Promise.all(
      ordered.map(async (u): Promise<PipeChart> => {
        const expected = await expectedReturnForCampaign(identity, brandId, { offerId: row.offerId, featureSlug: u.featureSlug, legKeys: [u.legKey] }, null);
        const chart = await chartOf(ctx, pipeScope(row, u, pipeSteps), expected);
        return { campaignId: u.campaignId, pipeId: u.pipeId, featureSlug: u.featureSlug, legKey: u.legKey, status: u.status, ...chart };
      }),
    ),
  ]);
  return { salesFunnelCampaignId: row.id, brandId, offerId: row.offerId, pricing, costBasis: "charged", campaign, pipes };
}

export async function computeOfferSpendCharts(
  offerId: string,
  brandId: string,
  rows: readonly SalesFunnelCampaignRow[],
  pricing: Pricing,
  headers: DownstreamHeaders,
): Promise<OfferSpendChartsBody> {
  const identity = { orgId: headers.orgId, userId: headers.userId, runId: headers.runId };
  const [{ pipeSteps }, ctx, expected] = await Promise.all([
    funnelCopiesFor([...new Set(rows.map((r) => r.salesFunnelId))]),
    chartContext(brandId, rows.flatMap((r) => r.units.map((u) => u.campaignId)), pricing, headers),
    expectedReturnForOffer(identity, brandId, offerId, null),
  ]);
  const offer = await chartOf(ctx, groupScope(rows, offerLeg(rows, pipeSteps)), expected);
  return { offerId, brandId, pricing, costBasis: "charged", salesFunnelCampaignIds: rows.map((r) => r.id).sort(), offer };
}

const pricingOrRefuse = (raw: unknown): Pricing | null => parsePricing(raw);

router.get("/brands/:brandId/sales-funnel-campaigns/:salesFunnelCampaignId/spend-charts", apiKeyAuth, async (req, res) => {
  try {
    const auth = req as AuthenticatedRequest & { params: { brandId: string; salesFunnelCampaignId: string } };
    const { brandId, salesFunnelCampaignId } = auth.params;
    const pricing = pricingOrRefuse(req.query.pricing);
    if (pricing === null) return void res.status(400).json({ error: "pricing must be one of: gross, net", reason: "pricing_unrecognised" });
    const headers: DownstreamHeaders = { orgId: auth.orgId, userId: auth.userId, runId: auth.runId, featureSlug: undefined };
    const [rows] = await Promise.all([fetchSalesFunnelCampaigns(brandId, null, headers), assertBrandHeld(brandId, headers)]);
    const row = rows.find((r) => r.id === salesFunnelCampaignId);
    if (!row) return void res.status(404).json({ error: "No sales funnel campaign with this id on this brand", reason: "sales_funnel_campaign_not_found" });
    const body = await servedCached({
      view: "funnel-campaign-spend-charts",
      scopeKey: buildScopeKey(row.id, {
        orgId: headers.orgId,
        brandId,
        offerId: row.offerId,
        units: row.units.map((u) => `${u.campaignId}:${u.legKey}`).sort().join("+"),
        pricing,
      }),
      orgId: headers.orgId,
      responseShape: routeResponseShapeFingerprint("/brands/{brandId}/sales-funnel-campaigns/{salesFunnelCampaignId}/spend-charts"),
      compute: () => computeFunnelCampaignSpendCharts(row, pricing, headers),
    });
    res.json(body);
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error("[features-service] funnel campaign spend charts error:", err);
    res.status(502).json({ error: "Failed to read the campaign's spend charts" });
  }
});

router.get("/offers/:offerId/spend-charts", apiKeyAuth, async (req, res) => {
  try {
    const auth = req as AuthenticatedRequest & { params: { offerId: string } };
    const { offerId } = auth.params;
    const brandId = typeof req.query.brandId === "string" ? req.query.brandId.trim() : "";
    if (!brandId) return void res.status(400).json({ error: "brandId is required", reason: "brand_id_required" });
    const pricing = pricingOrRefuse(req.query.pricing);
    if (pricing === null) return void res.status(400).json({ error: "pricing must be one of: gross, net", reason: "pricing_unrecognised" });
    const headers: DownstreamHeaders = { orgId: auth.orgId, userId: auth.userId, runId: auth.runId, featureSlug: undefined };
    const [rows] = await Promise.all([fetchSalesFunnelCampaigns(brandId, offerId, headers), assertBrandHeld(brandId, headers)]);
    const ofOffer = rows.filter((r) => r.offerId === offerId);
    if (ofOffer.length === 0) return void res.status(404).json({ error: "This offer runs no sales funnel campaign on this brand", reason: "offer_has_no_campaigns" });
    const body = await servedCached({
      view: "offer-spend-charts",
      scopeKey: buildScopeKey(offerId, {
        orgId: headers.orgId,
        brandId,
        units: ofOffer.flatMap((r) => r.units.map((u) => `${u.campaignId}:${u.legKey}`)).sort().join("+"),
        pricing,
      }),
      orgId: headers.orgId,
      responseShape: routeResponseShapeFingerprint("/offers/{offerId}/spend-charts"),
      compute: () => computeOfferSpendCharts(offerId, brandId, ofOffer, pricing, headers),
    });
    res.json(body);
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error("[features-service] offer spend charts error:", err);
    res.status(502).json({ error: "Failed to read the offer's spend charts" });
  }
});

export default router;
