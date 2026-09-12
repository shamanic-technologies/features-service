/**
 * THE LEG'S OWN STEP, PRICED THROUGH THE FUNNEL THAT CONTAINS IT.
 *
 * Every case asserts the DIVERGENCE between a step and the step below it — a suite that only checked
 * "a number came back" would pass on the implementation this replaces, which priced every leg of a
 * funnel at the price of the step the funnel is NAMED after.
 */
import { describe, it, expect } from "vitest";
import { bookedToAttendedRate, grainLegOutcome, legOutcomeTerms } from "./leg-outcome.js";

const ECON = { r2m: 0.2, v2m: 0.25, m2c: 0.5, v2c: 0, v2s: 0.04, s2pc: 0.5, v2fs: 0.1, fs2pc: 0.25 };

describe("legOutcomeTerms", () => {
  it("an ENTRY leg is worth its driver signal exactly — the walk is empty, so the count is OBSERVED", () => {
    const conv = legOutcomeTerms("sales_meetings_from_conversation", "conversation", ECON, 1)!;
    expect(conv).toMatchObject({ driver: "reply", rateFromDriver: 1, outcomeObserved: true });
    const visit = legOutcomeTerms("form_magnet", "website_visit", ECON, 1)!;
    expect(visit).toMatchObject({ driver: "click", rateFromDriver: 1, outcomeObserved: true });
  });

  it("each rung of a funnel is strictly rarer than the rung below it, and never priced the same", () => {
    const rate = (step: any) => legOutcomeTerms("sales_meetings_from_conversation", step, ECON, 0.8)!.rateFromDriver!;
    expect(rate("conversation")).toBe(1);
    expect(rate("meeting_booked")).toBeCloseTo(0.2, 10);
    expect(rate("meeting_attended")).toBeCloseTo(0.16, 10);
    expect(rate("paid_client")).toBeCloseTo(0.1, 10);
    expect(rate("conversation")).toBeGreaterThan(rate("meeting_booked"));
    expect(rate("meeting_booked")).toBeGreaterThan(rate("meeting_attended"));
    expect(rate("meeting_attended")).toBeGreaterThan(rate("paid_client"));
  });

  it("the two meeting funnels are entered through DIFFERENT signals and priced apart", () => {
    const reply = legOutcomeTerms("sales_meetings_from_conversation", "meeting_booked", ECON, 1)!;
    const click = legOutcomeTerms("sales_meetings_from_website", "meeting_booked", ECON, 1)!;
    expect(reply.driver).toBe("reply");
    expect(click.driver).toBe("click");
    expect(reply.rateFromDriver).not.toBeCloseTo(click.rateFromDriver!, 6);
  });

  it("each of the four funnels prices its own middle rung, and none borrows another's route", () => {
    expect(legOutcomeTerms("website_purchases", "signup", ECON, 1)!.rateFromDriver).toBeCloseTo(0.04, 10);
    expect(legOutcomeTerms("website_purchases", "paid_client", ECON, 1)!.rateFromDriver).toBeCloseTo(0.02, 10);
    expect(legOutcomeTerms("form_magnet", "form_filled", ECON, 1)!.rateFromDriver).toBeCloseTo(0.1, 10);
    expect(legOutcomeTerms("form_magnet", "paid_client", ECON, 1)!.rateFromDriver).toBeCloseTo(0.025, 10);
    // A meeting is not a step of either self-serve funnel, so there is nothing to price.
    expect(legOutcomeTerms("website_purchases", "meeting_booked", ECON, 1)).toBeNull();
    expect(legOutcomeTerms("form_magnet", "meeting_attended", ECON, 1)).toBeNull();
  });

  it("a rate the brand never declared makes the walk UNPRICEABLE — null, never 0 and never a default", () => {
    const { v2fs, ...noFormRate } = ECON;
    expect(legOutcomeTerms("form_magnet", "form_filled", noFormRate, 1)!.rateFromDriver).toBeNull();
    expect(legOutcomeTerms("form_magnet", "paid_client", noFormRate, 1)!.rateFromDriver).toBeNull();
    // A DECLARED zero is a real answer and passes through as 0.
    expect(legOutcomeTerms("form_magnet", "form_filled", { ...ECON, v2fs: 0 }, 1)!.rateFromDriver).toBe(0);
  });
});

describe("bookedToAttendedRate", () => {
  it("is the ratio of the two rates brand-service does state", () => {
    expect(bookedToAttendedRate({ meetingToClosePct: 40, meetingAttendedToPaidClientPct: 50 })).toBeCloseTo(0.8, 10);
  });
  it("stands in at 1 when nobody stated an attended→paid rate — the two rungs are then worth the same", () => {
    expect(bookedToAttendedRate({ meetingToClosePct: 40 })).toBe(1);
    // …and never above certainty when the two rates disagree.
    expect(bookedToAttendedRate({ meetingToClosePct: 90, meetingAttendedToPaidClientPct: 50 })).toBe(1);
  });
});

describe("grainLegOutcome", () => {
  const terms = legOutcomeTerms("sales_meetings_from_conversation", "conversation", ECON, 1)!;

  it("an entry leg is the grain's own driver cost and its own raw count", () => {
    expect(grainLegOutcome(terms, { spentUsd: 2141.76, driverUnitCostUsd: 2141.76 / 13, driverObserved: 13 })).toEqual({
      costPerOutcomeUsd: 2141.76 / 13,
      outcomeCount: 13,
      outcomeObserved: true,
      spentUsd: 2141.76,
    });
  });

  it("a grain that reached people and got no answer reports its floor and a MEASURED zero", () => {
    const out = grainLegOutcome(terms, { spentUsd: 500, driverUnitCostUsd: 500, driverObserved: 0 });
    expect(out.outcomeCount).toBe(0);
    expect(out.costPerOutcomeUsd).toBe(500);
  });

  it("an unpriceable walk nulls the cost AND the count rather than reading zero", () => {
    const { v2fs, ...noFormRate } = ECON;
    const unpriceable = legOutcomeTerms("form_magnet", "form_filled", noFormRate, 1)!;
    expect(grainLegOutcome(unpriceable, { spentUsd: 100, driverUnitCostUsd: 10, driverObserved: 10 })).toMatchObject({
      costPerOutcomeUsd: null,
      outcomeCount: null,
    });
  });
});
