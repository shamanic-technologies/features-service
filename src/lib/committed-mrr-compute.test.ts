import { describe, it, expect } from "vitest";

import { buildCommittedMrrHistory, bucketizeCommitted } from "./committed-mrr-compute.js";
import { enumerateBuckets, bucketOf } from "./active-users-compute.js";

const NOW = new Date("2026-07-15T12:00:00Z"); // Wednesday

describe("bucketizeCommitted — last-snapshot-per-period, current = live, omit empty", () => {
  it("takes the LAST snapshot in each period; current period uses the live MRR; ARR = MRR × 12", () => {
    const buckets = enumerateBuckets("2026-07-15", "month", 3); // 05, 06, 07
    const series = bucketizeCommitted(
      [
        { date: "2026-05-05", mrrUsd: 800 },
        { date: "2026-05-25", mrrUsd: 1000 }, // later May snapshot wins
        { date: "2026-06-15", mrrUsd: 2000 },
      ],
      buckets,
      "month",
      bucketOf("2026-07-15", "month").periodStart,
      3000, // live July
    );
    expect(series.map((s) => [s.period, s.mrrUsd, s.arrUsd])).toEqual([
      ["2026-05", 1000, 12000],
      ["2026-06", 2000, 24000],
      ["2026-07", 3000, 36000],
    ]);
  });

  it("OMITS periods with no recorded snapshot (no fabrication / carry-forward), growth vs previous EMITTED", () => {
    const buckets = enumerateBuckets("2026-07-15", "month", 4); // 04,05,06,07
    const series = bucketizeCommitted(
      [{ date: "2026-05-10", mrrUsd: 1000 }], // only May recorded; April + June absent
      buckets,
      "month",
      bucketOf("2026-07-15", "month").periodStart,
      1500,
    );
    // April omitted (no snapshot), May from snapshot, June omitted, July = live. Growth May→null, July vs May.
    expect(series.map((s) => s.period)).toEqual(["2026-05", "2026-07"]);
    expect(series.map((s) => s.growthPct)).toEqual([null, 50]); // 1000 → 1500
  });

  it("current period always emits even with zero snapshots (its point is the live value)", () => {
    const buckets = enumerateBuckets("2026-07-15", "week", 2);
    const series = bucketizeCommitted([], buckets, "week", bucketOf("2026-07-15", "week").periodStart, 500);
    expect(series).toHaveLength(1);
    expect(series[0].mrrUsd).toBe(500);
    expect(series[0].growthPct).toBeNull();
  });

  it("growth is null off a 0 base, never Infinity", () => {
    const buckets = enumerateBuckets("2026-07-15", "month", 2); // 06, 07
    const series = bucketizeCommitted(
      [{ date: "2026-06-10", mrrUsd: 0 }],
      buckets,
      "month",
      bucketOf("2026-07-15", "month").periodStart,
      1000,
    );
    expect(series.map((s) => [s.period, s.mrrUsd, s.growthPct])).toEqual([
      ["2026-06", 0, null],
      ["2026-07", 1000, null], // 0 → 1000 → null (no % from zero base)
    ]);
  });
});

describe("buildCommittedMrrHistory — monthly + weekly, current reconciles + ARR ×12", () => {
  it("current-period point equals the live MRR on BOTH grains; ARR = MRR × 12", () => {
    const history = buildCommittedMrrHistory(
      [{ date: "2026-06-01", mrrUsd: 900 }],
      2400.5,
      NOW,
      { weeks: 3, months: 3 },
    );
    expect(history.currentMrrUsd).toBe(2400.5);
    expect(history.currentArrUsd).toBe(2400.5 * 12);
    expect(history.monthly[history.monthly.length - 1]).toMatchObject({ period: "2026-07", mrrUsd: 2400.5, arrUsd: 2400.5 * 12 });
    expect(history.weekly[history.weekly.length - 1].mrrUsd).toBe(2400.5);
    expect(history.weekly[history.weekly.length - 1].arrUsd).toBe(2400.5 * 12);
  });

  it("empty snapshots → each grain has only the current period (series starts at first real point)", () => {
    const history = buildCommittedMrrHistory([], 100, NOW, { weeks: 4, months: 6 });
    expect(history.monthly).toHaveLength(1);
    expect(history.weekly).toHaveLength(1);
    expect(history.monthly[0]).toMatchObject({ period: "2026-07", mrrUsd: 100, arrUsd: 1200 });
  });
});
