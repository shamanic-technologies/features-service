/**
 * Assembly of the staff-gated `GET /internal/stats/revenue` history — the MONEY twin of
 * `GET /internal/stats/active-users`. Active-users answers "how MANY orgs were active each period";
 * revenue answers "how much MONEY was billed each period" — the exact same per-day ACTUALIZED cold-email
 * spend signal, summed in dollars instead of thresholded to a distinct-org headcount.
 *
 * WHY reconstruct from spend. Realized revenue = the money we actually billed. features-service owns the
 * faithful HISTORICAL signal: per-day ACTUALIZED cold-email spend (runs-service). A day of real billed
 * cold-email spend is realized revenue that day (spend only happens on a non-paused, budgeted, funded
 * brand — the same conditions the accounts "active" verdict checks, observed after the fact). We SUM the
 * per-day actual cold-email spend across all orgs. No fabrication — a day with no billed spend is $0.
 *
 * currentMrr is NOT reconstructed — it is the LIVE accounts-audit MRR (fleet active daily budget × 30),
 * the SAME number the admin page already renders from `/internal/stats/accounts`, so the two tabs
 * reconcile. The last daily point (realized spend so far today) legitimately lags currentMrr / a full
 * day's run-rate — the series is realized activity, currentMrr is the live config run-rate. Aggregate
 * totals only, no per-org rows.
 *
 * The account universe is the SAME source the accounts audit + active-users + send-forecast use:
 * lead-service feature-memberships over the cold-email feature slugs, deduped to distinct orgs. Per-org
 * dated spend is one runs-service call per org (bounded fan-out, capped concurrency). Fail loud on error.
 */
import { fetchFeatureMemberships } from "./feature-memberships-client.js";
import { fetchOrgDailySpendCents } from "./revenue-history-client.js";
import { buildAccountsAudit } from "./accounts-compute.js";
import { mapWithConcurrency } from "./concurrency.js";
import { addUtcDays } from "./send-forecast-compute.js";
import { bucketOf, enumerateBuckets, type Granularity } from "./active-users-compute.js";
import { recordCommittedMrrSnapshotSoft, readCommittedMrrSnapshotsSoft } from "./committed-mrr-store.js";
import { buildCommittedMrrHistory, type CommittedMrrHistory } from "./committed-mrr-compute.js";
import { buildNetRevenueRetention, type NrrHistory } from "./nrr-compute.js";

/** Cap the per-org runs-service fan-out so a cold-Neon sibling is not hit with N sockets at once. */
const ORG_FANOUT_CONCURRENCY = 6;

/**
 * Lower bound for the all-time (since-inception) per-org spend fetch. Well before the product existed, so
 * "total revenue since inception" and the MRR-over-time line capture every billed day. Bounded (product is
 * young), and runs returns only buckets that have data, so this is not an unbounded scan.
 */
const INCEPTION_FLOOR_ISO = "2020-01-01T00:00:00.000Z";

export interface RevenueWindows {
  /** Number of trailing UTC days in the daily series (inclusive of today). */
  days: number;
  /** Number of trailing ISO weeks in the weekly series (inclusive of the current week). */
  weeks: number;
  /** Number of trailing calendar months in the monthly series (inclusive of the current month). */
  months: number;
}

export interface RevenueBucket {
  /** Human/sortable label: `YYYY-MM-DD` (day), `YYYY-Www` ISO week (week), or `YYYY-MM` (month). */
  period: string;
  /** UTC start date of the bucket (`YYYY-MM-DD`) — the day, the week's Monday, or the month's 1st. For charting. */
  periodStart: string;
  /** Realized revenue (summed actual cold-email spend, all orgs) in this bucket, in USD (2-decimal). */
  revenueUsd: number;
  /** Period-over-period growth vs the previous bucket, in percent (1-decimal). null on the first bucket or when the previous bucket is 0. */
  growthPct: number | null;
}

export interface RevenueHistory {
  /** Cumulative realized revenue since inception (all orgs, all time), in USD (2-decimal). */
  totalRevenueUsd: number;
  /** LIVE MRR — fleet active daily budget × 30 (the accounts-audit verdict). Matches the accounts snapshot. */
  currentMrrUsd: number;
  monthly: RevenueBucket[];
  weekly: RevenueBucket[];
  daily: RevenueBucket[];
  /** Per-day realized-revenue series since inception (the "MRR over time" line) — every day from the first billed day to today. */
  sinceInceptionDaily: RevenueBucket[];
  /**
   * COMMITTED MRR/ARR over time (monthly + weekly, each with growth) — the point-in-time run-rate the fleet
   * is CONTRACTED to bill (Σ active daily budget × 30), NOT realized spend. Recorded as daily snapshots
   * going forward; the current-period point equals `currentMrrUsd` (reconciles with the accounts audit),
   * ARR = MRR × 12. Additive + non-breaking to the realized series above; degrades to the current live
   * point only if the snapshot store is unavailable.
   */
  committedMrr: CommittedMrrHistory;
  /**
   * NET REVENUE RETENTION over time (monthly + weekly) — of the money existing customers were spending at
   * the START of a period, how much those SAME customers still spend now (expansion + contraction + churn
   * among them; nothing from customers acquired during the period). Same realized-revenue basis as the
   * series above, so the two reconcile. A period with no prior-period cohort carries `retentionPct: null`
   * (NOT 0, NOT carried forward). Aggregate only — no per-org rows.
   */
  netRevenueRetention: NrrHistory;
  asOf: string;
}

/** Injectable client bundle (defaults to the real clients; overridden in tests). */
export interface RevenueHistoryDeps {
  featureMemberships: (featureSlugsCsv: string) => Promise<Array<{ orgId: string }>>;
  /** Map of UTC day → actual cold-email spend (cents) for the org, since `startedAfterIso`. */
  orgDailySpendCents: (orgId: string, coldEmailSlugsCsv: string, startedAfterIso: string) => Promise<Map<string, number>>;
  /** LIVE fleet committed stats (accounts-audit): MRR (budget × 30), daily budget, active count — all USD. */
  currentFleetStats: (coldEmailSlugsCsv: string, now: Date) => Promise<{ mrrUsd: number; dailyBudgetUsd: number; activeCount: number }>;
  /** Persist today's committed-budget snapshot (fail-soft; recorded going forward, no boot backfill). */
  recordCommittedSnapshot: (dailyBudgetUsd: number, activeCount: number, now: Date) => Promise<void>;
  /** Read committed snapshots on/after a `YYYY-MM-DD` lower bound → {date, mrrUsd} oldest→newest (fail-soft → []). */
  readCommittedSnapshots: (sinceIso: string) => Promise<Array<{ date: string; mrrUsd: number }>>;
}

const REAL_DEPS: RevenueHistoryDeps = {
  featureMemberships: async (csv) => (await fetchFeatureMemberships(csv)).map((m) => ({ orgId: m.orgId })),
  orgDailySpendCents: fetchOrgDailySpendCents,
  currentFleetStats: async (csv, now) => {
    const s = (await buildAccountsAudit(csv, now)).stats;
    return { mrrUsd: s.mrrUsd, dailyBudgetUsd: s.totalDailyBudgetUsd, activeCount: s.activeCount };
  },
  recordCommittedSnapshot: recordCommittedMrrSnapshotSoft,
  readCommittedSnapshots: readCommittedMrrSnapshotsSoft,
};

/** Round a cents amount to whole USD dollars-and-cents (2 decimals), FP-safe. */
function centsToUsd(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * Sum realized revenue per bucket at a granularity, then attach period-over-period growth.
 * `orgDailyCents` maps each org → its day→cents spend map. Only days that fall inside one of `buckets`
 * contribute (days outside the displayed window are ignored). Pure.
 */
export function bucketizeRevenue(
  orgDailyCents: Map<string, Map<string, number>>,
  buckets: Array<{ period: string; periodStart: string }>,
  g: Granularity,
): RevenueBucket[] {
  const tally = new Map<string, number>();
  for (const b of buckets) tally.set(b.periodStart, 0);
  for (const days of orgDailyCents.values()) {
    for (const [day, cents] of days) {
      const key = bucketOf(day, g).periodStart;
      if (tally.has(key)) tally.set(key, tally.get(key)! + cents);
    }
  }

  return buckets.map((b, i) => {
    const revenueCents = tally.get(b.periodStart)!;
    const revenueUsd = centsToUsd(revenueCents);
    let growthPct: number | null = null;
    if (i > 0) {
      const prev = tally.get(buckets[i - 1].periodStart)!;
      if (prev > 0) growthPct = Math.round(((revenueCents - prev) / prev) * 1000) / 10;
    }
    return { period: b.period, periodStart: b.periodStart, revenueUsd, growthPct };
  });
}

/**
 * Build the full revenue history payload. Enumerates the cold-email org universe, fans out one all-time
 * dated-spend read per org (capped), then builds the monthly / weekly / daily trailing series (each with
 * growth), the total-since-inception, the per-day-since-inception line, and reads the LIVE current MRR.
 */
export async function buildRevenueHistory(
  coldEmailSlugsCsv: string,
  now: Date,
  windows: RevenueWindows,
  deps: RevenueHistoryDeps = REAL_DEPS,
): Promise<RevenueHistory> {
  const todayIso = now.toISOString().slice(0, 10);

  const monthlyBuckets = enumerateBuckets(todayIso, "month", windows.months);
  const weeklyBuckets = enumerateBuckets(todayIso, "week", windows.weeks);
  const dailyBuckets = enumerateBuckets(todayIso, "day", windows.days);

  // 1. Enumerate the distinct cold-email org universe (same source as the accounts audit).
  const memberships = coldEmailSlugsCsv ? await deps.featureMemberships(coldEmailSlugsCsv) : [];
  const orgIds = [...new Set(memberships.map((m) => m.orgId))];

  // 2. Per-org ALL-TIME daily-spend map (capped fan-out) + the live fleet committed stats (accounts verdict),
  //    in parallel. One all-time fetch per org feeds every series: the trailing windows ignore out-of-window days.
  const [orgDayEntries, fleet] = await Promise.all([
    mapWithConcurrency(orgIds, ORG_FANOUT_CONCURRENCY, async (orgId): Promise<[string, Map<string, number>]> => {
      return [orgId, await deps.orgDailySpendCents(orgId, coldEmailSlugsCsv, INCEPTION_FLOOR_ISO)];
    }),
    coldEmailSlugsCsv ? deps.currentFleetStats(coldEmailSlugsCsv, now) : Promise.resolve({ mrrUsd: 0, dailyBudgetUsd: 0, activeCount: 0 }),
  ]);
  const orgDailyCents = new Map(orgDayEntries);
  const currentMrrUsd = fleet.mrrUsd;

  // 2b. COMMITTED MRR: record today's committed-budget snapshot (going forward, fail-soft), then read the
  //     recorded snapshots over the displayed window and build the monthly/weekly committed series. The
  //     current-period point uses the LIVE MRR, so it reconciles with the accounts audit by construction.
  let committedMrr: CommittedMrrHistory = buildCommittedMrrHistory([], currentMrrUsd, now, { weeks: windows.weeks, months: windows.months });
  if (coldEmailSlugsCsv) {
    await deps.recordCommittedSnapshot(fleet.dailyBudgetUsd, fleet.activeCount, now);
    const committedSinceIso = [monthlyBuckets[0]?.periodStart, weeklyBuckets[0]?.periodStart]
      .filter((s): s is string => Boolean(s))
      .reduce((a, b) => (a < b ? a : b), todayIso);
    const snapshots = await deps.readCommittedSnapshots(committedSinceIso);
    committedMrr = buildCommittedMrrHistory(snapshots, currentMrrUsd, now, { weeks: windows.weeks, months: windows.months });
  }

  // 3. Total since inception = sum every org's every billed day.
  let totalCents = 0;
  let earliestDay: string | null = null;
  for (const days of orgDailyCents.values()) {
    for (const [day, cents] of days) {
      totalCents += cents;
      if (earliestDay === null || day < earliestDay) earliestDay = day;
    }
  }

  // 4. Per-day-since-inception line: every UTC day from the first billed day to today (inclusive).
  let sinceInceptionDaily: RevenueBucket[] = [];
  if (earliestDay !== null) {
    const spanDays = Math.round((Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${earliestDay}T00:00:00Z`)) / 86_400_000) + 1;
    const inceptionBuckets: Array<{ period: string; periodStart: string }> = [];
    for (let i = 0; i < spanDays; i++) {
      const day = addUtcDays(earliestDay, i);
      inceptionBuckets.push({ period: day, periodStart: day });
    }
    sinceInceptionDaily = bucketizeRevenue(orgDailyCents, inceptionBuckets, "day");
  }

  return {
    totalRevenueUsd: centsToUsd(totalCents),
    currentMrrUsd,
    monthly: bucketizeRevenue(orgDailyCents, monthlyBuckets, "month"),
    weekly: bucketizeRevenue(orgDailyCents, weeklyBuckets, "week"),
    daily: bucketizeRevenue(orgDailyCents, dailyBuckets, "day"),
    sinceInceptionDaily,
    committedMrr,
    // Same per-org realized-spend maps the series above sum — one revenue basis for the whole payload.
    netRevenueRetention: buildNetRevenueRetention(orgDailyCents, todayIso, { weeks: windows.weeks, months: windows.months }),
    asOf: now.toISOString(),
  };
}
