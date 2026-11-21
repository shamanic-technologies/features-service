/**
 * ONE-CAMPAIGN-VOLUME-1122, GOLD (owner 2026-11-22: « Ils veulent juste un volume d'outcome par jour / week ou mois, avec
 * le budget range associé sur un intervalle 20-80% »; « Et quid du fait que les meetings mettent plus d'une week à se
 * booker? … Il y a une question de temporalité non? »). PURE.
 *
 * BEFORE a campaign exists: what one Unit of its Target costs from Start (everything the campaign spends to make one:
 * finding people, writing, answering, ... down to the Target), as a 20th-80th percentile interval, and how long after the
 * launch the Target's Units start landing. Same hypotheses as a running campaign's forecast (`lib/outcome-forecast.ts`),
 * with no campaign level: per transition the yield and the delay blended brand measured > fleet measured > the plan line
 * (the offer's catalogue rates: brand measured > stated > fleet measured > default) > default; the cost of one
 * first-milestone Unit ALL IN (the brand's sales funnel campaigns, else the fleet's, else the plan line's own).
 *
 * METHOD: posterior predictive draws of the cost of one Target Unit = (all-in cost of one first-milestone Unit) ÷
 * Π (yield of each transition), each yield drawn from its Gamma (mean = the blended rate, shape = the cases it is known
 * by: few cases = a wide interval). The interval is the 20th and 80th percentiles of those draws: a cost we expect, never
 * a promise. The ramp: a campaign spending the same every day from launch makes its first-milestone Units at once; the
 * Target's Units follow along the transitions' delays added (their daily lag shares convolved), so the share of the
 * steady pace reached on day d is the cumulative delay distribution at d.
 *
 * ONE mechanism for every Target (guard `outcome-silver.test.ts`): no outcome, channel or Engine named here.
 */
import type { ExpectedBasis } from "./expected-return.js";
import type { DelayDistribution, EntryCostStat, TransitionStat } from "./outcome-silver.js";
import { chooseDelay, chooseYield, gammaDraw, lagSharesOf, quantileOf, rngOf, seedOf, type HypothesisSource } from "./outcome-forecast.js";

/** Bump when a rule here changes what a stored estimate means (in the cell key). */
export const VOLUME_ESTIMATE_RULE = "2026-11-22.1";
export const VOLUME_ESTIMATE_DRAWS = 4000;
/** The interval served: owner 2026-11-22, « un intervalle 20-80% ». */
export const LOW_QUANTILE = 0.2;
export const HIGH_QUANTILE = 0.8;
/** Weeks the ramp is served over (half a year). */
export const RAMP_WEEKS = 26;
/** The weekly pace counts as steady from the week it reaches this share of the wanted volume. */
export const STEADY_SHARE = 0.8;
/** Other campaigns' all-in cost of a first-milestone Unit stands from this many Units of theirs (`MIN_ENTRY_COST_UNITS`). */
export const MIN_ENTRY_UNITS = 30;

export type VolumePeriod = "day" | "week" | "month";
export const VOLUME_PERIODS: readonly VolumePeriod[] = ["day", "week", "month"];
export const DAYS_PER_PERIOD: Record<VolumePeriod, number> = { day: 1, week: 7, month: 365 / 12 };

export interface EstimateMilestone {
  step: string;
  label: string;
  ledgerKeys: readonly string[];
}

/** The plan line of one transition (the offer's catalogue rate between two milestones). */
export interface PlanRate {
  ratePct: number | null;
  basis: ExpectedBasis | null;
}

export interface VolumeEstimateInput {
  /** Seeds the draws: the same inputs answer the same interval. */
  seed: string;
  /** From the first milestone to the Target. */
  milestones: readonly EstimateMilestone[];
  /** One per transition (milestone i -> i + 1). */
  planRates: readonly PlanRate[];
  /** The plan line's cost of ONE Target from Start (catalogue legs: cost per outcome × outcomes needed), and its basis. */
  planCostPerTargetUsd: number | null;
  planCostBasis: ExpectedBasis | null;
  /** Silver: a stored transition of the brand or the fleet; null = none. */
  transition: (scope: "brand" | "fleet", fromKey: string, toKey: string) => TransitionStat | null;
  /** Silver: what sales funnel campaigns with this first milestone spent all in per Unit of it; null = none. */
  entryCost: (scope: "brand" | "fleet", outcomeKey: string) => EntryCostStat | null;
  silverComputedAt: string | null;
}

/** What a hypothesis rests on, in the words the expected figures already use (`measured` = this brand's own). */
const basisOfSource = (source: HypothesisSource, plan: ExpectedBasis | null): ExpectedBasis => (source === "brand" ? "measured" : source === "fleet" ? "fleet" : source === "plan" ? plan ?? "default" : "default");
const RANK: Record<ExpectedBasis, number> = { measured: 0, stated: 1, fleet: 2, default: 3 };
const weakestOf = (bases: readonly ExpectedBasis[]): ExpectedBasis => bases.reduce((w, b) => (RANK[b] > RANK[w] ? b : w), "measured" as ExpectedBasis);
const sig = (v: number) => Number(v.toPrecision(6));

export interface PerUnitCost {
  /** USD one Unit of the Target costs from Start: the 20th and 80th percentiles (multiply by a volume for its budget range). */
  lowUsd: number;
  highUsd: number;
  medianUsd: number;
}

export type VolumeEstimateModel = ReturnType<typeof volumeEstimateModelOf>;

/** PURE. The per-Unit interval and the ramp, independent of the volume. Never blank: null + reason. */
export function volumeEstimateModelOf(i: VolumeEstimateInput) {
  const K = i.milestones.length;
  const empty = (unavailableReason: string) => ({ rule: VOLUME_ESTIMATE_RULE, silverComputedAt: i.silverComputedAt, unavailableReason, perUnit: null as PerUnitCost | null, basis: null as ExpectedBasis | null, isExpected: true, hypotheses: null, rampShareByWeek: null as number[] | null });
  if (K === 0) return empty("no_milestone_reaches_the_target");
  const picks = i.milestones.slice(0, -1).map((m, k) => {
    const next = i.milestones[k + 1]!;
    // The pair of ledger outcomes the fleet measured most between the two milestones (the forecast's rule).
    const pairs = m.ledgerKeys.flatMap((a) => next.ledgerKeys.map((b) => ({ a, b, n: i.transition("fleet", a, b)?.fromUnits ?? -1 })));
    const best = [...pairs].sort((x, y) => y.n - x.n)[0] ?? null;
    const stats = best === null ? { campaign: null, brand: null, fleet: null } : { campaign: null, brand: i.transition("brand", best.a, best.b), fleet: i.transition("fleet", best.a, best.b) };
    const plan = i.planRates[k] ?? { ratePct: null, basis: null };
    const planRate = plan.ratePct !== null && plan.ratePct > 0 ? plan.ratePct / 100 : null;
    return { from: m, to: next, keys: best, plan, yield: chooseYield(stats, planRate, { fromUnits: 0, toUnits: 0 }), delay: chooseDelay(stats, null as DelayDistribution | null) };
  });
  const missing = picks.find((p) => p.yield === null);
  if (missing) return empty(`yield_unknown:${missing.from.step}->${missing.to.step}`);

  // The all-in cost of one first-milestone Unit: the brand's sales funnel campaigns, else the fleet's, else the plan line's own.
  const entry = i.milestones[0]!;
  const entryKey = entry.ledgerKeys.map((k) => ({ k, n: i.entryCost("fleet", k)?.units ?? -1 })).sort((x, y) => y.n - x.n)[0]?.k ?? null;
  const levelOf = (scope: "brand" | "fleet"): { skip: string } | { usdPerUnit: number; units: number; campaigns: number } => {
    const pool = entryKey === null ? null : i.entryCost(scope, entryKey);
    if (pool === null) return { skip: "no_sales_funnel_campaign_with_this_first_milestone" };
    if (pool.units < MIN_ENTRY_UNITS) return { skip: "under_30_units" };
    if (!(pool.spendUsd > 0)) return { skip: "no_spend_measured" };
    return { usdPerUnit: pool.spendUsd / pool.units, units: pool.units, campaigns: pool.campaigns };
  };
  const planNeededAtEntry = picks.reduce((n, p) => n / (p.yield!.shape / p.yield!.rate), 1);
  // The plan line's own cost of a first-milestone Unit: its cost per Target ÷ the first-milestone Units one Target takes on it.
  const planEntryUsd = (() => {
    if (i.planCostPerTargetUsd === null || !(i.planCostPerTargetUsd > 0)) return null;
    const planNeeded = i.planRates.reduce<number | null>((n, r) => (n === null || r.ratePct === null || !(r.ratePct > 0) ? null : n / (r.ratePct / 100)), 1);
    return planNeeded === null ? null : i.planCostPerTargetUsd / planNeeded;
  })();
  const brand = levelOf("brand");
  const fleet = levelOf("fleet");
  const entryCost =
    "usdPerUnit" in brand
      ? { source: "brand" as const, usdPerUnit: brand.usdPerUnit, units: brand.units, campaigns: brand.campaigns, basis: "measured" as ExpectedBasis }
      : "usdPerUnit" in fleet
        ? { source: "fleet" as const, usdPerUnit: fleet.usdPerUnit, units: fleet.units, campaigns: fleet.campaigns, basis: "fleet" as ExpectedBasis }
        : planEntryUsd !== null
          ? { source: "plan" as const, usdPerUnit: planEntryUsd, units: null, campaigns: null, basis: i.planCostBasis ?? ("default" as ExpectedBasis) }
          : null;
  if (entryCost === null) return empty("cost_unknown_and_plan_prices_no_target");

  // Draws: cost of one Target Unit = entry cost ÷ Π yields drawn.
  const rng = rngOf(seedOf(i.seed));
  const draws = new Float64Array(VOLUME_ESTIMATE_DRAWS);
  for (let r = 0; r < draws.length; r++) {
    let through = 1;
    for (const p of picks) through *= gammaDraw(p.yield!.shape, rng) / p.yield!.rate;
    draws[r] = entryCost.usdPerUnit / Math.max(through, 1e-12);
  }
  draws.sort();
  const perUnit: PerUnitCost = { lowUsd: sig(quantileOf(draws, LOW_QUANTILE)), highUsd: sig(quantileOf(draws, HIGH_QUANTILE)), medianUsd: sig(quantileOf(draws, 0.5)) };

  // The ramp: the Target's share of the steady pace on each day after launch = the cumulative delay of the whole chain.
  let lag: number[] = [1];
  for (const p of picks) {
    const step = lagSharesOf(p.delay.cdf);
    const out = new Array<number>(lag.length + step.length - 1).fill(0);
    for (let a = 0; a < lag.length; a++) if (lag[a]! !== 0) for (let b = 0; b < step.length; b++) out[a + b]! += lag[a]! * step[b]!;
    lag = out;
  }
  const daily: number[] = [];
  let cum = 0;
  for (let d = 0; d < RAMP_WEEKS * 7; d++) daily.push((cum += lag[d] ?? 0));
  const rampShareByWeek = Array.from({ length: RAMP_WEEKS }, (_, w) => sig(daily.slice(w * 7, w * 7 + 7).reduce((a, v) => a + v, 0) / 7));

  const transitions = picks.map((p) => {
    const mean = p.yield!.shape / p.yield!.rate;
    return {
      fromStep: p.from.step,
      toStep: p.to.step,
      fromOutcomeKey: p.keys?.a ?? null,
      toOutcomeKey: p.keys?.b ?? null,
      yield: { source: p.yield!.source, basis: basisOfSource(p.yield!.source, p.plan.basis), unitsPerUnit: sig(mean), effectiveCases: sig(p.yield!.effectiveCases), planRatePct: p.plan.ratePct, planBasis: p.plan.basis, evidence: p.yield!.evidence },
      delay: { source: p.delay.source, pairs: p.delay.pairs, thinSample: p.delay.thinSample, medianHours: sig(p.delay.medianHours), p10Hours: sig(p.delay.p10Hours), p90Hours: sig(p.delay.p90Hours) },
    };
  });
  const basis = weakestOf([entryCost.basis, ...transitions.map((t) => t.yield.basis)]);
  return {
    rule: VOLUME_ESTIMATE_RULE,
    silverComputedAt: i.silverComputedAt,
    unavailableReason: null as string | null,
    perUnit: perUnit as PerUnitCost | null,
    basis: basis as ExpectedBasis | null,
    /** True unless every hypothesis is this brand's own measurement: the interval is then an EXPECTED cost. */
    isExpected: basis !== "measured",
    hypotheses: {
      milestones: i.milestones.map((m) => ({ step: m.step, label: m.label })),
      entryCost: { step: entry.step, outcomeKey: entryKey, source: entryCost.source, basis: entryCost.basis, usdPerUnit: sig(entryCost.usdPerUnit), units: entryCost.units, campaigns: entryCost.campaigns, brandSkippedReason: "skip" in brand ? brand.skip : null, fleetSkippedReason: "skip" in fleet ? fleet.skip : null },
      transitions,
      plan: { costPerTargetUsd: i.planCostPerTargetUsd, basis: i.planCostBasis },
      firstMilestoneUnitsPerTarget: sig(planNeededAtEntry),
    },
    rampShareByWeek: rampShareByWeek as number[] | null,
  };
}

/** PURE. The budget range and the timing for one wanted volume of Target Units per period. */
export function volumeEstimateOf(model: Pick<VolumeEstimateModel, "perUnit" | "rampShareByWeek" | "unavailableReason">, volume: number, period: VolumePeriod) {
  const weekly = (volume * 7) / DAYS_PER_PERIOD[period];
  const budget =
    model.perUnit === null
      ? { period, lowUsd: null, highUsd: null, maxUsd: null, unavailableReason: model.unavailableReason }
      : {
          period,
          lowUsd: Math.floor(volume * model.perUnit.lowUsd),
          highUsd: Math.ceil(volume * model.perUnit.highUsd),
          /** The campaign's own max budget per period: the top of the range (owner decision 2026-11-22). */
          maxUsd: Math.ceil(volume * model.perUnit.highUsd),
          unavailableReason: null as string | null,
        };
  if (model.rampShareByWeek === null) return { volume, period, budget, timing: { firstUnitsWeek: null, steadyFromWeek: null, steadyPerPeriod: volume, weeks: [], unavailableReason: model.unavailableReason } };
  const weeks = model.rampShareByWeek.map((share, w) => ({ week: w + 1, expectedUnits: sig(weekly * share) }));
  let cum = 0;
  const first = weeks.find((w) => (cum += w.expectedUnits) >= 1) ?? null;
  const steady = model.rampShareByWeek.findIndex((s) => s >= STEADY_SHARE);
  return {
    volume,
    period,
    budget,
    timing: {
      /** The week after launch by which the first Unit is expected (cumulative expected ≥ 1); null = later than the weeks served. */
      firstUnitsWeek: first?.week ?? null,
      /** The week the weekly pace reaches 80% of the wanted volume; null = later than the weeks served. */
      steadyFromWeek: steady < 0 ? null : steady + 1,
      steadyPerPeriod: volume,
      weeks,
      unavailableReason: first === null ? "first_units_later_than_26_weeks" : null,
    },
  };
}
