/**
 * Persistence of the public fleet index points (`fleet_index_points`, `lib/fleet-indexes.ts`). Only TODAY's row is
 * ever written: a past day is what we published that day and stays as is.
 */
import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { fleetIndexPoints, type FleetIndexPointRow } from "../db/schema.js";
import type { FleetIndexPoint } from "./fleet-indexes.js";

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
