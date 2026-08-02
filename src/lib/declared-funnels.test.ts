import { describe, it, expect } from "vitest";
import { declaredFunnelsToRank, UnknownFunnelGoalError } from "./declared-funnels.js";
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

describe("declaredFunnelsToRank", () => {
  it("a brand that declared NO funnel has nothing to rank — [] in, [] out (never a substituted set)", () => {
    expect(declaredFunnelsToRank([])).toEqual([]);
  });

  it("keeps ONE entry per funnel, carrying the key billing funds and campaign-service paces on", () => {
    const parsed = declaredFunnelsToRank([
      funnel({ funnelKey: "visit_form", name: "Form Magnet", goal: "form_submissions", currentGoal: "signup" }),
      funnel({ funnelKey: "visit_signup", name: "Self-serve", goal: "signups", currentGoal: "signup" }),
      funnel({ funnelKey: "reply_meeting", name: "Reply → Meeting", goal: "booked_meetings", currentGoal: "meetingBooked" }),
    ]);
    expect(parsed.map((e) => e.funnelKey)).toEqual(["visit_form", "visit_signup", "reply_meeting"]);
    expect(parsed.map((e) => e.goal)).toEqual(["formSubmission", "signup", "meetingBooked"]);
    expect(parsed.map((e) => e.name)).toEqual(["Form Magnet", "Self-serve", "Reply → Meeting"]);
  });

  it("reads the WIRE goal, not the lossy runtime token — a Form Magnet is NOT a signup funnel", () => {
    // brand-service deliberately collapses form_submissions onto the `signup` runtime token so its
    // consumers "never see a new value". features-service models form submissions as their OWN goal
    // with their own funnel, so reading currentGoal here would price a Form Magnet on signup economics.
    const parsed = declaredFunnelsToRank([funnel({ funnelKey: "visit_form", goal: "form_submissions", currentGoal: "signup" })]);
    expect(parsed.map((e) => e.goal)).toEqual(["formSubmission"]);
  });

  it("falls back to the runtime token only when the wire goal maps to nothing", () => {
    const parsed = declaredFunnelsToRank([funnel({ goal: "", currentGoal: "positiveReply" })]);
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
      expect(declaredFunnelsToRank([funnel({ goal: wire })])[0].goal).toBe(expected);
    }
  });

  it("carries the funnel's OWN declared economics, dropping every rate the brand never gave us", () => {
    const parsed = declaredFunnelsToRank([
      funnel({
        funnelKey: "visit_signup",
        goal: "signups",
        // A null rate is "never declared" upstream — it must NOT become 0, which would zero-collapse
        // the funnel. meetingBookedToAttendedPct has no counterpart in our projection and is dropped.
        rates: { visitToSignupPct: 8, signupToPaidClientPct: null, meetingBookedToAttendedPct: 60 },
        lifetimeRevenueUsd: 20_000,
      }),
    ]);
    expect(parsed[0].economics).toEqual({ visitToSignupPct: 8, lifetimeRevenueUsd: 20_000 });
  });

  it("a funnel with nothing declared carries no override — the brand's effective economics apply", () => {
    expect(declaredFunnelsToRank([funnel({ rates: {}, lifetimeRevenueUsd: null })])[0].economics).toBeNull();
  });

  it("does NOT merge two funnels that share a goal — the customer funds each one separately", () => {
    // reply_meeting and visit_meeting are two routes to a booked meeting. They used to collapse into
    // one goal-grain entry, because the answer was a single elected goal. The answer is now a RANKING
    // per funnel, and each funnel carries its own budget, so merging them would leave the customer
    // unable to see which of the two is worth funding. A rate a funnel does not state falls back to
    // the brand's effective economics at projection time — never to zero.
    const parsed = declaredFunnelsToRank([
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
    expect(parsed).toHaveLength(2);
    expect(parsed.map((e) => e.funnelKey)).toEqual(["reply_meeting", "visit_meeting"]);
    expect(parsed.every((e) => e.goal === "meetingBooked")).toBe(true);
    // Each keeps its OWN lifetime revenue — the merge used to take the lowest across the goal, which
    // priced a $9k contract funnel on a $7k one.
    expect(parsed[0].economics).toEqual({ replyToMeetingPct: 30, meetingToClosePct: 25, lifetimeRevenueUsd: 9_000 });
    expect(parsed[1].economics).toEqual({ visitToMeetingPct: 4, meetingToClosePct: 40, lifetimeRevenueUsd: 7_000 });
  });

  it("COMPOSES the meeting show-up rate into booked→paid — the shared field name means two things", () => {
    // brand-service's chain is `… → Meeting booked → Meeting attended → Paid client`, so its
    // meetingToClosePct is ATTENDED→paid. Ours is BOOKED→paid (the projection multiplies it by
    // visitToMeeting / replyToMeeting, which produce BOOKED meetings). 50% show-up × 40% close = 20%.
    const parsed = declaredFunnelsToRank([
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
    const parsed = declaredFunnelsToRank([
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
    const parsed = declaredFunnelsToRank([
      funnel({
        funnelKey: "reply_meeting",
        goal: "booked_meetings",
        currentGoal: "meetingBooked",
        rates: { replyToMeetingPct: 30, meetingBookedToAttendedPct: 50, meetingToClosePct: null },
      }),
    ]);
    expect(parsed[0].economics).toEqual({ replyToMeetingPct: 30 });
  });

  it("throws on a goal it cannot map — a declared funnel must never be silently dropped", () => {
    expect(() => declaredFunnelsToRank([funnel({ goal: "telepathy", currentGoal: "telepathy" })])).toThrow(
      UnknownFunnelGoalError,
    );
  });

  it("reads nothing about FUNDING — the shape it produces has no place to put a budget", () => {
    // Ranking is about history. Whether a funnel currently carries a daily ceiling is billing's data
    // and campaign-service's question at run time; it must not reach this path at all.
    const [entry] = declaredFunnelsToRank([funnel({})]);
    expect(Object.keys(entry).sort()).toEqual(["economics", "funnelKey", "goal", "name"]);
  });
});
