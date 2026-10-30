/**
 * Persistence of the box watchdog runs (`box_check_runs`, `lib/box-checks.ts`). A run's identity is (check, instant):
 * writing a batch UPSERTS on it (idempotent re-send), then prunes rows older than RETENTION_DAYS.
 */
import { asc, desc, gte, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { boxCheckRuns, type BoxCheckRunRow } from "../db/schema.js";
import { RETENTION_DAYS, type BoxCheckRun, type BoxChecksInputs, type StoredCheckRun } from "./box-checks.js";

export async function upsertBoxCheckRuns(runs: BoxCheckRun[], now: Date): Promise<{ pruned: number }> {
  return db.transaction(async (tx) => {
    await tx
      .insert(boxCheckRuns)
      .values(
        runs.map((r) => ({
          check: r.check,
          ranAt: new Date(r.ranAt),
          ok: r.ok,
          reason: r.reason && r.reason.length > 0 ? r.reason : null,
          cadenceMinutes: r.cadenceMinutes,
          label: r.label ?? null,
          value: r.value ?? null,
          unit: r.unit ?? null,
          details: r.details ?? null,
          receivedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [boxCheckRuns.check, boxCheckRuns.ranAt],
        set: {
          ok: sql`excluded.ok`,
          reason: sql`excluded.reason`,
          cadenceMinutes: sql`excluded.cadence_minutes`,
          label: sql`excluded.label`,
          value: sql`excluded.value`,
          unit: sql`excluded.unit`,
          details: sql`excluded.details`,
          receivedAt: sql`excluded.received_at`,
        },
      });
    const pruned = await tx
      .delete(boxCheckRuns)
      .where(lt(boxCheckRuns.ranAt, new Date(now.getTime() - RETENTION_DAYS * 86_400_000)))
      .returning({ check: boxCheckRuns.check });
    return { pruned: pruned.length };
  });
}

function toStored(r: Partial<BoxCheckRunRow> & Pick<BoxCheckRunRow, "check" | "ranAt" | "ok" | "value" | "cadenceMinutes">): StoredCheckRun {
  return {
    check: r.check,
    ranAt: r.ranAt,
    ok: r.ok,
    value: r.value,
    cadenceMinutes: r.cadenceMinutes,
    reason: r.reason ?? null,
    label: r.label ?? null,
    unit: r.unit ?? null,
    details: r.details ?? null,
  };
}

/** Slim runs since `since` (every check) and the latest run of each check ever seen (all fields). */
export async function readBoxChecksInputs(since: Date): Promise<BoxChecksInputs> {
  const slim = {
    check: boxCheckRuns.check,
    ranAt: boxCheckRuns.ranAt,
    ok: boxCheckRuns.ok,
    value: boxCheckRuns.value,
    cadenceMinutes: boxCheckRuns.cadenceMinutes,
  };
  const [windowRows, latestRows] = await Promise.all([
    db.select(slim).from(boxCheckRuns).where(gte(boxCheckRuns.ranAt, since)),
    db
      .selectDistinctOn([boxCheckRuns.check])
      .from(boxCheckRuns)
      .orderBy(asc(boxCheckRuns.check), desc(boxCheckRuns.ranAt)),
  ]);
  return {
    windowRuns: windowRows.map((r) => toStored(r)),
    latestPerCheck: latestRows.map((r) => toStored(r)),
  };
}
