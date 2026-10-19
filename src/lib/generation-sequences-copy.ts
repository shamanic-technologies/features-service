/**
 * OUR COPY OF CONTENT-GENERATION-SERVICE'S SEQUENCE FEED (LIVE-RESEARCH-1018). content-generation-service states, per
 * generated cold email sequence (campaign x lead, every org), the concrete model and the template that wrote it and
 * three deterministic classes of its first email's text (`GET /internal/sequences`, content-generation-service#289),
 * keyset-paged for a consumer to follow incrementally. The fleet person cell (`lib/fleet-positive-repliers.ts`) files
 * each person under what wrote their emails from this copy; the Research LLM, template, naming and first-email studies
 * read those buckets.
 *
 *  - One row per sequence (`generationId`), upserted (a re-read refreshes it: the classes are computed on read there).
 *  - The cursor is persisted per feature (`lib/fleet-cell-store.ts`); followed every 2 minutes after listen,
 *    single-flight; a failed tick logs and the next one resumes from the stored cursor.
 *  - Every feature holding a pipe workflow is followed (WRITTEN-BY-1019: a client reads who wrote ANY message we sent;
 *    the features come from `workflow_leg_assignments`, never a slug list). The research studies key on the cold email
 *    campaigns' (campaign, lead) pairs, so another feature's rows never enter them.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { generationSequenceCopy } from "../db/schema.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { loadFleetCell, storeFleetCell } from "./fleet-cell-store.js";
import { listLegAssignments } from "./workflow-leg-assignments.js";

const COLD_EMAIL = "sales-cold-email-outreach";

const cursorKeyOf = (feature: string) => `generation-sequences-cursor:${feature}:v1`;
const TICK_MS = 2 * 60_000;
const FIRST_TICK_MS = 100_000;

interface RawSequence {
  generationId: string;
  orgId: string;
  campaignId: string;
  leadId: string;
  model: string;
  promptType: string | null;
  workflowSlug: string | null;
  createdAt: string;
  firstEmail: { layout: string; opening: string; dash: string } | null;
}

/** PURE. One served sequence as its row. */
export function rowOfSequence(s: RawSequence): typeof generationSequenceCopy.$inferInsert {
  return {
    generationId: s.generationId,
    orgId: s.orgId,
    campaignId: s.campaignId,
    leadId: s.leadId,
    model: s.model,
    promptType: s.promptType,
    workflowSlug: s.workflowSlug,
    createdAt: new Date(s.createdAt),
    layout: s.firstEmail?.layout ?? null,
    opening: s.firstEmail?.opening ?? null,
    dash: s.firstEmail?.dash ?? null,
  };
}

/** Every feature holding a pipe workflow, cold email first (the research studies read it). */
async function followedFeatures(): Promise<string[]> {
  const slugs = new Set((await listLegAssignments()).map((r) => r.featureSlug));
  slugs.delete(COLD_EMAIL);
  return [COLD_EMAIL, ...[...slugs].sort()];
}

export async function copyGenerationSequences(): Promise<number> {
  let read = 0;
  for (const feature of await followedFeatures()) read += await copyFeatureSequences(feature);
  return read;
}

async function copyFeatureSequences(feature: string): Promise<number> {
  const base = process.env.CONTENT_GENERATION_SERVICE_URL;
  const key = process.env.CONTENT_GENERATION_SERVICE_API_KEY;
  if (!base || !key) throw new Error("CONTENT_GENERATION_SERVICE_URL / CONTENT_GENERATION_SERVICE_API_KEY not configured");
  const cursorKey = cursorKeyOf(feature);
  let cursor = (await loadFleetCell(cursorKey))?.text ?? null;
  let read = 0;
  for (let page = 0; page < 1000; page++) {
    const q = new URLSearchParams({ featureSlug: feature, limit: "1000" });
    if (cursor) q.set("cursor", cursor);
    const res = await fetchWithRetry(`${base}/internal/sequences?${q}`, { headers: { "x-api-key": key } }, { timeoutMs: 60_000 });
    if (!res.ok) throw new Error(`content-generation-service sequences (${feature}) ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { sequences?: RawSequence[]; nextCursor?: string | null; hasMore?: boolean };
    if (!Array.isArray(body.sequences)) throw new Error("content-generation-service sequences: malformed page");
    const rows = body.sequences.map(rowOfSequence);
    for (let i = 0; i < rows.length; i += 500) {
      await db
        .insert(generationSequenceCopy)
        .values(rows.slice(i, i + 500))
        .onConflictDoUpdate({
          target: generationSequenceCopy.generationId,
          set: {
            model: sql`excluded.model`,
            promptType: sql`excluded.prompt_type`,
            workflowSlug: sql`excluded.workflow_slug`,
            layout: sql`excluded.layout`,
            opening: sql`excluded.opening`,
            dash: sql`excluded.dash`,
            copiedAt: sql`now()`,
          },
        });
    }
    read += rows.length;
    if (body.nextCursor && body.nextCursor !== cursor) {
      cursor = body.nextCursor;
      await storeFleetCell(cursorKey, cursor, Date.now());
    }
    if (!body.hasMore) break;
  }
  return read;
}

let running: Promise<void> | null = null;
export function tickGenerationSequencesCopy(): Promise<void> {
  if (running) return running;
  running = copyGenerationSequences()
    .then((n) => {
      if (n > 0) console.log(`[features-service] generation sequences copy: ${n} sequences copied`);
    })
    .catch((err) => console.error("[features-service] generation sequences copy failed (next tick resumes from the stored cursor):", err))
    .finally(() => {
      running = null;
    });
  return running;
}

export function startGenerationSequencesCopy(): void {
  setTimeout(() => {
    void tickGenerationSequencesCopy();
    setInterval(() => void tickGenerationSequencesCopy(), TICK_MS).unref();
  }, FIRST_TICK_MS).unref();
}

/** What wrote one person's sequence, keyed `${campaignId}|${leadId}` (the latest generation of the pair). */
export interface GenerationClass {
  model: string;
  promptType: string | null;
  layout: string | null;
  opening: string | null;
  dash: string | null;
}

/** The whole copy as a lookup (≈60k rows, a few MB), read once per person cell build. */
export async function loadGenerationClasses(): Promise<Map<string, GenerationClass>> {
  const rows = await db
    .select({
      campaignId: generationSequenceCopy.campaignId,
      leadId: generationSequenceCopy.leadId,
      model: generationSequenceCopy.model,
      promptType: generationSequenceCopy.promptType,
      layout: generationSequenceCopy.layout,
      opening: generationSequenceCopy.opening,
      dash: generationSequenceCopy.dash,
      createdAt: generationSequenceCopy.createdAt,
    })
    .from(generationSequenceCopy);
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const out = new Map<string, GenerationClass>();
  for (const r of rows) out.set(`${r.campaignId}|${r.leadId}`, { model: r.model, promptType: r.promptType, layout: r.layout, opening: r.opening, dash: r.dash });
  return out;
}
