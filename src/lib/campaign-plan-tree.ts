/**
 * A CAMPAIGN'S PLAN, FROM ITS TARGET DOWN, ENGINE BY ENGINE (owner 2026-11-24, PLAN-RECURSIVE-PER-ENGINE-1124: « À chaque
 * Engine en partant de la fin (Target), on demande à Jev de filtrer les scripts possibles et puis le Rating nous donne le
 * meilleur parmi la liste possible. Et ainsi de suite récursivement. »; framework v10 §5). PURE; IO in
 * `routes/campaign-plan-tree.ts`.
 *
 * One node per Engine reached: the strategy the campaign keeps there (its STORED verdict, never judged on this read), the
 * runnable scripts that strategy keeps and those it rules out with the reason (`scriptsKeptByStrategy`, the rule the
 * Engine runner applies per run), today's share of the Rating's draws among the kept ones (`pickScript`), the script
 * drawn most = the pick, then one node per outcome the PICKED script needs (`scriptNeedsOf`: what its code must be handed
 * and what it asks another Engine for), and so on down to a script that needs nothing.
 *
 * - An Engine already on the path from the Target is named and never expanded again (`engine_already_on_path`).
 * - An Engine with no runnable script, or whose strategy keeps none, ends its branch with that reason: never a guess.
 * - Served FLAT, depth first, each node naming its parent and its children: a tree with no recursive wire shape.
 *
 * The Rating's score (value credited per dollar) is a staff DECISION figure: read to draw, never served here. No Engine,
 * outcome or script is named in code: every one comes off the campaign's Target and what each picked script states.
 */
import type { PlayCatalogue, Strategy, Tactic } from "./plays.js";
import { strategyOnEngine } from "./plays.js";
import { scriptDynastyKey, type RunnableScript } from "./script-catalogue-client.js";
import { scriptsKeptByStrategy } from "./script-strategy.js";
import { briefAsksByEngine, type StoredBriefAsk } from "./brief-opt-in.js";
import type { StoredEngineStrategy } from "./engine-strategy.js";
import { CAMPAIGN_DRAWS, type DrawRule, type StrategyState } from "./campaign-engine-scripts.js";
import { pickScript, type OutcomeValue, type ScriptPick, type ScriptRating } from "./script-value-rating.js";

/** How today's draws decide, in words (the campaign Engines page's own). */
const DRAW_RULE: Record<ScriptPick["basis"], DrawRule> = {
  value_per_dollar: "what_runs_led_to_per_cost",
  value_only: "what_runs_led_to",
  cost_only: "cheapest_per_run",
  no_candidate: "no_script",
};

/** Why nothing is listed below a node; null on a node whose picked script needs other Engines (`needs`). */
export type PlanBranchEnd = "script_needs_nothing" | "engine_already_on_path" | "no_runnable_script" | "strategy_keeps_no_script";

export interface PlanTreeScript {
  /** `<outcome>/<dynasty>`. */
  script: string;
  dynasty: string;
  name: string | null;
  version: number;
  description: string | null;
  /** Share of today's draws among the scripts the campaign keeps on this Engine, 0..100. */
  shareOfDrawsPct: number;
  /** The script drawn most today: the one the Plan goes through. */
  picked: boolean;
  /** The outcomes one run of it needs: handed to it, or asked of another Engine. */
  needs: string[];
}

export interface PlanTreeRuledOut {
  script: string;
  dynasty: string;
  name: string | null;
  version: number;
  description: string | null;
  /** Why the campaign's strategy rules it out, in words. */
  reason: string | null;
}

export interface PlanTreeNode {
  /** The Engines from the Target to this one, `>`-joined: unique in the tree. */
  id: string;
  parentId: string | null;
  depth: number;
  outcome: string;
  label: string;
  isTarget: boolean;
  /** The picked script of the parent Engine that needs this outcome; null on the Target. */
  neededByScript: string | null;
  strategyState: StrategyState;
  strategy: { id: string; name: string; description: string } | null;
  rules: Array<{ kind: "requires" | "excludes"; tacticId: string; name: string; clientLine: string | null }>;
  drawRule: DrawRule;
  /** The script the Plan goes through on this Engine; null = none (see `endReason`). */
  picked: string | null;
  /** Kept scripts, most drawn first. */
  scripts: PlanTreeScript[];
  ruledOut: PlanTreeRuledOut[];
  endReason: PlanBranchEnd | null;
  /** One entry per outcome the picked script needs, each the node that follows. */
  needs: Array<{ outcome: string; nodeId: string }>;
}

export interface CampaignPlanTree {
  /** Depth first from the Target; empty with `unavailableReason`. */
  nodes: PlanTreeNode[];
  unavailableReason: "campaign_states_no_target" | null;
}

/** PURE: the outcomes one run of a script needs: its materials (what its code is handed) and what it asks (`tactics.asks`), each once. */
export function scriptNeedsOf(s: Pick<RunnableScript, "materials" | "tactics">): string[] {
  const asks = Array.isArray(s.tactics.asks) ? s.tactics.asks.filter((a): a is string => typeof a === "string" && a !== "") : [];
  return [...new Set([...(s.materials ?? []), ...asks])];
}

const SEPARATOR = ">";

/** PURE. `rngOf(outcome)` = the seeded generator of one Engine's draws: an Engine reached twice reads the same shares. */
export function campaignPlanTree(input: {
  target: string | null;
  /** The campaign's stored strategy per Engine (`campaign_engine_strategies`); an Engine with none reads `not_judged_yet`. */
  stored: readonly Pick<StoredEngineStrategy, "outcome" | "strategyId" | "campaignId">[];
  /** STORED answers of what the campaign's brief asks for (opt-in tactics per Engine, `lib/brief-opt-in.ts`); never asked here. */
  briefAsks?: readonly Pick<StoredBriefAsk, "outcome" | "tacticId" | "asks">[];
  runnable: readonly RunnableScript[];
  catalogue: Pick<PlayCatalogue, "tactics" | "strategies" | "tacticsByWriter">;
  /** The fleet Rating (every script's runs and reach): what the runner draws on. Never served. */
  fleetRatings: readonly ScriptRating[];
  values: ReadonlyMap<string, OutcomeValue>;
  labelOf: (outcome: string) => string;
  rngOf: (outcome: string) => () => number;
  draws?: number;
}): CampaignPlanTree {
  if (!input.target) return { nodes: [], unavailableReason: "campaign_states_no_target" };
  const draws = input.draws ?? CAMPAIGN_DRAWS;
  const storedByOutcome = new Map(input.stored.map((s) => [s.outcome, s]));
  const briefAsks = briefAsksByEngine(input.briefAsks ?? []);
  const nodes: PlanTreeNode[] = [];

  const walk = (outcome: string, path: readonly string[], neededByScript: string | null): string => {
    const id = [...path, outcome].join(SEPARATOR);
    const base = {
      id,
      parentId: path.length ? path.join(SEPARATOR) : null,
      depth: path.length,
      outcome,
      label: input.labelOf(outcome),
      isTarget: path.length === 0,
      neededByScript,
    };
    const row = storedByOutcome.get(outcome);
    let strategy: Strategy | null = null;
    if (row?.strategyId) {
      strategy = input.catalogue.strategies.get(row.strategyId) ?? null;
      if (!strategy) throw new Error(`campaign ${row.campaignId} keeps strategy ${row.strategyId} on ${outcome}, which the catalogue does not hold`);
    }
    const strategyState: StrategyState = !row ? "not_judged_yet" : strategy ? "kept" : "no_condition";
    const strategyView = strategy ? { id: strategy.id, name: strategy.name, description: strategy.description } : null;
    const empty = { rules: [], drawRule: "no_script" as const, picked: null, scripts: [], ruledOut: [], needs: [] };
    if (path.includes(outcome)) {
      nodes.push({ ...base, strategyState, strategy: strategyView, ...empty, endReason: "engine_already_on_path" });
      return id;
    }
    const scripts = input.runnable.filter((s) => s.outcome === outcome);
    if (scripts.length === 0) {
      nodes.push({ ...base, strategyState, strategy: strategyView, ...empty, endReason: "no_runnable_script" });
      return id;
    }
    const onScripts = strategy ? strategyOnEngine(strategy, scripts, input.catalogue.tactics) : null;
    const tactic = (t: string): Tactic | undefined => input.catalogue.tactics.get(t);
    const rules = onScripts
      ? [
          ...onScripts.requiresTacticIds.map((t) => ({ kind: "requires" as const, tacticId: t, name: tactic(t)?.name ?? t, clientLine: tactic(t)?.clientLine ?? null })),
          ...onScripts.excludesTacticIds.map((t) => ({ kind: "excludes" as const, tacticId: t, name: tactic(t)?.name ?? t, clientLine: tactic(t)?.clientLine ?? null })),
        ]
      : [];
    const kept = scriptsKeptByStrategy(scripts, strategy, input.catalogue, null, briefAsks.get(outcome));
    const keptDynasties = new Set(kept.keptDynasties);
    const keptKeys = kept.keptDynasties.map((d) => `${outcome}/${d}`);
    const counts = new Map<string, number>(keptKeys.map((k) => [k, 0]));
    let basis: ScriptPick["basis"] = "no_candidate";
    if (keptKeys.length) {
      const rng = input.rngOf(outcome);
      for (let i = 0; i < draws; i += 1) {
        const pick = pickScript({ outcome, candidates: keptKeys, ratings: input.fleetRatings, values: input.values, rng });
        basis = pick.basis;
        if (pick.scriptDynasty) counts.set(pick.scriptDynasty, (counts.get(pick.scriptDynasty) ?? 0) + 1);
      }
    }
    const reasonByDynasty = new Map(kept.scripts.map((k) => [k.dynasty, k.reason]));
    const keptRows = scripts
      .filter((s) => keptDynasties.has(s.dynasty))
      .map(
        (s): PlanTreeScript => ({
          script: scriptDynastyKey(s),
          dynasty: s.dynasty,
          name: s.name ?? null,
          version: s.version,
          description: s.description || null,
          shareOfDrawsPct: Math.round(((counts.get(scriptDynastyKey(s)) ?? 0) / draws) * 1000) / 10,
          picked: false,
          needs: scriptNeedsOf(s),
        }),
      )
      .sort((a, b) => b.shareOfDrawsPct - a.shareOfDrawsPct || a.script.localeCompare(b.script));
    const ruledOut = scripts
      .filter((s) => !keptDynasties.has(s.dynasty))
      .map((s): PlanTreeRuledOut => ({ script: scriptDynastyKey(s), dynasty: s.dynasty, name: s.name ?? null, version: s.version, description: s.description || null, reason: reasonByDynasty.get(s.dynasty) ?? null }))
      .sort((a, b) => a.script.localeCompare(b.script));
    const pickedRow = keptRows[0] ?? null;
    if (pickedRow) pickedRow.picked = true;
    const node: PlanTreeNode = {
      ...base,
      strategyState,
      strategy: strategyView,
      rules,
      drawRule: DRAW_RULE[basis],
      picked: pickedRow?.script ?? null,
      scripts: keptRows,
      ruledOut,
      endReason: !pickedRow ? "strategy_keeps_no_script" : pickedRow.needs.length === 0 ? "script_needs_nothing" : null,
      needs: [],
    };
    // Pushed before its children: depth first, a parent always before what its picked script needs.
    nodes.push(node);
    if (pickedRow) for (const need of pickedRow.needs) node.needs.push({ outcome: need, nodeId: walk(need, [...path, outcome], pickedRow.script) });
    return id;
  };

  walk(input.target, [], null);
  return { nodes, unavailableReason: null };
}
