/**
 * ESTIMATED RATE AND COST PER OUTCOME, young cohorts included (owner 2026-10-23, COST-ACCOUNTING-1023-P3). Pure.
 *
 * Served BESIDE the maturity rule (`lib/maturity.ts`), never in its place: the measured figures and every order stay
 * the mature/flash ones until the owner approves a replay.
 *
 * Two classic corrections, both standard in conversion analytics:
 *  1. CENSORING. A person emailed 3 days ago has not had the time to reply: of all first positive replies, only F(3)
 *     arrive within 3 days (F = the fleet's own delay curve, lead-service's time-to-first-positive-reply bins). So a
 *     person of age a counts for F(a) of a person in the denominator (effective exposure, the actuarial estimator):
 *     rate = replies ÷ Σ F(age). A mature cohort (F = 1) reads its plain rate; nothing is thrown away.
 *  2. SMALL SAMPLES. A workflow with 40 people and 0 replies is not a 0% workflow. Each workflow's rate is drawn
 *     toward the pipe's (empirical Bayes, Beta-Binomial): prior Beta(α, β) fitted on every workflow of the pipe by
 *     maximum marginal likelihood, posterior Beta(α + replies, β + exposure − replies), mean + 95% interval.
 *
 * Cost per outcome = spend ÷ (people contacted × rate): the expected eventual outcomes the spend bought.
 */

/** PURE. The share of eventual first positive replies arrived within `ageDays`, from day bins (Day 1..21, then 21+). */
export function lagCurveOf(dayBins: ReadonlyArray<{ count: number }>, tailDays = 60): (ageDays: number) => number {
  const total = dayBins.reduce((a, b) => a + b.count, 0);
  if (total <= 0) return () => 1;
  const cum: number[] = [];
  let run = 0;
  // every bin but the open last one is one day: cum[d] = share within d+1 days
  for (let i = 0; i < dayBins.length - 1; i++) {
    run += dayBins[i]!.count;
    cum.push(run / total);
  }
  const lastClosed = cum.length; // days covered by closed bins
  const atLast = cum[lastClosed - 1] ?? 0;
  return (ageDays: number) => {
    if (ageDays <= 0) return 0;
    if (ageDays <= lastClosed) {
      const d = Math.floor(ageDays);
      const lo = d === 0 ? 0 : cum[d - 1]!;
      const hi = cum[Math.min(d, lastClosed - 1)]!;
      return lo + (hi - lo) * (ageDays - d);
    }
    // the open tail: linear from the last closed day to 1 at `tailDays`
    if (ageDays >= tailDays) return 1;
    return atLast + (1 - atLast) * ((ageDays - lastClosed) / (tailDays - lastClosed));
  };
}

export interface CohortSlice {
  /** People served that day. */
  contacted: number;
  /** Days since the serve, at the read. */
  ageDays: number;
}

/** PURE. Effective exposure: each person counts for the share of eventual outcomes already due at their age. */
export function effectiveExposure(slices: readonly CohortSlice[], F: (ageDays: number) => number): number {
  return slices.reduce((a, s) => a + s.contacted * F(s.ageDays), 0);
}

export interface GroupEvidence {
  key: string;
  outcomes: number;
  exposure: number;
  contacted: number;
  spendUsd: number;
}

/**
 * PURE. The pipe's Beta prior, empirical Bayes: mean = the pooled rate, strength (α + β) = the value maximizing the
 * marginal Beta-Binomial likelihood of every group (grid on log strength, 2..10,000). Fewer than two groups with
 * exposure = a weak prior (strength 2) on the pooled rate.
 */
export function fitBetaPrior(groups: readonly GroupEvidence[]): { alpha: number; beta: number } {
  const g = groups.filter((x) => x.exposure > 0);
  const E = g.reduce((a, x) => a + x.exposure, 0);
  const Y = g.reduce((a, x) => a + x.outcomes, 0);
  const m = E > 0 ? Math.min(Math.max(Y / E, 1e-6), 1 - 1e-6) : 0.01;
  if (g.length < 2) return { alpha: m * 2, beta: (1 - m) * 2 };
  const lnB = (a: number, b: number) => lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const logLik = (strength: number) => {
    const a = m * strength;
    const b = (1 - m) * strength;
    return g.reduce((acc, x) => acc + lnB(a + x.outcomes, b + Math.max(x.exposure - x.outcomes, 0)) - lnB(a, b), 0);
  };
  let best = 2;
  let bestLl = -Infinity;
  for (let i = 0; i <= 200; i++) {
    const strength = Math.exp(Math.log(2) + (i / 200) * (Math.log(10_000) - Math.log(2)));
    const ll = logLik(strength);
    if (ll > bestLl) {
      bestLl = ll;
      best = strength;
    }
  }
  return { alpha: m * best, beta: (1 - m) * best };
}

// Regularized incomplete beta I_x(a, b) (Numerical Recipes continued fraction).
const lnGamma = (z: number): number => {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z;
  let y = z;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const k of c) ser += k / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
};
const betacf = (a: number, b: number, x: number): number => {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-300) d = 1e-300;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
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
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
};
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** PURE. The p-quantile of Beta(a, b) (bisection on the incomplete beta). */
export function betaQuantile(p: number, a: number, b: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (incompleteBeta(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface OutcomeEstimate {
  key: string;
  /** Estimated eventual rate per person contacted, percent, with its 95% interval. */
  ratePct: number;
  rateLowPct: number;
  rateHighPct: number;
  /** spend ÷ (contacted × rate), with the interval inverted (a high rate = a low cost). Null without spend or people. */
  costPerOutcomeUsd: number | null;
  costLowUsd: number | null;
  costHighUsd: number | null;
  /** Inputs, stated. */
  outcomes: number;
  contacted: number;
  exposure: number;
}

/** PURE. Every group's posterior. */
export function estimateOutcomes(groups: readonly GroupEvidence[]): { prior: { alpha: number; beta: number }; estimates: OutcomeEstimate[] } {
  const prior = fitBetaPrior(groups);
  const estimates = groups.map((g) => {
    const a = prior.alpha + g.outcomes;
    const b = prior.beta + Math.max(g.exposure - g.outcomes, 0);
    const mean = a / (a + b);
    const low = betaQuantile(0.025, a, b);
    const high = betaQuantile(0.975, a, b);
    const cost = (r: number) => (g.spendUsd > 0 && g.contacted > 0 && r > 0 ? g.spendUsd / (g.contacted * r) : null);
    return {
      key: g.key,
      ratePct: 100 * mean,
      rateLowPct: 100 * low,
      rateHighPct: 100 * high,
      costPerOutcomeUsd: cost(mean),
      costLowUsd: cost(high),
      costHighUsd: cost(low),
      outcomes: g.outcomes,
      contacted: g.contacted,
      exposure: g.exposure,
    };
  });
  return { prior, estimates };
}
