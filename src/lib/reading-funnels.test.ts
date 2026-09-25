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

const { readingFunnelsForLegs, onwardPathScore, offerLegKeys, fetchPricingFunnels } = await import("./reading-funnels.js");
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
    // A pre-leg ancestor: the one leg its channel performs inside the funnel it states.
    { id: "d", featureSlug: "sales-cold-email-outreach", funnelKey: "website_purchases", offerId: null, status: "stopped" },
  ];
  it("every status and channel of THIS offer — never the other offer's", () => {
    expect(offerLegKeys(rows, "offer-1")).toEqual(["conversation_to_meeting_booked", "start_to_conversation"]);
    expect(offerLegKeys(rows, "offer-2")).toEqual(["start_to_website_visit"]);
  });
  it("a row predating the offer is the SOLE offer's, and only when the brand sells one", () => {
    expect(offerLegKeys(rows, "offer-2", true)).toEqual(["start_to_website_visit"]);
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

  it("a funnel a route NAMES is priced even when no campaign reads it", async () => {
    mock();
    const named = await fetchPricingFunnels("b1", "org-1", "offer-self", { rates: "stated", legKeys: [], include: ["form_magnet"] });
    expect(named.map((f) => f.funnelKey)).toEqual(["form_magnet"]);
  });

  it("a scope whose campaigns perform no leg reads NO funnel — never a substituted one", async () => {
    mock();
    expect(await fetchPricingFunnels("b1", "org-1", "offer-self", { rates: "stated", legKeys: [] })).toEqual([]);
  });
});
