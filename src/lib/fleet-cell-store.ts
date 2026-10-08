/**
 * WHERE A FLEET CELL IS KEPT BETWEEN PROCESSES — one row of `feature_view_snapshots` per cell, platform
 * scope (`PLATFORM_SCOPE_ORG_ID`), no replay URL (so the view keeper never replays it).
 *
 * WHY. A fleet cell (lib/fleet-positive-repliers.ts) is one whole-population lead walk per (org, brand)
 * pair running a channel. Held only in memory, it was rebuilt by EVERY process that read it — the server
 * and the refresher each — and from scratch on every boot: a deploy re-walked every brand of every
 * cold-email channel (prod 2026-10-08: a fresh process issued ~14-17 whole-brand lead pages a minute
 * while it rebuilt, on a day with eight deploys). Stored here, a process starts from the last build and
 * only ONE process rebuilds a stale cell (a claim on `refreshing_at`), on the same 15 min / 6 h windows.
 *
 * The row is DERIVED and rebuildable, like every Gold row: a read or write failure is logged loudly and the
 * caller builds the cell itself, exactly as before this store existed.
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { featureViewSnapshots } from "../db/schema.js";
import { PLATFORM_SCOPE_ORG_ID } from "./view-cache.js";

const STORE_VIEW = "fleet-cell";

export interface StoredCell {
  text: string;
  computedAt: number;
}

/** The stored cell, or null when none is stored (or the store cannot be read — logged). */
export async function loadFleetCell(key: string): Promise<StoredCell | null> {
  try {
    const [row] = await db
      .select({ bodyText: featureViewSnapshots.bodyText, computedAt: featureViewSnapshots.computedAt })
      .from(featureViewSnapshots)
      .where(and(eq(featureViewSnapshots.view, STORE_VIEW), eq(featureViewSnapshots.scopeKey, key)))
      .limit(1);
    if (!row || typeof row.bodyText !== "string") return null;
    return { text: row.bodyText, computedAt: new Date(row.computedAt).getTime() };
  } catch (err) {
    console.error(`[features-service] fleet cell store read failed (${key}) — building in this process:`, err);
    return null;
  }
}

/**
 * Claim the rebuild of a stored cell for `claimMs`. FALSE only when another process holds a live claim;
 * TRUE when nothing is stored yet (the first builder wins by writing) or the store cannot be reached
 * (logged — the caller builds, as it always did).
 */
export async function claimFleetCellBuild(key: string, claimMs: number): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - claimMs);
    const claimed = await db
      .update(featureViewSnapshots)
      .set({ refreshingAt: new Date() })
      .where(
        and(
          eq(featureViewSnapshots.view, STORE_VIEW),
          eq(featureViewSnapshots.scopeKey, key),
          or(isNull(featureViewSnapshots.refreshingAt), lt(featureViewSnapshots.refreshingAt, cutoff)),
        ),
      )
      .returning({ id: featureViewSnapshots.id });
    if (claimed.length > 0) return true;
    const [exists] = await db
      .select({ n: sql<number>`1` })
      .from(featureViewSnapshots)
      .where(and(eq(featureViewSnapshots.view, STORE_VIEW), eq(featureViewSnapshots.scopeKey, key)))
      .limit(1);
    return !exists;
  } catch (err) {
    console.error(`[features-service] fleet cell build claim failed (${key}) — building in this process:`, err);
    return true;
  }
}

/** Store a freshly built cell and release the claim. A failure is logged; the built cell is still served. */
export async function storeFleetCell(key: string, text: string, computedAt: number): Promise<void> {
  try {
    const at = new Date(computedAt);
    await db
      .insert(featureViewSnapshots)
      .values({
        view: STORE_VIEW,
        scopeKey: key,
        orgId: PLATFORM_SCOPE_ORG_ID,
        body: { storedAs: "body_text" },
        bodyText: text,
        computedAt: at,
        refreshingAt: null,
      })
      .onConflictDoUpdate({
        target: [featureViewSnapshots.view, featureViewSnapshots.scopeKey],
        set: { bodyText: text, computedAt: at, refreshingAt: null },
      });
  } catch (err) {
    console.error(`[features-service] fleet cell store write failed (${key}):`, err);
  }
}
