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
}

export interface Strategy {
  id: string;
  name: string;
  description: string;
  requiresTacticIds: string[];
  excludesTacticIds: string[];
  createdBy: string;
  createdAt: string;
}

export interface PlayRecord {
  pipeId: string;
  strategyId: string;
  isDefault: boolean;
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
  /** pipe id -> its catalogued plays (default first, then by strategy id). */
  playsByPipe: Map<string, PlayRecord[]>;
  /** dynasty -> tactic id -> verdict on its current version. */
  tacticsByDynasty: Map<string, Map<string, boolean>>;
}

export function buildPlayCatalogue(input: { tactics: readonly Tactic[]; strategies: readonly Strategy[]; plays: readonly PlayRecord[]; verdicts: readonly TacticVerdictRow[] }): PlayCatalogue {
  const playsByPipe = new Map<string, PlayRecord[]>();
  for (const p of input.plays) playsByPipe.set(p.pipeId, [...(playsByPipe.get(p.pipeId) ?? []), p]);
  for (const list of playsByPipe.values()) list.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || (a.strategyId < b.strategyId ? -1 : 1));
  return {
    tactics: new Map(input.tactics.map((t) => [t.id, t])),
    strategies: new Map(input.strategies.map((s) => [s.id, s])),
    playsByPipe,
    tacticsByDynasty: currentTacticsByDynasty(input.verdicts),
  };
}

export const tacticNameOf = (c: PlayCatalogue) => (id: string): string => c.tactics.get(id)?.name ?? id;

/** PURE: the pipe's default strategy (null = the pipe catalogues no play: every assigned workflow, as always). */
export function defaultStrategyOf(c: PlayCatalogue, pipeId: string): Strategy | null {
  const d = c.playsByPipe.get(pipeId)?.find((p) => p.isDefault);
  return d ? (c.strategies.get(d.strategyId) ?? null) : null;
}

/**
 * PURE: the strategy a play id or a funnel segment names on a pipe. `strategyId` null or the pipe's default = its
 * default play. A strategy the pipe does not catalogue is no play of it: null + `known:false`.
 */
export function resolvePlay(c: PlayCatalogue, pipeId: string, strategyId: string | null): { known: boolean; isDefault: boolean; strategy: Strategy | null } {
  const def = defaultStrategyOf(c, pipeId);
  if (strategyId === null || strategyId === def?.id) return { known: true, isDefault: true, strategy: def };
  const listed = c.playsByPipe.get(pipeId)?.some((p) => p.strategyId === strategyId) ?? false;
  const strategy = c.strategies.get(strategyId) ?? null;
  return listed && strategy ? { known: true, isDefault: false, strategy } : { known: false, isDefault: false, strategy: null };
}
