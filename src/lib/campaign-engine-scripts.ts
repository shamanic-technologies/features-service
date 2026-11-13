/**
 * A CAMPAIGN'S OWN VIEW OF ITS ENGINES, IN SCRIPTS (owner 2026-11-13, CAMPAIGN-SCRIPTS-1113: « un pick = toujours un
 * script », the LLM and the template are tactics of the script). PURE; IO in `routes/campaign-engine-scripts.ts`.
 *
 * For one funnel campaign, from its Target down, at each Engine it uses:
 * - the scripts that compete FOR THIS CAMPAIGN: the Engine's runnable scripts its brief's strategy keeps
 *   (`scriptsKeptByStrategy`, the rule the Engine runner applies per run), and the ones the strategy rules out, each
 *   with the reason in words and the strategy's script tactics (what it requires, what it excludes);
 * - how often the Rating draws each TODAY among the kept ones (`pickScript`, `CAMPAIGN_DRAWS` draws on the fleet
 *   Rating the Monitoring board stored: the exact draw the runner makes for this campaign), so the shares add to 100;
 *   never the fleet board's share among every runnable script (a brief that narrows reads a different share);
 * - what THIS campaign's own runs of each did (runs, the strongest outcome each run reached, cost per run, last day).
 *
 * The Rating's score (value credited per dollar) is a staff DECISION figure: it is read to draw, never served here.
 * No Engine or outcome is named in code: every one comes off the stored strategies, the campaign's runs and its Target.
 */
import type { PlayCatalogue, Strategy, Tactic } from "./plays.js";
import { strategyOnSubject } from "./plays.js";
import { scriptDynastyKey, type RunnableScript } from "./script-catalogue-client.js";
import { scriptsKeptByStrategy } from "./script-strategy.js";
import type { StoredEngineStrategy } from "./engine-strategy.js";
import { llmTacticsOf, templateTacticsOf, type ScriptLlmTactic, type ScriptTemplateTactic } from "./script-engine-board.js";
import { engineOfDynasty, pickScript, scriptRatings, type OutcomeValue, type ReachGroup, type ScriptPick, type ScriptRating } from "./script-value-rating.js";

/** Draws per Engine: a share is read to the half percent, the same as the Monitoring board. */
export const CAMPAIGN_DRAWS = 400;

export type StrategyState = "kept" | "no_condition" | "not_judged_yet";

/** How today's draws decide (words for `ScriptPick.basis`, never a score). */
export type DrawRule = "what_runs_led_to_per_cost" | "what_runs_led_to" | "cheapest_per_run" | "no_script";
const DRAW_RULE: Record<ScriptPick["basis"], DrawRule> = {
  value_per_dollar: "what_runs_led_to_per_cost",
  value_only: "what_runs_led_to",
  cost_only: "cheapest_per_run",
  no_candidate: "no_script",
};

export interface CampaignScriptRuns {
  runs: number;
  /** Runs by the strongest outcome they reached beyond their own Unit (`outcome` null = nothing beyond it), most first. */
  reached: Array<{ outcome: string | null; label: string | null; runs: number }>;
  spentUsd: number | null;
  costPerRunUsd: number | null;
  /** UTC day of this campaign's last run of the script; null = never ran here. */
  lastRunDay: string | null;
}

export interface CampaignScriptRow {
  /** `<outcome>/<dynasty>`, the key the Rating and the strategies use. */
  script: string;
  dynasty: string;
  version: number | null;
  description: string | null;
  /** Share of today's draws among the scripts this campaign's strategy keeps, 0..100; null = not competing. */
  shareOfDrawsPct: number | null;
  /** The script the draws pick most often today for this campaign. */
  drawnMost: boolean;
  /** Why the strategy rules it out, in words; null = kept (or no longer runnable). */
  ruledOutReason: string | null;
  llms: ScriptLlmTactic[];
  templates: ScriptTemplateTactic[];
  campaign: CampaignScriptRuns;
}

export interface CampaignEngineRow {
  outcome: string;
  label: string;
  isTarget: boolean;
  strategyState: StrategyState;
  strategy: { id: string; name: string; description: string } | null;
  /** The strategy's conditions on scripts, in words (tactic name + the line a client reads). */
  rules: Array<{ kind: "requires" | "excludes"; tacticId: string; name: string; clientLine: string | null }>;
  drawRule: DrawRule;
  /** The script the draws pick most often today; null = none can run. */
  runsNow: string | null;
  /** Kept scripts, most drawn first: shares add to ~100. */
  scripts: CampaignScriptRow[];
  /** Runnable scripts the strategy rules out, with the reason. */
  ruledOut: CampaignScriptRow[];
  /** Scripts this campaign ran on the Engine that are no longer runnable (history). */
  past: CampaignScriptRow[];
  campaign: { runs: number; spentUsd: number | null; costPerRunUsd: number | null };
}

/** PURE: a seeded generator (mulberry32) so one build reads the same shares on every read. */
export function seededRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const nameOfKey = (key: string): string => key.slice(key.indexOf("/") + 1);

function campaignRunsOf(rating: ScriptRating | undefined, lastDay: string | undefined, labelOf: (o: string) => string): CampaignScriptRuns {
  if (!rating) return { runs: 0, reached: [], spentUsd: null, costPerRunUsd: null, lastRunDay: lastDay ?? null };
  return {
    runs: rating.runs,
    reached: [...rating.reached]
      .sort((a, b) => b.runs - a.runs || String(a.outcome).localeCompare(String(b.outcome)))
      .map((r) => ({ outcome: r.outcome, label: r.outcome === null ? null : labelOf(r.outcome), runs: r.runs })),
    spentUsd: rating.spentUsd,
    costPerRunUsd: rating.costPerRunUsd,
    lastRunDay: lastDay ?? null,
  };
}

/** PURE: every Engine the campaign uses, its Target first, then the most valued outcome, then the most run. */
export function campaignEngineScripts(input: {
  target: string | null;
  /** The campaign's stored strategy per Engine (`campaign_engine_strategies`). */
  stored: readonly Pick<StoredEngineStrategy, "outcome" | "strategyId" | "campaignId">[];
  runnable: readonly RunnableScript[];
  catalogue: Pick<PlayCatalogue, "tactics" | "strategies" | "tacticsByWriter">;
  /** The fleet Rating (every script's runs and reach): what the runner draws on. */
  fleetRatings: readonly ScriptRating[];
  values: ReadonlyMap<string, OutcomeValue>;
  /** This campaign's own script runs (its units), re-homed like the Rating's. */
  campaignGroups: readonly ReachGroup[];
  labelOf: (outcome: string) => string;
  rng: () => number;
  draws?: number;
}): CampaignEngineRow[] {
  const draws = input.draws ?? CAMPAIGN_DRAWS;
  const campaignRatings = new Map(scriptRatings({ groups: input.campaignGroups, values: input.values }).map((r) => [r.scriptDynasty, r]));
  const lastDay = new Map<string, string>();
  for (const g of input.campaignGroups) if (g.runs > 0 && g.day > (lastDay.get(g.scriptDynasty) ?? "")) lastDay.set(g.scriptDynasty, g.day);
  const storedByOutcome = new Map(input.stored.map((s) => [s.outcome, s]));
  const outcomes = new Set<string>(storedByOutcome.keys());
  for (const key of campaignRatings.keys()) outcomes.add(engineOfDynasty(key));
  if (input.target && input.runnable.some((s) => s.outcome === input.target)) outcomes.add(input.target);

  const rows = [...outcomes].map((outcome): CampaignEngineRow => {
    const row = storedByOutcome.get(outcome);
    let strategy: Strategy | null = null;
    if (row?.strategyId) {
      strategy = input.catalogue.strategies.get(row.strategyId) ?? null;
      if (!strategy) throw new Error(`campaign ${row.campaignId} keeps strategy ${row.strategyId} on ${outcome}, which the catalogue does not hold`);
    }
    const state: StrategyState = !row ? "not_judged_yet" : strategy ? "kept" : "no_condition";
    const onScripts = strategy ? strategyOnSubject(strategy, "script", input.catalogue.tactics) : null;
    const tactic = (id: string): Tactic | undefined => input.catalogue.tactics.get(id);
    const rules = onScripts
      ? [
          ...onScripts.requiresTacticIds.map((id) => ({ kind: "requires" as const, tacticId: id, name: tactic(id)?.name ?? id, clientLine: tactic(id)?.clientLine ?? null })),
          ...onScripts.excludesTacticIds.map((id) => ({ kind: "excludes" as const, tacticId: id, name: tactic(id)?.name ?? id, clientLine: tactic(id)?.clientLine ?? null })),
        ]
      : [];
    const scripts = input.runnable.filter((s) => s.outcome === outcome);
    const kept = scriptsKeptByStrategy(scripts, strategy, input.catalogue as PlayCatalogue);
    const keptKeys = kept.keptDynasties.map((d) => `${outcome}/${d}`);
    const counts = new Map<string, number>(keptKeys.map((k) => [k, 0]));
    let basis: ScriptPick["basis"] = "no_candidate";
    if (keptKeys.length)
      for (let i = 0; i < draws; i += 1) {
        const pick = pickScript({ outcome, candidates: keptKeys, ratings: input.fleetRatings, values: input.values, rng: input.rng });
        basis = pick.basis;
        if (pick.scriptDynasty) counts.set(pick.scriptDynasty, (counts.get(pick.scriptDynasty) ?? 0) + 1);
      }
    const reasonByDynasty = new Map(kept.scripts.map((k) => [k.dynasty, k.reason]));
    const rowOf = (s: RunnableScript, share: number | null): CampaignScriptRow => {
      const key = scriptDynastyKey(s);
      return {
        script: key,
        dynasty: s.dynasty,
        version: s.version,
        description: s.description || null,
        shareOfDrawsPct: share,
        drawnMost: false,
        ruledOutReason: share === null ? (reasonByDynasty.get(s.dynasty) ?? null) : null,
        llms: llmTacticsOf(s.tactics),
        templates: templateTacticsOf(s.tactics),
        campaign: campaignRunsOf(campaignRatings.get(key), lastDay.get(key), input.labelOf),
      };
    };
    const keptRows = scripts
      .filter((s) => counts.has(scriptDynastyKey(s)))
      .map((s) => rowOf(s, Math.round(((counts.get(scriptDynastyKey(s)) ?? 0) / draws) * 1000) / 10))
      .sort((a, b) => b.shareOfDrawsPct! - a.shareOfDrawsPct! || b.campaign.runs - a.campaign.runs || a.script.localeCompare(b.script));
    if (keptRows[0]) keptRows[0].drawnMost = true;
    const ruledOut = scripts
      .filter((s) => !counts.has(scriptDynastyKey(s)))
      .map((s) => rowOf(s, null))
      .sort((a, b) => b.campaign.runs - a.campaign.runs || a.script.localeCompare(b.script));
    const runnableKeys = new Set(scripts.map(scriptDynastyKey));
    const past = [...campaignRatings.keys()]
      .filter((k) => engineOfDynasty(k) === outcome && !runnableKeys.has(k))
      .map(
        (k): CampaignScriptRow => ({
          script: k,
          dynasty: nameOfKey(k),
          version: null,
          description: null,
          shareOfDrawsPct: null,
          drawnMost: false,
          ruledOutReason: null,
          llms: [],
          templates: [],
          campaign: campaignRunsOf(campaignRatings.get(k), lastDay.get(k), input.labelOf),
        }),
      )
      .sort((a, b) => b.campaign.runs - a.campaign.runs || a.script.localeCompare(b.script));
    const all = [...keptRows, ...ruledOut, ...past];
    const runs = all.reduce((n, r) => n + r.campaign.runs, 0);
    const ran = all.filter((r) => r.campaign.runs > 0);
    const spentKnown = ran.every((r) => r.campaign.spentUsd !== null);
    const spentUsd = spentKnown ? round6(ran.reduce((n, r) => n + (r.campaign.spentUsd ?? 0), 0)) : null;
    return {
      outcome,
      label: input.labelOf(outcome),
      isTarget: outcome === input.target,
      strategyState: state,
      strategy: strategy ? { id: strategy.id, name: strategy.name, description: strategy.description } : null,
      rules,
      drawRule: DRAW_RULE[basis],
      runsNow: keptRows[0]?.script ?? null,
      scripts: keptRows,
      ruledOut,
      past,
      campaign: { runs, spentUsd, costPerRunUsd: spentUsd === null || runs === 0 ? null : round6(spentUsd / runs) },
    };
  });
  const valueOf = (o: string): number => input.values.get(o)?.valueUsd ?? 0;
  return rows.sort(
    (a, b) => Number(b.isTarget) - Number(a.isTarget) || valueOf(b.outcome) - valueOf(a.outcome) || b.campaign.runs - a.campaign.runs || a.outcome.localeCompare(b.outcome),
  );
}
