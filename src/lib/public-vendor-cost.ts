/**
 * PUBLIC MONEY FIGURES AT REAL VENDOR COST (owner 2026-10-31, PUBLIC-VENDOR-COST-1031: « afficher le cost réel, si on
 * enlève notre markup depuis le début »). Every money figure a VISITOR reads (the fleet indexes and their history, the
 * homepage showcase) is priced on what the vendors charged us, before our markup, whole history. Customer-authed and
 * staff reads keep their own basis.
 *
 * A row with no known vendor cost must never make a public figure read low silently. The rule, PURE:
 *   - unpriced billed spend ≤ {@link PUBLIC_VENDOR_UNPRICED_TOLERANCE_PCT} of the scope's billed spend: the figure is
 *     served on the vendor cost of the priced rows, and states the unpriced share beside it;
 *   - above it: the figure is null with `vendor_cost_unknown`, never the billed figure, never the priced part as the whole.
 */

/** The share of a scope's billed spend that may lack a vendor cost before its public figure is withheld (%). */
export const PUBLIC_VENDOR_UNPRICED_TOLERANCE_PCT = 1;

export interface VendorCoverage {
  /** Vendor cost of the scope's priced rows (comped rows included: still paid to the vendor), USD. */
  vendorUsd: number;
  /** Billed spend on the scope's rows with no known vendor cost, USD. */
  unpricedBilledUsd: number;
  /** Billed spend of the whole scope (comped rows included), USD. */
  billedUsd: number;
  /** unpriced ÷ billed, %; 0 when nothing was billed. */
  unpricedSharePct: number;
  /** TRUE ⟺ the unpriced share is within the tolerance: the vendor figure may be served. */
  servable: boolean;
}

/** PURE. What a scope's vendor cost rests on, and whether a public figure may be built on it. */
export function vendorCoverage(vendorUsd: number, unpricedBilledUsd: number, billedUsd: number): VendorCoverage {
  const unpricedSharePct = billedUsd > 0 ? (unpricedBilledUsd / billedUsd) * 100 : 0;
  return { vendorUsd, unpricedBilledUsd, billedUsd, unpricedSharePct, servable: unpricedSharePct <= PUBLIC_VENDOR_UNPRICED_TOLERANCE_PCT };
}

/** The reason a public money figure states when its vendor cost is not known well enough. */
export const VENDOR_COST_UNKNOWN = "vendor_cost_unknown";

/** One served sentence for what every public money figure means. */
export const PUBLIC_COST_BASIS_TEXT =
  "Every cost here is our real vendor cost: what email, data and AI vendors charged us, with no markup, over the whole history.";
