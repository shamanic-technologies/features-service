/**
 * A CAMPAIGN'S STRATEGY NARROWS THE SCRIPTS ITS ENGINE MAY RUN (MIGRATE-1105 S0-STRATEGY, owner 2026-11-05). PURE.
 *
 * The same rule as workflows, templates and LLMs (`lib/plays.ts` `strategyVerdict`): the strategy the campaign unit's
 * sales funnel names (else its default) is read on its SCRIPT tactics only (`strategyOnSubject(…, "script")`); a script
 * dynasty is kept when every REQUIRED tactic is judged yes on it and every EXCLUDED one judged no. Verdicts are Jev's,
 * judged on each runnable version (its description, its tactics data and its code; `lib/tactic-judgments.ts`), stored
 * in `writer_tactic_verdicts` (subject kind `script`, key `<outcome>/<dynasty>`), the previous version's verdict serving
 * until the new one is judged. A script NOT judged on a named tactic is never kept. An OPT-IN tactic (`Tactic.optIn`,
 * OUTREACH-3WAYS-1121) works the other way round: a script judged yes on it is kept ONLY where the strategy requires it
 * (`optInRefusal`), never under no strategy nor a strategy silent on it. A tactic about a matter the Engine's
 * scripts do not decide (`strategyOnEngine`, ONE-WRITER-N-MODELS-1116-LEADS-ONLY) narrows nothing on that Engine. No strategy (or one naming no script
 * tactic) keeps every script of the Engine. A play the campaign's pipe does not catalogue keeps none (never a silent
 * widen). No order is served: workflow-service's Rating picks among the kept dynasties.
 */
import { excludedDynasties, optInRefusal, optInTacticsOnEngine, strategyOnEngine, strategyOnSubject, strategyVerdict, tacticNameOf, workflowStrategyOf, writerSubjectKey, type PlayCatalogue, type Strategy } from "./plays.js";
import { scriptDynastyKey, scriptWorksPipe, type RunnableScript } from "./script-catalogue-client.js";
import type { StoredEngineStrategy } from "./engine-strategy.js";

/** PURE: the tactic ids a strategy REQUIRES (what a campaign ASKS for, OUTREACH-3WAYS-1121); none without one. */
const askedOf = (strategy: Strategy | null): Set<string> => new Set(strategy?.requiresTacticIds ?? []);

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
  // One reading per Engine: a tactic about a matter its scripts do not decide drops out there (`strategyOnEngine`).
  const onEngine = new Map<string, Strategy>();
  const stOf = (outcome: string): Strategy | null => {
    if (!strategy) return null;
    if (!onEngine.has(outcome)) onEngine.set(outcome, strategyOnEngine(strategy, scripts.filter((x) => x.outcome === outcome), c.tactics));
    return onEngine.get(outcome)!;
  };
  // OUTREACH-3WAYS-1121: the opt-in tactics gating each Engine (empty while no tactic is opt-in: byte-identical).
  const optInsByEngine = new Map<string, ReturnType<typeof optInTacticsOnEngine>>();
  const optInsOf = (outcome: string) => {
    if (!optInsByEngine.has(outcome)) optInsByEngine.set(outcome, optInTacticsOnEngine(scripts.filter((x) => x.outcome === outcome), c.tactics));
    return optInsByEngine.get(outcome)!;
  };
  const asked = askedOf(strategy);
  for (const s of scripts) stOf(s.outcome);
  const scriptTacticIds = [...new Set([...onEngine.values()].flatMap((st) => [...st.requiresTacticIds, ...st.excludesTacticIds]))];
  const nameOf = tacticNameOf(c as PlayCatalogue);
  const rows: ScriptKept[] = [...scripts]
    .sort((a, b) => (a.dynasty < b.dynasty ? -1 : a.dynasty > b.dynasty ? 1 : 0))
    .map((s) => {
      const base = { dynasty: s.dynasty, scriptId: s.id, version: s.version };
      if (playUnknown) return { ...base, kept: false, reason: `the play "${playUnknown}" is not catalogued on this campaign's pipe` };
      const optOut = optInRefusal(optInsOf(s.outcome), asked, c.tacticsByWriter.get(writerSubjectKey("script", scriptDynastyKey(s))));
      if (optOut) return { ...base, kept: false, reason: optOut };
      const st = stOf(s.outcome);
      if (!st || st.requiresTacticIds.length + st.excludesTacticIds.length === 0) return { ...base, kept: true, reason: null };
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

/**
 * PURE (MON-SCRIPT-PRICES-2-1111): what a play's strategy subtracts from a pipe's priced candidates, workflow AND script
 * dynasties alike. A workflow dynasty is judged on the strategy's WORKFLOW tactics (`excludedDynasties`), a script dynasty
 * (`<outcome>/<dynasty>`, it holds a `/`) on its SCRIPT tactics, the rule its Engine's Rating applies per run
 * (`scriptsKeptByStrategy`): every required tactic judged yes on it, every excluded one judged no; a strategy naming no
 * script tactic keeps every script. Keys naming neither (the unnamed pool) are left to the caller.
 */
export function excludedPipeCandidates(
  strategy: Strategy | null,
  keys: Iterable<string>,
  c: Pick<PlayCatalogue, "tactics" | "tacticsByDynasty" | "tacticsByWriter">,
  /** Every runnable script (`strategyOnEngine`); null = unread, every script tactic applies (as strict as before). */
  runnable: readonly RunnableScript[] | null = null,
): Set<string> {
  const all = [...keys];
  const out = new Set<string>();
  const nameOf = tacticNameOf(c as PlayCatalogue);
  const workflows = all.filter((k) => !k.includes("/"));
  if (strategy) for (const k of excludedDynasties(workflowStrategyOf(c, strategy), workflows, c.tacticsByDynasty, nameOf).keys()) out.add(k);
  const asked = askedOf(strategy);
  for (const k of all.filter((x) => x.includes("/"))) {
    const outcome = k.slice(0, k.indexOf("/"));
    // OUTREACH-3WAYS-1121: an opt-in script is priced only on a play whose strategy asks for it (no strategy included).
    // Runnable scripts unread = every opt-in script tactic applies (as strict as the rest of this read).
    const optIns = runnable
      ? optInTacticsOnEngine(runnable.filter((x) => x.outcome === outcome), c.tactics)
      : optInTacticsOnEngine([], new Map([...c.tactics].map(([id, t]) => [id, { ...t, decidedByFields: null }])));
    if (optInRefusal(optIns, asked, c.tacticsByWriter.get(writerSubjectKey("script", k)))) {
      out.add(k);
      continue;
    }
    if (!strategy) continue;
    const st = runnable ? strategyOnEngine(strategy, runnable.filter((x) => x.outcome === outcome), c.tactics) : strategyOnSubject(strategy, "script", c.tactics);
    if (st.requiresTacticIds.length + st.excludesTacticIds.length === 0) continue;
    if (!strategyVerdict(st, c.tacticsByWriter.get(writerSubjectKey("script", k)), nameOf, "script").allowed) out.add(k);
  }
  return out;
}
