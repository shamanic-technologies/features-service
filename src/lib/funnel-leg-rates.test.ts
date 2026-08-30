import { describe, it, expect } from "vitest";
import { declaredFunnelsToRank } from "./declared-funnels.js";
import { declaredFunnelLegs, legPathRate, statedLegRates } from "./funnel-leg-rates.js";
import type { DeclaredSalesFunnel } from "./sales-funnels-client.js";

// Shaped exactly like brand-service's deployed `GET /internal/brands/:brandId/sales-funnels` items,
// which carry `arrows[]` beside the named `rates` since v0.76.0.
function conversationFunnel(over: Partial<DeclaredSalesFunnel> = {}): DeclaredSalesFunnel {
  return {
    funnelKey: "sales_meetings_from_conversation",
    name: "Sales Meeting from Conversation",
    steps: ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"],
    rates: {},
    lifetimeRevenueUsd: null,
    destinationUrl: null,
    bookingUrl: null,
    updatedAt: "2026-08-31T00:00:00.000Z",
    ...over,
  };
}

const leg = (
  fromStep: string,
  toStep: string,
  ratePct: number | null,
  provenance: string,
  rateKey: string | null = null,
) => ({ fromStep, toStep, ratePct, provenance, rateKey });

// The funnel exactly as brand-service serves it for a brand that stated only the NAMED rates: every
// leg carries the named rate's own value, tagged `named_rate`.
const namedOnly = conversationFunnel({
  rates: { replyToMeetingPct: 40, meetingBookedToAttendedPct: 50, meetingToClosePct: 30 },
  arrows: [
    leg("Positive reply", "Meeting booked", 40, "named_rate", "replyToMeetingPct"),
    leg("Meeting booked", "Meeting attended", 50, "named_rate", "meetingBookedToAttendedPct"),
    leg("Meeting attended", "Paid client", 30, "named_rate", "meetingToClosePct"),
  ],
});

describe("no brand's numbers move — the named rates remain the answer for every arrow they cover", () => {
  it("a funnel whose every leg came from a NAMED rate is priced byte-identically to a payload with no legs at all", () => {
    const withLegs = declaredFunnelsToRank([namedOnly])[0]!.economics;
    const withoutLegs = declaredFunnelsToRank([
      conversationFunnel({ rates: namedOnly.rates }),
    ])[0]!.economics;
    expect(withLegs).toEqual(withoutLegs);
    // and it is still today's composition: booked→paid = attended% × show-up%
    expect(withLegs).toMatchObject({
      replyToMeetingPct: 40,
      meetingToClosePct: 15,
      meetingAttendedToPaidClientPct: 30,
    });
  });

  it("a producer serving NO legs at all is the same no-change path, never a gap to fill", () => {
    expect(declaredFunnelLegs(conversationFunnel())).toEqual([]);
    expect(statedLegRates("sales_meetings_from_conversation", [])).toEqual({});
  });
});

describe("a brand that stated a rate FOR AN ARROW is priced on it", () => {
  it("the stated leg wins over the named rate that covered the same arrow", () => {
    const funnel = conversationFunnel({
      rates: { replyToMeetingPct: 40, meetingToClosePct: 30 },
      arrows: [
        leg("Positive reply", "Meeting booked", 70, "stated_arrow", "replyToMeetingPct"),
        leg("Meeting booked", "Meeting attended", null, "unstated", "meetingBookedToAttendedPct"),
        leg("Meeting attended", "Paid client", 30, "named_rate", "meetingToClosePct"),
      ],
    });
    expect(declaredFunnelsToRank([funnel])[0]!.economics).toMatchObject({ replyToMeetingPct: 70 });
  });

  it("an INSERTED step is priced as the product of the legs across it — no field had to exist for it", () => {
    // The phone call sits between the positive reply and the booked meeting. No named rate can express
    // either half; both are stated for the leg, so reply→booked is 50% × 80% = 40%.
    const funnel = conversationFunnel({
      steps: ["Positive reply", "Phone call", "Meeting booked", "Meeting attended", "Paid client"],
      rates: { replyToMeetingPct: 10, meetingBookedToAttendedPct: 50, meetingToClosePct: 30 },
      arrows: [
        leg("Positive reply", "Phone call", 50, "stated_arrow"),
        leg("Phone call", "Meeting booked", 80, "stated_arrow"),
        leg("Meeting booked", "Meeting attended", 50, "named_rate", "meetingBookedToAttendedPct"),
        leg("Meeting attended", "Paid client", 30, "named_rate", "meetingToClosePct"),
      ],
    });
    const economics = declaredFunnelsToRank([funnel])[0]!.economics;
    expect(economics!.replyToMeetingPct).toBeCloseTo(40, 10);
    // the rest of the funnel is untouched by the insertion
    expect(economics).toMatchObject({ meetingToClosePct: 15, meetingAttendedToPaidClientPct: 30 });
  });
});

describe("an arrow nobody has priced is NOT priced on a fabricated rate", () => {
  it("an unstated arrow yields no rate — never 0, never a default, never an average", () => {
    const funnel = conversationFunnel({
      rates: {},
      arrows: [
        leg("Positive reply", "Meeting booked", null, "unstated"),
        leg("Meeting booked", "Meeting attended", null, "unstated"),
        leg("Meeting attended", "Paid client", null, "unstated"),
      ],
    });
    // Nothing is declared at all, so the funnel carries no economics and the brand's effective set
    // applies unchanged downstream.
    expect(declaredFunnelsToRank([funnel])[0]!.economics).toBeNull();
  });

  it("an unstated leg in the MIDDLE of an inserted path leaves the destination leg's own rate standing", () => {
    const path = legPathRate(
      [
        leg("Positive reply", "Phone call", null, "unstated"),
        leg("Phone call", "Meeting booked", 80, "stated_arrow"),
      ],
      "Positive reply",
      "Meeting booked",
    );
    expect(path).toEqual({ ratePct: 80, stated: true });
  });

  it("the leg REACHING the destination must be stated, or the path has no rate at all", () => {
    const path = legPathRate(
      [
        leg("Meeting booked", "Meeting attended", 50, "stated_arrow"),
        leg("Meeting attended", "Paid client", null, "unstated"),
      ],
      "Meeting booked",
      "Paid client",
    );
    expect(path).toEqual({ ratePct: null, stated: false });
  });

  it("a destination the funnel's legs never reach has no rate", () => {
    expect(legPathRate([leg("Signup", "Paid client", 10, "stated_arrow")], "Website visit", "Paid client"))
      .toEqual({ ratePct: null, stated: false });
  });
});

describe("only the arrows THIS funnel has are asked for", () => {
  it("a meeting funnel never derives the direct self-serve rate from its through-a-meeting path", () => {
    const rates = statedLegRates("sales_meetings_from_website", [
      leg("Website visit", "Meeting booked", 20, "stated_arrow"),
      leg("Meeting booked", "Meeting attended", 50, "stated_arrow"),
      leg("Meeting attended", "Paid client", 30, "stated_arrow"),
    ]);
    expect(rates).toEqual({
      visitToMeetingPct: 20,
      meetingToClosePct: 15,
      meetingAttendedToPaidClientPct: 30,
    });
    expect(rates).not.toHaveProperty("visitToClosePct");
    expect(rates).not.toHaveProperty("visitToPaidClientPct");
  });

  it("a self-serve funnel answers for its own two arrows and for no meeting rate", () => {
    expect(
      statedLegRates("website_purchases", [
        leg("Website visit", "Signup", 12, "stated_arrow"),
        leg("Signup", "Paid client", 25, "stated_arrow"),
      ]),
    ).toEqual({ visitToSignupPct: 12, signupToPaidClientPct: 25 });
  });

  it("a form funnel answers for its own two arrows", () => {
    expect(
      statedLegRates("form_magnet", [
        leg("Website visit", "Form filled", 8, "stated_arrow"),
        leg("Form filled", "Paid client", 5, "stated_arrow"),
      ]),
    ).toEqual({ visitToFormSubmissionPct: 8, formSubmissionToPaidClientPct: 5 });
  });
});
