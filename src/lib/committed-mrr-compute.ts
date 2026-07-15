/**
 * Pure assembly of the COMMITTED-MRR-over-time series (monthly + weekly), the point-in-time run-rate twin
 * of the realized-revenue history. Committed MRR = the fleet's currently-active daily budget × 30 (what
 * we are CONTRACTED to bill); ARR = MRR × 12.
 *
 * Distinct from the realized series (summed actualized spend): committed MRR is a SNAPSHOT that cannot be
 * reconstructed from spend, so each period's point comes from a REAL recorded daily snapshot — the LAST
 * snapshot within the period (its end-of-period run-rate). The CURRENT (in-progress) period's point is the
 * LIVE `currentMrrUsd` (the accounts-audit fleet MRR), so the most-recent point RECONCILES exactly with the
 * `currentMrrUsd` the accounts audit reports (AC). A period with NO recorded snapshot is OMITTED — never a
 * fabricated / carried-forward point (only real snapshots). Growth is point-over-point vs the previous
 * EMITTED period. The series legitimately starts at the first recorded snapshot and lengthens each day.
 */
import { bucketOf, enumerateBuckets } from "./active-users-compute.js";

/** ARR = MRR × 12 (annualized calendar-month run-rate). */
export const ARR_MONTH_MULTIPLE = 12;

/** Round a USD amount to 2 decimals, FP-safe. */
function usd2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface CommittedMrrBucket {
  /** Bucket label: `YYYY-MM` (month) or `YYYY-Www` ISO week. */
  period: string;
  /** UTC start date of the bucket (`YYYY-MM-DD`): the month's 1st or the ISO week's Monday. For charting. */
  periodStart: string;
  /** Committed MRR as of this period (last recorded snapshot in the period; live value for the current period), USD. */
  mrrUsd: number;
  /** Committed ARR = mrrUsd × 12, USD (2-decimal). */
  arrUsd: number;
  /** Point-over-point growth vs the previous EMITTED bucket, in percent (1-decimal). null on the first bucket or a 0 base. */
  growthPct: number | null;
}

export interface CommittedMrrHistory {
  /** LIVE committed MRR — fleet active daily budget × 30 (the accounts-audit verdict). The current-period point equals this. */
  currentMrrUsd: number;
  /** LIVE committed ARR = currentMrrUsd × 12. */
  currentArrUsd: number;
  monthly: CommittedMrrBucket[];
  weekly: CommittedMrrBucket[];
}

/**
 * Bucketize snapshots at a granularity: each period's point = the LAST snapshot in that period; the CURRENT
 * period's point = the live `currentMrrUsd` (reconciles with the accounts audit). Periods with no real
 * snapshot are OMITTED (no fabrication). Growth is vs the previous emitted bucket. Pure.
 */
export function bucketizeCommitted(
  snapshots: Array<{ date: string; mrrUsd: number }>,
  buckets: Array<{ period: string; periodStart: string }>,
  g: "week" | "month",
  currentPeriodStart: string,
  currentMrrUsd: number,
): CommittedMrrBucket[] {
  // Last snapshot (by date) per period → its end-of-period run-rate.
  const lastByPeriod = new Map<string, { date: string; mrrUsd: number }>();
  for (const s of snapshots) {
    const ps = bucketOf(s.date, g).periodStart;
    const prev = lastByPeriod.get(ps);
    if (!prev || s.date > prev.date) lastByPeriod.set(ps, s);
  }

  const emitted: CommittedMrrBucket[] = [];
  for (const b of buckets) {
    let mrr: number | undefined;
    if (b.periodStart === currentPeriodStart) {
      mrr = currentMrrUsd; // live run-rate — the reconciling point
    } else {
      const hit = lastByPeriod.get(b.periodStart);
      if (hit) mrr = hit.mrrUsd;
    }
    if (mrr === undefined) continue; // no real snapshot in this period → omit (only real recorded points)

    const prevMrr = emitted.length ? emitted[emitted.length - 1].mrrUsd : null;
    const growthPct = prevMrr !== null && prevMrr > 0 ? Math.round(((mrr - prevMrr) / prevMrr) * 1000) / 10 : null;
    emitted.push({ period: b.period, periodStart: b.periodStart, mrrUsd: usd2(mrr), arrUsd: usd2(mrr * ARR_MONTH_MULTIPLE), growthPct });
  }
  return emitted;
}

/**
 * Build the committed MRR/ARR history (monthly + weekly) from recorded snapshots + the live current MRR.
 * The current period always emits (its point is the live value); past periods emit only when a real
 * snapshot fell in them. Pure.
 */
export function buildCommittedMrrHistory(
  snapshots: Array<{ date: string; mrrUsd: number }>,
  currentMrrUsd: number,
  now: Date,
  windows: { weeks: number; months: number },
): CommittedMrrHistory {
  const todayIso = now.toISOString().slice(0, 10);
  const monthlyBuckets = enumerateBuckets(todayIso, "month", windows.months);
  const weeklyBuckets = enumerateBuckets(todayIso, "week", windows.weeks);

  return {
    currentMrrUsd: usd2(currentMrrUsd),
    currentArrUsd: usd2(currentMrrUsd * ARR_MONTH_MULTIPLE),
    monthly: bucketizeCommitted(snapshots, monthlyBuckets, "month", bucketOf(todayIso, "month").periodStart, currentMrrUsd),
    weekly: bucketizeCommitted(snapshots, weeklyBuckets, "week", bucketOf(todayIso, "week").periodStart, currentMrrUsd),
  };
}
