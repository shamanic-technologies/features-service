import { describe, expect, it } from "vitest";
import { meetingBookingGainOf } from "./meeting-booking-gain.js";

const arms = (ai: [number, number], team: [number, number]) => ({
  aiMeetingBooking: { handled: ai[0], booked: ai[1], rate: null },
  yourTeamMeetingBooking: { handled: team[0], booked: team[1], rate: null },
  unknown: { handled: 4, booked: 0, rate: null },
  other: [],
});
const brand = (brandId: string, ai: [number, number], team: [number, number], meetings: number) => ({
  orgId: "o",
  brandId,
  arms: arms(ai, team),
  meetings: { total: meetings },
});
const fact = (brandId: string, source = "crm") => ({ brandId, event: "meeting_booked", source, occurredAt: "2026-10-01T00:00:00.000Z" });
const body = (ai: [number, number], team: [number, number]) => ({
  summary: { arms: arms(ai, team) },
  byBrand: [brand("b1", ai, team, 3)],
  attributedMeetings: [fact("b1")],
});

describe("AI Meeting Booking gain (owner 2026-10-13)", () => {
  it("serves both rates and populations, and withholds the gain while a side booked under the bar (prod 2026-10-13)", () => {
    expect(meetingBookingGainOf(body([8, 1], [26, 2]))).toEqual({
      legKey: "conversation_to_meeting_booked",
      basis: "positive_repliers_since_inception",
      aiMeetingBooking: { handledPeople: 8, bookedPeople: 1, ratePct: 12.5 },
      yourTeamMeetingBooking: { handledPeople: 26, bookedPeople: 2, ratePct: 7.69 },
      gainPctPoints: null,
      bookedRequiredPerSide: 10,
      population: { rule: "brands_reporting_meetings", brandsCounted: 1, brandsLeftOut: 0 },
      unavailableReason: "not_enough_meetings",
    });
  });

  it("MEETING-POPULATION-1018: both arms are summed over the brands that report meetings only", () => {
    const out = meetingBookingGainOf({
      summary: { arms: arms([9, 1], [24, 2]) },
      byBrand: [brand("reports", [6, 1], [19, 2], 162), brand("silent-a", [2, 0], [3, 0], 0), brand("silent-b", [1, 0], [2, 0], 8)],
      // MEETING-TRACKER-1024: silent-b's 8 meetings are tracker facts, which measure no meeting
      attributedMeetings: [fact("reports"), ...Array.from({ length: 8 }, () => fact("silent-b", "tracker"))],
    });
    expect(out.aiMeetingBooking).toEqual({ handledPeople: 6, bookedPeople: 1, ratePct: 16.67 });
    expect(out.yourTeamMeetingBooking).toEqual({ handledPeople: 19, bookedPeople: 2, ratePct: 10.53 });
    expect(out.population).toEqual({ rule: "brands_reporting_meetings", brandsCounted: 1, brandsLeftOut: 2 });
  });

  it("no brand reports meetings: rates null and the reason says why", () => {
    const out = meetingBookingGainOf({ summary: { arms: arms([3, 0], [5, 0]) }, byBrand: [brand("silent", [3, 0], [5, 0], 0)], attributedMeetings: [] });
    expect(out).toMatchObject({ aiMeetingBooking: { handledPeople: 0, ratePct: null }, gainPctPoints: null, unavailableReason: "no_brand_reports_meetings" });
  });

  it("serves the gain in points once each side booked the bar", () => {
    expect(meetingBookingGainOf(body([50, 20], [100, 10]))).toMatchObject({ gainPctPoints: 30, unavailableReason: null });
  });

  it("a malformed arm is an error (the caller serves null + lead_service_unavailable)", () => {
    expect(() => meetingBookingGainOf({ byBrand: [{ brandId: "b", meetings: { total: 1 }, arms: { aiMeetingBooking: { handled: 1, booked: 2 } } }], attributedMeetings: [fact("b")] })).toThrow(/aiMeetingBooking/);
  });
});
