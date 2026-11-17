/**
 * OUTCOME-FORECAST-1117, SILVER (owner 2026-11-17: « pour les coûts la moyenne, la médiane, les ranges de percentile », the
 * same for the duration an outcome takes; « découper ces chiffres et hypothèses par layers »). PURE.
 *
 * What is MEASURED about the Units of the ledger, with NO hypothesis, at three scopes (a campaign, a brand, the fleet):
 *  1. COST PER UNIT of an outcome: the distribution of the production cost the ledger states on each Unit.
 *  2. YIELD of a transition (Units of `to` per Unit of `from`): a rate, never a probability (a lead found holds several
 *     messages sent). Estimated the standard way for a count over an exposure: Gamma-Poisson (empirical Bayes), the prior
 *     fitted on every campaign of the fleet by maximum marginal likelihood (negative binomial); CENSORING by effective
 *     exposure (a `from` Unit of age a counts for F(a), F = the transition's own measured delay curve: the actuarial
 *     estimator `lib/outcome-estimates.ts` applies to positive replies only).
 *  3. DELAY of a transition: the delay the ledger STATES on the link between the two Units (`delaySeconds`).
 *
 * UNIT-LINKS-CONSUME-1117-FIX: the YIELD is counted on UNITS, never on links. `to` Units ÷ the censored exposure of the
 * `from` Units, both over the Units of the scope that a campaign carries (a campaign's own counts: the ones its page
 * prints; a brand and the fleet pool their campaigns). A stored link says WHICH Unit a Unit came from: where producers
 * declare no consumption the link is missing, the Unit still happened, so a yield counted on links reads low by exactly
 * the missing links (prod 2026-11-17: 0.62 for a campaign whose counts give 0.90). The links give the delay curve, the
 * campaign a late Unit is credited to, and which transitions exist; `linkedToUnits` / `linkCoverage` say how much of the
 * `to` Units they tie, so a thin coverage is visible. A Unit no campaign carries is in no yield (nothing ties it to a
 * funnel: a served fact of the ledger, never filled here).
 *
 * UNIT-LINKS-CONSUME-1117: a PAIR is a link the ledger stores (the Unit a Unit came from, subject equivalences followed),
 * or a walk of such links (A -> B -> C pairs A with C, the delays added). Nothing is paired here by subject and date. A
 * Unit counts for the campaign(s) it CARRIES as the ledger serves them: its own run's, else those of the Units it came
 * from (a Unit declared late on a run naming no campaign). A Unit carried by two campaigns counts in both, once in its
 * brand and in the fleet.
 *
 * ONE mechanism for every outcome: no outcome, channel or Engine is named here (guard `outcome-silver.test.ts`).
 * The rows come from our copies of the ledger's Units and links (`outcome_units`, `outcome_unit_links`), grouped by SQL
 * only (`lib/outcome-silver-io.ts`); every figure is computed here.
 */
import { lnGamma } from "./outcome-estimates.js";

// ── Distributions ──────────────────────────────────────────────────────────────────────────────────

export interface WeightedPoint {
  value: number;
  weight: number;
}

export interface Distribution {
  /** Sample size (Σ weights). */
  n: number;
  mean: number;
  median: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
}

/** PURE. The q-quantile of weighted points (lower weighted quantile: the smallest value whose cumulative weight reaches q). */
export function weightedQuantile(sorted: readonly WeightedPoint[], total: number, q: number): number {
  let acc = 0;
  for (const p of sorted) {
    acc += p.weight;
    if (acc >= q * total - 1e-9) return p.value;
  }
  return sorted[sorted.length - 1]!.value;
}

/** PURE. Mean, median and percentiles of weighted points; null without a sample. `exactSum` = Σ value when the points are binned. */
export function distributionOf(points: readonly WeightedPoint[], exactSum?: number): Distribution | null {
  const pts = points.filter((p) => p.weight > 0 && Number.isFinite(p.value)).sort((a, b) => a.value - b.value);
  const n = pts.reduce((a, p) => a + p.weight, 0);
  if (n <= 0) return null;
  const q = (x: number) => weightedQuantile(pts, n, x);
  return { n, mean: (exactSum ?? pts.reduce((a, p) => a + p.value * p.weight, 0)) / n, median: q(0.5), p10: q(0.1), p25: q(0.25), p75: q(0.75), p90: q(0.9) };
}

// ── Delays ─────────────────────────────────────────────────────────────────────────────────────────

/** Upper edges of the delay bins, in hours (the SQL `width_bucket` thresholds): fine below a day, then days, weeks, months. */
export const DELAY_EDGES_HOURS: readonly number[] = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 36, 48, 72, 96, 120, 144, 168, 240, 336, 504, 720, 1080, 1440, 2160, 2880, 4320, 8760];
/** The open last bin (a year and more) is read as ending here. */
const LAST_BIN_END_HOURS = 2 * 8760;

/** PURE. [from, to) hours of a `width_bucket` bin index (0 = under the first edge). */
export function delayBinRange(bin: number): [number, number] {
  const e = DELAY_EDGES_HOURS;
  return [bin <= 0 ? 0 : e[Math.min(bin, e.length) - 1]!, bin >= e.length ? LAST_BIN_END_HOURS : e[Math.max(bin, 0)]!];
}

export interface DelayDistribution {
  /** Pairs measured (a `to` Unit and the `from` Unit it came after). */
  n: number;
  meanHours: number;
  medianHours: number;
  p10Hours: number;
  p25Hours: number;
  p75Hours: number;
  p90Hours: number;
  /** The measured curve: share of pairs whose delay is under `hours`, one point per edge of a bin that holds pairs. */
  cdf: Array<{ hours: number; share: number }>;
}

/** Up to this many pairs the quantiles of a delay are EXACT (computed on the pairs' own delays); above, read off the bins. */
export const EXACT_DELAY_MAX_PAIRS = 200;

/** PURE. The q-quantile of sorted values, linear between the two nearest (the usual continuous quantile: the median of two values is their middle). */
export function exactQuantile(sorted: readonly number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

/**
 * PURE. A transition's delay distribution. `samplesHours` = every pair's own delay, given while the sample is small
 * (`EXACT_DELAY_MAX_PAIRS`): the quantiles are then EXACT (a binned median of 4 pairs read 1.5 d where the pairs say 2.1).
 * Without it the quantiles are interpolated inside the bins. The mean is exact either way; the curve is the bins'.
 */
export function delayDistributionOf(bins: ReadonlyMap<number, number>, sumHours: number, samplesHours?: readonly number[] | null): DelayDistribution | null {
  const rows = [...bins].filter(([, n]) => n > 0).sort((a, b) => a[0] - b[0]);
  const n = rows.reduce((a, [, c]) => a + c, 0);
  if (n <= 0) return null;
  const exact = samplesHours && samplesHours.length === n && n <= EXACT_DELAY_MAX_PAIRS ? [...samplesHours].sort((a, b) => a - b) : null;
  const quantile = (q: number): number => {
    if (exact) return exactQuantile(exact, q);
    let acc = 0;
    for (const [bin, c] of rows) {
      if (acc + c >= q * n - 1e-9) {
        const [lo, hi] = delayBinRange(bin);
        return lo + (hi - lo) * Math.min(1, Math.max(0, (q * n - acc) / c));
      }
      acc += c;
    }
    return delayBinRange(rows[rows.length - 1]![0])[1];
  };
  // One point per edge of a bin holding pairs (its lower edge too when the bin before it is empty: nothing arrives there).
  let acc = 0;
  const cdf: Array<{ hours: number; share: number }> = [];
  for (const [bin, c] of rows) {
    const [lo, hi] = delayBinRange(bin);
    if (lo > (cdf[cdf.length - 1]?.hours ?? 0)) cdf.push({ hours: lo, share: acc / n });
    cdf.push({ hours: hi, share: (acc += c) / n });
  }
  return { n, meanHours: sumHours / n, medianHours: quantile(0.5), p10Hours: quantile(0.1), p25Hours: quantile(0.25), p75Hours: quantile(0.75), p90Hours: quantile(0.9), cdf };
}

/** PURE. The share of a transition's `to` Units arrived within `hours` of their `from` Unit (linear between the curve's points). */
export function delayCdfAt(cdf: ReadonlyArray<{ hours: number; share: number }>, hours: number): number {
  if (cdf.length === 0) return 1;
  if (hours <= 0) return 0;
  let prevH = 0;
  let prevS = 0;
  for (const p of cdf) {
    if (hours <= p.hours) return prevS + (p.share - prevS) * ((hours - prevH) / (p.hours - prevH));
    prevH = p.hours;
    prevS = p.share;
  }
  return 1;
}

// ── Yields (Gamma-Poisson) ─────────────────────────────────────────────────────────────────────────

/** Regularized lower incomplete gamma P(a, x) (Numerical Recipes: series below a + 1, continued fraction above). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const gln = lnGamma(a);
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let i = 0; i < 1000; i++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return Math.min(1, sum * Math.exp(-x + a * Math.log(x) - gln));
  }
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.max(0, 1 - Math.exp(-x + a * Math.log(x) - gln) * h);
}

/** PURE. The p-quantile of Gamma(shape, rate) (bisection on the incomplete gamma). */
export function gammaQuantile(p: number, shape: number, rate: number): number {
  let lo = 0;
  let hi = Math.max(1, shape) * 4;
  while (gammaP(shape, hi) < p) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (gammaP(shape, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / (2 * rate);
}

/** One group's evidence on a transition: `to` Units over the effective exposure of its `from` Units. */
export interface RateEvidence {
  toUnits: number;
  exposure: number;
}

export interface GammaPrior {
  shape: number;
  /** In exposure units: the prior weighs as much as this many `from` Units. */
  rate: number;
}

/**
 * PURE. The fleet's Gamma prior on a transition's rate, empirical Bayes: mean = the pooled rate (half a Unit over the pooled
 * exposure when nothing was ever made: never a zero rate), strength = the value maximizing the negative binomial marginal
 * likelihood of every group (grid on log strength). Fewer than two groups = the weakest prior (half a Unit).
 */
export function fitGammaPrior(groups: readonly RateEvidence[], pooled?: RateEvidence): GammaPrior {
  const g = groups.filter((x) => x.exposure > 0);
  // The mean is the POOLED rate: the fleet's own evidence when given (it holds the Units no campaign is tagged on), else
  // the groups summed. The groups only say how much campaigns differ (the strength).
  const E = pooled && pooled.exposure > 0 ? pooled.exposure : g.reduce((a, x) => a + x.exposure, 0);
  const Y = pooled && pooled.exposure > 0 ? pooled.toUnits : g.reduce((a, x) => a + x.toUnits, 0);
  if (E <= 0) return { shape: 0.5, rate: 0.5 };
  const m = Math.max(Y, 0.5) / E;
  const weakest: GammaPrior = { shape: 0.5, rate: 0.5 / m };
  if (g.length < 2) return weakest;
  const logLik = (rate: number) => {
    const shape = m * rate;
    return g.reduce((acc, x) => acc + lnGamma(x.toUnits + shape) - lnGamma(shape) + shape * Math.log(rate / (rate + x.exposure)) + x.toUnits * Math.log(x.exposure / (rate + x.exposure)), 0);
  };
  let best = weakest.rate;
  let bestLl = -Infinity;
  const lo = Math.log(weakest.rate);
  const hi = Math.log(Math.max(weakest.rate * 10, E * 100));
  for (let i = 0; i <= 200; i++) {
    const rate = Math.exp(lo + (i / 200) * (hi - lo));
    const ll = logLik(rate);
    if (ll > bestLl) {
      bestLl = ll;
      best = rate;
    }
  }
  return { shape: m * best, rate: best };
}

export interface RateEstimate {
  /** Units of `to` per Unit of `from`: the posterior's mean, median and percentiles. */
  mean: number;
  median: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  /** The posterior Gamma(shape, rate) itself (a projection draws from it). */
  shape: number;
  rate: number;
}

/** PURE. A group's rate posterior: Gamma(prior.shape + toUnits, prior.rate + exposure). */
export function rateEstimateOf(e: RateEvidence, prior: GammaPrior): RateEstimate {
  const shape = prior.shape + e.toUnits;
  const rate = prior.rate + e.exposure;
  const q = (p: number) => gammaQuantile(p, shape, rate);
  return { mean: shape / rate, median: q(0.5), p10: q(0.1), p25: q(0.25), p75: q(0.75), p90: q(0.9), shape, rate };
}

// ── The Silver build: SQL-grouped rows -> stats per scope ──────────────────────────────────────────

export type SilverScope = "campaign" | "brand" | "fleet";
export const FLEET_SCOPE_ID = "all";

/** Units of one outcome made on one UTC day, by the unit campaign(s) they carry ([] = none) (SQL group). */
export interface UnitDayRow {
  outcomeKey: string;
  campaignIds: readonly string[];
  brandId: string | null;
  day: string;
  units: number;
}
/** Units of one outcome by cost (3 significant digits), by the unit campaign(s) they carry (SQL group). */
export interface UnitCostRow {
  outcomeKey: string;
  campaignIds: readonly string[];
  brandId: string | null;
  costNetCents: number;
  units: number;
  sumNetCents: number;
  sumGrossCents: number;
}
/** Linked pairs of a transition by delay bin, by the unit campaign(s) the `from` Unit carries and its brand (SQL group). */
export interface PairBinRow {
  fromKey: string;
  toKey: string;
  fromCampaignIds: readonly string[];
  brandId: string | null;
  bin: number;
  pairs: number;
  sumHours: number;
  /** Each pair's own delay in hours, served while the group is small (`EXACT_DELAY_MAX_PAIRS`); null above. */
  samplesHours: readonly number[] | null;
}
/** `to` Units of a transition that a stored link (or a walk of links) ties to a `from` Unit, each once, by the campaign(s) and brand the `to` Unit carries (SQL group). */
export interface LinkedToRow {
  fromKey: string;
  toKey: string;
  campaignIds: readonly string[];
  brandId: string | null;
  units: number;
}

export interface UnitCostStat {
  units: number;
  /** Production cost per Unit as the ledger states it, in USD on the net basis (what the org pays). */
  costUsd: Distribution;
  /** The gross mean beside it (before the org's discount). */
  meanGrossCostUsd: number;
}

export interface TransitionStat {
  /** `from` Units of the scope that a campaign carries. */
  fromUnits: number;
  /** `to` Units of the scope that a campaign carries: COUNTED, whether or not a stored link ties them to a `from` Unit. */
  toUnits: number;
  /** Of `toUnits`, those a stored link (or a walk of links) ties to a `from` Unit. */
  linkedToUnits: number;
  /** linkedToUnits ÷ toUnits; null without a `to` Unit. Low = producers declare the `to` Unit without the Unit it consumed. */
  linkCoverage: number | null;
  /** Σ over `from` Units of the share of their `to` Units already due at their age (= fromUnits when no delay is measured). */
  exposure: number;
  /** Whose delay curve censored the exposure; null = none measured anywhere (exposure = fromUnits). */
  censoredBy: SilverScope | null;
  yield: RateEstimate;
  /** The fleet prior the estimate starts from (`rate` = the `from` Units it weighs). */
  prior: GammaPrior;
  delay: DelayDistribution | null;
}

export interface SilverStatRow {
  scope: SilverScope;
  scopeId: string;
  /** '' on a cost row. */
  fromKey: string;
  toKey: string;
  sampleSize: number;
  body: { kind: "unit_cost"; stat: UnitCostStat } | { kind: "transition"; stat: TransitionStat };
}

/** Bump when a rule here changes what the stored stats mean: the next tick sweeps again instead of waiting a day. */
export const SILVER_RULE = "2026-11-17.4-yield-on-units";

/** A delay sample under this is THIN: the next scope's curve is preferred (and the choice is said). */
export const MIN_DELAY_PAIRS = 10;

const hoursBetweenDays = (day: string, today: string) => ((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 3_600_000) + 12;

/**
 * PURE. Every Silver stat from the SQL groups. `funnelOf` = the sales funnel campaign of a unit campaign (campaign scope is
 * the funnel campaign: its Units come from several unit campaigns); `today` = the UTC day ages are counted to.
 */
export function buildSilverStats(input: {
  unitDays: readonly UnitDayRow[];
  unitCosts: readonly UnitCostRow[];
  pairBins: readonly PairBinRow[];
  linkedTo: readonly LinkedToRow[];
  funnelOf: (unitCampaignId: string) => string | null;
  today: string;
}): SilverStatRow[] {
  const { funnelOf, today } = input;
  /** The sales funnel campaigns of the unit campaigns a Unit carries (each once). */
  const funnels = (campaignIds: readonly string[]): string[] => [...new Set(campaignIds.flatMap((c) => funnelOf(c) ?? []))];
  const scopesOf = (campaignIds: readonly string[], brandId: string | null): string[] => {
    const out = [`fleet\u0000${FLEET_SCOPE_ID}`];
    if (brandId !== null) out.push(`brand\u0000${brandId}`);
    for (const f of funnels(campaignIds)) out.push(`campaign\u0000${f}`);
    return out;
  };
  const brandOfFunnel = new Map<string, string>();
  for (const r of input.unitDays) if (r.brandId !== null) for (const f of funnels(r.campaignIds)) brandOfFunnel.set(f, r.brandId);
  const rows: SilverStatRow[] = [];

  // 1. Cost per Unit.
  const costs = new Map<string, { pts: WeightedPoint[]; net: number; gross: number }>();
  for (const r of input.unitCosts)
    for (const s of scopesOf(r.campaignIds, r.brandId)) {
      const k = `${s}\u0000${r.outcomeKey}`;
      const c = costs.get(k) ?? costs.set(k, { pts: [], net: 0, gross: 0 }).get(k)!;
      c.pts.push({ value: r.costNetCents / 100, weight: r.units });
      c.net += r.sumNetCents;
      c.gross += r.sumGrossCents;
    }
  for (const [k, c] of costs) {
    const [scope, scopeId, outcomeKey] = k.split("\u0000") as [SilverScope, string, string];
    const d = distributionOf(c.pts, c.net / 100);
    if (d) rows.push({ scope, scopeId, fromKey: "", toKey: outcomeKey, sampleSize: d.n, body: { kind: "unit_cost", stat: { units: d.n, costUsd: d, meanGrossCostUsd: c.gross / 100 / d.n } } });
  }

  // 2. Units per scope, outcome and day, over the Units a campaign carries (the basis of every yield, both sides).
  const fromDays = new Map<string, Map<string, number>>();
  for (const r of input.unitDays)
    for (const s of r.campaignIds.length === 0 ? [] : scopesOf(r.campaignIds, r.brandId)) {
      const k = `${s}\u0000${r.outcomeKey}`;
      const days = fromDays.get(k) ?? fromDays.set(k, new Map()).get(k)!;
      days.set(r.day, (days.get(r.day) ?? 0) + r.units);
    }

  // 3. Pairs per scope and transition. A scope's pair = what became of ITS `from` Unit (the campaigns and the brand that
  // Unit carries: the very basis its `from` Units are counted on), wherever the `to` Unit was declared.
  // The pairs give the DELAY (and which transitions exist), never the yield's count.
  const pairs = new Map<string, { bins: Map<number, number>; sumHours: number; samples: number[] | null }>();
  for (const r of input.pairBins) {
    for (const s of scopesOf(r.fromCampaignIds, r.brandId)) {
      const k = `${s}\u0000${r.fromKey}\u0000${r.toKey}`;
      const p = pairs.get(k) ?? pairs.set(k, { bins: new Map(), sumHours: 0, samples: [] }).get(k)!;
      p.bins.set(r.bin, (p.bins.get(r.bin) ?? 0) + r.pairs);
      p.sumHours += r.sumHours;
      // Every pair's own delay while the scope's sample is small; a group served without them, or too many, ends it.
      if (p.samples !== null) p.samples = r.samplesHours === null || p.samples.length + r.samplesHours.length > EXACT_DELAY_MAX_PAIRS ? null : p.samples.concat(r.samplesHours);
    }
  }
  const delays = new Map<string, DelayDistribution>();
  for (const [k, p] of pairs) {
    const d = delayDistributionOf(p.bins, p.sumHours, p.samples);
    if (d) delays.set(k, d);
  }
  // `to` Units a link ties to a `from` Unit, per scope and transition (same basis as the counts: Units a campaign carries).
  const linked = new Map<string, number>();
  for (const r of input.linkedTo)
    for (const s of r.campaignIds.length === 0 ? [] : scopesOf(r.campaignIds, r.brandId)) {
      const k = `${s}\u0000${r.fromKey}\u0000${r.toKey}`;
      linked.set(k, (linked.get(k) ?? 0) + r.units);
    }

  // 4. Each transition the fleet measured, at every scope holding its `from` Units.
  const transitions = new Set([...pairs.keys()].filter((k) => k.startsWith("fleet\u0000")).map((k) => k.split("\u0000").slice(2).join("\u0000")));
  for (const t of transitions) {
    const [fromKey, toKey] = t.split("\u0000") as [string, string];
    const evidence: Array<{ scope: SilverScope; scopeId: string; fromUnits: number; toUnits: number; linkedToUnits: number; exposure: number; censoredBy: SilverScope | null }> = [];
    for (const [k, days] of fromDays) {
      const [scope, scopeId, outcomeKey] = k.split("\u0000") as [SilverScope, string, string];
      if (outcomeKey !== fromKey) continue;
      const own = delays.get(`${scope}\u0000${scopeId}\u0000${t}`);
      const brandId = scope === "campaign" ? brandOfFunnel.get(scopeId) ?? null : scope === "brand" ? scopeId : null;
      const brand = brandId !== null ? delays.get(`brand\u0000${brandId}\u0000${t}`) : undefined;
      const fleet = delays.get(`fleet\u0000${FLEET_SCOPE_ID}\u0000${t}`);
      // The curve that censors: the finest scope with a sample that is not thin, else the largest sample measured.
      const ladder: Array<[SilverScope, DelayDistribution | undefined]> = [[scope, own], ["brand", brand], ["fleet", fleet]];
      const pick = ladder.find(([, d]) => d !== undefined && d.n >= MIN_DELAY_PAIRS) ?? ladder.filter(([, d]) => d !== undefined).sort((a, b) => b[1]!.n - a[1]!.n)[0];
      const fromUnits = [...days.values()].reduce((a, n) => a + n, 0);
      const exposure = pick ? [...days].reduce((a, [day, n]) => a + n * delayCdfAt(pick[1]!.cdf, hoursBetweenDays(day, today)), 0) : fromUnits;
      // The yield's count: the scope's own `to` Units (never the links: a missing link is not a missing Unit).
      const toUnits = [...(fromDays.get(`${scope}\u0000${scopeId}\u0000${toKey}`)?.values() ?? [])].reduce((a, n) => a + n, 0);
      evidence.push({ scope, scopeId, fromUnits, toUnits, linkedToUnits: linked.get(`${scope}\u0000${scopeId}\u0000${t}`) ?? 0, exposure, censoredBy: pick ? pick[0] : null });
    }
    const prior = fitGammaPrior(evidence.filter((e) => e.scope === "campaign"), evidence.find((e) => e.scope === "fleet"));
    for (const e of evidence) {
      // The fleet's own row is what a campaign with no evidence can expect: the prior itself, on the fleet's pooled counts.
      const est = e.scope === "fleet" ? rateEstimateOf({ toUnits: 0, exposure: 0 }, prior) : rateEstimateOf({ toUnits: e.toUnits, exposure: Math.max(e.exposure, 0) }, prior);
      rows.push({
        scope: e.scope,
        scopeId: e.scopeId,
        fromKey,
        toKey,
        sampleSize: e.fromUnits,
        body: { kind: "transition", stat: { fromUnits: e.fromUnits, toUnits: e.toUnits, linkedToUnits: e.linkedToUnits, linkCoverage: e.toUnits > 0 ? e.linkedToUnits / e.toUnits : null, exposure: e.exposure, censoredBy: e.censoredBy, yield: est, prior, delay: delays.get(`${e.scope}\u0000${e.scopeId}\u0000${t}`) ?? null } },
      });
    }
  }
  return rows;
}
