/**
 * WHAT A RESEARCH STUDY'S DATA CAN CARRY, in one of three words (owner 2026-10-02; LIVE-RESEARCH-1018 ports the rule
 * the nightly snapshot applied, `apps/landing/scripts/blog-data/verdict.mjs` + `like-for-like.mjs` in distribute.you):
 *   conclusion: the leader beats the runner-up on the crude counts AND on the same clients in the same months, both
 *               after a Bonferroni correction for every comparison the study makes;
 *   signal:     the crude gap is under 5% chance alone, but it fails the correction or the like-for-like check (or
 *               that check cannot run): a lead to confirm;
 *   noise:      anything else, a leader resting on fewer than MIN_OUTCOMES outcomes included.
 * The leader stays the first bar whatever the word. Pure: nothing here reads or prints.
 */

export const MIN_OUTCOMES = 5;
const ALPHA = 0.05;

/** One arm of a comparison: outcomes over an exposure (people or dollars). */
export interface Arm {
  label: string;
  outcomes: number;
  /** The rate's exposure: people (or emails) the outcomes are counted over. */
  exposure: number;
  spend: number;
}

/** One stratum of an arm (a client in a month): the same three counts. */
export interface StratumCounts {
  exposure: number;
  outcomes: number;
  spend: number;
}

/** Per arm label, per stratum key (`<org>|<month>`). */
export type Strata = Record<string, Record<string, StratumCounts>>;

export type VerdictKind = "conclusion" | "signal" | "noise";
export interface Verdict {
  kind: VerdictKind;
  reason: string;
  p?: number;
}

const lgamma = (z: number): number => {
  // Lanczos, good to ~1e-13 for z > 0
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = c[0]!;
  for (let i = 1; i < g + 2; i++) x += c[i]! / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
};

/**
 * Two arms, outcomes over an exposure: given the total, the arm an outcome lands on is binomial with that arm's
 * share of the exposure if both share one rate. Exact two-sided p-value.
 */
export function exactP(xa: number, ea: number, xb: number, eb: number): number {
  const n = Math.round(xa + xb);
  if (n === 0 || ea <= 0 || eb <= 0) return 1;
  const q = ea / (ea + eb);
  const logP = (k: number) => lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1) + k * Math.log(q) + (n - k) * Math.log(1 - q);
  const obs = logP(Math.round(xa));
  let p = 0;
  for (let k = 0; k <= n; k++) {
    const lk = logP(k);
    if (lk <= obs + 1e-9) p += Math.exp(lk);
  }
  return Math.min(1, p);
}

/** Exact 95% Poisson interval on a count, by bisection on the cumulative distribution. */
export function poissonInterval(k: number): [number, number] {
  const cdf = (x: number, l: number) => {
    let t = Math.exp(-l);
    let s = t;
    for (let i = 1; i <= x; i++) {
      t *= l / i;
      s += t;
    }
    return s;
  };
  const solve = (f: (l: number) => number, target: number) => {
    let lo = 0;
    let hi = k * 5 + 20;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) > target) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  return [k === 0 ? 0 : solve((l) => cdf(k - 1, l), 0.975), solve((l) => cdf(k, l), 0.025)];
}

interface RatioCi {
  ratio: number;
  lo: number;
  hi: number;
}

export interface LikeForLike {
  a: { exposure: number; outcomes: number; spend: number; strata: number };
  b: { exposure: number; outcomes: number; spend: number; strata: number };
  /** Outcomes per unit of exposure, a against b (Mantel-Haenszel, Greenland-Robins 95% interval). */
  rate: RatioCi | null;
  /** Cost per outcome, a against b: the inverse of the per-dollar ratio. */
  cost: RatioCi | null;
}

/**
 * Two arms on the SAME client in the SAME month only, so a client mix cannot pass for an arm effect. `pairs` is one
 * entry per stratum both arms ran in. Two Mantel-Haenszel rate ratios, each with a 95% Greenland-Robins interval:
 * outcomes per unit of exposure, and outcomes per DOLLAR; the cost ratio is the inverse of the second (never the
 * crude price ratio divided by the pooled rate ratio: the two carry different weights).
 */
export function likeForLike(pairs: ReadonlyArray<readonly [StratumCounts, StratumCounts]>): LikeForLike {
  let num = 0;
  let den = 0;
  let v = 0;
  let numS = 0;
  let denS = 0;
  let vS = 0;
  const a = { exposure: 0, outcomes: 0, spend: 0, strata: pairs.length };
  const b = { exposure: 0, outcomes: 0, spend: 0, strata: pairs.length };
  for (const [x, y] of pairs) {
    const T = x.exposure + y.exposure;
    if (T > 0) {
      num += (x.outcomes * y.exposure) / T;
      den += (y.outcomes * x.exposure) / T;
      v += (x.exposure * y.exposure * (x.outcomes + y.outcomes)) / (T * T);
    }
    const S = x.spend + y.spend;
    if (S > 0) {
      numS += (x.outcomes * y.spend) / S;
      denS += (y.outcomes * x.spend) / S;
      vS += (x.spend * y.spend * (x.outcomes + y.outcomes)) / (S * S);
    }
    for (const [acc, s] of [
      [a, x],
      [b, y],
    ] as const) {
      acc.exposure += s.exposure;
      acc.outcomes += s.outcomes;
      acc.spend += s.spend;
    }
  }
  const ci = (n: number, d: number, va: number): RatioCi => {
    const r = n / d;
    const se = Math.sqrt(va / (n * d));
    return { ratio: r, lo: r * Math.exp(-1.96 * se), hi: r * Math.exp(1.96 * se) };
  };
  if (!num || !den) return { a, b, rate: null, cost: null };
  const rate = ci(num, den, v);
  const perDollar = numS && denS ? ci(numS, denS, vS) : null;
  return { a, b, rate, cost: perDollar ? { ratio: 1 / perDollar.ratio, lo: 1 / perDollar.hi, hi: 1 / perDollar.lo } : null };
}

/** The strata two arms share. */
export function sharedPairs(
  armA: Readonly<Record<string, StratumCounts>> | undefined,
  armB: Readonly<Record<string, StratumCounts>> | undefined,
): Array<[StratumCounts, StratumCounts]> {
  const out: Array<[StratumCounts, StratumCounts]> = [];
  for (const [k, x] of Object.entries(armA ?? {})) {
    const y = armB?.[k];
    if (!y) continue;
    out.push([x, y]);
  }
  return out;
}

/** The like-for-like ratio's p-value, read off its 95% interval (log scale, normal). */
function pOfInterval(ci: RatioCi | null): number {
  if (!ci) return 1;
  const se = (Math.log(ci.hi) - Math.log(ci.lo)) / (2 * 1.96);
  if (!(se > 0)) return 1;
  const z = Math.abs(Math.log(ci.ratio)) / se;
  const t = 1 / (1 + 0.2316419 * z);
  const tail =
    (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return Math.min(1, 2 * tail);
}

export const pText = (p: number): string => (p < 0.001 ? "< 0.001" : p.toFixed(3));
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export interface CompareInput {
  a: Arm | null;
  b: Arm | null;
  goal: "rate" | "roi";
  /** How many other buckets the leader was ranked against (Bonferroni). */
  comparisons: number;
  /**
   * Per-arm strata keyed on the arm LABEL. `null` = the same-clients check cannot run on this read (a pipe whose
   * evidence is not split by client and month): the verdict says so, never "they never ran for the same client".
   */
  strata: Strata | null;
  noun: string;
  nouns: string;
  /** Both arms are the SAME people (the follow-ups against the first email): no client mix to rule out. */
  splitTest?: boolean;
  /** Names the exposure when it is not people ("per person with a positive reply"). */
  per?: string;
}

/** Leader against runner-up on a categorical cut. */
export function compareVerdict({ a, b, goal, comparisons, strata, noun, nouns, splitTest = false, per: perText }: CompareInput): Verdict {
  if (!a) return { kind: "noise", reason: `No ${nouns} yet.` };
  if (!b) return { kind: "noise", reason: `Only one side has sent anything: nothing to compare.` };
  if (a.outcomes < MIN_OUTCOMES) {
    return {
      kind: "noise",
      reason: `${a.label} rests on ${plural(a.outcomes, noun, nouns)}; a lead needs at least ${MIN_OUTCOMES} before chance stops dominating.`,
    };
  }
  const ea = goal === "roi" ? a.spend : a.exposure;
  const eb = goal === "roi" ? b.spend : b.exposure;
  const p = exactP(a.outcomes, ea, b.outcomes, eb);
  const m = Math.max(1, comparisons);
  const alpha = ALPHA / m;
  const per = perText ?? (goal === "roi" ? "per dollar" : "per person emailed");
  const vs = `${a.label} against ${b.label}, ${nouns} ${per}`;
  const corr = m > 1 ? ` (${m} comparisons, so the bar is p < ${pText(alpha)})` : "";
  if (p >= ALPHA) return { kind: "noise", reason: `${vs}: p ${pText(p)}, a gap chance alone produces often.`, p };
  if (splitTest) {
    return p < alpha
      ? { kind: "conclusion", reason: `${vs}: p ${pText(p)}${corr}, on the same people.`, p }
      : { kind: "signal", reason: `${vs}: p ${pText(p)}, but not under the corrected bar${corr}.`, p };
  }
  if (p >= alpha) return { kind: "signal", reason: `${vs}: p ${pText(p)}, but not under the corrected bar${corr}.`, p };
  if (strata === null) {
    return { kind: "signal", reason: `${vs}: p ${pText(p)}${corr}, but this pipe's evidence is not split by client and month yet, so the same-clients check cannot run.`, p };
  }
  const pairs = sharedPairs(strata[a.label], strata[b.label]);
  if (!pairs.length) {
    return { kind: "signal", reason: `${vs}: p ${pText(p)}${corr}, but the two never ran for the same client in the same month, so the gap may be the clients'.`, p };
  }
  const lfl = likeForLike(pairs);
  const ci = goal === "roi" ? (lfl.cost ? { ratio: 1 / lfl.cost.ratio, lo: 1 / lfl.cost.hi, hi: 1 / lfl.cost.lo } : null) : lfl.rate;
  const pl = pOfInterval(ci);
  const same = ci !== null && ci.ratio > 1;
  if (same && pl < alpha) {
    return { kind: "conclusion", reason: `${vs}: p ${pText(p)}${corr}, and it holds on the same clients in the same months (${ci.ratio.toFixed(2)}x, p ${pText(pl)}).`, p };
  }
  return {
    kind: "signal",
    reason: `${vs}: p ${pText(p)}${corr}, but on the same clients in the same months it reads ${ci ? `${ci.ratio.toFixed(2)}x (p ${pText(pl)})` : "too few to compare"}: the gap may be the clients'.`,
    p,
  };
}

/** The headline's verb follows the word: a conclusion "wins", anything else only "leads". */
export function headlineFor(headline: string, kind: VerdictKind): string {
  if (kind === "conclusion") return headline;
  const led = headline.replace(/ wins( at| with|:)/, " leads$1");
  return `${led} ${kind === "signal" ? "A signal to confirm, not yet a conclusion." : "Noise so far."}`;
}

// Abramowitz and Stegun 7.1.26.
const erf = (x: number): number => {
  const sg = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  return sg * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
};

/** Two-proportion z-test on outcomes over exposure, two-sided. */
export function rateP(a: StratumCounts, b: StratumCounts): number {
  const pool = (a.outcomes + b.outcomes) / (a.exposure + b.exposure);
  const se = Math.sqrt(pool * (1 - pool) * (1 / a.exposure + 1 / b.exposure));
  if (!(se > 0)) return 1;
  const z = (a.outcomes / a.exposure - b.outcomes / b.exposure) / se;
  return 1 - erf(Math.abs(z) / Math.SQRT2);
}

/** Outcomes per dollar: exact two-sided binomial on the spend shares. */
export function costP(a: StratumCounts, b: StratumCounts): number {
  return exactP(a.outcomes, a.spend, b.outcomes, b.spend);
}

/** A p-value as the naming study prints it. */
export const pTextShort = (pv: number): string => (pv < 0.001 ? "< 0.001" : pv.toFixed(pv < 0.01 ? 3 : 2));
