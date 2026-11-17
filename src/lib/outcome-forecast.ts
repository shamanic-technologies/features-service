/**
 * OUTCOME-FORECAST-1117, GOLD (owner 2026-11-17: « Il faut de la projection, il faut du rêve. Et de la clarté et transparence »;
 * « un graphe de réalisation médian de ces Outcomes dans le futur, avec un tunnel de percentile. Sur la base de ce qui a été
 * runné jusqu'à présent. Et en faisant une hypothèse de continuation sur la base du budget du user »). PURE.
 *
 * A campaign's milestones from Start to its Target, projected day by day: the cumulative Units of each as a median and a
 * p10-p90 tunnel, the spend ahead, the expected revenue, and when the next Target is due. HYPOTHESES + PROJECTION only:
 * every measured figure comes from Silver (`lib/outcome-silver.ts`), picked by the owner's order (campaign measured > brand
 * measured > fleet measured > the plan line > default, MEASURED-BEFORE-DEFAULT-1117) and NAMED on the response.
 *
 * METHOD (standard): a Bayesian posterior predictive simulation of a staged conversion process (Gelman et al., Bayesian Data
 * Analysis, ch. 1 and 7). Each draw takes one value of every uncertain input (the yield of each transition from its
 * Gamma-Poisson posterior, the cost per first-milestone Unit by bootstrap over the campaign's days), then counts are Poisson
 * around the expected flow: money buys first-milestone Units day by day under the budget's calendar, each transition thins
 * them by its yield and spreads them by its measured delay curve (the development-pattern method of cohort reserving,
 * chain ladder, Mack 1993: Units already produced keep maturing along the same curve). Thinning and delaying a Poisson flow
 * leaves a Poisson flow, so each milestone's count given the inputs is exact; the tunnel is the percentiles over draws.
 *
 * ONE mechanism for every campaign and outcome (guard `outcome-silver.test.ts`).
 */
import { gammaQuantile, MIN_DELAY_PAIRS, type DelayDistribution, type GammaPrior, type TransitionStat } from "./outcome-silver.js";
import { capacityUnavailableReason, expectedScheduleOf, SCHEDULE_DAYS, type SpendCapacityInput } from "./spend-capacity.js";

export type HypothesisSource = "campaign" | "brand" | "fleet" | "plan" | "default";

// ── Hypotheses: which measured figure the projection takes, and why ──

export interface ScopeEvidence {
  scope: "campaign" | "brand" | "fleet";
  fromUnits: number;
  toUnits: number;
  exposure: number;
  delayPairs: number;
}

export interface YieldHypothesis {
  source: HypothesisSource;
  /** Units of the next milestone per Unit of this one: Gamma(shape, rate). */
  shape: number;
  rate: number;
  /** A finer scope exists but its sample is thinner than the fleet prior weighs: it only nudges the estimate. */
  thinnerScopes: Array<"campaign" | "brand">;
  evidence: ScopeEvidence[];
}

export interface TransitionStats {
  campaign: TransitionStat | null;
  brand: TransitionStat | null;
  fleet: TransitionStat | null;
}

const evidenceOf = (s: TransitionStats): ScopeEvidence[] =>
  (["campaign", "brand", "fleet"] as const).flatMap((scope) => {
    const t = s[scope];
    return t ? [{ scope, fromUnits: t.fromUnits, toUnits: t.toUnits, exposure: t.exposure, delayPairs: t.delay?.n ?? 0 }] : [];
  });

/**
 * PURE. The yield a projection takes for one transition. A scope's sample is THIN while its exposure weighs less than the
 * fleet prior (`prior.rate` `from` Units): the next scope up is taken, and said. With no pair measured anywhere in the fleet:
 * the plan line's rate (weak: half a Unit), else the campaign's own counts on the weakest prior; nothing at all = null.
 */
export function chooseYield(s: TransitionStats, planRate: number | null, own: { fromUnits: number; toUnits: number }): YieldHypothesis | null {
  const evidence = evidenceOf(s);
  const prior: GammaPrior | null = s.fleet?.prior ?? s.brand?.prior ?? s.campaign?.prior ?? null;
  if (prior !== null) {
    const thick = (t: TransitionStat | null): t is TransitionStat => t !== null && t.exposure >= prior.rate;
    if (thick(s.campaign)) return { source: "campaign", shape: s.campaign.yield.shape, rate: s.campaign.yield.rate, thinnerScopes: [], evidence };
    const thinner: Array<"campaign" | "brand"> = s.campaign ? ["campaign"] : [];
    if (thick(s.brand)) return { source: "brand", shape: s.brand.yield.shape, rate: s.brand.yield.rate, thinnerScopes: thinner, evidence };
    if (s.brand) thinner.push("brand");
    // The fleet prior, moved by whatever the finest thin scope holds (still its own evidence, weighed for what it is).
    const y = (s.campaign ?? s.brand ?? s.fleet)!.yield;
    return { source: "fleet", shape: y.shape, rate: y.rate, thinnerScopes: thinner, evidence };
  }
  if (planRate !== null && planRate > 0) return { source: "plan", shape: 0.5 + own.toUnits, rate: 0.5 / planRate + own.fromUnits, thinnerScopes: [], evidence };
  if (own.fromUnits > 0) return { source: "default", shape: 0.5 + own.toUnits, rate: own.fromUnits, thinnerScopes: [], evidence };
  return null;
}

export interface DelayHypothesis {
  source: HypothesisSource;
  /** Pairs behind the curve (0 on the default). */
  pairs: number;
  /** Under MIN_DELAY_PAIRS pairs: the largest sample measured anywhere, taken over the default (a measured figure wins). */
  thinSample: boolean;
  medianHours: number;
  p10Hours: number;
  p90Hours: number;
  cdf: Array<{ hours: number; share: number }>;
}

/** With no pair measured anywhere: half the Units within this many days (the maturity window `lib/maturity.ts` has always assumed), exponential. */
export const DEFAULT_DELAY_MEDIAN_DAYS = 21;

function defaultDelay(): DelayHypothesis {
  const medianHours = DEFAULT_DELAY_MEDIAN_DAYS * 24;
  const F = (h: number) => 1 - Math.pow(2, -h / medianHours);
  const cdf: Array<{ hours: number; share: number }> = [];
  for (let d = 1; d <= 180; d += d < 14 ? 1 : 7) cdf.push({ hours: d * 24, share: F(d * 24) });
  cdf.push({ hours: 365 * 24, share: 1 });
  return { source: "default", pairs: 0, thinSample: false, medianHours, p10Hours: -Math.log2(0.9) * medianHours, p90Hours: -Math.log2(0.1) * medianHours, cdf };
}

/** PURE. The delay curve a projection takes: the finest scope with a sample that is not thin, else the largest sample measured, else the default. */
export function chooseDelay(s: TransitionStats): DelayHypothesis {
  const ladder = (["campaign", "brand", "fleet"] as const).flatMap((scope) => (s[scope]?.delay ? [[scope, s[scope]!.delay as DelayDistribution] as const] : []));
  const pick = ladder.find(([, d]) => d.n >= MIN_DELAY_PAIRS) ?? [...ladder].sort((a, b) => b[1].n - a[1].n)[0];
  if (!pick) return defaultDelay();
  const [source, d] = pick;
  return { source, pairs: d.n, thinSample: d.n < MIN_DELAY_PAIRS, medianHours: d.medianHours, p10Hours: d.p10Hours, p90Hours: d.p90Hours, cdf: d.cdf };
}

export interface EntryCostHypothesis {
  source: "campaign" | "plan";
  /** USD per Unit of the first milestone, everything the campaign spends included. */
  usdPerUnit: number;
  p10: number;
  p90: number;
  /** campaign: its spend and Units of the first milestone to date. plan: null. */
  spentUsd: number | null;
  units: number | null;
  /** plan: the basis the plan line states for its cost per Target. */
  planBasis: string | null;
  /** The values a draw picks from. */
  draws: number[];
}

/** Under this many Units of its first milestone a campaign's own cost is not measured yet: the plan line prices it. */
export const MIN_ENTRY_UNITS = 30;
const COST_RESAMPLES = 200;

/** Deterministic generator (mulberry32): the same inputs give the same stored projection. */
export function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const quantileOf = (sorted: ArrayLike<number>, q: number): number => {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
};

/**
 * PURE. What one Unit of the first milestone costs, all in. Measured on the campaign (everything it spent ÷ its Units of the
 * first milestone; the uncertainty = bootstrap over its days), else the plan line's cost per Target walked back through the
 * yields (`planCostPerEntryUsd`), else null.
 */
export function chooseEntryCost(days: ReadonlyArray<{ spendUsd: number; units: number }>, plan: { costPerEntryUsd: number | null; basis: string | null }, rng: () => number): EntryCostHypothesis | null {
  const spent = days.reduce((a, d) => a + d.spendUsd, 0);
  const units = days.reduce((a, d) => a + d.units, 0);
  if (units >= MIN_ENTRY_UNITS && spent > 0) {
    const point = spent / units;
    const draws: number[] = [];
    for (let i = 0; i < COST_RESAMPLES; i++) {
      let s = 0;
      let u = 0;
      for (let k = 0; k < days.length; k++) {
        const d = days[Math.floor(rng() * days.length)]!;
        s += d.spendUsd;
        u += d.units;
      }
      draws.push(u > 0 && s > 0 ? s / u : point);
    }
    const sorted = [...draws].sort((a, b) => a - b);
    return { source: "campaign", usdPerUnit: point, p10: quantileOf(sorted, 0.1), p90: quantileOf(sorted, 0.9), spentUsd: spent, units, planBasis: null, draws };
  }
  if (plan.costPerEntryUsd !== null && plan.costPerEntryUsd > 0) return { source: "plan", usdPerUnit: plan.costPerEntryUsd, p10: plan.costPerEntryUsd, p90: plan.costPerEntryUsd, spentUsd: null, units: null, planBasis: plan.basis, draws: [plan.costPerEntryUsd] };
  return null;
}

// ── The simulation ──

export interface ForecastMilestone {
  step: string;
  label: string;
  /** Units the campaign made to date, per UTC day. */
  unitsByDay: ReadonlyArray<{ date: string; units: number }>;
}

export interface ForecastInput {
  now: string;
  /** From the first milestone to the Target. */
  milestones: readonly ForecastMilestone[];
  /** One per transition (milestone i -> i + 1). */
  yields: ReadonlyArray<Pick<YieldHypothesis, "shape" | "rate">>;
  delays: ReadonlyArray<Pick<DelayHypothesis, "cdf">>;
  entryCostDraws: readonly number[];
  /** USD the campaign spends per segment: [what is left of today, day + 1, day + 2, ...]. */
  spendUsd: readonly number[];
  /** What one Target brings in (the offer's lifetime revenue); null = none stated. */
  targetRevenueUsd: number | null;
  /** Days served on the curves, and days searched for the next Target. */
  seriesDays: number;
  searchDays: number;
  draws: number;
  seed: number;
}

export interface Tunnel {
  /** The mean over draws (smooth), the median and the p10-p90 tunnel, one value per day of `days`. */
  expected: number[];
  median: number[];
  p10: number[];
  p90: number[];
}

export interface ForecastOutput {
  /** The UTC days after today, one per point of every series. */
  days: string[];
  outcomes: Array<{
    step: string;
    label: string;
    isTarget: boolean;
    /** Units made to date: every series starts from it (cumulative). */
    unitsToDate: number;
    cumulativeUnits: Tunnel;
    /** Units of this milestone it takes to make one Target (the yields down to it). */
    unitsPerTarget: { median: number; p10: number; p90: number } | null;
    /** The Target's revenue walked down through the yields: what one Unit here is expected to bring in (gross, a forecast). */
    expectedRevenuePerUnitUsd: { median: number; p10: number; p90: number } | null;
  }>;
  /** Cumulative spend from now (the budget hypothesis: no uncertainty of its own). */
  spendAheadUsd: number[];
  /** Cumulative revenue of the Targets made from now on; null = the Target has no revenue stated. */
  expectedRevenueUsd: Tunnel | null;
  nextTarget: {
    /** Draws that make a Target within `searchDays`. */
    shareWithinSearch: number;
    searchDays: number;
    /** The median, early (p10) and late (p90) day; null = later than `searchDays` in that case. */
    medianDate: string | null;
    earlyDate: string | null;
    lateDate: string | null;
    medianInDays: number | null;
    /**
     * The day the EXPECTED count of Targets made from now reaches one (the mean pace: what a cost per Target ÷ the budget
     * says, delays included). Earlier than the median date when the yields are poorly known: a few lucky cases pull the mean.
     */
    expectedOneByDate: string | null;
    expectedOneInDays: number | null;
  };
}

const DAY_MS = 86_400_000;
const dayAfter = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** PURE. A delay curve as a share per whole day of lag (lag 0 = the same day), until the curve ends. */
export function lagSharesOf(cdf: ReadonlyArray<{ hours: number; share: number }>): number[] {
  if (cdf.length === 0) return [1];
  const F = (hours: number): number => {
    let ph = 0;
    let ps = 0;
    for (const p of cdf) {
      if (hours <= p.hours) return ps + (p.share - ps) * ((hours - ph) / (p.hours - ph));
      ph = p.hours;
      ps = p.share;
    }
    return 1;
  };
  const lastDay = Math.ceil(cdf[cdf.length - 1]!.hours / 24);
  const out: number[] = [];
  for (let d = 0; d < lastDay; d++) out.push(F((d + 1) * 24) - F(d * 24));
  return out;
}

const convolve = (flow: Float64Array, lag: readonly number[]): Float64Array => {
  const out = new Float64Array(flow.length);
  for (let t = 0; t < flow.length; t++) {
    const f = flow[t]!;
    if (f === 0) continue;
    const end = Math.min(lag.length, flow.length - t);
    for (let l = 0; l < end; l++) out[t + l]! += f * lag[l]!;
  }
  return out;
};

function gammaDraw(shape: number, rng: () => number): number {
  if (shape < 1) return gammaDraw(shape + 1, rng) * Math.pow(Math.max(rng(), 1e-300), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normalDraw(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x || Math.log(Math.max(u, 1e-300)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
const normalDraw = (rng: () => number) => Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-300))) * Math.cos(2 * Math.PI * rng());
function poissonDraw(lambda: number, rng: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normalDraw(rng)));
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = rng();
  while (p > limit) {
    k += 1;
    p *= rng();
  }
  return k;
}

/** PURE. The projection. */
export function forecastOf(i: ForecastInput): ForecastOutput {
  const K = i.milestones.length;
  const today = i.now.slice(0, 10);
  const T = i.searchDays + 1; // segment 0 = what is left of today
  const todayShare = (Date.parse(`${dayAfter(today, 1)}T00:00:00.000Z`) - Date.parse(i.now)) / DAY_MS;
  const lags = i.delays.map((d) => lagSharesOf(d.cdf));
  const rng = rngOf(i.seed);

  // What money buys: the spend flow carried to each milestone by the delays (yields and cost applied per draw).
  const bought: Float64Array[] = [Float64Array.from({ length: T }, (_, t) => i.spendUsd[t] ?? 0)];
  for (let k = 1; k < K; k++) bought.push(convolve(bought[k - 1]!, lags[k - 1]!));
  // What already ran: the Units of milestone j still maturing into j + 1, carried further down (yields applied per draw).
  const maturing: Array<Array<Float64Array | null>> = i.milestones.map(() => i.milestones.map(() => null));
  for (let j = 0; j < K - 1; j++) {
    const lag = lags[j]!;
    const flow = new Float64Array(T);
    for (const d of i.milestones[j]!.unitsByDay) {
      const age = Math.round((Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${d.date}T00:00:00.000Z`)) / DAY_MS);
      if (age < 0 || d.units <= 0) continue;
      for (let t = 0; t < T && age + t < lag.length; t++) flow[t]! += d.units * lag[age + t]! * (t === 0 ? todayShare : 1);
    }
    maturing[j]![j + 1] = flow;
    for (let k = j + 2; k < K; k++) maturing[j]![k] = convolve(maturing[j]![k - 1]!, lags[k - 1]!);
  }

  const S = i.seriesDays;
  const cum: Float64Array[][] = i.milestones.map(() => Array.from({ length: S }, () => new Float64Array(i.draws)));
  const mean: Float64Array[] = i.milestones.map(() => new Float64Array(S));
  const perTarget: Float64Array[] = i.milestones.map(() => new Float64Array(i.draws));
  const firstTarget = new Float64Array(i.draws).fill(Infinity);
  const targetMean = new Float64Array(T);
  const toDate = i.milestones.map((m) => m.unitsByDay.reduce((a, d) => a + d.units, 0));
  const y = new Float64Array(Math.max(K - 1, 0));
  for (let r = 0; r < i.draws; r++) {
    for (let k = 0; k < K - 1; k++) y[k] = gammaDraw(i.yields[k]!.shape, rng) / i.yields[k]!.rate;
    const cost = i.entryCostDraws[Math.floor(rng() * i.entryCostDraws.length)]!;
    for (let k = 0; k < K; k++) {
      // Units of k per first-milestone Unit, and per Unit of each milestone before it.
      let fromEntry = 1;
      for (let a = 0; a < k; a++) fromEntry *= y[a]!;
      const from: number[] = [];
      for (let j = 0; j < k; j++) {
        let p = 1;
        for (let a = j; a < k; a++) p *= y[a]!;
        from.push(p);
      }
      let down = 1;
      for (let a = k; a < K - 1; a++) down *= y[a]!;
      perTarget[k]![r] = down;
      const isTarget = k === K - 1;
      const reach = isTarget ? T : Math.min(T, S + 1);
      let made = 0;
      let expectedMade = 0;
      for (let t = 0; t < reach; t++) {
        let lambda = (fromEntry / cost) * bought[k]![t]!;
        for (let j = 0; j < k; j++) lambda += from[j]! * maturing[j]![k]![t]!;
        expectedMade += lambda;
        made += poissonDraw(lambda, rng);
        // Day t (t >= 1) closes segment t; today's remainder is in the first point.
        if (t >= 1 && t <= S) {
          cum[k]![t - 1]![r] = toDate[k]! + made;
          mean[k]![t - 1]! += (toDate[k]! + expectedMade) / i.draws;
        }
        if (isTarget) targetMean[t]! += expectedMade / i.draws;
        if (isTarget && made >= 1 && firstTarget[r] === Infinity) firstTarget[r] = t;
      }
    }
  }

  const tunnelOf = (series: Float64Array[], expected: Float64Array, scale = 1, minus = 0): Tunnel => {
    const out: Tunnel = { expected: [], median: [], p10: [], p90: [] };
    const round = (v: number) => Math.round(v * 100) / 100;
    series.forEach((draws, t) => {
      const sorted = Float64Array.from(draws).sort();
      out.expected.push(round((expected[t]! - minus) * scale));
      out.median.push(round((quantileOf(sorted, 0.5) - minus) * scale));
      out.p10.push(round((quantileOf(sorted, 0.1) - minus) * scale));
      out.p90.push(round((quantileOf(sorted, 0.9) - minus) * scale));
    });
    return out;
  };
  const band = (draws: Float64Array, f: (v: number) => number) => {
    const sorted = Float64Array.from(draws, f).sort();
    const sig = (v: number) => Number(v.toPrecision(6));
    return { median: sig(quantileOf(sorted, 0.5)), p10: sig(quantileOf(sorted, 0.1)), p90: sig(quantileOf(sorted, 0.9)) };
  };
  const days = Array.from({ length: S }, (_, t) => dayAfter(today, t + 1));
  let spent = i.spendUsd[0] ?? 0;
  const spendAheadUsd = days.map((_, t) => Math.round((spent += i.spendUsd[t + 1] ?? 0) * 100) / 100);
  const revenue = i.targetRevenueUsd;
  const sortedFirst = Float64Array.from(firstTarget).sort();
  const dayAt = (q: number): number | null => {
    const v = sortedFirst[Math.min(sortedFirst.length - 1, Math.floor((sortedFirst.length - 1) * q))]!;
    return Number.isFinite(v) ? v : null;
  };
  const dateOf = (t: number | null) => (t === null ? null : dayAfter(today, t));
  const oneAt = targetMean.findIndex((v) => v >= 1);
  const expectedOneInDays = oneAt < 0 ? null : oneAt;
  return {
    days,
    outcomes: i.milestones.map((m, k) => ({
      step: m.step,
      label: m.label,
      isTarget: k === K - 1,
      unitsToDate: toDate[k]!,
      cumulativeUnits: tunnelOf(cum[k]!, mean[k]!),
      unitsPerTarget: k === K - 1 ? null : band(perTarget[k]!, (v) => 1 / Math.max(v, 1e-12)),
      expectedRevenuePerUnitUsd: revenue === null ? null : band(perTarget[k]!, (v) => v * revenue),
    })),
    spendAheadUsd,
    expectedRevenueUsd: revenue === null ? null : tunnelOf(cum[K - 1]!, mean[K - 1]!, revenue, toDate[K - 1]!),
    nextTarget: {
      shareWithinSearch: firstTarget.reduce((a, v) => a + (Number.isFinite(v) ? 1 : 0), 0) / i.draws,
      searchDays: i.searchDays,
      medianDate: dateOf(dayAt(0.5)),
      earlyDate: dateOf(dayAt(0.1)),
      lateDate: dateOf(dayAt(0.9)),
      medianInDays: dayAt(0.5),
      expectedOneByDate: dateOf(expectedOneInDays),
      expectedOneInDays,
    },
  };
}

// ── One campaign's served forecast: hypotheses named, baseline + alternative budgets ──


/** Days served on every curve (18 months) and days searched for the next Target (the spend schedule's reach, 3 years). */
export const FORECAST_SERIES_DAYS = 548;
export const FORECAST_SEARCH_DAYS = SCHEDULE_DAYS;
export const FORECAST_DRAWS = 1000;
/** The alternative budgets served beside the campaign's own (× its budget). */
export const BUDGET_MULTIPLIERS: readonly number[] = [2, 5, 10];
const DAYS_PER_MONTH = 365 / 12;

export interface CampaignForecastInput {
  now: string;
  salesFunnelCampaignId: string;
  /** From the first milestone to the Target (the campaign page's own milestones, same counts). */
  milestones: ReadonlyArray<{ step: string; label: string; ledgerKeys: readonly string[]; unitsByDay: ReadonlyArray<{ date: string; units: number }>; neededPerTarget: number | null }>;
  hasTarget: boolean;
  spendByDay: ReadonlyArray<{ date: string; spendUsd: number }>;
  capacity: SpendCapacityInput;
  spendPerDayUsd: number | null;
  spendPerDaySource: "daily_budget" | "spend_pace_7d" | null;
  plan: { costPerTargetUsd: number | null; basis: string | null };
  targetValueUsd: number | null;
  /** Silver: the stored transition of a scope, null = none. */
  transition: (scope: "campaign" | "brand" | "fleet", fromKey: string, toKey: string) => TransitionStat | null;
  silverComputedAt: string | null;
}

const band = (shape: number, rate: number) => ({ mean: shape / rate, median: gammaQuantile(0.5, shape, rate), p10: gammaQuantile(0.1, shape, rate), p90: gammaQuantile(0.9, shape, rate) });
const seedOf = (s: string) => {
  let h = 2166136261;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619);
  return h >>> 0;
};
const monthlyOf = (c: SpendCapacityInput, spendPerDayUsd: number | null): number | null => {
  const b = c.budget;
  if (b === null || b.period === "one_off") return spendPerDayUsd === null ? null : spendPerDayUsd * DAYS_PER_MONTH;
  return b.period === "monthly" ? b.amountUsd : b.period === "weekly" ? (b.amountUsd / 7) * DAYS_PER_MONTH : b.amountUsd * DAYS_PER_MONTH;
};

/** PURE. The capacity and pace of the campaign had its budget been `m` times what it is, from now. */
export function scaledCapacity(c: SpendCapacityInput, m: number): SpendCapacityInput {
  if (c.budget === null || m === 1) return c;
  const b = c.budget;
  const remainingUsd = b.remainingUsd === null ? null : b.remainingUsd + (m - 1) * b.amountUsd;
  return { ...c, budget: { ...b, amountUsd: b.amountUsd * m, remainingUsd, reached: remainingUsd === null ? b.reached : remainingUsd <= 0 } };
}

export type CampaignForecastBody = ReturnType<typeof campaignForecastOf>;

/** PURE. The served forecast of one campaign. Never blank: what cannot be projected is null with its reason. */
export function campaignForecastOf(i: CampaignForecastInput) {
  const round = (v: number, d = 6) => (Number.isFinite(v) ? Number(v.toPrecision(d)) : null);
  const K = i.milestones.length;
  const capacityReason = capacityUnavailableReason(i.capacity);
  const spendReason = capacityReason ?? (i.spendPerDayUsd === null || i.spendPerDayUsd <= 0 ? "no_daily_budget_and_no_recent_spend" : null);
  const baseSchedule = spendReason === null ? expectedScheduleOf(i.spendPerDayUsd!, i.spendPerDayUsd!, i.capacity, i.now) : null;
  const budget = {
    source: spendReason !== null ? null : i.capacity.budget !== null ? ("budget_cap" as const) : i.spendPerDaySource,
    hypothesis: "the_stated_budget_continues" as const,
    monthlyUsd: spendReason !== null ? null : round(monthlyOf(i.capacity, i.spendPerDayUsd) ?? NaN, 6),
    capPeriod: i.capacity.budget?.period ?? null,
    capAmountUsd: i.capacity.budget?.amountUsd ?? null,
    capRemainingUsd: i.capacity.budget?.remainingUsd ?? null,
    capPeriodEnd: i.capacity.budget?.periodEnd ?? null,
    spendPerDayWhileSpendingUsd: i.spendPerDayUsd,
    pausedReason: baseSchedule?.pausedReason ?? null,
    resumesAt: baseSchedule?.resumesAt ?? null,
    /** Why nothing more is spent (the projection then only matures what already ran). */
    unavailableReason: spendReason,
  };
  const empty = (unavailableReason: string) => ({
    salesFunnelCampaignId: i.salesFunnelCampaignId,
    computedAt: i.now,
    silverComputedAt: i.silverComputedAt,
    method: null,
    unavailableReason,
    hypotheses: { budget, entryCost: null, transitions: [], targetValue: null },
    forecast: null,
    alternatives: [],
  });
  if (!i.hasTarget) return empty("campaign_states_no_target");
  if (K === 0) return empty("no_unit_reaches_a_step");

  // Each transition's keys: the pair of ledger outcomes the fleet measured most between the two milestones.
  const picks = i.milestones.slice(0, -1).map((m, k) => {
    const next = i.milestones[k + 1]!;
    const pairs = m.ledgerKeys.flatMap((a) => next.ledgerKeys.map((b) => ({ a, b, n: i.transition("fleet", a, b)?.fromUnits ?? -1 })));
    const best = [...pairs].sort((x, y) => y.n - x.n)[0] ?? null;
    const stats: TransitionStats = best === null ? { campaign: null, brand: null, fleet: null } : { campaign: i.transition("campaign", best.a, best.b), brand: i.transition("brand", best.a, best.b), fleet: i.transition("fleet", best.a, best.b) };
    const own = { fromUnits: m.unitsByDay.reduce((s, d) => s + d.units, 0), toUnits: next.unitsByDay.reduce((s, d) => s + d.units, 0) };
    const planRate = m.neededPerTarget !== null && next.neededPerTarget !== null && m.neededPerTarget > 0 ? next.neededPerTarget / m.neededPerTarget : null;
    return { from: m, to: next, keys: best, yield: chooseYield(stats, planRate, own), delay: chooseDelay(stats) };
  });
  const missing = picks.find((p) => p.yield === null);
  if (missing) return empty(`yield_unmeasured:${missing.from.step}->${missing.to.step}`);

  const rng = rngOf(seedOf(i.salesFunnelCampaignId));
  const entry = i.milestones[0]!;
  const spendOn = new Map(i.spendByDay.map((d) => [d.date, d.spendUsd]));
  const unitsOn = new Map(entry.unitsByDay.map((d) => [d.date, d.units]));
  const costDays = [...new Set([...spendOn.keys(), ...unitsOn.keys()])].sort().map((date) => ({ spendUsd: spendOn.get(date) ?? 0, units: unitsOn.get(date) ?? 0 }));
  const entryPerTarget = picks.reduce((a, p) => a * (p.yield!.shape / p.yield!.rate), 1);
  const entryCost = chooseEntryCost(costDays, { costPerEntryUsd: i.plan.costPerTargetUsd !== null ? i.plan.costPerTargetUsd * entryPerTarget : null, basis: i.plan.basis }, rng);
  if (entryCost === null) return empty("cost_unmeasured_and_plan_prices_no_target");

  const run = (m: number) => {
    const schedule = spendReason === null ? expectedScheduleOf(i.spendPerDayUsd! * m, i.spendPerDayUsd! * m, scaledCapacity(i.capacity, m), i.now) : null;
    return forecastOf({
      now: i.now,
      milestones: i.milestones,
      yields: picks.map((p) => p.yield!),
      delays: picks.map((p) => p.delay),
      entryCostDraws: entryCost.draws,
      spendUsd: schedule?.outcomes ?? [],
      targetRevenueUsd: i.targetValueUsd,
      seriesDays: FORECAST_SERIES_DAYS,
      searchDays: FORECAST_SEARCH_DAYS,
      draws: FORECAST_DRAWS,
      seed: seedOf(i.salesFunnelCampaignId),
    });
  };
  const forecast = run(1);
  const alternatives =
    spendReason !== null || budget.monthlyUsd === null
      ? []
      : BUDGET_MULTIPLIERS.map((m) => {
          const f = run(m);
          const target = f.outcomes[f.outcomes.length - 1]!;
          return { budgetMultiplier: m, monthlyBudgetUsd: round(budget.monthlyUsd! * m, 6), nextTarget: f.nextTarget, targetCumulativeUnits: target.cumulativeUnits, expectedRevenueUsd: f.expectedRevenueUsd, spendAheadUsd: f.spendAheadUsd };
        });
  return {
    salesFunnelCampaignId: i.salesFunnelCampaignId,
    computedAt: i.now,
    silverComputedAt: i.silverComputedAt,
    method: { name: "posterior_predictive_simulation" as const, draws: FORECAST_DRAWS, seriesDays: FORECAST_SERIES_DAYS, searchDays: FORECAST_SEARCH_DAYS },
    unavailableReason: null as string | null,
    hypotheses: {
      budget,
      entryCost: { step: entry.step, label: entry.label, source: entryCost.source, usdPerUnit: round(entryCost.usdPerUnit), p10: round(entryCost.p10), p90: round(entryCost.p90), spentUsd: entryCost.spentUsd, units: entryCost.units, planBasis: entryCost.planBasis },
      transitions: picks.map((p) => {
        const b = band(p.yield!.shape, p.yield!.rate);
        return {
          fromStep: p.from.step,
          toStep: p.to.step,
          fromOutcomeKey: p.keys?.a ?? null,
          toOutcomeKey: p.keys?.b ?? null,
          yield: { source: p.yield!.source, unitsPerUnit: round(b.mean), median: round(b.median), p10: round(b.p10), p90: round(b.p90), thinnerScopes: p.yield!.thinnerScopes, evidence: p.yield!.evidence },
          delay: { source: p.delay.source, pairs: p.delay.pairs, thinSample: p.delay.thinSample, medianHours: round(p.delay.medianHours), p10Hours: round(p.delay.p10Hours), p90Hours: round(p.delay.p90Hours) },
        };
      }),
      targetValue: i.targetValueUsd === null ? null : { usd: i.targetValueUsd, source: "plan_target_value" as const },
    },
    forecast: forecast as ForecastOutput | null,
    alternatives,
  };
}
