/**
 * THE PUBLIC FLEET INDEXES AT REAL VENDOR COST (owner 2026-10-31, PUBLIC-VENDOR-COST-1031). PURE; the reads are the
 * recorder's (`routes/fleet-indexes.ts`) and the history run's (`scripts/backfill-fleet-indexes.ts`).
 *
 * WHO is picked never moves: the best proven workflow is the one the BILLED ranking picks (what a client's money goes to;
 * campaign-service runs that order). Only the MONEY of each pick is swapped: the same rows (same campaigns, same versions,
 * same run-start cut, same people) read on the vendor basis. A row whose billed spend lacks a vendor cost past the
 * tolerance (`lib/public-vendor-cost.ts`) prices nothing: its index reads null + `vendor_cost_unknown`, never the billed
 * figure, never the priced part as the whole.
 */
import type { LegWorkflowRankingRow } from "./leg-workflow-ranking.js";
import type { LegMaturityFigures } from "./maturity.js";
import type { LegPrice } from "./outcome-prices.js";
import { vendorCoverage } from "./public-vendor-cost.js";

/** One pipe's per-dynasty spend on the vendor basis and the billed spend no vendor cost prices, both halves, USD. */
export interface PipeVendorTwin {
  vendor: ReadonlyMap<string, LegMaturityFigures>;
  unpriced: ReadonlyMap<string, LegMaturityFigures>;
}

/** A ranking row as an index reads it, its money possibly withheld for an unknown vendor cost. */
export type IndexRow = LegWorkflowRankingRow & { vendorCostUnknown?: boolean; unpricedSharePct?: number };

/** A half's spend; null when the twin does not state it (no row, or the mature cut could not be read). */
function halfSpend(f: LegMaturityFigures | undefined, basis: "mature" | "flash"): number | null {
  const half = basis === "mature" ? f?.mature : f?.flash;
  return half ? half.spentUsd : null;
}

/** PURE. A dynasty's vendor money on one half, judged against its billed spend on that half. */
export function vendorSpendOf(twin: PipeVendorTwin, dynasty: string, basis: "mature" | "flash", billedUsd: number): { vendorUsd: number | null; unpricedSharePct: number | null; known: boolean } {
  const vendorUsd = halfSpend(twin.vendor.get(dynasty), basis);
  // No unpriced row on the dynasty at all = nothing unpriced; a vendor half not stated = unknown.
  const unpricedUsd = twin.unpriced.has(dynasty) ? halfSpend(twin.unpriced.get(dynasty), basis) : 0;
  if (vendorUsd === null || unpricedUsd === null) return { vendorUsd: null, unpricedSharePct: null, known: false };
  const cov = vendorCoverage(vendorUsd, unpricedUsd, billedUsd);
  return { vendorUsd, unpricedSharePct: cov.unpricedSharePct, known: cov.servable };
}

/** PURE. The billed ranking's rows with each row's money on the vendor basis (order, picks, counts untouched). */
export function vendorRankingRows(rows: readonly LegWorkflowRankingRow[], twin: PipeVendorTwin): IndexRow[] {
  return rows.map((r) => {
    const v = vendorSpendOf(twin, r.workflowDynastySlug, r.basis, r.spentUsd);
    if (!v.known || v.vendorUsd === null) {
      return { ...r, spentUsd: v.vendorUsd ?? 0, costPerOutcomeUsd: null, vendorCostUnknown: true, ...(v.unpricedSharePct !== null ? { unpricedSharePct: v.unpricedSharePct } : {}) };
    }
    return {
      ...r,
      spentUsd: v.vendorUsd,
      costPerOutcomeUsd: r.outcomes > 0 && v.vendorUsd > 0 ? v.vendorUsd / r.outcomes : null,
      vendorCostUnknown: false,
      unpricedSharePct: v.unpricedSharePct!,
    };
  });
}

/** The meeting pipe pooled, every workflow (`MeetingLegFleet.pooled`), as the index reads it. */
export interface PooledPipe {
  spentUsd: number;
  contacted: number;
  outcomes: number;
  spentByDynasty: Record<string, number>;
  vendorCostUnknown?: boolean;
}

/** PURE. The pooled meeting pipe on the vendor basis: every dynasty's spend swapped, the counts kept. */
export function vendorPooled(pooled: PooledPipe, vendorByDynasty: Record<string, number>, unpricedByDynasty: Record<string, number>): PooledPipe {
  const vendorUsd = Object.values(vendorByDynasty).reduce((a, b) => a + b, 0);
  const unpricedUsd = Object.values(unpricedByDynasty).reduce((a, b) => a + b, 0);
  const cov = vendorCoverage(vendorUsd, unpricedUsd, pooled.spentUsd);
  return { ...pooled, spentUsd: vendorUsd, spentByDynasty: { ...vendorByDynasty }, vendorCostUnknown: !cov.servable };
}

/** PURE. One leg of an outcome price on the vendor basis: the same pick, its cost per outcome on its vendor spend. */
export function vendorLegPrice(leg: LegPrice, twin: PipeVendorTwin): LegPrice & { vendorCostUnknown: boolean } {
  if (leg.workflowDynastySlug === null || leg.basis === null || !leg.figures) return { ...leg, vendorCostUnknown: false };
  const v = vendorSpendOf(twin, leg.workflowDynastySlug, leg.basis, leg.figures.spentUsd);
  if (!v.known || v.vendorUsd === null) return { ...leg, costPerOutcomeUsd: null, vendorCostUnknown: true };
  const cost = leg.figures.outcomes > 0 && v.vendorUsd > 0 ? v.vendorUsd / leg.figures.outcomes : null;
  return { ...leg, costPerOutcomeUsd: cost, figures: { ...leg.figures, spentUsd: v.vendorUsd, costPerOutcomeUsd: cost }, vendorCostUnknown: false };
}
