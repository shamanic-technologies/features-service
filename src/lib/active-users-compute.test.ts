import { describe, it, expect, vi } from "vitest";

// active-users-compute transitively imports accounts-compute → pipeline-activity → the db module.
// Stub it so this pure-logic suite needs no DB connection (all reads are injected).
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  buildActiveUsersHistory,
  bucketizeSeries,
  enumerateBuckets,
  bucketOf,
  weekStart,
  isoWeek,
  type ActiveUsersDeps,
} from "./active-users-compute.js";

const NOW = new Date("2026-07-15T12:00:00Z"); // Wednesday
const COLD = "sales-cold-email-outreach,pr-cold-email-outreach";

function utcWeekday(dayIso: string): number {
  const [y, m, d] = dayIso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

describe("UTC bucketing helpers", () => {
  it("weekStart returns the Monday (UTC) of the ISO week", () => {
    expect(utcWeekday(weekStart("2026-07-15"))).toBe(1); // always a Monday
    expect(weekStart("2026-07-15")).toBe("2026-07-13"); // Wed → Mon 13
    expect(weekStart("2026-07-13")).toBe("2026-07-13"); // Mon → itself
    expect(weekStart("2026-07-19")).toBe("2026-07-13"); // Sun → same Monday
  });

  it("days in the same ISO week share one weekly bucket; the label is YYYY-Www", () => {
    const a = bucketOf("2026-07-13", "week");
    const b = bucketOf("2026-07-19", "week");
    expect(a.periodStart).toBe(b.periodStart);
    expect(a.period).toBe(b.period);
    expect(a.period).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("bucketOf day/month keys are the calendar day / YYYY-MM", () => {
    expect(bucketOf("2026-07-15", "day")).toEqual({ period: "2026-07-15", periodStart: "2026-07-15" });
    expect(bucketOf("2026-07-15", "month")).toEqual({ period: "2026-07", periodStart: "2026-07-01" });
  });

  it("isoWeek matches the ISO-8601 reference (2026-01-01 is in week 1)", () => {
    expect(isoWeek("2026-01-01")).toEqual({ year: 2026, week: 1 });
    // 2025-12-29 (Mon) starts ISO week 1 of 2026.
    expect(isoWeek("2025-12-29")).toEqual({ year: 2026, week: 1 });
  });
});

describe("enumerateBuckets — trailing contiguous buckets ending today", () => {
  it("daily: N contiguous UTC days, oldest→newest, ending today", () => {
    const b = enumerateBuckets("2026-07-15", "day", 3);
    expect(b.map((x) => x.periodStart)).toEqual(["2026-07-13", "2026-07-14", "2026-07-15"]);
  });

  it("monthly: N calendar months back, ending the current month", () => {
    const b = enumerateBuckets("2026-07-15", "month", 3);
    expect(b.map((x) => x.period)).toEqual(["2026-05", "2026-06", "2026-07"]);
    expect(b.map((x) => x.periodStart)).toEqual(["2026-05-01", "2026-06-01", "2026-07-01"]);
  });

  it("monthly: crosses a year boundary correctly", () => {
    const b = enumerateBuckets("2026-01-15", "month", 3);
    expect(b.map((x) => x.period)).toEqual(["2025-11", "2025-12", "2026-01"]);
  });

  it("weekly: N ISO weeks back on Monday boundaries, ending this week", () => {
    const b = enumerateBuckets("2026-07-15", "week", 3);
    expect(b.map((x) => x.periodStart)).toEqual(["2026-06-29", "2026-07-06", "2026-07-13"]);
    expect(b.every((x) => utcWeekday(x.periodStart) === 1)).toBe(true);
  });
});

describe("bucketizeSeries — distinct active orgs per bucket + growth", () => {
  it("counts DISTINCT orgs (an org active twice in a bucket counts once) and computes growth", () => {
    const buckets = enumerateBuckets("2026-07-15", "day", 3); // 13,14,15
    const orgDays = new Map<string, Set<string>>([
      ["orgA", new Set(["2026-07-13", "2026-07-14", "2026-07-15"])],
      ["orgB", new Set(["2026-07-14", "2026-07-14"])], // dup day → still one org
      ["orgC", new Set(["2026-07-15"])],
    ]);
    const series = bucketizeSeries(orgDays, buckets, "day");
    expect(series.map((s) => s.activeUsers)).toEqual([1, 2, 2]); // 13:{A} 14:{A,B} 15:{A,C}
    expect(series[0].growthPct).toBeNull(); // first bucket
    expect(series[1].growthPct).toBe(100); // 1→2
    expect(series[2].growthPct).toBe(0); // 2→2
  });

  it("an org active on two days of the SAME week is ONE weekly active user", () => {
    const buckets = enumerateBuckets("2026-07-15", "week", 1); // week of 07-13
    const orgDays = new Map<string, Set<string>>([["orgA", new Set(["2026-07-13", "2026-07-15"])]]);
    const series = bucketizeSeries(orgDays, buckets, "week");
    expect(series[0].activeUsers).toBe(1);
  });

  it("growthPct is null when the previous bucket is 0 (no % from zero base)", () => {
    const buckets = enumerateBuckets("2026-07-15", "day", 2); // 14,15
    const orgDays = new Map<string, Set<string>>([["orgA", new Set(["2026-07-15"])]]);
    const series = bucketizeSeries(orgDays, buckets, "day");
    expect(series.map((s) => s.activeUsers)).toEqual([0, 1]);
    expect(series[1].growthPct).toBeNull(); // 0→1 → null, never a false Infinity/100
  });

  it("days outside the displayed window are ignored", () => {
    const buckets = enumerateBuckets("2026-07-15", "day", 2); // 14,15
    const orgDays = new Map<string, Set<string>>([["orgA", new Set(["2026-01-01", "2026-07-15"])]]);
    const series = bucketizeSeries(orgDays, buckets, "day");
    expect(series.map((s) => s.activeUsers)).toEqual([0, 1]); // 01-01 dropped
  });
});

describe("buildActiveUsersHistory — integration via injected deps", () => {
  function deps(fixture: {
    orgs: string[];
    activeDays: Record<string, string[]>;
    currentTotal: number;
    capture?: { startedAfter?: string };
  }): ActiveUsersDeps {
    return {
      featureMemberships: async () => fixture.orgs.map((orgId) => ({ orgId })),
      orgActiveDays: async (orgId, _csv, startedAfterIso) => {
        if (fixture.capture) fixture.capture.startedAfter = startedAfterIso;
        return new Set(fixture.activeDays[orgId] ?? []);
      },
      currentActiveUserCount: async () => fixture.currentTotal,
    };
  }

  it("assembles monthly/weekly/daily distinct series + the live current total", async () => {
    const capture: { startedAfter?: string } = {};
    const history = await buildActiveUsersHistory(
      COLD,
      NOW,
      { days: 3, weeks: 2, months: 2 },
      deps({
        orgs: ["orgA", "orgB"],
        activeDays: {
          orgA: ["2026-07-15", "2026-07-06"], // this month + week; last daily bucket
          orgB: ["2026-06-20"], // last month, outside the 3-day + 2-week daily/weekly windows
        },
        currentTotal: 7,
        capture,
      }),
    );

    expect(history.currentTotal).toBe(7); // live verdict passthrough, NOT reconstructed
    expect(history.asOf).toBe("2026-07-15T12:00:00.000Z");

    // Monthly (2026-06, 2026-07): orgB in June, orgA in July.
    expect(history.monthly.map((m) => [m.period, m.activeUsers])).toEqual([
      ["2026-06", 1],
      ["2026-07", 1],
    ]);

    // Daily (07-13,07-14,07-15): only orgA on 07-15.
    expect(history.daily.map((d) => d.activeUsers)).toEqual([0, 0, 1]);

    // startedAfter lower bound spans the widest (monthly) window → 2026-06-01.
    expect(capture.startedAfter).toBe("2026-06-01T00:00:00.000Z");
  });

  it("empty cold-email universe → zero series + zero current total, never throws", async () => {
    const history = await buildActiveUsersHistory("", NOW, { days: 2, weeks: 1, months: 1 }, deps({ orgs: [], activeDays: {}, currentTotal: 0 }));
    expect(history.currentTotal).toBe(0);
    expect(history.daily.every((d) => d.activeUsers === 0)).toBe(true);
    expect(history.monthly.length).toBe(1);
  });
});
