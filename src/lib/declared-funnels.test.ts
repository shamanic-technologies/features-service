import { describe, it, expect } from "vitest";
import { declaredFunnelsToRank } from "./declared-funnels.js";
import type { DeclaredSalesFunnel } from "./sales-funnels-client.js";
import { matchSalesFunnelKey, SALES_FUNNELS, SALES_FUNNEL_KEYS } from "./sales-funnels.js";

// Shaped exactly like brand-service's deployed `GET /internal/brands/:brandId/sales-funnels` items —
// which carry NO `goal` and NO `currentGoal` since the retirement (brand-service #434).
function funnel(over: Partial<DeclaredSalesFunnel>): DeclaredSalesFunnel {
  return {
    funnelKey: "website_purchases",
    name: "Website Purchase",
    steps: ["Website visit", "Signup", "Paid client"],
    rates: {},
    lifetimeRevenueUsd: null,
    destinationUrl: null,
    bookingUrl: null,
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...over,
  };
}

describe("the funnel key is the whole vocabulary", () => {
  it("is exactly brand-service's deployed catalogue — no more, no fewer, in its own order", () => {
    // Pinned against what brand-service deploys (v0.79.1, verified in prod 2026-09-17). The first four
    // are the original catalogue and their KEYS are frozen — live declarations and billing ceilings
    // reference them; the last four were ADDED when roughly thirty acquisition channels opened.
    expect([...SALES_FUNNEL_KEYS]).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
      "website_purchases",
      "form_magnet",
      "sales_from_conversation",
      "sales_meetings_from_ads",
      "lead_forms_from_ads",
      "sales_from_website",
    ]);
  });

  it("carries brand-service's OWN names and chains — nothing here is authored locally", () => {
    // Mirrored byte-for-byte from brand-service's `SALES_FUNNELS`. Two of the original four had their
    // NAME moved (never their key): the reply-led meeting funnel no longer says "Conversation", which is
    // banned from every customer-facing name in the fleet, and `website_purchases` reads "Signups"
    // because its middle rung IS a signup — that name now belongs to `sales_from_website`.
    expect(SALES_FUNNELS.sales_meetings_from_conversation.name).toBe("Sales Meeting from Positive Reply");
    expect(SALES_FUNNELS.website_purchases.name).toBe("Signups");
    expect(SALES_FUNNELS.sales_from_website.name).toBe("Website Purchase");
    expect(SALES_FUNNELS.sales_from_conversation.name).toBe("Sale from Positive Reply");
    expect(SALES_FUNNELS.sales_meetings_from_ads.name).toBe("Sales Meeting from Ads");
    expect(SALES_FUNNELS.lead_forms_from_ads.name).toBe("Lead Form from Ads");

    expect(SALES_FUNNELS.sales_from_conversation.steps).toEqual(["Positive reply", "Paid client"]);
    expect(SALES_FUNNELS.sales_meetings_from_ads.steps).toEqual(["Meeting booked", "Meeting attended", "Paid client"]);
    expect(SALES_FUNNELS.lead_forms_from_ads.steps).toEqual(["Lead form submitted", "Paid client"]);
    expect(SALES_FUNNELS.sales_from_website.steps).toEqual(["Website visit", "Paid client"]);

    // The four originals are UNCHANGED in chain — only two names moved.
    expect(SALES_FUNNELS.sales_meetings_from_conversation.steps).toEqual(["Positive reply", "Meeting booked", "Meeting attended", "Paid client"]);
    expect(SALES_FUNNELS.sales_meetings_from_website.steps).toEqual(["Website visit", "Meeting booked", "Meeting attended", "Paid client"]);
    expect(SALES_FUNNELS.website_purchases.steps).toEqual(["Website visit", "Signup", "Paid client"]);
    expect(SALES_FUNNELS.form_magnet.steps).toEqual(["Website visit", "Form filled", "Paid client"]);

    // Every funnel terminates in the SALE, under the one label the fleet renders for it.
    for (const key of SALES_FUNNEL_KEYS) {
      expect(SALES_FUNNELS[key].steps.at(-1), key).toBe("Paid client");
    }
  });

  it("ships NO customer-facing name carrying the word 'conversation'", () => {
    for (const key of SALES_FUNNEL_KEYS) {
      expect(SALES_FUNNELS[key].name.toLowerCase(), key).not.toContain("conversation");
    }
  });

  it("keeps accepting every pre-retirement spelling, so a caller sending yesterday's word still works", () => {
    expect(matchSalesFunnelKey("reply_meeting")).toBe("sales_meetings_from_conversation");
    expect(matchSalesFunnelKey("visit_meeting")).toBe("sales_meetings_from_website");
    expect(matchSalesFunnelKey("visit_signup")).toBe("website_purchases");
    expect(matchSalesFunnelKey("visit_form")).toBe("form_magnet");
    // separator / case variance on either vocabulary
    expect(matchSalesFunnelKey("Form-Magnet")).toBe("form_magnet");
    expect(matchSalesFunnelKey(" Reply Meeting ")).toBe("sales_meetings_from_conversation");
  });

  it("resolves a word that names no funnel to null — the caller fails loud rather than guessing one", () => {
    expect(matchSalesFunnelKey("telepathy")).toBeNull();
    // A GOAL is not a funnel. `meetingBooked` names two different funnels, which is the whole reason the
    // goal was retired; accepting it here would silently pick one of them.
    expect(matchSalesFunnelKey("meetingBooked")).toBeNull();
    expect(matchSalesFunnelKey("signup")).toBeNull();
  });
});

describe("declaredFunnelsToRank", () => {
  it("a brand that declared NO funnel has nothing to rank — [] in, [] out (never a substituted set)", () => {
    expect(declaredFunnelsToRank([])).toEqual([]);
  });

  it("keeps ONE entry per funnel, carrying the key billing funds and campaign-service paces on", () => {
    const parsed = declaredFunnelsToRank([
      funnel({ funnelKey: "form_magnet", name: "Form Magnet" }),
      funnel({ funnelKey: "website_purchases", name: "Self-serve" }),
      funnel({ funnelKey: "sales_meetings_from_conversation", name: "Reply → Meeting" }),
    ]);
    expect(parsed.map((e) => e.funnelKey)).toEqual([
      "form_magnet",
      "website_purchases",
      "sales_meetings_from_conversation",
    ]);
    expect(parsed.map((e) => e.name)).toEqual(["Form Magnet", "Self-serve", "Reply → Meeting"]);
  });

  it("carries the funnel's OWN declared economics, dropping every rate the brand never gave us", () => {
    const parsed = declaredFunnelsToRank([
      funnel({
        funnelKey: "website_purchases",
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

  it("keeps the TWO meeting funnels apart — they are two funnels, and the customer funds each separately", () => {
    // They used to collapse into one goal-grain entry, because the answer was a single elected goal.
    // The answer is a RANKING per funnel now, and each funnel carries its own budget, so merging them
    // would leave the customer unable to see which of the two is worth funding.
    const parsed = declaredFunnelsToRank([
      funnel({
        funnelKey: "sales_meetings_from_conversation",
        rates: { replyToMeetingPct: 30, meetingToClosePct: 25 },
        lifetimeRevenueUsd: 9_000,
      }),
      funnel({
        funnelKey: "sales_meetings_from_website",
        rates: { visitToMeetingPct: 4, meetingToClosePct: 40 },
        lifetimeRevenueUsd: 7_000,
      }),
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((e) => e.funnelKey)).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
    ]);
    // Each keeps its OWN lifetime revenue — the merge used to take the lowest across the goal, which
    // priced a $9k contract funnel on a $7k one.
    expect(parsed[0].economics).toEqual({ replyToMeetingPct: 30, meetingToClosePct: 25, meetingAttendedToPaidClientPct: 25, lifetimeRevenueUsd: 9_000 });
    expect(parsed[1].economics).toEqual({ visitToMeetingPct: 4, meetingToClosePct: 40, meetingAttendedToPaidClientPct: 40, lifetimeRevenueUsd: 7_000 });
  });

  it("COMPOSES the meeting show-up rate into booked→paid — the shared field name means two things", () => {
    // brand-service's funnel is `… → Meeting booked → Meeting attended → Paid client`, so its
    // meetingToClosePct is ATTENDED→paid. Ours is BOOKED→paid (the projection multiplies it by
    // visitToMeeting / replyToMeeting, which produce BOOKED meetings). 50% show-up × 40% close = 20%.
    const parsed = declaredFunnelsToRank([
      funnel({
        funnelKey: "sales_meetings_from_conversation",
        rates: { replyToMeetingPct: 30, meetingBookedToAttendedPct: 50, meetingToClosePct: 40 },
      }),
    ]);
    expect(parsed[0].economics).toEqual({ replyToMeetingPct: 30, meetingToClosePct: 20, meetingAttendedToPaidClientPct: 40 });
    // The show-up rate never reaches SalesEconomics under its own name — there is no field for it.
    expect(parsed[0].economics).not.toHaveProperty("meetingBookedToAttendedPct");
  });

  it("no declared show-up rate ⇒ the close rate stands alone, never discarded", () => {
    // The brand-wide economics row has no show-up column at all, so close-alone IS its semantics.
    const parsed = declaredFunnelsToRank([
      funnel({
        funnelKey: "sales_meetings_from_website",
        rates: { visitToMeetingPct: 4, meetingBookedToAttendedPct: null, meetingToClosePct: 40 },
      }),
    ]);
    expect(parsed[0].economics).toEqual({ visitToMeetingPct: 4, meetingToClosePct: 40, meetingAttendedToPaidClientPct: 40 });
  });

  it("a show-up rate with NO close rate contributes nothing — half a funnel is not a close rate", () => {
    const parsed = declaredFunnelsToRank([
      funnel({
        funnelKey: "sales_meetings_from_conversation",
        rates: { replyToMeetingPct: 30, meetingBookedToAttendedPct: 50, meetingToClosePct: null },
      }),
    ]);
    expect(parsed[0].economics).toEqual({ replyToMeetingPct: 30 });
  });

  it("carries NO goal, and reads nothing about FUNDING", () => {
    // No goal: the funnel key is what this is priced on, and a goal beside it would be a second
    // vocabulary for the same thing — the one that could not tell the two meeting funnels apart.
    // No funding: ranking is about history. Whether a funnel currently carries a daily ceiling is
    // billing's data and campaign-service's question at run time; it must not reach this path at all.
    const [entry] = declaredFunnelsToRank([funnel({})]);
    expect(Object.keys(entry).sort()).toEqual(["economics", "funnelKey", "name"]);
  });
});
