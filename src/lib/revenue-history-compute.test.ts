import { describe, it, expect, vi } from "vitest";

// revenue-history-compute transitively imports accounts-compute → pipeline-activity → the db module.
// Stub it so this pure-logic suite needs no DB connection (all reads are injected).
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildRevenueHistory, bucketizeRevenue, type RevenueHistoryDeps } from "./revenue-history-compute.js";
import { enumerateBuckets } from "./active-users-compute.js";

const NOW = new Date("2026-07-15T12:00:00Z"); // Wednesday
const COLD = "sales-cold-email-outreach,pr-cold-email-outreach";

describe("bucketizeRevenue — summed spend per bucket + growth", () => {
  it("SUMS cents across orgs (not distinct-counts) and converts to 2-decimal USD + growth", () => {
    const buckets = enumerateBuckets("2026-07-15", "day", 3); // 13,14,15
    const orgDaily = new Map<string, Map<string, number>>([
      ["orgA", new Map([["2026-07-13", 1000], ["2026-07-14", 2000], ["2026-07-15", 4000]])],
      ["orgB", new Map([["2026-07-14", 2000]])], // second org adds to the same bucket
      ["orgC", new Map([["2026-07-15", 4000]])],
    ]);
    const series = bucketizeRevenue(orgDaily, buckets, "day");
    // 13:1000c=$10  14:(2000+2000)=$40  15:(4000+4000)=$80
    expect(series.map((s) => s.revenueUsd)).toEqual([10, 40, 80]);
    expect(series[0].growthPct).toBeNull(); // first bucket
    expect(series[1].growthPct).toBe(300); // 1000→4000
    expect(series[2].growthPct).toBe(100); // 4000→8000
  });

  it("spend on two days of the SAME week rolls into one weekly bucket", () => {
    const buckets = enumerateBuckets("2026-07-15", "week", 1); // week of 07-13
    const orgDaily = new Map<string, Map<string, number>>([["orgA", new Map([["2026-07-13", 1500], ["2026-07-15", 3500]])]]);
    const series = bucketizeRevenue(orgDaily, buckets, "week");
    expect(series[0].revenueUsd).toBe(50); // 5000c
  });

  it("growthPct is null when the previous bucket is 0 (no % from zero base)", () => {
    const buckets = enumerateBuckets("2026-07-15", "day", 2); // 14,15
    const orgDaily = new Map<string, Map<string, number>>([["orgA", new Map([["2026-07-15", 5000]])]]);
    const series = bucketizeRevenue(orgDaily, buckets, "day");
    expect(series.map((s) => s.revenueUsd)).toEqual([0, 50]);
    expect(series[1].growthPct).toBeNull(); // 0→50 → null, never Infinity
  });

  it("days outside the displayed window are ignored", () => {
    const buckets = enumerateBuckets("2026-07-15", "day", 2); // 14,15
    const orgDaily = new Map<string, Map<string, number>>([["orgA", new Map([["2026-01-01", 9999], ["2026-07-15", 5000]])]]);
    const series = bucketizeRevenue(orgDaily, buckets, "day");
    expect(series.map((s) => s.revenueUsd)).toEqual([0, 50]); // 01-01 dropped from the trailing window
  });
});

describe("buildRevenueHistory — integration via injected deps", () => {
  function deps(fixture: {
    orgs: string[];
    dailyCents: Record<string, Record<string, number>>;
    currentMrrUsd: number;
    activeCount?: number;
    snapshots?: Array<{ date: string; mrrUsd: number }>;
    capture?: { startedAfter?: string; recorded?: { dailyBudgetUsd: number; activeCount: number } };
  }): RevenueHistoryDeps {
    return {
      featureMemberships: async () => fixture.orgs.map((orgId) => ({ orgId })),
      orgDailySpendCents: async (orgId, _csv, startedAfterIso) => {
        if (fixture.capture) fixture.capture.startedAfter = startedAfterIso;
        return new Map(Object.entries(fixture.dailyCents[orgId] ?? {}));
      },
      currentFleetStats: async () => ({
        mrrUsd: fixture.currentMrrUsd,
        dailyBudgetUsd: fixture.currentMrrUsd / 30,
        activeCount: fixture.activeCount ?? 0,
        pairs: [],
      }),
      recordCommittedSnapshot: async (dailyBudgetUsd, activeCount) => {
        if (fixture.capture) fixture.capture.recorded = { dailyBudgetUsd, activeCount };
      },
      readCommittedSnapshots: async () => fixture.snapshots ?? [],
      readStatedAmounts: async () => [],
      budgetHistory: async () => [],
      firstBilledDay: async () => null,
    };
  }

  it("assembles totals, trailing series, the since-inception line, and the live MRR", async () => {
    const capture: { startedAfter?: string } = {};
    const history = await buildRevenueHistory(
      COLD,
      NOW,
      { days: 3, weeks: 2, months: 2 },
      deps({
        orgs: ["orgA", "orgB"],
        dailyCents: {
          orgA: { "2026-07-15": 4000, "2026-05-10": 1000 }, // today + a May day (before the trailing daily/weekly windows)
          orgB: { "2026-06-20": 3000 }, // June, in the monthly window
        },
        currentMrrUsd: 12345.67,
        capture,
      }),
    );

    // Total since inception = 4000+1000+3000 = 8000c = $80. Live MRR is a passthrough, NOT reconstructed.
    expect(history.totalRevenueUsd).toBe(80);
    expect(history.currentMrrUsd).toBe(12345.67);
    expect(history.asOf).toBe("2026-07-15T12:00:00.000Z");

    // Monthly (2026-06, 2026-07): $30 in June (orgB), $40 in July (orgA today).
    expect(history.monthly.map((m) => [m.period, m.revenueUsd])).toEqual([
      ["2026-06", 30],
      ["2026-07", 40],
    ]);

    // Daily (07-13,07-14,07-15): only orgA today → $40.
    expect(history.daily.map((d) => d.revenueUsd)).toEqual([0, 0, 40]);

    // Since-inception line spans the earliest billed day (2026-05-10) → today, first & last carry the spend.
    const first = history.sinceInceptionDaily[0];
    const last = history.sinceInceptionDaily[history.sinceInceptionDaily.length - 1];
    expect(first).toMatchObject({ period: "2026-05-10", revenueUsd: 10 });
    expect(last).toMatchObject({ period: "2026-07-15", revenueUsd: 40 });
    // The June orgB day is in the line too; the middle days between billed days read $0.
    expect(history.sinceInceptionDaily.find((d) => d.period === "2026-06-20")?.revenueUsd).toBe(30);
    expect(history.sinceInceptionDaily.find((d) => d.period === "2026-05-11")?.revenueUsd).toBe(0);

    // The all-time fetch uses the inception floor, NOT the trailing-window lower bound.
    expect(capture.startedAfter).toBe("2020-01-01T00:00:00.000Z");

    // Committed MRR current period reconciles with the live MRR; ARR = MRR × 12.
    expect(history.committedMrr.currentMrrUsd).toBe(12345.67);
    expect(history.committedMrr.currentArrUsd).toBe(12345.67 * 12);
    const lastMonth = history.committedMrr.monthly[history.committedMrr.monthly.length - 1];
    expect(lastMonth).toMatchObject({ period: "2026-07", mrrUsd: 12345.67, arrUsd: 12345.67 * 12 });
    const lastWeek = history.committedMrr.weekly[history.committedMrr.weekly.length - 1];
    expect(lastWeek.mrrUsd).toBe(12345.67);
    expect(lastWeek.arrUsd).toBe(12345.67 * 12);
  });

  it("committed MRR series: past periods from recorded snapshots, current period = live MRR, growth + ARR coherent", async () => {
    const capture: { recorded?: { dailyBudgetUsd: number; activeCount: number } } = {};
    const history = await buildRevenueHistory(
      COLD,
      NOW,
      { days: 3, weeks: 2, months: 3 },
      deps({
        orgs: ["orgA"],
        dailyCents: { orgA: { "2026-07-15": 4000 } },
        currentMrrUsd: 3000, // live current-month committed MRR
        activeCount: 4,
        // June has two snapshots (last one = end-of-June run-rate $2000); May has one ($1000).
        snapshots: [
          { date: "2026-05-20", mrrUsd: 1000 },
          { date: "2026-06-10", mrrUsd: 1500 },
          { date: "2026-06-28", mrrUsd: 2000 },
        ],
        capture,
      }),
    );

    // Today's snapshot recorded going forward (budget = mrr/30, active count passed through).
    expect(capture.recorded).toEqual({ dailyBudgetUsd: 100, activeCount: 4 });

    // Monthly: May $1000 → June $2000 (last snapshot) → July $3000 (live). Growth point-over-point.
    expect(history.committedMrr.monthly.map((m) => [m.period, m.mrrUsd, m.arrUsd, m.growthPct])).toEqual([
      ["2026-05", 1000, 12000, null],
      ["2026-06", 2000, 24000, 100],
      ["2026-07", 3000, 36000, 50],
    ]);
  });

  it("NRR rides the SAME realized-revenue basis as the series, on both grains", async () => {
    const history = await buildRevenueHistory(
      COLD,
      NOW,
      { days: 3, weeks: 2, months: 2 },
      deps({
        orgs: ["existing", "newLogo"],
        dailyCents: {
          existing: { "2026-06-10": 100_00, "2026-07-02": 80_00 }, // contraction: 80%
          newLogo: { "2026-07-05": 500_00 }, // acquired in July — must not inflate NRR
        },
        currentMrrUsd: 0,
      }),
    );

    // The realized-revenue series still sees BOTH orgs (July = 80 + 500 = $580) …
    expect(history.monthly.at(-1)).toMatchObject({ period: "2026-07", revenueUsd: 580 });
    // … while NRR sees only the start-of-July cohort: 80/100 = 80%, not 580/100.
    expect(history.netRevenueRetention.monthly.at(-1)).toMatchObject({
      period: "2026-07",
      retentionPct: 80,
      cohortSize: 1,
      priorRevenueUsd: 100,
      retainedRevenueUsd: 80,
    });
    expect(history.netRevenueRetention.monthly).toHaveLength(2);
    expect(history.netRevenueRetention.weekly).toHaveLength(2);
  });

  it("empty cold-email universe → zero totals + empty since-inception line, never throws", async () => {
    const history = await buildRevenueHistory("", NOW, { days: 2, weeks: 1, months: 1 }, deps({ orgs: [], dailyCents: {}, currentMrrUsd: 0 }));
    expect(history.totalRevenueUsd).toBe(0);
    expect(history.currentMrrUsd).toBe(0);
    expect(history.daily.every((d) => d.revenueUsd === 0)).toBe(true);
    expect(history.sinceInceptionDaily).toEqual([]);
    expect(history.monthly.length).toBe(1);
  });
});

/**
 * WIRING of the agency / self-serve split into the revenue payload. The split's own arithmetic is
 * guarded in agency-self-serve-compute.test.ts; these cases assert what only this layer decides — that
 * an empty store costs NOTHING and moves NOTHING (the regression gate for every existing consumer),
 * that a stated amount reaches the wire, and that a failed read NULLS the split instead of 502-ing a
 * payload whose every other figure is correct.
 */
describe("buildRevenueHistory — the agency / self-serve split", () => {
  const SPLIT_NOW = new Date("2026-09-12T12:00:00Z");
  const AGENCY_ORG = "org-agency";
  const BRAND_BIG = "brand-big";

  function splitDeps(over: Partial<RevenueHistoryDeps> = {}, calls?: { budget: number; firstBilled: number }): RevenueHistoryDeps {
    return {
      featureMemberships: async () => [{ orgId: AGENCY_ORG }, { orgId: "org-saas" }],
      orgDailySpendCents: async () => new Map(),
      currentFleetStats: async () => ({
        mrrUsd: 7350,
        dailyBudgetUsd: 245,
        activeCount: 2,
        pairs: [
          { orgId: AGENCY_ORG, brandId: BRAND_BIG, runningDailyBudgetUsd: 143, active: true },
          { orgId: "org-saas", brandId: "brand-saas", runningDailyBudgetUsd: 102, active: true },
        ],
      }),
      recordCommittedSnapshot: async () => {},
      readCommittedSnapshots: async () => [{ date: "2026-08-31", mrrUsd: 6000 }],
      readStatedAmounts: async () => [],
      budgetHistory: async () => {
        if (calls) calls.budget += 1;
        return [{ dailyBudgetUsd: 143, changedAt: "2026-08-01T00:00:00Z" }];
      },
      firstBilledDay: async () => {
        if (calls) calls.firstBilled += 1;
        return "2026-07-25";
      },
      ...over,
    };
  }

  const WINDOWS = { days: 7, weeks: 4, months: 3 };

  it("with NO stated amounts the self-serve figure IS the fleet committed MRR, and NOTHING is fetched", async () => {
    const calls = { budget: 0, firstBilled: 0 };
    const out = await buildRevenueHistory(COLD, SPLIT_NOW, WINDOWS, splitDeps({}, calls));

    expect(out.mrrSplit).not.toBeNull();
    expect(out.mrrSplit!.currentSelfServeMrrUsd).toBe(out.currentMrrUsd);
    expect(out.mrrSplit!.currentAgencyMrrUsd).toBe(0);
    expect(out.mrrSplit!.currentTotalMrrUsd).toBe(out.currentMrrUsd);
    // An empty store means no agency side, so the split issues ZERO extra requests — no new failure
    // mode on an endpoint that was already working.
    expect(calls).toEqual({ budget: 0, firstBilled: 0 });
  });

  it("a stated amount reaches the wire as the agency's worth, and its budget leaves the self-serve half", async () => {
    const calls = { budget: 0, firstBilled: 0 };
    const out = await buildRevenueHistory(
      COLD,
      SPLIT_NOW,
      WINDOWS,
      splitDeps(
        {
          readStatedAmounts: async () => [
            {
              id: "row-1",
              orgId: AGENCY_ORG,
              brandId: BRAND_BIG,
              amountUsd: 5000,
              startDate: null,
              endDate: null,
              note: null,
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
        },
        calls,
      ),
    );

    const split = out.mrrSplit!;
    expect(split.currentAgencyMrrUsd).toBe(5000); // the STATED amount
    expect(split.currentAgencyBudgetMrrUsd).toBe(143 * 30); // 4290 — what it contributed to the fleet figure
    expect(split.currentSelfServeMrrUsd).toBe(7350 - 4290); // 3060, the SaaS business on its own
    expect(split.currentTotalMrrUsd).toBe(5000 + 3060);
    expect(split.agencyOrgIds).toEqual([AGENCY_ORG]);
    // One budget-timeline read per agency pair; the first-billed-day read only because the row has no start.
    expect(calls).toEqual({ budget: 1, firstBilled: 1 });
  });

  it("skips the first-billed-day read when every stated row carries a start date", async () => {
    const calls = { budget: 0, firstBilled: 0 };
    await buildRevenueHistory(
      COLD,
      SPLIT_NOW,
      WINDOWS,
      splitDeps(
        {
          readStatedAmounts: async () => [
            {
              id: "row-1",
              orgId: AGENCY_ORG,
              brandId: BRAND_BIG,
              amountUsd: 5000,
              startDate: "2026-08-01",
              endDate: null,
              note: null,
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
        },
        calls,
      ),
    );
    expect(calls).toEqual({ budget: 1, firstBilled: 0 });
  });

  it("NULLS the split when a read fails, leaving every other figure intact", async () => {
    const out = await buildRevenueHistory(
      COLD,
      SPLIT_NOW,
      WINDOWS,
      splitDeps({
        readStatedAmounts: async () => [
          {
            id: "row-1",
            orgId: AGENCY_ORG,
            brandId: BRAND_BIG,
            amountUsd: 5000,
            startDate: "2026-08-01",
            endDate: null,
            note: null,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        budgetHistory: async () => {
          throw new Error("billing-service unreachable");
        },
      }),
    );

    expect(out.mrrSplit).toBeNull(); // "we could not read this" — never a zero agency
    expect(out.currentMrrUsd).toBe(7350);
    expect(out.committedMrr.currentMrrUsd).toBe(7350);
    expect(out.asOf).toBe(SPLIT_NOW.toISOString());
  });

  it("nulls the split when the STORE itself is unreadable, distinct from an empty store", async () => {
    const out = await buildRevenueHistory(COLD, SPLIT_NOW, WINDOWS, splitDeps({ readStatedAmounts: async () => null }));
    expect(out.mrrSplit).toBeNull();
  });

  it("leaves the committed series byte-identical whether or not anything is stated (AC7)", async () => {
    const withNone = await buildRevenueHistory(COLD, SPLIT_NOW, WINDOWS, splitDeps());
    const withStated = await buildRevenueHistory(
      COLD,
      SPLIT_NOW,
      WINDOWS,
      splitDeps({
        readStatedAmounts: async () => [
          {
            id: "row-1",
            orgId: AGENCY_ORG,
            brandId: BRAND_BIG,
            amountUsd: 5000,
            startDate: "2026-08-01",
            endDate: null,
            note: null,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(withStated.committedMrr).toEqual(withNone.committedMrr);
    expect(withStated.currentMrrUsd).toBe(withNone.currentMrrUsd);
    expect(withStated.totalRevenueUsd).toBe(withNone.totalRevenueUsd);
    expect(withStated.netRevenueRetention).toEqual(withNone.netRevenueRetention);
    // …while the split itself DIVERGES, which is the whole point.
    expect(withStated.mrrSplit!.currentSelfServeMrrUsd).not.toBe(withNone.mrrSplit!.currentSelfServeMrrUsd);
  });
});
