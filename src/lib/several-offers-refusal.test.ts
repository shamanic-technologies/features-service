/**
 * THE 409 IS A QUESTION WITH SEVERAL ANSWERS, NOT A FAULT — and telling the two apart is the whole
 * point of the subclass. A suite that only asserted "it throws" would pass on the implementation this
 * replaces, which reported brand-service's refusal as a downstream failure and blanked the page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./db/index.js", () => ({ db: {}, sql: {} }));

process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";

const {
  fetchDeclaredSalesFunnels,
  SalesFunnelsUnavailableError,
  SeveralOffersDeclaredError,
  describeSeveralOffers,
} = await import("./sales-funnels-client.js");
const { buildCampaignFamilies } = await import("./campaign-identity.js");

const OFFERS = [
  { offerId: "offer-a", name: "Product-led" },
  { offerId: "offer-b", name: "Sales-led" },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
afterEach(() => fetchSpy?.mockRestore());
beforeEach(() => vi.clearAllMocks());

describe("brand-service's several-offers refusal", () => {
  it("is its own error type, carrying the offers it refused to choose between", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ error: "name the offer", code: "SEVERAL_OFFERS", offers: OFFERS }, 409) as never,
    );
    const err = await fetchDeclaredSalesFunnels("brand-1", "org-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeveralOffersDeclaredError);
    expect((err as InstanceType<typeof SeveralOffersDeclaredError>).offers).toEqual(OFFERS);
    // brand-service's own sentence, rendered verbatim so the two services say one thing.
    expect((err as Error).message).toBe("name the offer");
    expect(describeSeveralOffers(err)).toEqual({ reason: "several_offers", message: "name the offer", offers: OFFERS });
  });

  it("still EXTENDS SalesFunnelsUnavailableError, so every existing fail-soft catch is unchanged", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ error: "x", code: "SEVERAL_OFFERS", offers: OFFERS }, 409) as never,
    );
    const err = await fetchDeclaredSalesFunnels("brand-1", "org-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SalesFunnelsUnavailableError);
  });

  it("is NOT claimed by any other 409, nor by a genuine outage", async () => {
    for (const [body, status] of [
      [{ error: "taken", code: "OFFER_NAME_TAKEN" }, 409],
      [{ error: "boom" }, 503],
      [{ error: "gone" }, 404],
    ] as const) {
      fetchSpy?.mockRestore();
      fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(body, status) as never);
      const err = await fetchDeclaredSalesFunnels("brand-1", "org-1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SalesFunnelsUnavailableError);
      expect(err).not.toBeInstanceOf(SeveralOffersDeclaredError);
      expect(describeSeveralOffers(err)).toBeNull();
    }
  });

  it("names the offer on the WIRE when one is given, and names nothing when none is", async () => {
    const seen: string[] = [];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seen.push(typeof input === "string" ? input : (input as { url: string }).url);
      return json({ funnels: [{ funnelKey: "website_purchases", name: "W", steps: [], rates: {}, lifetimeRevenueUsd: null, destinationUrl: null, bookingUrl: null, updatedAt: "x" }] });
    });
    await fetchDeclaredSalesFunnels("brand-1", "org-1", "offer-b");
    await fetchDeclaredSalesFunnels("brand-1", "org-1");
    expect(seen[0]).toContain("offerId=offer-b");
    expect(seen[1]).not.toContain("offerId=");
  });
});

describe("a campaign identity carries the offer its members sell", () => {
  const base = { orgId: "org-1", brandId: "brand-1", featureSlug: "f", funnelKey: "website_purchases", acquisitionChannel: "cold_email" };

  it("reads the offer off the members, so a campaign-scoped read can name it", () => {
    const families = buildCampaignFamilies([
      { ...base, id: "live", offerId: "offer-b", status: "ongoing", createdAt: "2026-09-01T00:00:00.000Z" },
      { ...base, id: "old", offerId: "offer-b", status: "stopped", createdAt: "2026-08-01T00:00:00.000Z" },
    ]);
    // Either member answers the same, exactly as every other figure on an identity does.
    expect(families.identityOf("live")?.offerId).toBe("offer-b");
    expect(families.identityOf("old")?.offerId).toBe("offer-b");
  });

  it("skips a member predating the column rather than pinning the identity to null", () => {
    const families = buildCampaignFamilies([
      { ...base, id: "old", status: "stopped", createdAt: "2026-07-01T00:00:00.000Z" },
      { ...base, id: "live", offerId: "offer-a", status: "ongoing", createdAt: "2026-09-01T00:00:00.000Z" },
    ]);
    expect(families.identityOf("old")?.offerId).toBe("offer-a");
  });

  it("is null when no member states one — a real state, never a default offer", () => {
    const families = buildCampaignFamilies([{ ...base, id: "solo", status: "ongoing", createdAt: "2026-09-01T00:00:00.000Z" }]);
    expect(families.identityOf("solo")?.offerId).toBeNull();
  });
});
