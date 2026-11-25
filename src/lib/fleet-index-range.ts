/**
 * PURE. The LIKELY RANGE of a public fleet index value (owner 2026-11-25, INDEX-RANGE-1125): the 20th and 80th
 * percentile of how uncertain the value is, from the counts it is built on, same unit and basis as the value.
 *
 * Method (one rule per kind of value, all Bayesian with the Jeffreys prior, the standard non-informative prior for a
 * count or a proportion):
 * - a cost per outcome (spend ÷ outcomes): the outcomes are a Poisson count k; the expected count behind the spend is
 *   Gamma(k + 1/2, 1) (Jeffreys); the value's range = value × k ÷ the 80th / 20th percentile of that Gamma.
 * - a conversion rate (outcomes ÷ people emailed): the Jeffreys interval (Brown, Cai & DasGupta 2001, "Interval
 *   Estimation for a Binomial Proportion"): Beta(k + 1/2, n - k + 1/2), lower bound 0 when k = 0, upper 100 when k = n.
 * - a chained meeting index (interest cost ÷ booking rate + cost per meeting, or interest rate × booking rate): 4,000
 *   draws of each count's posterior (the same Gamma), propagated through the formula; seeded on the index and the day so
 *   a value never flickers.
 * - the client median (cost per engaged lead): a bootstrap of the median (Efron 1979) over the clients, each client's
 *   cost drawn from its own Gamma; computed when the point is recorded (the per-client figures are not stored), so a day
 *   recorded before this rule carries none.
 * Clamped so low <= value <= high. No range around an EXPECTED value (a quoted price, not a measurement) nor a null one.
 */

export const RANGE_LOW_PERCENTILE = 20;
export const RANGE_HIGH_PERCENTILE = 80;
const DRAWS = 4000;

export const RANGE_RULE_TEXT =
  "The likely range is the 20th to 80th percentile of the value's uncertainty, from the outcomes and people emailed it is built on: the fewer the outcomes, the wider the range.";

export interface ValueRange {
  low: number;
  high: number;
}

export interface RangeVerdict {
  valueRange: ValueRange | null;
  /** Why no range: `no_value`, `expected_value`, `no_outcome`, `people_emailed_not_counted`, `inputs_not_recorded`, `range_not_recorded_that_day`. */
  valueRangeUnavailableReason: string | null;
}

/** The fields of a stored index point the range is read from. */
export interface RangePointInput {
  indexSlug: string;
  day: string | null;
  metric: "cost_per_outcome" | "conversion_rate";
  outcome: string;
  value: number | null;
  outcomes: number;
  contacted: number | null;
  inputs: Record<string, unknown> | null | undefined;
}

// ── numerics ────────────────────────────────────────────────────────────────

function lnGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const ci of c) ser += ci / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Regularized lower incomplete gamma P(a, x) (Numerical Recipes gammp). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const gln = lnGamma(a);
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 500; n++) {
      del *= x / ++ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
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
  return 1 - Math.exp(-x + a * Math.log(x) - gln) * h;
}

function betacf(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-300) d = 1e-300;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b) (Numerical Recipes betai). */
export function betaI(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

function bisect(cdf: (x: number) => number, p: number, lo: number, hi: number): number {
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < p) lo = mid;
    else hi = mid;
    if (hi - lo <= 1e-12 * Math.max(1, hi)) break;
  }
  return (lo + hi) / 2;
}

/** The p-quantile of Gamma(shape, 1). */
export function gammaQuantile(shape: number, p: number): number {
  let hi = shape + 10 * Math.sqrt(shape) + 10;
  while (gammaP(shape, hi) < p) hi *= 2;
  return bisect((x) => gammaP(shape, x), p, 0, hi);
}

/** The p-quantile of Beta(a, b). */
export function betaQuantile(a: number, b: number, p: number): number {
  return bisect((x) => betaI(a, b, x), p, 0, 1);
}

/** Seeded uniform draws (mulberry32 over a string hash): the same index and day always draw the same. */
function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297;
  };
}

function normal(u: () => number): number {
  return Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/** One draw of Gamma(shape, 1) (Marsaglia & Tsang 2000; shape < 1 boosted). */
function gammaDraw(shape: number, u: () => number): number {
  if (shape < 1) return gammaDraw(shape + 1, u) * Math.pow(u(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(u);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const w = u();
    if (w < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(w) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function quantileOfSorted(sorted: number[], p: number): number {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function clamp(value: number, low: number, high: number): ValueRange {
  return { low: Math.min(low, value), high: Math.max(high, value) };
}

function fromDraws(value: number, draws: number[]): ValueRange {
  const finite = draws.filter((d) => Number.isFinite(d)).sort((a, b) => a - b);
  return clamp(value, quantileOfSorted(finite, RANGE_LOW_PERCENTILE / 100), quantileOfSorted(finite, RANGE_HIGH_PERCENTILE / 100));
}

// ── ranges per kind of value ────────────────────────────────────────────────

/** Cost per outcome = spend ÷ k outcomes: the Jeffreys Gamma posterior of the count. k <= 0 = null. */
export function costPerOutcomeRange(value: number, outcomes: number): ValueRange | null {
  if (!(outcomes > 0)) return null;
  const shape = outcomes + 0.5;
  return clamp(value, (value * outcomes) / gammaQuantile(shape, RANGE_HIGH_PERCENTILE / 100), (value * outcomes) / gammaQuantile(shape, RANGE_LOW_PERCENTILE / 100));
}

/** Conversion rate in percent = 100 × k ÷ n: the Jeffreys interval. n <= 0 or k > n = null. */
export function conversionRateRange(valuePct: number, outcomes: number, contacted: number): ValueRange | null {
  if (!(contacted > 0) || outcomes < 0 || outcomes > contacted) return null;
  const a = outcomes + 0.5;
  const b = contacted - outcomes + 0.5;
  const low = outcomes === 0 ? 0 : 100 * betaQuantile(a, b, RANGE_LOW_PERCENTILE / 100);
  const high = outcomes === contacted ? 100 : 100 * betaQuantile(a, b, RANGE_HIGH_PERCENTILE / 100);
  return clamp(valuePct, low, high);
}

function num(inputs: Record<string, unknown>, key: string): number | null {
  const v = inputs[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * A chained meeting index: interest figure (k_i outcomes) chained through the meeting pipe (m meetings of n positive
 * replies acted on, spend S). Draws each count's Gamma posterior; the booking rate = draw ÷ n, capped at 1.
 */
export function meetingChainRange(metric: RangePointInput["metric"], value: number, inputs: Record<string, unknown>, seed: string): ValueRange | null {
  const interest = num(inputs, "interestIndexValue");
  const ki = num(inputs, "interestOutcomes");
  const n = num(inputs, "positiveRepliesActedOn");
  const m = num(inputs, "meetingsBooked");
  const spent = num(inputs, "meetingPipeSpentUsd");
  if (interest === null || ki === null || n === null || m === null || !(ki > 0) || !(n > 0) || !(m > 0)) return null;
  if (metric === "cost_per_outcome" && spent === null) return null;
  const u = rng(seed);
  const draws: number[] = [];
  for (let i = 0; i < DRAWS; i++) {
    const li = gammaDraw(ki + 0.5, u);
    const lm = gammaDraw(m + 0.5, u);
    const rate = Math.min(lm / n, 1);
    draws.push(metric === "cost_per_outcome" ? (interest * ki) / li / rate + (spent as number) / lm : ((interest * li) / ki) * rate);
  }
  return fromDraws(value, draws);
}

/** The client median's range: bootstrap of the median over clients, each client's cost from its own Gamma posterior. */
export function clientMedianRange(value: number, clients: ReadonlyArray<{ engaged: number; spendUsd: number }>, seed: string): ValueRange | null {
  if (clients.length === 0) return null;
  const u = rng(seed);
  const draws: number[] = [];
  const sample = new Array<number>(clients.length);
  for (let i = 0; i < DRAWS; i++) {
    for (let j = 0; j < clients.length; j++) {
      const c = clients[Math.min(clients.length - 1, Math.floor(u() * clients.length))];
      sample[j] = c.spendUsd / gammaDraw(c.engaged + 0.5, u);
    }
    sample.sort((a, b) => a - b);
    const mid = Math.floor(sample.length / 2);
    draws.push(sample.length % 2 === 0 ? (sample[mid - 1] + sample[mid]) / 2 : sample[mid]);
  }
  return fromDraws(value, draws);
}

/** The inputs keys the recorder writes the client median's range under. */
export const CLIENT_RANGE_LOW_KEY = "valueRangeLowUsd";
export const CLIENT_RANGE_HIGH_KEY = "valueRangeHighUsd";

const none = (reason: string): RangeVerdict => ({ valueRange: null, valueRangeUnavailableReason: reason });
const some = (r: ValueRange | null, reason: string): RangeVerdict => (r ? { valueRange: r, valueRangeUnavailableReason: null } : none(reason));

/** PURE. The range served beside one stored index point (the list's latest day or one day of a series). */
export function indexValueRange(p: RangePointInput): RangeVerdict {
  if (p.value === null || !Number.isFinite(p.value)) return none("no_value");
  const inputs = (p.inputs ?? {}) as Record<string, unknown>;
  if (inputs.valueKind === "expected") return none("expected_value");
  if (p.outcome === "engaged_lead") {
    const low = num(inputs, CLIENT_RANGE_LOW_KEY);
    const high = num(inputs, CLIENT_RANGE_HIGH_KEY);
    return low === null || high === null ? none("range_not_recorded_that_day") : some(clamp(p.value, low, high), "range_not_recorded_that_day");
  }
  const seed = `${p.indexSlug}|${p.day ?? ""}`;
  if (typeof inputs.formula === "string" && inputs.formula.startsWith("interest_")) {
    return some(meetingChainRange(p.metric, p.value, inputs, seed), "inputs_not_recorded");
  }
  if (p.metric === "cost_per_outcome") return some(costPerOutcomeRange(p.value, p.outcomes), "no_outcome");
  if (p.contacted === null) return none("people_emailed_not_counted");
  return some(conversionRateRange(p.value, p.outcomes, p.contacted), "no_outcome");
}
