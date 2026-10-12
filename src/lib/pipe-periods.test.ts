import { describe, expect, it } from "vitest";
import { buildPipePeriods } from "./pipe-periods.js";

const dated = (days: Record<string, number>, undated = 0) => ({ daily: new Map(Object.entries(days)), undated });
const pairs = [{ key: "reachedFrom_to_outcomes", fromKey: "reachedFrom", toKey: "outcomes" }];

describe("a pipe's figures by calendar period (owner 2026-10-12, PIPE-PERIODS-1012)", () => {
  it("reproduces the owner's hand table: per quarter and month, not cumulative, plus a since-inception row", () => {
    const p = buildPipePeriods({
      counts: [
        { key: "reachedFrom", counts: dated({ "2024-12-06": 2, "2026-01-10": 50, "2026-03-31": 32, "2026-04-02": 47, "2026-10-05": 7 }, 1) },
        { key: "outcomes", counts: dated({ "2024-12-06": 1, "2026-01-10": 40, "2026-03-31": 21, "2026-04-02": 18 }) },
      ],
      ratePairs: pairs,
      outcomeKey: "outcomes",
      spendByDay: null,
      today: "2026-10-12",
    });
    expect(p.total).toMatchObject({ period: "since_inception", label: "Since Dec 2024", startDate: "2024-12-06", endDate: "2026-10-12", counts: { reachedFrom: 139, outcomes: 80 }, spendUsd: null, costPerOutcomeUsd: null });
    expect(p.total.ratesPct.reachedFrom_to_outcomes).toBe(57.55);
    const q1 = p.quarters.find((q) => q.period === "2026-Q1")!;
    expect(q1).toMatchObject({ label: "Q1 2026", startDate: "2026-01-01", endDate: "2026-03-31", counts: { reachedFrom: 82, outcomes: 61 }, ratesPct: { reachedFrom_to_outcomes: 74.39 } });
    // Every period from the first one to today's is listed, oldest first; an empty one reads 0 with a null rate.
    expect(p.quarters.map((q) => q.period)).toEqual(["2024-Q4", "2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4", "2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"]);
    const q3 = p.quarters.find((q) => q.period === "2026-Q3")!;
    expect(q3.counts).toEqual({ reachedFrom: 0, outcomes: 0 });
    expect(q3.ratesPct.reachedFrom_to_outcomes).toBeNull();
    expect(q3.rateUnavailableReasons.reachedFrom_to_outcomes).toBe("no_input_yet");
    const oct = p.months.at(-1)!;
    expect(oct).toMatchObject({ period: "2026-10", label: "Oct 2026", counts: { reachedFrom: 7, outcomes: 0 }, ratesPct: { reachedFrom_to_outcomes: 0 } });
    expect(p.months).toHaveLength(23);
    // Undated counts are in no period: the periods sum to the total minus them.
    expect(p.quarters.reduce((a, q) => a + (q.counts.reachedFrom ?? 0), 0)).toBe(139 - 1);
  });

  it("serves spend and cost per outcome per period where the pipe has spend; unmeasured counts stay null", () => {
    const p = buildPipePeriods({
      counts: [
        { key: "handed", counts: dated({ "2026-09-03": 10, "2026-10-01": 4 }) },
        { key: "outcomes", counts: dated({ "2026-09-20": 2 }) },
        { key: "unmeasured", counts: null },
      ],
      ratePairs: [{ key: "handed_to_outcomes", fromKey: "handed", toKey: "outcomes" }],
      outcomeKey: "outcomes",
      spendByDay: new Map([["2026-09-03", 3], ["2026-10-02", 1.5]]),
      today: "2026-10-12",
    });
    const sep = p.months.find((m) => m.period === "2026-09")!;
    expect(sep).toMatchObject({ spendUsd: 3, costPerOutcomeUsd: 1.5, counts: { handed: 10, outcomes: 2, unmeasured: null }, ratesPct: { handed_to_outcomes: 20 } });
    const oct = p.months.find((m) => m.period === "2026-10")!;
    expect(oct).toMatchObject({ spendUsd: 1.5, costPerOutcomeUsd: null });
    expect(p.total).toMatchObject({ spendUsd: 4.5, costPerOutcomeUsd: 2.25 });
  });

  it("nothing dated: only the total row", () => {
    const p = buildPipePeriods({ counts: [{ key: "outcomes", counts: dated({}, 3) }], ratePairs: [], outcomeKey: "outcomes", spendByDay: new Map(), today: "2026-10-12" });
    expect(p.quarters).toEqual([]);
    expect(p.months).toEqual([]);
    expect(p.total).toMatchObject({ label: "Since inception", startDate: null, counts: { outcomes: 3 } });
  });
});
