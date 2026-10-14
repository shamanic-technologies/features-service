/**
 * JEV JUDGES EVERY WORKFLOW VERSION AGAINST EVERY TACTIC, ONCE (owner 2026-10-13; `lib/plays.ts`).
 *
 * Population: every version (any status) of every workflow DYNASTY assigned to a pipe (`workflow_leg_assignments`,
 * any state): the workflows a play can run. A (version, tactic) already judged on the tactic's CURRENT description is
 * never asked again; a version is immutable, so its verdict moves only when the tactic's description is edited
 * (owner 2026-10-14): a verdict judged on an older text is re-asked and replaced in place, the old one serving until
 * then (a strategy never sees the workflow as unjudged mid-edit). The question is asked on what the workflow DOES (its DAG and description),
 * never on its name: a copy named "catch-all" that still sends to confirmed addresses only is judged "no".
 *
 * Asked through chat-service's PLATFORM twin (`/internal/platform-judgments`): no org request stands behind a sweep,
 * and chat-service declares the spend on a platform run. A `noul` answers the probability itself; verdict = p >= 0.5,
 * stored with p and the model release.
 *
 * Runs off the request path: ~60 s after boot, then every 15 min, single-flight; kicked again when a tactic is
 * declared or edited and when a workflow is registered on a pipe, so a new version is judged within minutes of its birth.
 * Each item has its own try/catch and timeout; one failure leaves only that (version, tactic) unjudged for the
 * next sweep. Fail LOUD in the log, never a default verdict. Every FULL sweep records, per tactic, how many versions it
 * covered, how many stand judged and how many Jev could not judge and why (`tactic_judging_sweeps`): the tactic serves it
 * as `judging` (owner 2026-10-14: Jev out of credits looked "pending" forever to a client's agent).
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { mapWithConcurrency } from "./concurrency.js";
import { listLegAssignments } from "./workflow-leg-assignments.js";
import { insertVerdict, invalidatePlayCatalogue, listVerdicts, loadPlayCatalogue, recordJudgingSweeps, refreshVersionActive } from "./plays-store.js";
import type { Tactic, TacticJudgingSweep } from "./plays.js";
import { fetchWorkflowDefinitions, type WorkflowDefinition } from "./workflow-definitions-client.js";

const JUDGE_CONCURRENCY = 4;
const JUDGE_TIMEOUT_MS = 60_000;
export const SWEEP_EVERY_MS = 15 * 60_000;
const FIRST_SWEEP_AFTER_MS = 60_000;
/** A DAG is sent whole up to this size (every cold email DAG today is under 13k characters). */
const MAX_DAG_CHARS = 60_000;
const QUESTION_KEY = "followsTactic";

export interface TacticJudgment {
  verdict: boolean;
  probability: number;
  model: string;
}

/** The yes/no question, built from the tactic's own description (the description is what Jev judges against). */
export function tacticQuestion(t: Pick<Tactic, "name" | "description">) {
  return {
    type: "noul" as const,
    instructions:
      `Does this workflow follow the tactic "${t.name}"? The tactic: ${t.description} ` +
      "Judge only on what the workflow actually does: its steps and the parameters each step sends. Ignore its name, its description's claims and any label.",
    criteria: {
      true: `A step of the workflow, as configured, does exactly what the tactic describes: ${t.description}`,
      false: "No step of the workflow does what the tactic describes, or the workflow does the opposite.",
    },
  };
}

/** PURE: the state Jev reads for one version. */
export function judgedState(w: WorkflowDefinition): Record<string, unknown> {
  const dag = JSON.stringify(w.dag);
  return {
    workflow: w.workflowSlug,
    description: w.description,
    definition: dag.length > MAX_DAG_CHARS ? `${dag.slice(0, MAX_DAG_CHARS)} [truncated]` : w.dag,
  };
}

export async function judgeTactic(t: Tactic, w: WorkflowDefinition): Promise<TacticJudgment> {
  const base = process.env.CHAT_SERVICE_URL;
  const apiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!base || !apiKey) throw new Error("[features-service] CHAT_SERVICE_URL / CHAT_SERVICE_API_KEY not configured");
  const res = await fetchWithRetry(`${base}/internal/platform-judgments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({ state: judgedState(w), questions: { [QUESTION_KEY]: tacticQuestion(t) } }),
  }, { timeoutMs: JUDGE_TIMEOUT_MS });
  if (!res.ok) throw new Error(`chat-service platform-judgments ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { model?: unknown; answers?: Record<string, { type?: unknown; noul?: unknown }> };
  const answer = body.answers?.[QUESTION_KEY];
  if (answer?.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) throw new Error("chat-service answered without a readable probability");
  if (typeof body.model !== "string" || body.model === "") throw new Error("chat-service answered without naming the model release");
  return { verdict: answer.noul >= 0.5, probability: answer.noul, model: body.model };
}

export interface SweepResult {
  versions: number;
  judged: number;
  failed: number;
  alreadyJudged: number;
}

/**
 * One sweep: every version of every feature that holds a pipe workflow (retired lineages included: a play's price is
 * picked among every measured workflow, so each one needs its verdict) x every tactic, judging what is not stored.
 * `onlyDynasties` narrows the sweep to those dynasties (a registration kick). Exported for tests and the staff kick route.
 */
export async function sweepTacticJudgments(deps: { judge?: typeof judgeTactic; definitions?: typeof fetchWorkflowDefinitions; record?: typeof recordJudgingSweeps; now?: () => Date } = {}, onlyDynasties: ReadonlySet<string> | null = null): Promise<SweepResult> {
  const judge = deps.judge ?? judgeTactic;
  const definitions = deps.definitions ?? fetchWorkflowDefinitions;
  const record = deps.record ?? recordJudgingSweeps;
  const startedAt = (deps.now ?? (() => new Date()))();
  const [assignments, catalogue, stored] = await Promise.all([listLegAssignments(), loadPlayCatalogue(), listVerdicts()]);
  const tactics = [...catalogue.tactics.values()];
  const result: SweepResult = { versions: 0, judged: 0, failed: 0, alreadyJudged: 0 };
  if (tactics.length === 0) return result;
  const dynastiesByFeature = new Map<string, Set<string>>();
  for (const a of assignments) {
    if (onlyDynasties && !onlyDynasties.has(a.workflowDynastySlug)) continue;
    const set = dynastiesByFeature.get(a.featureSlug) ?? new Set<string>();
    set.add(a.workflowDynastySlug);
    dynastiesByFeature.set(a.featureSlug, set);
  }
  // Judged on the tactic's CURRENT description; a verdict on an older text is re-judged (and replaced in place).
  const descriptionOf = new Map(tactics.map((t) => [t.id, t.description]));
  const done = new Set(stored.filter((v) => v.judgedDescription === descriptionOf.get(v.tacticId)).map((v) => `${v.workflowSlug}|${v.tacticId}`));
  const activeBySlug = new Map(stored.map((v) => [v.workflowSlug, v.versionActive]));
  const todo: Array<{ t: Tactic; w: WorkflowDefinition; featureSlug: string }> = [];
  // Per tactic: what this sweep saw (versions covered, judged, failed, the last reason Jev or a read gave).
  const perTactic = new Map(tactics.map((t) => [t.id, { versions: 0, judged: 0, failed: 0, lastFailure: null as string | null }]));
  const failOn = (tacticId: string, reason: string) => {
    const x = perTactic.get(tacticId)!;
    x.failed += 1;
    x.lastFailure = reason.slice(0, 300);
  };
  for (const [featureSlug, dynasties] of dynastiesByFeature) {
    let versions: WorkflowDefinition[];
    try {
      versions = (await definitions(featureSlug)).filter((w) => !onlyDynasties || dynasties.has(w.workflowDynastySlug));
    } catch (error) {
      console.error(`[features-service] tactic judgments: workflow definitions of ${featureSlug} unreadable, judged next sweep:`, error);
      result.failed += 1;
      for (const t of tactics) failOn(t.id, `the workflows of ${featureSlug} could not be read: ${(error as Error).message}`);
      continue;
    }
    for (const w of versions) {
      result.versions += 1;
      if (activeBySlug.has(w.workflowSlug) && activeBySlug.get(w.workflowSlug) !== w.versionActive) await refreshVersionActive(w.workflowSlug, w.versionActive);
      for (const t of tactics) {
        perTactic.get(t.id)!.versions += 1;
        if (done.has(`${w.workflowSlug}|${t.id}`)) {
          result.alreadyJudged += 1;
          perTactic.get(t.id)!.judged += 1;
        } else todo.push({ t, w, featureSlug });
      }
    }
  }
  await mapWithConcurrency(todo, JUDGE_CONCURRENCY, async ({ t, w, featureSlug }) => {
    try {
      const j = await judge(t, w);
      await insertVerdict({ workflowSlug: w.workflowSlug, tacticId: t.id, workflowDynastySlug: w.workflowDynastySlug, featureSlug, version: w.version, versionActive: w.versionActive, verdict: j.verdict, probability: j.probability, model: j.model, judgedDescription: t.description });
      result.judged += 1;
      perTactic.get(t.id)!.judged += 1;
    } catch (error) {
      result.failed += 1;
      failOn(t.id, (error as Error).message);
      console.error(`[features-service] tactic judgments: ${w.workflowSlug} x ${t.id} not judged (next sweep retries):`, (error as Error).message);
    }
  });
  // A FULL sweep states each tactic's judging; a kick narrowed to a few dynasties covers too little to.
  if (!onlyDynasties) {
    const sweptAt = startedAt.toISOString();
    const rows: TacticJudgingSweep[] = tactics.map((t) => {
      const x = perTactic.get(t.id)!;
      return { tacticId: t.id, judgedDescription: t.description, sweptAt, versions: x.versions, judged: x.judged, failed: x.failed, lastFailure: x.failed > 0 ? x.lastFailure : null, lastFailureAt: x.failed > 0 ? sweptAt : null };
    });
    try {
      await record(rows);
    } catch (error) {
      console.error("[features-service] tactic judgments: the sweep's per-tactic outcome could not be recorded:", error);
    }
  }
  invalidatePlayCatalogue();
  return result;
}

let inFlight: Promise<SweepResult> | null = null;
let pendingDynasties: Set<string> | null | undefined;

/** Single-flight sweep; a kick arriving during a sweep runs once more right after it (never lost, never doubled). */
export function kickTacticJudgments(onlyDynasties: ReadonlySet<string> | null = null): Promise<SweepResult> {
  if (inFlight) {
    pendingDynasties = pendingDynasties === undefined ? (onlyDynasties ? new Set(onlyDynasties) : null) : pendingDynasties === null || !onlyDynasties ? null : new Set([...pendingDynasties, ...onlyDynasties]);
    return inFlight;
  }
  inFlight = sweepTacticJudgments({}, onlyDynasties)
    .then((r) => {
      if (r.judged > 0 || r.failed > 0) console.log(`[features-service] tactic judgments: ${r.judged} judged, ${r.failed} failed, ${r.alreadyJudged} already judged over ${r.versions} versions`);
      return r;
    })
    .catch((error) => {
      console.error("[features-service] tactic judgments sweep failed:", error);
      return { versions: 0, judged: 0, failed: 1, alreadyJudged: 0 };
    })
    .finally(() => {
      inFlight = null;
      if (pendingDynasties !== undefined) {
        const next = pendingDynasties;
        pendingDynasties = undefined;
        void kickTacticJudgments(next);
      }
    });
  return inFlight;
}

/** Boot: first sweep ~60 s after listen, then every 15 min (in-process: a GitHub cron declares a cadence, it does not deliver one). */
export function startTacticJudgmentLoop(): void {
  const first = setTimeout(() => void kickTacticJudgments(), FIRST_SWEEP_AFTER_MS);
  first.unref?.();
  const every = setInterval(() => void kickTacticJudgments(), SWEEP_EVERY_MS);
  every.unref?.();
}
