import { describe, it, expect } from "vitest";
import { authorizedGoalsFromFunnels, UnknownAuthorizedGoalError } from "./authorized-goals.js";
import type { DeclaredSalesFunnel } from "./sales-funnels-client.js";

// Shaped exactly like brand-service's deployed `GET /internal/brands/:brandId/sales-funnels` items.
function funnel(over: Partial<DeclaredSalesFunnel>): DeclaredSalesFunnel {
  return {
    funnelKey: "visit_signup",
    name: "Website Purchase",
    steps: ["Website visit", "Signup", "Paid client"],
    goal: "signups",
    currentGoal: "signup",
    rates: {},
    lifetimeRevenueUsd: null,
    destinationUrl: null,
    bookingUrl: null,
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...over,
  };
}

describe("authorizedGoalsFromFunnels", () => {
  it("a brand that declared NO funnel authorizes nothing — [] in, [] out (never a substituted set)", () => {
    expect(authorizedGoalsFromFunnels([])).toEqual([]);
  });

  it("maps each declared funnel to its canonical goal, in the producer's order", () => {
    const parsed = authorizedGoalsFromFunnels([
      funnel({ funnelKey: "visit_form", goal: "form_submissions", currentGoal: "signup" }),
      funnel({ funnelKey: "visit_signup", goal: "signups", currentGoal: "signup" }),
      funnel({ funnelKey: "reply_meeting", goal: "booked_meetings", currentGoal: "meetingBooked" }),
    ]);
    expect(parsed.map((e) => e.goal)).toEqual(["formSubmission", "signup", "meetingBooked"]);
  });

  it("reads the WIRE goal, not the lossy runtime token — a Form Magnet is NOT a signup funnel", () => {
    // brand-service deliberately collapses form_submissions onto the `signup` runtime token so its
    // consumers "never see a new value". features-service models form submissions as their OWN goal
    // with their own funnel, so reading currentGoal here would price a Form Magnet on signup economics.
    const parsed = authorizedGoalsFromFunnels([
      funnel({ funnelKey: "visit_form", goal: "form_submissions", currentGoal: "signup" }),
    ]);
    expect(parsed.map((e) => e.goal)).toEqual(["formSubmission"]);
  });

  it("falls back to the runtime token only when the wire goal maps to nothing", () => {
    const parsed = authorizedGoalsFromFunnels([funnel({ goal: "", currentGoal: "positiveReply" })]);
    expect(parsed.map((e) => e.goal)).toEqual(["positiveReply"]);
  });

  it("accepts every goal spelling brand-service can echo, including the dashboard's sales_meetings", () => {
    const spellings = [
      ["signups", "signup"],
      ["booked_meetings", "meetingBooked"],
      ["sales_meetings", "meetingBooked"],
      ["form_submissions", "formSubmission"],
      ["website_purchase", "websitePurchase"],
      ["combined_sales", "sales"],
      ["website_visits", "websiteVisit"],
      ["positive_replies", "positiveReply"],
      ["whatsapp_conversations", "whatsappConversation"],
    ] as const;
    for (const [wire, expected] of spellings) {
      expect(authorizedGoalsFromFunnels([funnel({ goal: wire })])[0].goal).toBe(expected);
    }
  });

  it("carries the funnel's OWN declared economics, dropping every rate the brand never gave us", () => {
    const parsed = authorizedGoalsFromFunnels([
      funnel({
        funnelKey: "visit_signup",
        goal: "signups",
        // A null rate is "never declared" upstream — it must NOT become 0, which would zero-collapse
        // the funnel. meetingBookedToAttendedPct has no counterpart in our projection and is dropped.
        rates: { visitToSignupPct: 8, signupToPaidClientPct: null, meetingBookedToAttendedPct: 60 },
        lifetimeRevenueUsd: 20_000,
      }),
    ]);
    expect(parsed).toEqual([{ goal: "signup", economics: { visitToSignupPct: 8, lifetimeRevenueUsd: 20_000 } }]);
  });

  it("a funnel with nothing declared carries no override — the brand's effective economics apply", () => {
    expect(authorizedGoalsFromFunnels([funnel({ rates: {}, lifetimeRevenueUsd: null })])).toEqual([
      { goal: "signup", economics: null },
    ]);
  });

  it("MERGES two funnels that share a goal — their rates are complementary legs, not duplicates", () => {
    // reply_meeting and visit_meeting are two routes to a booked meeting, and our meeting projection
    // spans BOTH channels (clicks·visitToMeeting + replies·replyToMeeting). Keeping only the first
    // would arbitrate the goal on half its economics.
    const parsed = authorizedGoalsFromFunnels([
      funnel({
        funnelKey: "reply_meeting",
        goal: "booked_meetings",
        rates: { replyToMeetingPct: 30, meetingToClosePct: 25 },
        lifetimeRevenueUsd: 9_000,
      }),
      funnel({
        funnelKey: "visit_meeting",
        goal: "booked_meetings",
        rates: { visitToMeetingPct: 4, meetingToClosePct: 40 },
        lifetimeRevenueUsd: 7_000,
      }),
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].goal).toBe("meetingBooked");
    expect(parsed[0].economics).toEqual({
      replyToMeetingPct: 30,
      meetingToClosePct: 25, // first declaration wins a collision, in the producer's order
      visitToMeetingPct: 4,
      lifetimeRevenueUsd: 7_000, // lowest of the two — can only understate the goal's return
    });
  });

  it("COMPOSES the meeting show-up rate into booked→paid — the shared field name means two things", () => {
    // brand-service's chain is `… → Meeting booked → Meeting attended → Paid client`, so its
    // meetingToClosePct is ATTENDED→paid. Ours is BOOKED→paid (the projection multiplies it by
    // visitToMeeting / replyToMeeting, which produce BOOKED meetings). 50% show-up × 40% close = 20%.
    const parsed = authorizedGoalsFromFunnels([
      funnel({
        funnelKey: "reply_meeting",
        goal: "booked_meetings",
        currentGoal: "meetingBooked",
        rates: { replyToMeetingPct: 30, meetingBookedToAttendedPct: 50, meetingToClosePct: 40 },
      }),
    ]);
    expect(parsed[0].economics).toEqual({ replyToMeetingPct: 30, meetingToClosePct: 20 });
    // The show-up rate never reaches SalesEconomics under its own name — there is no field for it.
    expect(parsed[0].economics).not.toHaveProperty("meetingBookedToAttendedPct");
  });

  it("no declared show-up rate ⇒ the close rate stands alone, never discarded", () => {
    // The brand-wide economics row has no show-up column at all, so close-alone IS its semantics.
    const parsed = authorizedGoalsFromFunnels([
      funnel({
        funnelKey: "visit_meeting",
        goal: "booked_meetings",
        currentGoal: "meetingBooked",
        rates: { visitToMeetingPct: 4, meetingBookedToAttendedPct: null, meetingToClosePct: 40 },
      }),
    ]);
    expect(parsed[0].economics).toEqual({ visitToMeetingPct: 4, meetingToClosePct: 40 });
  });

  it("a show-up rate with NO close rate contributes nothing — half a chain is not a close rate", () => {
    const parsed = authorizedGoalsFromFunnels([
      funnel({
        funnelKey: "reply_meeting",
        goal: "booked_meetings",
        currentGoal: "meetingBooked",
        rates: { replyToMeetingPct: 30, meetingBookedToAttendedPct: 50, meetingToClosePct: null },
      }),
    ]);
    expect(parsed[0].economics).toEqual({ replyToMeetingPct: 30 });
  });

  it("merges two meeting chains on their COMPOSED close rates, not their raw ones", () => {
    // reply_meeting composes to 60% × 50% = 30%; visit_meeting to 80% × 90% = 72%. The first
    // declaration wins the collision, in the producer's catalogue order.
    const parsed = authorizedGoalsFromFunnels([
      funnel({
        funnelKey: "reply_meeting",
        goal: "booked_meetings",
        currentGoal: "meetingBooked",
        rates: { replyToMeetingPct: 40, meetingBookedToAttendedPct: 60, meetingToClosePct: 50 },
      }),
      funnel({
        funnelKey: "visit_meeting",
        goal: "booked_meetings",
        currentGoal: "meetingBooked",
        rates: { visitToMeetingPct: 5, meetingBookedToAttendedPct: 80, meetingToClosePct: 90 },
      }),
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].economics).toEqual({ replyToMeetingPct: 40, visitToMeetingPct: 5, meetingToClosePct: 30 });
  });

  it("throws on a goal it cannot map — an authorized goal must never be silently dropped", () => {
    expect(() => authorizedGoalsFromFunnels([funnel({ goal: "telepathy", currentGoal: "telepathy" })])).toThrow(
      UnknownAuthorizedGoalError,
    );
  });
});
