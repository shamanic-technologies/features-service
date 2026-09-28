/**
 * THE PER-WORKFLOW AND PER-CAMPAIGN REVENUE ROWS ON ACTUAL COST — `/revenue?groupBy=workflow|campaignId`
 * with every spend figure read at VENDOR cost, before our markup, served on the staff-only
 * `/internal/features/:slug/revenue/actual-cost` path (lib/actual-cost-history.ts says why a customer
 * read can never answer on this basis).
 *
 * ONE COMPUTE, COST READS SWAPPED. The groups are the byte-same compute the billed read makes, with its
 * runs cost reads on the `vendor` basis (pricing.ts): committed cost, the mature-cohort spend and every
 * ratio built on them (ROI, %CAC, $CAC, cost per click / positive reply) come out at vendor cost, and
 * the value leg (pipeline, counts) is untouched.
 *
 * AN UNPRICED GROUP IS STATED, NEVER BORROWED. A group whose committed spend includes rows with no
 * known vendor cost has an unknown vendor spend: every spend figure and every ratio built on it reads
 * null, and the group names the billed amount it could not price (`vendorCost.unpricedBilledCostUsd`)
 * beside the vendor cost of what IS priced. The billed figure is never substituted, and the priced part
 * is never passed off as the whole. PURE.
 */

import type { CostEconomics } from "./cost-economics.js";

export interface GroupVendorStatement {
  /** Vendor cost of the group's PRICED committed rows (comped rows included — still paid to the vendor). */
  pricedVendorCostUsd: number;
  /** BILLED committed spend on the group's rows with no known vendor cost. 0 when every row is priced. */
  unpricedBilledCostUsd: number;
  /** TRUE ⟺ nothing is unpriced, i.e. every spend figure on this group is its real vendor cost. */
  vendorCostKnown: boolean;
}

interface MoneyGroup {
  costEconomics: CostEconomics;
  outcomes?: object | null;
}

/** Null every spend-derived figure of a group whose vendor spend is not fully known. */
function nullSpend<G extends MoneyGroup>(group: G): G {
  const ce = group.costEconomics;
  const costEconomics: CostEconomics = {
    ...ce,
    committedCostUsd: null as unknown as number,
    actualCostUsd: null as unknown as number,
    costOfAcquisitionPct: null,
    roiMultiple: null,
    costPerAcquisitionUsd: null,
    ...(ce.costPerConversionUsd !== undefined ? { costPerConversionUsd: null } : {}),
    ...(ce.ratioBasis ? { ratioBasis: { ...ce.ratioBasis, committedCostUsd: null } } : {}),
    ...(ce.realizedReturn ? { realizedReturn: { ...ce.realizedReturn, roiMultiple: null } } : {}),
  };
  const o = group.outcomes as Record<string, unknown> | null | undefined;
  const outcomes = o
    ? {
        ...o,
        committedSpentCents: null,
        actualSpentCents: null,
        cpcCents: null,
        cpprCents: null,
        ...(o.ratioBasis ? { ratioBasis: { ...(o.ratioBasis as object), committedSpentCents: null } } : {}),
      }
    : o;
  return { ...group, costEconomics, ...(o !== undefined ? { outcomes } : {}) };
}

/**
 * Stamp one vendor-basis group with what its vendor cost rests on, nulling its spend figures when part
 * of that spend could not be priced. `unpricedCents` is the group's billed committed spend on unpriced
 * rows, read on the SAME scope the group's own cost was read on.
 */
export function stampVendorGroup<G extends MoneyGroup>(group: G, unpricedCents: number): G & { vendorCost: GroupVendorStatement } {
  const unpricedBilledCostUsd = unpricedCents / 100;
  const vendorCost: GroupVendorStatement = {
    pricedVendorCostUsd: group.costEconomics.committedCostUsd,
    unpricedBilledCostUsd,
    vendorCostKnown: unpricedCents <= 0,
  };
  return { ...(unpricedCents > 0 ? nullSpend(group) : group), vendorCost };
}
