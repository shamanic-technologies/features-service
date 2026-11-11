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

/** Upsert one answer. A refusal keeps the streak's `first_held_at`; a good answer clears it. Never throws. */
export async function persistEngineAnswer(campaignId: string, outcome: string, heldReason: string | null, at = Date.now()): Promise<void> {
  const key = `${campaignId}|${outcome}`;
  if (!shouldWriteAnswer(lastWritten.get(key), heldReason, at)) return;
  lastWritten.set(key, { heldReason, at });
  if (lastWritten.size > 20_000) for (const [k, v] of lastWritten) if (at - v.at > ENGINE_ANSWER_WINDOW_MS) lastWritten.delete(k);
  const when = new Date(at);
  try {
    await db
      .insert(campaignEngineAnswers)
      .values({ campaignId, outcome, heldReason, firstHeldAt: heldReason === null ? null : when, answeredAt: when })
      .onConflictDoUpdate({
        target: [campaignEngineAnswers.campaignId, campaignEngineAnswers.outcome],
        set: {
          heldReason,
          answeredAt: when,
          firstHeldAt:
            heldReason === null
              ? sql`NULL`
              : sql`CASE WHEN ${campaignEngineAnswers.heldReason} IS NOT NULL AND ${campaignEngineAnswers.firstHeldAt} IS NOT NULL THEN ${campaignEngineAnswers.firstHeldAt} ELSE ${when.toISOString()}::timestamptz END`,
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
  }));
}
