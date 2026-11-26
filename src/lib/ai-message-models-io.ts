/**
 * IO of `lib/ai-message-models.ts` (MODEL-TAG-EVERY-AI-MESSAGE-1126): builds one UTC day from runs-service's ledger and
 * chat-service's cost-name catalogue, stores it (`ai_message_model_days`), and keeps the series current off the request
 * path: today and yesterday every hour, plus a few missing or older-rule days of the last `BACKFILL_DAYS` per tick.
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../db/index.js";
import { aiMessageModelDays } from "../db/schema.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { mapWithConcurrency } from "./concurrency.js";
import { readLlmCostNameModels } from "./llm-cost-names-client.js";
import { readRunTreeCostLines } from "./message-writer-model-io.js";
import type { RunCostLine } from "./message-writer-model.js";
import { AI_MESSAGE_MODELS_RULE, tallySends, type DaySend, type OrgDayTally } from "./ai-message-models.js";

const PAGE = 1000;
const RUN_CHUNK = 100;
const BACKFILL_DAYS = 30;
const BACKFILL_PER_TICK = 4;
const TICK_MS = 60 * 60_000;
const FIRST_TICK_MS = 4 * 60_000;

interface Occ {
  runId: string;
  organizationId: string | null;
  consumption: { sourceRunId: string | null } | null;
  reversal?: unknown;
}

async function readOccurrences(params: Record<string, string>): Promise<Occ[]> {
  const base = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!base || !apiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  const out: Occ[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 200; page++) {
    const q = new URLSearchParams({ ...params, limit: String(PAGE) });
    if (cursor) q.set("cursor", cursor);
    const res = await fetchWithRetry(`${base}/internal/outcome-occurrences?${q}`, { headers: { "x-api-key": apiKey } }, { timeoutMs: 150_000 });
    if (!res.ok) throw new Error(`runs-service outcome-occurrences ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { occurrences?: Occ[]; nextCursor?: string | null };
    if (!Array.isArray(body.occurrences)) throw new Error("runs-service outcome-occurrences: no occurrences array");
    out.push(...body.occurrences);
    cursor = body.nextCursor ?? null;
    if (!cursor) return out;
  }
  throw new Error("runs-service outcome-occurrences: more than 200 pages");
}

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** One UTC day, tallied per org (fail-loud: a day is stored whole or not at all). */
export async function computeAiMessageModelDay(day: string): Promise<OrgDayTally[]> {
  const sent = (await readOccurrences({ outcomeKey: "message_sent", direction: "produced", declaredAfter: `${day}T00:00:00Z`, declaredBefore: `${nextDay(day)}T00:00:00Z` })).filter(
    (o) => !o.reversal,
  );
  const sends: DaySend[] = sent.map((o) => ({ runId: o.runId, orgId: o.organizationId }));
  const orgOfRun = new Map(sends.map((s) => [s.runId, s.orgId]));
  const runIds = [...orgOfRun.keys()];
  const writersOfSendRun = new Map<string, string[]>();
  for (let i = 0; i < runIds.length; i += RUN_CHUNK) {
    const consumed = await readOccurrences({ runIds: runIds.slice(i, i + RUN_CHUNK).join(","), outcomeKey: "message_written", direction: "consumed" });
    for (const o of consumed) {
      if (o.reversal || !o.consumption?.sourceRunId) continue;
      const list = writersOfSendRun.get(o.runId) ?? [];
      if (!list.includes(o.consumption.sourceRunId)) list.push(o.consumption.sourceRunId);
      writersOfSendRun.set(o.runId, list);
    }
  }
  const writers = new Map<string, string | null>();
  for (const [sendRun, list] of writersOfSendRun) if (list.length === 1) writers.set(list[0], orgOfRun.get(sendRun) ?? null);
  const linesOfWriter = new Map<string, RunCostLine[] | null>();
  await mapWithConcurrency([...writers.entries()], 4, async ([runId, orgId]) => {
    try {
      linesOfWriter.set(runId, orgId ? await readRunTreeCostLines(orgId, runId) : null);
    } catch (error) {
      console.error(`[features-service] ai-message-models: writing run ${runId} unreadable:`, (error as Error).message);
      linesOfWriter.set(runId, null);
    }
  });
  const catalogue = await readLlmCostNameModels().catch((error) => {
    console.error("[features-service] ai-message-models: llm cost names unreadable:", error);
    return null;
  });
  return tallySends({ sends, writersOfSendRun, linesOfWriter, catalogue });
}

async function storeDay(day: string, rows: OrgDayTally[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(aiMessageModelDays).where(eq(aiMessageModelDays.day, day));
    if (rows.length === 0) {
      // A day with no send is stored as such (one empty fleet row), so it is never recomputed as "missing".
      rows = [{ orgId: "", sentNotWrittenByOurRuns: 0, messages: 0, withModel: 0, withoutModel: 0, withoutByReason: {}, byModel: {} }];
    }
    await tx.insert(aiMessageModelDays).values(
      rows.map((r) => ({ day, orgId: r.orgId, sentNotWrittenByOurRuns: r.sentNotWrittenByOurRuns, messages: r.messages, withModel: r.withModel, withoutModel: r.withoutModel, withoutByReason: r.withoutByReason, byModel: r.byModel, rule: AI_MESSAGE_MODELS_RULE })),
    );
  });
}

export interface StoredDayRow {
  day: string;
  orgId: string;
  sentNotWrittenByOurRuns: number;
  messages: number;
  withModel: number;
  withoutModel: number;
  withoutByReason: Record<string, number>;
  byModel: Record<string, number>;
  computedAt: string;
}

export async function readStoredAiMessageModelDays(sinceDay: string): Promise<StoredDayRow[]> {
  const rows = await db
    .select()
    .from(aiMessageModelDays)
    .where(and(gte(aiMessageModelDays.day, sinceDay), eq(aiMessageModelDays.rule, AI_MESSAGE_MODELS_RULE)))
    .orderBy(desc(aiMessageModelDays.day), aiMessageModelDays.orgId);
  return rows.map((r) => ({
    day: String(r.day),
    orgId: r.orgId,
    sentNotWrittenByOurRuns: r.sentNotWrittenByOurRuns,
    messages: r.messages,
    withModel: r.withModel,
    withoutModel: r.withoutModel,
    withoutByReason: r.withoutByReason as Record<string, number>,
    byModel: r.byModel as Record<string, number>,
    computedAt: r.computedAt.toISOString(),
  }));
}

const dayOf = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

let running = false;

/** One pass: today + yesterday, then up to BACKFILL_PER_TICK days of the window not stored under this rule. */
export async function aiMessageModelsTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const stored = (await db
      .selectDistinct({ day: aiMessageModelDays.day })
      .from(aiMessageModelDays)
      .where(and(gte(aiMessageModelDays.day, dayOf(BACKFILL_DAYS)), eq(aiMessageModelDays.rule, AI_MESSAGE_MODELS_RULE)))) as Array<{ day: unknown }>;
    const have = new Set(stored.map((r) => String(r.day)));
    const missing = Array.from({ length: BACKFILL_DAYS - 1 }, (_, i) => dayOf(i + 2)).filter((d) => !have.has(d)).slice(0, BACKFILL_PER_TICK);
    for (const day of [dayOf(0), dayOf(1), ...missing]) {
      const t = Date.now();
      try {
        const rows = await computeAiMessageModelDay(day);
        await storeDay(day, rows);
        const m = rows.reduce((a, r) => a + r.messages, 0);
        const w = rows.reduce((a, r) => a + r.withModel, 0);
        console.log(`[features-service] ai-message-models ${day}: ${w}/${m} messages name their model (${Date.now() - t} ms)`);
      } catch (error) {
        console.error(`[features-service] ai-message-models ${day} not built this tick:`, error);
      }
    }
  } finally {
    running = false;
  }
}

export function startAiMessageModelsLoop(): void {
  if (process.env.AI_MESSAGE_MODELS_LOOP === "false") return;
  setTimeout(() => {
    void aiMessageModelsTick();
    setInterval(() => void aiMessageModelsTick(), TICK_MS).unref();
  }, FIRST_TICK_MS).unref();
}
