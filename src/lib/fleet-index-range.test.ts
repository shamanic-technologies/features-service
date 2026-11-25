import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  betaQuantile,
  clientMedianRange,
  conversionRateRange,
  costPerOutcomeRange,
  gammaQuantile,
  indexValueRange,
  meetingChainRange,
  type RangePointInput,
} from "./fleet-index-range.js";
import { engagedLeadPoint } from "./fleet-indexes.js";

const point = (over: Partial<RangePointInput>): RangePointInput => ({
  indexSlug: "cold-email-cost-per-positive-reply",
  day: "2026-11-24",
  metric: "cost_per_outcome",
  outcome: "positive_reply",
  value: 10,
  outcomes: 10,
  contacted: 1000,
  inputs: {},
  ...over,
});

describe("numerics", () => {
  it("Gamma quantiles match known values", () => {
    // Gamma(1) is Exp(1): q = -ln(1 - p).
    expect(gammaQuantile(1, 0.2)).toBeCloseTo(-Math.log(0.8), 6);
    expect(gammaQuantile(1, 0.8)).toBeCloseTo(-Math.log(0.2), 6);
    // Gamma(10.5): median ~ 10.17.
    expect(gammaQuantile(10.5, 0.5)).toBeCloseTo(10.17, 1);
  });

  it("Beta quantiles match known values", () => {
    // Beta(1,1) is uniform.
    expect(betaQuantile(1, 1, 0.2)).toBeCloseTo(0.2, 6);
    // Beta(0.5, 0.5) is the arcsine law: q = sin²(πp/2).
    expect(betaQuantile(0.5, 0.5, 0.8)).toBeCloseTo(Math.sin((Math.PI * 0.8) / 2) ** 2, 5);
  });
});

describe("cost per outcome (Jeffreys Gamma on the outcome count)", () => {
  it("0 outcomes: no range", () => {
    expect(costPerOutcomeRange(5, 0)).toBeNull();
  });

  it("1 outcome: wide, around the value", () => {
    const r = costPerOutcomeRange(100, 1)!;
    expect(r.low).toBeLessThanOrEqual(100);
    expect(r.high).toBeGreaterThanOrEqual(100);
    expect(r.low).toBeCloseTo(100 / gammaQuantile(1.5, 0.8), 6);
    expect(r.high).toBeCloseTo(100 / gammaQuantile(1.5, 0.2), 6);
    expect(r.high / r.low).toBeGreaterThan(3);
  });

  it("few outcomes: wider than many outcomes", () => {
    const few = costPerOutcomeRange(4, 3)!;
    const many = costPerOutcomeRange(4, 300)!;
    expect(few.high - few.low).toBeGreaterThan(many.high - many.low);
    for (const r of [few, many]) {
      expect(r.low).toBeLessThanOrEqual(4);
      expect(r.high).toBeGreaterThanOrEqual(4);
    }
    // 300 outcomes: about ±5% (z(0.8) / sqrt(300)).
    expect(many.high / 4).toBeLessThan(1.06);
    expect(many.low / 4).toBeGreaterThan(0.94);
  });
});

describe("conversion rate (Jeffreys interval)", () => {
  it("0 outcomes: low is 0, high above 0", () => {
    const r = conversionRateRange(0, 0, 500)!;
    expect(r.low).toBe(0);
    expect(r.high).toBeGreaterThan(0);
    expect(r.high).toBeCloseTo(100 * betaQuantile(0.5, 500.5, 0.8), 8);
  });

  it("few outcomes: brackets the value", () => {
    const r = conversionRateRange(0.4, 2, 500)!;
    expect(r.low).toBeLessThanOrEqual(0.4);
    expect(r.high).toBeGreaterThanOrEqual(0.4);
    expect(r.low).toBeGreaterThan(0);
  });

  it("no people emailed or more outcomes than people: no range", () => {
    expect(conversionRateRange(0, 0, 0)).toBeNull();
    expect(conversionRateRange(150, 3, 2)).toBeNull();
  });

  it("every outcome: high is 100", () => {
    expect(conversionRateRange(100, 4, 4)!.high).toBe(100);
  });
});

describe("chained meeting index", () => {
  const inputs = { formula: "interest_cost / meeting_rate + meeting_pipe_cost_per_meeting", interestIndexValue: 50, interestOutcomes: 20, positiveRepliesActedOn: 30, meetingsBooked: 6, meetingPipeSpentUsd: 60 };
  const value = 50 / (6 / 30) + 60 / 6;

  it("brackets the value and is seeded (never flickers)", () => {
    const a = meetingChainRange("cost_per_outcome", value, inputs, "x|2026-11-24")!;
    const b = meetingChainRange("cost_per_outcome", value, inputs, "x|2026-11-24")!;
    expect(a).toEqual(b);
    expect(a.low).toBeLessThanOrEqual(value);
    expect(a.high).toBeGreaterThanOrEqual(value);
    expect(a.high).toBeGreaterThan(a.low);
  });

  it("rate chain brackets the value", () => {
    const rate = 2 * (6 / 30);
    const r = meetingChainRange("conversion_rate", rate, { ...inputs, formula: "interest_rate * meeting_rate", interestIndexValue: 2 }, "y")!;
    expect(r.low).toBeLessThanOrEqual(rate);
    expect(r.high).toBeGreaterThanOrEqual(rate);
  });

  it("missing counts: no range", () => {
    expect(meetingChainRange("cost_per_outcome", value, { ...inputs, meetingsBooked: null }, "z")).toBeNull();
  });
});

describe("client median", () => {
  it("brackets the median", () => {
    const r = clientMedianRange(5, [{ engaged: 4, spendUsd: 20 }, { engaged: 10, spendUsd: 50 }, { engaged: 1, spendUsd: 30 }], "s")!;
    expect(r.low).toBeLessThanOrEqual(5);
    expect(r.high).toBeGreaterThanOrEqual(5);
  });

  it("is recorded beside the engaged lead index value", () => {
    const p = engagedLeadPoint([
      { contacted: 1000, positiveReplies: 4, screenedContacted: 0, humanClicks: 0, spendCents: 2000 },
      { contacted: 1000, positiveReplies: 10, screenedContacted: 0, humanClicks: 0, spendCents: 5000 },
    ]);
    expect(p.value).toBe(5);
    const r = indexValueRange({ indexSlug: p.indexSlug, day: "2026-11-25", metric: "cost_per_outcome", outcome: "engaged_lead", value: p.value, outcomes: p.outcomes, contacted: null, inputs: p.inputs });
    expect(r.valueRangeUnavailableReason).toBeNull();
    expect(r.valueRange!.low).toBeLessThanOrEqual(5);
    expect(r.valueRange!.high).toBeGreaterThanOrEqual(5);
  });
});

describe("indexValueRange", () => {
  it("null value: none, named", () => {
    expect(indexValueRange(point({ value: null }))).toEqual({ valueRange: null, valueRangeUnavailableReason: "no_value" });
  });

  it("expected value: never a range", () => {
    expect(indexValueRange(point({ inputs: { valueKind: "expected" } }))).toEqual({ valueRange: null, valueRangeUnavailableReason: "expected_value" });
  });

  it("measured cost: low <= value <= high", () => {
    const r = indexValueRange(point({}));
    expect(r.valueRange!.low).toBeLessThanOrEqual(10);
    expect(r.valueRange!.high).toBeGreaterThanOrEqual(10);
  });

  it("cost with 0 outcomes: no_outcome", () => {
    expect(indexValueRange(point({ outcomes: 0 })).valueRangeUnavailableReason).toBe("no_outcome");
  });

  it("rate with no people counted: named", () => {
    expect(indexValueRange(point({ metric: "conversion_rate", value: 1, contacted: null })).valueRangeUnavailableReason).toBe("people_emailed_not_counted");
  });

  it("engaged lead day recorded before the range: named", () => {
    expect(indexValueRange(point({ outcome: "engaged_lead", inputs: { clients: 3 } })).valueRangeUnavailableReason).toBe("range_not_recorded_that_day");
  });

  it("chained day missing counts: inputs_not_recorded", () => {
    expect(indexValueRange(point({ outcome: "meeting_booked", inputs: { formula: "interest_cost / meeting_rate + meeting_pipe_cost_per_meeting" } })).valueRangeUnavailableReason).toBe("inputs_not_recorded");
  });

  it("ledger meeting cost: Gamma on the meetings", () => {
    const r = indexValueRange(point({ outcome: "meeting_booked", value: 800, outcomes: 8, inputs: { method: "ledger_every_path", valueKind: "measured" } }));
    expect(r.valueRange!.low).toBeLessThan(800);
    expect(r.valueRange!.high).toBeGreaterThan(800);
  });
});
