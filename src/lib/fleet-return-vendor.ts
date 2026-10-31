/**
 * THE PUBLIC ROI MEDIAN ON REAL VENDOR COST (PUBLIC-VENDOR-COST-1031), PURE: the live index (`readFleetVendorReturn`,
 * over the fleet-return snapshot) and its history (`lib/client-index-history.ts`, over brand rows replayed as of each
 * day) read the ONE rule. Population = mature brands past the spend floor, the floor read on what they were billed; each
 * brand's pipeline divided by what its mature spend really cost. A brand of that population whose vendor cost is unknown
 * (none stated, or billed spend with no vendor cost past the tolerance) is left out of the median and COUNTED.
 */
import { buildFleetReturnOnSpend, type BrandReturnRow } from "./fleet-return-on-spend.js";
import { overMatureScopes } from "./fleet-return-maturity.js";
import { vendorCoverage } from "./public-vendor-cost.js";

export interface VendorReturnMedian {
  measured: boolean;
  reason: string | null;
  brandCount: number;
  medianReturnPerDollar: number | null;
  vendorCostUnknownBrands: number;
}

export function vendorReturnMedian(brands: readonly BrandReturnRow[], minSpendUsd: number): VendorReturnMedian {
  const floored = brands.filter((b) => b.isMature === true && b.committedSpendUsd >= minSpendUsd);
  const known = floored.filter((b) => {
    const v = b.vendorSpend;
    return Boolean(v) && vendorCoverage(v!.matureUsd, v!.unpricedMatureUsd, b.committedSpendUsd + v!.unpricedMatureUsd).servable;
  });
  const onVendor = known.map((b) => ({ ...b, committedSpendUsd: b.vendorSpend!.matureUsd, flashCommittedSpendUsd: b.vendorSpend!.flashUsd }));
  const r = overMatureScopes(onVendor, (row) => row.isMature, (pop) => buildFleetReturnOnSpend(pop, 0));
  return { measured: r.measured, reason: r.reason, brandCount: r.brandCount, medianReturnPerDollar: r.medianReturnPerDollar, vendorCostUnknownBrands: floored.length - known.length };
}
