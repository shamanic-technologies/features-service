/**
 * THE STAFF ACTUAL-COST TWIN STATES BOTH VERSIONS OF A LEG-KEYED ROW, each known on ITS OWN version
 * (features-service#1196). A grain whose YOUNG spend holds rows with no vendor cost can still state a real
 * mature vendor cost, and the reverse; a figure that cannot be priced reads null, never the billed amount.
 */
import { describe, it, expect } from "vitest";
import { overlayVendorProjection } from "./actual-cost-projection.js";

const figures = (spentUsd: number, outcomes: number) => ({
  spentUsd,
  contacted: 100,
  outcomes,
  costPerOutcomeUsd: outcomes > 0 ? spentUsd / outcomes : null,
  conversionRatePct: outcomes,
});

/** One grain block on `basis`, its own fields read off the version it is priced on. */
function block(basis: "flash" | "mature", flash: [number, number], mature: [number, number]) {
  const own = basis === "mature" ? mature : flash;
  return {
    costBasis: "charged",
    basis,
    evidence: { spentUsd: own[0], observedContacted: 100, observedClicks: own[1], observedPositiveReplies: 0 },
    unitCosts: { costPerClickUsd: own[0] / own[1], costPerPositiveReplyUsd: own[0], costPerContactedUsd: own[0] / 100 },
    resolvedOutcomeCount: own[1],
    projected: { costPerSignupUsd: 1, costPerPaidClientUsd: 2, costPerMeetingBookedUsd: 3, roiMultiple: 4, cacPct: 25 },
    flash: figures(...flash),
    mature: figures(...mature),
    isMature: true,
  };
}

function response(basis: "flash" | "mature", grains: Record<string, unknown>, resolvedCost: { flash: number; mature: number }) {
  const cost = basis === "mature" ? resolvedCost.mature : resolvedCost.flash;
  return {
    rows: [
      {
        audienceId: null,
        workflow: { workflowDynastySlug: "dyn-a", workflowDynastyName: "A" },
        estimatesByGrain: grains,
        resolved: {
          costBasis: "charged",
          grain: "brand",
          costPerClickUsd: cost,
          costPerOutcomeUsd: cost,
          costPerPaidClientUsd: 10,
          costPerMeetingBookedUsd: 5,
          roiMultiple: 2,
          cacPct: 50,
          conversionRatePct: 20,
        },
        measured: true,
        maturity: {
          basis,
          isMature: true,
          matureOutcomes: 20,
          resolved: {
            flash: { grain: "brand", costPerOutcomeUsd: resolvedCost.flash, conversionRatePct: 14 },
            mature: { grain: "brand", costPerOutcomeUsd: resolvedCost.mature, conversionRatePct: 20 },
            isMature: true,
          },
        },
      },
    ],
    recommendedBudgetUsd: 50,
  } as any;
}

// BILLED: $300 flash / $100 mature at the fleet; $260 / $60 at the brand. VENDOR: the same at 1/5.
const BILLED = response(
  "mature",
  { crossOrg: block("mature", [300, 22], [100, 20]), brand: block("mature", [260, 14], [60, 12]) },
  { flash: 260 / 14, mature: 5 },
);
const VENDOR = response(
  "mature",
  { crossOrg: block("mature", [60, 22], [20, 20]), brand: block("mature", [52, 14], [12, 12]) },
  { flash: 52 / 14, mature: 1 },
);

describe("overlayVendorProjection — both versions of a leg-keyed row", () => {
  it("unpriced spend only in the YOUNG runs: the mature side is real vendor money, the flash side is null", () => {
    // The unpriced read holds $10 of young fleet spend and nothing mature: its own ladder sits on FLASH.
    const UNPRICED = response("flash", { crossOrg: block("flash", [10, 22], [0, 20]) }, { flash: 1, mature: 1 });
    const out = overlayVendorProjection(BILLED, VENDOR, UNPRICED);
    const row = out.rows[0] as any;

    // The row is priced on MATURE, and nothing mature is unpriced: vendor money throughout.
    expect(row.estimatesByGrain.crossOrg.vendorCost.vendorCostKnown).toBe(true);
    expect(row.estimatesByGrain.crossOrg.evidence.spentUsd).toBe(20);
    expect(row.estimatesByGrain.crossOrg.mature).toMatchObject({ spentUsd: 20, costPerOutcomeUsd: 1 });
    // …but $10 of the fleet's flash spend has no vendor cost: that version's money is unknown.
    expect(row.estimatesByGrain.crossOrg.flash).toMatchObject({ spentUsd: null, costPerOutcomeUsd: null, outcomes: 22 });
    // The brand holds no unpriced spend on either version.
    expect(row.estimatesByGrain.brand.flash).toMatchObject({ spentUsd: 52 });
    expect(row.estimatesByGrain.brand.mature).toMatchObject({ spentUsd: 12, costPerOutcomeUsd: 1 });
    // The row's two prices floor through the fleet grain.
    expect(row.maturity.resolved.mature.costPerOutcomeUsd).toBe(1);
    expect(row.maturity.resolved.flash.costPerOutcomeUsd).toBeNull();
    expect(row.maturity.resolved.flash.conversionRatePct).toBe(14);
    // The verdict and the version are the billed read's, untouched.
    expect(row.maturity).toMatchObject({ basis: "mature", isMature: true, matureOutcomes: 20 });
    expect(row.estimatesByGrain.brand.isMature).toBe(true);
  });

  it("unpriced spend in the OLD runs: the mature side and the priced fields are null — never the billed amount", () => {
    const UNPRICED = response("mature", { crossOrg: block("mature", [10, 22], [10, 20]) }, { flash: 1, mature: 1 });
    const out = overlayVendorProjection(BILLED, VENDOR, UNPRICED);
    const row = out.rows[0] as any;
    expect(row.estimatesByGrain.crossOrg.vendorCost.vendorCostKnown).toBe(false);
    expect(row.estimatesByGrain.crossOrg.evidence.spentUsd).toBeNull();
    expect(row.estimatesByGrain.crossOrg.mature).toMatchObject({ spentUsd: null, costPerOutcomeUsd: null, outcomes: 20 });
    // The brand's OWN mature spend is fully priced (an observed pair never floors)…
    expect(row.estimatesByGrain.brand.mature).toMatchObject({ spentUsd: 12 });
    // …but its priced fields floor against the fleet, whose mature money is unknown.
    expect(row.estimatesByGrain.brand.vendorCost.vendorCostKnown).toBe(false);
    // Its FLASH side cannot be read at all (the unpriced read sat on mature): unknown, not zero.
    expect(row.estimatesByGrain.brand.flash).toMatchObject({ spentUsd: null, costPerOutcomeUsd: null });
    expect(row.maturity.resolved.mature.costPerOutcomeUsd).toBeNull();
    expect(row.resolved.costPerOutcomeUsd).toBeNull();
    expect(row.resolved.vendorCostKnown).toBe(false);
  });

  it("a vendor read that priced the row on the OTHER version never lends its fields to this one", () => {
    // Every mature dollar unpriced at the brand leaves the vendor ladder without a mature grain there, so
    // its row sits on flash while the billed row sits on mature.
    const VENDOR_FLASH = response(
      "flash",
      { crossOrg: block("flash", [60, 22], [20, 20]), brand: block("flash", [52, 14], [12, 12]) },
      { flash: 52 / 14, mature: 1 },
    );
    const UNPRICED = response("flash", {}, { flash: 1, mature: 1 });
    const out = overlayVendorProjection(BILLED, VENDOR_FLASH, UNPRICED);
    const row = out.rows[0] as any;
    expect(row.estimatesByGrain.brand.vendorCost.vendorCostKnown).toBe(false);
    expect(row.estimatesByGrain.brand.evidence.spentUsd).toBeNull();
    expect(row.resolved.costPerOutcomeUsd).toBeNull();
    // The observed pairs are stated per version on the vendor read whatever its basis.
    expect(row.estimatesByGrain.brand.mature).toMatchObject({ spentUsd: 12 });
  });
});
