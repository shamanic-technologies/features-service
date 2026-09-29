import { describe, it, expect, vi } from "vitest";

// active-users-compute (imported for bucket helpers) transitively pulls accounts-compute → the db module.
// Stub it so this pure-logic suite needs no DB connection.
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildCommittedMrrHistory, bucketizeCommitted, mergeMrrSnapshots } from "./committed-mrr-compute.js";
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
      { mrrUsd: 3000, unknownOrgCount: 0 }, // live July
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
      [{ date: "2026-05-10", mrrUsd: 1000, basis: "billing_recurring" }], // only May recorded; April + June absent
      buckets,
      "month",
      bucketOf("2026-07-15", "month").periodStart,
      { mrrUsd: 1500, unknownOrgCount: 0 },
    );
    // April omitted (no snapshot), May from snapshot, June omitted, July = live. Growth May→null, July vs May.
    expect(series.map((s) => s.period)).toEqual(["2026-05", "2026-07"]);
    expect(series.map((s) => s.growthPct)).toEqual([null, 50]); // 1000 → 1500
  });

  it("current period always emits even with zero snapshots (its point is the live value)", () => {
    const buckets = enumerateBuckets("2026-07-15", "week", 2);
    const series = bucketizeCommitted([], buckets, "week", bucketOf("2026-07-15", "week").periodStart, { mrrUsd: 500, unknownOrgCount: 0 });
    expect(series).toHaveLength(1);
    expect(series[0].mrrUsd).toBe(500);
    expect(series[0].growthPct).toBeNull();
  });

  it("growth is null off a 0 base, never Infinity", () => {
    const buckets = enumerateBuckets("2026-07-15", "month", 2); // 06, 07
    const series = bucketizeCommitted(
      [{ date: "2026-06-10", mrrUsd: 0, basis: "billing_recurring" }],
      buckets,
      "month",
      bucketOf("2026-07-15", "month").periodStart,
      { mrrUsd: 1000, unknownOrgCount: 0 },
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
      { mrrUsd: 2400.5, unknownOrgCount: 0 },
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
    const history = buildCommittedMrrHistory([], { mrrUsd: 100, unknownOrgCount: 0 }, NOW, { weeks: 4, months: 6 });
    expect(history.monthly).toHaveLength(1);
    expect(history.weekly).toHaveLength(1);
    expect(history.monthly[0]).toMatchObject({ period: "2026-07", mrrUsd: 100, arrUsd: 1200 });
  });
});

describe("the 2026-09-29 basis change — billing's recurring MRR from the first billing day, never mixed silently", () => {
  const TODAY = new Date("2026-10-14T12:00:00Z");

  it("keeps legacy points BEFORE the first billing day, drops any on/after it, and states the switch", () => {
    const merged = mergeMrrSnapshots(
      [
        { date: "2026-08-31", mrrUsd: 2610 },
        { date: "2026-09-29", mrrUsd: 2700 }, // same day as the first billing record: dropped
        { date: "2026-09-30", mrrUsd: 2800 }, // after the switch: dropped (never written again)
      ],
      [{ date: "2026-09-29", mrrUsd: 990, basis: "billing_recurring", unknownOrgCount: 1 }],
    );
    expect(merged.basisChangedOn).toBe("2026-09-29");
    expect(merged.snapshots.map((s) => [s.date, s.mrrUsd, s.basis])).toEqual([
      ["2026-08-31", 2610, "running_budget_x30"],
      ["2026-09-29", 990, "billing_recurring"],
    ]);
  });

  it("every bucket names its basis, growth is never read across the basis change, and the live point reconciles", () => {
    const { snapshots, basisChangedOn } = mergeMrrSnapshots(
      [{ date: "2026-08-31", mrrUsd: 2610 }],
      [{ date: "2026-09-30", mrrUsd: 990, basis: "billing_recurring", unknownOrgCount: 0 }],
    );
    const h = buildCommittedMrrHistory(snapshots, { mrrUsd: 1188, unknownOrgCount: 2 }, TODAY, { weeks: 2, months: 3 }, basisChangedOn);
    expect(h.basisChangedOn).toBe("2026-09-30");
    expect(h.monthly.map((b) => [b.period, b.mrrUsd, b.basis, b.growthPct])).toEqual([
      ["2026-08", 2610, "running_budget_x30", null],
      ["2026-09", 990, "billing_recurring", null], // a basis change is not a −62% month
      ["2026-10", 1188, "billing_recurring", 20],
    ]);
    expect(h.currentMrrUsd).toBe(1188);
    expect(h.currentArrUsd).toBe(1188 * 12);
    expect(h.monthly[2].unknownOrgCount).toBe(2);
  });

  it("an unavailable billing read is a NULL point, never a zero and never the old computation", () => {
    const h = buildCommittedMrrHistory([], { mrrUsd: null, unknownOrgCount: 0 }, TODAY, { weeks: 1, months: 1 });
    expect(h.currentMrrUsd).toBeNull();
    expect(h.currentArrUsd).toBeNull();
    expect(h.monthly[0]).toMatchObject({ mrrUsd: null, arrUsd: null, basis: "billing_recurring", growthPct: null });
  });
});
