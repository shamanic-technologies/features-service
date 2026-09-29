/**
 * Persistence for the COMMITTED-MRR daily snapshot store (`committed_mrr_snapshots`).
 *
 * Committed MRR is a POINT-IN-TIME run-rate (Σ active brands' daily budget × 30) that cannot be
 * reconstructed from realized spend, so it is recorded going forward — one upsert per UTC day whenever
 * the fleet committed budget is computed. Both functions are FAIL-SOFT (log loud, never throw): the
 * committed series is ADDITIVE display enrichment on the already-working realized `/internal/stats/revenue`
 * response, so a snapshot write/read blip must NEVER 502 the endpoint (Gold-layer doctrine + the
 * fail-soft-display pattern used by the /revenue conversion-count tiles). The next request retries the
 * upsert; a failed read degrades the committed series to the current live point only.
 */
import { eq, gte } from "drizzle-orm";
import { db } from "../db/index.js";
import { committedMrrSnapshots, recurringMrrOrgSnapshots } from "../db/schema.js";

/** MRR = daily budget × 30 (calendar-month run-rate); the accounts-audit convention. */
export const MRR_DAY_MULTIPLE = 30;

/**
 * Upsert today's committed-budget snapshot (idempotent on the UTC day). Overwrites the day's row with the
 * latest observed committed budget + active count, so end-of-day the row holds the last-seen run-rate.
 * Fail-soft: a write error logs loud and is swallowed (the read stays non-blocking; next call retries).
 */
export async function recordCommittedMrrSnapshotSoft(
  dailyBudgetUsd: number,
  activeCount: number,
  now: Date,
): Promise<void> {
  try {
    const snapshotDate = now.toISOString().slice(0, 10);
    const committedDailyBudgetCents = Math.round(dailyBudgetUsd * 100);
    await db
      .insert(committedMrrSnapshots)
      .values({ snapshotDate, committedDailyBudgetCents, activeCount, recordedAt: now })
      .onConflictDoUpdate({
        target: committedMrrSnapshots.snapshotDate,
        set: { committedDailyBudgetCents, activeCount, recordedAt: now },
      });
  } catch (err) {
    console.error("[features-service] committed-mrr snapshot record failed (soft):", err);
  }
}

/**
 * Read committed snapshots on or after a `YYYY-MM-DD` lower bound, oldest→newest, mapping each row's
 * stored budget-cents to its committed MRR in USD (budgetCents × 30 / 100, FP-safe). Fail-soft: a read
 * error logs loud and returns `[]` (the series degrades to the current live point, never breaks the response).
 */
export async function readCommittedMrrSnapshotsSoft(
  sinceIso: string,
): Promise<Array<{ date: string; mrrUsd: number }>> {
  try {
    const since = sinceIso.slice(0, 10);
    const rows = await db
      .select({
        date: committedMrrSnapshots.snapshotDate,
        cents: committedMrrSnapshots.committedDailyBudgetCents,
      })
      .from(committedMrrSnapshots)
      .where(gte(committedMrrSnapshots.snapshotDate, since))
      .orderBy(committedMrrSnapshots.snapshotDate);
    return rows.map((r) => ({ date: r.date, mrrUsd: Math.round(r.cents * MRR_DAY_MULTIPLE) / 100 }));
  } catch (err) {
    console.error("[features-service] committed-mrr snapshot read failed (soft):", err);
    return [];
  }
}

/**
 * One org's recorded billing MRR on one day. `mrrCents` null = billing could not state it that day
 * (unknown, never a 0). `revenueClass` `unreadable` = billing could not read the org at all.
 */
export interface RecordedOrgMrr {
  orgId: string;
  revenueClass: string;
  mrrCents: string | null;
}

/**
 * Upsert today's per-org billing MRR (idempotent on (day, org); the day's rows are REPLACED so an org
 * that left billing's fleet does not linger). Fail-soft like the legacy store: a write blip logs loud and
 * the next read retries; the live figures on the response never depend on it.
 */
export async function recordRecurringMrrSnapshotSoft(rows: RecordedOrgMrr[], now: Date): Promise<void> {
  try {
    const snapshotDate = now.toISOString().slice(0, 10);
    await db.transaction(async (tx) => {
      await tx.delete(recurringMrrOrgSnapshots).where(eq(recurringMrrOrgSnapshots.snapshotDate, snapshotDate));
      if (rows.length > 0) {
        await tx.insert(recurringMrrOrgSnapshots).values(
          rows.map((r) => ({ snapshotDate, orgId: r.orgId, revenueClass: r.revenueClass, mrrCents: r.mrrCents, recordedAt: now })),
        );
      }
    });
  } catch (err) {
    console.error("[features-service] recurring-mrr snapshot record failed (soft):", err);
  }
}

/** Recorded per-org billing MRR on/after a `YYYY-MM-DD` bound, grouped by day. Fail-soft → empty map. */
export async function readRecurringMrrSnapshotsSoft(sinceIso: string): Promise<Map<string, RecordedOrgMrr[]>> {
  try {
    const rows = await db
      .select({
        date: recurringMrrOrgSnapshots.snapshotDate,
        orgId: recurringMrrOrgSnapshots.orgId,
        revenueClass: recurringMrrOrgSnapshots.revenueClass,
        mrrCents: recurringMrrOrgSnapshots.mrrCents,
      })
      .from(recurringMrrOrgSnapshots)
      .where(gte(recurringMrrOrgSnapshots.snapshotDate, sinceIso.slice(0, 10)));
    const byDay = new Map<string, RecordedOrgMrr[]>();
    for (const r of rows) {
      const list = byDay.get(r.date) ?? [];
      list.push({ orgId: r.orgId, revenueClass: r.revenueClass, mrrCents: r.mrrCents });
      byDay.set(r.date, list);
    }
    return byDay;
  } catch (err) {
    console.error("[features-service] recurring-mrr snapshot read failed (soft):", err);
    return new Map();
  }
}
