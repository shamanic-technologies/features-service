/**
 * BASIS CHANGE 2026-09-29 (owner decision): the recorded MRR is billing-service's RECURRING revenue
 * (recurring orgs only, proactive running campaigns with audience left, DRR × 30), recorded per org in
 * `recurring_mrr_org_snapshots`. Points recorded before that day were the running daily budget × 30
 * (`committed_mrr_snapshots`); they are kept, never restated, and every point says which basis it is on
 * (`basis`), so a chart never mixes the two silently. `basisChangedOn` is the first billing-basis day.
 *
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

/** The basis a recorded MRR point was computed on. */
export type MrrBasis = "running_budget_x30" | "billing_recurring";

/** One recorded day of fleet MRR. `mrrUsd` null = billing's read was unavailable that day. */
export interface MrrSnapshot {
  date: string;
  mrrUsd: number | null;
  /** Absent = a legacy `committed_mrr_snapshots` point (running budget × 30). */
  basis?: MrrBasis;
  /** Orgs billing could not state that day (billing basis only), never counted as 0. */
  unknownOrgCount?: number;
}

/** Round a USD amount to 2 decimals, FP-safe. */
function usd2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface CommittedMrrBucket {
  /** Bucket label: `YYYY-MM` (month) or `YYYY-Www` ISO week. */
  period: string;
  /** UTC start date of the bucket (`YYYY-MM-DD`): the month's 1st or the ISO week's Monday. For charting. */
  periodStart: string;
  /**
   * Fleet MRR as of this period (last recorded snapshot in the period; live value for the current
   * period), USD. null = billing's recurring revenue was unavailable for that point (never the old
   * computation standing in for it).
   */
  mrrUsd: number | null;
  /** ARR = mrrUsd × 12, USD (2-decimal). null whenever the MRR is. */
  arrUsd: number | null;
  /** Which basis this point is on — `running_budget_x30` before `basisChangedOn`, `billing_recurring` from it. */
  basis: MrrBasis;
  /** Orgs billing could not state on this point's day, listed beside the sum (0 on the legacy basis). */
  unknownOrgCount: number;
  /** Point-over-point growth vs the previous EMITTED bucket, in percent (1-decimal). null on the first bucket or a 0 base. */
  growthPct: number | null;
}

export interface CommittedMrrHistory {
  /** LIVE fleet MRR — billing's recurring revenue (Σ known orgs). The current-period point equals this. null = billing unavailable. */
  currentMrrUsd: number | null;
  /** LIVE ARR = currentMrrUsd × 12. */
  currentArrUsd: number | null;
  /** First UTC day recorded on the billing basis; every point before it is `running_budget_x30`. null = none recorded yet. */
  basisChangedOn: string | null;
  monthly: CommittedMrrBucket[];
  weekly: CommittedMrrBucket[];
}

/**
 * Bucketize snapshots at a granularity: each period's point = the LAST snapshot in that period; the CURRENT
 * period's point = the live `currentMrrUsd` (reconciles with the accounts audit). Periods with no real
 * snapshot are OMITTED (no fabrication). Growth is vs the previous emitted bucket. Pure.
 */
export interface CommittedPoint {
  /** Fleet MRR in force for the period, USD. null = unavailable on that point. */
  mrrUsd: number | null;
  basis: MrrBasis;
  unknownOrgCount: number;
  /**
   * The UTC day this point was READ AS OF — the date of the last snapshot in the period, or today for
   * the current (in-progress) period. Anything computed ALONGSIDE a committed point (the agency /
   * self-serve split) must use this SAME date, or the two series would describe two different moments
   * and stop reconciling.
   */
  referenceDate: string;
}

/**
 * The committed point per emitted period, keyed on `periodStart`: the LAST snapshot in the period (its
 * end-of-period run-rate), except the CURRENT period which takes the live `currentMrrUsd` so the newest
 * point reconciles exactly with the accounts audit. A period with NO real snapshot is ABSENT from the
 * map — never a fabricated or carried-forward point. Shared by the committed series and the
 * agency/self-serve split so the two emit the SAME periods against the SAME dates. Pure.
 */
export function committedPointsByPeriod(
  snapshots: MrrSnapshot[],
  buckets: Array<{ period: string; periodStart: string }>,
  g: "week" | "month",
  currentPeriodStart: string,
  current: { mrrUsd: number | null; unknownOrgCount: number },
  todayIso: string,
): Map<string, CommittedPoint> {
  // Last snapshot (by date) per period → its end-of-period run-rate.
  const lastByPeriod = new Map<string, MrrSnapshot>();
  for (const s of snapshots) {
    const ps = bucketOf(s.date, g).periodStart;
    const prev = lastByPeriod.get(ps);
    if (!prev || s.date > prev.date) lastByPeriod.set(ps, s);
  }

  const points = new Map<string, CommittedPoint>();
  for (const b of buckets) {
    if (b.periodStart === currentPeriodStart) {
      points.set(b.periodStart, {
        mrrUsd: current.mrrUsd,
        basis: "billing_recurring",
        unknownOrgCount: current.unknownOrgCount,
        referenceDate: todayIso,
      }); // live run-rate — the reconciling point
      continue;
    }
    const hit = lastByPeriod.get(b.periodStart);
    if (hit) {
      points.set(b.periodStart, {
        mrrUsd: hit.mrrUsd,
        basis: hit.basis ?? "running_budget_x30",
        unknownOrgCount: hit.unknownOrgCount ?? 0,
        referenceDate: hit.date,
      });
    }
  }
  return points;
}

/**
 * Bucketize snapshots at a granularity: each period's point = the LAST snapshot in that period; the CURRENT
 * period's point = the live `currentMrrUsd` (reconciles with the accounts audit). Periods with no real
 * snapshot are OMITTED (no fabrication). Growth is vs the previous emitted bucket. Pure.
 */
export function bucketizeCommitted(
  snapshots: MrrSnapshot[],
  buckets: Array<{ period: string; periodStart: string }>,
  g: "week" | "month",
  currentPeriodStart: string,
  current: { mrrUsd: number | null; unknownOrgCount: number },
  todayIso: string = currentPeriodStart,
): CommittedMrrBucket[] {
  const points = committedPointsByPeriod(snapshots, buckets, g, currentPeriodStart, current, todayIso);

  const emitted: CommittedMrrBucket[] = [];
  for (const b of buckets) {
    const point = points.get(b.periodStart);
    if (!point) continue; // no real snapshot in this period → omit (only real recorded points)
    const mrr = point.mrrUsd;
    // Growth only against the previous point on the SAME basis and with a value — a basis change is
    // not growth, and an unavailable point is not a zero.
    const prev = emitted.length ? emitted[emitted.length - 1] : null;
    const prevMrr = prev && prev.basis === point.basis ? prev.mrrUsd : null;
    const growthPct =
      mrr !== null && prevMrr !== null && prevMrr > 0 ? Math.round(((mrr - prevMrr) / prevMrr) * 1000) / 10 : null;
    emitted.push({
      period: b.period,
      periodStart: b.periodStart,
      mrrUsd: mrr === null ? null : usd2(mrr),
      arrUsd: mrr === null ? null : usd2(mrr * ARR_MONTH_MULTIPLE),
      basis: point.basis,
      unknownOrgCount: point.unknownOrgCount,
      growthPct,
    });
  }
  return emitted;
}

/**
 * Build the committed MRR/ARR history (monthly + weekly) from recorded snapshots + the live current MRR.
 * The current period always emits (its point is the live value); past periods emit only when a real
 * snapshot fell in them. Pure.
 */
export function buildCommittedMrrHistory(
  snapshots: MrrSnapshot[],
  current: { mrrUsd: number | null; unknownOrgCount: number },
  now: Date,
  windows: { weeks: number; months: number },
  basisChangedOn: string | null = null,
): CommittedMrrHistory {
  const todayIso = now.toISOString().slice(0, 10);
  const monthlyBuckets = enumerateBuckets(todayIso, "month", windows.months);
  const weeklyBuckets = enumerateBuckets(todayIso, "week", windows.weeks);
  const m = current.mrrUsd;

  return {
    currentMrrUsd: m === null ? null : usd2(m),
    currentArrUsd: m === null ? null : usd2(m * ARR_MONTH_MULTIPLE),
    basisChangedOn,
    monthly: bucketizeCommitted(snapshots, monthlyBuckets, "month", bucketOf(todayIso, "month").periodStart, current, todayIso),
    weekly: bucketizeCommitted(snapshots, weeklyBuckets, "week", bucketOf(todayIso, "week").periodStart, current, todayIso),
  };
}

/**
 * Merge the two recorded bases into one snapshot list: the legacy running-budget points strictly
 * BEFORE the first billing-basis day, the billing-basis points from it on. Never two points for one
 * day, never a legacy point after the switch. Pure.
 */
export function mergeMrrSnapshots(
  legacy: Array<{ date: string; mrrUsd: number }>,
  billing: MrrSnapshot[],
): { snapshots: MrrSnapshot[]; basisChangedOn: string | null } {
  const basisChangedOn = billing.length ? billing.map((b) => b.date).reduce((a, b) => (a < b ? a : b)) : null;
  const old = legacy
    .filter((l) => basisChangedOn === null || l.date < basisChangedOn)
    .map((l): MrrSnapshot => ({ date: l.date, mrrUsd: l.mrrUsd, basis: "running_budget_x30", unknownOrgCount: 0 }));
  return { snapshots: [...old, ...billing].sort((a, b) => (a.date < b.date ? -1 : 1)), basisChangedOn };
}
