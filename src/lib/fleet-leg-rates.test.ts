import { describe, expect, it } from "vitest";
import { expectedBrandLegRate, fleetLegRatePct, pickExpectedLegRate } from "./fleet-leg-rates.js";

/** EXPECTED-FLEET-RATE-1116 (owner 2026-11-16, « go with A »): one order on every expected figure. */
describe("THE ORDER: brand measured > customer stated > fleet measured > default", () => {
  it("each rung wins over every rung after it", () => {
    expect(pickExpectedLegRate({ ratePct: 3, rung: "measured" }, 0.1, 1)).toEqual({ ratePct: 3, rung: "measured" });
    expect(pickExpectedLegRate({ ratePct: 2, rung: "stated" }, 0.1, 1)).toEqual({ ratePct: 2, rung: "stated" });
    expect(pickExpectedLegRate(null, 0.1, 1)).toEqual({ ratePct: 0.1, rung: "fleet" });
    expect(pickExpectedLegRate(null, null, 1)).toEqual({ ratePct: 1, rung: "default" });
    expect(pickExpectedLegRate(null, null, null)).toBeNull();
  });

  it("a brand's conclusive measured 0 % stands; an unusable fleet figure is skipped", () => {
    expect(pickExpectedLegRate({ ratePct: 0, rung: "measured" }, 0.1, 1)).toEqual({ ratePct: 0, rung: "measured" });
    expect(pickExpectedLegRate(null, 0, 1)).toEqual({ ratePct: 1, rung: "default" });
    expect(pickExpectedLegRate(null, Number.NaN, 1)).toEqual({ ratePct: 1, rung: "default" });
  });

  it("a brand leg resolved on its default reads the fleet's rate; manual / measured keep their own", () => {
    const fleet = new Map([["conversation_to_meeting_booked|ai-meeting-booking", 12]]);
    const leg = (source: "measured" | "manual" | "default", pct: number) => ({ effectiveRatePct: pct, source, defaultRatePct: 30 });
    expect(expectedBrandLegRate(leg("default", 30), fleet, "conversation_to_meeting_booked", "ai-meeting-booking")).toEqual({ ratePct: 12, rung: "fleet" });
    expect(expectedBrandLegRate(leg("manual", 45), fleet, "conversation_to_meeting_booked", "ai-meeting-booking")).toEqual({ ratePct: 45, rung: "stated" });
    expect(expectedBrandLegRate(leg("measured", 8), fleet, "conversation_to_meeting_booked", "ai-meeting-booking")).toEqual({ ratePct: 8, rung: "measured" });
    expect(expectedBrandLegRate(leg("default", 30), new Map(), "conversation_to_meeting_booked", "ai-meeting-booking")).toEqual({ ratePct: 30, rung: "default" });
  });
});

describe("fleetLegRatePct", () => {
  const fleet = new Map([
    ["start_to_conversation|sales-cold-email-outreach", 0.1023],
    ["x_to_y|a", 5],
    ["x_to_y|b", 2],
  ]);
  it("reads a (leg, channel): the outbound spelling and a play suffix name the same pipe", () => {
    expect(fleetLegRatePct(fleet, "start_to_conversation", "sales-cold-email-outreach")).toBe(0.1023);
    expect(fleetLegRatePct(fleet, "lead_found_to_conversation", "sales-cold-email-outreach~no-offer-emails")).toBe(0.1023);
    expect(fleetLegRatePct(fleet, "start_to_conversation", "another-channel")).toBeNull();
  });
  it("no channel named: the lowest rate any channel measured on the leg (never flatters)", () => {
    expect(fleetLegRatePct(fleet, "x_to_y", null)).toBe(2);
    expect(fleetLegRatePct(fleet, "z_to_y", null)).toBeNull();
  });
});
