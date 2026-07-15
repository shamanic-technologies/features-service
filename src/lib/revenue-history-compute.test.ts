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
    capture?: { startedAfter?: string };
  }): RevenueHistoryDeps {
    return {
      featureMemberships: async () => fixture.orgs.map((orgId) => ({ orgId })),
      orgDailySpendCents: async (orgId, _csv, startedAfterIso) => {
        if (fixture.capture) fixture.capture.startedAfter = startedAfterIso;
        return new Map(Object.entries(fixture.dailyCents[orgId] ?? {}));
      },
      currentMrrUsd: async () => fixture.currentMrrUsd,
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
