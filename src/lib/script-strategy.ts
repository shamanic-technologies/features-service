/**
 * A CAMPAIGN'S STRATEGY NARROWS THE SCRIPTS ITS ENGINE MAY RUN (MIGRATE-1105 S0-STRATEGY, owner 2026-11-05). PURE.
 *
 * The same rule as workflows, templates and LLMs (`lib/plays.ts` `strategyVerdict`): the strategy the campaign unit's
 * sales funnel names (else its default) is read on its SCRIPT tactics only (`strategyOnSubject(…, "script")`); a script
 * dynasty is kept when every REQUIRED tactic is judged yes on it and every EXCLUDED one judged no. Verdicts are Jev's,
 * judged on each runnable version (its description, its tactics data and its code; `lib/tactic-judgments.ts`), stored
 * in `writer_tactic_verdicts` (subject kind `script`, key `<outcome>/<dynasty>`), the previous version's verdict serving
 * until the new one is judged. A script NOT judged on a named tactic is never kept. No strategy (or one naming no script
 * tactic) keeps every script of the Engine. A play the campaign's pipe does not catalogue keeps none (never a silent
 * widen). No order is served: workflow-service's Rating picks among the kept dynasties.
 */
import { strategyOnSubject, strategyVerdict, tacticNameOf, writerSubjectKey, type PlayCatalogue, type Strategy } from "./plays.js";
import { scriptDynastyKey, scriptWorksPipe, type RunnableScript } from "./script-catalogue-client.js";
import type { StoredEngineStrategy } from "./engine-strategy.js";

export interface ScriptKept {
  dynasty: string;
  scriptId: string;
  version: number;
  kept: boolean;
  /** Why not, in a sentence an agent can relay. Null when kept. */
  reason: string | null;
}

export interface ScriptsKept {
  /** The script tactics the strategy names (requires + excludes); empty = the strategy narrows no script. */
  scriptTacticIds: string[];
  keptDynasties: string[];
  scripts: ScriptKept[];
}

/**
 * PURE. `strategy` null = no strategy (every script kept). `playUnknown` = the campaign names a play its pipe does not
 * catalogue: every script ruled out.
 */
export function scriptsKeptByStrategy(scripts: readonly RunnableScript[], strategy: Strategy | null, c: Pick<PlayCatalogue, "tactics" | "tacticsByWriter">, playUnknown: string | null = null): ScriptsKept {
  const st = strategy ? strategyOnSubject(strategy, "script", c.tactics) : null;
  const scriptTacticIds = st ? [...st.requiresTacticIds, ...st.excludesTacticIds] : [];
  const nameOf = tacticNameOf(c as PlayCatalogue);
  const rows: ScriptKept[] = [...scripts]
    .sort((a, b) => (a.dynasty < b.dynasty ? -1 : a.dynasty > b.dynasty ? 1 : 0))
    .map((s) => {
      const base = { dynasty: s.dynasty, scriptId: s.id, version: s.version };
      if (playUnknown) return { ...base, kept: false, reason: `the play "${playUnknown}" is not catalogued on this campaign's pipe` };
      if (!st || scriptTacticIds.length === 0) return { ...base, kept: true, reason: null };
      const v = strategyVerdict(st, c.tacticsByWriter.get(writerSubjectKey("script", scriptDynastyKey(s))), nameOf, "script");
      return { ...base, kept: v.allowed, reason: v.reason };
    });
  return { scriptTacticIds, keptDynasties: rows.filter((r) => r.kept).map((r) => r.dynasty), scripts: rows };
}

/** The scripts working one pipe for one campaign: every runnable one, and those its strategy keeps. */
export interface ScriptsOnPipe {
  working: readonly string[];
  kept: readonly string[];
}

/**
 * PURE (MON-ENGINE-PICK-1111): per campaign, the scripts working a pipe (`scriptWorksPipe`) and those the campaign's
 * STORED strategy on the pipe's Engine keeps (`scriptsKeptByStrategy`, the rule workflow-service's Rating applies per
 * run). No stored verdict yet = no condition (the runner judges it on its first run). Never asks Jev.
 */
export function scriptsOnPipeOf(
  scripts: readonly RunnableScript[],
  strategies: readonly Pick<StoredEngineStrategy, "campaignId" | "outcome" | "strategyId">[],
  catalogue: Pick<PlayCatalogue, "strategies" | "tactics" | "tacticsByWriter">,
): (campaignId: string) => (pipe: { channelSlug: string; outcome: string; outcomeStated: boolean }) => ScriptsOnPipe {
  return (campaignId) => (pipe) => {
    const working = scripts.filter((s) => scriptWorksPipe(s, pipe));
    if (working.length === 0) return { working: [], kept: [] };
    const stored = strategies.find((x) => x.campaignId === campaignId && x.outcome === pipe.outcome);
    // Same reading as `strategyOfStored` (engine-strategy.ts, which imports this module): a kept id the catalogue lost throws.
    const strategy = stored?.strategyId ? catalogue.strategies.get(stored.strategyId) : null;
    if (strategy === undefined) throw new Error(`campaign ${campaignId} keeps strategy ${stored!.strategyId} on ${pipe.outcome}, which the catalogue does not hold`);
    return { working: working.map((s) => s.dynasty), kept: scriptsKeptByStrategy(working, strategy, catalogue).keptDynasties };
  };
}
