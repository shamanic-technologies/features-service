import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const { resolveLifetimeRevenue, offerLifetimeRevenue } = await import("./offer-lifetime-revenue.js");
const { buildFleetLifetimeRevenueMedian, getFleetLifetimeRevenueMedian } = await import("./effective-conversion-rates.js");
const { economicsFromTerms, offerTermsEconomics, economicsFingerprint } = await import("./offer-priced-economics.js");
const { withFleetMedianLifetimeRevenue, resolveRecapLifetimeRevenue } = await import("./org-period-recap.js");

describe("every offer has a lifetime revenue: stated > fleet median (owner 2026-10-09)", () => {
  it("stated wins, else the fleet median, never 0", () => {
    expect(resolveLifetimeRevenue(1200, 2500)).toEqual({ usd: 1200, source: "offer_stated" });
    expect(resolveLifetimeRevenue(null, 2500)).toEqual({ usd: 2500, source: "fleet_median" });
    expect(resolveLifetimeRevenue(0, 2500)).toEqual({ usd: 2500, source: "fleet_median" });
    expect(resolveLifetimeRevenue(null, null)).toEqual({ usd: null, source: null });
    expect(resolveLifetimeRevenue(null, 0)).toEqual({ usd: null, source: null });
  });

  it("a stated value never reads the fleet; an unstated one takes the median; an unreadable fleet is unpriced, not a throw", async () => {
    const median = vi.mocked(getFleetLifetimeRevenueMedian);
    median.mockClear();
    expect(await offerLifetimeRevenue(800)).toEqual({ usd: 800, source: "offer_stated" });
    expect(median).not.toHaveBeenCalled();
    median.mockResolvedValueOnce({ usd: 2500, offerCount: 138 });
    expect(await offerLifetimeRevenue(null)).toEqual({ usd: 2500, source: "fleet_median" });
    median.mockRejectedValueOnce(new Error("lead-service down"));
    expect(await offerLifetimeRevenue(null)).toEqual({ usd: null, source: null });
  });

  it("the fleet median is one point per OFFER over stated (> 0) values — never per brand, never an average", () => {
    const offer = (offerId: string, v: number | null) => ({ offerId, name: offerId, lifetimeRevenueUsd: v });
    const out = buildFleetLifetimeRevenueMedian([
      [offer("a", 100), offer("b", 200), offer("c", null)],
      [offer("d", 10_000), offer("a", 100)], // "a" seen twice (two claiming orgs) counts once
      [offer("e", 0)],
    ]);
    expect(out).toEqual({ usd: 200, offerCount: 3 }); // median of 100, 200, 10000; the mean would be 3433
    expect(buildFleetLifetimeRevenueMedian([[offer("x", null)]])).toEqual({ usd: null, offerCount: 0 });
  });
});

describe("the priced economics carry where the lifetime revenue came from", () => {
  it("economicsFromTerms echoes the source; unpriced carries none", () => {
    expect(economicsFromTerms({ lifetimeRevenueUsd: 2500 }, ["sales_from_website"], "fleet_median").lifetimeRevenueSource).toBe("fleet_median");
    expect(economicsFromTerms({}, ["sales_from_website"]).unpricedReason).toBe("lifetime_revenue_not_stated");
    expect(economicsFromTerms({}, []).unpricedReason).toBe("no_priced_funnel");
  });

  it("offerTermsEconomics reads the source off the priced funnels, and the fingerprint moves with it", () => {
    const funnel = (source: "offer_stated" | "fleet_median") => ({
      funnelKey: "sales_from_website" as const,
      name: "x",
      steps: [],
      rates: { visitToPaidClientPct: 2 },
      lifetimeRevenueUsd: 2500,
      lifetimeRevenueSource: source,
      destinationUrl: null,
      bookingUrl: null,
      updatedAt: "",
    });
    const median = offerTermsEconomics([funnel("fleet_median")], ["sales_from_website"]);
    const stated = offerTermsEconomics([funnel("offer_stated")], ["sales_from_website"]);
    expect(median.economics?.lifetimeRevenueUsd).toBe(2500);
    expect(median.lifetimeRevenueSource).toBe("fleet_median");
    expect(stated.lifetimeRevenueSource).toBe("offer_stated");
    expect(economicsFingerprint(median)).not.toBe(economicsFingerprint(stated));
  });
});

describe("period recap: unstated offers valued at the fleet median", () => {
  it("fills only the unstated offers and names the source", () => {
    const offers = [
      { offerId: "o1", lifetimeRevenueUsd: null, lifetimeRevenueStatedAt: null },
      { offerId: "o2", lifetimeRevenueUsd: null, lifetimeRevenueStatedAt: null },
    ];
    const filled = withFleetMedianLifetimeRevenue(offers, 2500);
    expect(resolveRecapLifetimeRevenue(filled)).toMatchObject({ usd: 2500, source: "fleet_median", nullReason: null });
    // One stated at the median value, one defaulted: the value agrees, the provenance does not → source null.
    const mixed = withFleetMedianLifetimeRevenue([{ offerId: "o1", lifetimeRevenueUsd: 2500, lifetimeRevenueStatedAt: "2026-10-01" }, offers[1]], 2500);
    expect(resolveRecapLifetimeRevenue(mixed)).toMatchObject({ usd: 2500, source: null });
    // Stated and defaulted values differ: no one figure is true.
    const differs = withFleetMedianLifetimeRevenue([{ offerId: "o1", lifetimeRevenueUsd: 900, lifetimeRevenueStatedAt: "2026-10-01" }, offers[1]], 2500);
    expect(resolveRecapLifetimeRevenue(differs).nullReason).toBe("lifetime_revenue_differs_across_offers");
    expect(resolveRecapLifetimeRevenue(withFleetMedianLifetimeRevenue(offers, null)).nullReason).toBe("economics_missing");
  });
});
