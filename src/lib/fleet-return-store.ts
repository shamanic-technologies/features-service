/**
 * Persistence for the per-brand fleet snapshot (`fleet_return_snapshots`, historical table name): the rows the
 * homepage's recently-started client pick ranks (`lib/showcase-clients.ts`). It used to hold each brand's
 * pipeline and spend for the public return medians; those are deleted (ROI-CONSISTENCY-1103) and a row now
 * holds how far its funnel reached and its meetings booked + positive replies (SHOWCASE-MAX-1107). A row stored before carries more fields,
 * ignored on read.
 *
 * Both functions are FAIL-SOFT (log loud, never throw): the read feeds a marketing surface whose consumer
 * drops the section when it cannot be stated, and the write happens inside a background warm nobody waits on.
 * The stored payload is validated on the way OUT: a malformed cell reads as "no snapshot".
 */
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { fleetReturnSnapshots } from "../db/schema.js";

/** One brand's stored ingredients on one channel. */
export interface BrandSnapshotRow {
  brandId: string;
  /**
   * People on the furthest RUNG the brand's funnel reached on the channel (`furthestRungReached`), never the
   * outreach base. `0` is measured; NULL = could not be counted.
   */
  outcomeCount?: number | null;
  /**
   * Meetings booked and positive replies on the channel, EVERY conversion (the counts the client's own dashboard
   * reads; SHOWCASE-MAX-1107). NULL = not counted (a row stored before these fields existed).
   */
  meetingsBooked?: number | null;
  positiveReplies?: number | null;
}

export interface FleetReturnSnapshotRead {
  brands: BrandSnapshotRow[];
  computedAt: Date;
}

/** Narrow one stored jsonb entry to a `BrandSnapshotRow`, or null when it is not one. */
export function parseRow(raw: unknown): BrandSnapshotRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.brandId !== "string") return null;
  // Absent and explicit-null are the same statement ("we have no such figure"); a present-but-wrong-typed value is
  // malformed.
  const num = (v: unknown): number | null | false => {
    if (v === undefined || v === null) return null;
    return typeof v === "number" && Number.isFinite(v) ? v : false;
  };
  const outcomeCount = num(r.outcomeCount);
  const meetingsBooked = num(r.meetingsBooked);
  const positiveReplies = num(r.positiveReplies);
  if (outcomeCount === false || meetingsBooked === false || positiveReplies === false) return null;
  return { brandId: r.brandId, outcomeCount, meetingsBooked, positiveReplies };
}

/**
 * Read one channel's stored per-brand rows. Returns null when there is no snapshot, when the stored
 * cell is not the array shape this module writes, or when the read itself failed — all three are the
 * same statement to the caller ("nothing to rank"), and the last two log loud.
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
    const brands: BrandSnapshotRow[] = [];
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
 * The row is replaced WHOLE — a brand that has left the channel must leave the population too.
 */
export async function writeFleetReturnSnapshotSoft(
  featureSlug: string,
  brands: BrandSnapshotRow[],
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
