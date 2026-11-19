/**
 * ENGINE ANSWERS STORE (NEXT-STEPS-TRUE-REASON-1111). Every answer `/internal/script-strategy` gives the Engine runner is
 * kept per (pipe campaign, Engine) in `campaign_engine_answers`, so the campaign next-steps read (any process, after any
 * restart) names the Engine that cannot run and why, instead of a bare "nothing queued" the assistant then explains
 * with a guess (prod 2026-11-11, campaign 3cfc2aaa: « Message written » refused 14 times for no brief, next-steps said
 * 0 queued, Sophie said "today's cap is used").
 *
 * Writes are cheap upserts, throttled per key in memory: an unchanged answer is re-written at most once a minute (the
 * runner asks per run); a change is written at once. A write failure logs loud and never fails the runner's answer.
 */
import { and, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaignEngineAnswers } from "../db/schema.js";
import type { HeldEngine } from "./campaign-next-steps.js";

/** An answer older than this says nothing about now (the Monitoring check's own window). */
export const ENGINE_ANSWER_WINDOW_MS = 60 * 60_000;
const REWRITE_MS = 60_000;

const lastWritten = new Map<string, { heldReason: string | null; at: number }>();

export function __resetEngineAnswerWritesForTest(): void {
  lastWritten.clear();
}

/** PURE: whether this answer must be written now (state changed, or the stored one is a minute old). */
export function shouldWriteAnswer(prev: { heldReason: string | null; at: number } | undefined, heldReason: string | null, at: number): boolean {
  return !prev || prev.heldReason !== heldReason || at - prev.at >= REWRITE_MS;
}

/**
 * DOC-DINNERS-SENDS-1119. A pass stated less than this before a refusal of the same reason is the SAME run, refused
 * further down: campaign-service states "ran" when it dispatches, this service answers the runner's strategy read, then
 * the gate refuses (prod 2026-11-19: dispatch -> gate refusal in 8 s, every 30 min). Those passes do not end the streak.
 * A pass that has stood longer (the Engine really ran, then got refused again) does.
 */
export const SAME_RUN_PASS_MS = 2 * 60_000;

/** The stored streak of one (unit, Engine). */
export interface AnswerStreak {
  heldReason: string | null;
  firstHeldAt: Date | null;
  streakReason: string | null;
  passingSince: Date | null;
}

/**
 * PURE: the streak after one more answer (`heldReason` null = a pass). The rule the upsert below runs in SQL, kept here
 * so it is tested: a refusal keeps `firstHeldAt` when it repeats the streak's reason and the Engine was held, or passed
 * only for less than `SAME_RUN_PASS_MS`; any other refusal starts a streak now. A pass keeps the streak in memory (a
 * refusal seconds later continues it) and starts `passingSince` if not passing already.
 */
export function nextStreak(prev: AnswerStreak | null, heldReason: string | null, when: Date): AnswerStreak {
  if (heldReason === null) {
    return {
      heldReason: null,
      firstHeldAt: prev?.firstHeldAt ?? null,
      streakReason: prev?.streakReason ?? null,
      passingSince: prev && prev.heldReason === null && prev.passingSince ? prev.passingSince : when,
    };
  }
  const continues =
    prev !== null &&
    prev.streakReason === heldReason &&
    prev.firstHeldAt !== null &&
    (prev.heldReason !== null || prev.passingSince === null || when.getTime() - prev.passingSince.getTime() < SAME_RUN_PASS_MS);
  return { heldReason, firstHeldAt: continues ? prev!.firstHeldAt : when, streakReason: heldReason, passingSince: null };
}

/**
 * Upsert one answer, atomically (`nextStreak`'s rule in SQL: every right-hand side reads the row as it was).
 * `expected` = the holder called the hold a normal business state (MON-HELD-FALSE-1113); a pass is never expected.
 * Never throws.
 */
export async function persistEngineAnswer(campaignId: string, outcome: string, heldReason: string | null, at = Date.now(), expected = false): Promise<void> {
  const key = `${campaignId}|${outcome}`;
  if (!shouldWriteAnswer(lastWritten.get(key), heldReason, at)) return;
  lastWritten.set(key, { heldReason, at });
  if (lastWritten.size > 20_000) for (const [k, v] of lastWritten) if (at - v.at > ENGINE_ANSWER_WINDOW_MS) lastWritten.delete(k);
  const when = new Date(at);
  const whenSql = sql`${when.toISOString()}::timestamptz`;
  const t = campaignEngineAnswers;
  const isExpected = heldReason !== null && expected;
  try {
    await db
      .insert(campaignEngineAnswers)
      .values({
        campaignId,
        outcome,
        heldReason,
        firstHeldAt: heldReason === null ? null : when,
        answeredAt: when,
        streakReason: heldReason,
        passingSince: heldReason === null ? when : null,
        expected: isExpected,
      })
      .onConflictDoUpdate({
        target: [t.campaignId, t.outcome],
        set:
          heldReason === null
            ? {
                heldReason: null,
                answeredAt: when,
                expected: false,
                passingSince: sql`CASE WHEN ${t.heldReason} IS NULL AND ${t.passingSince} IS NOT NULL THEN ${t.passingSince} ELSE ${whenSql} END`,
              }
            : {
                heldReason,
                answeredAt: when,
                expected: isExpected,
                streakReason: heldReason,
                passingSince: sql`NULL`,
                firstHeldAt: sql`CASE WHEN ${t.streakReason} = ${heldReason} AND ${t.firstHeldAt} IS NOT NULL AND (${t.heldReason} IS NOT NULL OR ${t.passingSince} IS NULL OR ${whenSql} - ${t.passingSince} < make_interval(secs => ${SAME_RUN_PASS_MS / 1000})) THEN ${t.firstHeldAt} ELSE ${whenSql} END`,
              },
      });
  } catch (err) {
    lastWritten.delete(key);
    console.error(`[features-service] engine answer ${campaignId} x ${outcome} not stored (next-steps will not see it):`, err);
  }
}

/** The Engines of these pipe campaigns whose latest answer in the last hour was a refusal. FAIL-LOUD (throws). */
export async function readHeldEngines(campaignIds: readonly string[], now = Date.now()): Promise<HeldEngine[]> {
  if (campaignIds.length === 0) return [];
  const rows = await db
    .select()
    .from(campaignEngineAnswers)
    .where(
      and(
        inArray(campaignEngineAnswers.campaignId, [...campaignIds]),
        isNotNull(campaignEngineAnswers.heldReason),
        gte(campaignEngineAnswers.answeredAt, new Date(now - ENGINE_ANSWER_WINDOW_MS)),
      ),
    );
  return rows.map((r) => ({
    outcome: r.outcome,
    pipeCampaignId: r.campaignId,
    reason: r.heldReason as string,
    heldSince: (r.firstHeldAt ?? r.answeredAt).toISOString(),
    lastAnsweredAt: r.answeredAt.toISOString(),
    expected: r.expected,
  }));
}

/**
 * CAMPAIGN-SCRIPTS-1113: the Engines the runner ever asked a strategy for, per pipe campaign (any answer, held or not):
 * an Engine the campaign USES. FAIL-LOUD (throws).
 */
export async function readAskedEngines(campaignIds: readonly string[]): Promise<string[]> {
  if (campaignIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ outcome: campaignEngineAnswers.outcome })
    .from(campaignEngineAnswers)
    .where(inArray(campaignEngineAnswers.campaignId, [...campaignIds]));
  return rows.map((r) => r.outcome).sort();
}
