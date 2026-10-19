/**
 * ONE LEG PER WORKFLOW: resolve the dynasties active on several legs (owner 2026-10-19, ONE-LEG-PER-WORKFLOW-1019:
 * « A workflow can only be at one leg at a time. »). The write guard (`lib/workflow-leg-assignments.ts`) refuses a NEW
 * second leg; this resolves the ones stated before the rule.
 *
 * Per dynasty active on 2+ legs:
 *   1. a leg with no PUBLISHED pipe (its channel no longer performs it, or staff hid it: Email Sending's retired
 *      "Email sent" leg) comes off first: no customer surface runs it, so there is no pipe to keep;
 *   2. among the legs left, the leg its template TYPE is built for is KEPT. Judged on the type only (owner rule
 *      2026-10-17): the content-generation template type(s) the workflow's latest version renders (a reply template =
 *      the positive reply leg, a click template = the website visit leg), else the workflow's own description when it
 *      renders no template. Jev picks (a `choice` among the legs, never a hand list); an unsure Jev (confidence below
 *      `MIN_CONFIDENCE`) moves nothing;
 *   3. every other leg comes off (deprecated there, history row decided by this task), EXCEPT where that would empty
 *      a pipe: the pipe must keep another active workflow, and a runnable one when it had one. Such a leg is KEPT and
 *      named (`would_empty_pipe`), so a live campaign or a public index on that pipe never loses its last workflow.
 *
 * `plan` is PURE (tests); `resolveOneLegPerWorkflow` reads, asks Jev, and writes only when `apply` is true.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { pipeLegKeyOf, servedLegKeyOf } from "./funnel-legs.js";
import { loadChannelCatalogue } from "./channel-declarations-store.js";
import { executableDynasties, fetchPublicWorkflows } from "./public-stats-clients.js";
import { fetchWorkflowDefinitions, type WorkflowDefinition } from "./workflow-definitions-client.js";
import { listLegAssignments, setLegAssignment, type LegAssignmentRow } from "./workflow-leg-assignments.js";

export const ONE_LEG_TASK = "ONE-LEG-PER-WORKFLOW-1019";
/** Below this Jev was hesitating between legs (chat-service: "decline to act on it"): nothing moves. */
export const MIN_CONFIDENCE = 0.6;
const JEV_TIMEOUT_MS = 60_000;

/** A leg as the channel performs it: its label for Jev, or null when the channel no longer performs it. */
export interface PerformedLeg {
  legKey: string;
  label: string;
}

export interface LegPick {
  legKey: string;
  confidence: number;
  model: string;
}

export interface DynastyResolution {
  featureSlug: string;
  workflowDynastySlug: string;
  /** What the pick was judged on: the template type(s), or the description when it renders none. */
  judgedOn: { templateTypes: string[]; description: string | null };
  /** Jev's pick, null when no pick was needed (one performed leg left) or Jev was unsure. */
  pick: LegPick | null;
  kept: Array<{ legKey: string; reason: "template_type" | "only_performed_leg" | "would_empty_pipe" | "jev_unsure" }>;
  removed: Array<{ legKey: string; reason: "leg_not_performed" | "template_type" }>;
}

/** PURE: the content-generation template types a DAG renders (workflow-service's own extraction rule). */
export function templateTypesOf(dag: unknown): string[] {
  const nodes = (dag as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out = new Set<string>();
  for (const n of nodes as Array<Record<string, any>>) {
    if (n?.type !== "http.call" || n?.config?.service !== "content-generation" || n?.config?.path !== "/generate") continue;
    const mapped = n.inputMapping?.["body.type"];
    const t = typeof mapped === "string" && !mapped.startsWith("$ref:") ? mapped : n.config?.body?.type;
    if (typeof t === "string" && t !== "") out.add(t);
  }
  return [...out].sort();
}

/** PURE: the version a dynasty is judged on: its active version, else its latest. */
export function judgedVersionOf(defs: readonly WorkflowDefinition[], dynasty: string): WorkflowDefinition | null {
  const own = defs.filter((d) => d.workflowDynastySlug === dynasty);
  if (own.length === 0) return null;
  return own.find((d) => d.versionActive) ?? own.reduce((a, b) => (b.version > a.version ? b : a));
}

/** The Jev question: which of these legs is this workflow's template built for. */
export function legQuestion(legs: readonly PerformedLeg[]) {
  return {
    type: "choice" as const,
    instructions:
      "A sales workflow writes its messages with the content template named in the state (or, when it names none, does what its description says). " +
      "Which leg (from one funnel step to the next) is this workflow BUILT to produce? Judge on the template type only: a template written to get a reply " +
      "belongs to the leg ending on a positive reply; a template written to get a click on a link belongs to the leg ending on a website visit; and so on for other steps. " +
      "Ignore the workflow's name and any claim about results.",
    criteria: Object.fromEntries(legs.map((l) => [l.legKey, `${l.label}: the workflow is built to move the person to this step.`])),
  };
}

async function askJev(state: Record<string, unknown>, legs: readonly PerformedLeg[]): Promise<LegPick> {
  const base = process.env.CHAT_SERVICE_URL;
  const apiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!base || !apiKey) throw new Error("[features-service] CHAT_SERVICE_URL / CHAT_SERVICE_API_KEY not configured");
  const res = await fetchWithRetry(
    `${base}/internal/platform-judgments`,
    { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": apiKey }, body: JSON.stringify({ state, questions: { leg: legQuestion(legs) } }) },
    { timeoutMs: JEV_TIMEOUT_MS },
  );
  if (!res.ok) throw new Error(`chat-service platform-judgments ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { model?: unknown; answers?: Record<string, { type?: unknown; choice?: unknown; confidence?: unknown }> };
  const a = body.answers?.leg;
  if (a?.type !== "choice" || typeof a.choice !== "string" || typeof a.confidence !== "number") throw new Error("chat-service answered without a readable choice");
  if (!legs.some((l) => l.legKey === a.choice)) throw new Error(`chat-service picked ${a.choice}, not one of the legs offered`);
  return { legKey: a.choice, confidence: a.confidence, model: typeof body.model === "string" ? body.model : "unknown" };
}

export interface PlanInput {
  /** Every ACTIVE assignment. */
  active: readonly LegAssignmentRow[];
  /** `(featureSlug, stored legKey)` → the leg as its channel performs it, null when it no longer does. */
  performed: (featureSlug: string, legKey: string) => PerformedLeg | null;
  /** Dynasties workflow-service can run. */
  runnable: ReadonlySet<string>;
  /** The kept leg per dynasty (Jev), asked only for dynasties with 2+ performed legs. */
  picks: ReadonlyMap<string, LegPick | null>;
  judgedOn: ReadonlyMap<string, DynastyResolution["judgedOn"]>;
}

/** PURE: the resolution of every dynasty active on 2+ legs, applied in order so each one sees the pipes as left by the previous. */
export function plan(input: PlanInput): DynastyResolution[] {
  const pipeKey = (r: { featureSlug: string; legKey: string }) => `${r.featureSlug}|${r.legKey}`;
  const onPipe = new Map<string, Set<string>>();
  for (const r of input.active) {
    const set = onPipe.get(pipeKey(r)) ?? new Set<string>();
    set.add(r.workflowDynastySlug);
    onPipe.set(pipeKey(r), set);
  }
  const byDynasty = new Map<string, LegAssignmentRow[]>();
  for (const r of input.active) byDynasty.set(r.workflowDynastySlug, [...(byDynasty.get(r.workflowDynastySlug) ?? []), r]);
  const out: DynastyResolution[] = [];
  for (const [dynasty, rows] of [...byDynasty].sort(([a], [b]) => a.localeCompare(b))) {
    if (rows.length < 2) continue;
    const res: DynastyResolution = {
      featureSlug: rows[0].featureSlug,
      workflowDynastySlug: dynasty,
      judgedOn: input.judgedOn.get(dynasty) ?? { templateTypes: [], description: null },
      pick: null,
      kept: [],
      removed: [],
    };
    // Coming off a pipe must leave it another active workflow, and a runnable one when it had one.
    const canLeave = (r: LegAssignmentRow): boolean => {
      const others = [...(onPipe.get(pipeKey(r)) ?? [])].filter((d) => d !== dynasty);
      if (others.length === 0) return false;
      return !input.runnable.has(dynasty) || others.some((d) => input.runnable.has(d));
    };
    const leave = (r: LegAssignmentRow, reason: DynastyResolution["removed"][number]["reason"]) => {
      onPipe.get(pipeKey(r))!.delete(dynasty);
      res.removed.push({ legKey: r.legKey, reason });
    };
    const performedRows: LegAssignmentRow[] = [];
    for (const r of rows) {
      if (input.performed(r.featureSlug, r.legKey) === null) leave(r, "leg_not_performed");
      else performedRows.push(r);
    }
    if (performedRows.length === 1) res.kept.push({ legKey: performedRows[0].legKey, reason: "only_performed_leg" });
    else if (performedRows.length > 1) {
      const pick = input.picks.get(dynasty) ?? null;
      if (!pick || pick.confidence < MIN_CONFIDENCE || !performedRows.some((r) => r.legKey === pick.legKey)) {
        res.pick = pick;
        for (const r of performedRows) res.kept.push({ legKey: r.legKey, reason: "jev_unsure" });
      } else {
        res.pick = pick;
        for (const r of performedRows) {
          if (r.legKey === pick.legKey) res.kept.push({ legKey: r.legKey, reason: "template_type" });
          else if (canLeave(r)) leave(r, "template_type");
          else res.kept.push({ legKey: r.legKey, reason: "would_empty_pipe" });
        }
      }
    }
    out.push(res);
  }
  return out;
}

/**
 * Read every active assignment, the channel catalogue, the runnable dynasties and each multi-leg dynasty's latest
 * version, ask Jev, plan, and (when `apply`) deprecate the removed legs with a history row decided by `decidedBy`.
 */
export async function resolveOneLegPerWorkflow(opts: { apply: boolean; decidedBy: string }, deps: { ask?: typeof askJev } = {}): Promise<{ applied: boolean; resolutions: DynastyResolution[] }> {
  const ask = deps.ask ?? askJev;
  const active = (await listLegAssignments()).filter((r) => r.state === "active");
  const count = new Map<string, number>();
  for (const r of active) count.set(r.workflowDynastySlug, (count.get(r.workflowDynastySlug) ?? 0) + 1);
  const multi = active.filter((r) => (count.get(r.workflowDynastySlug) ?? 0) > 1);
  if (multi.length === 0) return { applied: opts.apply, resolutions: [] };

  const cat = await loadChannelCatalogue({ publishedOnly: true });
  const performed = (featureSlug: string, legKey: string): PerformedLeg | null => {
    const ch = cat.channels.find((c) => c.slug === featureSlug);
    const computed = pipeLegKeyOf(featureSlug, legKey);
    const t = ch?.stepTransitions.find((x) => x.legKey === legKey) ?? ch?.stepTransitions.find((x) => x.legKey === computed);
    if (!t) return null;
    const from = servedLegKeyOf(featureSlug, t.legKey) !== t.legKey ? "Lead found" : (t.from?.label ?? "Start");
    return { legKey, label: `${from} -> ${t.to.label}` };
  };
  const features = [...new Set(active.map((r) => r.featureSlug))];
  const [workflows, defsByFeature] = await Promise.all([
    fetchPublicWorkflows(features.join(","), "all", true),
    Promise.all([...new Set(multi.map((r) => r.featureSlug))].map(async (f) => [f, await fetchWorkflowDefinitions(f)] as const)),
  ]);
  const runnable = executableDynasties(workflows);
  const defs = new Map(defsByFeature);

  const judgedOn = new Map<string, DynastyResolution["judgedOn"]>();
  const picks = new Map<string, LegPick | null>();
  for (const dynasty of [...new Set(multi.map((r) => r.workflowDynastySlug))].sort()) {
    const rows = multi.filter((r) => r.workflowDynastySlug === dynasty);
    const legs = rows.map((r) => performed(r.featureSlug, r.legKey)).filter((l): l is PerformedLeg => l !== null);
    const version = judgedVersionOf(defs.get(rows[0].featureSlug) ?? [], dynasty);
    const templateTypes = version ? templateTypesOf(version.dag) : [];
    const on = { templateTypes, description: templateTypes.length > 0 ? null : (version?.description ?? null) };
    judgedOn.set(dynasty, on);
    if (legs.length < 2) continue;
    if (!version) {
      console.error(`[features-service] one-leg: workflow-service describes no version of ${dynasty}: nothing moves on it`);
      picks.set(dynasty, null);
      continue;
    }
    const state = templateTypes.length > 0 ? { templateTypes } : { description: on.description ?? "(no description)" };
    picks.set(dynasty, await ask(state, legs));
  }

  const resolutions = plan({ active, performed, runnable, picks, judgedOn });
  if (opts.apply) {
    for (const r of resolutions) {
      for (const leg of r.removed) {
        const why =
          leg.reason === "leg_not_performed"
            ? "its channel no longer performs this leg"
            : `its template type (${r.judgedOn.templateTypes.join(", ") || "its description"}) is built for ${r.pick!.legKey} (Jev, confidence ${r.pick!.confidence.toFixed(2)})`;
        await setLegAssignment({
          featureSlug: r.featureSlug,
          legKey: leg.legKey,
          workflowDynastySlug: r.workflowDynastySlug,
          state: "deprecated",
          decidedBy: opts.decidedBy,
          note: `${ONE_LEG_TASK}: a workflow runs on one leg at a time (owner 2026-10-19); off this leg because ${why}`,
        });
      }
    }
  }
  return { applied: opts.apply, resolutions };
}
