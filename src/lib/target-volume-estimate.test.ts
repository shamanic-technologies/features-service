import { describe, expect, it } from "vitest";
import { volumeEstimateModelOf, volumeEstimateOf, type VolumeEstimateInput } from "./target-volume-estimate.js";
import type { DelayDistribution, EntryCostStat, TransitionStat } from "./outcome-silver.js";

// A delay curve with half the Units through by `medianHours`, exponential, as Silver stores one.
const delay = (medianHours: number, n: number): DelayDistribution => {
  const cdf: Array<{ hours: number; share: number }> = [];
  for (let h = 24; h <= 24 * 200; h += 24) cdf.push({ hours: h, share: 1 - Math.pow(2, -h / medianHours) });
  cdf.push({ hours: 24 * 365, share: 1 });
  return { n, medianHours, cdf } as unknown as DelayDistribution;
};
const stat = (fromUnits: number, toUnits: number, exposure: number, d: DelayDistribution | null): TransitionStat =>
  ({ fromUnits, toUnits, linkedToUnits: toUnits, linkCoverage: 1, exposure, delay: d }) as unknown as TransitionStat;

// Prod fleet Silver, 2026-11-22: all in $1,902.53 over 26,199 first-milestone Units (40 campaigns); A -> B 70 over 19,981
// exposure (median 228 h, 68 pairs); B -> C 2 over 69.8 (median 12 h, 8 pairs).
const FLEET: Record<string, TransitionStat> = {
  "a>b": stat(26199, 70, 19981.3, delay(228.4, 68)),
  "b>c": stat(75, 2, 69.8, delay(12, 8)),
};
const FLEET_ENTRY: EntryCostStat = { campaigns: 40, units: 26199, spendUsd: 1902.53 };

const input = (over: Partial<VolumeEstimateInput> = {}): VolumeEstimateInput => ({
  seed: "brand|offer|f1+f2|c",
  milestones: [
    { step: "a", label: "A", ledgerKeys: ["a"] },
    { step: "b", label: "B", ledgerKeys: ["b"] },
    { step: "c", label: "C", ledgerKeys: ["c"] },
  ],
  planRates: [
    { ratePct: 1, basis: "default" },
    { ratePct: 20, basis: "default" },
  ],
  planCostPerTargetUsd: 120,
  planCostBasis: "fleet",
  transition: (scope, a, b) => (scope === "fleet" ? FLEET[`${a}>${b}`] ?? null : null),
  entryCost: (scope) => (scope === "fleet" ? FLEET_ENTRY : null),
  silverComputedAt: "2026-11-22T05:00:00.000Z",
  ...over,
});

describe("volumeEstimateModelOf (ONE-CAMPAIGN-VOLUME-1122)", () => {
  it("serves a 20-80% interval of one Target Unit's all-in cost, never a single point", () => {
    const m = volumeEstimateModelOf(input());
    expect(m.unavailableReason).toBeNull();
    expect(m.perUnit!.lowUsd).toBeGreaterThan(0);
    expect(m.perUnit!.lowUsd).toBeLessThan(m.perUnit!.medianUsd);
    expect(m.perUnit!.medianUsd).toBeLessThan(m.perUnit!.highUsd);
    // The entry cost is the fleet's all in ($0.0726 per first-milestone Unit), the fleet's thin evidence still outweighs the plan line: fleet, expected.
    expect((m.hypotheses as { entryCost: { source: string; usdPerUnit: number } }).entryCost).toMatchObject({ source: "fleet", usdPerUnit: 0.0726184 });
    expect(m.basis).toBe("fleet");
    expect(m.isExpected).toBe(true);
    // Same inputs, same interval (seeded draws).
    expect(volumeEstimateModelOf(input()).perUnit).toEqual(m.perUnit);
  });

  it("the brand's own measurements take over once they hold many cases (basis measured, interval tightens)", () => {
    const many = (s: TransitionStat) => stat(s.fromUnits * 50, s.toUnits * 50, s.exposure * 50, delay(100, 500));
    const m = volumeEstimateModelOf(
      input({
        transition: (scope, a, b) => (scope === "brand" ? many(FLEET[`${a}>${b}`]!) : FLEET[`${a}>${b}`] ?? null),
        entryCost: () => FLEET_ENTRY,
      }),
    );
    expect(m.basis).toBe("measured");
    expect(m.isExpected).toBe(false);
    const thin = volumeEstimateModelOf(input());
    expect(m.perUnit!.highUsd / m.perUnit!.lowUsd).toBeLessThan(thin.perUnit!.highUsd / thin.perUnit!.lowUsd);
  });

  it("with nothing measured anywhere: the plan line alone, an expected figure (never blank)", () => {
    const m = volumeEstimateModelOf(input({ transition: () => null, entryCost: () => null }));
    expect(m.unavailableReason).toBeNull();
    // Plan: $120 per Target, 1 / (1% × 20%) = 500 first-milestone Units per Target: $0.24 each.
    expect((m.hypotheses as { entryCost: { source: string; usdPerUnit: number } }).entryCost).toMatchObject({ source: "plan", usdPerUnit: 0.24 });
    expect(m.perUnit!.lowUsd).toBeLessThan(120);
    expect(m.perUnit!.highUsd).toBeGreaterThan(120);
    expect(m.isExpected).toBe(true);
  });

  it("names why when nothing prices a transition", () => {
    const m = volumeEstimateModelOf(input({ transition: () => null, planRates: [{ ratePct: null, basis: null }, { ratePct: 20, basis: "default" }] }));
    expect(m.perUnit).toBeNull();
    expect(m.unavailableReason).toBe("yield_unknown:a->b");
  });
});

describe("volumeEstimateOf", () => {
  it("owner's worked example: 10 per week at $9 / $26 per Unit = $90 to $260 a week, max $260", () => {
    const ramp = Array.from({ length: 26 }, (_, w) => Math.min(1, w * 0.25));
    const v = volumeEstimateOf({ perUnit: { lowUsd: 9, highUsd: 26, medianUsd: 15 }, rampShareByWeek: ramp, unavailableReason: null }, 10, "week");
    expect(v.budget).toEqual({ period: "week", lowUsd: 90, highUsd: 260, maxUsd: 260, unavailableReason: null });
    // Week 1 makes nothing, week 2 a quarter (2.5): the first Units land in week 2, steady (≥ 80%) from week 5.
    expect(v.timing.firstUnitsWeek).toBe(2);
    expect(v.timing.steadyFromWeek).toBe(5);
    expect(v.timing.steadyPerPeriod).toBe(10);
  });

  it("the period scales the pace, not the per-Unit cost", () => {
    const m = { perUnit: { lowUsd: 9, highUsd: 26, medianUsd: 15 }, rampShareByWeek: Array.from({ length: 26 }, () => 1), unavailableReason: null };
    expect(volumeEstimateOf(m, 2, "day").budget).toMatchObject({ period: "day", lowUsd: 18, highUsd: 52 });
    expect(volumeEstimateOf(m, 2, "day").timing.weeks[0]!.expectedUnits).toBe(14);
    expect(volumeEstimateOf(m, 30, "month").timing.weeks[0]!.expectedUnits).toBeCloseTo((30 * 7) / (365 / 12), 4);
  });

  it("prod-like fleet: 10 per week answers a range, a first week and a steady week", () => {
    const m = volumeEstimateModelOf(input());
    const v = volumeEstimateOf(m, 10, "week");
    expect(v.budget.lowUsd).toBeGreaterThan(0);
    expect(v.budget.highUsd!).toBeGreaterThan(v.budget.lowUsd!);
    expect(v.timing.firstUnitsWeek).toBeGreaterThanOrEqual(1);
    expect(v.timing.weeks).toHaveLength(26);
  });
});
