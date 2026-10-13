import { describe, expect, it } from "vitest";
import { meetingBookingGainOf } from "./meeting-booking-gain.js";

const body = (ai: [number, number], team: [number, number]) => ({
  summary: {
    arms: {
      aiMeetingBooking: { handled: ai[0], booked: ai[1], rate: null },
      yourTeamMeetingBooking: { handled: team[0], booked: team[1], rate: null },
      unknown: { handled: 4, booked: 0, rate: null },
      other: [],
    },
  },
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
      unavailableReason: "not_enough_meetings",
    });
  });

  it("serves the gain in points once each side booked the bar", () => {
    expect(meetingBookingGainOf(body([50, 20], [100, 10]))).toMatchObject({ gainPctPoints: 30, unavailableReason: null });
  });

  it("a malformed arm is an error (the caller serves null + lead_service_unavailable)", () => {
    expect(() => meetingBookingGainOf({ summary: { arms: { aiMeetingBooking: { handled: 1, booked: 2 } } } })).toThrow(/aiMeetingBooking/);
  });
});
