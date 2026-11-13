import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { catalogueStepOf, legRateSources, type StepRateBook } from "./rate-sources.js";
import { measuredStepShare, outcomeValues } from "./script-value-rating.js";

const book = (steps: Array<[string, string, number, number]>, extra: Array<[string, number]> = []): StepRateBook => {
  const consumed = new Map<string, number>(extra);
  for (const [f, , , c] of steps) consumed.set(f, Math.max(consumed.get(f) ?? 0, c));
  return { builtAt: "2026-11-13T00:00:00.000Z", consumed, steps: steps.map(([fromOutcome, toOutcome, ledUnits, consumedUnits]) => ({ fromOutcome, toOutcome, ledUnits, consumedUnits })) };
};
const leg = (fromStep: string, toStep: string, ratePct: number | null = null) => ({ fromStep, toStep, ratePct, stated: ratePct !== null });

// Prod 2026-11-13 (fleet) and a CRM brand (Doc Dinners shape).
const FLEET = book([
  ["message_sent", "conversation", 115, 99508],
  ["message_sent", "website_visit", 844, 99508],
  ["conversation", "meeting_booked", 8, 45],
  ["meeting_booked", "meeting_attended", 4, 5],
  ["meeting_attended", "paid_client", 1, 1],
]);
const BRAND = book([
  ["conversation", "meeting_booked", 3, 12],
  ["meeting_booked", "meeting_attended", 3, 4],
  ["meeting_attended", "paid_client", 1, 1],
]);

describe("legRateSources (SCRIPT-VALUE-RATING-1113-RATES)", () => {
  it("brand-service's step words map through the catalogue onto the ledger outcomes", () => {
    expect(catalogueStepOf("Positive reply")).toBe("conversation");
    expect(catalogueStepOf("Form filled")).toBe("form_submitted");
    expect(catalogueStepOf("Purchase")).toBe("purchase");
    expect(catalogueStepOf("Nonsense step")).toBeNull();
  });

  it("a leg the brand's ledger chains enough Units on is measured, shown, never asked", () => {
    const [r] = legRateSources({ legs: [leg("Positive reply", "Meeting booked", 25)], brand: BRAND, fleet: FLEET, reportsMeetings: true });
    expect(r).toMatchObject({ fromOutcome: "conversation", toOutcome: "meeting_booked", ask: false, source: "measured", measuredRatePct: 25, ratePct: 25, ledger: { consumedUnits: 12, ledUnits: 3 }, statedRatePct: 25, unmeasuredReason: null });
  });

  it("a leg below the bar is asked: the client's stated rate is in force, the default is the leg's benchmark on a meeting leg", () => {
    const [r] = legRateSources({ legs: [leg("Meeting booked", "Meeting attended", 17)], brand: BRAND, fleet: FLEET, reportsMeetings: true });
    expect(r).toMatchObject({ ask: true, source: "stated", ratePct: 17, measuredRatePct: null, unmeasuredReason: "too_few_units", ledger: { consumedUnits: 4, ledUnits: 3 }, defaultSource: "leg_default" });
  });

  it("a brand that reports no meeting is unmeasured on a meeting leg, never measured nor 0 %", () => {
    const [r] = legRateSources({ legs: [leg("Positive reply", "Meeting booked")], brand: BRAND, fleet: FLEET, reportsMeetings: false });
    expect(r).toMatchObject({ ask: true, unmeasuredReason: "brand_reports_no_meetings", measuredRatePct: null, source: "default", defaultSource: "leg_default" });
    expect(r!.ratePct).toBe(r!.defaultRatePct);
  });

  it("an unstated, unmeasured non-meeting leg is prefilled with the fleet's measured rate when the fleet measures it, never as the brand's measure", () => {
    const fleet = book([["website_visit", "signup", 30, 1000]]);
    const [r] = legRateSources({ legs: [leg("Website visit", "Signup")], brand: book([["website_visit", "signup", 1, 4]]), fleet, reportsMeetings: false });
    expect(r).toMatchObject({ fromOutcome: "website_visit", ask: true, source: "default", defaultSource: "fleet_measured", defaultRatePct: 3, ratePct: 3, measuredRatePct: null, unmeasuredReason: "too_few_units" });
  });

  it("enough consumed Units with none led is nothing_led_yet (asked), as the Rating reads it", () => {
    const brand = book([], [["website_visit", 50]]);
    const [r] = legRateSources({ legs: [leg("Website visit", "Signup")], brand, fleet: book([]), reportsMeetings: true });
    expect(r).toMatchObject({ ask: true, unmeasuredReason: "nothing_led_yet", ledger: { consumedUnits: 50, ledUnits: 0 }, defaultSource: "leg_default" });
  });

  it("a step outside the catalogue is asked, not a ledger step", () => {
    const [r] = legRateSources({ legs: [leg("Unknown thing", "Paid client", 10)], brand: BRAND, fleet: FLEET, reportsMeetings: true });
    expect(r).toMatchObject({ ask: true, unmeasuredReason: "not_a_ledger_step", source: "stated", ratePct: 10, fromOutcome: null, ledger: null });
  });

  it("the Rating's values and the client's rates read ONE rule", () => {
    expect(measuredStepShare({ consumedUnits: 12, ledUnits: 3 })).toBe(0.25);
    expect(measuredStepShare({ consumedUnits: 4, ledUnits: 3 })).toBeNull();
    expect(measuredStepShare({ consumedUnits: 50, ledUnits: 0 })).toBeNull();
    const v = outcomeValues({ steps: BRAND.steps, anchor: { outcome: "paid_client", valueUsd: 1000 }, declared: new Map() });
    expect(v.get("conversation")).toBeUndefined();
  });
});
