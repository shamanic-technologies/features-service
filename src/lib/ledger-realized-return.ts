/**
 * LEDGER-ONLY-1107: revenue bodies' realized return (and revenueGenerated's real half) re-based on the brand's ledger
 * Paid client Units. IO through `scope-outcome-ledger-io.ts` (the suite mocks its reader to "unreadable" by default).
 */
import { fetchBrandOutcomeLedger } from "./scope-outcome-ledger-io.js";
import type { LedgerBasis } from "./outcome-cost-totals-client.js";

type CostEconLike = { actualCostUsd?: number; realizedReturn?: unknown };
type RevenueBodyLike = {
  headline?: { lifetimeRevenueUsd?: number | null } | null;
  costEconomics?: CostEconLike | null;
  channels?: Array<{ headline?: { lifetimeRevenueUsd?: number | null } | null; costEconomics?: CostEconLike | null }>;
  groups?: Array<{ headline?: { lifetimeRevenueUsd?: number | null } | null; costEconomics?: CostEconLike | null }>;
  offers?: Array<{ headline?: { lifetimeRevenueUsd?: number | null } | null; costEconomics?: CostEconLike | null }>;
};

const nulled = <R extends { costEconomics?: CostEconLike | null }>(rows: R[] | undefined, reason: string): R[] | undefined =>
  rows?.map((r) => (r.costEconomics ? { ...r, costEconomics: { ...r.costEconomics, realizedReturn: null, realizedReturnUnavailableReason: reason } } : r));

/**
 * LEDGER-ONLY-1107: every `costEconomics.realizedReturn` of a revenue body re-based on the brand's ledger Paid client Units
 * (`ledgerRealizedReturn`), `realizedReturnUnavailableReason` beside it. The body itself and each `offers[]` row read the
 * brand's ledger (Units × their own LTR ÷ their own spend), so do `channels[]` and offer `groups[]` rows (one Paid client count
 * per brand); campaign `groups[]` and a body scoped narrower than the brand (`narrowerScope` = its reason) carry none. A failed ledger read = null +
 * `ledger_unreadable`, never the CRM count.
 */
export async function withLedgerRealizedReturn<T extends object>(body: T, brandId: string, basis: LedgerBasis, narrowerScope: string | null = null): Promise<T> {
  const b = body as RevenueBodyLike;
  const { ledgerRealizedReturn, scopeOutcomeLedgerRowOf } = await import("./scope-outcome-ledger.js");
  const needsLedger = narrowerScope === null && (Boolean(b.costEconomics) || (b.offers?.length ?? 0) > 0 || (b.channels?.length ?? 0) > 0 || (b.groups?.length ?? 0) > 0 || Boolean((body as { revenueGenerated?: unknown }).revenueGenerated));
  const ledger = needsLedger
    ? await fetchBrandOutcomeLedger(brandId, basis).catch((err: Error) => {
        console.error(`[features-service] realized return: brand ledger of ${brandId} unreadable (null): ${err.message}`);
        return null;
      })
    : null;
  const paid = ledger ? scopeOutcomeLedgerRowOf(["paid_client"], ledger) : null;
  const rebased = (ce: CostEconLike, ltr: number | null | undefined) => {
    if (narrowerScope !== null) return { ...ce, realizedReturn: null, realizedReturnUnavailableReason: narrowerScope };
    const spent = (ce.realizedReturn as { spentUsd?: number | null } | null | undefined)?.spentUsd ?? ce.actualCostUsd ?? null;
    const r = ledgerRealizedReturn(paid, ltr ?? null, spent);
    return { ...ce, realizedReturn: r.realizedReturn, realizedReturnUnavailableReason: r.unavailableReason };
  };
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  if (b.costEconomics) out.costEconomics = rebased(b.costEconomics, b.headline?.lifetimeRevenueUsd);
  if (b.offers) out.offers = b.offers.map((o) => (o.costEconomics ? { ...o, costEconomics: rebased(o.costEconomics, o.headline?.lifetimeRevenueUsd) } : o));
  const rg = (body as { revenueGenerated?: import("./revenue-generated.js").RevenueGenerated | null }).revenueGenerated;
  if (rg && narrowerScope === null) {
    const { withLedgerRealHalf } = await import("./revenue-generated.js");
    out.revenueGenerated = withLedgerRealHalf(rg, paid, b.headline?.lifetimeRevenueUsd ?? null);
  }
  // Offer / channel rows read the same brand ledger (one Paid client count per brand, never re-split); campaign and
  // workflow groups carry none.
  const rowsOf = <R extends { costEconomics?: CostEconLike | null; headline?: { lifetimeRevenueUsd?: number | null } | null }>(rows: R[]) =>
    rows.map((r) => (r.costEconomics ? { ...r, costEconomics: rebased(r.costEconomics, r.headline?.lifetimeRevenueUsd) } : r));
  if (b.channels) out.channels = rowsOf(b.channels);
  const groupBy = (body as { groupBy?: string }).groupBy;
  if (b.groups) out.groups = groupBy === "offerId" ? rowsOf(b.groups) : nulled(b.groups, groupBy === "campaignId" ? "per_campaign_not_in_ledger" : "per_group_not_in_ledger");
  return out as T;
}
