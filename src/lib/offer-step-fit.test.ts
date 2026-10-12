import { describe, it, expect } from "vitest";
import { missingStepsOf, setAsideCountByStep, splitByOfferSteps } from "./offer-step-fit.js";

const DOC_DINNERS = { stated: true, steps: ["conversation", "booking_call", "meeting_booked", "meeting_attended", "website_visit"] };
const PURCHASE = ["website_visit", "purchase", "paid_client"];
const MEETING = ["lead_found", "conversation", "meeting_booked", "meeting_attended", "paid_client"];

describe("offer step fit (owner 2026-10-12)", () => {
  it("names the steps the offer lacks; Lead found and Paid client are always present", () => {
    expect(missingStepsOf(PURCHASE, DOC_DINNERS)).toEqual(["purchase"]);
    expect(missingStepsOf(MEETING, DOC_DINNERS)).toEqual([]);
    expect(missingStepsOf(["lead_found", "paid_client"], { stated: true, steps: [] })).toEqual([]);
  });

  it("an offer that never stated sets nothing aside", () => {
    expect(missingStepsOf(PURCHASE, { stated: false, steps: null })).toEqual([]);
  });

  it("splits in order and counts each missing step", () => {
    const { kept, setAside } = splitByOfferSteps([PURCHASE, MEETING, ["signup", "purchase", "paid_client"]], (s) => s, DOC_DINNERS);
    expect(kept).toEqual([MEETING]);
    expect(setAside.map((x) => x.missingSteps)).toEqual([["purchase"], ["signup", "purchase"]]);
    expect(setAsideCountByStep(setAside)).toEqual([{ step: "purchase", setAsideCount: 2 }, { step: "signup", setAsideCount: 1 }]);
  });
});
