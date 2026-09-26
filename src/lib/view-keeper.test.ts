import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const { siblingRequests, brandEntitiesOf, canonicalRequest, diffPaths } = await import("./view-keeper.js");

const entities = {
  campaigns: [
    { id: "c1", featureSlug: "sales-cold-email-outreach" },
    { id: "c2", featureSlug: "pr-expert-quote-outreach" },
    { id: "c3", featureSlug: null },
  ],
  offerIds: ["o1", "o2"],
};

describe("siblingRequests", () => {
  it("asks a campaign-scoped request of every OTHER campaign, moving the channel with it", () => {
    const out = siblingRequests("/features/sales-cold-email-outreach/revenue?pricing=net&campaignId=c1&brandId=b", entities);
    expect(out).toEqual(["/features/pr-expert-quote-outreach/revenue?brandId=b&campaignId=c2&pricing=net"]);
  });

  it("skips a campaign whose channel it cannot name", () => {
    const out = siblingRequests("/features/sales-cold-email-outreach/stats?campaignId=c2", entities);
    expect(out).toEqual(["/features/sales-cold-email-outreach/stats?campaignId=c1"]);
  });

  it("asks an offer-scoped request of every OTHER offer", () => {
    expect(siblingRequests("/offers/o1/revenue?brandId=b&pricing=net", entities)).toEqual(["/offers/o2/revenue?brandId=b&pricing=net"]);
  });

  it("yields nothing for a brand-grain request", () => {
    expect(siblingRequests("/brands/b/revenue?pricing=net", entities)).toEqual([]);
  });
});

describe("brandEntitiesOf", () => {
  it("keeps one campaign per identity (the live one) and every offer sold", () => {
    const rows = [
      { id: "old", brandId: "b", acquisitionChannel: "email", funnelKey: "f", featureSlug: "s", status: "stopped", createdAt: "2026-01-01", offerId: "o1" },
      { id: "live", brandId: "b", acquisitionChannel: "email", funnelKey: "f", featureSlug: "s", status: "ongoing", createdAt: "2026-02-01", offerId: "o1" },
      { id: "other", brandId: "b", acquisitionChannel: "linkedin", funnelKey: "f", featureSlug: "t", status: "stopped", createdAt: "2026-02-01", offerId: "o2" },
    ];
    const e = brandEntitiesOf(rows);
    expect(e.campaigns.map((c) => c.id)).toEqual(["live", "other"]);
    expect(e.offerIds).toEqual(["o1", "o2"]);
  });
});

describe("canonicalRequest", () => {
  it("sorts the query so two spellings compare equal", () => {
    expect(canonicalRequest("/a?b=2&a=1")).toBe(canonicalRequest("/a?a=1&b=2"));
  });
});

describe("diffPaths", () => {
  it("is empty for equal values whatever the key order", () => {
    expect(diffPaths({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toEqual([]);
  });
  it("names every differing path", () => {
    expect(diffPaths({ a: 1, b: [1, 2] }, { a: 2, b: [1, 3, 4] })).toEqual(["$.a", "$.b.length(2!=3)", "$.b[1]"]);
  });
});
