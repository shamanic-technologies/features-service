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
import { fetchBrandFirstBilledDay, fetchOrgDailySpendCents } from "./revenue-history-client.js";
import { buildAccountsAudit } from "./accounts-compute.js";
import { mapWithConcurrency } from "./concurrency.js";
import { addUtcDays } from "./send-forecast-compute.js";
import { bucketOf, enumerateBuckets, type Granularity } from "./active-users-compute.js";
import { recordCommittedMrrSnapshotSoft, readCommittedMrrSnapshotsSoft } from "./committed-mrr-store.js";
import { buildCommittedMrrHistory, type CommittedMrrHistory } from "./committed-mrr-compute.js";
import { buildNetRevenueRetention, type NrrHistory } from "./nrr-compute.js";
import { readStatedAmountsSoft, type StatedAmountRow } from "./stated-monthly-amounts-store.js";
import {
  fetchBrandBudgetByDay,
  fetchCampaignEarningOnDay,
  fetchFleetCampaigns,
  fetchPaymentStoppedPeriods,
  EARNING_BATCH_SIZE,
  type BudgetByDay,
  type CampaignDayAnswer,
  type FleetCampaignRow,
  type PaymentStoppedFacts,
} from "./mrr-day-facts-clients.js";
import { fetchBrandCommittedSpendByDay } from "./brand-spend-by-day-client.js";
import {
  agencyPairKeysOf,
  buildMrrSplit,
  pairKey,
  recordedEarningOf,
  referenceDatesOf,
  type DayFacts,
  type MrrSplit,
} from "./agency-self-serve-compute.js";

/** Cap the per-org runs-service fan-out so a cold sibling is not hit with N sockets at once. */
const ORG_FANOUT_CONCURRENCY = 6;

/**
 * How many past reference dates the earning read is paid for. Every emitted period asks campaign-service
 * one question, so the fan-out grows with the DISPLAYED window rather than with the fleet; a staff caller
 * asking for three years of weekly buckets would otherwise mint a request per week. Beyond the cap the
 * oldest buckets fall back to activity evidence and say so (`selfServeBasis: "approximated"`) — the same
 * marking the pre-record era already carries, never a silent blend.
 */
const MAX_EARNING_REFERENCE_DATES = 60;

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
  /**
   * THE SAME MONTHLY RUN-RATE, SPLIT INTO ITS TWO HONEST HALVES — an AGENCY half worth what a human
   * STATED it is worth, and a SELF-SERVE (SaaS) half worth its budget × 30 — plus their total, live and
   * over the same monthly / weekly history the committed series covers. See agency-self-serve-compute.ts
   * for why budget × 30 is the wrong number for an agency. Additive: `committedMrr` above is unchanged
   * and still carries the undivided fleet figure. With NO stated amounts on record the split is the
   * whole fleet on the self-serve side and zero agency, byte-for-byte today's numbers.
   *
   * `null` means "we could not read this" — the stated-amount store or billing's budget timeline was
   * unreachable — never a zero that would say the agency is worth nothing. The rest of the payload is
   * unaffected: a split blip must not 502 a revenue read whose every other figure is correct.
   */
  mrrSplit: MrrSplit | null;
  asOf: string;
}

/** Injectable client bundle (defaults to the real clients; overridden in tests). */
export interface RevenueHistoryDeps {
  featureMemberships: (featureSlugsCsv: string) => Promise<Array<{ orgId: string }>>;
  /** Map of UTC day → actual cold-email spend (cents) for the org, since `startedAfterIso`. */
  orgDailySpendCents: (orgId: string, coldEmailSlugsCsv: string, startedAfterIso: string) => Promise<Map<string, number>>;
  /**
   * LIVE fleet committed stats (accounts-audit): MRR (budget × 30), daily budget, active count — all USD —
   * plus the per-(org, brand) rows behind them. The rows are what the agency / self-serve split subtracts
   * on: it must use the SAME running-budget figures the fleet MRR was summed from, or today's self-serve
   * half would not cancel against today's committed MRR.
   */
  currentFleetStats: (
    coldEmailSlugsCsv: string,
    now: Date,
  ) => Promise<{
    mrrUsd: number;
    dailyBudgetUsd: number;
    activeCount: number;
    pairs: Array<{
      orgId: string;
      brandId: string;
      brandName: string | null;
      brandDomain: string | null;
      runningDailyBudgetUsd: number;
      active: boolean;
    }>;
  }>;
  /** Persist today's committed-budget snapshot (fail-soft; recorded going forward, no boot backfill). */
  recordCommittedSnapshot: (dailyBudgetUsd: number, activeCount: number, now: Date) => Promise<void>;
  /** Read committed snapshots on/after a `YYYY-MM-DD` lower bound → {date, mrrUsd} oldest→newest (fail-soft → []). */
  readCommittedSnapshots: (sinceIso: string) => Promise<Array<{ date: string; mrrUsd: number }>>;
  /** Every stated monthly amount on record (fail-soft → null = "could not read", distinct from [] = "none stated"). */
  readStatedAmounts: () => Promise<StatedAmountRow[] | null>;
  /** What amount billing recorded as in force for one (org, brand) on each UTC day of a range. Fails loud. */
  budgetByDay: (brandId: string, orgId: string, from: string, to: string) => Promise<BudgetByDay>;
  /** Every stretch during which an org's payment had stopped, plus the day that record begins. Fails loud. */
  paymentStopped: (orgId: string) => Promise<PaymentStoppedFacts>;
  /** Every campaign across every org, in one call — which campaigns each (org, brand) pair has. Fails loud. */
  fleetCampaigns: () => Promise<FleetCampaignRow[]>;
  /** Was each campaign running, and did it have anybody to contact, on ONE UTC day. Fails loud. */
  campaignEarningOnDay: (campaignIds: string[], day: string) => Promise<CampaignDayAnswer[]>;
  /** One (org, brand)'s billed cold-email spend per UTC day — the activity evidence for the earlier era. Fails loud. */
  brandSpendByDay: (orgId: string, brandId: string, coldEmailSlugsCsv: string) => Promise<Map<string, number>>;
  /** First UTC day one (org, brand) ever billed cold-email spend, or null. Fails loud. */
  firstBilledDay: (orgId: string, brandId: string, coldEmailSlugsCsv: string, startedAfterIso: string) => Promise<string | null>;
}

const REAL_DEPS: RevenueHistoryDeps = {
  featureMemberships: async (csv) => (await fetchFeatureMemberships(csv)).map((m) => ({ orgId: m.orgId })),
  orgDailySpendCents: fetchOrgDailySpendCents,
  currentFleetStats: async (csv, now) => {
    const audit = await buildAccountsAudit(csv, now);
    const s = audit.stats;
    return {
      mrrUsd: s.mrrUsd,
      dailyBudgetUsd: s.totalRunningDailyBudgetUsd,
      activeCount: s.activeCount,
      pairs: audit.rows.map((r) => ({
        orgId: r.orgId,
        brandId: r.brandId,
        // The audit already batches brand-service for its own table, so naming a brand in the
        // self-serve breakdown costs no extra read.
        brandName: r.brandName,
        brandDomain: r.brandDomain,
        runningDailyBudgetUsd: r.runningDailyBudgetUsd,
        active: r.status === "active",
      })),
    };
  },
  recordCommittedSnapshot: recordCommittedMrrSnapshotSoft,
  readCommittedSnapshots: readCommittedMrrSnapshotsSoft,
  readStatedAmounts: readStatedAmountsSoft,
  budgetByDay: fetchBrandBudgetByDay,
  paymentStopped: fetchPaymentStoppedPeriods,
  fleetCampaigns: fetchFleetCampaigns,
  campaignEarningOnDay: fetchCampaignEarningOnDay,
  brandSpendByDay: (orgId, brandId, coldEmailSlugsCsv) =>
    fetchBrandCommittedSpendByDay(brandId, undefined, coldEmailSlugsCsv.split(","), { orgId }),
  firstBilledDay: fetchBrandFirstBilledDay,
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
    coldEmailSlugsCsv ? deps.currentFleetStats(coldEmailSlugsCsv, now) : Promise.resolve({ mrrUsd: 0, dailyBudgetUsd: 0, activeCount: 0, pairs: [] }),
  ]);
  const orgDailyCents = new Map(orgDayEntries);
  const currentMrrUsd = fleet.mrrUsd;

  // 2b. COMMITTED MRR: record today's committed-budget snapshot (going forward, fail-soft), then read the
  //     recorded snapshots over the displayed window and build the monthly/weekly committed series. The
  //     current-period point uses the LIVE MRR, so it reconciles with the accounts audit by construction.
  let committedMrr: CommittedMrrHistory = buildCommittedMrrHistory([], currentMrrUsd, now, { weeks: windows.weeks, months: windows.months });
  let committedSnapshots: Array<{ date: string; mrrUsd: number }> = [];
  if (coldEmailSlugsCsv) {
    await deps.recordCommittedSnapshot(fleet.dailyBudgetUsd, fleet.activeCount, now);
    const committedSinceIso = [monthlyBuckets[0]?.periodStart, weeklyBuckets[0]?.periodStart]
      .filter((s): s is string => Boolean(s))
      .reduce((a, b) => (a < b ? a : b), todayIso);
    committedSnapshots = await deps.readCommittedSnapshots(committedSinceIso);
    committedMrr = buildCommittedMrrHistory(committedSnapshots, currentMrrUsd, now, { weeks: windows.weeks, months: windows.months });
  }

  // 2c. AGENCY / SELF-SERVE SPLIT: the same run-rate, divided into the half a human STATED a monthly
  //     worth for and the half that genuinely is budget × 30. Fail-SOFT as a whole — additive
  //     enrichment must never 502 a revenue read whose every other figure is correct — and NEVER
  //     half-computed: a partial read would state a self-serve figure that is quietly wrong.
  const mrrSplit = await buildMrrSplitSoft(
    { coldEmailSlugsCsv, snapshots: committedSnapshots, currentMrrUsd, pairs: fleet.pairs },
    now,
    { weeks: windows.weeks, months: windows.months },
    deps,
  );

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
    mrrSplit,
    asOf: now.toISOString(),
  };
}

/**
 * Assemble the agency / self-serve split, FAIL-SOFT as a whole (`null` = "we could not read this",
 * never a zero agency). Both halves are SUMS over their own pairs, so neither can come out negative
 * and neither depends on the other.
 *
 * WHAT IT COSTS, AND WHY THE OLD "an empty store costs nothing" PROPERTY IS GONE. The self-serve half
 * used to be a subtraction, so with no stated amounts on record it needed no reads at all. It is a sum
 * over the self-serve side now, and reading that side is what an honest figure costs: one recorded
 * budget replay and one activity read per (org, brand), one payment-stopped read per org, one call for
 * the fleet's campaigns, and one earning read per REFERENCE DATE (not per day of the window). Every
 * fan-out is capped and every read is bounded by the ~30 cold-email pairs the accounts audit already
 * enumerates; the whole thing sits behind this endpoint's existing SWR window.
 *
 * The activity read is SKIPPED entirely once campaign-service's record covers the oldest reference
 * date — at that point nothing is approximated, so the fallback evidence buys nothing and is not paid
 * for. That is a real condition, not a heuristic: it is exactly `earningRecordBeginsOn <= from`.
 */
async function buildMrrSplitSoft(
  ctx: {
    coldEmailSlugsCsv: string;
    snapshots: Array<{ date: string; mrrUsd: number }>;
    currentMrrUsd: number;
    pairs: Array<{ orgId: string; brandId: string; brandName?: string | null; brandDomain?: string | null }>;
  },
  now: Date,
  windows: { weeks: number; months: number },
  deps: RevenueHistoryDeps,
): Promise<MrrSplit | null> {
  try {
    const statedRows = await deps.readStatedAmounts();
    if (statedRows === null) return null; // could not read the store — say so, never a zero agency

    const todayIso = now.toISOString().slice(0, 10);
    const pairs = ctx.pairs.map((p) => ({ ...p, key: pairKey(p.orgId, p.brandId) }));
    const orgIds = [...new Set(pairs.map((p) => p.orgId))];

    // The split is only ever read ON these days — one per emitted period, plus today. Everything
    // below is fetched for that set, never for every day of the displayed window.
    const referenceDates = referenceDatesOf(ctx.snapshots, todayIso, windows, ctx.currentMrrUsd);
    const from = referenceDates[0] ?? todayIso;

    const [budgetEntries, paymentEntries, fleetCampaigns] = await Promise.all([
      mapWithConcurrency(pairs, ORG_FANOUT_CONCURRENCY, async (p): Promise<[string, BudgetByDay]> => [
        p.key,
        await deps.budgetByDay(p.brandId, p.orgId, from, todayIso),
      ]),
      mapWithConcurrency(orgIds, ORG_FANOUT_CONCURRENCY, async (orgId): Promise<[string, PaymentStoppedFacts]> => [
        orgId,
        await deps.paymentStopped(orgId),
      ]),
      pairs.length > 0 ? deps.fleetCampaigns() : Promise.resolve([] as FleetCampaignRow[]),
    ]);

    // Which campaigns belong to each pair — the brand-level earning question is an OR over them.
    const pairOfCampaign = new Map<string, string>();
    const campaignIdsOfPair = new Map<string, string[]>();
    const pairKeySet = new Set(pairs.map((p) => p.key));
    for (const c of fleetCampaigns) {
      if (c.brandId === null) continue; // a row naming no brand joins to no pair
      const key = pairKey(c.orgId, c.brandId);
      if (!pairKeySet.has(key)) continue;
      pairOfCampaign.set(c.campaignId, key);
      const list = campaignIdsOfPair.get(key);
      if (list) list.push(c.campaignId);
      else campaignIdsOfPair.set(key, [c.campaignId]);
    }
    const trackedCampaignIds = [...pairOfCampaign.keys()];
    const chunks: string[][] = [];
    for (let i = 0; i < trackedCampaignIds.length; i += EARNING_BATCH_SIZE) {
      chunks.push(trackedCampaignIds.slice(i, i + EARNING_BATCH_SIZE));
    }

    /** One reference date's per-campaign answers, merged across the batches. */
    const earningOn = async (day: string): Promise<CampaignDayAnswer[]> =>
      (await mapWithConcurrency(chunks, ORG_FANOUT_CONCURRENCY, (ids) => deps.campaignEarningOnDay(ids, day))).flat();

    // TODAY first, on its own: its answer is needed anyway, and it is what tells us the day
    // campaign-service's record begins — so no earlier date is asked for an answer we already know
    // is `not_recorded`.
    const todayAnswers = chunks.length > 0 ? await earningOn(todayIso) : [];
    const recordStarts = todayAnswers
      .flatMap((a) => [a.statusRecordedSince, a.audienceRecordedSince])
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.slice(0, 10));
    const earningRecordBeginsOn = recordStarts.length > 0 ? recordStarts.reduce((a, b) => (a < b ? a : b)) : null;

    const inRecordDates = referenceDates.filter(
      (d) => d !== todayIso && earningRecordBeginsOn !== null && d >= earningRecordBeginsOn,
    );
    const pastAnswers = await mapWithConcurrency(
      inRecordDates.slice(-MAX_EARNING_REFERENCE_DATES),
      ORG_FANOUT_CONCURRENCY,
      async (day): Promise<[string, CampaignDayAnswer[]]> => [day, await earningOn(day)],
    );

    // pair key → day → the RECORDED verdict (true / false / null = campaign-service knows nothing),
    // and beside it the per-campaign answers that verdict was collapsed FROM. Both come out of the
    // SAME grouping, so the breakdown's "which condition said no" can never describe a different set
    // of campaigns than the verdict the arithmetic took.
    const recordedEarning = new Map<string, Map<string, boolean | null>>();
    const campaignAnswers = new Map<string, Map<string, CampaignDayAnswer[]>>();
    for (const [day, answers] of [[todayIso, todayAnswers] as [string, CampaignDayAnswer[]], ...pastAnswers]) {
      const byPair = new Map<string, CampaignDayAnswer[]>();
      for (const a of answers) {
        const key = pairOfCampaign.get(a.campaignId);
        if (!key) continue;
        const list = byPair.get(key);
        if (list) list.push(a);
        else byPair.set(key, [a]);
      }
      for (const [key, list] of byPair) {
        const days = recordedEarning.get(key) ?? new Map<string, boolean | null>();
        days.set(day, recordedEarningOf(list));
        recordedEarning.set(key, days);

        const raw = campaignAnswers.get(key) ?? new Map<string, CampaignDayAnswer[]>();
        raw.set(day, list);
        campaignAnswers.set(key, raw);
      }
    }

    // The fallback evidence, paid for ONLY while some reference date sits before the record begins.
    const needsActivity = earningRecordBeginsOn === null || from < earningRecordBeginsOn;
    const activityEntries = needsActivity
      ? await mapWithConcurrency(pairs, ORG_FANOUT_CONCURRENCY, async (p): Promise<[string, Set<string>]> => {
          const byDay = await deps.brandSpendByDay(p.orgId, p.brandId, ctx.coldEmailSlugsCsv);
          return [p.key, new Set([...byDay].filter(([, usd]) => usd > 0).map(([day]) => day))];
        })
      : [];

    // Only a stated row with NO start date needs its brand's first billed day.
    const agencyPairKeys = agencyPairKeysOf(statedRows, ctx.pairs);
    const agencyPairs = agencyPairKeys.map((key) => {
      const [orgId, brandId] = key.split("::");
      return { key, orgId, brandId };
    });
    const firstBilledEntries = await mapWithConcurrency(
      agencyPairs.filter((p) => statedRows.some((r) => r.orgId === p.orgId && r.brandId === p.brandId && r.startDate === null)),
      ORG_FANOUT_CONCURRENCY,
      async (p): Promise<[string, string | null]> => [
        p.key,
        await deps.firstBilledDay(p.orgId, p.brandId, ctx.coldEmailSlugsCsv, INCEPTION_FLOOR_ISO),
      ],
    );

    const facts: DayFacts = {
      budgetByDay: new Map(budgetEntries.map(([key, b]) => [key, b.byDay])),
      activityDays: new Map(activityEntries),
      recordedEarning,
      paymentByOrg: new Map(paymentEntries),
      campaignAnswers,
    };

    return buildMrrSplit(
      {
        statedRows,
        allPairs: ctx.pairs,
        facts,
        firstBilledDayByPair: new Map(firstBilledEntries),
        snapshots: ctx.snapshots,
        currentMrrUsd: ctx.currentMrrUsd,
        earningRecordBeginsOn,
        brandNamesByPair: new Map(
          ctx.pairs.map((p) => [pairKey(p.orgId, p.brandId), { name: p.brandName ?? null, domain: p.brandDomain ?? null }]),
        ),
      },
      now,
      windows,
    );
  } catch (err) {
    console.error("[features-service] agency/self-serve MRR split failed (soft):", err);
    return null;
  }
}
