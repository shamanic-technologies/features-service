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
import { delayCdfAt, gammaQuantile, MIN_DELAY_PAIRS, type DelayDistribution, type EntryCostStat, type TransitionStat } from "./outcome-silver.js";
import { capacityUnavailableReason, expectedScheduleOf, SCHEDULE_DAYS, type SpendCapacityInput } from "./spend-capacity.js";

export type HypothesisSource = "campaign" | "brand" | "fleet" | "plan" | "default";

// ── Hypotheses: which measured figure the projection takes, and why ──

export interface ScopeEvidence {
  scope: "campaign" | "brand" | "fleet";
  fromUnits: number;
  /** Units of the next milestone COUNTED in the scope (the yield's count), whether or not a stored link ties them. */
  toUnits: number;
  /** Of them, those a stored link ties to a Unit of this milestone, and the share: a thin coverage is visible here. */
  linkedToUnits: number;
  linkCoverage: number | null;
  exposure: number;
  delayPairs: number;
}

/**
 * THIN-SAMPLE-BLEND-1118 (owner 2026-11-18). A measured figure resting on few cases is BLENDED with its fallback, in
 * proportion to its cases: the order stays measured before default (campaign > brand > fleet > plan line), and each
 * level is shrunk toward the level below it by its own sample size. Method: conjugate Bayesian updating (Gamma-Poisson
 * for a rate), the level below being the prior, restated at a FIXED strength of `BLEND_PSEUDO_CASES` cases: the weight
 * of a level's own measurement is cases-it-could-expect ÷ (those + 10). So 3 cases against 10 barely move the fallback,
 * 10 weigh half, 100 weigh 91%, thousands read as themselves. Ten = the sample this file already called thin under
 * (`MIN_DELAY_PAIRS`). One rule for every transition, scope and Engine.
 */
export const BLEND_PSEUDO_CASES = 10;
/** Bump when a rule here changes what a stored forecast means: it is in the forecast cell's key (Silver is not re-swept for it). */
export const FORECAST_RULE = "2026-11-18.6-entry-cost-all-in";
/**
 * FORECAST-TUNNEL-1118. How SURE a rate is, apart from where its mean sits. The mean is blended with a fallback worth
 * `BLEND_PSEUDO_CASES`; the SPREAD each draw samples from must not treat that fallback as 10 observed cases when it is a
 * guess. A rate's effective cases = the cases actually observed along its ladder, a fallback counting for what it was
 * itself worth, at most 10. A PLAN LINE (a human's stated rate, not a measurement) is worth HALF a case: the weakest
 * proper prior on a rate (Jeffreys' prior for a Poisson rate is Gamma(1/2)), the figure this file always gave a rate
 * nothing measured. So a step resting on the plan line alone is drawn from a very wide range, 1,000 cases from a tight one.
 */
export const PLAN_LINE_SPREAD_CASES = 0.5;
/** Other campaigns' all-in cost of a first-milestone Unit stands as a fallback from this many Units of theirs; under it the level is skipped. */
export const MIN_ENTRY_COST_UNITS = 30;
/** The two bases a cost per first-milestone Unit is stated on: every measured level is ALL IN, like the campaign's own. */
export const ENTRY_COST_BASIS = { allIn: "all_in_spend_per_first_milestone_unit", plan: "plan_cost_per_target_over_units_needed" } as const;

/** One level of the ladder the first milestone's cost rests on. */
export interface EntryCostLevel {
  level: EntryCostSource;
  basis: (typeof ENTRY_COST_BASIS)[keyof typeof ENTRY_COST_BASIS];
  /** The level's own cost per Unit; null = it states none (`skippedReason`). */
  usdPerUnit: number | null;
  /** The Units (and campaigns) it is measured on; null on the plan line. */
  units: number | null;
  campaigns: number | null;
  /** Its share in the cost used. */
  weight: number;
  /** Why it weighs nothing: it could not be measured on the same basis, or a finer level was taken. */
  skippedReason: string | null;
}

/** One level of the ladder a figure rests on, from the fallback up to the campaign. */
export interface BlendLevel {
  level: HypothesisSource;
  /** What this level adds that the finer levels do not hold: its cases and the exposure they were counted over (null on the plan line). */
  cases: number | null;
  exposure: number | null;
  /** The level's own raw rate (cases ÷ exposure; the plan line's stated rate); null without exposure. */
  measuredRate: number | null;
  /** The blended rate of the level below: what this level falls back on. null = nothing below. */
  fallbackRate: number | null;
  /** Share of this level's own measurement in ITS blended rate (0 = the fallback alone, 1 = itself alone). */
  weight: number;
  /** The rate after blending at this level; the last level's is the rate the projection uses. */
  blendedRate: number;
  /** Share of this level's measurement in the rate finally used (the levels' shares sum to 1). */
  share: number;
  /** The effective cases the rate is KNOWN by after this level (its spread): the fallback's own, at most 10, plus this level's cases. */
  spreadCases: number;
}

export interface YieldHypothesis {
  /** The level weighing most in the rate used. */
  source: HypothesisSource;
  /**
   * Units of the next milestone per Unit of this one: Gamma(shape, rate), what each draw samples. Its MEAN is the blended
   * rate used; its SHAPE is `effectiveCases` (the spread: FORECAST-TUNNEL-1118).
   */
  shape: number;
  rate: number;
  /** The cases the rate is known by: few = a wide range of draws, thousands = a tight one. */
  effectiveCases: number;
  /** Finer scopes that hold evidence but weigh less than `source`. */
  thinnerScopes: Array<"campaign" | "brand">;
  evidence: ScopeEvidence[];
  /** The ladder, fallback first: each level's raw rate with its cases, what it fell back on, its weight and the result. */
  blend: BlendLevel[];
  /**
   * Where the campaign level's cases come from: `silver` = the stored sweep; `live_counts` = the campaign page's own counts
   * (Silver holds no row for this campaign on this transition yet: FORECAST-FRESH-EVIDENCE-1118); `own_counts` = the same
   * counts uncensored (nothing measured anywhere); null = the campaign holds no evidence.
   */
  campaignEvidence: "silver" | "live_counts" | "own_counts" | null;
}

export interface TransitionStats {
  campaign: TransitionStat | null;
  brand: TransitionStat | null;
  fleet: TransitionStat | null;
}

const evidenceOf = (s: TransitionStats): ScopeEvidence[] =>
  (["campaign", "brand", "fleet"] as const).flatMap((scope) => {
    const t = s[scope];
    return t ? [{ scope, fromUnits: t.fromUnits, toUnits: t.toUnits, linkedToUnits: t.linkedToUnits, linkCoverage: t.linkCoverage, exposure: t.exposure, delayPairs: t.delay?.n ?? 0 }] : [];
  });

const sharesAfter = <T extends { share: number }>(levels: T[], weight: number): void => {
  for (const l of levels) l.share *= 1 - weight;
};
const heaviest = <T extends { share: number; level: HypothesisSource }>(levels: readonly T[]): T => levels.reduce((a, l) => (l.share >= a.share ? l : a));

/**
 * PURE. The yield a projection takes for one transition: the plan line's rate, then what the fleet, the brand and the
 * campaign measured, each BLENDED into the level below by its own cases (`BLEND_PSEUDO_CASES`). A level counts what the
 * finer ones do not already hold (the fleet without the brand, the brand without the campaign): no case weighs twice.
 * With no plan rate the coarsest measured level stands alone (half a case added: never a zero rate). Nothing at all = null.
 *
 * FORECAST-FRESH-EVIDENCE-1118: `live` = the campaign's cases as its page counts them NOW (`to` Units over the exposure of
 * its `from` Units, censored as the sweep does). The campaign level takes them when Silver holds no row for it (a campaign
 * younger than the last daily sweep read the fleet's rate alone: 2.25 messages per lead where its own counts said 79 over
 * 106). They are not yet in the brand's or the fleet's stored counts, so nothing is taken away from those.
 */
export function chooseYield(s: TransitionStats, planRate: number | null, own: { fromUnits: number; toUnits: number }, live: { toUnits: number; exposure: number } | null = null): YieldHypothesis | null {
  const evidence = evidenceOf(s);
  const K = BLEND_PSEUDO_CASES;
  const of = (t: TransitionStat | null) => (t ? { y: t.toUnits, e: Math.max(t.exposure, 0) } : null);
  const less = (a: { y: number; e: number } | null, x: { y: number; e: number } | null) => (a ? { y: Math.max(a.y - (x?.y ?? 0), 0), e: Math.max(a.e - (x?.e ?? 0), 0) } : null);
  const measuredAnywhere = s.campaign !== null || s.brand !== null || s.fleet !== null;
  const stored = of(s.campaign);
  const fresh = stored === null && live !== null && live.exposure > 0 ? { y: live.toUnits, e: live.exposure } : null;
  // With nothing stored or live, and no Silver stat at all, the campaign's own counts are its evidence (uncensored).
  const c = stored ?? fresh ?? (measuredAnywhere ? null : { y: own.toUnits, e: own.fromUnits });
  const campaignEvidence = stored ? ("silver" as const) : fresh ? ("live_counts" as const) : c && c.e > 0 ? ("own_counts" as const) : null;
  const b = of(s.brand);
  const f = of(s.fleet);
  // Only what Silver STORED for the campaign is inside the brand's and the fleet's stored counts.
  const ladder: Array<[HypothesisSource, { y: number; e: number } | null]> = [["fleet", less(f, b ?? stored)], ["brand", less(b, stored)], [stored || fresh ? "campaign" : "default", c]];

  const blend: BlendLevel[] = [];
  // `shape` / `rate` carry the MEAN (the blend); `known` carries how sure it is (the spread), a separate count.
  let shape: number | null = null;
  let rate = 0;
  let known = 0;
  if (planRate !== null && planRate > 0) {
    shape = K;
    rate = K / planRate;
    known = PLAN_LINE_SPREAD_CASES;
    blend.push({ level: "plan", cases: null, exposure: null, measuredRate: planRate, fallbackRate: null, weight: 1, blendedRate: planRate, share: 1, spreadCases: known });
  }
  for (const [level, ev] of ladder) {
    if (ev === null || ev.e <= 0) continue;
    const measuredRate = ev.y / ev.e;
    if (shape === null) {
      shape = 0.5 + ev.y;
      rate = ev.e;
      known = shape;
      blend.push({ level, cases: ev.y, exposure: ev.e, measuredRate, fallbackRate: null, weight: 1, blendedRate: shape / rate, share: 1, spreadCases: known });
      continue;
    }
    // The level below, restated at K cases, updated by this level's own cases over its own exposure.
    const fallbackRate: number = shape / rate;
    const priorRate = K / fallbackRate;
    const weight = ev.e / (priorRate + ev.e);
    shape = K + ev.y;
    rate = priorRate + ev.e;
    // The fallback is restated at K cases for the MEAN; for the spread it counts what it was itself known by, at most K.
    known = Math.min(K, known) + ev.y;
    sharesAfter(blend, weight);
    blend.push({ level, cases: ev.y, exposure: ev.e, measuredRate, fallbackRate, weight, blendedRate: shape / rate, share: weight, spreadCases: known });
  }
  if (shape === null) return null;
  // What a draw samples: the blended mean, known by `known` cases.
  const mean = shape / rate;
  shape = known;
  rate = known / mean;
  const source = heaviest(blend).level;
  const finer = (["campaign", "brand"] as const).filter((scope) => s[scope] !== null || (scope === "campaign" && fresh !== null));
  const rank: Record<HypothesisSource, number> = { default: 0, plan: 0, fleet: 1, brand: 2, campaign: 3 };
  return { source, shape, rate, effectiveCases: known, thinnerScopes: finer.filter((scope) => rank[scope] > rank[source]), evidence, blend, campaignEvidence };
}

/** One level of the ladder a delay curve rests on. */
export interface DelayBlendLevel {
  level: HypothesisSource;
  /** Pairs this level adds that the finer levels do not hold (0 on the default). */
  pairs: number;
  /** The level's own measured median; the default's assumed one. */
  medianHours: number;
  /** Share of this level's own curve in ITS blended curve, and in the curve finally used. */
  weight: number;
  share: number;
}

export interface DelayHypothesis {
  /** The level weighing most in the curve used. */
  source: HypothesisSource;
  /** Pairs behind `source`'s own curve (0 on the default). */
  pairs: number;
  /** `source` holds under MIN_DELAY_PAIRS pairs. */
  thinSample: boolean;
  /** Of the BLENDED curve: what the projection uses. */
  medianHours: number;
  p10Hours: number;
  p90Hours: number;
  cdf: Array<{ hours: number; share: number }>;
  /** The ladder, default first. */
  blend: DelayBlendLevel[];
  /** Each level's OWN curve with its share in the curve used: a draw takes ONE of them, by share (FORECAST-TUNNEL-1118). */
  curves: Array<{ level: HypothesisSource; share: number; cdf: Array<{ hours: number; share: number }> }>;
}

/** With no pair measured anywhere: half the Units within this many days (the maturity window `lib/maturity.ts` has always assumed), exponential. */
export const DEFAULT_DELAY_MEDIAN_DAYS = 21;

function defaultDelayCdf(): Array<{ hours: number; share: number }> {
  const medianHours = DEFAULT_DELAY_MEDIAN_DAYS * 24;
  const F = (h: number) => 1 - Math.pow(2, -h / medianHours);
  const cdf: Array<{ hours: number; share: number }> = [];
  for (let d = 1; d <= 180; d += d < 14 ? 1 : 7) cdf.push({ hours: d * 24, share: F(d * 24) });
  cdf.push({ hours: 365 * 24, share: 1 });
  return cdf;
}

/** PURE. The mixture of two delay curves: `weight` of `a`, the rest of `b`, on every hour either one names. */
export function mixDelayCurves(a: ReadonlyArray<{ hours: number; share: number }>, b: ReadonlyArray<{ hours: number; share: number }>, weight: number): Array<{ hours: number; share: number }> {
  const hours = [...new Set([...a, ...b].map((p) => p.hours))].sort((x, y) => x - y);
  return hours.map((h) => ({ hours: h, share: weight * delayCdfAt(a, h) + (1 - weight) * delayCdfAt(b, h) }));
}

/** PURE. The hours by which a curve has let `q` of its Units through (linear between its points). */
export function delayQuantileOf(cdf: ReadonlyArray<{ hours: number; share: number }>, q: number): number {
  let ph = 0;
  let ps = 0;
  for (const p of cdf) {
    if (p.share >= q) return p.share === ps ? p.hours : ph + (p.hours - ph) * ((q - ps) / (p.share - ps));
    ph = p.hours;
    ps = p.share;
  }
  return ph;
}

/**
 * PURE. The delay curve a projection takes: the default curve, then the fleet's, the brand's and the campaign's measured
 * curves, each MIXED into the one below with the weight pairs ÷ (pairs + `BLEND_PSEUDO_CASES`), a level counting the pairs
 * the finer ones do not already hold (THIN-SAMPLE-BLEND-1118: 2 pairs no longer set a curve alone).
 */
export function chooseDelay(s: TransitionStats, liveCampaign: DelayDistribution | null = null): DelayHypothesis {
  // A campaign Silver holds no row for brings the delay it measured itself (FORECAST-FRESH-EVIDENCE-1118).
  if (s.campaign === null && liveCampaign !== null) s = { ...s, campaign: { delay: liveCampaign } as TransitionStat };
  const K = BLEND_PSEUDO_CASES;
  let cdf = defaultDelayCdf();
  const blend: DelayBlendLevel[] = [{ level: "default", pairs: 0, medianHours: DEFAULT_DELAY_MEDIAN_DAYS * 24, weight: 1, share: 1 }];
  const own: Array<Array<{ hours: number; share: number }>> = [cdf];
  const ownPairs = new Map<HypothesisSource, number>([["default", 0]]);
  const n = (scope: "campaign" | "brand" | "fleet") => s[scope]?.delay?.n ?? 0;
  // Pairs read live are not in the brand's or the fleet's stored curves yet: nothing is taken from those.
  const inStored = liveCampaign !== null && s.campaign?.delay === liveCampaign ? 0 : n("campaign");
  const ladder: Array<["fleet" | "brand" | "campaign", number]> = [["fleet", n("fleet") - (s.brand?.delay ? n("brand") : inStored)], ["brand", n("brand") - inStored], ["campaign", n("campaign")]];
  for (const [scope, pairs] of ladder) {
    const d = s[scope]?.delay;
    if (!d || pairs <= 0) continue;
    const weight = pairs / (pairs + K);
    cdf = mixDelayCurves(d.cdf, cdf, weight);
    sharesAfter(blend, weight);
    blend.push({ level: scope, pairs, medianHours: d.medianHours, weight, share: weight });
    own.push(d.cdf);
    ownPairs.set(scope, d.n);
  }
  const source = heaviest(blend).level;
  const pairs = ownPairs.get(source) ?? 0;
  const curves = blend.map((l, k) => ({ level: l.level, share: l.share, cdf: own[k]! }));
  return { source, pairs, thinSample: source !== "default" && pairs < MIN_DELAY_PAIRS, medianHours: delayQuantileOf(cdf, 0.5), p10Hours: delayQuantileOf(cdf, 0.1), p90Hours: delayQuantileOf(cdf, 0.9), cdf, blend, curves };
}

export type EntryCostSource = "campaign" | "brand" | "fleet" | "plan";

export interface EntryCostHypothesis {
  /** The level weighing most in the cost used. */
  source: EntryCostSource;
  /** USD per Unit of the first milestone: the cost USED (the campaign's own, blended with its fallback by its Units). */
  usdPerUnit: number;
  p10: number;
  p90: number;
  /** The campaign's spend and Units of the first milestone to date; null = it made none yet. */
  spentUsd: number | null;
  units: number | null;
  /** The campaign's own measured cost (everything it spent ÷ its Units of the first milestone); null = no Unit yet. */
  measuredUsdPerUnit: number | null;
  /** What it falls back on, and from where (`brand` / `fleet` = the ledger's measured cost of one such Unit; `plan` = the plan line's own); null = none. */
  fallbackUsdPerUnit: number | null;
  fallbackSource: Exclude<EntryCostSource, "campaign"> | null;
  /** Share of the campaign's own measurement in the cost used. */
  weight: number;
  /** plan fallback: the basis the plan line states for its cost per Target. */
  planBasis: string | null;
  /** The values a draw picks from. */
  draws: number[];
}

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

export const quantileOf = (sorted: ArrayLike<number>, q: number): number => {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
};

/**
 * PURE. What one Unit of the first milestone costs. FORECAST-LEAD-DEALS-1118: the same ladder as every figure, measured
 * before default: the campaign's own cost (everything it spent ÷ its Units of the first milestone, from its FIRST Unit;
 * the uncertainty = bootstrap over its days), blended with its fallback by its Units (`BLEND_PSEUDO_CASES`, on the log
 * scale). The fallback
 * is a cost of ONE such Unit on the SAME all-in basis: what the brand's other campaigns, else the fleet's, spent per Unit
 * of that first milestone (FORECAST-ENTRY-COST-BASIS-1118), else the plan line's own (its cost per Target ÷ its own Units
 * needed per Target). Never the plan's cost per Target times
 * yields measured elsewhere: a plan line assuming a default rate of 60% priced a message at $0.000008 once multiplied by
 * the fleet's measured 0.00007, where the campaign's own 27 messages cost $0.075 each. Nothing = null.
 */
export function chooseEntryCost(days: ReadonlyArray<{ spendUsd: number; units: number }>, fallback: { usdPerUnit: number; source: Exclude<EntryCostSource, "campaign">; planBasis: string | null } | null, rng: () => number): EntryCostHypothesis | null {
  const spent = days.reduce((a, d) => a + d.spendUsd, 0);
  const units = days.reduce((a, d) => a + d.units, 0);
  const fb = fallback !== null && fallback.usdPerUnit > 0 ? fallback : null;
  if (units > 0 && spent > 0) {
    const measured = spent / units;
    const weight = fb === null ? 1 : units / (units + BLEND_PSEUDO_CASES);
    // Blended on the log scale (a cost is a ratio: 10 times too high and 10 times too low weigh alike), so a fallback far
    // from the measurement barely moves a campaign holding thousands of Units.
    const mix = (own: number) => (fb === null ? own : Math.exp(weight * Math.log(own) + (1 - weight) * Math.log(fb.usdPerUnit)));
    const draws: number[] = [];
    for (let i = 0; i < COST_RESAMPLES; i++) {
      let s = 0;
      let u = 0;
      for (let k = 0; k < days.length; k++) {
        const d = days[Math.floor(rng() * days.length)]!;
        s += d.spendUsd;
        u += d.units;
      }
      draws.push(mix(u > 0 && s > 0 ? s / u : measured));
    }
    const sorted = [...draws].sort((a, b) => a - b);
    return { source: weight >= 0.5 ? "campaign" : fb!.source, usdPerUnit: mix(measured), p10: quantileOf(sorted, 0.1), p90: quantileOf(sorted, 0.9), spentUsd: spent, units, measuredUsdPerUnit: measured, fallbackUsdPerUnit: fb?.usdPerUnit ?? null, fallbackSource: fb?.source ?? null, weight, planBasis: fb?.planBasis ?? null, draws };
  }
  if (fb !== null) return { source: fb.source, usdPerUnit: fb.usdPerUnit, p10: fb.usdPerUnit, p90: fb.usdPerUnit, spentUsd: null, units: null, measuredUsdPerUnit: null, fallbackUsdPerUnit: fb.usdPerUnit, fallbackSource: fb.source, weight: 0, planBasis: fb.planBasis, draws: [fb.usdPerUnit] };
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
  /**
   * `cdf` = the curve of the transition. `curves` (optional) = the candidate curves it is a mixture of, with their
   * shares: each draw then takes ONE per transition, by share, so a curve resting on a default adds its own doubt to the
   * tunnel. The mean over draws is the mixture's (a Poisson flow is linear in the curve): the expected figures do not move.
   */
  delays: ReadonlyArray<{ cdf: ReadonlyArray<{ hours: number; share: number }>; curves?: ReadonlyArray<{ share: number; cdf: ReadonlyArray<{ hours: number; share: number }> }> }>;
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

/** A candidate curve weighing under this share of its mixture is not drawn (its share goes to the others): it bounds the curve choices computed. */
const MIN_CURVE_SHARE = 0.02;

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

/** PURE. One draw of Gamma(shape, 1) (Marsaglia-Tsang): divide by the rate for Gamma(shape, rate). */
export function gammaDraw(shape: number, rng: () => number): number {
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
  const rng = rngOf(i.seed);
  // The candidate curves of each transition (one when it states no mixture), each as shares per day of lag.
  const candidates = i.delays.map((d) => {
    const all = d.curves && d.curves.length > 0 ? d.curves.filter((c) => c.share >= MIN_CURVE_SHARE) : [];
    const kept = all.length > 0 ? all : [{ share: 1, cdf: d.cdf }];
    const total = kept.reduce((a, c) => a + c.share, 0);
    return kept.map((c) => ({ share: c.share / total, lag: lagSharesOf(c.cdf) }));
  });

  // The flows under ONE choice of curve per transition (memoised: a few choices carry nearly every draw).
  const flowsOf = (choice: readonly number[]) => {
    const lags = choice.map((c, k) => candidates[k]![c]!.lag);
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
    return { bought, maturing };
  };
  const flows = new Map<string, ReturnType<typeof flowsOf>>();
  const choice = new Array<number>(Math.max(K - 1, 0)).fill(0);

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
    // One curve per transition for this draw, by share (no random number spent where there is only one).
    for (let k = 0; k < K - 1; k++) {
      const c = candidates[k]!;
      let pick = 0;
      if (c.length > 1) {
        let u = rng();
        while (pick < c.length - 1 && u >= c[pick]!.share) u -= c[pick++]!.share;
      }
      choice[k] = pick;
    }
    const key = choice.join(",");
    const { bought, maturing } = flows.get(key) ?? flows.set(key, flowsOf(choice)).get(key)!;
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
  /**
   * The delay the campaign measured ITSELF on a transition Silver holds no campaign row for (its pairs, read live off the
   * links); null = none. Absent = nothing is read live.
   */
  liveCampaignDelay?: (fromKey: string, toKey: string) => DelayDistribution | null;
  /**
   * Silver: what sales funnel campaigns with this FIRST milestone spent all in, and their Units of it, at a scope
   * (`campaign` = this campaign's own stored row, taken out of its brand's and the fleet's pools); null = none.
   */
  entryCost?: (scope: "campaign" | "brand" | "fleet", outcomeKey: string) => EntryCostStat | null;
  silverComputedAt: string | null;
}

const band = (shape: number, rate: number) => ({ mean: shape / rate, median: gammaQuantile(0.5, shape, rate), p10: gammaQuantile(0.1, shape, rate), p90: gammaQuantile(0.9, shape, rate) });
export const seedOf = (s: string) => {
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
    // A campaign Silver holds no row for yet (younger than the last sweep): its cases as its page counts them NOW, each
    // `from` Unit counting for the share of its `to` Units already due at its age: the sweep's own censoring, on the curve
    // the sweep would pick (the campaign's OWN pairs when it holds at least 10, read live off the links; else the brand's,
    // else the fleet's stored curve). Prod 2026-11-18: censored by the fleet's curve alone (follow-up steps sent weeks
    // later) a campaign's 79 messages for 106 leads read 3.5 per lead; on its own pairs it reads what it is.
    const live = stats.campaign === null && best !== null ? i.liveCampaignDelay?.(best.a, best.b) ?? null : null;
    const curves = [live, stats.brand?.delay ?? null, stats.fleet?.delay ?? null].filter((d): d is DelayDistribution => d !== null);
    const censor = curves.find((d) => d.n >= MIN_DELAY_PAIRS) ?? [...curves].sort((x, y) => y.n - x.n)[0] ?? null;
    const today0 = Date.parse(`${i.now.slice(0, 10)}T00:00:00.000Z`);
    const exposure = censor === null ? own.fromUnits : m.unitsByDay.reduce((s, d) => s + d.units * delayCdfAt(censor.cdf, (today0 - Date.parse(`${d.date}T00:00:00.000Z`)) / 3_600_000 + 12), 0);
    return { from: m, to: next, keys: best, yield: chooseYield(stats, planRate, own, { toUnits: own.toUnits, exposure }), delay: chooseDelay(stats, live) };
  });
  const missing = picks.find((p) => p.yield === null);
  if (missing) return empty(`yield_unmeasured:${missing.from.step}->${missing.to.step}`);

  const rng = rngOf(seedOf(i.salesFunnelCampaignId));
  const entry = i.milestones[0]!;
  const spendOn = new Map(i.spendByDay.map((d) => [d.date, d.spendUsd]));
  const unitsOn = new Map(entry.unitsByDay.map((d) => [d.date, d.units]));
  const costDays = [...new Set([...spendOn.keys(), ...unitsOn.keys()])].sort().map((date) => ({ spendUsd: spendOn.get(date) ?? 0, units: unitsOn.get(date) ?? 0 }));
  // FORECAST-ENTRY-COST-BASIS-1118: every level of the cost ladder is on the SAME basis as the campaign's own figure:
  // everything spent ÷ Units of the first milestone. Brand = the brand's OTHER sales funnel campaigns with this first
  // milestone, pooled; fleet = the fleet's others; then the plan line's own cost per Unit. A level that cannot be measured
  // all in is skipped with its reason, never replaced by the ledger cost of the Unit alone ($0.001 to send a message).
  const entryKey = entry.ledgerKeys.map((k) => ({ k, n: i.entryCost?.("fleet", k)?.units ?? -1 })).sort((x, y) => y.n - x.n)[0]?.k ?? null;
  const ownStored = entryKey === null ? null : i.entryCost?.("campaign", entryKey) ?? null;
  const othersAt = (scope: "brand" | "fleet"): { usdPerUnit: number; units: number; campaigns: number } | { skip: string } => {
    const pool = entryKey === null ? null : i.entryCost?.(scope, entryKey) ?? null;
    if (pool === null) return { skip: "no_sales_funnel_campaign_with_this_first_milestone" };
    const campaigns = pool.campaigns - (ownStored ? 1 : 0);
    const units = pool.units - (ownStored?.units ?? 0);
    const spendUsd = pool.spendUsd - (ownStored?.spendUsd ?? 0);
    if (campaigns <= 0) return { skip: "no_other_sales_funnel_campaign_with_this_first_milestone" };
    if (units < MIN_ENTRY_COST_UNITS) return { skip: "under_30_units_of_other_campaigns" };
    if (spendUsd <= 0) return { skip: "no_spend_measured_on_other_campaigns" };
    return { usdPerUnit: spendUsd / units, units, campaigns };
  };
  const brandLevel = othersAt("brand");
  const fleetLevel = othersAt("fleet");
  const planOwn = i.plan.costPerTargetUsd !== null && i.plan.costPerTargetUsd > 0 && entry.neededPerTarget !== null && entry.neededPerTarget > 0 ? i.plan.costPerTargetUsd / entry.neededPerTarget : null;
  const fallback =
    "usdPerUnit" in brandLevel
      ? { usdPerUnit: brandLevel.usdPerUnit, source: "brand" as const, planBasis: null }
      : "usdPerUnit" in fleetLevel
        ? { usdPerUnit: fleetLevel.usdPerUnit, source: "fleet" as const, planBasis: null }
        : planOwn !== null
          ? { usdPerUnit: planOwn, source: "plan" as const, planBasis: i.plan.basis }
          : null;
  const entryCost = chooseEntryCost(costDays, fallback, rng);
  if (entryCost === null) return empty("cost_unmeasured_and_plan_prices_no_target");
  const usedBelow = entryCost.fallbackSource;
  const below = (level: "brand" | "fleet", l: typeof brandLevel): EntryCostLevel => ({
    level,
    basis: ENTRY_COST_BASIS.allIn,
    usdPerUnit: "usdPerUnit" in l ? l.usdPerUnit : null,
    units: "usdPerUnit" in l ? l.units : null,
    campaigns: "usdPerUnit" in l ? l.campaigns : null,
    weight: usedBelow === level ? 1 - entryCost.weight : 0,
    skippedReason: "skip" in l ? l.skip : usedBelow === level ? null : "finer_level_used",
  });
  const entryLevels: EntryCostLevel[] = [
    { level: "campaign", basis: ENTRY_COST_BASIS.allIn, usdPerUnit: entryCost.measuredUsdPerUnit, units: entryCost.units, campaigns: entryCost.units === null ? null : 1, weight: entryCost.weight, skippedReason: entryCost.measuredUsdPerUnit === null ? "no_unit_of_the_first_milestone_yet" : null },
    below("brand", brandLevel),
    below("fleet", fleetLevel),
    { level: "plan", basis: ENTRY_COST_BASIS.plan, usdPerUnit: planOwn, units: null, campaigns: null, weight: usedBelow === "plan" ? 1 - entryCost.weight : 0, skippedReason: planOwn === null ? (i.plan.costPerTargetUsd === null ? "plan_prices_no_target" : "plan_states_no_units_needed_per_target") : usedBelow === "plan" ? null : "finer_level_used" },
  ];


  const run = (m: number) => {
    const schedule = spendReason === null ? expectedScheduleOf(i.spendPerDayUsd! * m, i.spendPerDayUsd! * m, scaledCapacity(i.capacity, m), i.now) : null;
    return forecastOf({
      now: i.now,
      milestones: i.milestones,
      yields: picks.map((p) => p.yield!),
      delays: picks.map((p) => ({ cdf: p.delay.cdf, curves: p.delay.curves })),
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
      entryCost: { step: entry.step, label: entry.label, source: entryCost.source, usdPerUnit: round(entryCost.usdPerUnit), p10: round(entryCost.p10), p90: round(entryCost.p90), spentUsd: entryCost.spentUsd, units: entryCost.units, measuredUsdPerUnit: entryCost.measuredUsdPerUnit === null ? null : round(entryCost.measuredUsdPerUnit), fallbackUsdPerUnit: entryCost.fallbackUsdPerUnit === null ? null : round(entryCost.fallbackUsdPerUnit), fallbackSource: entryCost.fallbackSource, weight: round(entryCost.weight, 4), planBasis: entryCost.planBasis, levels: entryLevels.map((l) => ({ ...l, usdPerUnit: l.usdPerUnit === null ? null : round(l.usdPerUnit), weight: round(l.weight, 4) })) },
      transitions: picks.map((p) => {
        const b = band(p.yield!.shape, p.yield!.rate);
        return {
          fromStep: p.from.step,
          toStep: p.to.step,
          fromOutcomeKey: p.keys?.a ?? null,
          toOutcomeKey: p.keys?.b ?? null,
          // `unitsPerUnit` = the BLENDED rate the projection uses; `blend` = what it rests on (THIN-SAMPLE-BLEND-1118).
          yield: {
            source: p.yield!.source,
            unitsPerUnit: round(b.mean),
            median: round(b.median),
            p10: round(b.p10),
            p90: round(b.p90),
            thinnerScopes: p.yield!.thinnerScopes,
            pseudoCases: BLEND_PSEUDO_CASES,
            campaignEvidence: p.yield!.campaignEvidence,
            // The spread, apart from the mean (FORECAST-TUNNEL-1118): the cases the rate is known by, and a plan line's worth.
            effectiveCases: round(p.yield!.effectiveCases),
            planLineSpreadCases: PLAN_LINE_SPREAD_CASES,
            blend: p.yield!.blend.map((l) => ({ level: l.level, cases: l.cases, exposure: l.exposure === null ? null : round(l.exposure), measuredRate: l.measuredRate === null ? null : round(l.measuredRate), fallbackRate: l.fallbackRate === null ? null : round(l.fallbackRate), weight: round(l.weight, 4), blendedRate: round(l.blendedRate), share: round(l.share, 4), spreadCases: round(l.spreadCases) })),
            evidence: p.yield!.evidence,
          },
          delay: {
            source: p.delay.source,
            pairs: p.delay.pairs,
            thinSample: p.delay.thinSample,
            medianHours: round(p.delay.medianHours),
            p10Hours: round(p.delay.p10Hours),
            p90Hours: round(p.delay.p90Hours),
            blend: p.delay.blend.map((l) => ({ level: l.level, pairs: l.pairs, medianHours: round(l.medianHours), weight: round(l.weight, 4), share: round(l.share, 4) })),
          },
        };
      }),
      targetValue: i.targetValueUsd === null ? null : { usd: i.targetValueUsd, source: "plan_target_value" as const },
    },
    forecast: forecast as ForecastOutput | null,
    alternatives,
  };
}
