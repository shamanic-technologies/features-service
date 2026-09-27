/**
 * BRAND TRANSFER — this service's half of the fleet `POST /internal/transfer-brand` contract.
 *
 * brand-service orchestrates the move of a brand (and its whole history) from one org to another and
 * calls every service registering this route. Contract (locked, fleet-wide):
 *   body `{ sourceBrandId, sourceOrgId, targetOrgId, targetBrandId? }` → every row this service keys on
 *   (org, brand) moves from sourceOrgId to targetOrgId, the brand id rewritten to targetBrandId when
 *   given; idempotent; answers `{ updatedTables: [{ tableName, count }] }`.
 *
 * What this service holds per (org, brand), and what happens to each:
 *   - `stated_monthly_amounts` (the agency/self-serve MRR split's stated amounts): MOVED. A row of
 *     (sourceOrg, sourceBrand) becomes (targetOrg, targetBrand ?? sourceBrand). A move that would put two
 *     ranges in force on one day for the target pair is REFUSED (409) — the store's own invariant.
 *   - `feature_view_snapshots` (the Gold serving cache): INVALIDATED for BOTH orgs, never moved. A cell's
 *     `scope_key` embeds the org and the brand, and many cells span several brands of one org, so a moved
 *     cell would carry the wrong key and the source org's remaining cells would still hold the brand's
 *     figures. Every cell of either org is derived and rebuildable; the next read recomputes it.
 *   - In-process caches (live lead copies, interactive memo, shared reads, hot bodies): DROPPED in this
 *     process. The route forwards the same (idempotent) request to the view refresher, which holds its
 *     own copies.
 *
 * Nothing here touches money: this service stores no balance.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { featureViewSnapshots, statedMonthlyAmounts } from "../db/schema.js";
import { dropLeadCopiesForOrgs } from "./lead-copy.js";
import { __resetInteractiveMemo } from "./interactive-memo.js";
import { __resetSharedReads } from "./fetch-retry.js";
import { __resetHotBodies } from "./view-cache.js";
import { rangesOverlap, describeRange, StatedAmountConflictError } from "./stated-monthly-amounts-store.js";

export interface TransferBrandInput {
  sourceBrandId: string;
  sourceOrgId: string;
  targetOrgId: string;
  targetBrandId?: string;
}

export interface UpdatedTable {
  tableName: string;
  count: number;
}

interface RangeRow {
  id: string;
  startDate: string | null;
  endDate: string | null;
}

/**
 * Refuse a move whose rows would overlap a range the target pair already holds. Pure. `moving` are the
 * rows about to land on the target pair; `resident` are the rows already there. Two moving rows never
 * collide with each other (they already coexisted on one pair, whose writes refused overlaps).
 */
export function assertMoveFits(moving: RangeRow[], resident: RangeRow[]): void {
  const movingIds = new Set(moving.map((r) => r.id));
  for (const m of moving) {
    for (const r of resident) {
      if (movingIds.has(r.id)) continue;
      if (rangesOverlap(m, r)) {
        throw new StatedAmountConflictError(
          `the stated amount ${m.id} (${describeRange(m.startDate, m.endDate)}) would overlap ${r.id} ` +
            `(${describeRange(r.startDate, r.endDate)}) already recorded for the target org and brand — ` +
            "close or move one of them before transferring.",
        );
      }
    }
  }
}

/** Drop every in-process cache that could answer for the moved brand under either org. */
export function dropInProcessCaches(orgIds: readonly string[]): number {
  const dropped = dropLeadCopiesForOrgs(orgIds);
  __resetInteractiveMemo();
  __resetSharedReads();
  __resetHotBodies();
  return dropped;
}

export async function transferBrand(input: TransferBrandInput, now: Date = new Date()): Promise<UpdatedTable[]> {
  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = input;
  const finalBrandId = targetBrandId ?? sourceBrandId;

  const movedStated = await db.transaction(async (tx) => {
    // Rows still on the source pair, plus — on a merge — rows a previous partial run already moved to
    // the target org without rewriting the brand. Both converge on (targetOrg, finalBrand).
    const sourcePairs = [and(eq(statedMonthlyAmounts.orgId, sourceOrgId), eq(statedMonthlyAmounts.brandId, sourceBrandId))];
    if (targetBrandId && targetBrandId !== sourceBrandId) {
      sourcePairs.push(and(eq(statedMonthlyAmounts.orgId, targetOrgId), eq(statedMonthlyAmounts.brandId, sourceBrandId)));
    }
    const moving = await tx.select().from(statedMonthlyAmounts).where(or(...sourcePairs));
    if (moving.length === 0) return 0;

    const resident = await tx
      .select()
      .from(statedMonthlyAmounts)
      .where(and(eq(statedMonthlyAmounts.orgId, targetOrgId), eq(statedMonthlyAmounts.brandId, finalBrandId)));
    assertMoveFits(moving, resident);

    const updated = await tx
      .update(statedMonthlyAmounts)
      .set({ orgId: targetOrgId, brandId: finalBrandId, updatedAt: now })
      .where(inArray(statedMonthlyAmounts.id, moving.map((r) => r.id)))
      .returning({ id: statedMonthlyAmounts.id });
    return updated.length;
  });

  const orgIds = sourceOrgId === targetOrgId ? [sourceOrgId] : [sourceOrgId, targetOrgId];
  const invalidated = await db
    .delete(featureViewSnapshots)
    .where(inArray(featureViewSnapshots.orgId, orgIds))
    .returning({ id: featureViewSnapshots.id });

  const droppedCopies = dropInProcessCaches(orgIds);

  console.log(
    `[features-service] transfer-brand: sourceBrandId=${sourceBrandId} targetBrandId=${targetBrandId ?? "none"} ` +
      `sourceOrgId=${sourceOrgId} targetOrgId=${targetOrgId} — stated_monthly_amounts moved: ${movedStated}, ` +
      `feature_view_snapshots invalidated: ${invalidated.length}, lead copies dropped: ${droppedCopies}`,
  );

  return [
    { tableName: "stated_monthly_amounts", count: movedStated },
    { tableName: "feature_view_snapshots", count: invalidated.length },
  ];
}
