/**
 * Persistence for the FLEET RETURN-ON-SPEND snapshot (`fleet_return_snapshots`) — see the table's own
 * doc in `db/schema.ts` for why this answer is written down rather than merely cached.
 *
 * Both functions are FAIL-SOFT (log loud, never throw). The public read that consumes them is a
 * marketing surface whose consumer already drops the stat when it cannot be stated: a read blip must
 * answer "we could not state this" and let the two figures beside it survive, never 502 a landing
 * build. The WRITE is equally soft — it happens inside a background warm nobody is waiting on, and its
 * only failure consequence is that the next warm rewrites the row.
 *
 * The stored payload is validated on the way OUT, not trusted: a jsonb column has no shape guarantee
 * across a schema change, and a malformed cell must read as "no snapshot" rather than crash a public
 * handler or, worse, produce a median over rows whose numbers are undefined.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { fleetReturnSnapshots } from "../db/schema.js";
import type { BrandReturnRow } from "./fleet-return-on-spend.js";

export interface FleetReturnSnapshotRead {
  brands: BrandReturnRow[];
  computedAt: Date;
}

/** Narrow one stored jsonb entry to a `BrandReturnRow`, or null when it is not one. */
function parseRow(raw: unknown): BrandReturnRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.brandId !== "string") return null;
  if (typeof r.committedSpendUsd !== "number" || !Number.isFinite(r.committedSpendUsd)) return null;
  const pipeline = r.expectedPipelineUsd;
  if (pipeline !== null && (typeof pipeline !== "number" || !Number.isFinite(pipeline))) return null;
  return {
    brandId: r.brandId,
    committedSpendUsd: r.committedSpendUsd,
    expectedPipelineUsd: pipeline as number | null,
  };
}

/**
 * Read one channel's stored per-brand rows. Returns null when there is no snapshot, when the stored
 * cell is not the array shape this module writes, or when the read itself failed — all three are the
 * same statement to the caller ("nothing to take a median over"), and the last two log loud.
 */
export async function readFleetReturnSnapshotSoft(featureSlug: string): Promise<FleetReturnSnapshotRead | null> {
  try {
    const row = await db.query.fleetReturnSnapshots.findFirst({
      where: eq(fleetReturnSnapshots.featureSlug, featureSlug),
    });
    if (!row) return null;
    if (!Array.isArray(row.brands)) {
      console.error(
        `[features-service] fleet-return snapshot for ${featureSlug} is not an array — treating as absent`,
      );
      return null;
    }
    const brands: BrandReturnRow[] = [];
    for (const raw of row.brands) {
      const parsed = parseRow(raw);
      if (parsed === null) {
        console.error(
          `[features-service] fleet-return snapshot for ${featureSlug} holds a malformed brand row — treating the whole snapshot as absent`,
        );
        return null;
      }
      brands.push(parsed);
    }
    return { brands, computedAt: row.computedAt };
  } catch (err) {
    console.error(`[features-service] fleet-return snapshot read failed (soft) for ${featureSlug}:`, err);
    return null;
  }
}

/**
 * Overwrite one channel's snapshot with the rows a warm just computed (idempotent on `feature_slug`).
 * The row is replaced WHOLE — a brand that has left the channel must leave the population too, and
 * merging would keep it in the median forever.
 */
export async function writeFleetReturnSnapshotSoft(
  featureSlug: string,
  brands: BrandReturnRow[],
  now: Date,
): Promise<void> {
  try {
    await db
      .insert(fleetReturnSnapshots)
      .values({ featureSlug, brands, computedAt: now })
      .onConflictDoUpdate({
        target: fleetReturnSnapshots.featureSlug,
        set: { brands, computedAt: now },
      });
  } catch (err) {
    console.error(`[features-service] fleet-return snapshot write failed (soft) for ${featureSlug}:`, err);
  }
}
