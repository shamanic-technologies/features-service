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
import { insertVerdict, insertWriterVerdict, invalidatePlayCatalogue, listVerdicts, listWriterVerdicts, loadPlayCatalogue, recordJudgingSweeps, refreshVersionActive } from "./plays-store.js";
import { readTemplateDynasties, readTemplateTexts } from "./writer-catalogue-client.js";
import { readLlmDynasties } from "./llm-dynasties.js";
import { subjectOfTactic, type Tactic, type TacticJudgingSweep } from "./plays.js";
import { fetchWorkflowDefinitions, type WorkflowDefinition } from "./workflow-definitions-client.js";
import { TACTIC_JUDGMENT_SUPPORT } from "./platform-caller.js";

const JUDGE_CONCURRENCY = 4;
const JUDGE_TIMEOUT_MS = 60_000;
export const SWEEP_EVERY_MS = 15 * 60_000;
const FIRST_SWEEP_AFTER_MS = 60_000;
/**
 * A DAG up to this size is sent whole, in one question (every verdict judged before 2026-10-14 was asked this way).
 * Jev's budget is 32k tokens for the state (chat-service `/internal/platform-judgments`), ~60,000 characters of DAG.
 */
const MAX_DAG_CHARS = 60_000;
/**
 * How Jev reads a workflow, stored with every verdict. A bigger DAG used to be CUT at 60,000 characters, so a step past
 * the cut was never seen (ai-meeting-booking-torcular-v4 attaches the offer's document at char ~79,000 of 103,000 and
 * was judged "no"). It is now read whole, in parts: a verdict on a cut DAG is re-judged by the sweep.
 */
export const JUDGE_RULE = "whole-in-parts";
const QUESTION_KEY = "followsTactic";

export interface TacticJudgment {
  verdict: boolean;
  probability: number;
  model: string;
}

/** The yes/no question, built from the tactic's own description (the description is what Jev judges against). */
export function tacticQuestion(t: Pick<Tactic, "name" | "description">, part: { index: number; count: number } | null = null) {
  const partNote =
    part && part.count > 1
      ? ` The workflow is too long to read at once: you see part ${part.index} of ${part.count} of its steps, with the list of every step and how they connect. Answer yes when a step shown in full in this part does what the tactic describes; a step of another part is judged with that part.`
      : "";
  return {
    type: "noul" as const,
    instructions:
      `Does this workflow follow the tactic "${t.name}"? The tactic: ${t.description} ` +
      "Judge only on what the workflow actually does: its steps and the parameters each step sends. Ignore its name, its description's claims and any label." +
      partNote,
    criteria: {
      true: `A step of the workflow, as configured, does exactly what the tactic describes: ${t.description}`,
      false: part && part.count > 1 ? "No step shown in full in this part does what the tactic describes, or it does the opposite." : "No step of the workflow does what the tactic describes, or the workflow does the opposite.",
    },
  };
}

interface DagNode {
  id?: unknown;
  type?: unknown;
  config?: { service?: unknown; method?: unknown; path?: unknown };
}

/** PURE: one line per step (id, type, and the call it makes), so a part keeps the shape of the whole workflow. */
function stepList(nodes: readonly DagNode[]): string[] {
  return nodes.map((n) => {
    const c = n.config ?? {};
    const call = typeof c.service === "string" ? ` ${String(c.method ?? "")} ${c.service}${String(c.path ?? "")}` : "";
    return `${String(n.id)} (${String(n.type)}${call})`;
  });
}

/**
 * PURE: what Jev reads for one version, in as many parts as its DAG needs. A DAG up to `MAX_DAG_CHARS` is ONE part,
 * byte for byte the state every earlier verdict was judged on. A bigger one is split on WHOLE steps (a step is never
 * cut unless it alone exceeds a part, then it is marked `[truncated]`), each part carrying the full step list and the
 * edges so Jev sees where the shown steps sit. Never a cut that drops steps.
 */
export function judgedParts(w: WorkflowDefinition, maxChars = MAX_DAG_CHARS): Array<Record<string, unknown>> {
  const dag = JSON.stringify(w.dag);
  if (dag.length <= maxChars) return [{ workflow: w.workflowSlug, description: w.description, definition: w.dag }];
  const d = w.dag as { nodes?: unknown; edges?: unknown };
  if (!d || !Array.isArray(d.nodes)) {
    const parts: Array<Record<string, unknown>> = [];
    for (let i = 0; i < dag.length; i += maxChars) parts.push({ workflow: w.workflowSlug, description: w.description, definitionText: dag.slice(i, i + maxChars) });
    return parts.map((p, i) => ({ ...p, part: `${i + 1} of ${parts.length}` }));
  }
  const nodes = d.nodes as DagNode[];
  const steps = stepList(nodes);
  const edges = Array.isArray(d.edges) ? (d.edges as Array<{ from?: unknown; to?: unknown }>).map((e) => `${String(e.from)} -> ${String(e.to)}`) : [];
  const budget = Math.max(10_000, maxChars - JSON.stringify(steps).length - JSON.stringify(edges).length);
  const groups: unknown[][] = [];
  let current: unknown[] = [];
  let size = 0;
  for (const n of nodes) {
    let item: unknown = n;
    let len = JSON.stringify(n).length;
    if (len > budget) {
      item = { id: n.id, type: n.type, truncated: `${JSON.stringify(n).slice(0, budget - 200)} [truncated]` };
      len = budget;
    }
    if (current.length > 0 && size + len > budget) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += len;
  }
  if (current.length > 0) groups.push(current);
  return groups.map((g, i) => ({ workflow: w.workflowSlug, description: w.description, part: `${i + 1} of ${groups.length}`, everyStep: steps, edges, stepsInThisPart: g }));
}

/** PURE (kept for callers reading one state): the first part. */
export const judgedState = (w: WorkflowDefinition): Record<string, unknown> => judgedParts(w)[0];

async function askOne(state: Record<string, unknown>, question: ReturnType<typeof tacticQuestion>): Promise<{ probability: number; model: string }> {
  const base = process.env.CHAT_SERVICE_URL;
  const apiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!base || !apiKey) throw new Error("[features-service] CHAT_SERVICE_URL / CHAT_SERVICE_API_KEY not configured");
  const res = await fetchWithRetry(`${base}/internal/platform-judgments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({ state, questions: { [QUESTION_KEY]: question }, support: TACTIC_JUDGMENT_SUPPORT }),
  }, { timeoutMs: JUDGE_TIMEOUT_MS });
  if (!res.ok) throw new Error(`chat-service platform-judgments ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { model?: unknown; answers?: Record<string, { type?: unknown; noul?: unknown }> };
  const answer = body.answers?.[QUESTION_KEY];
  if (answer?.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) throw new Error("chat-service answered without a readable probability");
  if (typeof body.model !== "string" || body.model === "") throw new Error("chat-service answered without naming the model release");
  return { probability: answer.noul, model: body.model };
}

/**
 * Jev's verdict on the WHOLE workflow: one question per part (`judgedParts`); the workflow follows the tactic when ONE
 * part shows a step doing it, so p = the highest part's. Any part failing fails the judgment (never a verdict on part
 * of the workflow).
 */
export async function judgeTactic(t: Tactic, w: WorkflowDefinition, ask: typeof askOne = askOne): Promise<TacticJudgment> {
  const parts = judgedParts(w);
  let best: { probability: number; model: string } | null = null;
  for (const [i, state] of parts.entries()) {
    const a = await ask(state, tacticQuestion(t, { index: i + 1, count: parts.length }));
    if (!best || a.probability > best.probability) best = a;
  }
  return { verdict: best!.probability >= 0.5, probability: best!.probability, model: best!.model };
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
  // Workflow tactics only: a template / LLM tactic is judged by `sweepWriterTacticJudgments` (BEST-TPL-LLM-1022).
  const tactics = [...catalogue.tactics.values()].filter((t) => subjectOfTactic(t) === "workflow");
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
  // A verdict on a DAG read cut short (an older judge rule) is re-judged too; a DAG that fits in one part was read whole.
  const storedOn = new Map(stored.filter((v) => v.judgedDescription === descriptionOf.get(v.tacticId)).map((v) => [`${v.workflowSlug}|${v.tacticId}`, v.judgeRule]));
  const isDone = (w: WorkflowDefinition, tacticId: string): boolean => {
    const key = `${w.workflowSlug}|${tacticId}`;
    return storedOn.has(key) && (storedOn.get(key) === JUDGE_RULE || JSON.stringify(w.dag).length <= MAX_DAG_CHARS);
  };
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
        if (isDone(w, t.id)) {
          result.alreadyJudged += 1;
          perTactic.get(t.id)!.judged += 1;
        } else todo.push({ t, w, featureSlug });
      }
    }
  }
  await mapWithConcurrency(todo, JUDGE_CONCURRENCY, async ({ t, w, featureSlug }) => {
    try {
      const j = await judge(t, w);
      await insertVerdict({ workflowSlug: w.workflowSlug, tacticId: t.id, workflowDynastySlug: w.workflowDynastySlug, featureSlug, version: w.version, versionActive: w.versionActive, verdict: j.verdict, probability: j.probability, model: j.model, judgedDescription: t.description, judgeRule: JUDGE_RULE });
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

/** One template dynasty or LLM dynasty Jev judges a writer tactic on (BEST-TPL-LLM-1022, LLM-DYNASTY-1022-FS). */
export interface WriterSubject {
  kind: "template" | "llm";
  key: string;
  /** What the verdict was judged on: the template dynasty's head template, the LLM dynasty's head model. A move re-judges it. */
  version: string;
  state: Record<string, unknown>;
}

/** The yes/no question on a template dynasty or an LLM, from the tactic's own description. */
export function writerTacticQuestion(t: Pick<Tactic, "name" | "description">, kind: "template" | "llm") {
  const what = kind === "template" ? "email template (the prompt our writer model follows)" : "language model line (the LLM dynasty that writes our messages, run on its newest version)";
  return {
    type: "noul" as const,
    instructions:
      `Does this ${what} follow the tactic "${t.name}"? The tactic: ${t.description} ` +
      (kind === "template"
        ? "Judge on what the template's text asks the writer to do, and on its type (headTemplate) when the tactic names template types. Ignore its display name."
        : "Judge only on which model line it is (its head model and its versions), who makes it and its tier."),
    criteria: {
      true: `The ${kind === "template" ? "template" : "model"} does exactly what the tactic describes: ${t.description}`,
      false: `The ${kind === "template" ? "template" : "model"} does not do what the tactic describes, or does the opposite.`,
    },
  };
}

/**
 * Every template dynasty of every pipe holding a workflow (content-generation's dynasties, judged on their HEAD's text)
 * and every chat-service LLM dynasty (judged on its HEAD model). A pipe whose dynasties cannot
 * be read is skipped this sweep (logged, its tactics state the failure).
 */
export async function readWriterSubjects(): Promise<{ subjects: WriterSubject[]; failures: string[] }> {
  const failures: string[] = [];
  const assignments = await listLegAssignments();
  const pipes = [...new Map(assignments.map((a) => [`${a.featureSlug}|${a.legKey}`, a])).values()];
  const byDynasty = new Map<string, { slug: string; name: string; description: string; head: string | null }>();
  for (const a of pipes) {
    const read = await readTemplateDynasties(a.featureSlug, a.legKey);
    if (typeof read === "string") {
      failures.push(`the template dynasties of ${a.featureSlug}|${a.legKey} could not be read`);
      continue;
    }
    for (const d of read) if (!byDynasty.has(d.slug)) byDynasty.set(d.slug, { slug: d.slug, name: d.name, description: d.description, head: d.head });
  }
  const heads = [...byDynasty.values()].map((d) => d.head).filter((h): h is string => Boolean(h));
  const texts = await readTemplateTexts(heads).catch((error) => {
    failures.push(`template texts unreadable: ${(error as Error).message}`);
    return new Map<string, string>();
  });
  const subjects: WriterSubject[] = [];
  for (const d of byDynasty.values()) {
    const text = d.head ? texts.get(d.head) : undefined;
    if (!d.head || !text) continue; // judged once its head's text is readable
    subjects.push({ kind: "template", key: d.slug, version: d.head, state: { templateDynasty: d.slug, name: d.name, description: d.description, headTemplate: d.head, prompt: text } });
  }
  // An LLM tactic judges a chat-service LLM DYNASTY on its HEAD model (LLM-DYNASTY-1022-FS; the template rule): key = the
  // dynasty slug, version = the head's id, so a new head re-judges it.
  try {
    for (const d of await readLlmDynasties()) {
      const head = d.models.find((m) => m.modelId === d.headModelId);
      subjects.push({
        kind: "llm",
        key: d.slug,
        version: d.headModelId,
        state: { llmDynasty: d.slug, name: d.name, provider: d.provider, capabilityTier: d.capabilityTier, headModel: head?.displayName ?? d.headModelId, headModelId: d.headModelId, versions: d.models.map((m) => m.displayName) },
      });
    }
  } catch (error) {
    failures.push(`the LLM dynasties could not be read: ${(error as Error).message}`);
  }
  return { subjects, failures };
}

async function judgeWriter(t: Tactic, subject: WriterSubject, ask: typeof askOne = askOne): Promise<TacticJudgment> {
  const a = await ask(subject.state, writerTacticQuestion(t, subject.kind));
  return { verdict: a.probability >= 0.5, probability: a.probability, model: a.model };
}

/**
 * One sweep of the TEMPLATE and LLM tactics (BEST-TPL-LLM-1022): every (subject of the tactic's kind, tactic) not
 * judged on the tactic's current description and the subject's current version is asked; the old verdict serves until
 * the new one lands. Records each tactic's judging like the workflow sweep (versions = subjects covered).
 */
export async function sweepWriterTacticJudgments(deps: { judge?: typeof judgeWriter; subjects?: typeof readWriterSubjects; record?: typeof recordJudgingSweeps; now?: () => Date } = {}): Promise<SweepResult> {
  const judge = deps.judge ?? judgeWriter;
  const startedAt = (deps.now ?? (() => new Date()))();
  const catalogue = await loadPlayCatalogue();
  const tactics = [...catalogue.tactics.values()].filter((t) => subjectOfTactic(t) !== "workflow");
  const result: SweepResult = { versions: 0, judged: 0, failed: 0, alreadyJudged: 0 };
  if (tactics.length === 0) return result;
  const [{ subjects, failures }, stored] = await Promise.all([(deps.subjects ?? readWriterSubjects)(), listWriterVerdicts()]);
  const done = new Set(stored.map((v) => `${v.subjectKind}|${v.subjectKey}|${v.tacticId}|${v.subjectVersion}|${v.judgedDescription}`));
  const perTactic = new Map(tactics.map((t) => [t.id, { versions: 0, judged: 0, failed: failures.length, lastFailure: failures[0] ?? null }]));
  const todo: Array<{ t: Tactic; subject: WriterSubject }> = [];
  for (const t of tactics) {
    for (const subject of subjects.filter((x) => x.kind === subjectOfTactic(t))) {
      result.versions += 1;
      perTactic.get(t.id)!.versions += 1;
      if (done.has(`${subject.kind}|${subject.key}|${t.id}|${subject.version}|${t.description}`)) {
        result.alreadyJudged += 1;
        perTactic.get(t.id)!.judged += 1;
      } else todo.push({ t, subject });
    }
  }
  await mapWithConcurrency(todo, JUDGE_CONCURRENCY, async ({ t, subject }) => {
    try {
      const j = await judge(t, subject);
      await insertWriterVerdict({ subjectKind: subject.kind, subjectKey: subject.key, tacticId: t.id, subjectVersion: subject.version, verdict: j.verdict, probability: j.probability, model: j.model, judgedDescription: t.description });
      result.judged += 1;
      perTactic.get(t.id)!.judged += 1;
    } catch (error) {
      result.failed += 1;
      const x = perTactic.get(t.id)!;
      x.failed += 1;
      x.lastFailure = (error as Error).message.slice(0, 300);
      console.error(`[features-service] writer tactic judgments: ${subject.kind} ${subject.key} x ${t.id} not judged (next sweep retries):`, (error as Error).message);
    }
  });
  const sweptAt = startedAt.toISOString();
  try {
    await (deps.record ?? recordJudgingSweeps)(
      tactics.map((t) => {
        const x = perTactic.get(t.id)!;
        return { tacticId: t.id, judgedDescription: t.description, sweptAt, versions: x.versions, judged: x.judged, failed: x.failed, lastFailure: x.failed > 0 ? x.lastFailure : null, lastFailureAt: x.failed > 0 ? sweptAt : null };
      }),
    );
  } catch (error) {
    console.error("[features-service] writer tactic judgments: the sweep's per-tactic outcome could not be recorded:", error);
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
    .then(async (r) => {
      // The template and LLM tactics ride the same single flight (a registration kick narrows only the workflows).
      if (!onlyDynasties) {
        const w = await sweepWriterTacticJudgments().catch((error) => {
          console.error("[features-service] writer tactic judgments sweep failed:", error);
          return { versions: 0, judged: 0, failed: 1, alreadyJudged: 0 };
        });
        if (w.judged > 0 || w.failed > 0) console.log(`[features-service] writer tactic judgments: ${w.judged} judged, ${w.failed} failed, ${w.alreadyJudged} already judged over ${w.versions} subjects`);
      }
      return r;
    })
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
