import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  betaQuantile,
  clientMedianRange,
  conversionRateRange,
  costPerOutcomeRange,
  expectedValueRange,
  gammaQuantile,
  signupChainRange,
  SIGNUP_CHAIN_FORMULA,
  indexValueRange,
  meetingChainRange,
  type RangePointInput,
} from "./fleet-index-range.js";
import { engagedLeadPoint, signupCostIndexPoint, type FleetIndexPoint } from "./fleet-indexes.js";

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

// OUTCOME-RANGES-1125: a DERIVED range beside an EXPECTED value, from the counts it was derived from.
describe("expectedValueRange", () => {
  /** Prod 2026-11-25 vendor point of the Cost Per Meeting Index (expected pipe chain). */
  const meetingChainInputs = {
    valueKind: "expected",
    method: "expected_pipe_chain",
    formula: "interest_cost / meeting_rate + meeting_pipe_cost_per_meeting",
    interestIndexValue: 61.97403834190132,
    interestOutcomes: 51,
    positiveRepliesActedOn: 16,
    meetingsBooked: 5,
    meetingPipeSpentUsd: 2.3400627613730007,
  };

  it("a measured value: none, its range is valueRange", () => {
    expect(expectedValueRange(point({}))).toEqual({ valueRange: null, valueRangeUnavailableReason: "measured_value" });
  });

  it("a null expected value: no_value", () => {
    expect(expectedValueRange(point({ value: null, inputs: { valueKind: "expected" } })).valueRangeUnavailableReason).toBe("no_value");
  });

  it("the expected meeting chain (prod counts): low <= value <= high, wide on 5 meetings, seeded", () => {
    const p = point({ indexSlug: "cold-email-cost-per-meeting", outcome: "meeting_booked", value: 198.7849352463588, outcomes: 5, contacted: null, inputs: meetingChainInputs });
    const r = expectedValueRange(p);
    expect(r.valueRangeUnavailableReason).toBeNull();
    expect(r.valueRange!.low).toBeLessThan(198.78);
    expect(r.valueRange!.high).toBeGreaterThan(198.78);
    // 5 of 16 booked: the booking rate alone spans roughly 0.2-0.45, so the range is wide.
    expect(r.valueRange!.high / r.valueRange!.low).toBeGreaterThan(1.5);
    expect(expectedValueRange(p)).toEqual(r);
    // The measured range stays withheld on the same point (INDEX-RANGE-1125 unchanged).
    expect(indexValueRange(p).valueRangeUnavailableReason).toBe("expected_value");
  });

  it("the outcome prices' quoted meeting price carries no counts: inputs_not_recorded", () => {
    expect(expectedValueRange(point({ value: 300, inputs: { valueKind: "expected", method: "expected_outcome_prices", formula: "reply_cost / meeting_rate + meeting_leg_cost" } })).valueRangeUnavailableReason).toBe("inputs_not_recorded");
  });

  it("an expected cold email leg cost: Gamma on the leg's outcomes; 0 outcomes = no_outcome", () => {
    const inputs = { valueKind: "expected", formula: "subject_cost_per_person_reached / leg_measured_rate", legOutcomes: 4, legReached: 2000 };
    const r = expectedValueRange(point({ value: 50, inputs }));
    expect(r.valueRange!.low).toBeLessThan(50);
    expect(r.valueRange!.high).toBeGreaterThan(50);
    expect(expectedValueRange(point({ value: 50, inputs: { ...inputs, legOutcomes: 0 } })).valueRangeUnavailableReason).toBe("no_outcome");
  });

  it("an expected cold email leg rate: the Jeffreys interval on the leg", () => {
    const r = expectedValueRange(point({ metric: "conversion_rate", value: 0.2, inputs: { valueKind: "expected", formula: "leg_measured_rate", legOutcomes: 4, legReached: 2000 } }));
    expect(r.valueRange!.low).toBeLessThan(0.2);
    expect(r.valueRange!.high).toBeGreaterThan(0.2);
  });
});

describe("signupChainRange (0 / few / many signups)", () => {
  const inputs = (led: number, consumed: number) => ({ clickIndexValue: 5, clickOutcomes: 18, visitsConsumed: consumed, visitsLedToSignup: led });

  it("0 signups: no range", () => {
    expect(signupChainRange(100, inputs(0, 500), "s")).toBeNull();
  });

  it("few signups: wide; many: narrower, both around the value", () => {
    const few = signupChainRange(5 / (3 / 100), inputs(3, 100), "s")!;
    const many = signupChainRange(5 / (300 / 10000), inputs(300, 10000), "s")!;
    const v = 5 / 0.03;
    expect(few.low).toBeLessThanOrEqual(v);
    expect(few.high).toBeGreaterThanOrEqual(v);
    expect(many.low).toBeLessThanOrEqual(v);
    expect(many.high).toBeGreaterThanOrEqual(v);
    expect(few.high / few.low).toBeGreaterThan(many.high / many.low);
  });

  it("served through expectedValueRange on the signup point's formula", () => {
    const r = expectedValueRange(point({ indexSlug: "cold-email-cost-per-signup", outcome: "signup", value: 5 / 0.03, inputs: { valueKind: "expected", formula: SIGNUP_CHAIN_FORMULA, ...inputs(3, 100) } }));
    expect(r.valueRangeUnavailableReason).toBeNull();
  });
});

describe("signupCostIndexPoint", () => {
  const click: FleetIndexPoint = { indexSlug: "cold-email-cost-per-click", value: 5, status: "signal", outcomes: 18, contacted: 1097, workflowDynastySlug: "w", workflowDynastyName: "W", unavailableReason: null, inputs: {} };

  it("no visit chained to a signup on the ledger (prod 2026-11-25): null, named, never a default rate", () => {
    const p = signupCostIndexPoint(click, { consumedUnits: 0, ledUnits: 0 }, 10);
    expect(p).toMatchObject({ indexSlug: "cold-email-cost-per-signup", value: null, unavailableReason: "visit_to_signup_not_measured", status: "noise" });
    expect(p.inputs.valueKind).toBe("expected");
  });

  it("below the ledger's measuring bar (10 consumed visits): not measured", () => {
    expect(signupCostIndexPoint(click, { consumedUnits: 9, ledUnits: 2 }, 10).value).toBeNull();
  });

  it("measured: click cost / share, expected, weakest status, its derived range around it", () => {
    const p = signupCostIndexPoint(click, { consumedUnits: 200, ledUnits: 4 }, 10);
    expect(p.value).toBeCloseTo(250, 6);
    expect(p.status).toBe("noise");
    expect(p.outcomes).toBe(4);
    const r = expectedValueRange({ indexSlug: p.indexSlug, day: "2026-11-25", metric: "cost_per_outcome", outcome: "signup", value: p.value, outcomes: p.outcomes, contacted: null, inputs: p.inputs });
    expect(r.valueRange!.low).toBeLessThanOrEqual(250);
    expect(r.valueRange!.high).toBeGreaterThanOrEqual(250);
  });

  it("no click price: the click's own reason", () => {
    expect(signupCostIndexPoint({ ...click, value: null, unavailableReason: "not_measured" }, { consumedUnits: 200, ledUnits: 4 }, 10)).toMatchObject({ value: null, unavailableReason: "not_measured" });
  });
});
