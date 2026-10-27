/**
 * GET /offers/:offerId/outcome-cost-series?brandId=[&pricing=] — WHAT ONE OUTCOME COSTS, per month and since inception,
 * for every outcome step of the offer (owner 2026-10-27, OUTCOME-COST-SERIES-1027). The rule lives in
 * `lib/outcome-cost-series.ts`; this file only reads.
 *
 * The scope is the offer spend chart's (`routes/spend-charts.ts` `groupScope`): every campaign of the offer, every
 * channel, legacy campaigns included, + the brand's campaign-less work. So the since-inception spend here IS the offer
 * spend chart's and the brand offers row's. Gold cached per scope on this route's response shape.
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import type { DownstreamHeaders } from "./revenue.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { parsePricing, type Pricing } from "../lib/pricing.js";
import { fetchSalesFunnelCampaigns, type SalesFunnelCampaignRow } from "../lib/sales-funnel-campaigns-client.js";
import { fetchOfferChannelMap, type OfferChannel } from "../lib/offer-channels.js";
import { funnelCopiesFor } from "./agent-catalogue.js";
import { groupScope } from "./spend-charts.js";
import { fetchFollowupActionRows, readScopePeople, utcToday } from "../lib/spend-charts-io.js";
import { fetchBrandCommittedSpendByDay } from "../lib/brand-spend-by-day-client.js";
import { addBrandLevelByDay, fetchBrandLevelSpend } from "../lib/brand-level-spend.js";
import { legMaturity } from "../lib/maturity.js";
import { pipeLegKeyOf, storedLegKeyOf } from "../lib/funnel-legs.js";
import { expectedForOffer, offerExpectedModel, ExpectedModelComputing } from "../lib/expected-return.js";
import {
  buildOutcomeCostSeries,
  contactedOutcomeDays,
  expectedStepCosts,
  type OutcomeCostStep,
  type OutcomeCostStepSeries,
  type StepExpectedCost,
} from "../lib/outcome-cost-series.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { routeResponseShapeFingerprint } from "../lib/response-shape.js";

const router = Router();

/** How long a read waits on a cold expected model (computed once per offer, then memoized). */
const EXPECTED_COLD_WAIT_MS = 25_000;

export interface OutcomeCostSeriesBody {
  offerId: string;
  brandId: string;
  pricing: Pricing;
  costBasis: "charged";
  /** The offer's first spend day: an outcome before it is not the offer's. Null when the offer never spent. */
  firstSpendDay: string | null;
  steps: OutcomeCostStepSeries[];
}

/** The expected cost per step, off the offer's expected model's path. Soft: unreadable = every step null + reason. */
async function expectedCostsSoft(headers: DownstreamHeaders, brandId: string, offerId: string): Promise<Map<string, StepExpectedCost>> {
  try {
    const m = await offerExpectedModel({ orgId: headers.orgId, userId: headers.userId, runId: headers.runId }, brandId, offerId, EXPECTED_COLD_WAIT_MS);
    if (m === null) return expectedStepCosts(null, null, "expected_model_unavailable");
    const e = expectedForOffer(m);
    const path = e.combinationKey ? (m.body.paths.find((p) => p.combinationKey === e.combinationKey) ?? null) : null;
    return expectedStepCosts(path, e.basis, e.unavailableReason);
  } catch (err) {
    if (err instanceof ExpectedModelComputing) return expectedStepCosts(null, null, "expected_model_computing");
    console.error(`[features-service] outcome cost series: expected model unreadable (offer ${offerId}): ${(err as Error).message}`);
    return expectedStepCosts(null, null, "expected_model_unavailable");
  }
}

export async function computeOutcomeCostSeries(
  offerId: string,
  brandId: string,
  rows: readonly SalesFunnelCampaignRow[],
  offerChannels: readonly OfferChannel[],
  pricing: Pricing,
  headers: DownstreamHeaders,
  today: string = utcToday(),
): Promise<OutcomeCostSeriesBody> {
  const scope = groupScope(rows, null, offerChannels);
  const unitIds = rows.flatMap((r) => r.units.map((u) => u.campaignId));
  const [ownByDay, brandLevel, handedRows, { pipeSteps }, expected] = await Promise.all([
    scope.campaignIds.length === 0
      ? Promise.resolve(new Map<string, number>())
      : fetchBrandCommittedSpendByDay(brandId, scope.campaignIds, scope.featureSlugs, headers, pricing),
    fetchBrandLevelSpend({ brandId, orgId: headers.orgId, pricing, featureScope: scope.featureSlugs, campaignScoped: true }),
    unitIds.length > 0 ? fetchFollowupActionRows(brandId, unitIds) : Promise.resolve([]),
    funnelCopiesFor([...new Set(rows.map((r) => r.salesFunnelId))]),
    expectedCostsSoft(headers, brandId, offerId),
  ]);
  const spendByDay = addBrandLevelByDay(ownByDay, brandLevel);
  const firstSpendDay = [...spendByDay.entries()].filter(([, v]) => v !== 0).map(([d]) => d).sort()[0] ?? null;
  const handedActed = new Set(handedRows.filter((r) => r.actedCount > 0).map((r) => r.leadId));
  const handedAll = new Set(handedRows.map((r) => r.leadId));
  const persons = await readScopePeople(brandId, scope.personCampaignIds, handedAll, headers);
  const outcomeDays = contactedOutcomeDays(persons, new Set(scope.personCampaignIds), handedActed, firstSpendDay);

  // The learning bar of a step: the maturity rule of the offer's leg landing on it, else the default rule.
  const barByStep = new Map<string, number>();
  for (const u of rows.flatMap((r) => r.units)) {
    const s = pipeSteps.get(u.pipeId);
    if (!s || barByStep.has(s.toStep)) continue;
    barByStep.set(s.toStep, legMaturity(storedLegKeyOf(pipeLegKeyOf(u.featureSlug, u.legKey))).outcomesRequired);
  }
  const steps = buildOutcomeCostSeries({
    spendByDay,
    outcomeDays,
    learningBarOf: (step: OutcomeCostStep) => barByStep.get(step) ?? legMaturity(null).outcomesRequired,
    expectedOf: (step: OutcomeCostStep) => expected.get(step)!,
    today,
  });
  return { offerId, brandId, pricing, costBasis: "charged", firstSpendDay, steps };
}

router.get("/offers/:offerId/outcome-cost-series", apiKeyAuth, async (req, res) => {
  try {
    const auth = req as AuthenticatedRequest & { params: { offerId: string } };
    const { offerId } = auth.params;
    const brandId = typeof req.query.brandId === "string" ? req.query.brandId.trim() : "";
    if (!brandId) return void res.status(400).json({ error: "brandId is required", reason: "brand_id_required" });
    const pricing = parsePricing(req.query.pricing);
    if (pricing === null) return void res.status(400).json({ error: "pricing must be one of: gross, net", reason: "pricing_unrecognised" });
    const headers: DownstreamHeaders = { orgId: auth.orgId, userId: auth.userId, runId: auth.runId, featureSlug: undefined };
    const [rows, channelMap] = await Promise.all([
      fetchSalesFunnelCampaigns(brandId, offerId, headers),
      fetchOfferChannelMap(brandId, headers),
      assertBrandHeld(brandId, headers),
    ]);
    const ofOffer = rows.filter((r) => r.offerId === offerId);
    const offerChannels = channelMap.channelsOf(offerId);
    if (ofOffer.length === 0 && offerChannels.length === 0) {
      return void res.status(404).json({ error: "This offer runs no campaign on this brand", reason: "offer_has_no_campaigns" });
    }
    const body = await servedCached({
      view: "offer-outcome-cost-series",
      scopeKey: buildScopeKey(offerId, {
        orgId: headers.orgId,
        brandId,
        units: ofOffer.flatMap((r) => r.units.map((u) => `${u.campaignId}:${u.legKey}`)).sort().join("+"),
        campaigns: offerChannels.map((c) => `${c.featureSlug}>${c.campaignIds.join("+")}`).join(","),
        pricing,
      }),
      orgId: headers.orgId,
      responseShape: routeResponseShapeFingerprint("/offers/{offerId}/outcome-cost-series"),
      compute: () => computeOutcomeCostSeries(offerId, brandId, ofOffer, offerChannels, pricing, headers),
    });
    res.json(body);
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error("[features-service] offer outcome cost series error:", err);
    res.status(502).json({ error: "Failed to read the offer's outcome cost series" });
  }
});

export default router;
