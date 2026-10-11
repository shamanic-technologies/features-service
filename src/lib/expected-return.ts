/**
 * THE EXPECTED RETURN: a return every ROI-bearing read serves, never empty (owner 2026-10-11, verbatim: "on devrait
 * toujours avoir une valeur même expected ... quitte à poser une hypothèse. De sorte à ce que tout contienne un ROI").
 *
 * ADDITIVE. The measured return (`costEconomics.roiMultiple`, `costEconomics.maturity`) and its maturity verdict are
 * untouched; `expectedReturn` is served BESIDE them, and says what it rests on:
 *
 *   1. MEASURED: the scope's own return is mature (`maturity.isMature` and a mature `roiMultiple`) → that figure.
 *   2. Else the SALES PATH MODEL (`GET /offers/:offerId/sales-paths`, `computeOfferSalesPathsModel`, the byte-same
 *      computation): ROI = lifetime revenue ÷ Σ cost per outcome × outcomes needed per paying client, each leg rate
 *      measured > stated > fleet median > industry default, each leg cost best mature workflow > fleet measured >
 *      seeded default, the offer's stated lifetime revenue else the fleet median. One grade per campaign: the
 *      Sales path page and this field read the same path.
 *
 * `basis` = the WEAKEST input the figure rests on (`measured` < `stated` < `fleet` < `default`), and `assumptions`
 * lists every input with its own source, so the dashboard's tooltip says it. No fake precision: a default rate or
 * a seeded cost makes the whole figure `default`.
 *
 * Which path a scope reads:
 *   - a sales funnel campaign: the path of its `salesFunnelId` (= the combination key);
 *   - a campaign (one channel × leg): the best SELECTED path running it (the sales-paths `campaigns[].roi`), else
 *     the best path running it;
 *   - an offer: the best selected path, else the best path; an offer running no funnel campaign walks EVERY leg
 *     of the catalogue (what we would sell it), and says so (`assumptions` `sales_path:not_running`);
 *   - a brand: the best of its offers that run a funnel campaign, else of all its offers.
 * A scope whose own path cannot be priced falls to the next coarser one (campaign → offer), named by
 * `combinationKey`.
 *
 * Null only when the model cannot be READ (`unavailableReason`), loudly, never a 502 of the read carrying it.
 * The model is memoized per (org, brand, offer), served stale while it refreshes behind.
 */
import { FUNNEL_LEG_KEYS, FUNNEL_LEGS, funnelLeg, storedCombinationKeyOf, storedLegKeyOf } from "./funnel-legs.js";
import {
  DEFAULT_COST_PER_OUTCOME_USD,
  resolveLegChannelCost,
  type LegChannelPrice,
  type OfferSalesPathsBody,
  type SalesPath,
  type SalesPathCostSource,
  type SalesPathRateSource,
} from "./offer-sales-paths.js";
import type { EffectiveArrowRate, EffectiveRateSource } from "./effective-conversion-rates.js";
import type { OfferLifetimeRevenueSource as LifetimeRevenueSource } from "./offer-lifetime-revenue.js";
import type { AudienceStatsEnvelope } from "./audience-stats-compute.js";

/** What an expected figure rests on, weakest last. */
export type ExpectedBasis = "measured" | "stated" | "fleet" | "default";
const BASIS_ORDER: readonly ExpectedBasis[] = ["measured", "stated", "fleet", "default"];

/** One input of an expected figure, with its source in the customer's terms. */
export interface ExpectedAssumption {
  input: "lifetime_revenue" | "rate" | "cost" | "sales_path";
  /** The leg it is about (rate, cost). Null otherwise. */
  legKey: string | null;
  basis: ExpectedBasis;
  /** The producer's own source word (`fleet_median`, `industry_default`, `workflow`, `offer_stated`, `not_running`...). */
  source: string;
}

export type ExpectedReturnUnavailableReason =
  /** The sales path model could not be read (logged). */
  | "expected_model_unavailable"
  /** The model is still computing for the first time since boot (served on the next read). */
  | "expected_model_computing"
  /** No path of the model could be priced. */
  | "no_priced_sales_path";

export interface ExpectedCostPerOutcome {
  costPerOutcomeUsd: number;
  legKey: string;
  /** The outcome the cost buys: the leg's TO step key. */
  stepKey: string;
  basis: ExpectedBasis;
  source: SalesPathCostSource;
}

export interface ExpectedReturn {
  /** Never null unless `unavailableReason`. */
  roiMultiple: number | null;
  basis: ExpectedBasis | null;
  assumptions: ExpectedAssumption[];
  /** The sales path the model figure is read off (stored spelling). Null on a measured figure. */
  combinationKey: string | null;
  /** The expected cost per outcome of the scope's leg on that path (its own entry leg for an offer/funnel/brand). */
  costPerOutcome: ExpectedCostPerOutcome | null;
  unavailableReason: ExpectedReturnUnavailableReason | null;
}

/** The slice of a served `maturity` pair the measured rung reads. */
export interface MeasuredReturnPair {
  isMature: boolean | null;
  mature: { roiMultiple: number | null } | null;
}

const RATE_BASIS: Record<SalesPathRateSource, ExpectedBasis> = {
  crm_measured: "measured",
  measured_on_our_leads: "measured",
  customer_stated: "stated",
  fleet_median: "fleet",
  industry_default: "default",
};
const COST_BASIS: Record<SalesPathCostSource, ExpectedBasis> = {
  workflow: "measured",
  fleet_measured: "fleet",
  default: "default",
  benchmark: "default",
};
const LTR_BASIS: Record<LifetimeRevenueSource, ExpectedBasis> = { offer_stated: "stated", fleet_median: "fleet" };

const weakest = (bases: readonly ExpectedBasis[]): ExpectedBasis =>
  bases.reduce<ExpectedBasis>((w, b) => (BASIS_ORDER.indexOf(b) > BASIS_ORDER.indexOf(w) ? b : w), "measured");

export const unavailableExpectedReturn = (reason: ExpectedReturnUnavailableReason): ExpectedReturn => ({
  roiMultiple: null,
  basis: null,
  assumptions: [],
  combinationKey: null,
  costPerOutcome: null,
  unavailableReason: reason,
});

/** PURE: the expected cost per outcome of `legKey` on `path` (null on a human leg or an unpriced one). */
function costOn(path: SalesPath, legKey: string | null): ExpectedCostPerOutcome | null {
  const leg = legKey
    ? path.legs.find((l) => l.legKey === legKey)
    : path.legs.find((l) => l.workedBy === "platform" && l.costPerOutcomeUsd !== null);
  if (!leg || leg.costPerOutcomeUsd === null || leg.costSource === null) return null;
  return {
    costPerOutcomeUsd: leg.costPerOutcomeUsd,
    legKey: leg.legKey,
    stepKey: leg.toStep.key,
    basis: COST_BASIS[leg.costSource],
    source: leg.costSource,
  };
}

/** PURE: the expected return read off one PRICED path (`roi` non-null). */
export function expectedFromPath(
  path: SalesPath,
  lifetimeRevenueSource: LifetimeRevenueSource | null,
  legKey: string | null,
  extra: readonly ExpectedAssumption[] = [],
): ExpectedReturn {
  const assumptions: ExpectedAssumption[] = [...extra];
  if (lifetimeRevenueSource) {
    assumptions.push({ input: "lifetime_revenue", legKey: null, basis: LTR_BASIS[lifetimeRevenueSource], source: lifetimeRevenueSource });
  }
  path.legs.forEach((l, i) => {
    // The entry leg's rate prices nothing (the path counts from its outcome); every later leg's does.
    if (i > 0 && l.rateSource) assumptions.push({ input: "rate", legKey: l.legKey, basis: RATE_BASIS[l.rateSource], source: l.rateSource });
    if (l.costSource) assumptions.push({ input: "cost", legKey: l.legKey, basis: COST_BASIS[l.costSource], source: l.costSource });
  });
  return {
    roiMultiple: path.roi,
    basis: weakest(assumptions.map((a) => a.basis)),
    assumptions,
    combinationKey: path.combinationKey,
    costPerOutcome: costOn(path, legKey),
    unavailableReason: null,
  };
}

/** One offer's model, as `expected-return` reads it. */
export interface OfferExpectedModel {
  offerId: string;
  body: OfferSalesPathsBody;
  /** The selected combination keys (stored spelling); empty when the offer runs no funnel campaign. */
  selected: readonly string[];
  lifetimeRevenueSource: LifetimeRevenueSource | null;
  /** True when the offer runs no funnel campaign and the model walked every catalogue leg. */
  notRunning: boolean;
  /** What the paths were priced on, to price a combination the build does not list. Absent = list only. */
  inputs?: CombinationInputs;
}

/** The rates, costs and lifetime revenue an offer's paths are priced on (`computeOfferSalesPathsModel`). */
export interface CombinationInputs {
  lifetimeRevenueUsd: number | null;
  rates: readonly EffectiveArrowRate[];
  prices: ReadonlyMap<string, LegChannelPrice>;
  fleetPrices: ReadonlyMap<string, number>;
}

const priced = (paths: readonly SalesPath[]): SalesPath[] => paths.filter((p) => p.roi !== null && Number.isFinite(p.roi));
const best = (paths: readonly SalesPath[]): SalesPath | null =>
  priced(paths).sort((a, b) => b.roi! - a.roi! || a.combinationKey.localeCompare(b.combinationKey))[0] ?? null;
const notRunningAssumption = (m: OfferExpectedModel): ExpectedAssumption[] =>
  m.notRunning ? [{ input: "sales_path", legKey: null, basis: "default", source: "not_running" }] : [];

/** A path that starts from nothing (Lead found), not on a trigger: its cost covers the whole way to a paying client. */
const proactive = (p: SalesPath): boolean => p.legs[0]?.reactive !== true;

/** PURE: an offer's expected return: best selected path, else best path; proactive before reactive within each. */
export function expectedForOffer(m: OfferExpectedModel): ExpectedReturn {
  const sel = new Set(m.selected);
  const selected = m.body.paths.filter((p) => sel.has(p.combinationKey));
  const path =
    best(selected.filter(proactive)) ?? best(selected) ?? best(m.body.paths.filter(proactive)) ?? best(m.body.paths);
  return path ? expectedFromPath(path, m.lifetimeRevenueSource, null, notRunningAssumption(m)) : unavailableExpectedReturn("no_priced_sales_path");
}

/**
 * PURE: a sales funnel campaign's expected return, on ITS OWN path: the listed path when the build lists it
 * (byte-same as the Sales path page), else its own legs priced on the SAME rates and costs (`priceCombination`:
 * a reactive funnel, a leg the customer's team works). Only a combination that cannot be priced at all falls to
 * the offer's figure.
 */
export function expectedForCombination(m: OfferExpectedModel, salesFunnelId: string): ExpectedReturn {
  const key = storedCombinationKeyOf(salesFunnelId);
  const path = priced(m.body.paths).find((p) => p.combinationKey === key);
  if (path) return expectedFromPath(path, m.lifetimeRevenueSource, null);
  const own = m.inputs ? priceCombination(key, m.inputs, m.lifetimeRevenueSource) : null;
  return own ?? expectedForOffer(m);
}

const RATE_WORD: Record<EffectiveRateSource, { basis: ExpectedBasis; source: (r: EffectiveArrowRate) => string }> = {
  measured: { basis: "measured", source: (r) => (r.measured.basis === "crm" ? "crm_measured" : "measured_on_our_leads") },
  manual: { basis: "stated", source: () => "customer_stated" },
  median: { basis: "fleet", source: () => "fleet_median" },
  default: { basis: "default", source: () => "industry_default" },
};

/**
 * PURE: P(paying client | a person at `step`) over the BEST route of catalogue legs on the brand's rates, with the
 * weakest basis it rests on. 1 at Paid client; null when no route is rated.
 */
function bestRouteToPaid(step: string, rates: ReadonlyMap<string, EffectiveArrowRate>, seen: ReadonlySet<string> = new Set()): { p: number; basis: ExpectedBasis } | null {
  if (step === "paid_client") return { p: 1, basis: "measured" };
  let best: { p: number; basis: ExpectedBasis } | null = null;
  for (const leg of FUNNEL_LEGS) {
    if (leg.fromStep?.key !== step || seen.has(leg.toStep.key)) continue;
    const r = rates.get(leg.legKey);
    if (!r || r.effectiveRatePct === null || r.source === null) continue;
    const rest = bestRouteToPaid(leg.toStep.key, rates, new Set([...seen, step]));
    if (!rest) continue;
    const p = (r.effectiveRatePct / 100) * rest.p;
    if (!best || p > best.p) best = { p, basis: weakest([RATE_WORD[r.source].basis, rest.basis]) };
  }
  return best;
}

/**
 * PURE: one combination (`legKey[@channel]+...`, stored spelling) priced on the offer's inputs, the sales-path
 * formula: cost per paying client = Σ platform leg cost × outcomes needed (each leg's cost: workflow > fleet
 * measured > seeded default; a leg the customer's team works costs nothing); ROI = the value it ADDS per paying
 * client ÷ that cost, where a funnel starting on a valued step (a reactive one, on a trigger) is credited the
 * client MINUS what the people it took over were already worth there (best rated route to Paid client, the
 * campaign's own value-added rule, `lib/value-added.ts`). Null when a leg is unrated or a platform leg unpriced.
 */
export function priceCombination(key: string, inputs: CombinationInputs, lifetimeRevenueSource: LifetimeRevenueSource | null): ExpectedReturn | null {
  const ltr = inputs.lifetimeRevenueUsd;
  if (ltr === null || !(ltr > 0)) return null;
  const rates = new Map(inputs.rates.filter((r) => r.legKey).map((r) => [r.legKey!, r]));
  const legs = key.split("+").map((part) => {
    const [legKey, slug] = part.split("@");
    return { legKey: storedLegKeyOf(legKey), slug: slug ?? null, def: funnelLeg(storedLegKeyOf(legKey)) };
  });
  if (legs.length === 0 || legs.some((l) => l.def === null) || legs[legs.length - 1].def!.toStep.key !== "paid_client") return null;

  const assumptions: ExpectedAssumption[] = [];
  if (lifetimeRevenueSource) assumptions.push({ input: "lifetime_revenue", legKey: null, basis: LTR_BASIS[lifetimeRevenueSource], source: lifetimeRevenueSource });
  let needed = 1;
  let cost = 0;
  let costOfFirstPlatform: ExpectedCostPerOutcome | null = null;
  const rateOf = (legKey: string) => {
    const r = rates.get(legKey);
    return r && r.effectiveRatePct !== null && r.effectiveRatePct > 0 && r.source !== null ? r : null;
  };
  for (let i = legs.length - 1; i >= 0; i -= 1) {
    const l = legs[i];
    if (l.slug) {
      const k = `${l.legKey}|${l.slug}`;
      const c = resolveLegChannelCost(inputs.prices.get(k), inputs.fleetPrices.get(k), DEFAULT_COST_PER_OUTCOME_USD.get(k));
      if (c.costPerOutcomeUsd === null || c.costSource === null) return null;
      cost += c.costPerOutcomeUsd * needed;
      assumptions.push({ input: "cost", legKey: l.legKey, basis: COST_BASIS[c.costSource], source: c.costSource });
      costOfFirstPlatform = { costPerOutcomeUsd: c.costPerOutcomeUsd, legKey: l.legKey, stepKey: l.def!.toStep.key, basis: COST_BASIS[c.costSource], source: c.costSource };
    }
    if (i === 0) break;
    const r = rateOf(l.legKey);
    if (!r) return null;
    assumptions.push({ input: "rate", legKey: l.legKey, basis: RATE_WORD[r.source!].basis, source: RATE_WORD[r.source!].source(r) });
    needed /= r.effectiveRatePct! / 100;
  }
  if (!(cost > 0)) return null;

  // Where it took its people over: the first leg's start, unless that is nothing / Lead found (worth $0).
  const from = legs[0].def!.fromStep?.key ?? null;
  let added = ltr;
  if (from !== null && from !== "lead_found") {
    const r0 = rateOf(legs[0].legKey);
    const route = bestRouteToPaid(from, rates);
    if (!r0 || !route) return null;
    // People at the takeover step per paying client × what one was already worth there.
    added = ltr - (needed / (r0.effectiveRatePct! / 100)) * ltr * route.p;
    assumptions.push({ input: "sales_path", legKey: legs[0].legKey, basis: route.basis, source: `value_added_from:${from}` });
  }
  return {
    roiMultiple: added / cost,
    basis: weakest(assumptions.map((a) => a.basis)),
    assumptions,
    combinationKey: key,
    costPerOutcome: costOfFirstPlatform,
    unavailableReason: null,
  };
}

/** PURE: a campaign's (one channel × leg) expected return: best selected path running it, else best path running it, else the offer's. */
export function expectedForCampaign(m: OfferExpectedModel, channelSlug: string, legKeys: readonly string[]): ExpectedReturn {
  const legs = new Set(legKeys.map(storedLegKeyOf));
  const runs = (p: SalesPath) => p.legs.some((l) => legs.has(l.legKey) && l.channel?.slug === channelSlug);
  const sel = new Set(m.selected);
  const path = best(m.body.paths.filter((p) => runs(p) && sel.has(p.combinationKey))) ?? best(m.body.paths.filter(runs));
  if (!path) return expectedForOffer(m);
  const leg = path.legs.find((l) => legs.has(l.legKey) && l.channel?.slug === channelSlug)!;
  return expectedFromPath(path, m.lifetimeRevenueSource, leg.legKey);
}

/** PURE: a brand's expected return: the best of its offers running a funnel campaign, else of all its offers. */
export function expectedForBrand(models: readonly OfferExpectedModel[]): ExpectedReturn {
  const running = models.filter((m) => !m.notRunning);
  const pool = (running.length > 0 ? running : models).map(expectedForOffer).filter((e) => e.roiMultiple !== null);
  pool.sort((a, b) => b.roiMultiple! - a.roiMultiple! || (a.combinationKey ?? "").localeCompare(b.combinationKey ?? ""));
  return pool[0] ?? unavailableExpectedReturn("no_priced_sales_path");
}

/**
 * PURE: the measured rung first. A scope whose own return is MATURE serves it (`basis: "measured"`); else the
 * model's figure. The model's cost per outcome rides along either way (it is the expected one).
 */
export function withMeasuredReturn(model: ExpectedReturn, measured: MeasuredReturnPair | null | undefined): ExpectedReturn {
  const roi = measured?.isMature === true ? (measured.mature?.roiMultiple ?? null) : null;
  if (roi === null || !Number.isFinite(roi)) return model;
  return {
    roiMultiple: roi,
    basis: "measured",
    assumptions: [],
    combinationKey: null,
    costPerOutcome: model.costPerOutcome,
    unavailableReason: null,
  };
}

// ── IO: the memoized per-offer model ─────────────────────────────────────────────────────────────

export interface ExpectedIdentity {
  orgId: string;
  userId?: string;
  runId?: string;
}

/** Fresh window of a model; a stale one is served (up to `STALE_MS`) while it is recomputed behind. */
const FRESH_MS = 120_000;
const STALE_MS = 30 * 60_000;
/** How long a cold read waits on the first computation before answering `expected_model_computing`. */
const COLD_WAIT_MS = 25_000;
/** How long the model waits on the fleet-cost build right after a boot. */
const FLEET_WAIT_MS = 20_000;
const MAX_ENTRIES = 2_000;

interface Entry {
  at: number;
  value?: OfferExpectedModel | null;
  pending?: Promise<OfferExpectedModel | null>;
}
const entries = new Map<string, Entry>();

export function __resetExpectedReturnMemo(): void {
  entries.clear();
}

const inputsOf = (m: { lifetimeRevenue: { usd: number | null }; rates: EffectiveArrowRate[]; prices: ReadonlyMap<string, LegChannelPrice>; fleetPrices: ReadonlyMap<string, number> }): CombinationInputs => ({
  lifetimeRevenueUsd: m.lifetimeRevenue.usd,
  rates: m.rates,
  prices: m.prices,
  fleetPrices: m.fleetPrices,
});

async function computeModel(identity: ExpectedIdentity, brandId: string, offerId: string): Promise<OfferExpectedModel | null> {
  const { computeOfferSalesPathsModel } = await import("../routes/offer-sales-paths.js");
  const id = { orgId: identity.orgId, userId: identity.userId ?? "", runId: identity.runId ?? "" };
  const run = (legKeysOverride?: readonly string[]) =>
    computeOfferSalesPathsModel({ identity: id, offerId, brandId, scope: "ticked", legKeysOverride, fleetWaitMs: FLEET_WAIT_MS });
  const own = await run();
  if (own === null) return null;
  const selected = own.selectedPaths?.combinationKeys ?? [];
  if (own.body.status === "ok" && priced(own.body.paths).length > 0) {
    return { offerId, body: own.body, selected, lifetimeRevenueSource: own.lifetimeRevenue.source, notRunning: false, inputs: inputsOf(own) };
  }
  // Runs no funnel (or none prices): what we would sell it, every catalogue leg.
  const all = await run(FUNNEL_LEG_KEYS);
  if (all === null) return null;
  return { offerId, body: all.body, selected: [], lifetimeRevenueSource: all.lifetimeRevenue.source, notRunning: true, inputs: inputsOf(all) };
}

/**
 * One offer's model, memoized (fresh 2 min, served stale up to 30 min while recomputed). Null = the offer is not
 * the brand's. Throws `ExpectedModelComputing` when a cold computation outlasts `COLD_WAIT_MS` (it keeps going).
 */
export async function offerExpectedModel(identity: ExpectedIdentity, brandId: string, offerId: string): Promise<OfferExpectedModel | null> {
  const key = `${identity.orgId}|${brandId}|${offerId}`;
  const now = Date.now();
  const entry = entries.get(key);
  const start = (): Promise<OfferExpectedModel | null> => {
    const pending = computeModel(identity, brandId, offerId);
    const e: Entry = { ...(entries.get(key) ?? { at: 0 }), pending };
    entries.set(key, e);
    pending.then(
      (value) => {
        entries.set(key, { at: Date.now(), value });
        while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
      },
      (error) => {
        console.error(`[features-service] expected return: model of offer ${offerId} (brand ${brandId}) failed: ${(error as Error).message}`);
        const prev = entries.get(key);
        if (prev?.pending === pending) {
          if ("value" in prev) entries.set(key, { at: prev.at, value: prev.value });
          else entries.delete(key);
        }
      },
    );
    return pending;
  };
  if (entry && "value" in entry) {
    const age = now - entry.at;
    if (age <= FRESH_MS) return entry.value!;
    if (age <= STALE_MS) {
      if (!entry.pending) start().catch(() => {});
      return entry.value!;
    }
  }
  const pending = entry?.pending ?? start();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ExpectedModelComputing(offerId)), COLD_WAIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class ExpectedModelComputing extends Error {
  constructor(offerId: string) {
    super(`expected return model of offer ${offerId} is still computing`);
  }
}

/** Soft: any failure is a named null figure, logged, never a failed read. */
async function soft(what: string, run: () => Promise<ExpectedReturn>): Promise<ExpectedReturn> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ExpectedModelComputing) return unavailableExpectedReturn("expected_model_computing");
    console.error(`[features-service] expected return (${what}) unavailable: ${(error as Error).message}`);
    return unavailableExpectedReturn("expected_model_unavailable");
  }
}

const modelOrThrow = async (identity: ExpectedIdentity, brandId: string, offerId: string): Promise<OfferExpectedModel> => {
  const m = await offerExpectedModel(identity, brandId, offerId);
  if (m === null) throw new Error(`offer ${offerId} is not an offer of brand ${brandId}`);
  return m;
};

/** An offer scope (`/offers/:id/revenue`, an `?offerId=` read). */
export function expectedReturnForOffer(identity: ExpectedIdentity, brandId: string, offerId: string, measured: MeasuredReturnPair | null | undefined): Promise<ExpectedReturn> {
  return soft(`offer ${offerId}`, async () => withMeasuredReturn(expectedForOffer(await modelOrThrow(identity, brandId, offerId)), measured));
}

/** A sales funnel campaign row. */
export function expectedReturnForFunnelCampaign(
  identity: ExpectedIdentity,
  brandId: string,
  offerId: string,
  salesFunnelId: string,
  measured: MeasuredReturnPair | null | undefined,
): Promise<ExpectedReturn> {
  return soft(`funnel campaign ${salesFunnelId}`, async () =>
    withMeasuredReturn(expectedForCombination(await modelOrThrow(identity, brandId, offerId), salesFunnelId), measured),
  );
}

/** A campaign (identity) scope: its offer, channel and legs. No offer stated → the brand's figure. */
export function expectedReturnForCampaign(
  identity: ExpectedIdentity,
  brandId: string,
  campaign: { offerId: string | null; featureSlug: string; legKeys: readonly string[] },
  measured: MeasuredReturnPair | null | undefined,
): Promise<ExpectedReturn> {
  if (!campaign.offerId) return expectedReturnForBrand(identity, brandId, measured);
  const offerId = campaign.offerId;
  return soft(`campaign on offer ${offerId}`, async () =>
    withMeasuredReturn(expectedForCampaign(await modelOrThrow(identity, brandId, offerId), campaign.featureSlug, campaign.legKeys), measured),
  );
}

/** A brand scope (`/brands/:id/revenue`, a brand-wide feature read): every offer of the brand. */
export function expectedReturnForBrand(identity: ExpectedIdentity, brandId: string, measured: MeasuredReturnPair | null | undefined): Promise<ExpectedReturn> {
  return soft(`brand ${brandId}`, async () => {
    const { fetchBrandLegEconomics } = await import("./brand-leg-economics-client.js");
    const offers = (await fetchBrandLegEconomics(brandId, identity.orgId)).offers;
    const models = (await Promise.all(offers.map((o) => offerExpectedModel(identity, brandId, o.offerId)))).filter(
      (m): m is OfferExpectedModel => m !== null,
    );
    return withMeasuredReturn(expectedForBrand(models), measured);
  });
}

// ── Audience rows ────────────────────────────────────────────────────────────────────────────────

/** The slice of an audience row / envelope projection pair the measured rung reads (`returnPerDollar`). */
interface ProjectionPairLike {
  isMature: boolean | null;
  mature: { returnPerDollar: number | null } | null;
}

const projectionMeasured = (pair: ProjectionPairLike | null | undefined): MeasuredReturnPair | null =>
  pair ? { isMature: pair.isMature, mature: pair.mature ? { roiMultiple: pair.mature.returnPerDollar } : null } : null;

/**
 * PURE: an audience-stats envelope with `expectedReturn` on the envelope (the scope's) and on every row (the
 * row's own mature return, else the scope's model figure). Additive: nothing else moves.
 */
export function withAudienceExpectedReturns(envelope: AudienceStatsEnvelope, scopeModel: ExpectedReturn): AudienceStatsEnvelope & { expectedReturn: ExpectedReturn } {
  return {
    ...envelope,
    expectedReturn: withMeasuredReturn(scopeModel, projectionMeasured(envelope.brandProjection?.maturity)),
    audiences: envelope.audiences.map((row) => ({
      ...row,
      expectedReturn: withMeasuredReturn(scopeModel, projectionMeasured(row.projection?.maturity)),
    })),
  };
}

/** The scope model of an audience-stats read: campaign identity > offer > brand. */
export function expectedReturnForScope(
  identity: ExpectedIdentity,
  brandId: string,
  scope: { campaign: { offerId: string | null; featureSlug: string; legKeys: readonly string[] } | null; offerId: string | null },
): Promise<ExpectedReturn> {
  if (scope.campaign) return expectedReturnForCampaign(identity, brandId, scope.campaign, null);
  if (scope.offerId) return expectedReturnForOffer(identity, brandId, scope.offerId, null);
  return expectedReturnForBrand(identity, brandId, null);
}
