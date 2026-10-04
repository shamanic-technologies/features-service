/**
 * WAVE C1 — what a read is priced on once no declared sales funnel is read. Every case asserts the
 * DIVERGENCE between two answers the rule could give (a statement picking one branch over another, an
 * offer's own lifetime revenue over its sibling's), so a suite that only checked "funnels came back"
 * would pass on an implementation reading every funnel the leg sits on.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../db/index.js", () => ({ db: { query: { features: { findMany: async () => [] } } }, sql: {} }));

process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";

const { readingFunnelsForLegs, onwardPathScore, offerLegKeys, fetchPricingFunnels, offerPathFunnels } = await import("./reading-funnels.js");
const { SeveralOffersDeclaredError } = await import("./sales-funnels-client.js");
const { declaredEconomicsForFunnel } = await import("./declared-funnels.js");

type Key = `${string}>${string}`;
const statedSet = (...legs: Key[]) => {
  const set = new Set<string>(legs);
  return (from: string, to: string) => set.has(`${from}>${to}`);
};
const noScore = () => null;

describe("readingFunnelsForLegs — the funnels a campaign's leg is read through", () => {
  it("a conversation campaign whose brand states reply → meeting reads the meeting funnel, not the direct sale", () => {
    expect(readingFunnelsForLegs(["start_to_conversation"], statedSet("conversation>meeting_booked"), noScore)).toEqual([
      "sales_meetings_from_conversation",
    ]);
    // The SAME leg, the brand stating reply → paid instead, reads the direct-sale funnel.
    expect(readingFunnelsForLegs(["start_to_conversation"], statedSet("conversation>paid_client"), noScore)).toEqual([
      "sales_from_conversation",
    ]);
  });

  it("a website-visit campaign is read through the funnel whose leg OUT of the visit the brand states", () => {
    expect(readingFunnelsForLegs(["start_to_website_visit"], statedSet("website_visit>signup"), noScore)).toEqual(["website_purchases"]);
    expect(readingFunnelsForLegs(["start_to_website_visit"], statedSet("website_visit>form_submitted"), noScore)).toEqual(["form_magnet"]);
    expect(readingFunnelsForLegs(["start_to_website_visit"], statedSet("website_visit>meeting_booked"), noScore)).toEqual([
      "sales_meetings_from_website",
    ]);
  });

  it("with nothing stated out of the step, the ONE best-priced onward path — never every candidate", () => {
    const score = (f: string) => ({ website_purchases: 0.01, form_magnet: 0.03, sales_meetings_from_website: 0.002 } as Record<string, number>)[f] ?? null;
    expect(readingFunnelsForLegs(["start_to_website_visit"], statedSet(), score)).toEqual(["form_magnet"]);
  });

  it("with nothing stated and nothing priceable, every candidate is read — nothing is guessed", () => {
    expect(readingFunnelsForLegs(["start_to_conversation"], statedSet(), noScore)).toEqual([
      "sales_meetings_from_conversation",
      "sales_from_conversation",
    ]);
  });

  it("an internal leg is read only through the funnels its leads actually arrived by", () => {
    // Booked → attended sits on both meeting funnels AND the ad funnel. The brand states reply → meeting
    // and attended → paid: its meetings come from replies, so only the conversation funnel reads it.
    const stated = statedSet("conversation>meeting_booked", "meeting_attended>paid_client");
    expect(readingFunnelsForLegs(["meeting_booked_to_meeting_attended"], stated, noScore)).toEqual(["sales_meetings_from_conversation"]);
    // The AI booking leg (reply → meeting) has one funnel, whatever is stated.
    expect(readingFunnelsForLegs(["conversation_to_meeting_booked"], statedSet(), noScore)).toEqual(["sales_meetings_from_conversation"]);
  });

  it("onwardPathScore multiplies the legs from the step to the paid client, null when one is unpriced", () => {
    const rate = (from: string, to: string) => ({ "website_visit>signup": 10, "signup>paid_client": 50 } as Record<string, number>)[`${from}>${to}`] ?? null;
    expect(onwardPathScore("website_purchases", "website_visit", rate)).toBeCloseTo(0.05, 9);
    expect(onwardPathScore("form_magnet", "website_visit", rate)).toBeNull();
  });
});

describe("offerLegKeys — the legs ONE offer's campaigns perform", () => {
  const rows = [
    { id: "a", featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation", offerId: "offer-1", status: "stopped" },
    { id: "b", featureSlug: "ai-meeting-booking", legKey: "conversation_to_meeting_booked", offerId: "offer-1", status: "ongoing" },
    { id: "c", featureSlug: "sales-cold-email-outreach", legKey: "start_to_website_visit", offerId: "offer-2", status: "ongoing" },
    // A row predating the offer column, stating its leg.
    { id: "d", featureSlug: "sales-cold-email-outreach", legKey: "start_to_website_visit", offerId: null, status: "stopped" },
    // A pre-leg ancestor: no leg is derived for it (wave C3), so it adds nothing.
    { id: "e", featureSlug: "sales-cold-email-outreach", legKey: null, offerId: "offer-1", status: "stopped" },
  ];
  it("every status and channel of THIS offer — never the other offer's", () => {
    expect(offerLegKeys(rows, "offer-1")).toEqual(["conversation_to_meeting_booked", "start_to_conversation"]);
    expect(offerLegKeys(rows, "offer-2")).toEqual(["start_to_website_visit"]);
  });
  it("a row predating the offer is the SOLE offer's, and only when the brand sells one", () => {
    expect(offerLegKeys([rows[2], rows[3]], "offer-2", true)).toEqual(["start_to_website_visit"]);
    expect(offerLegKeys([rows[3]], "offer-9", true)).toEqual(["start_to_website_visit"]);
    expect(offerLegKeys([rows[3]], "offer-9", false)).toEqual([]);
  });
});

describe("fetchPricingFunnels — the brand's leg rates and the OFFER's lifetime revenue", () => {
  afterEach(() => vi.restoreAllMocks());
  const OFFER_ECONOMICS = {
    legRates: [
      { fromStep: "Website visit", toStep: "Signup", ratePct: 5, stated: true, statedAt: "x" },
      { fromStep: "Signup", toStep: "Paid client", ratePct: 20, stated: true, statedAt: "x" },
      { fromStep: "Positive reply", toStep: "Meeting booked", ratePct: 60, stated: true, statedAt: "x" },
      { fromStep: "Meeting attended", toStep: "Paid client", ratePct: 25, stated: true, statedAt: "x" },
    ],
    offers: [
      { offerId: "offer-self", name: "Self-serve", lifetimeRevenueUsd: 500, lifetimeRevenueStatedAt: "x" },
      { offerId: "offer-sales", name: "Sales-led", lifetimeRevenueUsd: 4000, lifetimeRevenueStatedAt: "x" },
    ],
  };
  const CAMPAIGNS = [
    { id: "c1", featureSlug: "sales-cold-email-outreach", legKey: "start_to_website_visit", offerId: "offer-self", status: "ongoing" },
    { id: "c2", featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation", offerId: "offer-sales", status: "ongoing" },
  ];
  const mock = () =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("/offer-economics")) return json(OFFER_ECONOMICS);
      if (url.includes("campaign:3000/campaigns")) return json({ campaigns: CAMPAIGNS });
      return json({});
    });

  it("each offer reads ITS campaigns' funnels at ITS own lifetime revenue", async () => {
    mock();
    const self = await fetchPricingFunnels("b1", "org-1", "offer-self", { rates: "stated" });
    const sales = await fetchPricingFunnels("b1", "org-1", "offer-sales", { rates: "stated" });
    expect(self.map((f) => f.funnelKey)).toEqual(["website_purchases"]);
    expect(sales.map((f) => f.funnelKey)).toEqual(["sales_meetings_from_conversation"]);
    expect(self[0].lifetimeRevenueUsd).toBe(500);
    expect(sales[0].lifetimeRevenueUsd).toBe(4000);
    // The funnel is priced on the brand's LEG rates: visit → paid through a signup = 5% × 20%.
    const econ = declaredEconomicsForFunnel(self, "website_purchases")!;
    expect(econ.visitToSignupPct).toBe(5);
    expect(econ.visitToClosePct).toBeCloseTo(1, 9);
  });

  it("a brand-scoped read of a brand selling several offers refuses, naming them — never one picked", async () => {
    mock();
    await expect(fetchPricingFunnels("b1", "org-1", null, { rates: "stated" })).rejects.toBeInstanceOf(SeveralOffersDeclaredError);
  });

  it("a scope whose campaigns perform no leg reads NO funnel — never a substituted one", async () => {
    mock();
    expect(await fetchPricingFunnels("b1", "org-1", "offer-self", { rates: "stated", legKeys: [] })).toEqual([]);
  });
});

// Legistai's ticked sales path (prod, 2026-10-04): reply → meeting → attended → paid, and from a visit
// both to a meeting and to a signup. The Sales funnel page lists three chains; the pipeline walked six.
const LEGISTAI_TICKED = [
  "start_to_website_visit",
  "website_visit_to_meeting_booked",
  "meeting_booked_to_meeting_attended",
  "meeting_attended_to_paid_client",
  "website_visit_to_signup",
  "signup_to_paid_client",
  "start_to_conversation",
  "conversation_to_meeting_booked",
];

describe("offerPathFunnels — the funnels an offer's TICKED sales path walks (same chains as /sales-paths)", () => {
  it("Legistai's ticked legs walk exactly its three Sales-funnel chains, never the un-ticked direct sales or form", () => {
    expect(offerPathFunnels(LEGISTAI_TICKED)).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
      "website_purchases",
    ]);
  });
  it("a funnel missing one ticked leg is not walked", () => {
    expect(offerPathFunnels(["start_to_conversation", "conversation_to_meeting_booked", "meeting_booked_to_meeting_attended"])).toEqual([]);
  });
});

describe("fetchPricingFunnels — an offer with a TICKED sales path is priced on exactly those paths", () => {
  afterEach(() => vi.restoreAllMocks());
  const ECONOMICS = {
    legRates: [],
    offers: [{ offerId: "offer-legistai", name: "Legistai", lifetimeRevenueUsd: 2100, lifetimeRevenueStatedAt: "x" }],
  };
  const CAMPAIGNS = [
    { id: "c1", featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation", offerId: "offer-legistai", status: "ongoing" },
    { id: "c2", featureSlug: "sales-cold-email-outreach", legKey: "start_to_website_visit", offerId: "offer-legistai", status: "ongoing" },
  ];
  const mock = (salesPath: unknown) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("/offer-economics")) return json(ECONOMICS);
      if (url.includes("/sales-path")) return json(salesPath);
      if (url.includes("campaign:3000/campaigns")) return json({ campaigns: CAMPAIGNS });
      return json({});
    });

  it("ticked → the ticked chains; nothing stated → the campaigns' reading funnels (which DIFFER here)", async () => {
    mock({ offerId: "offer-legistai", stated: true, steps: [], legKeys: LEGISTAI_TICKED, statedAt: "x" });
    const ticked = await fetchPricingFunnels("b1", "org-1", "offer-legistai", { rates: "stated" });
    expect(ticked.map((f) => f.funnelKey)).toEqual(["sales_meetings_from_conversation", "sales_meetings_from_website", "website_purchases"]);
    vi.restoreAllMocks();

    mock({ offerId: "offer-legistai", stated: false, steps: null, legKeys: null, statedAt: null });
    const reading = await fetchPricingFunnels("b1", "org-1", "offer-legistai", { rates: "stated" });
    expect(reading.map((f) => f.funnelKey)).not.toEqual(ticked.map((f) => f.funnelKey));
    expect(reading.map((f) => f.funnelKey)).toContain("sales_from_conversation");
  });

  it("a leg-keyed read keeps the legs it names, whatever the offer ticked", async () => {
    mock({ offerId: "offer-legistai", stated: true, steps: [], legKeys: LEGISTAI_TICKED, statedAt: "x" });
    const leg = await fetchPricingFunnels("b1", "org-1", "offer-legistai", { rates: "stated", legKeys: ["start_to_conversation"] });
    expect(leg.map((f) => f.funnelKey)).toContain("sales_from_conversation");
  });
});

describe("the booking-call funnel is DISPLAY ONLY", () => {
  it("is never a reading funnel, whatever the scope performs or states", () => {
    const all = readingFunnelsForLegs(
      ["start_to_conversation", "conversation_to_booking_call", "booking_call_to_meeting_booked", "meeting_booked_to_meeting_attended"],
      () => true,
      () => 1,
    );
    expect(all).not.toContain("sales_meetings_from_call");
    expect(readingFunnelsForLegs(["start_to_conversation"], () => false, () => null)).toEqual([
      "sales_meetings_from_conversation",
      "sales_from_conversation",
    ]);
  });
});
