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
import { ledgerCountOfStep, ledgerUnitDays } from "../lib/ledger-counts.js";
import { readLedgerScope, ledgerBasisOf } from "../lib/ledger-counts-io.js";
import { withLedgerStepSeries, type LedgerStepSeries } from "../lib/ledger-outcome-cost-series.js";
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
import type { SalesPath } from "../lib/offer-sales-paths.js";
import { expectedRouteFigures } from "../lib/outcome-accounting.js";
import {
  OUTCOME_COST_STEPS,
  buildOutcomeCostSeries,
  contactedOutcomeLeads,
  expectedStepCosts,
  leadStepAccounting,
  pathRouteLegs,
  stepValues,
  type OutcomeCostStep,
  type OutcomeCostStepSeries,
  type StepExpectedCost,
  type StepValue,
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
  steps: Array<OutcomeCostStepSeries | LedgerStepSeries>;
  ledger: { basis: "ledger"; scope: "brand"; unavailableReason: string | null; ledgerDaysMissing: string[] };
}

interface ExpectedPerStep {
  costs: Map<string, StepExpectedCost>;
  values: Map<string, StepValue>;
  /** The expected sales path the figures are read off (OUTCOME-ACCOUNTING-1107 walks it), its basis and LTR source. */
  path: SalesPath | null;
  /** Every priced path of the offer's model, best first: a step off the expected path is read on the best one through it. */
  paths: SalesPath[];
  basis: string | null;
  lifetimeRevenueSource: string | null;
}

/** The expected cost AND value per step, off the offer's expected model's path. Soft: unreadable = every step null + reason. */
async function expectedCostsSoft(headers: DownstreamHeaders, brandId: string, offerId: string): Promise<ExpectedPerStep> {
  const none = (reason: string): ExpectedPerStep => ({ costs: expectedStepCosts(null, null, reason), values: stepValues(null, reason), path: null, paths: [], basis: null, lifetimeRevenueSource: null });
  try {
    const m = await offerExpectedModel({ orgId: headers.orgId, userId: headers.userId, runId: headers.runId }, brandId, offerId, EXPECTED_COLD_WAIT_MS);
    if (m === null) return none("expected_model_unavailable");
    const e = expectedForOffer(m);
    const path = e.combinationKey ? (m.body.paths.find((p) => p.combinationKey === e.combinationKey) ?? null) : null;
    return { costs: expectedStepCosts(path, e.basis, e.unavailableReason), values: stepValues(path, e.unavailableReason), path, paths: [...m.body.paths].sort((a, b) => a.rank - b.rank), basis: e.basis, lifetimeRevenueSource: m.lifetimeRevenueSource };
  } catch (err) {
    if (err instanceof ExpectedModelComputing) return none("expected_model_computing");
    console.error(`[features-service] outcome cost series: expected model unreadable (offer ${offerId}): ${(err as Error).message}`);
    return none("expected_model_unavailable");
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
  const { persons, servedLeadIds } = await readScopePeople(brandId, scope.personCampaignIds, handedAll, headers);
  const outcomes = contactedOutcomeLeads(persons, servedLeadIds, handedActed, firstSpendDay);
  // LEDGER-ONLY-1107-P2: each step's outcomes = the brand's ledger Units of it (the count Today prints), one day per Unit;
  // the people our campaigns contacted are no longer counted. An outcome the ledger lacks = every count null + reason.
  const brandLedger = await readLedgerScope(brandId, ledgerBasisOf(pricing), null, "outcome cost series");
  const ledgerOf = new Map(OUTCOME_COST_STEPS.map((step) => [step, ledgerCountOfStep(brandLedger, step)] as const));
  const outcomeDays = new Map(OUTCOME_COST_STEPS.map((step) => [step, ledgerUnitDays(ledgerOf.get(step)!)] as const));

  // OUTCOME-ACCOUNTING-1107. The Engine making each step = the offer's units whose pipe lands on it (or makes it), and
  // the funnel campaigns whose Target it is (campaign-service's `target`, else the funnel's last step).
  const stepsOf = (pipeId: string) => pipeSteps.get(pipeId) ?? pipeSteps.get(pipeId.split("~")[0]!) ?? null;
  const landing = new Map<string, Array<{ campaignId: string; featureSlug: string }>>();
  for (const u of rows.flatMap((r) => r.units)) {
    const st = stepsOf(u.pipeId);
    if (!st) continue;
    for (const k of new Set([st.toStep, st.outcome])) landing.set(k, [...(landing.get(k) ?? []), { campaignId: u.campaignId, featureSlug: u.featureSlug }]);
  }
  const targetOf = (r: SalesFunnelCampaignRow): string | null => {
    if (r.target) return r.target;
    const edges = r.units.map((u) => stepsOf(u.pipeId)).filter((x): x is NonNullable<typeof x> => x !== null);
    const froms = new Set(edges.map((e) => e.fromStep));
    return edges.find((e) => !froms.has(e.toStep))?.toStep ?? null;
  };
  const targetsByStep = new Map<string, Array<{ campaignId: string; unitCampaignIds: string[]; featureSlugs: string[] }>>();
  for (const r of rows) {
    const t = targetOf(r);
    if (t) targetsByStep.set(t, [...(targetsByStep.get(t) ?? []), { campaignId: r.id, unitCampaignIds: r.units.map((u) => u.campaignId), featureSlugs: r.units.map((u) => u.featureSlug) }]);
  }
  // Each spend read is whole-history committed spend of a set of unit campaigns, on the caller's pricing; unreadable =
  // null (the figure says `spend_unreadable`), never a zero.
  const spendOf = async (ids: readonly string[], slugs: readonly string[]): Promise<number | null> => {
    if (ids.length === 0) return 0;
    try {
      const byDay = await fetchBrandCommittedSpendByDay(brandId, [...new Set(ids)], [...new Set(slugs)].sort(), headers, pricing);
      return [...byDay.entries()].filter(([d]) => d <= today).reduce((a, [, v]) => a + v, 0);
    } catch (err) {
      console.error(`[features-service] outcome cost series: unit spend unreadable (offer ${offerId}): ${(err as Error).message}`);
      return null;
    }
  };
  const [landingSpend, targetSpend] = await Promise.all([
    Promise.all([...landing].map(async ([step, us]) => [step, await spendOf(us.map((u) => u.campaignId), us.map((u) => u.featureSlug))] as const)).then((x) => new Map(x)),
    Promise.all([...targetsByStep].map(async ([step, ts]) => [step, await spendOf(ts.flatMap((t) => t.unitCampaignIds), ts.flatMap((t) => t.featureSlugs))] as const)).then((x) => new Map(x)),
  ]);
  // The route of a step: the offer's expected path when it walks the step, else the best-ranked path of its model that
  // does (a Signup Target the expected path skips is still valued and priced on a real path, never left unvalued).
  const pathOfStep = (step: string): SalesPath | null =>
    expected.path && expected.path.legs.some((l) => l.toStep.key === step) ? expected.path : (expected.paths.find((p) => p.legs.some((l) => l.toStep.key === step)) ?? expected.path);
  const windowDaysOf = (legKey: string | null) => (legKey ? legMaturity(storedLegKeyOf(legKey)).durationDays : 0);

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
    // A step off the expected path reads its expected cost and value on the best path through it (same as `accounting`).
    expectedOf: (step: OutcomeCostStep) => {
      const p = pathOfStep(step);
      return p && p !== expected.path ? expectedStepCosts(p, expected.basis, null).get(step)! : expected.costs.get(step)!;
    },
    valueOf: (step: OutcomeCostStep) => {
      const p = pathOfStep(step);
      return p && p !== expected.path ? stepValues(p, null).get(step)! : expected.values.get(step)!;
    },
    accountingOf: (step: OutcomeCostStep, costFromStartUsd: number | null) => {
      const stepPath = pathOfStep(step);
      const routeLegs = stepPath ? pathRouteLegs(stepPath) : [];
      const figures = expectedRouteFigures(routeLegs, step, stepPath?.lifetimeRevenueUsd ?? null);
      const intoAt = routeLegs.findIndex((l) => l.toStep === step);
      const into = intoAt >= 0 ? routeLegs[intoAt]! : null;
      return leadStepAccounting({
        step,
        figures,
        intoLeg: into ? { fromStep: intoAt === 0 ? null : into.fromStep, ratePct: into.ratePct, legKey: into.legKey ?? null } : null,
        outcomes,
        landingUnitIds: new Set((landing.get(step) ?? []).map((u) => u.campaignId)),
        landingSpendUsd: landing.has(step) ? (landingSpend.get(step) ?? null) : 0,
        actualCostFromStartUsd: costFromStartUsd,
        targets: targetsByStep.get(step) ?? [],
        targetSpendUsd: targetsByStep.has(step) ? (targetSpend.get(step) ?? null) : null,
        windowDaysOf,
        lifetimeRevenueUsd: stepPath?.lifetimeRevenueUsd ?? null,
        lifetimeRevenueSource: expected.lifetimeRevenueSource,
        expectedBasis: expected.basis,
        today,
      });
    },
    today,
  });
  // LEDGER-ONLY-1107-P2: the accounting's measured halves on the ledger: cost per Unit = the landing units' spend ÷ the
  // Units THEIR runs produced, the measured return = the target campaigns' Units; the per-person yield is no ledger figure.
  const landingLedger = new Map(
    await Promise.all([...landing].map(async ([step, us]) => [step, ledgerCountOfStep(await readLedgerScope(brandId, ledgerBasisOf(pricing), us.map((u) => u.campaignId), "outcome cost series landing"), step)] as const)),
  );
  const targetLedger = new Map(
    await Promise.all([...targetsByStep].map(async ([step, ts]) => [step, ledgerCountOfStep(await readLedgerScope(brandId, ledgerBasisOf(pricing), ts.flatMap((t) => t.unitCampaignIds), "outcome cost series target"), step)] as const)),
  );
  return {
    offerId,
    brandId,
    pricing,
    costBasis: "charged",
    firstSpendDay,
    steps: steps.map((st) =>
      withLedgerStepSeries(st, ledgerOf.get(st.stepKey)!, landingLedger.get(st.stepKey) ?? null, landing.has(st.stepKey) ? (landingSpend.get(st.stepKey) ?? null) : null, targetLedger.get(st.stepKey) ?? null, targetsByStep.has(st.stepKey) ? (targetSpend.get(st.stepKey) ?? null) : null),
    ),
    ledger: { basis: "ledger", scope: "brand", unavailableReason: brandLedger.unavailableReason, ledgerDaysMissing: [...(brandLedger.ledger?.daysMissing ?? [])] },
  };
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
