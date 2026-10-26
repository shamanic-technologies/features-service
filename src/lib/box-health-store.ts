/**
 * Persistence of the box health samples (`box_health_samples`, `lib/box-health.ts`). A sample's identity is its instant:
 * writing a batch UPSERTS on `sampled_at` (idempotent re-send), then prunes rows older than RETENTION_DAYS.
 */
import { and, desc, eq, gt, gte, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { boxHealthSamples, type BoxHealthSampleRow } from "../db/schema.js";
import {
  RETENTION_DAYS,
  TOP_CONTAINERS_WINDOW_MINUTES,
  type BoxHealthInputs,
  type BoxHealthSample,
  type StoredBoxSample,
} from "./box-health.js";

const UPSERT_CHUNK = 500;

export async function upsertBoxHealthSamples(samples: BoxHealthSample[], now: Date): Promise<{ pruned: number }> {
  return db.transaction(async (tx) => {
    for (let i = 0; i < samples.length; i += UPSERT_CHUNK) {
      const values = samples.slice(i, i + UPSERT_CHUNK).map((s) => ({
        sampledAt: new Date(s.sampledAt),
        source: s.source,
        load1: s.load1,
        load5: s.load5,
        load15: s.load15,
        cores: s.cores,
        memTotalMb: s.memTotalMb,
        memAvailableMb: s.memAvailableMb,
        swapTotalMb: s.swapTotalMb,
        swapUsedMb: s.swapUsedMb,
        oomKills: s.oomKills ?? null,
        containers: s.containers ?? null,
        receivedAt: now,
      }));
      await tx
        .insert(boxHealthSamples)
        .values(values)
        .onConflictDoUpdate({
          target: boxHealthSamples.sampledAt,
          set: {
            source: sql`excluded.source`,
            load1: sql`excluded.load1`,
            load5: sql`excluded.load5`,
            load15: sql`excluded.load15`,
            cores: sql`excluded.cores`,
            memTotalMb: sql`excluded.mem_total_mb`,
            memAvailableMb: sql`excluded.mem_available_mb`,
            swapTotalMb: sql`excluded.swap_total_mb`,
            swapUsedMb: sql`excluded.swap_used_mb`,
            oomKills: sql`excluded.oom_kills`,
            containers: sql`excluded.containers`,
            receivedAt: sql`excluded.received_at`,
          },
        });
    }
    const pruned = await tx
      .delete(boxHealthSamples)
      .where(lt(boxHealthSamples.sampledAt, new Date(now.getTime() - RETENTION_DAYS * 86_400_000)))
      .returning({ sampledAt: boxHealthSamples.sampledAt });
    return { pruned: pruned.length };
  });
}

function toStored(r: Partial<BoxHealthSampleRow> & Omit<BoxHealthSampleRow, "containers" | "receivedAt">): StoredBoxSample {
  return {
    sampledAt: r.sampledAt,
    source: r.source === "sysstat" ? "sysstat" : "agent",
    load1: r.load1,
    load5: r.load5,
    load15: r.load15,
    cores: r.cores,
    memTotalMb: r.memTotalMb,
    memAvailableMb: r.memAvailableMb,
    swapTotalMb: r.swapTotalMb,
    swapUsedMb: r.swapUsedMb,
    oomKills: r.oomKills,
    containers: r.containers ?? null,
  };
}

/** Slim samples since `since` (no per-container list), the latest sample with containers, the last hour's agent samples. */
export async function readBoxHealthInputs(since: Date, now: Date): Promise<BoxHealthInputs> {
  const slim = {
    sampledAt: boxHealthSamples.sampledAt,
    source: boxHealthSamples.source,
    load1: boxHealthSamples.load1,
    load5: boxHealthSamples.load5,
    load15: boxHealthSamples.load15,
    cores: boxHealthSamples.cores,
    memTotalMb: boxHealthSamples.memTotalMb,
    memAvailableMb: boxHealthSamples.memAvailableMb,
    swapTotalMb: boxHealthSamples.swapTotalMb,
    swapUsedMb: boxHealthSamples.swapUsedMb,
    oomKills: boxHealthSamples.oomKills,
  };
  const [windowRows, latestRows, hourRows] = await Promise.all([
    db.select(slim).from(boxHealthSamples).where(gte(boxHealthSamples.sampledAt, since)),
    db.select().from(boxHealthSamples).orderBy(desc(boxHealthSamples.sampledAt)).limit(1),
    db
      .select()
      .from(boxHealthSamples)
      .where(
        and(
          eq(boxHealthSamples.source, "agent"),
          gt(boxHealthSamples.sampledAt, new Date(now.getTime() - TOP_CONTAINERS_WINDOW_MINUTES * 60_000)),
        ),
      ),
  ]);
  return {
    windowSamples: windowRows.map((r) => toStored(r)),
    latest: latestRows[0] ? toStored(latestRows[0]) : null,
    lastHourAgentSamples: hourRows.map((r) => toStored(r)),
  };
}
