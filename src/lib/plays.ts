/**
 * TACTICS, STRATEGIES AND PLAYS (owner 2026-10-13). PURE: the IO lives in `plays-store.ts`, the Jev sweep in
 * `tactic-judgments.ts`.
 *
 * - A TACTIC is a yes/no tag on a workflow VERSION ("Catch-all"). Jev judges every version against every tactic ONCE
 *   per description, and the answer is stored (`workflow_tactic_verdicts`). Editing a description re-judges every
 *   version in place; the old verdict serves until the new one lands.
 * - A STRATEGY is a boolean combination of tactics: the tactics it REQUIRES and the ones it EXCLUDES ("Valid only"
 *   excludes Catch-all; "Valid + Catch-all" requires it).
 * - A PLAY is a pipe x a strategy, catalogued per pipe (`plays`), never invented per campaign, so a play's ROI
 *   compares across clients. A pipe's DEFAULT play is what a campaign runs when its sales funnel names no strategy:
 *   exactly what the pipe ran before plays existed.
 *
 * Inside a play the platform still picks the workflow by ROI (the leg ladder), only among the workflows the strategy
 * allows. ROI stays measured per workflow, fleet-wide; a play's figure is its best allowed workflow's.
 *
 * IDS. A play id is `<pipe id>~<strategy id>`; a funnel id names a non-default play on its leg as
 * `<leg>@<channel slug>~<strategy id>` (`~` is unreserved in a URL, so an id never loses its suffix to an unencoded
 * `#` or `+`). The default play is the bare pipe id / bare `@<slug>`: every funnel id minted before plays still names
 * the same funnel. A play id naming the pipe's default strategy resolves to the bare pipe.
 *
 * Not the dashboard's "Strategy page" (audience/workflow ranking): a different word for a different thing.
 */

export const PLAY_SEPARATOR = "~";

export interface Tactic {
  id: string;
  name: string;
  description: string;
  createdBy: string;
  createdAt: string;
  /** Who last edited the description, and when; null = never edited. */
  updatedBy?: string | null;
  updatedAt?: string | null;
  /** The plain line a client reads (never the judged description); null = not shown to clients. */
  clientLine?: string | null;
}

export interface Strategy {
  id: string;
  name: string;
  description: string;
  requiresTacticIds: string[];
  excludesTacticIds: string[];
  createdBy: string;
  createdAt: string;
  /** Who last edited the rule or the description, and when; null = never edited. */
  updatedBy?: string | null;
  updatedAt?: string | null;
}

export interface PlayRecord {
  pipeId: string;
  strategyId: string;
  isDefault: boolean;
  /** PLAY-RETIRE-1022: taken off the pipe by staff (absent = live). A retired play is in no `playsByPipe` list. */
  retired?: boolean;
}

/** One stored Jev verdict on one workflow VERSION. */
export interface TacticVerdictRow {
  workflowSlug: string;
  tacticId: string;
  workflowDynastySlug: string;
  version: number;
  versionActive: boolean;
  verdict: boolean;
  probability: number;
  model: string;
  judgedAt: string;
}

/** PURE: a play id split into its pipe id and its strategy (null = the bare pipe, its default play). */
export function splitPlayId(id: string): { pipeId: string; strategyId: string | null } {
  const at = id.lastIndexOf(PLAY_SEPARATOR);
  if (at < 0) return { pipeId: id, strategyId: null };
  return { pipeId: id.slice(0, at), strategyId: id.slice(at + 1) || null };
}

export const playIdOf = (pipeId: string, strategyId: string | null): string => (strategyId ? `${pipeId}${PLAY_SEPARATOR}${strategyId}` : pipeId);

/** PURE: a channel slug part of a funnel id (`<slug>` or `<slug>~<strategy>`) split. */
export function splitPlaySlug(part: string): { slug: string; strategyId: string | null } {
  const at = part.indexOf(PLAY_SEPARATOR);
  return at < 0 ? { slug: part, strategyId: null } : { slug: part.slice(0, at), strategyId: part.slice(at + 1) || null };
}

/** PURE: the stable id of a tactic / strategy from its name ("Valid + Catch-all" -> `valid-catch-all`). */
export function idOfName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * PURE: which strategy a funnel names on one (channel, leg), read off its id (`<leg>@<slug>~<strategy>`), or null when
 * the segment is bare (the pipe's default play) or the funnel does not walk that pipe. `sameLeg` compares two leg
 * spellings (an outbound entry leg is stored `start_to_*`, served `lead_found_to_*`).
 */
export function strategyOfFunnelLeg(funnelId: string, channelSlug: string, legKey: string, sameLeg: (a: string, b: string) => boolean): string | null {
  for (const part of funnelId.split("+")) {
    const at = part.indexOf("@");
    if (at < 0) continue;
    const { slug, strategyId } = splitPlaySlug(part.slice(at + 1));
    if (slug === channelSlug && sameLeg(part.slice(0, at), legKey)) return strategyId;
  }
  return null;
}

/**
 * PURE: the tactics a DYNASTY carries, read on its CURRENT version (the active one, highest number; else the highest):
 * the version a run would execute. A tactic not judged on that version is absent from its map.
 */
export function currentTacticsByDynasty(rows: readonly TacticVerdictRow[]): Map<string, Map<string, boolean>> {
  const current = new Map<string, { slug: string; version: number; active: boolean }>();
  for (const r of rows) {
    const c = current.get(r.workflowDynastySlug);
    const better = !c || (r.versionActive && !c.active) || (r.versionActive === c.active && r.version > c.version);
    if (better) current.set(r.workflowDynastySlug, { slug: r.workflowSlug, version: r.version, active: r.versionActive });
  }
  const out = new Map<string, Map<string, boolean>>();
  for (const r of rows) {
    if (current.get(r.workflowDynastySlug)?.slug !== r.workflowSlug) continue;
    const m = out.get(r.workflowDynastySlug) ?? new Map<string, boolean>();
    m.set(r.tacticId, r.verdict);
    out.set(r.workflowDynastySlug, m);
  }
  return out;
}

/** The last FULL Jev sweep of one tactic (`tactic_judging_sweeps`, written by `lib/tactic-judgments.ts`). */
export interface TacticJudgingSweep {
  tacticId: string;
  judgedDescription: string;
  sweptAt: string;
  /** Workflow versions the sweep covered. */
  versions: number;
  /** Versions standing judged on `judgedDescription` once the sweep ended (judged before or by it). */
  judged: number;
  /** Versions Jev could not judge in that sweep (retried by the next one). */
  failed: number;
  lastFailure: string | null;
  lastFailureAt: string | null;
}

/**
 * A tactic's judging as an agent reads it (owner 2026-10-14: a judge failing for hours looked "pending" forever):
 * - `judging`: no full sweep has run on the tactic's CURRENT description yet (just created or edited): Jev is on it.
 * - `failing`: the last sweep could not judge `versionsFailed` versions (`lastFailure` says why). Nothing to do: every
 *   sweep retries them, so judging resumes by itself once Jev answers again (`nextSweepAt`).
 * - `complete`: every version the last sweep covered stands judged.
 */
export type TacticJudgingStatus = "judging" | "failing" | "complete";

export interface TacticJudging {
  status: TacticJudgingStatus;
  versions: number | null;
  versionsJudged: number | null;
  versionsFailed: number | null;
  lastSweepAt: string | null;
  /** When the next sweep is due (the loop runs every `sweepEveryMs`; a deploy restarts it a minute after boot). */
  nextSweepAt: string | null;
  lastFailure: string | null;
  lastFailureAt: string | null;
  /** One plain sentence an agent can relay. */
  detail: string;
}

/** PURE: the served judging state of one tactic from its last full sweep (null = never swept). */
export function tacticJudgingOf(t: Pick<Tactic, "name" | "description">, sweep: TacticJudgingSweep | null | undefined, sweepEveryMs: number): TacticJudging {
  if (!sweep || sweep.judgedDescription !== t.description) {
    return {
      status: "judging",
      versions: null,
      versionsJudged: null,
      versionsFailed: null,
      lastSweepAt: sweep?.sweptAt ?? null,
      nextSweepAt: null,
      lastFailure: null,
      lastFailureAt: null,
      detail: `Jev is judging every workflow version on the tactic "${t.name}" as it reads now; this takes a few minutes.`,
    };
  }
  const nextSweepAt = new Date(Date.parse(sweep.sweptAt) + sweepEveryMs).toISOString();
  const base = { versions: sweep.versions, versionsJudged: sweep.judged, versionsFailed: sweep.failed, lastSweepAt: sweep.sweptAt, nextSweepAt, lastFailure: sweep.lastFailure, lastFailureAt: sweep.lastFailureAt };
  if (sweep.failed > 0) {
    return {
      status: "failing",
      ...base,
      detail:
        `Jev could not judge ${sweep.failed} of ${sweep.versions} workflow versions on the tactic "${t.name}" at the last sweep (${sweep.lastFailure ?? "no reason recorded"}). ` +
        `Every sweep retries them by itself (next one due ${nextSweepAt}); until then a strategy naming this tactic allows none of the workflows still unjudged.`,
    };
  }
  return { status: "complete", ...base, detail: `Every one of the ${sweep.versions} workflow versions stands judged on the tactic "${t.name}".` };
}

/**
 * Why a play allows no ACTIVE workflow of its pipe (so nothing may run it), in a reason an agent can act on:
 * - `judging_failing` / `judging_pending`: some active workflow is not judged yet on a tactic the strategy names (a
 *   workflow never judged is never allowed), and that tactic's judging is failing / still running: the play may become
 *   runnable by itself once Jev answers.
 * - `no_workflow_follows_strategy`: every active workflow is judged and none fits the strategy: a workflow following
 *   it must be built (or the strategy changed).
 * Null when at least one active workflow is allowed, or the pipe holds no active workflow at all.
 */
export interface PlayBlock {
  reason: "judging_failing" | "judging_pending" | "no_workflow_follows_strategy";
  detail: string;
}

export function playBlockOf(strategy: Strategy, activeDynasties: readonly string[], tacticsByDynasty: ReadonlyMap<string, ReadonlyMap<string, boolean>>, judgingOf: (tacticId: string) => TacticJudging | null, nameOf: (tacticId: string) => string): PlayBlock | null {
  if (activeDynasties.length === 0) return null;
  if (activeDynasties.some((d) => strategyVerdict(strategy, tacticsByDynasty.get(d), nameOf).allowed)) return null;
  // A workflow judging could still let in: no named tactic judged AGAINST the strategy, at least one not judged yet.
  const unjudgedOf = (d: string): string[] => {
    const m = tacticsByDynasty.get(d);
    const against = strategy.requiresTacticIds.some((t) => m?.get(t) === false) || strategy.excludesTacticIds.some((t) => m?.get(t) === true);
    return against ? [] : [...strategy.requiresTacticIds, ...strategy.excludesTacticIds].filter((t) => m?.get(t) === undefined);
  };
  const waiting = activeDynasties.filter((d) => unjudgedOf(d).length > 0);
  if (waiting.length > 0) {
    const tacticIds = [...new Set(waiting.flatMap(unjudgedOf))];
    const failing = tacticIds.find((t) => judgingOf(t)?.status === "failing");
    if (failing) {
      const j = judgingOf(failing)!;
      return {
        reason: "judging_failing",
        detail:
          `${waiting.length} of the ${activeDynasties.length} active workflow(s) of this pipe are not judged yet on the tactic "${nameOf(failing)}", and Jev is failing to judge it (${j.lastFailure ?? "no reason recorded"}). ` +
          `Judging resumes by itself (next sweep due ${j.nextSweepAt}); the play becomes runnable once a workflow is judged to fit the strategy.`,
      };
    }
    return {
      reason: "judging_pending",
      detail: `${waiting.length} of the ${activeDynasties.length} active workflow(s) of this pipe are not judged yet on the tactic "${nameOf(tacticIds[0])}": Jev is on it, and the play becomes runnable once a workflow is judged to fit the strategy.`,
    };
  }
  return {
    reason: "no_workflow_follows_strategy",
    detail: `Every one of the ${activeDynasties.length} active workflow(s) of this pipe is judged, and none fits the strategy "${strategy.name}": a workflow following it must be built before the play can run.`,
  };
}

export interface StrategyVerdict {
  allowed: boolean;
  /** Why not, in a sentence a human reads. Null when allowed. */
  reason: string | null;
}

/**
 * PURE: may a workflow carrying `tactics` run under `strategy`? Every tactic the strategy NAMES must be judged: a
 * REQUIRED one judged yes, an EXCLUDED one judged no. A workflow not judged yet on a named tactic is NOT allowed
 * (owner 2026-10-13: a play never picks a version nobody judged, so an existing campaign never switches to a fresh
 * workflow in the second before Jev answers; prod: workflow-service's catch-all copies are active on their leg the
 * moment they are created). A strategy naming no tactic allows everything.
 */
export function strategyVerdict(strategy: Strategy, tactics: ReadonlyMap<string, boolean> | undefined, nameOf: (tacticId: string) => string): StrategyVerdict {
  for (const t of strategy.requiresTacticIds) {
    const v = tactics?.get(t);
    if (v === true) continue;
    return {
      allowed: false,
      reason:
        v === undefined
          ? `the strategy "${strategy.name}" requires the tactic "${nameOf(t)}" and this workflow has not been judged on it yet`
          : `the strategy "${strategy.name}" requires the tactic "${nameOf(t)}" and this workflow does not follow it`,
    };
  }
  for (const t of strategy.excludesTacticIds) {
    const v = tactics?.get(t);
    if (v === false) continue;
    return {
      allowed: false,
      reason:
        v === undefined
          ? `the strategy "${strategy.name}" excludes the tactic "${nameOf(t)}" and this workflow has not been judged on it yet`
          : `the strategy "${strategy.name}" excludes the tactic "${nameOf(t)}" and this workflow follows it`,
    };
  }
  return { allowed: true, reason: null };
}

/** PURE: the dynasties a strategy EXCLUDES among `dynasties` (what a play subtracts from its pipe's workflows). */
export function excludedDynasties(strategy: Strategy | null, dynasties: Iterable<string>, tacticsByDynasty: ReadonlyMap<string, ReadonlyMap<string, boolean>>, nameOf: (tacticId: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  if (!strategy) return out;
  for (const d of dynasties) {
    const v = strategyVerdict(strategy, tacticsByDynasty.get(d), nameOf);
    if (!v.allowed) out.set(d, v.reason!);
  }
  return out;
}

/** The catalogue's view of tactics, strategies and plays, built once per read. */
export interface PlayCatalogue {
  tactics: Map<string, Tactic>;
  strategies: Map<string, Strategy>;
  /** pipe id -> its catalogued LIVE plays (default first, then by strategy id). */
  playsByPipe: Map<string, PlayRecord[]>;
  /** pipe id -> the strategies of its RETIRED plays (PLAY-RETIRE-1022): a funnel naming one runs the pipe's default. */
  retiredByPipe: Map<string, Set<string>>;
  /** dynasty -> tactic id -> verdict on its current version. */
  tacticsByDynasty: Map<string, Map<string, boolean>>;
  /** tactic id -> its last full Jev sweep (absent = never swept). */
  sweepsByTactic: Map<string, TacticJudgingSweep>;
}

export function buildPlayCatalogue(input: { tactics: readonly Tactic[]; strategies: readonly Strategy[]; plays: readonly PlayRecord[]; verdicts: readonly TacticVerdictRow[]; sweeps?: readonly TacticJudgingSweep[] }): PlayCatalogue {
  const playsByPipe = new Map<string, PlayRecord[]>();
  const retiredByPipe = new Map<string, Set<string>>();
  for (const p of input.plays) {
    if (p.retired) retiredByPipe.set(p.pipeId, new Set([...(retiredByPipe.get(p.pipeId) ?? []), p.strategyId]));
    else playsByPipe.set(p.pipeId, [...(playsByPipe.get(p.pipeId) ?? []), p]);
  }
  for (const list of playsByPipe.values()) list.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || (a.strategyId < b.strategyId ? -1 : 1));
  return {
    tactics: new Map(input.tactics.map((t) => [t.id, t])),
    strategies: new Map(input.strategies.map((s) => [s.id, s])),
    playsByPipe,
    retiredByPipe,
    tacticsByDynasty: currentTacticsByDynasty(input.verdicts),
    sweepsByTactic: new Map((input.sweeps ?? []).map((w) => [w.tacticId, w])),
  };
}

export const tacticNameOf = (c: PlayCatalogue) => (id: string): string => c.tactics.get(id)?.name ?? id;

/** PURE: the pipe's default strategy (null = the pipe catalogues no play: every assigned workflow, as always). */
export function defaultStrategyOf(c: PlayCatalogue, pipeId: string): Strategy | null {
  const d = c.playsByPipe.get(pipeId)?.find((p) => p.isDefault);
  return d ? (c.strategies.get(d.strategyId) ?? null) : null;
}

/** PURE: the strategy was a play of this pipe that staff RETIRED (PLAY-RETIRE-1022). */
export const isRetiredPlay = (c: PlayCatalogue, pipeId: string, strategyId: string | null): boolean =>
  strategyId !== null && (c.retiredByPipe.get(pipeId)?.has(strategyId) ?? false);

/**
 * PURE: the strategy a play id or a funnel segment names on a pipe. `strategyId` null or the pipe's default = its
 * default play. A RETIRED play of the pipe is its default play too, `retiredFrom` naming it (PLAY-RETIRE-1022: the
 * campaigns that ran it keep running, on the default). A strategy the pipe never catalogued is no play of it: null +
 * `known:false`.
 */
export function resolvePlay(c: PlayCatalogue, pipeId: string, strategyId: string | null): { known: boolean; isDefault: boolean; strategy: Strategy | null; retiredFrom: string | null } {
  const def = defaultStrategyOf(c, pipeId);
  if (strategyId === null || strategyId === def?.id) return { known: true, isDefault: true, strategy: def, retiredFrom: null };
  const listed = c.playsByPipe.get(pipeId)?.some((p) => p.strategyId === strategyId) ?? false;
  const strategy = c.strategies.get(strategyId) ?? null;
  if (listed && strategy) return { known: true, isDefault: false, strategy, retiredFrom: null };
  if (isRetiredPlay(c, pipeId, strategyId)) return { known: true, isDefault: true, strategy: def, retiredFrom: strategyId };
  return { known: false, isDefault: false, strategy: null, retiredFrom: null };
}
