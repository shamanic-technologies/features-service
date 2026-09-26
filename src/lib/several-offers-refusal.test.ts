/**
 * THE 409 IS A QUESTION WITH SEVERAL ANSWERS, NOT A FAULT — and telling the two apart is the whole
 * point of the subclass. A suite that only asserted "it throws" would pass on the implementation this
 * replaces, which reported brand-service's refusal as a downstream failure and blanked the page.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";

const { SalesFunnelsUnavailableError, SeveralOffersDeclaredError, describeSeveralOffers } = await import(
  "./sales-funnels-client.js"
);
const { resolvePricedOffer } = await import("./reading-funnels.js");
const { buildCampaignFamilies } = await import("./campaign-identity.js");

const OFFERS = [
  { offerId: "offer-a", name: "Product-led", lifetimeRevenueUsd: 500 },
  { offerId: "offer-b", name: "Sales-led", lifetimeRevenueUsd: 4000 },
];

// Wave C1: the refusal is no longer brand-service's 409 (the declared read is gone) — it is raised here,
// from the offers `offer-economics` lists, with the SAME type and the SAME wire block.
describe("a brand-scoped pricing read of a brand selling several offers", () => {
  it("is its own error type, carrying the offers it will not choose between", () => {
    let err: unknown;
    try {
      resolvePricedOffer(OFFERS, null, "brand-1");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SeveralOffersDeclaredError);
    expect((err as InstanceType<typeof SeveralOffersDeclaredError>).offers).toEqual([
      { offerId: "offer-a", name: "Product-led" },
      { offerId: "offer-b", name: "Sales-led" },
    ]);
    expect(describeSeveralOffers(err)).toMatchObject({ reason: "several_offers" });
  });

  it("still EXTENDS SalesFunnelsUnavailableError, so every existing fail-soft catch is unchanged", () => {
    expect(() => resolvePricedOffer(OFFERS, null, "brand-1")).toThrow(SalesFunnelsUnavailableError);
  });

  it("naming the offer answers with THAT offer's lifetime revenue; one offer needs no name", () => {
    expect(resolvePricedOffer(OFFERS, "offer-b", "brand-1").lifetimeRevenueUsd).toBe(4000);
    expect(resolvePricedOffer([OFFERS[0]], null, "brand-1").offerId).toBe("offer-a");
  });

  it("an offer that is not the brand's, or a brand with none, is unavailable — never the several-offers answer", () => {
    for (const run of [() => resolvePricedOffer(OFFERS, "offer-z", "brand-1"), () => resolvePricedOffer([], null, "brand-1")]) {
      let err: unknown;
      try {
        run();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SalesFunnelsUnavailableError);
      expect(err).not.toBeInstanceOf(SeveralOffersDeclaredError);
      expect(describeSeveralOffers(err)).toBeNull();
    }
  });
});

describe("a campaign identity carries the offer its members sell", () => {
  const base = { orgId: "org-1", brandId: "brand-1", featureSlug: "f", legKey: "start_to_website_visit", acquisitionChannel: "cold_email" };

  it("reads the offer off the members, so a campaign-scoped read can name it", () => {
    const families = buildCampaignFamilies([
      { ...base, id: "live", offerId: "offer-b", status: "ongoing", createdAt: "2026-09-01T00:00:00.000Z" },
      { ...base, id: "old", offerId: "offer-b", status: "stopped", createdAt: "2026-08-01T00:00:00.000Z" },
    ]);
    // Either member answers the same, exactly as every other figure on an identity does.
    expect(families.identityOf("live")?.offerId).toBe("offer-b");
    expect(families.identityOf("old")?.offerId).toBe("offer-b");
  });

  it("the offer is PART of the identity (campaign-service's own index): a member predating the column is not folded in", () => {
    const families = buildCampaignFamilies([
      { ...base, id: "old", status: "stopped", createdAt: "2026-07-01T00:00:00.000Z" },
      { ...base, id: "live", offerId: "offer-a", status: "ongoing", createdAt: "2026-09-01T00:00:00.000Z" },
    ]);
    expect(families.identityOf("live")?.offerId).toBe("offer-a");
    expect(families.familyOf("old")).toEqual(["old"]);
    expect(families.identityOf("old")?.offerId).toBeNull();
  });

  it("is null when no member states one — a real state, never a default offer", () => {
    const families = buildCampaignFamilies([{ ...base, id: "solo", status: "ongoing", createdAt: "2026-09-01T00:00:00.000Z" }]);
    expect(families.identityOf("solo")?.offerId).toBeNull();
  });
});
