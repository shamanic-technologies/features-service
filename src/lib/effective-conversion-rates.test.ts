import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  applyEffectiveRates,
  buildBrandEffectiveRates,
  buildFleetArrowMedians,
  measuredArrowRate,
  MIN_MEASURED_FROM_REACHED,
  resolveArrow,
  type BrandStepMeasurement,
} from "./effective-conversion-rates.js";
import { ALL_STEP_EVIDENCE, type LeadStepField } from "./funnel-steps.js";
import { declaredEconomicsForFunnel } from "./declared-funnels.js";
import type { DeclaredSalesFunnel } from "./sales-funnels-client.js";

const NONE: Record<LeadStepField, boolean> = {
  clicked: false,
  repliedPositive: false,
  meetingBooked: false,
  meetingAttended: false,
  signup: false,
  formSubmission: false,
  purchased: false,
};
const lead = (reached: Partial<Record<LeadStepField, boolean>>) => ({ ...NONE, ...reached });
const times = <T,>(n: number, value: T): T[] => Array.from({ length: n }, () => value);

/** 20 positive replies, 8 of which booked a meeting; 3 MORE meetings booked off the website (no reply). */
const MEASUREMENT: BrandStepMeasurement = {
  contactedRecipients: 400,
  evidence: ALL_STEP_EVIDENCE,
  reached: [
    ...times(8, lead({ repliedPositive: true, meetingBooked: true })),
    ...times(12, lead({ repliedPositive: true })),
    ...times(3, lead({ clicked: true, meetingBooked: true })),
    ...times(5, lead({ meetingBooked: true, meetingAttended: true })),
  ],
};

describe("measuredArrowRate — the funnel-step conversion, the bar on the denominator", () => {
  it("is count(TO) ÷ count(FROM), the rung rate funnelSteps states — not the intersection", () => {
    const m = measuredArrowRate(MEASUREMENT, "repliedPositive", "meetingBooked");
    // 16 meetings over 20 replies. The intersection would have read 8 / 20 = 40%, under-stating every
    // brand whose bookings are recorded without a reply flag (prod: 21.7% against the rung's 60.9%).
    expect(m).toEqual({ fromReached: 20, toReached: 16, ratePct: 80, sufficient: true, gap: null });
  });

  it("more leads at TO than at FROM is no probability: unmeasurable, never clamped", () => {
    const skewed: BrandStepMeasurement = {
      ...MEASUREMENT,
      reached: [...times(10, lead({ repliedPositive: true })), ...times(12, lead({ meetingBooked: true }))],
    };
    expect(measuredArrowRate(skewed, "repliedPositive", "meetingBooked")).toMatchObject({ ratePct: 120, sufficient: false, gap: "to_exceeds_from" });
  });

  it("an arrow truly at 0% becomes measured once the FROM step clears the bar", () => {
    const zero: BrandStepMeasurement = { ...MEASUREMENT, reached: times(MIN_MEASURED_FROM_REACHED, lead({ repliedPositive: true })) };
    const m = measuredArrowRate(zero, "repliedPositive", "meetingBooked");
    expect(m.ratePct).toBe(0);
    expect(m.sufficient).toBe(true);
  });

  it("below the bar the rate is still reported, and is not sufficient", () => {
    const m = measuredArrowRate(MEASUREMENT, "clicked", "meetingBooked");
    // 3 website visits; the rung counts every booked meeting (16) — over 100%, so not a probability.
    expect(m).toMatchObject({ fromReached: 3, toReached: 16, sufficient: false, gap: "to_exceeds_from" });
  });

  it("a step nothing counts, and an unreadable producer, are told apart and never read as 0", () => {
    expect(measuredArrowRate(MEASUREMENT, null, "purchased").gap).toBe("step_not_counted");
    const blind = { ...MEASUREMENT, evidence: { ...ALL_STEP_EVIDENCE, observedSteps: false } };
    expect(measuredArrowRate(blind, "meetingBooked", "meetingAttended")).toMatchObject({
      fromReached: null,
      ratePct: null,
      gap: "evidence_unreadable",
    });
  });
});

describe("resolveArrow — measured, else manual, else median, else null", () => {
  const measured = measuredArrowRate(MEASUREMENT, "repliedPositive", "meetingBooked");
  const thin = measuredArrowRate(MEASUREMENT, "clicked", "meetingBooked");
  const median = { ratePct: 22, brandCount: 7 };

  it("a sufficient measurement wins over a stated rate", () => {
    expect(resolveArrow("Positive reply", "Meeting booked", measured, 70, median)).toMatchObject({
      effectiveRatePct: 80,
      source: "measured",
      manualRatePct: 70,
      median,
    });
  });
  it("under the bar, the brand's own statement wins over the fleet", () => {
    expect(resolveArrow("Website visit", "Meeting booked", thin, 5, median)).toMatchObject({ effectiveRatePct: 5, source: "manual" });
  });
  it("nothing stated, the median", () => {
    expect(resolveArrow("Website visit", "Meeting booked", thin, null, median)).toMatchObject({ effectiveRatePct: 22, source: "median" });
  });
  it("nothing at all: null with a reason, never a default", () => {
    expect(resolveArrow("Website visit", "Meeting booked", thin, null, { ratePct: null, brandCount: 0 })).toMatchObject({
      effectiveRatePct: null,
      source: null,
      unresolvedReason: "no_rate_available",
    });
  });
});

describe("buildFleetArrowMedians — the median of what brands STATED", () => {
  const stated = (ratePct: number | null) => [{
    funnelKey: "sales_meetings_from_conversation" as const,
    arrows: [{ fromStep: "Positive reply", toStep: "Meeting booked", ratePct, stated: ratePct !== null }],
  }];
  it("is the median, never the mean, over stated values only", () => {
    const medians = buildFleetArrowMedians([stated(10), stated(20), stated(90), stated(null)]);
    expect(medians.get("sales_meetings_from_conversation|positive reply|meeting booked")).toEqual({ ratePct: 20, brandCount: 3 });
  });
});

describe("pricing rests on the EFFECTIVE rate", () => {
  const declared: DeclaredSalesFunnel = {
    funnelKey: "sales_meetings_from_conversation",
    name: "Sales Meeting from Positive Reply",
    steps: ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"],
    // What the offer declared: 90% reply → meeting, a 50% close.
    rates: { replyToMeetingPct: 90, meetingToClosePct: 50 },
    lifetimeRevenueUsd: 5000,
    destinationUrl: null,
    bookingUrl: null,
    updatedAt: "2026-09-25T00:00:00Z",
  };
  const effective = buildBrandEffectiveRates({
    brandId: "b1",
    funnelKeys: ["sales_meetings_from_conversation"],
    measurement: MEASUREMENT,
    manual: [{
      funnelKey: "sales_meetings_from_conversation",
      arrows: [{ fromStep: "Meeting attended", toStep: "Paid client", ratePct: 25, stated: true }],
    }],
    medians: new Map([["sales_meetings_from_conversation|meeting booked|meeting attended", { ratePct: 60, brandCount: 4 }]]),
  });

  it("each arrow resolves from its own best source", () => {
    const [funnel] = effective.funnels;
    expect(funnel.arrows.map((a) => [a.source, a.effectiveRatePct])).toEqual([
      ["measured", 80], // 16 meetings over 20 replies
      ["measured", 5 / 16 * 100], // 5 attended over 16 booked — 16 ≥ 10
      ["manual", 25], // 5 attended < the bar → the brand's own statement
    ]);
  });

  it("the funnel is priced on the effective rates, not the offer's declared ones; its lifetime revenue stays the offer's", () => {
    const [onEffective] = applyEffectiveRates([declared], effective);
    const econ = declaredEconomicsForFunnel([onEffective], "sales_meetings_from_conversation")!;
    expect(econ.replyToMeetingPct).toBeCloseTo(80, 9); // not the declared 90
    expect(econ.meetingAttendedToPaidClientPct).toBeCloseTo(25, 9);
    // booked → paid = show-up (measured 31.25%) × attended → paid (25%), not the declared 50%.
    expect(econ.meetingToClosePct).toBeCloseTo(31.25 * 0.25, 9);
    expect(econ.lifetimeRevenueUsd).toBe(5000);
  });

  it("a funnel the effective set does not cover keeps its declaration", () => {
    const other = { ...declared, funnelKey: "form_magnet" as const };
    expect(applyEffectiveRates([other], effective)[0]).toBe(other);
  });
});

describe("each arrow is named in brand-service's own step wording", () => {
  it("the form rung reads brand-service's 'Form filled', and still joins to its statement", () => {
    const rates = buildBrandEffectiveRates({
      brandId: "b1",
      funnelKeys: ["form_magnet"],
      measurement: MEASUREMENT,
      manual: [{
        funnelKey: "form_magnet",
        arrows: [
          { fromStep: "Website visit", toStep: "Form filled", ratePct: 16.5, stated: true },
          { fromStep: "Form filled", toStep: "Paid client", ratePct: null, stated: false },
        ],
      }],
      medians: new Map(),
    });
    expect(rates.funnels[0].arrows.map((a) => [a.fromStep, a.toStep, a.manualRatePct])).toEqual([
      ["Website visit", "Form filled", 16.5],
      ["Form filled", "Paid client", null],
    ]);
  });
});
