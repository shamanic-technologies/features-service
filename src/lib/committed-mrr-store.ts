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
import { gte } from "drizzle-orm";
import { db } from "../db/index.js";
import { committedMrrSnapshots } from "../db/schema.js";

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
