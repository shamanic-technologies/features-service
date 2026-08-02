/**
 * NET REVENUE RETENTION (NRR / NDR) over time — the retention twin of the realized-revenue series on
 * `GET /internal/stats/revenue`. Investors ask for this number first; a non-standard NRR is worse than
 * none, so this implements the definition every benchmark source (Stripe, SaaS Capital, The SaaS CFO,
 * a16z) states verbatim:
 *
 *   NRR(period) = revenue in the period from the customers who had revenue in the PREVIOUS period
 *                 ÷ those same customers' revenue in the previous period,   × 100
 *
 * Three properties are load-bearing and are what make the number comparable to a benchmark:
 *
 *  - **The cohort is FIXED AT THE START of the period.** A customer acquired DURING the period is in
 *    neither the numerator nor the denominator. Including new logos turns NRR into a growth rate and
 *    inflates it — that is the single most common way this metric is served wrong.
 *  - **Expansion, contraction and churn need no extra computation** — they are already what the ratio
 *    measures. An org that spent more lands above 100, one that spent less or stopped lands below.
 *  - **AGGREGATE method** (all existing customers pooled), NOT a per-acquisition-cohort retention curve.
 *    The per-cohort curve is a legitimate but DIFFERENT metric; do not substitute it here.
 *
 * A period with NO prior-period cohort (the very first period, or a gap) has NO retention rate:
 * `retentionPct` is **null** and `cohortSize` is 0. That is deliberately DISTINGUISHABLE from a measured
 * 0% (`cohortSize > 0`, `priorRevenueUsd > 0`, `retainedRevenueUsd == 0`) — "we could not measure this"
 * and "the base shrank to nothing" are different statements and a benchmark reader acts differently on
 * each. NEVER fill an unmeasurable period with a substitute value and NEVER carry the previous period
 * forward across a gap.
 *
 * The revenue basis is the SAME per-org net realized cold-email spend the fleet revenue history already
 * sums (`revenue-history-compute.ts`) — one signal, so the two surfaces on the page reconcile. Per-org
 * resolution is INTERNAL to this computation; only the pooled cohort aggregates are returned.
 *
 * No TTM figure: the first billed day is March 2026, so a trailing-twelve-month NRR today would be
 * assembled from months that do not exist.
 */
import { bucketOf, enumerateBuckets, type Granularity } from "./active-users-compute.js";

export interface NrrBucket {
  /** Bucket label: `YYYY-MM` (month) or `YYYY-Www` ISO week. */
  period: string;
  /** UTC start date of the bucket (`YYYY-MM-DD`) — the month's 1st or the ISO week's Monday. For charting. */
  periodStart: string;
  /**
   * Net revenue retention for this period, in percent (1-decimal). **null when the rate could NOT be
   * measured** (no org had revenue in the previous period) — never 0, never a carried-forward value.
   */
  retentionPct: number | null;
  /** Number of orgs in the fixed start-of-period cohort (orgs with revenue in the PREVIOUS period). 0 ⇒ unmeasurable. */
  cohortSize: number;
  /** The cohort's revenue in the PREVIOUS period (the denominator), USD 2-decimal. */
  priorRevenueUsd: number;
  /** The SAME cohort's revenue in THIS period (the numerator) — excludes every org acquired during the period, USD 2-decimal. */
  retainedRevenueUsd: number;
}

export interface NrrHistory {
  /** NRR by calendar month (oldest→newest), one point per bucket of the monthly revenue series. */
  monthly: NrrBucket[];
  /** NRR by ISO week (oldest→newest), one point per bucket of the weekly revenue series. */
  weekly: NrrBucket[];
}

/** Round a cents amount to USD dollars-and-cents (2 decimals), FP-safe. */
function centsToUsd(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * Collapse the per-org day→cents maps into per-org bucket→cents at a granularity. Days outside every
 * listed bucket are ignored. Pure.
 */
function bucketPerOrg(
  orgDailyCents: Map<string, Map<string, number>>,
  bucketStarts: Set<string>,
  g: Granularity,
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [orgId, days] of orgDailyCents) {
    const perBucket = new Map<string, number>();
    for (const [day, cents] of days) {
      const key = bucketOf(day, g).periodStart;
      if (!bucketStarts.has(key)) continue;
      perBucket.set(key, (perBucket.get(key) ?? 0) + cents);
    }
    if (perBucket.size > 0) out.set(orgId, perBucket);
  }
  return out;
}

/**
 * Build the NRR series for one granularity over the trailing `count` buckets ending at `todayIso`.
 * Enumerates `count + 1` buckets so the OLDEST displayed period still has a real prior period to form
 * its cohort from (the extra bucket is used as a denominator only, never emitted). Pure.
 */
export function buildNrrSeries(
  orgDailyCents: Map<string, Map<string, number>>,
  todayIso: string,
  g: Granularity,
  count: number,
): NrrBucket[] {
  const buckets = enumerateBuckets(todayIso, g, count + 1);
  const perOrg = bucketPerOrg(orgDailyCents, new Set(buckets.map((b) => b.periodStart)), g);

  const out: NrrBucket[] = [];
  for (let i = 1; i < buckets.length; i++) {
    const prevStart = buckets[i - 1].periodStart;
    const curStart = buckets[i].periodStart;

    // Cohort FIXED AT THE START of the period: orgs with revenue in the PREVIOUS period. An org whose
    // first revenue lands in the current period is excluded from BOTH legs by construction.
    let priorCents = 0;
    let retainedCents = 0;
    let cohortSize = 0;
    for (const perBucket of perOrg.values()) {
      const prior = perBucket.get(prevStart) ?? 0;
      if (prior <= 0) continue;
      cohortSize++;
      priorCents += prior;
      retainedCents += perBucket.get(curStart) ?? 0;
    }

    // No prior-period cohort ⇒ the rate is NOT MEASURABLE. null, never 0, never carried forward.
    const retentionPct = cohortSize > 0 && priorCents > 0 ? Math.round((retainedCents / priorCents) * 1000) / 10 : null;

    out.push({
      period: buckets[i].period,
      periodStart: curStart,
      retentionPct,
      cohortSize,
      priorRevenueUsd: centsToUsd(priorCents),
      retainedRevenueUsd: centsToUsd(retainedCents),
    });
  }
  return out;
}

/** Build both NRR grains (monthly + weekly) from the per-org realized-spend maps. Pure. */
export function buildNetRevenueRetention(
  orgDailyCents: Map<string, Map<string, number>>,
  todayIso: string,
  windows: { weeks: number; months: number },
): NrrHistory {
  return {
    monthly: buildNrrSeries(orgDailyCents, todayIso, "month", windows.months),
    weekly: buildNrrSeries(orgDailyCents, todayIso, "week", windows.weeks),
  };
}
