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
import { SOURCE_LEG_KEY } from "./sourcing-origins.js";
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
import type { AudienceStatsEnvelope, ProjectionRatios, ServedProjectionRatios } from "./audience-stats-compute.js";
import type { MaturityPair } from "./maturity.js";
import type { CatalogueFunnel } from "./agent-catalogue.js";
import { loadFleetCell, storeFleetCell } from "./fleet-cell-store.js";

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
  | "no_priced_sales_path"
  /** A funnel campaign's OWN path cannot be priced (a leg with no rate or no platform cost, e.g. a leads-only funnel). */
  | "own_sales_path_unpriced";

export interface ExpectedCostPerOutcome {
  costPerOutcomeUsd: number;
  legKey: string;
  /** The outcome the cost buys: the leg's TO step key. */
  stepKey: string;
  basis: ExpectedBasis;
  source: SalesPathCostSource;
}

/**
 * SPEND-CHART-TARGET-1108: one leg of the priced route an expected figure is read off, in path order. Held OFF the wire
 * (`expectedRouteOf`, a WeakMap on the figure): the spend chart reads it to price the campaign's TARGET (its cost from
 * the route's start and its conversion from the chart's entry step), never served inside `expectedReturn`.
 */
export interface ExpectedRouteLeg {
  legKey: string;
  /** The channel working the leg in this route (null = none named). */
  channelSlug: string | null;
  /** Null = from nothing (Start). */
  fromStep: string | null;
  toStep: string;
  /** The leg's rate in %, null when the route prices none (its entry leg). */
  ratePct: number | null;
  rateBasis: ExpectedBasis | null;
  /** One outcome of the leg's step: 0 on a leg the customer's own team works, null when unpriced. */
  costPerOutcomeUsd: number | null;
  costBasis: ExpectedBasis | null;
}

const routes = new WeakMap<ExpectedReturn, ExpectedRouteLeg[]>();

/** The route an expected figure was read off (null on a measured figure, an unavailable one, or one built without a route). */
export const expectedRouteOf = (e: ExpectedReturn): ExpectedRouteLeg[] | null => routes.get(e) ?? null;

const withRoute = (e: ExpectedReturn, legs: ExpectedRouteLeg[]): ExpectedReturn => {
  routes.set(e, legs);
  return e;
};

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
  return withRoute(
    {
      roiMultiple: path.roi,
      basis: weakest(assumptions.map((a) => a.basis)),
      assumptions,
      combinationKey: path.combinationKey,
      costPerOutcome: costOn(path, legKey),
      unavailableReason: null,
    },
    path.legs.map((l) => ({
      legKey: l.legKey,
      channelSlug: l.channel?.slug ?? null,
      fromStep: l.fromStep?.key ?? null,
      toStep: l.toStep.key,
      ratePct: l.conversionRatePct,
      rateBasis: l.rateSource ? RATE_BASIS[l.rateSource] : null,
      costPerOutcomeUsd: l.workedBy === "human" ? 0 : l.costPerOutcomeUsd,
      costBasis: l.workedBy === "human" ? null : l.costSource ? COST_BASIS[l.costSource] : null,
    })),
  );
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
 * PURE: the combination a funnel id is priced as: stored spelling, its SOURCING legs (Start -> Lead found) dropped.
 * A sales path counts from Lead found (a found lead is worth $0 and the sales-path model lists no sourcing leg), so a
 * funnel `start_to_lead_found@<origin>+<rest>` is the path `<rest>`. A funnel that is ONLY sourcing prices as "".
 */
export function pricedCombinationKeyOf(salesFunnelId: string): string {
  return storedCombinationKeyOf(salesFunnelId)
    .split("+")
    .filter((part) => part.split("@")[0] !== SOURCE_LEG_KEY)
    .join("+");
}

/**
 * PURE: a sales funnel campaign's expected return, on ITS OWN path: the listed path when the build lists it
 * (byte-same as the Sales path page), else its own legs priced on the SAME rates and costs (`priceCombination`:
 * a reactive funnel, a leg the customer's team works). A combination that cannot be priced is null with
 * `own_sales_path_unpriced`, NEVER another funnel's figure (owner 2026-10-12: a leads-only funnel read the offer's
 * cold-email path; supersedes "falls to the offer's figure").
 */
export function expectedForCombination(m: OfferExpectedModel, salesFunnelId: string): ExpectedReturn {
  const key = pricedCombinationKeyOf(salesFunnelId);
  const path = priced(m.body.paths).find((p) => p.combinationKey === key);
  if (path) return expectedFromPath(path, m.lifetimeRevenueSource, null);
  const own = m.inputs && key !== "" ? priceCombination(key, m.inputs, m.lifetimeRevenueSource) : null;
  return own ?? unavailableExpectedReturn("own_sales_path_unpriced");
}

const RATE_WORD: Record<EffectiveRateSource, { basis: ExpectedBasis; source: (r: EffectiveArrowRate) => string }> = {
  measured: { basis: "measured", source: (r) => (r.measured.basis === "crm" ? "crm_measured" : "measured_on_our_leads") },
  manual: { basis: "stated", source: () => "customer_stated" },
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
  const route: ExpectedRouteLeg[] = [];
  const rateOf = (legKey: string) => {
    const r = rates.get(legKey);
    return r && r.effectiveRatePct !== null && r.effectiveRatePct > 0 && r.source !== null ? r : null;
  };
  for (let i = legs.length - 1; i >= 0; i -= 1) {
    const l = legs[i];
    const routeLeg: ExpectedRouteLeg = {
      legKey: l.legKey,
      channelSlug: l.slug,
      fromStep: l.def!.fromStep?.key ?? null,
      toStep: l.def!.toStep.key,
      ratePct: null,
      rateBasis: null,
      costPerOutcomeUsd: 0,
      costBasis: null,
    };
    route.unshift(routeLeg);
    if (l.slug) {
      const k = `${l.legKey}|${l.slug}`;
      const c = resolveLegChannelCost(inputs.prices.get(k), inputs.fleetPrices.get(k), DEFAULT_COST_PER_OUTCOME_USD.get(k));
      if (c.costPerOutcomeUsd === null || c.costSource === null) return null;
      cost += c.costPerOutcomeUsd * needed;
      assumptions.push({ input: "cost", legKey: l.legKey, basis: COST_BASIS[c.costSource], source: c.costSource });
      Object.assign(routeLeg, { costPerOutcomeUsd: c.costPerOutcomeUsd, costBasis: COST_BASIS[c.costSource] });
      costOfFirstPlatform = { costPerOutcomeUsd: c.costPerOutcomeUsd, legKey: l.legKey, stepKey: l.def!.toStep.key, basis: COST_BASIS[c.costSource], source: c.costSource };
    }
    if (i === 0) break;
    const r = rateOf(l.legKey);
    if (!r) return null;
    assumptions.push({ input: "rate", legKey: l.legKey, basis: RATE_WORD[r.source!].basis, source: RATE_WORD[r.source!].source(r) });
    Object.assign(routeLeg, { ratePct: r.effectiveRatePct, rateBasis: RATE_WORD[r.source!].basis });
    needed /= r.effectiveRatePct! / 100;
  }
  if (!(cost > 0)) return null;

  // Where it took its people over: the first leg's start, unless that is nothing / Lead found (worth $0).
  const from = legs[0].def!.fromStep?.key ?? null;
  let added = ltr;
  if (from !== null && from !== "lead_found") {
    const route = bestRouteToPaid(from, rates);
    if (!route) return null;
    // The people it MOVED (its first leg's outcomes per paying client) × what each was already worth at the
    // takeover step; the ones it did not move keep their value and add nothing (catalogue `funnelEconomics`).
    added = ltr - needed * ltr * route.p;
    assumptions.push({ input: "sales_path", legKey: legs[0].legKey, basis: route.basis, source: `value_added_from:${from}` });
  }
  return withRoute(
    {
      roiMultiple: added / cost,
      basis: weakest(assumptions.map((a) => a.basis)),
      assumptions,
      combinationKey: key,
      costPerOutcome: costOfFirstPlatform,
      unavailableReason: null,
    },
    route,
  );
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
 * PURE (BRAND-GRAIN-READS-1107): the ONE offer model a brand-grain chart (`/brands/:id/spend-charts`,
 * `/brands/:id/outcome-cost-series`) reads its expected figures off: the model
 * `expectedForBrand` takes its figure from (best ROI of the offers running a funnel campaign, else of all), else the
 * first offer's (by id) so an unpriced brand still names its offer's own reason. One offer = that offer's model.
 */
export function pickBrandModel(models: readonly OfferExpectedModel[]): OfferExpectedModel | null {
  const running = models.filter((m) => !m.notRunning);
  const pool = (running.length > 0 ? running : models)
    .map((m) => ({ m, e: expectedForOffer(m) }))
    .filter(({ e }) => e.roiMultiple !== null);
  pool.sort((a, b) => b.e.roiMultiple! - a.e.roiMultiple! || (a.e.combinationKey ?? "").localeCompare(b.e.combinationKey ?? ""));
  return pool[0]?.m ?? [...models].sort((a, b) => a.offerId.localeCompare(b.offerId))[0] ?? null;
}

/**
 * PURE: the measured rung first. A scope whose own return is MATURE serves it (`basis: "measured"`); else the
 * model's figure. The model's cost per outcome rides along either way (it is the expected one).
 */
export function withMeasuredReturn(model: ExpectedReturn, measured: MeasuredReturnPair | null | undefined): ExpectedReturn {
  const roi = measured?.isMature === true ? (measured.mature?.roiMultiple ?? null) : null;
  if (roi === null || !Number.isFinite(roi)) return model;
  const out: ExpectedReturn = {
    roiMultiple: roi,
    basis: "measured",
    assumptions: [],
    combinationKey: null,
    costPerOutcome: model.costPerOutcome,
    unavailableReason: null,
  };
  // The model's route rides along with its cost per outcome (the expected one).
  const route = expectedRouteOf(model);
  return route ? withRoute(out, route) : out;
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
/**
 * How long a read that SHOWS a table of rows (the Campaigns table, one model read per row) waits on a cold model:
 * not at all. The row answers `expected_model_computing` while the model computes behind it and the next poll reads
 * the memo. Waiting `COLD_WAIT_MS` per row made the table answer in 20-40 s whenever the model could not finish
 * (prod 2026-10-16, SFC-MONEY-SLOW-1016); a 1 s wait still put 1.1-1.5 s on every read that restarted it.
 */
export const TABLE_COLD_WAIT_MS = 0;
/** How long the model waits on the fleet-cost build right after a boot. */
const FLEET_WAIT_MS = 20_000;
/**
 * How long a FAILED model computation is remembered (SFC-MONEY-SLOW-1016). Without it every read restarted the
 * computation and waited on it again: with the fleet-cost build failing (a sibling cutting its stream), each
 * Campaigns read waited 20 s per batch of rows, and the second read was no faster than the first. Within the hold
 * a read answers the failure at once (`expected_model_unavailable`, logged once per computation, never a figure).
 */
const FAILURE_HOLD_MS = 60_000;
const MAX_ENTRIES = 2_000;

interface Entry {
  at: number;
  value?: OfferExpectedModel | null;
  pending?: Promise<OfferExpectedModel | null>;
  /** The last computation failed (no value to serve): when, and why. */
  failed?: { at: number; error: Error };
  /** The value is the LAST GOOD build persisted by a previous process (served whatever its age until this process builds). */
  restored?: boolean;
}
const entries = new Map<string, Entry>();
/** One store read per key and process (LEDGER-LOAD-1107-ROI-BOOT). */
const restoring = new Map<string, Promise<void>>();

export function __resetExpectedReturnMemo(): void {
  entries.clear();
  restoring.clear();
}

// ── The last good model, persisted (LEDGER-LOAD-1107-ROI-BOOT) ───────────────────────────────────────────────────
//
// The memo lives in the process. A restart (every deploy) emptied it, and on a loaded box the first computation of an
// offer's model (every leg ladder of the offer, the fleet leg costs) took up to ~50 min to land in the refresher: every
// revenue read served `expected_model_computing` meanwhile (prod 2026-11-07 18:09-19:02, Distribute.you, 0.41x
// measured / $175.96 per positive reply → blank). Each successful build is now stored (`lib/fleet-cell-store.ts`, one
// row per (org, brand, offer)) and a process with no model in memory serves the stored one, then rebuilds behind it.
// The stored model IS a build of the same computation (same figures, same provenance: its `computedAt` is kept); a
// failed or never-finishing rebuild never replaces it.

/** `-v1`: bump when `OfferExpectedModel` changes structure (an older stored model then reads as absent). */
const modelCellKey = (key: string): string => `expected-model-v1:${key}`;

interface StoredModel {
  offerId: string;
  body: OfferSalesPathsBody;
  selected: string[];
  lifetimeRevenueSource: LifetimeRevenueSource | null;
  notRunning: boolean;
  inputs: {
    lifetimeRevenueUsd: number | null;
    rates: EffectiveArrowRate[];
    prices: Array<[string, LegChannelPrice]>;
    fleetPrices: Array<[string, number]>;
  } | null;
}

/** PURE: a model as stored text (its Maps flattened to entry arrays; a jsonb Map would read back as `{}`). */
export function serializeOfferExpectedModel(m: OfferExpectedModel): string {
  const stored: StoredModel = {
    offerId: m.offerId,
    body: m.body,
    selected: [...m.selected],
    lifetimeRevenueSource: m.lifetimeRevenueSource,
    notRunning: m.notRunning,
    inputs: m.inputs
      ? {
          lifetimeRevenueUsd: m.inputs.lifetimeRevenueUsd,
          rates: [...m.inputs.rates],
          prices: [...m.inputs.prices],
          fleetPrices: [...m.inputs.fleetPrices],
        }
      : null,
  };
  return JSON.stringify(stored);
}

/** PURE: the stored text back as a model; throws on a text this module did not write. */
export function parseStoredOfferExpectedModel(text: string): OfferExpectedModel {
  const s = JSON.parse(text) as StoredModel;
  if (typeof s?.offerId !== "string" || typeof s.body !== "object" || s.body === null || !Array.isArray(s.selected)) {
    throw new Error("stored expected model is not one this build wrote");
  }
  return {
    offerId: s.offerId,
    body: s.body,
    selected: s.selected,
    lifetimeRevenueSource: s.lifetimeRevenueSource,
    notRunning: s.notRunning,
    ...(s.inputs
      ? {
          inputs: {
            lifetimeRevenueUsd: s.inputs.lifetimeRevenueUsd,
            rates: s.inputs.rates,
            prices: new Map(s.inputs.prices),
            fleetPrices: new Map(s.inputs.fleetPrices),
          },
        }
      : {}),
  };
}

/** Load the persisted model of `key` into the memo when this process holds none (once per key; a failure = none). */
function restoreModel(key: string): Promise<void> {
  const existing = restoring.get(key);
  if (existing) return existing;
  const p = loadFleetCell(modelCellKey(key)).then((stored) => {
    if (!stored) return;
    const entry = entries.get(key);
    if (entry && "value" in entry) return;
    try {
      const value = parseStoredOfferExpectedModel(stored.text);
      entries.set(key, { ...(entry ?? {}), at: stored.computedAt, value, restored: true, failed: undefined });
      console.log(`[features-service] expected return: serving the persisted model of ${key} built ${new Date(stored.computedAt).toISOString()} while this process rebuilds it`);
    } catch (error) {
      console.error(`[features-service] expected return: persisted model of ${key} unreadable, computing:`, error);
    }
  });
  restoring.set(key, p);
  return p;
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
export async function offerExpectedModel(
  identity: ExpectedIdentity,
  brandId: string,
  offerId: string,
  coldWaitMs: number = COLD_WAIT_MS,
): Promise<OfferExpectedModel | null> {
  const key = `${identity.orgId}|${brandId}|${offerId}`;
  if (!entries.get(key) || !("value" in entries.get(key)!)) await restoreModel(key);
  const now = Date.now();
  const entry = entries.get(key);
  const start = (): Promise<OfferExpectedModel | null> => {
    const pending = computeModel(identity, brandId, offerId);
    const e: Entry = { ...(entries.get(key) ?? { at: 0 }), pending };
    entries.set(key, e);
    pending.then(
      (value) => {
        const at = Date.now();
        entries.set(key, { at, value });
        while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
        // Null = the offer is not the brand's: nothing to serve after a restart either.
        if (value) void storeFleetCell(modelCellKey(key), serializeOfferExpectedModel(value), at);
      },
      (error) => {
        console.error(`[features-service] expected return: model of offer ${offerId} (brand ${brandId}) failed: ${(error as Error).message}`);
        const prev = entries.get(key);
        if (prev?.pending === pending) {
          if ("value" in prev) entries.set(key, { at: prev.at, value: prev.value, ...(prev.restored ? { restored: true } : {}) });
          else entries.set(key, { at: 0, failed: { at: Date.now(), error: error as Error } });
        }
      },
    );
    return pending;
  };
  if (entry && "value" in entry) {
    const age = now - entry.at;
    if (age <= FRESH_MS) return entry.value!;
    // A persisted last good build is served whatever its age until this process lands its own (never blank on boot).
    if (age <= STALE_MS || entry.restored) {
      if (!entry.pending) start().catch(() => {});
      return entry.value!;
    }
  }
  if (entry?.failed && !entry.pending && now - entry.failed.at < FAILURE_HOLD_MS) throw entry.failed.error;
  // A table read (short wait) never waits on a computation an EARLIER read started: it answers
  // `expected_model_computing` at once and a later poll reads the memo (SFC-MONEY-SLOW-1016).
  const waitMs = entry?.pending && coldWaitMs < COLD_WAIT_MS ? 0 : coldWaitMs;
  const pending = entry?.pending ?? start();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ExpectedModelComputing(offerId)), waitMs);
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

// ── A funnel the offer's sales-path model cannot price: the catalogue funnel's own EXPECTED figure ───────────────

/** The served cost source of a catalogue cost word (the wire enum stays `workflow | fleet_measured | default | benchmark`). */
const servedCostSourceOf = (source: string): SalesPathCostSource =>
  source === "workflow" || source === "default" || source === "benchmark" ? source : "fleet_measured";

/**
 * PURE: a catalogue funnel's `expected` figure (`expectedFunnelEconomics`: the catalogue's, the GTM Factory planner's
 * and the funnel lists' one formula, every leg known: a play's own allowed workflows, a declared leg, a trigger-headed
 * funnel, the value ADDED over the takeover step) as an expected return. Its cost per outcome = the first platform leg
 * that does more than find people (its route rides `expectedRouteOf`: the spend chart prices the campaign's Target off it). Null when the catalogue
 * cannot price it either (its own `unavailableReason`, logged by the caller) or when it ends after Paid client.
 */
export function expectedFromCatalogueFunnel(funnel: CatalogueFunnel, lifetimeRevenueSource: LifetimeRevenueSource | null): ExpectedReturn | null {
  const e = funnel.expected;
  if (e.roi === null || !Number.isFinite(e.roi) || e.basis === null) return null;
  // A funnel that ends after Paid client (Client Satisfied) adds nothing to the client's value: no return multiple,
  // never a 0x (its people were already worth the whole value at the takeover step).
  if (funnel.legs[funnel.legs.length - 1]?.pipe?.toStep !== "paid_client") return null;
  const assumptions: ExpectedAssumption[] = [];
  if (lifetimeRevenueSource) assumptions.push({ input: "lifetime_revenue", legKey: null, basis: LTR_BASIS[lifetimeRevenueSource], source: lifetimeRevenueSource });
  let costPerOutcome: ExpectedCostPerOutcome | null = null;
  e.legs.forEach((l, i) => {
    if (i > 0 && l.rateSource && l.rateBasis) assumptions.push({ input: "rate", legKey: l.legKey, basis: l.rateBasis, source: l.rateSource });
    if (l.costSource && l.costSource !== "customer_team" && l.costBasis && l.costPerOutcomeUsd !== null) {
      assumptions.push({ input: "cost", legKey: l.legKey, basis: l.costBasis, source: l.costSource });
      const toStep = funnel.legs[i]?.pipe?.toStep ?? null;
      if (!costPerOutcome && toStep && toStep !== "lead_found") {
        costPerOutcome = { costPerOutcomeUsd: l.costPerOutcomeUsd, legKey: l.legKey, stepKey: toStep, basis: l.costBasis, source: servedCostSourceOf(l.costSource) };
      }
    }
  });
  return withRoute({ roiMultiple: e.roi, basis: e.basis, assumptions, combinationKey: funnel.id, costPerOutcome, unavailableReason: null }, catalogueRouteOf(funnel));
}

/** PURE: a catalogue funnel's expected route, leg by leg (a leg its catalogue cannot price reads a null cost, its rate kept). */
function catalogueRouteOf(funnel: CatalogueFunnel): ExpectedRouteLeg[] {
  return funnel.expected.legs.flatMap((l, i) => {
    const pipe = funnel.legs[i]?.pipe ?? null;
    if (!pipe) return [];
    return [
      {
        legKey: l.legKey,
        channelSlug: pipe.channelSlug,
        fromStep: pipe.fromStep,
        toStep: pipe.toStep,
        ratePct: l.ratePct,
        rateBasis: l.rateBasis,
        costPerOutcomeUsd: l.costPerOutcomeUsd,
        costBasis: l.costBasis,
      },
    ];
  });
}

interface CatalogueEntry {
  at: number;
  value?: ExpectedReturn;
  pending?: Promise<ExpectedReturn>;
}
const catalogueEntries = new Map<string, CatalogueEntry>();

export function __resetCatalogueExpectedMemo(): void {
  catalogueEntries.clear();
}

/** The brand's own measured / stated rates of the offer model, keyed the catalogue's way (`<from>><to>`). */
function offerRatesOf(m: OfferExpectedModel): Map<string, { ratePct: number; source: "offer_measured" | "offer_stated" }> {
  const out = new Map<string, { ratePct: number; source: "offer_measured" | "offer_stated" }>();
  for (const r of m.inputs?.rates ?? []) {
    if (!r.catalogueFromStep || !r.catalogueToStep || r.effectiveRatePct === null || !(r.effectiveRatePct > 0)) continue;
    if (r.source !== "measured" && r.source !== "manual") continue;
    out.set(`${r.catalogueFromStep}>${r.catalogueToStep}`, { ratePct: r.effectiveRatePct, source: r.source === "measured" ? "offer_measured" : "offer_stated" });
  }
  return out;
}

async function computeCatalogueExpected(m: OfferExpectedModel, salesFunnelId: string): Promise<ExpectedReturn> {
  const { loadCatalogueModelForOffer } = await import("../routes/agent-catalogue.js");
  const { funnelById } = await import("./agent-catalogue.js");
  const model = await loadCatalogueModelForOffer({
    lifetimeRevenueUsd: m.inputs?.lifetimeRevenueUsd ?? null,
    lifetimeRevenueSource: m.lifetimeRevenueSource,
    rates: offerRatesOf(m),
  });
  const funnel = funnelById(model, salesFunnelId);
  const e = funnel ? expectedFromCatalogueFunnel(funnel, m.lifetimeRevenueSource) : null;
  if (e) return e;
  console.warn(
    `[features-service] expected return: funnel ${salesFunnelId} (offer ${m.offerId}) unpriced on the catalogue too: ${funnel ? funnel.expected.unavailableReason : "funnel_not_in_catalogue"}`,
  );
  // Unpriced, but its legs' rates stand: the spend chart still reads the expected % to the campaign's Target off them
  // (SPEND-CHART-TARGET-1108); its cost walk stops on the unpriced leg (`route_leg_unpriced`).
  const unpriced = unavailableExpectedReturn("own_sales_path_unpriced");
  return funnel ? withRoute(unpriced, catalogueRouteOf(funnel)) : unpriced;
}

/**
 * The catalogue rung, memoized per (org, brand, offer, funnel) like the offer model (fresh 2 min, stale 30 min served
 * while recomputed behind). A cold read waits `coldWaitMs` then answers `expected_model_computing`.
 */
async function catalogueExpected(identity: ExpectedIdentity, brandId: string, m: OfferExpectedModel, salesFunnelId: string, coldWaitMs: number): Promise<ExpectedReturn> {
  const key = `${identity.orgId}|${brandId}|${m.offerId}|${salesFunnelId}`;
  const now = Date.now();
  const entry = catalogueEntries.get(key);
  const start = (): Promise<ExpectedReturn> => {
    const pending = computeCatalogueExpected(m, salesFunnelId);
    catalogueEntries.set(key, { ...(entry ?? { at: 0 }), pending });
    pending.then(
      (value) => {
        catalogueEntries.set(key, { at: Date.now(), value });
        while (catalogueEntries.size > MAX_ENTRIES) catalogueEntries.delete(catalogueEntries.keys().next().value!);
      },
      () => {
        const prev = catalogueEntries.get(key);
        if (prev?.pending === pending) catalogueEntries.set(key, prev.value ? { at: prev.at, value: prev.value } : { at: 0 });
      },
    );
    return pending;
  };
  if (entry?.value) {
    const age = now - entry.at;
    if (age <= FRESH_MS) return entry.value;
    if (age <= STALE_MS) {
      if (!entry.pending) start().catch(() => {});
      return entry.value;
    }
  }
  const pending = entry?.pending ?? start();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ExpectedModelComputing(m.offerId)), coldWaitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Soft: any failure is a named null figure, logged, never a failed read. A scope that is MATURE keeps its measured return
 * even while the model computes or failed (LEDGER-LOAD-1107-ROI-BOOT): the measured rung reads no model, only its cost
 * per outcome does (null until the model lands).
 */
async function soft(what: string, measured: MeasuredReturnPair | null | undefined, run: () => Promise<ExpectedReturn>): Promise<ExpectedReturn> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ExpectedModelComputing) return withMeasuredReturn(unavailableExpectedReturn("expected_model_computing"), measured);
    console.error(`[features-service] expected return (${what}) unavailable: ${(error as Error).message}`);
    return withMeasuredReturn(unavailableExpectedReturn("expected_model_unavailable"), measured);
  }
}

const modelOrThrow = async (identity: ExpectedIdentity, brandId: string, offerId: string, coldWaitMs?: number): Promise<OfferExpectedModel> => {
  const m = await offerExpectedModel(identity, brandId, offerId, coldWaitMs);
  if (m === null) throw new Error(`offer ${offerId} is not an offer of brand ${brandId}`);
  return m;
};

/** An offer scope (`/offers/:id/revenue`, an `?offerId=` read). */
export function expectedReturnForOffer(identity: ExpectedIdentity, brandId: string, offerId: string, measured: MeasuredReturnPair | null | undefined): Promise<ExpectedReturn> {
  return soft(`offer ${offerId}`, measured, async () => withMeasuredReturn(expectedForOffer(await modelOrThrow(identity, brandId, offerId)), measured));
}

/** A sales funnel campaign row (a table row: never waits on a cold model unless told otherwise, `TABLE_COLD_WAIT_MS`). */
export function expectedReturnForFunnelCampaign(
  identity: ExpectedIdentity,
  brandId: string,
  offerId: string,
  salesFunnelId: string,
  measured: MeasuredReturnPair | null | undefined,
  coldWaitMs: number = TABLE_COLD_WAIT_MS,
): Promise<ExpectedReturn> {
  return soft(`funnel campaign ${salesFunnelId}`, measured, async () => {
    const m = await modelOrThrow(identity, brandId, offerId, coldWaitMs);
    const own = expectedForCombination(m, salesFunnelId);
    // A path the offer's sales-path model cannot price (a play, a trigger head, a declared leg, a pipe its ladder does
    // not price): the catalogue funnel's own expected figure, priced on this offer (EXPECTED-ROI-WIDE-EMAIL-1102).
    const model = own.unavailableReason === "own_sales_path_unpriced" ? await catalogueExpected(identity, brandId, m, salesFunnelId, coldWaitMs) : own;
    return withMeasuredReturn(model, measured);
  });
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
  return soft(`campaign on offer ${offerId}`, measured, async () =>
    withMeasuredReturn(expectedForCampaign(await modelOrThrow(identity, brandId, offerId), campaign.featureSlug, campaign.legKeys), measured),
  );
}

/** A brand scope (`/brands/:id/revenue`, a brand-wide feature read): every offer of the brand. */
export function expectedReturnForBrand(identity: ExpectedIdentity, brandId: string, measured: MeasuredReturnPair | null | undefined): Promise<ExpectedReturn> {
  return soft(`brand ${brandId}`, measured, async () => {
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

/** PURE: a projection pair as served, its internal return dropped. */
const servedProjectionPair = (pair: MaturityPair<ProjectionRatios>): MaturityPair<ServedProjectionRatios> => {
  const cost = (r: ProjectionRatios | null): ServedProjectionRatios | null => (r ? { costPerPaidClientUsd: r.costPerPaidClientUsd } : null);
  return { ...pair, flash: cost(pair.flash), mature: cost(pair.mature) };
};

const projectionMeasured = (pair: ProjectionPairLike | null | undefined): MeasuredReturnPair | null =>
  pair ? { isMature: pair.isMature, mature: pair.mature ? { roiMultiple: pair.mature.returnPerDollar } : null } : null;

/**
 * PURE: the SERVED audience-stats envelope: `expectedReturn` on the envelope (the scope's) and on every row (the
 * row's own mature return, else the scope's model figure), and every projection pair stripped of its internal return
 * (ROI-CONSISTENCY-1103: an audience serves a cost, its only return is its `expectedReturn`).
 */
export function withAudienceExpectedReturns(envelope: AudienceStatsEnvelope, scopeModel: ExpectedReturn) {
  const { maturity: brandPair, ...brandProjection } = envelope.brandProjection;
  return {
    ...envelope,
    brandProjection: { ...brandProjection, ...(brandPair ? { maturity: servedProjectionPair(brandPair) } : {}) },
    expectedReturn: withMeasuredReturn(scopeModel, projectionMeasured(brandPair)),
    audiences: envelope.audiences.map((row) => {
      const { maturity: pair, ...projection } = row.projection;
      return {
        ...row,
        projection: { ...projection, ...(pair ? { maturity: servedProjectionPair(pair) } : {}) },
        expectedReturn: withMeasuredReturn(scopeModel, projectionMeasured(pair)),
      };
    }),
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
