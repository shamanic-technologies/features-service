/**
 * WHAT THE RATING PICKS TODAY, PER ENGINE (SCRIPT-VALUE-RATING-1113-MON, owner 2026-11-13: « un pick = toujours un
 * script », the LLM and the template are tactics of the script). PURE: the staff Monitoring board of every Engine, its
 * scripts ranked by today's share of draws (the Rating's own Thompson draw `pickScript`, `BOARD_DRAWS` times among the
 * Engine's RUNNABLE scripts, no campaign strategy narrowing), with what each rests on: runs, what they reached, spend,
 * cost per run, the Rating's score (credited value per dollar: a DECISION figure, never a return), the LLM / template
 * tactics workflow-service states, and runs per day. No Engine or outcome is named here: every one comes off the data.
 */
import type { RunnableScript } from "./script-catalogue-client.js";
import { scriptDynastyKey } from "./script-catalogue-client.js";
import { engineOfDynasty, pickScript, type OutcomeValue, type ReachGroup, type ScriptPick, type ScriptRating } from "./script-value-rating.js";

/** Draws per Engine: a share is read to the half percent. */
export const BOARD_DRAWS = 400;
/** Days of runs per day served per script. */
export const BOARD_DAYS = 30;

export interface ScriptLlmTactic {
  /** The call's place (`writer`...), null = every call of the script. */
  place: string | null;
  provider: string | null;
  model: string | null;
}
export interface ScriptTemplateTactic {
  place: string | null;
  templateDynastySlug: string;
}

export interface BoardScriptRow {
  scriptDynasty: string;
  /** Runnable today (workflow-service); a past script keeps its figures and draws nothing. */
  runnable: boolean;
  version: number | null;
  /** Share of today's draws among the Engine's runnable scripts, 0..100; null = not runnable. */
  shareOfDrawsPct: number | null;
  runs: number;
  reached: ScriptRating["reached"];
  spentUsd: number | null;
  costPerRunUsd: number | null;
  valuePerRunUsd: number | null;
  /** The Rating's score: credited value per dollar spent (decision figure; never a return). */
  valuePerDollar: number | null;
  valuePerDollarUnavailableReason: ScriptRating["valuePerDollarUnavailableReason"] | "no_runs";
  llms: ScriptLlmTactic[];
  templates: ScriptTemplateTactic[];
  runsByDay: Array<{ day: string; runs: number; spentUsd: number | null }>;
}

export interface BoardEngine {
  outcome: string;
  /** What one Unit of the Engine's outcome is worth on the way to a Paid client (fleet), null = worth nothing known. */
  outcomeValueUsd: number | null;
  outcomeValueSource: OutcomeValue["source"] | null;
  /** How the draws decided (`ScriptPick.basis`); `no_candidate` = no runnable script. */
  basis: ScriptPick["basis"];
  /** The runnable script with the largest share of today's draws. */
  favourite: string | null;
  runnableScripts: number;
  runs: number;
  scripts: BoardScriptRow[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** PURE: the LLM tactics a script states (`llm` = `{provider, model}`, `llms` = per place). */
export function llmTacticsOf(tactics: Record<string, unknown>): ScriptLlmTactic[] {
  const one = (place: string | null, v: unknown): ScriptLlmTactic[] => {
    if (isRecord(v)) return [{ place, provider: str(v.provider), model: str(v.model) }];
    const name = str(v);
    return name ? [{ place, provider: null, model: name }] : [];
  };
  const out = one(null, tactics.llm);
  if (isRecord(tactics.llms)) for (const [place, v] of Object.entries(tactics.llms).sort(([a], [b]) => a.localeCompare(b))) out.push(...one(place, v));
  return out;
}

/** PURE: the template tactics a script states (`template` = a dynasty slug, `templates` = per place). */
export function templateTacticsOf(tactics: Record<string, unknown>): ScriptTemplateTactic[] {
  const out: ScriptTemplateTactic[] = [];
  const one = str(tactics.template);
  if (one) out.push({ place: null, templateDynastySlug: one });
  if (isRecord(tactics.templates))
    for (const [place, v] of Object.entries(tactics.templates).sort(([a], [b]) => a.localeCompare(b))) {
      const slug = str(v);
      if (slug) out.push({ place, templateDynastySlug: slug });
    }
  return out;
}

/** PURE: the day `n - 1` days before `today` (YYYY-MM-DD, UTC). */
export function dayBefore(today: string, n: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

/** PURE: every Engine's board, the most-run Engine first. */
export function scriptEngineBoard(input: {
  ratings: readonly ScriptRating[];
  values: ReadonlyMap<string, OutcomeValue>;
  runnable: readonly RunnableScript[];
  groups: readonly ReachGroup[];
  today: string;
  rng: () => number;
  draws?: number;
}): BoardEngine[] {
  const draws = input.draws ?? BOARD_DRAWS;
  const firstDay = dayBefore(input.today, BOARD_DAYS - 1);
  const runnableByKey = new Map(input.runnable.map((s) => [scriptDynastyKey(s), s]));
  const ratingByKey = new Map(input.ratings.map((r) => [r.scriptDynasty, r]));
  const byDay = new Map<string, Map<string, { runs: number; spent: number; known: boolean }>>();
  for (const g of input.groups) {
    if (!(g.runs > 0) || g.day < firstDay || g.day > input.today) continue;
    const days = byDay.get(g.scriptDynasty) ?? new Map();
    const d = days.get(g.day) ?? { runs: 0, spent: 0, known: true };
    d.runs += g.runs;
    if (g.spentUsd === null) d.known = false;
    else d.spent += g.spentUsd;
    days.set(g.day, d);
    byDay.set(g.scriptDynasty, days);
  }
  const engines = new Map<string, Set<string>>();
  for (const key of [...runnableByKey.keys(), ...ratingByKey.keys()]) {
    const outcome = runnableByKey.get(key)?.outcome ?? ratingByKey.get(key)?.outcome ?? engineOfDynasty(key);
    engines.set(outcome, (engines.get(outcome) ?? new Set()).add(key));
  }
  const boards = [...engines.entries()].map(([outcome, keys]): BoardEngine => {
    const candidates = [...keys].filter((k) => runnableByKey.has(k)).sort();
    const counts = new Map<string, number>(candidates.map((c) => [c, 0]));
    let basis: ScriptPick["basis"] = "no_candidate";
    if (candidates.length)
      for (let i = 0; i < draws; i += 1) {
        const pick = pickScript({ outcome, candidates, ratings: input.ratings, values: input.values, rng: input.rng });
        basis = pick.basis;
        if (pick.scriptDynasty) counts.set(pick.scriptDynasty, (counts.get(pick.scriptDynasty) ?? 0) + 1);
      }
    const scripts = [...keys].map((key): BoardScriptRow => {
      const r = ratingByKey.get(key);
      const s = runnableByKey.get(key);
      const days = byDay.get(key);
      return {
        scriptDynasty: key,
        runnable: Boolean(s),
        version: s?.version ?? null,
        shareOfDrawsPct: s ? Math.round(((counts.get(key) ?? 0) / draws) * 1000) / 10 : null,
        runs: r?.runs ?? 0,
        reached: r?.reached ?? [],
        spentUsd: r ? r.spentUsd : null,
        costPerRunUsd: r ? r.costPerRunUsd : null,
        valuePerRunUsd: r ? r.valuePerRunUsd : null,
        valuePerDollar: r ? r.valuePerDollar : null,
        valuePerDollarUnavailableReason: r ? r.valuePerDollarUnavailableReason : "no_runs",
        llms: s ? llmTacticsOf(s.tactics) : [],
        templates: s ? templateTacticsOf(s.tactics) : [],
        runsByDay: days
          ? [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, d]) => ({ day, runs: d.runs, spentUsd: d.known ? Math.round(d.spent * 1e6) / 1e6 : null }))
          : [],
      };
    });
    scripts.sort(
      (a, b) =>
        Number(b.runnable) - Number(a.runnable) ||
        (b.shareOfDrawsPct ?? -1) - (a.shareOfDrawsPct ?? -1) ||
        (b.valuePerDollar ?? -1) - (a.valuePerDollar ?? -1) ||
        b.runs - a.runs ||
        a.scriptDynasty.localeCompare(b.scriptDynasty),
    );
    const value = input.values.get(outcome);
    return {
      outcome,
      outcomeValueUsd: value ? value.valueUsd : null,
      outcomeValueSource: value ? value.source : null,
      basis,
      favourite: candidates.length ? scripts[0]!.scriptDynasty : null,
      runnableScripts: candidates.length,
      runs: scripts.reduce((n, s) => n + s.runs, 0),
      scripts,
    };
  });
  return boards.sort((a, b) => b.runs - a.runs || b.runnableScripts - a.runnableScripts || a.outcome.localeCompare(b.outcome));
}
