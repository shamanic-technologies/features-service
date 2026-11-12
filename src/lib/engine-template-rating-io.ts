/**
 * THE RATING PICKS TEMPLATES PER ENGINE (LLM-RATING-PER-ENGINE-1112 phase 2, owner 2026-11-12 via missoula-v12;
 * framework v10 section 8): a template DYNASTY is a candidate at a place of an Engine exactly like an LLM (same pure
 * Rating, `lib/engine-llm-rating.ts`, keyed on the dynasty slug).
 *
 * - CANDIDATES of an Engine = the template dynasties content-generation-service lists on any catalogue pipe whose
 *   outcome is the Engine's (the pipe's finer outcome, else its `to` step: how content-generation still keys its
 *   templates; read here only to find them, never served). Pickable = the dynasty is `active` and has a head.
 * - EVIDENCE = which template each DECISION (run) wrote with (`template_decisions`): the thread generation feed (its
 *   run IS the decision), our sequence copy (its completion runs -> our LLM call copy -> their decision), and every
 *   template pick (the asking run) from now on; the decision's LLM spend and ledger Units are the LLM Rating's.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { engineTemplatePicks, templateDecisions } from "../db/schema.js";
import { loadChannelCatalogue } from "./channel-declarations-store.js";
import { pipeLegKeyOf } from "./funnel-legs.js";
import { mapWithConcurrency } from "./concurrency.js";
import { readTemplateDynasties } from "./writer-catalogue-client.js";
import { readPostGenerations } from "./post-writer-evidence-io.js";
import type { TemplateDynasty } from "./research/template-dynasties.js";
import type { PickRecord } from "./engine-llm-rating.js";

export interface TemplateLine {
  slug: string;
  name: string;
  head: string | null;
  status: "active" | "deprecated" | null;
  /** Active with a head: a run may write with it today. */
  pickable: boolean;
}

const HOLD_MS = 10 * 60_000;
const pipeHeld = new Map<string, { at: number; value: Promise<TemplateDynasty[]> }>();

/** One pipe's template dynasties (content-generation), held 10 min. FAIL-LOUD. */
function pipeDynasties(featureSlug: string, legKey: string): Promise<TemplateDynasty[]> {
  const k = `${featureSlug}|${legKey}`;
  const hit = pipeHeld.get(k);
  if (hit && Date.now() - hit.at < HOLD_MS) return hit.value;
  const value = readTemplateDynasties(featureSlug, legKey).then((r) => {
    if (typeof r === "string") throw new Error(`content-generation template dynasties of ${k} unreadable`);
    return r;
  });
  pipeHeld.set(k, { at: Date.now(), value });
  value.catch(() => {
    if (pipeHeld.get(k)?.value === value) pipeHeld.delete(k);
  });
  return value;
}

/** Every catalogue pipe with the Engine outcome it produces. */
async function pipesWithOutcome(): Promise<Array<{ featureSlug: string; legKey: string; outcome: string }>> {
  const catalogue = await loadChannelCatalogue({ publishedOnly: false });
  return catalogue.channels.flatMap((c) => c.stepTransitions.map((t) => ({ featureSlug: c.slug, legKey: pipeLegKeyOf(c.slug, t.legKey), outcome: t.outcome ?? t.to.key })));
}

/** PURE: dynasties -> the Engine's template lines (one per dynasty slug, active first wins a duplicate). */
export function templateLinesOf(dynasties: readonly TemplateDynasty[]): TemplateLine[] {
  const out = new Map<string, TemplateLine>();
  for (const d of dynasties) {
    const line: TemplateLine = { slug: d.slug, name: d.name, head: d.head, status: d.status, pickable: d.status === "active" && !!d.head };
    const prev = out.get(d.slug);
    if (!prev || (!prev.pickable && line.pickable)) out.set(d.slug, line);
  }
  return [...out.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

/** The template dynasties an Engine may write with (FAIL-LOUD: an unreadable pipe is never "no template"). */
export async function engineTemplateLines(outcome: string): Promise<TemplateLine[]> {
  const pipes = (await pipesWithOutcome()).filter((p) => p.outcome === outcome);
  const read = await mapWithConcurrency(pipes, 4, (p) => pipeDynasties(p.featureSlug, p.legKey));
  return templateLinesOf(read.flat());
}

/** Every Engine's template lines (for the staff read). Unreadable pipes are logged and left out of that Engine. */
export async function everyEngineTemplateLines(): Promise<Map<string, TemplateLine[]>> {
  const pipes = await pipesWithOutcome();
  const byOutcome = new Map<string, TemplateDynasty[]>();
  await mapWithConcurrency(pipes, 4, async (p) => {
    try {
      const ds = await pipeDynasties(p.featureSlug, p.legKey);
      byOutcome.set(p.outcome, [...(byOutcome.get(p.outcome) ?? []), ...ds]);
    } catch (error) {
      console.error(`[features-service] template rating: ${(error as Error).message}, left out of the ${p.outcome} Engine this read`);
    }
  });
  return new Map([...byOutcome].map(([o, ds]) => [o, templateLinesOf(ds)]));
}

/** PURE: every version template id -> its dynasty slug (and each original a copy states), first dynasty wins. */
export function versionDynastyMap(dynasties: readonly TemplateDynasty[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of dynasties) for (const v of d.versions) if (!out.has(v)) out.set(v, d.slug);
  for (const d of dynasties) for (const orig of Object.values(d.copiedFrom ?? {})) if (!out.has(orig)) out.set(orig, d.slug);
  return out;
}

/** History: which template dynasty each decision wrote with, from the thread feed and our sequence copy. Idempotent. */
export async function ingestTemplateDecisions(): Promise<{ threads: number; sequences: number }> {
  const feed = await readPostGenerations();
  const thread = [...new Map(feed.filter((g) => g.runId && g.templateDynasty && !g.dryRun).map((g) => [`${g.runId}|${g.templateDynasty!.slug}`, { decisionRunId: g.runId!, templateDynastySlug: g.templateDynasty!.slug, source: "thread_generation" }])).values()];
  for (let i = 0; i < thread.length; i += 1000) await db.insert(templateDecisions).values(thread.slice(i, i + 1000)).onConflictDoNothing();
  const pipes = await pipesWithOutcome();
  const dynasties = (
    await mapWithConcurrency(pipes, 4, async (p) => {
      try {
        return await pipeDynasties(p.featureSlug, p.legKey);
      } catch {
        return [];
      }
    })
  ).flat();
  const map = versionDynastyMap(dynasties);
  // One JSON parameter (drizzle spreads a JS array into one parameter per item).
  const pairs = JSON.stringify([...map].map(([type, slug]) => ({ type, slug })));
  const res = await db.execute(sql`
    INSERT INTO template_decisions (decision_run_id, template_dynasty_slug, source)
    SELECT DISTINCT c.decision_run_id, m.slug, 'sequence_copy'
    FROM generation_sequence_copy g
    JOIN jsonb_to_recordset(${pairs}::jsonb) AS m(type text, slug text) ON m.type = g.prompt_type
    CROSS JOIN LATERAL unnest(g.completion_run_ids) AS r(run_id)
    JOIN llm_call_copy c ON c.call_run_id = r.run_id
    WHERE g.completion_run_ids IS NOT NULL
    ON CONFLICT DO NOTHING
  `);
  return { threads: thread.length, sequences: Number((res as unknown as { count?: number }).count ?? 0) };
}

/** Record one template pick and the decision it makes (the asking run). A write failure logs loud, never fails the pick. */
export async function recordTemplatePick(p: { outcome: string; place: string; templateDynastySlug: string; runId: string | null; campaignId: string | null }): Promise<void> {
  try {
    await db.insert(engineTemplatePicks).values(p);
    if (p.runId) await db.insert(templateDecisions).values({ decisionRunId: p.runId, templateDynastySlug: p.templateDynastySlug, source: "pick" }).onConflictDoNothing();
  } catch (error) {
    console.error(`[features-service] template pick ${p.outcome}|${p.place} -> ${p.templateDynastySlug} not recorded:`, (error as Error).message);
  }
}

export async function listTemplatePicks(sinceDay: string): Promise<PickRecord[]> {
  const rows = (await db.execute(sql`
    SELECT outcome, place, template_dynasty_slug, run_id, to_char(picked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
    FROM engine_template_picks WHERE picked_at >= ${`${sinceDay}T00:00:00Z`}::timestamptz
  `)) as unknown as Array<{ outcome: string; place: string; template_dynasty_slug: string; run_id: string | null; day: string }>;
  // The Rating's pick records are slug-keyed; for a template the slug is the template dynasty's.
  return rows.map((r) => ({ outcome: r.outcome, place: r.place, llmDynastySlug: r.template_dynasty_slug, runId: r.run_id, day: r.day }));
}

/** Test seam. */
export function __resetTemplateRatingForTest(): void {
  pipeHeld.clear();
}
