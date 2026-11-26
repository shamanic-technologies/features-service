/**
 * IO of `lib/message-writer-model.ts` (MODEL-TAG-EVERY-AI-MESSAGE-1126): the person's ledger occurrences and a writing
 * run's cost lines, both at runs-service. Fail-loud per read; the caller turns a failure into a named null.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import type { LedgerOccurrence, RunCostLine } from "./message-writer-model.js";

const PAGE = 1000;
const MAX_PAGES = 20;

function runsBase(): { base: string; apiKey: string } {
  const base = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!base || !apiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  return { base, apiKey };
}

/**
 * Every ledger occurrence on one lead-service person (both directions), kept to the org's runs: a person is a
 * shared global id, another org's sends are never this org's messages.
 */
export async function readPersonLedger(orgId: string, leadId: string): Promise<LedgerOccurrence[]> {
  const { base, apiKey } = runsBase();
  const out: LedgerOccurrence[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ subjectService: "lead-service", subjectIds: leadId, limit: String(PAGE) });
    if (cursor) q.set("cursor", cursor);
    const res = await fetchWithRetry(`${base}/internal/outcome-occurrences?${q}`, { headers: { "x-api-key": apiKey } }, { timeoutMs: 30_000 });
    if (!res.ok) throw new Error(`runs-service outcome-occurrences ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { occurrences?: LedgerOccurrence[]; nextCursor?: string | null };
    if (!Array.isArray(body.occurrences)) throw new Error("runs-service outcome-occurrences: no occurrences array");
    for (const o of body.occurrences) if (o.organizationId === orgId) out.push(o);
    cursor = body.nextCursor ?? null;
    if (!cursor) return out;
  }
  throw new Error(`runs-service outcome-occurrences: person ${leadId} holds more than ${PAGE * MAX_PAGES} occurrences`);
}

/** run id -> its tree's cost lines, held once the run is finished (a finished run bills nothing more). */
const held = new Map<string, RunCostLine[]>();
const HELD_MAX = 20_000;

/** The cost lines of a run and every run under it. The run must be the org's. */
export async function readRunTreeCostLines(orgId: string, runId: string): Promise<RunCostLine[]> {
  const hit = held.get(`${orgId}|${runId}`);
  if (hit) return hit;
  const { base, apiKey } = runsBase();
  const res = await fetchWithRetry(`${base}/v1/runs/${encodeURIComponent(runId)}`, { headers: { "x-api-key": apiKey, "x-org-id": orgId } }, { timeoutMs: 20_000 });
  if (!res.ok) throw new Error(`runs-service run ${runId} ${res.status}`);
  const run = (await res.json()) as {
    organizationId?: unknown;
    status?: unknown;
    costs?: RunCostLine[];
    descendantRuns?: Array<{ status?: unknown; costs?: RunCostLine[] }>;
  };
  if (run.organizationId !== orgId) throw new Error(`run ${runId} is not the org's`);
  const trees = [run, ...(run.descendantRuns ?? [])];
  const lines = trees.flatMap((r) => (Array.isArray(r.costs) ? r.costs : [])).map((c) => ({ costName: c.costName, status: c.status, createdAt: c.createdAt }));
  const finished = trees.every((r) => r.status === "completed" || r.status === "failed");
  if (finished) {
    if (held.size >= HELD_MAX) held.clear();
    held.set(`${orgId}|${runId}`, lines);
  }
  return lines;
}

/** Test seam. */
export function __resetRunTreeCostLinesForTest(): void {
  held.clear();
}
