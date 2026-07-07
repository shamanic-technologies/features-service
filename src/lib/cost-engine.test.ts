import { describe, it, expect } from "vitest";
import { observedCostPerOutcome, projectedCostPerOutcome } from "./cost-engine.js";

describe("cost-engine — observedCostPerOutcome (accounting: real, null on 0)", () => {
  it("real ratio when spend and outcomes present", () => {
    expect(observedCostPerOutcome(100, 4)).toBe(25);
  });

  it("null when 0 outcomes (never a false $0)", () => {
    expect(observedCostPerOutcome(100, 0)).toBeNull();
  });

  it("null when 0 spend", () => {
    expect(observedCostPerOutcome(0, 4)).toBeNull();
  });
});

describe("cost-engine — projectedCostPerOutcome (rankable: cascade floor, never null)", () => {
  it("real ratio when outcomes present — parent is ignored", () => {
    expect(projectedCostPerOutcome(100, 4, 999)).toBe(25);
  });

  it("0 SPEND but outcomes present (cost un-attributed) → NOT a false $0; floors to parent", () => {
    expect(projectedCostPerOutcome(0, 4, 30)).toBe(30); // clicks tracked, cost untagged → assume parent
    expect(projectedCostPerOutcome(0, 4, null)).toBe(0); // no parent → 0 (no evidence at all)
  });

  it("0 outcomes, no parent → floor to own spend", () => {
    expect(projectedCostPerOutcome(120, 0)).toBe(120);
    expect(projectedCostPerOutcome(5, 0, null)).toBe(5);
  });

  it("0 outcomes, spend BELOW parent → assume the parent cost (not yet proven worse)", () => {
    // $5 spent, 0 outcomes, parent cpc $30 → $30
    expect(projectedCostPerOutcome(5, 0, 30)).toBe(30);
  });

  it("0 outcomes, spend ABOVE parent → own spend is the higher conservative floor", () => {
    // $120 spent, 0 outcomes, parent cpc $30 → $120
    expect(projectedCostPerOutcome(120, 0, 30)).toBe(120);
  });

  it("never null — always a comparable number at any spend", () => {
    expect(projectedCostPerOutcome(0, 0, null)).toBe(0);
    expect(projectedCostPerOutcome(0, 0, 30)).toBe(30);
  });
});
