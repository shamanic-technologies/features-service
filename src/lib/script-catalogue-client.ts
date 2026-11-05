/**
 * THE RUNNABLE SCRIPTS OF EVERY ENGINE, read from workflow-service's script catalogue with its api key only (MIGRATE-1105
 * S0-STRATEGY): `GET /internal/scripts[?outcome=]`, one row per runnable version (status active + dynasty active; a
 * dynasty holds at most one active version), each with what Jev judges a script on: its description, its tactics as
 * data and its code. Read by the tactic sweep (no org request behind it) and by the per-run strategy read (held 60 s).
 * FAIL-LOUD: a caller either retries next sweep or answers 502 (the runner then runs nothing and retries).
 */
import { fetchWithRetry } from "./fetch-retry.js";

export interface RunnableScript {
  id: string;
  /** The Engine: the outcome one run of the script makes. */
  outcome: string;
  dynasty: string;
  version: number;
  description: string;
  tactics: Record<string, unknown>;
  code: string;
}

/** PURE: the key a script dynasty is judged and kept on (`<outcome>/<dynasty>`, workflow-service's own spelling). */
export const scriptDynastyKey = (s: Pick<RunnableScript, "outcome" | "dynasty">): string => `${s.outcome}/${s.dynasty}`;

/** PURE: the version a verdict was judged on (a new version re-judges the dynasty; the old verdict serves until then). */
export const scriptVersionKey = (s: Pick<RunnableScript, "id" | "version">): string => `v${s.version}:${s.id}`;

/** PURE: one served row, or null when it lacks what a judgment reads. Only RUNNABLE rows are kept. */
export function parseRunnableScript(r: Record<string, unknown>): RunnableScript | null {
  if (typeof r.id !== "string" || typeof r.outcome !== "string" || typeof r.dynasty !== "string" || typeof r.version !== "number" || typeof r.code !== "string") return null;
  const runnable = r.runnable === undefined ? r.status === "active" && (r.dynastyStatus === undefined || r.dynastyStatus === "active") : r.runnable === true;
  if (!runnable) return null;
  return {
    id: r.id,
    outcome: r.outcome,
    dynasty: r.dynasty,
    version: r.version,
    description: typeof r.description === "string" ? r.description : "",
    tactics: r.tactics && typeof r.tactics === "object" && !Array.isArray(r.tactics) ? (r.tactics as Record<string, unknown>) : {},
    code: r.code,
  };
}

const HELD_MS = 60_000;
const TIMEOUT_MS = 30_000;
let held: { at: number; value: Promise<RunnableScript[]> } | null = null;

/** Every runnable script of every Engine, shared 60 s (a run-time reader calls it once per run). FAIL-LOUD. */
export function readRunnableScripts(): Promise<RunnableScript[]> {
  if (held && Date.now() - held.at < HELD_MS) return held.value;
  const value = (async () => {
    const base = process.env.WORKFLOW_SERVICE_URL;
    const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;
    if (!base || !apiKey) throw new Error("[features-service] WORKFLOW_SERVICE_URL / WORKFLOW_SERVICE_API_KEY not configured");
    const url = `${base}/internal/scripts`;
    const res = await fetchWithRetry(url, { headers: { "x-api-key": apiKey } }, { timeoutMs: TIMEOUT_MS });
    if (!res.ok) throw new Error(`workflow-service ${url} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { scripts?: unknown };
    if (!Array.isArray(body.scripts)) throw new Error(`workflow-service ${url} returned no scripts array`);
    return body.scripts.flatMap((r) => {
      const s = r && typeof r === "object" ? parseRunnableScript(r as Record<string, unknown>) : null;
      return s ? [s] : [];
    });
  })();
  held = { at: Date.now(), value };
  value.catch(() => {
    if (held?.value === value) held = null;
  });
  return value;
}

/** Test seam. */
export function __resetRunnableScriptsForTest(): void {
  held = null;
}
