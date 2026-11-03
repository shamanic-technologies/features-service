import { describe, expect, it } from "vitest";
import { buildCostEconomics } from "./cost-economics.js";
import { servedCostEconomics, servedHeadline, servedRevenueBody } from "./retired-returns.js";

// ROI-CONSISTENCY-1103: a revenue body serves no pipeline-based return and no pipeline dollars; the two
// returns that stay (`expectedReturn`, `costEconomics.realizedReturn`) pass through untouched.
const ce = buildCostEconomics({
  committedCostInUsdCents: 9356,
  actualCostInUsdCents: 9356,
  totalPipelineUsd: 3750,
  lifetimeRevenueUsd: 1000,
  realized: { closedWonCount: 0, closedWonRevenueUsd: 0 },
});

describe("the served revenue body (ROI-CONSISTENCY-1103)", () => {
  it("cuts the pipeline-based ratios, their pair and the pipeline they divided, keeps spend and the realized return", () => {
    const served = servedCostEconomics({ ...ce, maturity: { flash: null, mature: null, isMature: null } });
    expect(served).not.toHaveProperty("roiMultiple");
    expect(served).not.toHaveProperty("costOfAcquisitionPct");
    expect(served).not.toHaveProperty("costPerAcquisitionUsd");
    expect(served).not.toHaveProperty("maturity");
    expect(served.ratioBasis).toEqual({ committedCostUsd: 93.56 });
    expect(served.committedCostUsd).toBe(93.56);
    // Beyond Logic, prod 2026-11-03: realized 0x on $93.56 spent stays; the 40x pipeline ROI does not.
    expect(served.realizedReturn).toEqual({ closedWonCount: 0, closedWonRevenueUsd: 0, spentUsd: 93.56, roiMultiple: 0 });
  });

  it("drops the headline pipeline and the dated pipeline, recursing into channel / group / offer rows", () => {
    const expectedReturn = { roiMultiple: 18.5, basis: "fleet" };
    const body = servedRevenueBody({
      headline: { totalPipelineUsd: 3750, unpricedReason: null, lifetimeRevenueUsd: 1000 },
      costEconomics: ce,
      timeSeries: [{ date: "2026-11-01", cumulativePipelineUsd: 3750 }],
      expectedReturn,
      channels: [{ featureSlug: "x", headline: { totalPipelineUsd: 1, unpricedReason: null }, costEconomics: ce }],
      groups: [{ campaignId: "c", headline: { totalPipelineUsd: 2, unpricedReason: null }, costEconomics: ce }],
    });
    expect(body.headline).toEqual({ unpricedReason: null, lifetimeRevenueUsd: 1000 });
    expect(body).not.toHaveProperty("timeSeries");
    expect(body.expectedReturn).toBe(expectedReturn);
    expect(JSON.stringify(body)).not.toMatch(/totalPipelineUsd|costOfAcquisitionPct|costPerAcquisitionUsd|cumulativePipelineUsd/);
    expect(body.channels[0].costEconomics).not.toHaveProperty("roiMultiple");
    expect(body.groups[0].headline).toEqual({ unpricedReason: null });
  });

  it("a headline is cut without touching its reason", () => {
    expect(servedHeadline({ totalPipelineUsd: null, unpricedReason: "no_funnel_wired" })).toEqual({ unpricedReason: "no_funnel_wired" });
  });
});
