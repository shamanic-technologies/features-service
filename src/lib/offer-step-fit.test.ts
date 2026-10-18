import { describe, it, expect } from "vitest";
import { isCheckoutStep, missingStepsOf, setAsideCountByStep, splitByOfferSteps } from "./offer-step-fit.js";

const DOC_DINNERS = { stated: true, steps: ["conversation", "booking_call", "meeting_booked", "meeting_attended", "website_visit"] };
const PURCHASE = ["website_visit", "purchase", "paid_client"];
const MEETING = ["lead_found", "conversation", "meeting_booked", "meeting_attended", "paid_client"];

describe("offer step fit (owner 2026-10-12)", () => {
  it("names the steps the offer lacks; Lead found and Paid client are always present", () => {
    expect(missingStepsOf(PURCHASE, DOC_DINNERS)).toEqual(["purchase"]);
    expect(missingStepsOf(MEETING, DOC_DINNERS)).toEqual([]);
    expect(missingStepsOf(["lead_found", "paid_client"], { stated: true, steps: [] })).toEqual([]);
  });

  it("an offer that never stated assumes every step but a checkout (owner 2026-10-18, CeXO)", () => {
    const unknown = { stated: false, steps: null };
    expect(missingStepsOf(PURCHASE, unknown)).toEqual(["purchase"]);
    expect(missingStepsOf(MEETING, unknown)).toEqual([]);
    expect(missingStepsOf(["website_visit", "signup", "paid_client"], unknown)).toEqual([]);
    expect(isCheckoutStep("purchase")).toBe(true);
    expect(isCheckoutStep("paid_client")).toBe(false);
    expect(isCheckoutStep("meeting_attended")).toBe(false);
    // A declared step on the Paid client rung is a checkout too: the rung decides, never a key list.
    expect(missingStepsOf(["shop_order", "paid_client"], unknown, (k) => (k === "shop_order" ? "paid_client" : null))).toEqual(["shop_order"]);
  });

  it("CeXO: the $12,000 offer's 9.7x Direct purchase funnel no longer leads its 3.79x reply funnel; a shop stating the step keeps the order", () => {
    // Prod 2026-10-17, offer "CeXO AI" (client value $12,000, steps never stated), ROI-ranked.
    const ranked = [
      { name: "Wider Email Orders", roi: 9.7, steps: ["lead_found", "website_visit", "purchase", "paid_client"] },
      { name: "Wider Email Replies", roi: 3.79, steps: ["lead_found", "conversation", "meeting_booked", "meeting_attended", "paid_client"] },
    ];
    const cexo = splitByOfferSteps(ranked, (f) => f.steps, { stated: false, steps: null });
    expect(cexo.kept.map((f) => f.name)).toEqual(["Wider Email Replies"]);
    expect(cexo.setAside).toEqual([{ item: ranked[0], missingSteps: ["purchase"] }]);
    const shop = splitByOfferSteps(ranked, (f) => f.steps, { stated: true, steps: ["website_visit", "purchase", "conversation", "meeting_booked", "meeting_attended"] });
    expect(shop.kept.map((f) => f.name)).toEqual(["Wider Email Orders", "Wider Email Replies"]);
  });

  it("splits in order and counts each missing step", () => {
    const { kept, setAside } = splitByOfferSteps([PURCHASE, MEETING, ["signup", "purchase", "paid_client"]], (s) => s, DOC_DINNERS);
    expect(kept).toEqual([MEETING]);
    expect(setAside.map((x) => x.missingSteps)).toEqual([["purchase"], ["signup", "purchase"]]);
    expect(setAsideCountByStep(setAside)).toEqual([{ step: "purchase", setAsideCount: 2 }, { step: "signup", setAsideCount: 1 }]);
  });
});
