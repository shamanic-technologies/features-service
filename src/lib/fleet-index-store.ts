/**
 * Persistence of the public fleet index points (`fleet_index_points`, `lib/fleet-indexes.ts`). The recorder writes only
 * TODAY's row: a past day is what we published that day and stays as is. The history run (`lib/fleet-index-history.ts`)
 * writes `recomputed` rows on days nothing was recorded, and never touches a `recorded` row (guarded in the statement).
 */
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { fleetIndexPoints, type FleetIndexPointRow } from "../db/schema.js";
import type { FleetIndexPoint } from "./fleet-indexes.js";
import type { DatedIndexPoint } from "./fleet-index-history.js";

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Upsert today's point of each index (one statement per index, same day key). */
export async function recordFleetIndexPoints(points: FleetIndexPoint[], now: Date): Promise<void> {
  const day = utcDay(now);
  for (const p of points) {
    const row = {
      indexSlug: p.indexSlug,
      day,
      value: p.value,
      status: p.status,
      outcomes: p.outcomes,
      contacted: p.contacted,
      workflowDynastySlug: p.workflowDynastySlug,
      workflowDynastyName: p.workflowDynastyName,
      unavailableReason: p.unavailableReason,
      inputs: p.inputs,
      basis: "recorded",
      recordedAt: now,
    };
    await db
      .insert(fleetIndexPoints)
      .values(row)
      .onConflictDoUpdate({
        target: [fleetIndexPoints.indexSlug, fleetIndexPoints.day],
        set: { ...row, recordedAt: sql`excluded.recorded_at` },
      });
  }
}

/** Every point of one index, oldest day first. */
export async function readFleetIndexSeries(indexSlug: string): Promise<FleetIndexPointRow[]> {
  return db.select().from(fleetIndexPoints).where(eq(fleetIndexPoints.indexSlug, indexSlug)).orderBy(asc(fleetIndexPoints.day));
}

/** The latest point of every index (one row per index). The table holds a handful of rows a day: read whole. */
export async function readLatestFleetIndexPoints(): Promise<FleetIndexPointRow[]> {
  const rows = await db.select().from(fleetIndexPoints).orderBy(asc(fleetIndexPoints.indexSlug), desc(fleetIndexPoints.day));
  const latest = new Map<string, FleetIndexPointRow>();
  for (const r of rows) if (!latest.has(r.indexSlug)) latest.set(r.indexSlug, r);
  return [...latest.values()];
}

/** Every stored row of the named indexes (the history run's write plan reads them). */
export async function readFleetIndexRows(indexSlugs: readonly string[]): Promise<FleetIndexPointRow[]> {
  if (indexSlugs.length === 0) return [];
  return db.select().from(fleetIndexPoints).where(inArray(fleetIndexPoints.indexSlug, [...indexSlugs]));
}

/**
 * Write recomputed past points (`planRecomputedWrites` decided which). A day that holds a RECORDED row is left as is by
 * the statement itself (`setWhere basis = 'recomputed'`), whatever the plan said.
 */
export async function writeRecomputedFleetIndexPoints(points: readonly DatedIndexPoint[], now: Date): Promise<void> {
  for (const { day, point: p } of points) {
    const row = {
      indexSlug: p.indexSlug,
      day,
      value: p.value,
      status: p.status,
      outcomes: p.outcomes,
      contacted: p.contacted,
      workflowDynastySlug: p.workflowDynastySlug,
      workflowDynastyName: p.workflowDynastyName,
      unavailableReason: p.unavailableReason,
      inputs: p.inputs,
      basis: "recomputed",
      recordedAt: now,
    };
    await db
      .insert(fleetIndexPoints)
      .values(row)
      .onConflictDoUpdate({
        target: [fleetIndexPoints.indexSlug, fleetIndexPoints.day],
        set: { ...row, recordedAt: sql`excluded.recorded_at` },
        setWhere: sql`${fleetIndexPoints.basis} = 'recomputed'`,
      });
  }
}
