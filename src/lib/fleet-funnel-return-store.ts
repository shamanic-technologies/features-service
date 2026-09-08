/**
 * Persistence for the FLEET (channel × sales funnel) RETURN-ON-SPEND snapshot
 * (`fleet_funnel_return_snapshots`) — see the table's own doc in `db/schema.ts` for why this answer is
 * written down rather than merely cached.
 *
 * Both functions are FAIL-SOFT (log loud, never throw), for the reason its sibling
 * `fleet-return-store.ts` is: the public read that consumes them already answers "we could not state
 * this" per pair, so a read blip must degrade to that answer and let the pairs beside it survive rather
 * than 500 a page. The WRITE is equally soft — it happens inside a background warm nobody is waiting
 * on, and its only failure consequence is that the next warm rewrites the row.
 *
 * The stored payload is validated on the way OUT, not trusted: a jsonb column carries no shape
 * guarantee across a schema change, and a malformed cell must read as "no snapshot" rather than crash a
 * public handler or, worse, produce a median over rows whose numbers are undefined.
 */
import { inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { fleetFunnelReturnSnapshots } from "../db/schema.js";
import type { BrandFunnelReturnRow } from "./fleet-funnel-return.js";
import { SALES_FUNNEL_KEYS, type SalesFunnelKey } from "./sales-funnels.js";

export interface FleetFunnelReturnSnapshotRead {
  rows: BrandFunnelReturnRow[];
  computedAt: Date;
}

/** Narrow one stored jsonb entry to a `BrandFunnelReturnRow`, or null when it is not one. */
function parseRow(raw: unknown): BrandFunnelReturnRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.brandId !== "string") return null;
  // The CANONICAL key only: a stored legacy spelling would silently split one funnel's population in
  // two, which is exactly the failure a median over a thin population cannot afford.
  if (typeof r.funnelKey !== "string" || !(SALES_FUNNEL_KEYS as readonly string[]).includes(r.funnelKey)) return null;
  if (typeof r.committedSpendUsd !== "number" || !Number.isFinite(r.committedSpendUsd)) return null;
  const num = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));
  if (!num(r.expectedPipelineUsd) || !num(r.expectedPaidClients)) return null;
  return {
    brandId: r.brandId,
    funnelKey: r.funnelKey as SalesFunnelKey,
    committedSpendUsd: r.committedSpendUsd,
    expectedPipelineUsd: r.expectedPipelineUsd as number | null,
    expectedPaidClients: r.expectedPaidClients as number | null,
  };
}

/** Narrow one stored `rows` cell, or null when any entry in it is malformed. */
function parseRows(featureSlug: string, raw: unknown): BrandFunnelReturnRow[] | null {
  if (!Array.isArray(raw)) {
    console.error(
      `[features-service] fleet-funnel-return snapshot for ${featureSlug} is not an array — treating as absent`,
    );
    return null;
  }
  const rows: BrandFunnelReturnRow[] = [];
  for (const entry of raw) {
    const parsed = parseRow(entry);
    if (parsed === null) {
      console.error(
        `[features-service] fleet-funnel-return snapshot for ${featureSlug} holds a malformed row — treating the whole snapshot as absent`,
      );
      return null;
    }
    rows.push(parsed);
  }
  return rows;
}

/**
 * Read several channels' stored rows in ONE query, keyed by feature slug.
 *
 * Batched because the public read enumerates the WHOLE channel catalogue (roughly forty channels) and
 * one SELECT per channel would put forty round-trips on a request whose entire job is arithmetic over
 * rows somebody else already computed. A channel absent from the result simply has no snapshot, which
 * is the answer `no_snapshot_yet` states.
 */
export async function readFleetFunnelReturnSnapshotsSoft(
  featureSlugs: readonly string[],
): Promise<Map<string, FleetFunnelReturnSnapshotRead>> {
  const out = new Map<string, FleetFunnelReturnSnapshotRead>();
  if (featureSlugs.length === 0) return out;
  try {
    const found = await db.query.fleetFunnelReturnSnapshots.findMany({
      where: inArray(fleetFunnelReturnSnapshots.featureSlug, [...featureSlugs]),
    });
    for (const row of found) {
      const rows = parseRows(row.featureSlug, row.rows);
      if (rows === null) continue;
      out.set(row.featureSlug, { rows, computedAt: row.computedAt });
    }
  } catch (err) {
    console.error("[features-service] fleet-funnel-return snapshot read failed (soft):", err);
  }
  return out;
}

/**
 * Overwrite one channel's snapshot with the rows a warm just computed (idempotent on `feature_slug`).
 * The row is replaced WHOLE — a brand that stopped selling a funnel, or left the channel, must leave
 * the population too, and merging would keep it in the median forever.
 */
export async function writeFleetFunnelReturnSnapshotSoft(
  featureSlug: string,
  rows: BrandFunnelReturnRow[],
  now: Date,
): Promise<void> {
  try {
    await db
      .insert(fleetFunnelReturnSnapshots)
      .values({ featureSlug, rows, computedAt: now })
      .onConflictDoUpdate({
        target: fleetFunnelReturnSnapshots.featureSlug,
        set: { rows, computedAt: now },
      });
  } catch (err) {
    console.error(
      `[features-service] fleet-funnel-return snapshot write failed (soft) for ${featureSlug}:`,
      err,
    );
  }
}
