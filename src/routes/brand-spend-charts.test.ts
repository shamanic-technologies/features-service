/**
 * BRAND-GRAIN-READS-1107: the brand's spend chart is the offer chart's rule one level up (every offer, every campaign
 * as one scope). A brand selling ONE offer reads its offer chart byte for byte; several offers are one scope.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.mock("./agent-catalogue.js", () => ({
  funnelCopiesFor: vi.fn(async () => ({
    pipeSteps: new Map([
      ["p-email", { fromStep: "lead_found", toStep: "conversation" }],
      ["p-book", { fromStep: "conversation", toStep: "meeting_booked" }],
    ]),
    pathOf: () => null,
  })),
}));
vi.mock("./public.js", () => ({ fleetLegConversionRatesFromOutcomePrices: () => new Map() }));
vi.mock("../lib/effective-conversion-rates.js", () => ({ getBrandEffectiveRates: vi.fn(async () => ({ legs: [] })) }));
vi.mock("../lib/spend-charts-io.js", async (orig) => ({
  ...(await orig<typeof import("../lib/spend-charts-io.js")>()),
  fetchFollowupActionRows: vi.fn(async () => []),
  // Echo what the chart is computed on: two calls on the same scope and expected figure read the same chart.
  computeSpendChart: vi.fn(async (a: { scope: unknown; expected: unknown; pricing: string; brandId: string }) => ({
    scope: a.scope,
    expected: a.expected,
    pricing: a.pricing,
    brandId: a.brandId,
    outcomeStep: "conversation",
    leg: { fromStep: "lead_found", learningOutcomesRequired: 10 },
  })),
}));
vi.mock("../lib/spend-charts-ledger.js", () => ({
  rebaseSpendChartOnLedger: vi.fn((chart: unknown, row: unknown, from: unknown, bar: number) => ({ chart, row, from, bar })),
}));
vi.mock("../lib/scope-outcome-ledger-io.js", async (orig) => ({
  ...(await orig<typeof import("../lib/scope-outcome-ledger-io.js")>()),
  fetchBrandOutcomeLedger: vi.fn(async () => null),
}));
const path = (roi: number) => ({ rank: 1, combinationKey: `k${roi}`, lifetimeRevenueUsd: 1000, roi, legs: [] });
// The offer model memo, faked once: the offer read's composition (`expectedReturnForOffer` = soft(withMeasuredReturn(
// expectedForOffer(model), null))) is re-bound to it, since a module-internal call never sees a vi.mock.
vi.mock("../lib/expected-return.js", async (orig) => {
  const real = await orig<typeof import("../lib/expected-return.js")>();
  const offerExpectedModel = vi.fn(async (_i: unknown, _b: string, offerId: string) => ({
    offerId,
    body: { paths: [path(offerId === "o2" ? 7 : 3)] },
    selected: [],
    lifetimeRevenueSource: "offer_stated",
    notRunning: false,
  }));
  return {
    ...real,
    offerExpectedModel,
    expectedReturnForOffer: vi.fn(async (i: never, b: string, o: string, measured: never) =>
      real.withMeasuredReturn(real.expectedForOffer((await offerExpectedModel(i, b, o)) as never), measured),
    ),
  };
});

const { computeBrandSpendCharts, computeOfferSpendCharts, mergeOfferChannels } = await import("./spend-charts.js");

const H = { orgId: "org1", userId: "u", runId: "r", featureSlug: undefined };
const row = (id: string, offerId: string, units: Array<[string, string, string]>) =>
  ({
    id,
    brandId: "b1",
    offerId,
    salesFunnelId: `f-${id}`,
    salesFunnelName: "F",
    status: "ongoing",
    stopReason: null,
    createdAt: "2026-07-01T00:00:00Z",
    units: units.map(([campaignId, pipeId, featureSlug]) => ({ campaignId, pipeId, featureSlug, legKey: pipeId, status: "ongoing" })),
  }) as never;
const R1 = row("sfc1", "o1", [["u1", "p-email", "sales-cold-email-outreach"], ["u2", "p-book", "ai-meeting-booking"]]);
const R2 = row("sfc2", "o2", [["u3", "p-email", "sales-cold-email-outreach"]]);
const C1 = [
  { featureSlug: "ai-meeting-booking", campaignIds: ["u2"] },
  { featureSlug: "sales-cold-email-outreach", campaignIds: ["legacy1", "u1"] },
];
const C2 = [{ featureSlug: "sales-cold-email-outreach", campaignIds: ["u3"] }];

describe("computeBrandSpendCharts (BRAND-GRAIN-READS-1107)", () => {
  it("a brand selling ONE offer reads its offer chart byte for byte", async () => {
    const offer = await computeOfferSpendCharts("o1", "b1", [R1], C1, "net", H);
    const brand = await computeBrandSpendCharts("b1", ["o1"], [R1], mergeOfferChannels([C1]), "net", H);
    expect(brand.offerIds).toEqual(["o1"]);
    expect(brand.salesFunnelCampaignIds).toEqual(offer.salesFunnelCampaignIds);
    expect(brand.brand).toEqual(offer.offer);
    expect((brand.brand as unknown as { chart: { expected: { roiMultiple: number } } }).chart.expected.roiMultiple).toBeGreaterThan(0);
  });

  it("several offers: every campaign of every offer is ONE scope; the expected figure is the best offer's", async () => {
    const brand = await computeBrandSpendCharts("b1", ["o1", "o2"], [R1, R2], mergeOfferChannels([C1, C2]), "net", H);
    const chart = (brand.brand as unknown as { chart: { scope: { campaignIds: string[]; featureSlugs: string[]; brandLevelSpend: boolean }; expected: { combinationKey: string } } }).chart;
    expect(chart.scope.campaignIds).toEqual(["legacy1", "u1", "u2", "u3"]);
    expect(chart.scope.featureSlugs).toEqual(["ai-meeting-booking", "sales-cold-email-outreach"]);
    expect(chart.scope.brandLevelSpend).toBe(true);
    expect(chart.expected.combinationKey).toBe("k7");
    expect(brand.salesFunnelCampaignIds).toEqual(["sfc1", "sfc2"]);
  });

  it("mergeOfferChannels: per channel, every campaign of every offer, ascending", () => {
    expect(mergeOfferChannels([C1, C2])).toEqual([
      { featureSlug: "ai-meeting-booking", campaignIds: ["u2"] },
      { featureSlug: "sales-cold-email-outreach", campaignIds: ["legacy1", "u1", "u3"] },
    ]);
  });
});
