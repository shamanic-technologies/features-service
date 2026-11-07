/**
 * LEDGER-ONLY-1107-P2 IO: the ledger a body's counts are read on (`ledger-counts.ts` is the pure rule). A brand-wide or
 * offer read = the BRAND's ledger (every source and campaign, each Unit once: the count Today prints); a read scoped to
 * campaigns (a campaign identity, a funnel campaign's units, one pipe) = the Units those campaigns' runs produced. A read
 * narrower than a campaign (one workflow, a lens) has no ledger scope: every count null + its reason. Unreadable = null
 * + `ledger_unreadable` (logged), never another source's count.
 */
import { fetchBrandOutcomeLedger, fetchCampaignSetOutcomeLedger } from "./scope-outcome-ledger-io.js";
import { ledgerScopeOf, type LedgerScope } from "./ledger-counts.js";
import type { LedgerBasis } from "./outcome-cost-totals-client.js";

export const ledgerBasisOf = (pricing: string | undefined | null): LedgerBasis => (pricing === "net" ? "net" : pricing === "vendor" ? "vendor" : "gross");

export async function readLedgerScope(brandId: string, basis: LedgerBasis, campaignIds: readonly string[] | null, why: string): Promise<LedgerScope> {
  try {
    const ledger = campaignIds === null ? await fetchBrandOutcomeLedger(brandId, basis) : await fetchCampaignSetOutcomeLedger(campaignIds, brandId, basis);
    return ledgerScopeOf(ledger);
  } catch (err) {
    console.error(`[features-service] ${why}: ledger of brand ${brandId}${campaignIds ? ` campaigns ${campaignIds.length}` : ""} unreadable (counts null): ${(err as Error).message}`);
    return ledgerScopeOf(null);
  }
}
