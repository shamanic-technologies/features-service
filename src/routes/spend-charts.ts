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
import { fetchBrandOutcomeLedger, fetchCampaignSetOutcomeLedger } from "../lib/scope-outcome-ledger-io.js";
import { ledgerCountOfStep, ledgerScopeOf } from "../lib/ledger-counts.js";
import { rebaseSpendChartOnLedger, type LedgerSpendChart } from "../lib/spend-charts-ledger.js";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import type { DownstreamHeaders } from "./revenue.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { parsePricing, type Pricing } from "../lib/pricing.js";
import { fetchSalesFunnelCampaigns, type SalesFunnelCampaignRow, type SalesFunnelUnitRow } from "../lib/sales-funnel-campaigns-client.js";
import { funnelCopiesFor } from "./agent-catalogue.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { routeResponseShapeFingerprint } from "../lib/response-shape.js";
import {
  expectedForOffer,
  expectedReturnForCampaign,
  expectedReturnForFunnelCampaign,
  expectedReturnForOffer,
  ExpectedModelComputing,
  offerExpectedModel,
  pickBrandModel,
  unavailableExpectedReturn,
  type ExpectedReturn,
  type OfferExpectedModel,
} from "../lib/expected-return.js";
import { getBrandEffectiveRates } from "../lib/effective-conversion-rates.js";
import { computeSpendChart, fetchFollowupActionRows, type ChartLeg, type ChartScope, type SpendChart } from "../lib/spend-charts-io.js";
import type { FollowupActionRow } from "../lib/followup-actions-client.js";
import { fetchOfferChannelMap, type OfferChannel } from "../lib/offer-channels.js";
import { campaignChartTarget, groupChartTarget, type ChartTarget } from "../lib/spend-chart-target.js";
import { featurelessUnitIdsOf, isPipeUnit, pipeUnitsOf, stepsOfPipeId, unitFeatureSlugsOf, type PipeUnitRow } from "../lib/target-only-units.js";

const router = Router();

/** How long a chart read waits on a cold expected model (it is computed once per offer, then memoized). */
const EXPECTED_COLD_WAIT_MS = 25_000;

type PipeSteps = ReadonlyMap<string, { fromStep: string | null; toStep: string }>;
/** A funnel's path (the catalogue's), to read its last step. */
type PathOf = (salesFunnelId: string) => { legs: ReadonlyArray<{ toStep: string }> } | null;

export interface PipeChart extends LedgerSpendChart {
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
  campaign: LedgerSpendChart;
  pipes: PipeChart[];
}

export interface BrandSpendChartsBody {
  brandId: string;
  /** Every offer the chart covers: each offer any campaign of the brand states. */
  offerIds: string[];
  pricing: Pricing;
  costBasis: "charged";
  salesFunnelCampaignIds: string[];
  /** Every campaign of every offer as one scope (the offer chart's rule, one level up). */
  brand: LedgerSpendChart;
}

export interface OfferSpendChartsBody {
  offerId: string;
  brandId: string;
  pricing: Pricing;
  costBasis: "charged";
  salesFunnelCampaignIds: string[];
  offer: LedgerSpendChart;
}

/** A unit's pipe steps (a play id reads its base pipe's). */
const stepsOfUnit = (u: SalesFunnelUnitRow, steps: PipeSteps) => stepsOfPipeId(steps, u.pipeId);

const legOf = (u: SalesFunnelUnitRow, steps: PipeSteps): ChartLeg | null => {
  const s = stepsOfUnit(u, steps);
  return s && isPipeUnit(u) ? { channelSlug: u.featureSlug, legKey: u.legKey, fromStep: s.fromStep, toStep: s.toStep } : null;
};

/**
 * PURE. A funnel campaign's units in PATH order: from the unit leaving Start (else the one leaving a step no other unit
 * produces: a reactive funnel's head), each next unit leaving the step the previous one produced; leftovers last.
 */
export function unitsInPathOrder(units: readonly SalesFunnelUnitRow[], steps: PipeSteps): SalesFunnelUnitRow[] {
  const produced = new Set(units.map((u) => (u.pipeId === null ? undefined : steps.get(u.pipeId))?.toStep).filter(Boolean));
  const head =
    units.find((u) => (u.pipeId === null ? undefined : steps.get(u.pipeId))?.fromStep === null) ??
    units.find((u) => {
      const from = (u.pipeId === null ? undefined : steps.get(u.pipeId))?.fromStep;
      return from !== undefined && from !== null && !produced.has(from);
    });
  const out: SalesFunnelUnitRow[] = [];
  let cur = head;
  while (cur && !out.includes(cur)) {
    out.push(cur);
    const to = (cur.pipeId === null ? undefined : steps.get(cur.pipeId))?.toStep;
    cur = units.find((u) => !out.includes(u) && (u.pipeId === null ? undefined : steps.get(u.pipeId))?.fromStep === to);
  }
  return [...out, ...units.filter((u) => !out.includes(u))];
}

/**
 * PURE (SPEND-CHART-TARGET-1108). What a funnel campaign's chart counts: its TARGET (campaign-service's `target`, else
 * the last step of the funnel it runs), from the first milestone of its own units chain. Never a pipe's step.
 */
export function campaignTargetOf(row: SalesFunnelCampaignRow, steps: PipeSteps, pathOf: PathOf): ChartTarget | null {
  const lastStep = pathOf(row.runningSalesFunnelId ?? row.salesFunnelId)?.legs.at(-1)?.toStep ?? null;
  const edges = row.units.flatMap((u) => {
    const st = stepsOfUnit(u, steps);
    return st ? [{ campaignId: u.campaignId, fromStep: st.fromStep, toStep: st.toStep }] : [];
  });
  return campaignChartTarget(row.target, lastStep, edges);
}

/** PURE. One pipe's scope: its own spend; its people (a sourcing pipe's = what the campaign's other units were served). */
export function pipeScope(row: SalesFunnelCampaignRow, u: PipeUnitRow, steps: PipeSteps): ChartScope {
  const leg = legOf(u, steps);
  const finds = leg?.toStep === "lead_found";
  return {
    campaignIds: [u.campaignId],
    featureSlugs: [u.featureSlug],
    personCampaignIds: finds ? row.units.filter((x) => x.campaignId !== u.campaignId).map((x) => x.campaignId) : [u.campaignId],
    actingCampaignIds: [u.campaignId],
    leg,
    target: null,
    pipe: { campaignId: u.campaignId, featureSlug: u.featureSlug },
    brandLevelSpend: false,
  };
}

/**
 * PURE. A set of funnel campaigns as ONE scope (a campaign, an offer), charted on its `target`.
 *
 * `offerChannels` (offer grain only, SPEND-CHARTS-INCEPTION-1027): EVERY campaign the offer ran, per channel, the
 * campaigns from before the funnel-campaign era included (campaign-service rows stating the offer and no sales funnel),
 * so "since you started" is since the offer's first activity, and the offer's brand-level work joins the spend like on
 * every offer money figure (`lib/brand-level-spend.ts`). The scope is then the byte-same campaign and channel set the
 * brand offers read (`/brands/:id/offers`) prices that offer on.
 */
export function groupScope(rows: readonly SalesFunnelCampaignRow[], target: ChartTarget | null, offerChannels?: readonly OfferChannel[]): ChartScope {
  const units = rows.flatMap((r) => r.units);
  const ids = [...new Set([...units.map((u) => u.campaignId), ...(offerChannels ?? []).flatMap((c) => c.campaignIds)])].sort();
  return {
    campaignIds: ids,
    featureSlugs: [...new Set([...unitFeatureSlugsOf(units), ...(offerChannels ?? []).map((c) => c.featureSlug)])].sort(),
    personCampaignIds: ids,
    actingCampaignIds: ids,
    leg: null,
    target,
    pipe: null,
    brandLevelSpend: offerChannels !== undefined,
    ...(featurelessUnitIdsOf(units).length > 0 ? { featurelessCampaignIds: featurelessUnitIdsOf(units).sort() } : {}),
  };
}

/**
 * PURE (SPEND-CHART-TARGET-1108). An offer's / a brand's chart counts the Target its campaigns state: the Target most of
 * them state (the live ones when any runs), ties to the most recent campaign's. Never a pipe-voted step.
 */
export function groupTargetOf(rows: readonly SalesFunnelCampaignRow[], steps: PipeSteps, pathOf: PathOf): ChartTarget | null {
  const live = rows.filter((r) => r.status === "ongoing");
  return groupChartTarget((live.length > 0 ? live : rows).map((r) => ({ target: campaignTargetOf(r, steps, pathOf), createdAt: r.createdAt })));
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
  const [{ pipeSteps, pathOf }, ctx] = await Promise.all([
    funnelCopiesFor([...new Set([row.salesFunnelId, row.runningSalesFunnelId ?? row.salesFunnelId])]),
    chartContext(brandId, row.units.map((u) => u.campaignId), pricing, headers),
  ]);
  const target = campaignTargetOf(row, pipeSteps, pathOf);
  const ordered = unitsInPathOrder(pipeUnitsOf(row.units), pipeSteps).filter(isPipeUnit);
  // LEDGER-ONLY-1107-P2: every outcome / $ per outcome / conversion of the campaign's chart = the Units its units' runs
  // produced (runs-service ledger), a pipe's = its own campaign's; never the people a lead read counted.
  const basis = pricing === "gross" ? "gross" : "net";
  const onLedger = async (chart: SpendChart, campaignIds: readonly string[], scope: "campaign" | "pipe"): Promise<LedgerSpendChart> => {
    const ledger = await fetchCampaignSetOutcomeLedger(campaignIds, brandId, basis).catch((err: Error) => {
      console.error(`[features-service] funnel campaign spend charts: ledger of ${row.id} (${scope}) unreadable (outcomes null): ${err.message}`);
      return null;
    });
    const step = chart.outcomeStep;
    const from = chart.target ? chart.target.fromStep : chart.leg?.fromStep ?? null;
    const scopeOf = ledgerScopeOf(ledger);
    return rebaseSpendChartOnLedger(
      chart,
      step === null ? null : ledger === null ? "ledger_unreadable" : ledgerCountOfStep(scopeOf, step).row,
      from === null || ledger === null ? null : ledgerCountOfStep(scopeOf, from).row,
      chart.target?.learningOutcomesRequired ?? chart.leg?.learningOutcomesRequired ?? 10,
      scope,
    );
  };
  const [campaign, pipes] = await Promise.all([
    expectedReturnForFunnelCampaign(identity, brandId, row.offerId, row.salesFunnelId, null, EXPECTED_COLD_WAIT_MS).then(async (e) =>
      onLedger(await chartOf(ctx, groupScope([row], target), e), row.units.map((u) => u.campaignId), "campaign"),
    ),
    Promise.all(
      ordered.map(async (u): Promise<PipeChart> => {
        const expected = await expectedReturnForCampaign(identity, brandId, { offerId: row.offerId, featureSlug: u.featureSlug, legKeys: [u.legKey] }, null);
        const chart = await onLedger(await chartOf(ctx, pipeScope(row, u, pipeSteps), expected), [u.campaignId], "pipe");
        return { campaignId: u.campaignId, pipeId: u.pipeId, featureSlug: u.featureSlug, legKey: u.legKey, status: u.status, ...chart };
      }),
    ),
  ]);
  return { salesFunnelCampaignId: row.id, brandId, offerId: row.offerId, pricing, costBasis: "charged", campaign, pipes };
}

/** One funnel campaign's spend charts through their Gold cell (the route's read; the milestones read shares the cell). */
export function funnelCampaignSpendCharts(row: SalesFunnelCampaignRow, brandId: string, pricing: Pricing, headers: DownstreamHeaders): Promise<FunnelCampaignSpendChartsBody> {
  return servedCached({
    view: "funnel-campaign-spend-charts",
    scopeKey: buildScopeKey(row.id, {
      orgId: headers.orgId,
      brandId,
      offerId: row.offerId,
      units: row.units.map((u) => `${u.campaignId}:${u.legKey}`).sort().join("+"),
      // SPEND-CHART-TARGET-1108: the chart counts the Target, so a moved Target is another cell.
      target: row.target ?? "",
      pricing,
    }),
    orgId: headers.orgId,
    responseShape: routeResponseShapeFingerprint("/brands/{brandId}/sales-funnel-campaigns/{salesFunnelCampaignId}/spend-charts"),
    compute: () => computeFunnelCampaignSpendCharts(row, pricing, headers),
  });
}

export async function computeOfferSpendCharts(
  offerId: string,
  brandId: string,
  rows: readonly SalesFunnelCampaignRow[],
  offerChannels: readonly OfferChannel[],
  pricing: Pricing,
  headers: DownstreamHeaders,
): Promise<OfferSpendChartsBody> {
  const identity = { orgId: headers.orgId, userId: headers.userId, runId: headers.runId };
  const offer = await groupSpendChart(brandId, rows, offerChannels, expectedReturnForOffer(identity, brandId, offerId, null), pricing, headers, "offer");
  return { offerId, brandId, pricing, costBasis: "charged", salesFunnelCampaignIds: rows.map((r) => r.id).sort(), offer };
}

/**
 * The brand chart's expected return: the picked offer model's (`pickBrandModel`), soft like `expectedReturnForOffer`
 * (a failure is a named unavailable figure, never a failed chart). One offer = `expectedReturnForOffer` exactly.
 */
async function brandChartExpected(brandId: string, offerIds: readonly string[], headers: DownstreamHeaders): Promise<ExpectedReturn> {
  const identity = { orgId: headers.orgId, userId: headers.userId, runId: headers.runId };
  try {
    const models = (await Promise.all(offerIds.map((o) => offerExpectedModel(identity, brandId, o)))).filter((m): m is OfferExpectedModel => m !== null);
    const m = pickBrandModel(models);
    if (m === null) throw new Error(`no offer of ${offerIds.join(",")} is an offer of brand ${brandId}`);
    return expectedForOffer(m);
  } catch (error) {
    if (error instanceof ExpectedModelComputing) return unavailableExpectedReturn("expected_model_computing");
    console.error(`[features-service] expected return (brand ${brandId} chart) unavailable: ${(error as Error).message}`);
    return unavailableExpectedReturn("expected_model_unavailable");
  }
}

/** PURE. Several offers' channels as one channel list: per channel, every campaign of every offer (ascending). */
export function mergeOfferChannels(lists: ReadonlyArray<readonly OfferChannel[]>): OfferChannel[] {
  const bySlug = new Map<string, Set<string>>();
  for (const c of lists.flat()) bySlug.set(c.featureSlug, new Set([...(bySlug.get(c.featureSlug) ?? []), ...c.campaignIds]));
  return [...bySlug.entries()]
    .map(([featureSlug, ids]) => ({ featureSlug, campaignIds: [...ids].sort() }))
    .sort((a, b) => (a.featureSlug < b.featureSlug ? -1 : a.featureSlug > b.featureSlug ? 1 : 0));
}

/**
 * THE BRAND'S CHART (BRAND-GRAIN-READS-1107): every sales funnel campaign of every offer and every campaign each offer
 * ran, as ONE scope, charted exactly like the offer chart (same spend, leg rule, ledger and expected read; the expected
 * figures are the picked offer model's, `pickBrandModel`). A brand selling one offer reads its offer chart byte for byte.
 */
export async function computeBrandSpendCharts(
  brandId: string,
  offerIds: readonly string[],
  rows: readonly SalesFunnelCampaignRow[],
  channels: readonly OfferChannel[],
  pricing: Pricing,
  headers: DownstreamHeaders,
): Promise<BrandSpendChartsBody> {
  const brand = await groupSpendChart(brandId, rows, channels, brandChartExpected(brandId, offerIds, headers), pricing, headers, "brand");
  return { brandId, offerIds: [...offerIds], pricing, costBasis: "charged", salesFunnelCampaignIds: rows.map((r) => r.id).sort(), brand };
}

/** A set of funnel campaigns (+ every campaign of `channels`) charted as one scope, its outcomes on the brand's ledger. */
async function groupSpendChart(
  brandId: string,
  rows: readonly SalesFunnelCampaignRow[],
  offerChannels: readonly OfferChannel[],
  expectedRead: Promise<ExpectedReturn>,
  pricing: Pricing,
  headers: DownstreamHeaders,
  what: "offer" | "brand",
): Promise<LedgerSpendChart> {
  const [{ pipeSteps, pathOf }, ctx, expected] = await Promise.all([
    funnelCopiesFor([...new Set(rows.flatMap((r) => [r.salesFunnelId, r.runningSalesFunnelId ?? r.salesFunnelId]))]),
    chartContext(brandId, rows.flatMap((r) => r.units.map((u) => u.campaignId)), pricing, headers),
    expectedRead,
  ]);
  const measured = await chartOf(ctx, groupScope(rows, groupTargetOf(rows, pipeSteps, pathOf), offerChannels), expected);
  // LEDGER-ONLY-1107: the offer chart's outcomes and conversion are the brand's ledger Units (the count Today's Target
  // row prints), never the people the offer's campaigns reached. Unreadable = every outcome figure null, said so.
  const ledger = await fetchBrandOutcomeLedger(brandId, pricing === "gross" ? "gross" : "net").catch((err: Error) => {
    console.error(`[features-service] ${what} spend charts: brand ledger of ${brandId} unreadable (outcomes null): ${err.message}`);
    return null;
  });
  const step = measured.outcomeStep;
  const from = measured.target ? measured.target.fromStep : measured.leg?.fromStep ?? null;
  return rebaseSpendChartOnLedger(
    measured,
    step === null ? null : ledger === null ? "ledger_unreadable" : ledgerCountOfStep(ledgerScopeOf(ledger), step).row,
    from === null || ledger === null ? null : ledgerCountOfStep(ledgerScopeOf(ledger), from).row,
    measured.target?.learningOutcomesRequired ?? measured.leg?.learningOutcomesRequired ?? 10,
  );
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
    res.json(await funnelCampaignSpendCharts(row, brandId, pricing, headers));
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error("[features-service] funnel campaign spend charts error:", err);
    res.status(502).json({ error: "Failed to read the campaign's spend charts" });
  }
});

/**
 * The brand's scope for its charts (BRAND-GRAIN-READS-1107): every offer any campaign states, every sales funnel
 * campaign selling one of them, and every campaign of each offer per channel (the offer chart's inception rule).
 */
export async function brandChartScope(brandId: string, headers: DownstreamHeaders) {
  const [rows, channelMap] = await Promise.all([
    fetchSalesFunnelCampaigns(brandId, null, headers),
    fetchOfferChannelMap(brandId, headers),
    assertBrandHeld(brandId, headers),
  ]);
  const ofOffers = rows.filter((r) => Boolean(r.offerId));
  const offerIds = [...new Set([...channelMap.offerIds, ...ofOffers.map((r) => r.offerId)])].sort();
  const channels = mergeOfferChannels(offerIds.map((o) => channelMap.channelsOf(o)));
  return { rows: ofOffers, offerIds, channels };
}

router.get("/brands/:brandId/spend-charts", apiKeyAuth, async (req, res) => {
  try {
    const auth = req as AuthenticatedRequest & { params: { brandId: string } };
    const { brandId } = auth.params;
    const pricing = pricingOrRefuse(req.query.pricing);
    if (pricing === null) return void res.status(400).json({ error: "pricing must be one of: gross, net", reason: "pricing_unrecognised" });
    const headers: DownstreamHeaders = { orgId: auth.orgId, userId: auth.userId, runId: auth.runId, featureSlug: undefined };
    const { rows, offerIds, channels } = await brandChartScope(brandId, headers);
    if (rows.length === 0) return void res.status(404).json({ error: "This brand runs no sales funnel campaign", reason: "brand_has_no_campaigns" });
    const body = await servedCached({
      view: "brand-spend-charts",
      scopeKey: buildScopeKey(brandId, {
        orgId: headers.orgId,
        offers: offerIds.join("+"),
        units: rows.flatMap((r) => r.units.map((u) => `${u.campaignId}:${u.legKey}`)).sort().join("+"),
        targets: rows.map((r) => `${r.id}:${r.status}:${r.target ?? ""}`).sort().join("+"),
        campaigns: `inception:${channels.map((c) => `${c.featureSlug}>${c.campaignIds.join("+")}`).join(",")}`,
        pricing,
      }),
      orgId: headers.orgId,
      responseShape: routeResponseShapeFingerprint("/brands/{brandId}/spend-charts"),
      compute: () => computeBrandSpendCharts(brandId, offerIds, rows, channels, pricing, headers),
    });
    res.json(body);
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error("[features-service] brand spend charts error:", err);
    res.status(502).json({ error: "Failed to read the brand's spend charts" });
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
    const [rows, channelMap] = await Promise.all([
      fetchSalesFunnelCampaigns(brandId, offerId, headers),
      fetchOfferChannelMap(brandId, headers),
      assertBrandHeld(brandId, headers),
    ]);
    const ofOffer = rows.filter((r) => r.offerId === offerId);
    if (ofOffer.length === 0) return void res.status(404).json({ error: "This offer runs no sales funnel campaign on this brand", reason: "offer_has_no_campaigns" });
    const offerChannels = channelMap.channelsOf(offerId);
    const body = await servedCached({
      view: "offer-spend-charts",
      scopeKey: buildScopeKey(offerId, {
        orgId: headers.orgId,
        brandId,
        units: ofOffer.flatMap((r) => r.units.map((u) => `${u.campaignId}:${u.legKey}`)).sort().join("+"),
        // SPEND-CHART-TARGET-1108: the chart counts the Target most live campaigns state.
        targets: ofOffer.map((r) => `${r.id}:${r.status}:${r.target ?? ""}`).sort().join("+"),
        // Every campaign of the offer, legacy ones included (SPEND-CHARTS-INCEPTION-1027): a cell built on the funnel
        // units alone keys differently and is never served again.
        campaigns: `inception:${offerChannels.map((c) => `${c.featureSlug}>${c.campaignIds.join("+")}`).join(",")}`,
        pricing,
      }),
      orgId: headers.orgId,
      responseShape: routeResponseShapeFingerprint("/offers/{offerId}/spend-charts"),
      compute: () => computeOfferSpendCharts(offerId, brandId, ofOffer, offerChannels, pricing, headers),
    });
    res.json(body);
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error("[features-service] offer spend charts error:", err);
    res.status(502).json({ error: "Failed to read the offer's spend charts" });
  }
});

export default router;
