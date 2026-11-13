/**
 * THE STORES OF THE LLM RATING (LLM-RATING-PER-ENGINE-1112; pure rule `lib/engine-llm-rating.ts`, migration 0069):
 * which LLMs each Engine may use (`engine_llm_universes`, staff-written) and every pick the Rating answered
 * (`engine_llm_picks`). Reads fail loud (a universe read that failed is never "every LLM").
 */
import { desc, gte } from "drizzle-orm";
import { db } from "../db/index.js";
import { engineLlmPicks, engineLlmUniverses } from "../db/schema.js";
import type { PickRecord, UniverseRule } from "./engine-llm-rating.js";

export async function listUniverseRules(): Promise<UniverseRule[]> {
  const rows = await db.select().from(engineLlmUniverses);
  return rows.map((r) => ({
    outcome: r.outcome,
    allowed: r.allowed ?? null,
    excluded: r.excluded ?? [],
    decidedBy: r.decidedBy,
    note: r.note ?? null,
    decidedAt: r.decidedAt.toISOString(),
  }));
}

/** Write one Engine's universe (or the fleet row `*`): `allowed` null = every served LLM, `excluded` taken out. */
export async function putUniverseRule(input: { outcome: string; allowed: string[] | null; excluded: string[]; decidedBy: string; note: string | null }): Promise<UniverseRule> {
  const now = new Date();
  const [row] = await db
    .insert(engineLlmUniverses)
    .values({ ...input, decidedAt: now })
    .onConflictDoUpdate({ target: engineLlmUniverses.outcome, set: { allowed: input.allowed, excluded: input.excluded, decidedBy: input.decidedBy, note: input.note, decidedAt: now } })
    .returning();
  return { outcome: row!.outcome, allowed: row!.allowed ?? null, excluded: row!.excluded ?? [], decidedBy: row!.decidedBy, note: row!.note ?? null, decidedAt: row!.decidedAt.toISOString() };
}

/** Every pick since `sinceDay` (YYYY-MM-DD), newest first. */
export async function listLlmPicks(sinceDay: string): Promise<PickRecord[]> {
  const rows = await db
    .select()
    .from(engineLlmPicks)
    .where(gte(engineLlmPicks.pickedAt, new Date(`${sinceDay}T00:00:00Z`)))
    .orderBy(desc(engineLlmPicks.pickedAt));
  return rows.map((r) => ({ outcome: r.outcome, place: r.place, llmDynastySlug: r.llmDynastySlug, runId: r.runId, day: r.pickedAt.toISOString().slice(0, 10) }));
}
