import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { expectedContactedConversion, expectedStepConversion, withExpectedConversions } from "./expected-conversion.js";
import type { BrandEffectiveRates } from "./effective-conversion-rates.js";

const rates = {
  legs: [
    { legKey: "conversation_to_meeting_booked", effectiveRatePct: 30, source: "default" },
    { legKey: "conversation_to_paid_client", effectiveRatePct: 5, source: "median" },
    { legKey: "meeting_booked_to_meeting_attended", effectiveRatePct: 80, source: "measured" },
  ],
} as unknown as BrandEffectiveRates;
const input = { rates, pricedFunnelKeys: [], fleetConversions: new Map<string, number>() };
const measured = (ratePct: number | null) => ({ rowAbove: { key: "meeting_booked" as const, label: "Meeting booked" }, rowAbovePeople: 2, rowPeople: 8, ratePct });

describe("expected % Conversion of the sliced ladder", () => {
  it("measured wins; else the leg to the SHALLOWEST next step, with its source as basis", () => {
    expect(expectedStepConversion("conversation", measured(20), input)).toMatchObject({ ratePct: 20, basis: "measured", toStep: "meeting_booked" });
    expect(expectedStepConversion("conversation", measured(null), input)).toMatchObject({ ratePct: 30, basis: "default", source: "default", toStep: "meeting_booked", legKey: "conversation_to_meeting_booked" });
    expect(expectedStepConversion("meeting_booked", null, input)).toMatchObject({ ratePct: 80, basis: "measured", toStep: "meeting_attended" });
  });

  it("Paid client has nothing past it; unreadable rates are named, never a number", () => {
    expect(expectedStepConversion("paid_client", null, input)).toMatchObject({ ratePct: null, unavailableReason: "final_step" });
    expect(expectedStepConversion("conversation", null, { ...input, rates: null })).toMatchObject({ ratePct: null, unavailableReason: "rates_unavailable" });
  });

  it("the contacted row: fleet conversion of the entry leg into the first displayed step, else the seeded benchmark", () => {
    const fleet = new Map([["start_to_conversation|sales-cold-email-outreach", 1.7]]);
    expect(expectedContactedConversion(null, "conversation", { ...input, fleetConversions: fleet })).toMatchObject({ ratePct: 1.7, basis: "fleet", toStep: "conversation" });
    expect(expectedContactedConversion(null, "website_visit", input)).toMatchObject({ ratePct: 2, basis: "default", source: "default_entry", toStep: "website_visit" });
    expect(expectedContactedConversion(measured(4), null, input)).toMatchObject({ ratePct: 4, basis: "measured" });
  });

  it("every row and the contacted row carry one; conversionFromRowAbove is untouched", () => {
    const row = (key: string, people: number) => ({ step: { key }, pricedPeople: people, people: { notOurs: { count: 0 } }, conversionFromRowAbove: null });
    const ladder = { rows: [row("conversation", 5), row("meeting_booked", 0), row("paid_client", 1)], contacted: { conversionFromRowAbove: null } };
    const out = withExpectedConversions(ladder as never, input) as unknown as {
      rows: Array<{ conversionFromRowAbove: null; expectedConversionFromRowAbove: { ratePct: number | null } }>;
      contacted: { expectedConversionFromRowAbove: { ratePct: number | null; toStep: string } };
    };
    expect(out.rows.map((r) => r.expectedConversionFromRowAbove.ratePct)).toEqual([30, 80, null]);
    expect(out.rows.every((r) => r.conversionFromRowAbove === null)).toBe(true);
    expect(out.contacted.expectedConversionFromRowAbove).toMatchObject({ ratePct: 1, toStep: "conversation" });
  });
});
