/**
 * A BRAND THAT SELLS SEVERAL OFFERS IS NOT AN OUTAGE — the declaration read, the SET question, and the
 * campaign that already names the offer.
 *
 * brand-service refuses a brand-scoped declaration read for a brand selling several offers (409
 * `SEVERAL_OFFERS`), because each offer carries its own conversion rates, its own lifetime revenue and
 * its own value proposition. features-service turned that refusal into a 502 and blanked three
 * customer-facing surfaces the moment an org clicked "create offer" a second time.
 *
 * Every case here asserts the DIVERGENCE between what a several-offer brand answers and what the same
 * code answers for a brand selling one thing — a suite that only checked "it did not throw" would pass
 * on an implementation that swallowed the refusal and priced one proposition under the other's name,
 * which is the one outcome worse than the 502.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";

const { fetchDeclaredSalesFunnels, SeveralOffersError, SalesFunnelsUnavailableError, declaredFunnelsGapOf } =
  await import("./sales-funnels-client.js");
const { fetchDeclaredFunnelKeys } = await import("./brand-funnels.js");
const { fetchCampaignScopeSoft } = await import("./offer-scope.js");

const BRAND = "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb";
const ORG = "f0420eb5-8f72-4f0a-a150-f473746df1e6";
const PRODUCT_LED = "832126f3-f3f1-4601-885d-bc8e101e5680";
const SALES_LED = "5a2868bb-ac88-42f6-a00a-e49b89b04079";

/** The 409 body brand-service actually serves, read off production on 2026-09-15. */
const SEVERAL_OFFERS_BODY = {
  error: `Brand ${BRAND} sells 2 offers (Product-led, Sales-led), so a brand-scoped call has no single answer: each offer carries its own conversion rates, its own lifetime revenue and its own value proposition. Name the offer — use the /orgs/brands/{brandId}/offers/{offerId}/... routes.`,
  code: "SEVERAL_OFFERS",
  offers: [
    { offerId: PRODUCT_LED, name: "Product-led" },
    { offerId: SALES_LED, name: "Sales-led" },
  ],
};

const funnel = (funnelKey: string, lifetimeRevenueUsd: number) => ({
  funnelKey,
  active: true,
  name: funnelKey,
  steps: [],
  rates: {},
  lifetimeRevenueUsd,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-09-15T00:00:00.000Z",
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.restoreAllMocks());

describe("the declared-funnel read tells a several-offer brand apart from an outage", () => {
  it("raises SeveralOffersError carrying the offers brand-service itself named", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(SEVERAL_OFFERS_BODY, 409));

    const error = await fetchDeclaredSalesFunnels(BRAND, ORG).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SeveralOffersError);
    const several = error as InstanceType<typeof SeveralOffersError>;
    expect(several.offers).toEqual([
      { offerId: PRODUCT_LED, name: "Product-led" },
      { offerId: SALES_LED, name: "Sales-led" },
    ]);
    // A SUBCLASS on purpose: every call site this change has not taught to degrade keeps its documented
    // 502 instead of falling through to an unhandled 500.
    expect(several).toBeInstanceOf(SalesFunnelsUnavailableError);
    // The wire shape is the producer's answer, never authored here.
    expect(declaredFunnelsGapOf(several)).toEqual({
      reason: "several_offers",
      offers: several.offers,
      message: SEVERAL_OFFERS_BODY.error,
    });
  });

  it("a 409 that is NOT the several-offers code stays a plain unavailable — the two are never conflated", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "something else entirely" }, 409));

    const error = await fetchDeclaredSalesFunnels(BRAND, ORG).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SalesFunnelsUnavailableError);
    expect(error).not.toBeInstanceOf(SeveralOffersError);
  });

  it("naming the offer puts it on the wire, and the brand selling one thing sends no offer at all", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(typeof input === "string" ? input : (input as URL).toString());
      return json({ funnels: [funnel("website_purchases", 200)] });
    });

    await fetchDeclaredSalesFunnels(BRAND, ORG, PRODUCT_LED);
    await fetchDeclaredSalesFunnels(BRAND, ORG);

    expect(urls[0]).toBe(`http://brand:3000/internal/brands/${BRAND}/sales-funnels?offerId=${PRODUCT_LED}`);
    // Byte-unchanged for every brand selling one thing, which is what keeps today's traffic identical.
    expect(urls[1]).toBe(`http://brand:3000/internal/brands/${BRAND}/sales-funnels`);
  });
});

describe("fetchDeclaredFunnelKeys — a SET composes across offers where a rate does not", () => {
  it("answers the UNION of the offers' declarations, in catalogue order, reading each offer by name", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      urls.push(url);
      if (!url.includes("offerId=")) return json(SEVERAL_OFFERS_BODY, 409);
      return url.includes(PRODUCT_LED)
        ? json({ funnels: [funnel("website_purchases", 200), funnel("form_magnet", 200)] })
        : json({ funnels: [funnel("sales_meetings_from_conversation", 20000), funnel("form_magnet", 20000)] });
    });

    const keys = await fetchDeclaredFunnelKeys(BRAND, ORG);

    // The union, deduped (`form_magnet` is declared by BOTH offers) and in the catalogue's own order —
    // never a blend of two propositions' rates, which is exactly what brand-service refuses to serve.
    expect(keys).toEqual(["sales_meetings_from_conversation", "website_purchases", "form_magnet"]);
    expect(urls.filter((u) => u.includes("offerId=")).length).toBe(2);
    // The brand-scoped attempt came FIRST — a brand selling one thing never pays for the fan-out.
    expect(urls[0].includes("offerId=")).toBe(false);
  });

  it("an offer whose own declaration is unreadable is left out, never taking its sibling's funnels with it", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (!url.includes("offerId=")) return json(SEVERAL_OFFERS_BODY, 409);
      if (url.includes(PRODUCT_LED)) return json({ error: "boom" }, 500);
      return json({ funnels: [funnel("sales_meetings_from_conversation", 20000)] });
    });

    expect(await fetchDeclaredFunnelKeys(BRAND, ORG)).toEqual(["sales_meetings_from_conversation"]);
  });

  it("with NO offer answering, the producer's refusal is re-thrown — we know nothing, and say so", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      return url.includes("offerId=") ? json({ error: "boom" }, 500) : json(SEVERAL_OFFERS_BODY, 409);
    });

    await expect(fetchDeclaredFunnelKeys(BRAND, ORG)).rejects.toBeInstanceOf(SeveralOffersError);
  });

  it("a caller that NAMED an offer asked an answerable question — no fan-out, one read", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(typeof input === "string" ? input : (input as URL).toString());
      return json({ funnels: [funnel("website_purchases", 200)] });
    });

    expect(await fetchDeclaredFunnelKeys(BRAND, ORG, PRODUCT_LED)).toEqual(["website_purchases"]);
    expect(urls.length).toBe(1);
  });

  it("a brand selling ONE offer is byte-unchanged: one read, no offer on the wire", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(typeof input === "string" ? input : (input as URL).toString());
      return json({ funnels: [funnel("website_purchases", 200), funnel("form_magnet", 200)] });
    });

    expect(await fetchDeclaredFunnelKeys(BRAND, ORG)).toEqual(["website_purchases", "form_magnet"]);
    expect(urls).toEqual([`http://brand:3000/internal/brands/${BRAND}/sales-funnels`]);
  });
});

describe("fetchCampaignScopeSoft — the campaign already names the offer, off ONE read", () => {
  const rows = [
    { id: "c-live", orgId: ORG, brandId: BRAND, acquisitionChannel: "sales-cold-email-outreach", funnelKey: "website_purchases", offerId: PRODUCT_LED, status: "ongoing" },
    { id: "c-old", orgId: ORG, brandId: BRAND, acquisitionChannel: "sales-cold-email-outreach", funnelKey: "website_purchases", offerId: PRODUCT_LED, status: "stopped" },
    { id: "c-other", orgId: ORG, brandId: BRAND, acquisitionChannel: "sales-cold-email-outreach", funnelKey: "sales_meetings_from_conversation", offerId: SALES_LED, status: "ongoing" },
    { id: "c-offerless", orgId: ORG, brandId: BRAND, acquisitionChannel: "sales-cold-email-outreach", funnelKey: "form_magnet", offerId: null, status: "ongoing" },
  ];

  it("serves BOTH grains — the identity family and the offer — from a single /campaigns call", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      return json({ campaigns: rows });
    });

    const scope = await fetchCampaignScopeSoft(BRAND, "sales-cold-email-outreach", { orgId: ORG });

    expect(calls).toBe(1);
    expect(scope.families.familyOf("c-live")).toEqual(["c-live", "c-old"]);
    expect(scope.offerOf("c-live")).toBe(PRODUCT_LED);
    // A different campaign of the SAME brand sells a DIFFERENT offer — the divergence the whole change
    // exists for: pricing both on one brand-scoped declaration is what brand-service refuses.
    expect(scope.offerOf("c-other")).toBe(SALES_LED);
  });

  it("a campaign stating no offer, and no campaign at all, both resolve to undefined — never a default", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ campaigns: rows }));
    const scope = await fetchCampaignScopeSoft(BRAND, "sales-cold-email-outreach", { orgId: ORG });

    expect(scope.offerOf("c-offerless")).toBeUndefined();
    expect(scope.offerOf(undefined)).toBeUndefined();
    expect(scope.offerOf("c-unknown")).toBeUndefined();
  });

  it("FAIL-SOFT: campaign-service down leaves the offer unknown and the read behaving as it does today", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "down" }, 500));

    const scope = await fetchCampaignScopeSoft(BRAND, "sales-cold-email-outreach", { orgId: ORG });

    expect(scope.offerOf("c-live")).toBeUndefined();
    expect(scope.offers.offerIds).toEqual([]);
    expect(scope.families.familyOf("c-live")).toEqual(["c-live"]);
  });
});
