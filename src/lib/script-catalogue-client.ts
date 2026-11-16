/**
 * THE RUNNABLE SCRIPTS OF EVERY ENGINE, read from workflow-service's script catalogue with its api key only (MIGRATE-1105
 * S0-STRATEGY): `GET /internal/scripts[?outcome=]`, one row per runnable version (status active + dynasty active; a
 * dynasty holds at most one active version), each with what Jev judges a script on: its description, its tactics as
 * data and its code. Read by the tactic sweep (no org request behind it) and by the per-run strategy read (held 60 s).
 * FAIL-LOUD: a caller either retries next sweep or answers 502 (the runner then runs nothing and retries).
 */
import { fetchWithRetry } from "./fetch-retry.js";
import type { ScriptMerge } from "./script-value-rating.js";

export interface RunnableScript {
  id: string;
  /** The Engine: the outcome one run of the script makes. */
  outcome: string;
  dynasty: string;
  version: number;
  /** The short client-readable name workflow-service gives the dynasty (CAMPAIGN-SCRIPTS-1113-NAMES); null = not named yet. */
  name?: string | null;
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
    name: typeof r.name === "string" && r.name.trim() !== "" ? r.name : null,
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

/** PURE: the channel a script states (tactic `channel`), or null: a script stating none is asked by other scripts. */
export const scriptChannelOf = (s: Pick<RunnableScript, "tactics">): string | null =>
  typeof s.tactics.channel === "string" && s.tactics.channel ? s.tactics.channel : null;

/**
 * PURE (MIGRATE-1105 S5, owner 2026-11-06: the outcome is the WHAT, as fine as possible): whether a runnable script works
 * a pipe. It makes the outcome of the pipe's Engine, and either states the pipe's channel (tactic `channel`, a script not
 * yet re-homed onto its fine outcome) or states none on a pipe that names its Engine outcome (`outcomeStated`). A script
 * stating no channel on a pipe naming none is asked by other scripts, never the pipe's own.
 */
export function scriptWorksPipe(
  s: Pick<RunnableScript, "outcome" | "tactics">,
  pipe: { channelSlug: string; outcome: string; outcomeStated: boolean },
): boolean {
  if (s.outcome !== pipe.outcome) return false;
  const channel = scriptChannelOf(s);
  return channel !== null ? channel === pipe.channelSlug : pipe.outcomeStated;
}

let lastGood: { at: number; scripts: RunnableScript[] } | null = null;

/**
 * The catalogue's read (MIGRATE-1105 S0b: a play runs on the scripts its strategy keeps): every catalogue read prices
 * plays, so a workflow-service hiccup must not take the catalogue down. A failed read serves the last good one LOUDLY;
 * none ever read = throws (fail loud, never "no script").
 */
export async function readRunnableScriptsForCatalogue(): Promise<RunnableScript[]> {
  try {
    const scripts = await readRunnableScripts();
    lastGood = { at: Date.now(), scripts };
    return scripts;
  } catch (error) {
    if (!lastGood) throw error;
    console.error(`[features-service] runnable scripts unreadable, the read of ${new Date(lastGood.at).toISOString()} stands:`, (error as Error).message);
    return lastGood.scripts;
  }
}

/** PURE: the merges of a workflow-service body. FAIL-LOUD on a row that does not name its two scripts. */
export function parseScriptMerges(body: unknown): ScriptMerge[] {
  const rows = body && typeof body === "object" ? (body as { merges?: unknown }).merges : undefined;
  if (!Array.isArray(rows)) throw new Error("[features-service] workflow-service /internal/scripts/merges served no merges array");
  const key = (v: unknown, what: string): string => {
    if (typeof v !== "string" || !/^[^/]+\/[^/]+$/.test(v)) throw new Error(`[features-service] script merges: ${what} is not <outcome>/<dynasty>`);
    return v;
  };
  return rows.map((r) => {
    if (!r || typeof r !== "object") throw new Error("[features-service] script merges: a merge is not an object");
    const m = r as Record<string, unknown>;
    return { absorbed: key(m.absorbed, "absorbed"), survivor: key(m.survivor, "survivor"), askedBy: m.askedBy === null || m.askedBy === undefined ? null : key(m.askedBy, "askedBy") };
  });
}

let heldMerges: { at: number; value: Promise<ScriptMerge[]> } | null = null;

/**
 * ONE-WRITER-N-MODELS-1116: every merge workflow-service made of a per-model copy into its survivors (`GET
 * /internal/scripts/merges`), shared 60 s. FAIL-LOUD like every Rating input, with ONE exception: a 404 means
 * workflow-service does not serve the route yet, and a merge it has not made cannot exist (it serves every merge it
 * makes, from its first one): no merge, logged loud. Delete that exception once the route is live.
 */
export function readScriptMerges(): Promise<ScriptMerge[]> {
  if (heldMerges && Date.now() - heldMerges.at < HELD_MS) return heldMerges.value;
  const value = (async () => {
    const base = process.env.WORKFLOW_SERVICE_URL;
    const apiKey = process.env.WORKFLOW_SERVICE_API_KEY;
    if (!base || !apiKey) throw new Error("[features-service] WORKFLOW_SERVICE_URL / WORKFLOW_SERVICE_API_KEY not configured");
    const url = `${base}/internal/scripts/merges`;
    const res = await fetchWithRetry(url, { headers: { "x-api-key": apiKey } }, { timeoutMs: TIMEOUT_MS });
    if (res.status === 404) {
      console.error(`[features-service] ${url} 404: workflow-service serves no merges route yet, read as no merge`);
      return [];
    }
    if (!res.ok) throw new Error(`workflow-service ${url} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return parseScriptMerges(await res.json());
  })();
  heldMerges = { at: Date.now(), value };
  value.catch(() => {
    if (heldMerges?.value === value) heldMerges = null;
  });
  return value;
}

/** Test seam. */
export function __resetRunnableScriptsForTest(): void {
  held = null;
  lastGood = null;
  heldMerges = null;
}
