/**
 * WHICH CAMPAIGNS SELL ONE OFFER — the partition every offer-grain answer is built on.
 *
 * These pin the two things a consumer's numbers depend on: which campaigns a scope resolves to, and
 * what happens to a campaign the producer states no offer for. Both are decided here and nowhere else,
 * so they are tested without a network in sight.
 */
import { describe, it, expect } from "vitest";
import { buildOfferCampaigns, EMPTY_OFFER_CAMPAIGNS } from "./offer-scope.js";
import type { CampaignIdentityRow } from "./campaign-identity.js";

const row = (over: Partial<CampaignIdentityRow> & { id: string }): CampaignIdentityRow => ({
  orgId: "org-1",
  brandId: "b1",
  featureSlug: "sales-cold-email-outreach",
  funnelKey: "sales_meetings_from_conversation",
  acquisitionChannel: "sales-cold-email-outreach",
  status: "ongoing",
  ...over,
});

describe("buildOfferCampaigns — a brand's campaigns partitioned by the offer they sell", () => {
  it("groups every campaign under the offer it states, members ascending", () => {
    const offers = buildOfferCampaigns([
      row({ id: "c3", offerId: "offer-a" }),
      row({ id: "c1", offerId: "offer-a" }),
      row({ id: "c2", offerId: "offer-b" }),
    ]);

    expect(offers.offerIds).toEqual(["offer-a", "offer-b"]);
    // Ascending, so a scope is deterministic — it is folded into a cache key, and the order
    // campaign-service happened to serve its rows in must never decide which cell a read lands on.
    expect(offers.campaignIdsOf("offer-a")).toEqual(["c1", "c3"]);
    expect(offers.campaignIdsOf("offer-b")).toEqual(["c2"]);
    expect(offers.offerIdOf("c3")).toBe("offer-a");
  });

  it("puts a campaign stating NO offer in no group at all — never a default one", () => {
    const offers = buildOfferCampaigns([
      row({ id: "c1", offerId: "offer-a" }),
      row({ id: "c2", offerId: null }),
      row({ id: "c3" }), // the column predates this campaign entirely
    ]);

    expect(offers.offerIds).toEqual(["offer-a"]);
    expect(offers.campaignIdsOf("offer-a")).toEqual(["c1"]);
    expect(offers.offerIdOf("c2")).toBeNull();
    expect(offers.offerIdOf("c3")).toBeNull();
  });

  it("a brand whose campaigns all predate the offer column has NO offers", () => {
    // The honest transition answer: the grouped read serves no group and a scoped one 404s, rather
    // than the brand's own numbers appearing under an offer's name.
    expect(buildOfferCampaigns([row({ id: "c1" }), row({ id: "c2" })]).offerIds).toEqual([]);
  });

  it("an offer no campaign of this brand sells resolves to no campaign, never to the brand", () => {
    const offers = buildOfferCampaigns([row({ id: "c1", offerId: "offer-a" })]);
    expect(offers.campaignIdsOf("offer-zzz")).toEqual([]);
    expect(EMPTY_OFFER_CAMPAIGNS.offerIds).toEqual([]);
    expect(EMPTY_OFFER_CAMPAIGNS.campaignIdsOf("offer-a")).toEqual([]);
  });
});
