import { describe, it, expect, vi } from "vitest";

// nrr-compute imports active-users-compute for the bucket helpers, which transitively pulls
// accounts-compute → the db module. Stub it so this pure-logic suite needs no DB connection.
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildNrrSeries, buildNetRevenueRetention } from "./nrr-compute.js";

const TODAY = "2026-07-15"; // Wednesday

/** Build the per-org day→cents map shape the revenue history produces. */
function orgs(spec: Record<string, Record<string, number>>): Map<string, Map<string, number>> {
  return new Map(Object.entries(spec).map(([orgId, days]) => [orgId, new Map(Object.entries(days))]));
}

describe("buildNrrSeries — the standard aggregate NRR definition", () => {
  it("divides the prior-period cohort's CURRENT revenue by its PRIOR revenue", () => {
    // Cohort at the start of July = {a, b} (both billed in June).
    // June: a 100_00, b 200_00 → 300_00.  July: a 150_00, b 150_00 → 300_00.  NRR = 100%.
    const series = buildNrrSeries(
      orgs({
        a: { "2026-06-10": 100_00, "2026-07-02": 150_00 },
        b: { "2026-06-20": 200_00, "2026-07-09": 150_00 },
      }),
      TODAY,
      "month",
      1,
    );
    expect(series).toEqual([
      { period: "2026-07", periodStart: "2026-07-01", retentionPct: 100, cohortSize: 2, priorRevenueUsd: 300, retainedRevenueUsd: 300 },
    ]);
  });

  it("counts EXPANSION above 100 and CONTRACTION below, with no extra computation", () => {
    const expansion = buildNrrSeries(orgs({ a: { "2026-06-10": 100_00, "2026-07-02": 125_00 } }), TODAY, "month", 1);
    expect(expansion[0].retentionPct).toBe(125);

    const contraction = buildNrrSeries(orgs({ a: { "2026-06-10": 100_00, "2026-07-02": 40_00 } }), TODAY, "month", 1);
    expect(contraction[0].retentionPct).toBe(40);
  });

  it("EXCLUDES a customer acquired DURING the period from both legs (NRR is not a growth rate)", () => {
    // `newLogo` first bills in July. Including it would read 300% instead of the true 100%.
    const series = buildNrrSeries(
      orgs({
        existing: { "2026-06-10": 100_00, "2026-07-02": 100_00 },
        newLogo: { "2026-07-05": 200_00 },
      }),
      TODAY,
      "month",
      1,
    );
    expect(series[0]).toMatchObject({ retentionPct: 100, cohortSize: 1, priorRevenueUsd: 100, retainedRevenueUsd: 100 });
  });

  it("a fully CHURNED base reads a measured 0, distinguishable from unmeasurable", () => {
    const series = buildNrrSeries(orgs({ a: { "2026-06-10": 100_00 } }), TODAY, "month", 1);
    expect(series[0]).toMatchObject({ retentionPct: 0, cohortSize: 1, priorRevenueUsd: 100, retainedRevenueUsd: 0 });
  });

  it("a period with NO prior-period cohort is NULL — never 0, never carried forward", () => {
    // May and June have no revenue at all; only July does. May + June + July requested.
    const series = buildNrrSeries(
      orgs({ a: { "2026-04-10": 50_00, "2026-07-02": 100_00 } }),
      TODAY,
      "month",
      3,
    );
    expect(series.map((s) => [s.period, s.retentionPct, s.cohortSize])).toEqual([
      ["2026-05", 0, 1], // April cohort existed and churned → MEASURED zero
      ["2026-06", null, 0], // May had no revenue → no cohort → unmeasurable
      ["2026-07", null, 0], // June had no revenue → unmeasurable, NOT the 0 above carried forward
    ]);
  });

  it("the OLDEST displayed period still gets a real cohort from the period BEFORE the window", () => {
    // 1-month window ending July: the June cohort comes from data outside the displayed window.
    const series = buildNrrSeries(orgs({ a: { "2026-05-10": 100_00, "2026-06-10": 80_00 } }), TODAY, "month", 2);
    expect(series.map((s) => [s.period, s.retentionPct])).toEqual([
      ["2026-06", 80],
      ["2026-07", 0],
    ]);
  });

  it("recomputing by hand from the per-org spend reproduces the served rate exactly", () => {
    const data = orgs({
      a: { "2026-06-03": 33_33, "2026-07-01": 66_66 },
      b: { "2026-06-04": 66_67, "2026-07-08": 10_00 },
      c: { "2026-07-08": 999_99 }, // acquired in July — excluded from both legs
    });
    const series = buildNrrSeries(data, TODAY, "month", 1);
    const prior = 33_33 + 66_67;
    const retained = 66_66 + 10_00;
    expect(series[0].retentionPct).toBe(Math.round((retained / prior) * 1000) / 10);
    expect(series[0].priorRevenueUsd).toBe(prior / 100);
    expect(series[0].retainedRevenueUsd).toBe(retained / 100);
  });

  it("works at the WEEKLY grain on ISO weeks", () => {
    // 2026-07-15 is a Wednesday → its ISO week starts Mon 2026-07-13; the prior week starts 2026-07-06.
    const series = buildNrrSeries(
      orgs({ a: { "2026-07-07": 100_00, "2026-07-14": 50_00 } }),
      TODAY,
      "week",
      1,
    );
    expect(series[0]).toMatchObject({ periodStart: "2026-07-13", retentionPct: 50, cohortSize: 1 });
  });
});

describe("buildNetRevenueRetention — both grains, one point per revenue bucket", () => {
  it("emits exactly `months` monthly points and `weeks` weekly points", () => {
    const nrr = buildNetRevenueRetention(orgs({ a: { "2026-06-10": 100_00, "2026-07-02": 90_00 } }), TODAY, { weeks: 4, months: 3 });
    expect(nrr.monthly).toHaveLength(3);
    expect(nrr.weekly).toHaveLength(4);
    expect(nrr.monthly.at(-1)).toMatchObject({ period: "2026-07", retentionPct: 90 });
  });

  it("returns unmeasurable (null) everywhere when there is no revenue at all", () => {
    const nrr = buildNetRevenueRetention(new Map(), TODAY, { weeks: 2, months: 2 });
    expect(nrr.monthly.every((b) => b.retentionPct === null && b.cohortSize === 0)).toBe(true);
    expect(nrr.weekly.every((b) => b.retentionPct === null)).toBe(true);
  });
});
