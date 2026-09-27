import { describe, it, expect } from "vitest";
import { brandScopesOf, headersFor, instancesOf, orderShapes, shapeKey, shapeOf } from "./view-materializer.js";

const B = "75d7e3e8-6926-4f85-a557-976895400666";
const OTHER = "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb";

// A brand shaped like prod: one channel with an ongoing campaign and a stopped ancestor of the same
// identity, a second identity on another leg, one campaign with no leg, two offers.
const rows = [
  { id: "c-old", orgId: "o", brandId: B, featureSlug: "sales-cold-email-outreach", acquisitionChannel: "email", offerId: "off1", legKey: "start_to_conversation", status: "stopped", createdAt: "2026-08-01" },
  { id: "c-live", orgId: "o", brandId: B, featureSlug: "sales-cold-email-outreach", acquisitionChannel: "email", offerId: "off1", legKey: "start_to_conversation", status: "ongoing", createdAt: "2026-09-01" },
  { id: "c-visit", orgId: "o", brandId: B, featureSlug: "sales-cold-email-outreach", acquisitionChannel: "email", offerId: "off2", legKey: "start_to_website_visit", status: "stopped", createdAt: "2026-09-02" },
  { id: "c-noleg", orgId: "o", brandId: B, featureSlug: "pr-expert-quote-outreach", acquisitionChannel: "pr", offerId: null, legKey: null, status: "stopped", createdAt: "2026-09-03" },
];
const scopes = brandScopesOf(B, rows);

describe("shapeOf", () => {
  it("strips every id so two brands' reads are one shape", () => {
    const a = shapeOf(`/features/sales-cold-email-outreach/revenue?brandId=${B}&campaignId=x&pricing=net`)!;
    const b = shapeOf(`/features/pr-expert-quote-outreach/revenue?pricing=net&campaignId=y&brandId=${OTHER}`)!;
    expect(shapeKey(a)).toBe(shapeKey(b));
    expect(a.kind).toBe("featureCampaign");
  });

  it("classifies each grain", () => {
    expect(shapeOf(`/brands/${B}/revenue?pricing=net`)!.kind).toBe("brandPath");
    expect(shapeOf(`/offers/off1/revenue?brandId=${B}&pricing=net`)!.kind).toBe("offerPath");
    expect(shapeOf(`/features/s/revenue?brandId=${B}&groupBy=campaignId&pricing=net`)!.kind).toBe("featureBrand");
    expect(shapeOf(`/features/s/audience-stats?brandId=${B}&offerId=off1&pricing=net`)!.kind).toBe("featureOffer");
  });

  it("is not a shape: a one-off, a cross-org read, a read naming no brand", () => {
    expect(shapeOf(`/features/s/revenue?brandId=${B}&workflow=w&pricing=net`)).toBeNull();
    expect(shapeOf(`/brands/${B}/contacted-value?leadIds=a,b`)).toBeNull();
    expect(shapeOf(`/features/s/pipeline-activity?brandId=${B}&days=7&timezone=Asia%2FAlmaty`)).toBeNull();
    expect(shapeOf(`/public/stats/return-on-spend?featureSlug=s`)).toBeNull();
    expect(shapeOf(`/features/s/stats?campaignId=x`)).toBeNull();
  });
});

describe("brandScopesOf", () => {
  it("keeps one campaign per identity, live first, and every channel, leg and offer the brand runs", () => {
    expect(scopes.campaigns.map((c) => c.id)).toEqual(["c-live", "c-noleg", "c-visit"]);
    expect(scopes.channels).toEqual([
      { featureSlug: "pr-expert-quote-outreach", legKeys: [] },
      { featureSlug: "sales-cold-email-outreach", legKeys: ["start_to_conversation", "start_to_website_visit"] },
    ]);
    expect(scopes.offers).toEqual([
      { id: "off1", featureSlugs: ["sales-cold-email-outreach"] },
      { id: "off2", featureSlugs: ["sales-cold-email-outreach"] },
    ]);
  });
});

describe("instancesOf", () => {
  const urls = (u: string) => instancesOf(shapeOf(u)!, scopes).map((i) => i.url);

  it("a shape read by ANOTHER brand is asked of this one, on the brand's own id", () => {
    expect(urls(`/brands/${OTHER}/revenue?pricing=net`)).toEqual([`/brands/${B}/revenue?pricing=net`]);
  });

  it("a brand-grain feature shape is asked on every channel the brand runs", () => {
    expect(urls(`/features/x/revenue?brandId=${OTHER}&groupBy=campaignId&pricing=net`)).toEqual([
      `/features/pr-expert-quote-outreach/revenue?brandId=${B}&groupBy=campaignId&pricing=net`,
      `/features/sales-cold-email-outreach/revenue?brandId=${B}&groupBy=campaignId&pricing=net`,
    ]);
  });

  it("a campaign shape is asked of every identity on its OWN channel, never a stopped ancestor", () => {
    expect(urls(`/features/x/revenue?brandId=${OTHER}&campaignId=z&pricing=net`)).toEqual([
      `/features/sales-cold-email-outreach/revenue?brandId=${B}&campaignId=c-live&pricing=net`,
      `/features/pr-expert-quote-outreach/revenue?brandId=${B}&campaignId=c-noleg&pricing=net`,
      `/features/sales-cold-email-outreach/revenue?brandId=${B}&campaignId=c-visit&pricing=net`,
    ]);
  });

  it("a leg-keyed campaign shape takes the campaign's OWN leg and skips a campaign bought for none", () => {
    expect(urls(`/features/x/workflow-projection?brandId=${OTHER}&leg=conversation_to_meeting_booked&campaignId=z&pricing=net`)).toEqual([
      `/features/sales-cold-email-outreach/workflow-projection?brandId=${B}&campaignId=c-live&leg=start_to_conversation&pricing=net`,
      `/features/sales-cold-email-outreach/workflow-projection?brandId=${B}&campaignId=c-visit&leg=start_to_website_visit&pricing=net`,
    ]);
  });

  it("offer shapes go to every offer, feature-offer shapes to every channel that offer is sold through", () => {
    expect(urls(`/offers/q/revenue?brandId=${OTHER}&pricing=net`)).toEqual([
      `/offers/off1/revenue?brandId=${B}&pricing=net`,
      `/offers/off2/revenue?brandId=${B}&pricing=net`,
    ]);
    expect(urls(`/features/x/audience-stats?brandId=${OTHER}&offerId=q&pricing=net&statuses=active%2Cpaused%2Carchived`)).toEqual([
      `/features/sales-cold-email-outreach/audience-stats?brandId=${B}&offerId=off1&pricing=net&statuses=active%2Cpaused%2Carchived`,
      `/features/sales-cold-email-outreach/audience-stats?brandId=${B}&offerId=off2&pricing=net&statuses=active%2Cpaused%2Carchived`,
    ]);
  });

  it("keeps every fixed parameter byte for byte (the cell key is built from them)", () => {
    expect(urls(`/brands/${OTHER}/revenue?pricing=net&cause=outreach,other,unstated`)).toEqual([
      `/brands/${B}/revenue?cause=outreach%2Cother%2Cunstated&pricing=net`,
    ]);
  });
});

describe("orderShapes", () => {
  it("brand grain first, campaign and offer scopes after", () => {
    const kinds = orderShapes([
      shapeOf(`/features/x/revenue?brandId=${B}&campaignId=z`)!,
      shapeOf(`/brands/${B}/revenue`)!,
      shapeOf(`/features/x/revenue?brandId=${B}`)!,
    ]).map((s) => s.kind);
    expect(kinds).toEqual(["brandPath", "featureBrand", "featureCampaign"]);
  });
});

describe("headersFor", () => {
  const recorded = { "x-org-id": "o", "x-user-id": "u", "x-run-id": "r", "x-brand-id": OTHER, "x-campaign-id": "old", "x-api-key": "k" };

  it("swaps the scope headers the org's reads carry, drops the api key and a campaign it does not name", () => {
    expect(headersFor(recorded, B, { url: "/", campaignId: null, featureSlug: "s" })).toEqual({
      "x-org-id": "o",
      "x-user-id": "u",
      "x-run-id": "r",
      "x-brand-id": B,
    });
    expect(headersFor(recorded, B, { url: "/", campaignId: "c1", featureSlug: "s" })["x-campaign-id"]).toBe("c1");
  });

  it("never adds a header the org's reads do not send", () => {
    const h = headersFor({ "x-org-id": "o", "x-user-id": "u", "x-run-id": "r" }, B, { url: "/", campaignId: "c1", featureSlug: "s" });
    expect(h).toEqual({ "x-org-id": "o", "x-user-id": "u", "x-run-id": "r" });
  });
});
