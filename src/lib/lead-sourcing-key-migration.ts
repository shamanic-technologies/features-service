/**
 * ONE CHANNEL PER LEG, THE STORED HALF (owner 2026-10-11; the model is `lib/agent-catalogue.ts`): a sales funnel id
 * now names its sourcing leg like every other leg. An id stored before (it starts out of Lead found: the sourcing
 * leg was a "pool" outside the id) IS that funnel with Lead Sourcing on its sourcing leg (`legacyFunnelIdAliasOf`).
 *  - NAMES (`sales_path_combination_names`) move with the boot re-key of `lib/outbound-leg-key-migration.ts`: its
 *    `servedNameKeyOf` spells a legacy funnel key the Lead Sourcing way, so Bliss, Epiphany... stay attached to the
 *    funnel they name (a key whose new spelling is already named keeps the OLDER name), and a read asking with the
 *    old key gets that same name (`salesPathNamesFor`), never a second one.
 *  - `declared_sales_paths`: re-keyed HERE, the Lead Sourcing leg put first in its `legs`.
 * Ids stored by OTHER services (campaign-service units, billing caps) are not moved: they keep resolving through
 * `funnelById`.
 *
 * IDEMPOTENT and run at EVERY boot after the outbound re-key, under the name-assignment lock (one small table; once
 * moved, each boot is one empty read).
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { declaredSalesPaths } from "../db/schema.js";
import { legacyFunnelIdAliasOf } from "./funnel-legs.js";
import { NAME_ASSIGNMENT_LOCK } from "./sales-path-names.js";
import { LEAD_SOURCING_SLUG, SOURCE_LEG_KEY } from "./sourcing-origins.js";

/** PURE: a declared sales path's new spelling (key + legs), or null when it needs none. */
export function respellDeclaredSalesPath(row: { combinationKey: string; legs: unknown }): { combinationKey: string; legs: unknown[] } | null {
  const to = legacyFunnelIdAliasOf(row.combinationKey);
  if (!to) return null;
  return { combinationKey: to, legs: [{ channelSlug: LEAD_SOURCING_SLUG, legKey: SOURCE_LEG_KEY }, ...((row.legs as unknown[]) ?? [])] };
}

/** Move every declared sales path stored under a legacy funnel key. Fail-loud: a DB error throws (boot stops). */
export async function migrateLeadSourcingFunnelKeys(): Promise<{ declaredPathsRekeyed: number; declaredPathsDropped: number }> {
  const result = { declaredPathsRekeyed: 0, declaredPathsDropped: 0 };
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${NAME_ASSIGNMENT_LOCK})`);
    for (const row of await tx.select().from(declaredSalesPaths)) {
      const next = respellDeclaredSalesPath(row);
      if (!next) continue;
      const [twin] = await tx.select().from(declaredSalesPaths).where(eq(declaredSalesPaths.combinationKey, next.combinationKey));
      if (twin) {
        // Already declared under its new spelling: the older declaration is the same funnel.
        await tx.delete(declaredSalesPaths).where(eq(declaredSalesPaths.combinationKey, row.combinationKey));
        result.declaredPathsDropped += 1;
        continue;
      }
      await tx.update(declaredSalesPaths).set(next).where(eq(declaredSalesPaths.combinationKey, row.combinationKey));
      result.declaredPathsRekeyed += 1;
    }
  });
  console.log(`[features-service] lead sourcing funnel keys: ${JSON.stringify(result)}`);
  return result;
}
