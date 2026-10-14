import { describe, expect, it } from "vitest";
import { meetingBookingBeforeAfterOf } from "./meeting-booking-before-after.js";

const win = (people: number, booked: number, hPeople = people, hBooked = booked) => ({
  people,
  booked,
  rate: null,
  bookedBy: { aiMeetingBooking: 0, yourTeamMeetingBooking: booked, other: 0, unknown: 0 },
  bookedAfterGoLive: 0,
  withinDays: { days: 30, people: hPeople, booked: hBooked, rate: null },
});

const body = (brands: unknown[], fleet: { before: unknown; after: unknown; brands: number }) => ({
  scope: { brandId: null },
  legKey: "conversation_to_meeting_booked",
  horizonDays: 30,
  brands,
  fleet,
});

describe("AI Meeting Booking before vs after go-live (amarillo-v2 2026-10-14)", () => {
  it("serves both windows and populations, withholds the change while a window booked under the bar", () => {
    const out = meetingBookingBeforeAfterOf(
      body(
        [{ orgId: "o", brandId: "b1", goLive: { at: "2026-10-01T00:00:00.000Z" }, before: win(20, 3), after: win(12, 2, 8, 1) }],
        { brands: 1, before: win(20, 3), after: win(12, 2, 8, 1) },
      ),
    );
    expect(out.brands).toEqual([
      expect.objectContaining({
        brandId: "b1",
        goLiveAt: "2026-10-01T00:00:00.000Z",
        before: expect.objectContaining({ positiveReplyPeople: 20, bookedPeople: 3, ratePct: 15 }),
        after: expect.objectContaining({ positiveReplyPeople: 12, bookedPeople: 2, ratePct: 16.67, sameHorizon: { days: 30, positiveReplyPeople: 8, bookedPeople: 1, ratePct: 12.5 } }),
        changePctPoints: null,
        relativeChangePct: null,
        bookedRequiredPerWindow: 10,
        unavailableReason: "not_enough_meetings",
      }),
    ]);
    expect(out.fleet).toMatchObject({ brandCount: 1, unavailableReason: "not_enough_meetings" });
  });

  it("takes the change on the SAME horizon once each window booked the bar", () => {
    const out = meetingBookingBeforeAfterOf(body([], { brands: 2, before: win(200, 20, 200, 20), after: win(150, 40, 100, 15) }));
    expect(out.fleet).toMatchObject({ changePctPoints: 5, relativeChangePct: 50, unavailableReason: null });
  });

  it("a brand whose AI never acted is in no comparison; one with no before history says so", () => {
    const out = meetingBookingBeforeAfterOf(
      body(
        [
          { orgId: "o", brandId: "never", goLive: null, before: win(5, 1), after: win(0, 0) },
          { orgId: "o", brandId: "dayone", goLive: { at: "2026-09-01T00:00:00.000Z" }, before: win(0, 0), after: win(30, 12) },
        ],
        { brands: 1, before: win(0, 0), after: win(30, 12) },
      ),
    );
    expect(out.brands?.map((b) => [b.brandId, b.unavailableReason])).toEqual([["dayone", "no_before_history"]]);
  });

  it("a malformed body is an error (the caller serves null + lead_service_unavailable)", () => {
    expect(() => meetingBookingBeforeAfterOf({ brands: [] })).toThrow(/brands\/fleet/);
    expect(() => meetingBookingBeforeAfterOf(body([], { brands: 1, before: { people: 1 }, after: win(1, 1) }))).toThrow(/fleet.before/);
  });
});
