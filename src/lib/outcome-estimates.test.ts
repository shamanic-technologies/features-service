import { describe, expect, it } from "vitest";
import { betaQuantile, effectiveExposure, estimateOutcomes, fitBetaPrior, incompleteBeta, lagCurveOf } from "./outcome-estimates.js";

describe("estimated rate and cost per outcome (COST-ACCOUNTING-1023-P3)", () => {
  // half of the replies on day 1, then 10% a day for 4 days, 10% after day 21 (22 bins: Day 1..21 + 21+)
  const bins = [50, 10, 10, 10, 10, ...Array(16).fill(0), 10].map((count) => ({ count }));
  const F = lagCurveOf(bins);

  it("the delay curve: 0 at age 0, the bins' running share, 1 by the tail's end", () => {
    expect(F(0)).toBe(0);
    expect(F(1)).toBeCloseTo(0.5, 10);
    expect(F(5)).toBeCloseTo(0.9, 10);
    expect(F(21)).toBeCloseTo(0.9, 10);
    expect(F(60)).toBe(1);
    expect(F(40)).toBeGreaterThan(0.9);
  });

  it("a young cohort counts for the share of its replies already due (censoring)", () => {
    // 100 people served yesterday + 100 served 30 days ago
    expect(effectiveExposure([{ contacted: 100, ageDays: 1 }, { contacted: 100, ageDays: 30 }], F)).toBeCloseTo(50 + 100 * F(30), 8);
  });

  it("incomplete beta and its quantiles are right", () => {
    expect(incompleteBeta(0.5, 2, 2)).toBeCloseTo(0.5, 10);
    expect(incompleteBeta(0.3, 1, 1)).toBeCloseTo(0.3, 10);
    expect(betaQuantile(0.975, 1, 1)).toBeCloseTo(0.975, 8);
    // Beta(3, 97) 95% interval, checked by direct numeric integration of the density: 0.629% .. 7.108%
    expect(betaQuantile(0.025, 3, 97)).toBeCloseTo(0.006293, 5);
    expect(betaQuantile(0.975, 3, 97)).toBeCloseTo(0.071076, 5);
  });

  it("a small workflow is drawn toward the pipe, a big one keeps its own rate", () => {
    const groups = [
      { key: "big", outcomes: 100, exposure: 10_000, contacted: 10_000, spendUsd: 1000 },
      { key: "mid", outcomes: 20, exposure: 3000, contacted: 3000, spendUsd: 300 },
      { key: "tiny", outcomes: 0, exposure: 40, contacted: 40, spendUsd: 4 },
    ];
    const { estimates } = estimateOutcomes(groups);
    const by = new Map(estimates.map((e) => [e.key, e]));
    expect(by.get("big")!.ratePct).toBeCloseTo(1, 1);
    // 0 of 40 is not 0%: pulled toward the pipe's ~0.9%
    expect(by.get("tiny")!.ratePct).toBeGreaterThan(0.3);
    expect(by.get("tiny")!.rateLowPct).toBeLessThan(by.get("tiny")!.ratePct);
    expect(by.get("tiny")!.rateHighPct).toBeGreaterThan(by.get("tiny")!.ratePct);
    // cost = spend / (contacted x rate), interval inverted
    const b = by.get("big")!;
    expect(b.costPerOutcomeUsd).toBeCloseTo(1000 / (10_000 * (b.ratePct / 100)), 6);
    expect(b.costLowUsd!).toBeLessThan(b.costPerOutcomeUsd!);
    expect(b.costHighUsd!).toBeGreaterThan(b.costPerOutcomeUsd!);
  });

  it("one group = a weak prior on its own rate; no spend = no cost", () => {
    expect(fitBetaPrior([{ key: "a", outcomes: 5, exposure: 500, contacted: 500, spendUsd: 0 }])).toMatchObject({ alpha: expect.closeTo(0.02, 6) });
    expect(estimateOutcomes([{ key: "a", outcomes: 5, exposure: 500, contacted: 500, spendUsd: 0 }]).estimates[0]!.costPerOutcomeUsd).toBeNull();
  });
});
