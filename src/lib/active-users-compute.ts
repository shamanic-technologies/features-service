/**
 * Assembly of the staff-gated `GET /internal/stats/active-users` history — a cross-org time series of
 * how many ACTIVE USERS (distinct orgs with an active, funded, non-paused cold-email brand) existed
 * over time, bucketed monthly / weekly / daily, each with a period-over-period growth rate, plus the
 * current live total.
 *
 * WHY reconstruct from spend. "Active user" = a distinct org with ≥1 ACTIVE brand, where active is the
 * accounts-audit verdict (not paused, has a daily budget, credit funds ≥ the next day). That verdict is
 * a live, point-in-time composite (balance + budget + pause) — there is no stored history of it. The
 * faithful HISTORICAL signal features-service owns is per-day ACTUALIZED cold-email spend (runs-service):
 * a day of real billed cold-email spend implies the brand was NOT paused (paused → held → no spend), HAD
 * a budget (spend needs budget authorization) and was FUNDED (spend needs affordability). So an org that
 * billed cold-email spend on day D had an active, funded, non-paused brand on D — the same three
 * conditions the live verdict checks, observed after the fact. We count DISTINCT such orgs per bucket.
 *
 * currentTotal is NOT reconstructed — it is the LIVE accounts-audit active-user count (distinct orgs with
 * ≥1 active brand right now), so the number the admin page already renders from `/internal/stats/accounts`
 * stays coherent with this series' headline. The last daily point (realized spend so far today) may lag
 * currentTotal (an org configured-active that hasn't billed yet today) — that is expected: the series is
 * realized activity, currentTotal is the live config verdict. Aggregate counts only, no per-org rows.
 *
 * The account universe is the SAME source the accounts audit + send-forecast use: lead-service
 * feature-memberships over the cold-email feature slugs, deduped to distinct orgs. Per-org dated spend is
 * one runs-service call per org (bounded fan-out, capped concurrency). Fail loud on any read error.
 */
import { fetchFeatureMemberships } from "./feature-memberships-client.js";
import { fetchOrgActiveDays } from "./active-users-client.js";
import { buildAccountsAudit } from "./accounts-compute.js";
import { mapWithConcurrency } from "./concurrency.js";
import { addUtcDays } from "./send-forecast-compute.js";

/** Cap the per-org runs-service fan-out so a cold-Neon sibling is not hit with N sockets at once. */
const ORG_FANOUT_CONCURRENCY = 6;

export type Granularity = "day" | "week" | "month";

export interface ActiveUsersWindows {
  /** Number of trailing UTC days in the daily series (inclusive of today). */
  days: number;
  /** Number of trailing ISO weeks in the weekly series (inclusive of the current week). */
  weeks: number;
  /** Number of trailing calendar months in the monthly series (inclusive of the current month). */
  months: number;
}

export interface ActiveUsersBucket {
  /** Human/sortable label: `YYYY-MM-DD` (day), `YYYY-Www` ISO week (week), or `YYYY-MM` (month). */
  period: string;
  /** UTC start date of the bucket (`YYYY-MM-DD`) — the day, the week's Monday, or the month's 1st. For charting. */
  periodStart: string;
  /** Distinct orgs that were active (billed cold-email spend) at least once in this bucket. */
  activeUsers: number;
  /** Period-over-period growth vs the previous bucket, in percent (1-decimal). null on the first bucket or when the previous bucket is 0. */
  growthPct: number | null;
}

export interface ActiveUsersHistory {
  /** LIVE active-user count (distinct orgs with ≥1 active brand now) — matches the accounts snapshot. */
  currentTotal: number;
  monthly: ActiveUsersBucket[];
  weekly: ActiveUsersBucket[];
  daily: ActiveUsersBucket[];
  asOf: string;
}

/** Injectable client bundle (defaults to the real clients; overridden in tests). */
export interface ActiveUsersDeps {
  featureMemberships: (featureSlugsCsv: string) => Promise<Array<{ orgId: string }>>;
  orgActiveDays: (orgId: string, coldEmailSlugsCsv: string, startedAfterIso: string) => Promise<Set<string>>;
  /** LIVE distinct active-org count (the accounts-audit active verdict). */
  currentActiveUserCount: (coldEmailSlugsCsv: string, now: Date) => Promise<number>;
}

const REAL_DEPS: ActiveUsersDeps = {
  featureMemberships: async (csv) => (await fetchFeatureMemberships(csv)).map((m) => ({ orgId: m.orgId })),
  orgActiveDays: fetchOrgActiveDays,
  currentActiveUserCount: async (csv, now) => {
    const audit = await buildAccountsAudit(csv, now);
    return new Set(audit.rows.filter((r) => r.status === "active").map((r) => r.orgId)).size;
  },
};

// ── UTC bucketing helpers (pure) ─────────────────────────────────────────────

function ymd(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y, m, d];
}

/** ISO-8601 week number + week-year for a UTC `YYYY-MM-DD` day (Monday-based, week 1 contains Jan 4). */
export function isoWeek(day: string): { year: number; week: number } {
  const [y, m, d] = ymd(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  // Shift to the Thursday of this week (ISO weeks are identified by their Thursday).
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { year: isoYear, week };
}

/** The Monday (UTC `YYYY-MM-DD`) of the ISO week containing `day`. */
export function weekStart(day: string): string {
  const [y, m, d] = ymd(day);
  const dayNum = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return addUtcDays(day, -dayNum);
}

/** The bucket `{ period, periodStart }` a UTC day falls into at a given granularity. */
export function bucketOf(day: string, g: Granularity): { period: string; periodStart: string } {
  if (g === "day") return { period: day, periodStart: day };
  if (g === "month") {
    const period = day.slice(0, 7); // YYYY-MM
    return { period, periodStart: `${period}-01` };
  }
  const { year, week } = isoWeek(day);
  return { period: `${year}-W${String(week).padStart(2, "0")}`, periodStart: weekStart(day) };
}

/** Build the contiguous list of trailing buckets (oldest → newest) ending at `todayIso` for a granularity. */
export function enumerateBuckets(todayIso: string, g: Granularity, count: number): Array<{ period: string; periodStart: string }> {
  const out: Array<{ period: string; periodStart: string }> = [];
  const [y, m] = ymd(todayIso);
  if (g === "day") {
    for (let i = count - 1; i >= 0; i--) out.push(bucketOf(addUtcDays(todayIso, -i), "day"));
    return out;
  }
  if (g === "week") {
    const thisMonday = weekStart(todayIso);
    for (let i = count - 1; i >= 0; i--) out.push(bucketOf(addUtcDays(thisMonday, -7 * i), "week"));
    return out;
  }
  // month: walk back `count` calendar months from the current month.
  for (let i = count - 1; i >= 0; i--) {
    const ms = Date.UTC(y, m - 1 - i, 1);
    out.push(bucketOf(new Date(ms).toISOString().slice(0, 10), "month"));
  }
  return out;
}

/**
 * Count DISTINCT active orgs per bucket at a granularity, then attach period-over-period growth.
 * `orgActiveDays` maps each org → the set of UTC days it billed cold-email spend. Only days that fall
 * inside one of `buckets` contribute (days outside the displayed window are ignored). Pure.
 */
export function bucketizeSeries(
  orgActiveDays: Map<string, Set<string>>,
  buckets: Array<{ period: string; periodStart: string }>,
  g: Granularity,
): ActiveUsersBucket[] {
  const tally = new Map<string, Set<string>>();
  for (const b of buckets) tally.set(b.periodStart, new Set());
  for (const [org, days] of orgActiveDays) {
    for (const day of days) {
      const bucket = tally.get(bucketOf(day, g).periodStart);
      if (bucket) bucket.add(org);
    }
  }

  return buckets.map((b, i) => {
    const activeUsers = tally.get(b.periodStart)!.size;
    let growthPct: number | null = null;
    if (i > 0) {
      const prev = tally.get(buckets[i - 1].periodStart)!.size;
      if (prev > 0) growthPct = Math.round(((activeUsers - prev) / prev) * 1000) / 10;
    }
    return { period: b.period, periodStart: b.periodStart, activeUsers, growthPct };
  });
}

/**
 * Build the full active-users history payload. Enumerates the cold-email org universe, fans out one
 * dated-spend read per org (capped), unions each org's active-day set, then builds the monthly / weekly
 * / daily distinct-active-org series (each with growth), and reads the LIVE current total.
 */
export async function buildActiveUsersHistory(
  coldEmailSlugsCsv: string,
  now: Date,
  windows: ActiveUsersWindows,
  deps: ActiveUsersDeps = REAL_DEPS,
): Promise<ActiveUsersHistory> {
  const todayIso = now.toISOString().slice(0, 10);

  const monthlyBuckets = enumerateBuckets(todayIso, "month", windows.months);
  const weeklyBuckets = enumerateBuckets(todayIso, "week", windows.weeks);
  const dailyBuckets = enumerateBuckets(todayIso, "day", windows.days);

  // Earliest displayed instant across all three series → the runs `startedAfter` lower bound.
  const earliestPeriodStart = [monthlyBuckets, weeklyBuckets, dailyBuckets]
    .map((b) => b[0]?.periodStart ?? todayIso)
    .reduce((a, b) => (a < b ? a : b), todayIso);
  const startedAfterIso = `${earliestPeriodStart}T00:00:00.000Z`;

  // 1. Enumerate the distinct cold-email org universe (same source as the accounts audit).
  const memberships = coldEmailSlugsCsv ? await deps.featureMemberships(coldEmailSlugsCsv) : [];
  const orgIds = [...new Set(memberships.map((m) => m.orgId))];

  // 2. Per-org active-day set (capped fan-out) + the live current total (accounts verdict) in parallel.
  const [orgDayEntries, currentTotal] = await Promise.all([
    mapWithConcurrency(orgIds, ORG_FANOUT_CONCURRENCY, async (orgId): Promise<[string, Set<string>]> => {
      return [orgId, await deps.orgActiveDays(orgId, coldEmailSlugsCsv, startedAfterIso)];
    }),
    coldEmailSlugsCsv ? deps.currentActiveUserCount(coldEmailSlugsCsv, now) : Promise.resolve(0),
  ]);
  const orgActiveDays = new Map(orgDayEntries);

  return {
    currentTotal,
    monthly: bucketizeSeries(orgActiveDays, monthlyBuckets, "month"),
    weekly: bucketizeSeries(orgActiveDays, weeklyBuckets, "week"),
    daily: bucketizeSeries(orgActiveDays, dailyBuckets, "day"),
    asOf: now.toISOString(),
  };
}
