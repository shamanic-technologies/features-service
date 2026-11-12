/**
 * OUR COPY OF THE FLEET'S LLM CALLS (LLM-RATING-PER-ENGINE-1112). Producer reads, api key, no identity, FAIL-LOUD:
 *   - chat-service `GET /internal/llm-cost-names`: each cost name it ever billed -> its LLM dynasty (exact names, retired
 *     models included; a name it does not list is not an LLM: judges, images, embeddings);
 *   - runs-service `GET /internal/stats/service-calls?serviceName=chat-service` (whole history, then only what changed,
 *     cursor kept in `fleet-cell-store`): each call, its decision run, script / workflow, cost lines, support mark;
 *   - runs-service `POST /internal/stats/decision-units` (+ its `/changes` feed): the Units the ledger credits to each
 *     decision, own and one hop downstream, withdrawn Units out.
 * Each call is filed AT COPY TIME under its Engine (its script's outcome, else its workflow's pipe outcome) and its LLM
 * dynasty (`llm_call_copy`); the evidence build aggregates the copy in SQL (`lib/engine-llm-rating-io.ts`). Followed
 * every 2 minutes after listen, single-flight; a failed tick logs and the next resumes from the stored cursors.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { llmCallCopy, llmDecisionUnits } from "../db/schema.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { loadFleetCell, storeFleetCell } from "./fleet-cell-store.js";
import { listLegAssignments } from "./workflow-leg-assignments.js";
import { loadChannelCatalogue } from "./channel-declarations-store.js";
import { pipeLegKeyOf } from "./funnel-legs.js";

const CALLS_CURSOR_KEY = "llm-call-feed-cursor:v1";
const UNITS_CURSOR_KEY = "llm-decision-units-cursor:v1";
const TICK_MS = 2 * 60_000;
const FIRST_TICK_MS = 150_000;
const PAGE_LIMIT = 5000;
/** Pages per tick: the history (~875k calls) lands in ~10 ticks without holding the process. */
const PAGES_PER_TICK = 20;
const DECISIONS_PER_CALL = 200;
const DECISION_BATCHES_PER_TICK = 50;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not configured`);
  return v;
}

/** PURE: chat-service's cost-name list -> an exact-name lookup (never a prefix: `zai-glm-5.3-` nests in `-flash-`). */
export function costNameIndex(body: unknown): (costName: string) => string | null {
  const rows = (body as { costNames?: unknown }).costNames;
  if (!Array.isArray(rows)) throw new Error("chat-service llm-cost-names: no costNames array");
  const map = new Map<string, string>();
  for (const r of rows as Array<{ costName?: unknown; dynasty?: unknown }>) {
    if (typeof r.costName !== "string" || typeof r.dynasty !== "string") throw new Error(`chat-service llm-cost-names: malformed row ${JSON.stringify(r).slice(0, 200)}`);
    map.set(r.costName, r.dynasty);
  }
  return (name) => map.get(name) ?? null;
}

export async function readCostNameDynasties(): Promise<(costName: string) => string | null> {
  const res = await fetchWithRetry(`${env("CHAT_SERVICE_URL")}/internal/llm-cost-names`, { headers: { "x-api-key": env("CHAT_SERVICE_API_KEY") } }, { timeoutMs: 30_000 });
  if (!res.ok) throw new Error(`chat-service llm-cost-names ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return costNameIndex(await res.json());
}

/** PURE: the Engine outcome a script slug (`<outcome>/<dynasty>/v<n>`) works for. */
export const outcomeOfScriptSlug = (slug: string | null): string | null => {
  if (!slug) return null;
  const i = slug.indexOf("/");
  return i > 0 ? slug.slice(0, i) : null;
};

/**
 * PURE: a workflow version slug -> the Engine outcome of the pipe its dynasty is assigned on (the longest assigned dynasty
 * the slug is, or is a version `<dynasty>-…` of; an active row wins a tie). History filing only.
 */
export function workflowOutcomeResolver(
  assignments: ReadonlyArray<{ featureSlug: string; legKey: string; workflowDynastySlug: string; state: string }>,
  pipeOutcomeOf: (featureSlug: string, legKey: string) => string | null,
): (workflowSlug: string | null) => string | null {
  return (slug) => {
    if (!slug) return null;
    let best: { len: number; outcome: string; active: boolean } | null = null;
    for (const a of assignments) {
      const d = a.workflowDynastySlug;
      if (!(slug === d || slug.startsWith(`${d}-`))) continue;
      const outcome = pipeOutcomeOf(a.featureSlug, a.legKey);
      if (!outcome) continue;
      const active = a.state === "active";
      if (!best || d.length > best.len || (d.length === best.len && active && !best.active)) best = { len: d.length, outcome, active };
    }
    return best?.outcome ?? null;
  };
}

interface ServedCostLine {
  costName: string;
  status: string;
  totalCostInUsdCents: string;
}
interface ServedCall {
  runId: string;
  startedAt: string;
  workflowSlug: string | null;
  scriptSlug: string | null;
  rootRunId: string | null;
  decisionRunId: string | null;
  supportFunction: string | null;
  costs: ServedCostLine[];
}

/** PURE: one served call as its copy row (null = not an LLM call: no cost line chat-service places under a dynasty). */
export function copyRowOf(
  c: ServedCall,
  dynastyOfCostName: (costName: string) => string | null,
  workflowOutcome: (workflowSlug: string | null) => string | null,
): typeof llmCallCopy.$inferInsert | null {
  if (typeof c.runId !== "string" || typeof c.startedAt !== "string" || !Array.isArray(c.costs)) throw new Error(`runs-service service-calls: malformed call ${JSON.stringify(c).slice(0, 200)}`);
  // What the call cost, comped or not (the INCURRED basis of workflow performance): a released hold never happened.
  const charged = c.costs.filter((l) => l.status === "actual" || l.status === "provisioned" || l.status === "refunded");
  let llm: string | null = null;
  for (const l of c.costs) {
    llm = dynastyOfCostName(l.costName);
    if (llm) break;
  }
  if (!llm) return null;
  const cents = charged.reduce((s, l) => s + Number(l.totalCostInUsdCents), 0);
  return {
    callRunId: c.runId,
    decisionRunId: c.decisionRunId ?? c.rootRunId ?? c.runId,
    startedAt: new Date(c.startedAt),
    scriptSlug: c.scriptSlug,
    workflowSlug: c.workflowSlug,
    outcome: outcomeOfScriptSlug(c.scriptSlug) ?? workflowOutcome(c.workflowSlug),
    llmDynastySlug: llm,
    costNames: [...new Set(c.costs.map((l) => l.costName))].sort(),
    spentUsd: String(cents / 100),
    supportFunction: c.supportFunction,
  };
}

/** PURE: a decision's served Units -> quantity per outcome key (own and downstream). */
export function unitsByOutcome(units: ReadonlyArray<{ outcomeKey: string; quantity: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of units) out[u.outcomeKey] = (out[u.outcomeKey] ?? 0) + Number(u.quantity);
  return out;
}

async function runsGet(path: string): Promise<unknown> {
  const res = await fetchWithRetry(`${env("RUNS_SERVICE_URL")}${path}`, { headers: { "x-api-key": env("RUNS_SERVICE_API_KEY") } }, { timeoutMs: 120_000 });
  if (!res.ok) throw new Error(`runs-service ${path.split("?")[0]} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function workflowOutcomeNow(): Promise<(workflowSlug: string | null) => string | null> {
  const [assignments, catalogue] = await Promise.all([listLegAssignments(), loadChannelCatalogue({ publishedOnly: false })]);
  const pipeOutcome = new Map<string, string>();
  for (const c of catalogue.channels) for (const t of c.stepTransitions) pipeOutcome.set(`${c.slug}|${pipeLegKeyOf(c.slug, t.legKey)}`, t.outcome ?? t.to.key);
  return workflowOutcomeResolver(assignments, (f, l) => pipeOutcome.get(`${f}|${pipeLegKeyOf(f, l)}`) ?? null);
}

/** Copy the next pages of calls; returns the number of LLM calls copied and whether the feed is caught up. */
async function copyCalls(): Promise<{ copied: number; caughtUp: boolean }> {
  const [dynastyOf, workflowOutcome] = await Promise.all([readCostNameDynasties(), workflowOutcomeNow()]);
  let cursor = (await loadFleetCell(CALLS_CURSOR_KEY))?.text ?? null;
  let copied = 0;
  for (let page = 0; page < PAGES_PER_TICK; page++) {
    const q = new URLSearchParams({ serviceName: "chat-service", limit: String(PAGE_LIMIT) });
    if (cursor) q.set("cursor", cursor);
    const body = (await runsGet(`/internal/stats/service-calls?${q}`)) as { calls?: ServedCall[]; nextCursor?: string; caughtUp?: boolean };
    if (!Array.isArray(body.calls) || typeof body.nextCursor !== "string") throw new Error("runs-service service-calls: no calls / nextCursor");
    const rows = body.calls.map((c) => copyRowOf(c, dynastyOf, workflowOutcome)).filter((r): r is NonNullable<typeof r> => r !== null);
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      await db
        .insert(llmCallCopy)
        .values(chunk)
        .onConflictDoUpdate({
          target: llmCallCopy.callRunId,
          set: {
            decisionRunId: sql`excluded.decision_run_id`,
            scriptSlug: sql`excluded.script_slug`,
            workflowSlug: sql`excluded.workflow_slug`,
            outcome: sql`excluded.outcome`,
            llmDynastySlug: sql`excluded.llm_dynasty_slug`,
            costNames: sql`excluded.cost_names`,
            spentUsd: sql`excluded.spent_usd`,
            supportFunction: sql`excluded.support_function`,
            copiedAt: sql`now()`,
          },
        });
      // A decision seen for the first time (or touched again) is (re-)read.
      const decisions = [...new Set(chunk.map((r) => r.decisionRunId))];
      await db
        .insert(llmDecisionUnits)
        .values(decisions.map((d) => ({ decisionRunId: d, units: null, readAt: null })))
        .onConflictDoUpdate({ target: llmDecisionUnits.decisionRunId, set: { readAt: null } });
    }
    copied += rows.length;
    cursor = body.nextCursor;
    await storeFleetCell(CALLS_CURSOR_KEY, cursor, Date.now());
    if (body.caughtUp) return { copied, caughtUp: true };
  }
  return { copied, caughtUp: false };
}

/** Decisions the ledger's changes feed names since the stored cursor: marked to re-read. */
async function followUnitChanges(): Promise<number> {
  let cursor = (await loadFleetCell(UNITS_CURSOR_KEY))?.text ?? null;
  let marked = 0;
  for (let page = 0; page < 48; page++) {
    const body = (await runsGet(`/internal/stats/decision-units/changes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)) as { decisionRunIds?: string[]; nextCursor?: string; caughtUp?: boolean };
    if (!Array.isArray(body.decisionRunIds) || typeof body.nextCursor !== "string") throw new Error("runs-service decision-units changes: no decisionRunIds / nextCursor");
    for (let i = 0; i < body.decisionRunIds.length; i += 1000) {
      const ids = body.decisionRunIds.slice(i, i + 1000);
      const res = await db.execute(sql`UPDATE llm_decision_units SET read_at = NULL WHERE decision_run_id = ANY(${ids}::text[])`);
      marked += (res as unknown as { count?: number }).count ?? 0;
    }
    cursor = body.nextCursor;
    await storeFleetCell(UNITS_CURSOR_KEY, cursor, Date.now());
    if (body.caughtUp) break;
  }
  return marked;
}

/** Read the Units of the decisions waiting for a read. */
async function readPendingUnits(): Promise<number> {
  let read = 0;
  for (let b = 0; b < DECISION_BATCHES_PER_TICK; b++) {
    const pending = await db.select({ id: llmDecisionUnits.decisionRunId }).from(llmDecisionUnits).where(isNull(llmDecisionUnits.readAt)).limit(DECISIONS_PER_CALL);
    if (pending.length === 0) break;
    const ids = pending.map((p) => p.id);
    const uuidish = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    const res = uuidish.length
      ? await fetchWithRetry(
          `${env("RUNS_SERVICE_URL")}/internal/stats/decision-units`,
          { method: "POST", headers: { "x-api-key": env("RUNS_SERVICE_API_KEY"), "content-type": "application/json" }, body: JSON.stringify({ decisionRunIds: uuidish }) },
          { timeoutMs: 120_000 },
        )
      : null;
    if (res && !res.ok) throw new Error(`runs-service decision-units ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = res ? ((await res.json()) as { decisions?: Array<{ decisionRunId: string; units: Array<{ outcomeKey: string; quantity: string }> }> }) : { decisions: [] };
    if (!Array.isArray(body.decisions)) throw new Error("runs-service decision-units: no decisions array");
    const byId = new Map(body.decisions.map((d) => [d.decisionRunId.toLowerCase(), unitsByOutcome(d.units ?? [])]));
    const now = new Date();
    for (const id of ids) {
      await db
        .update(llmDecisionUnits)
        .set({ units: byId.get(id.toLowerCase()) ?? {}, readAt: now })
        .where(and(eq(llmDecisionUnits.decisionRunId, id), isNull(llmDecisionUnits.readAt)));
    }
    read += ids.length;
  }
  return read;
}

let ticking = false;
export async function llmCallFeedTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const calls = await copyCalls();
    const marked = await followUnitChanges();
    const read = await readPendingUnits();
    console.log(`[features-service] LLM call copy: ${calls.copied} calls copied${calls.caughtUp ? " (caught up)" : " (history continues)"}, ${marked} decisions re-marked, ${read} decisions' Units read`);
  } catch (error) {
    console.error("[features-service] LLM call copy tick failed, the next resumes from the stored cursors:", (error as Error).message);
  } finally {
    ticking = false;
  }
}

export function startLlmCallFeed(): void {
  setTimeout(() => void llmCallFeedTick(), FIRST_TICK_MS).unref();
  setInterval(() => void llmCallFeedTick(), TICK_MS).unref();
}
