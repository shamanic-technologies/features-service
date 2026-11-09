/**
 * A CAMPAIGN'S STRATEGY PER ENGINE (MIGRATE-1105 S6, owner 2026-11-07: « les pipe sont supprimés depuis longtemps non??
 * Meme les legs non???? »). PURE: the IO lives in `engine-strategy-io.ts`, the store is `campaign_engine_strategies`.
 *
 * Framework v10 §6: a judge reads the campaign's brief once per ENGINE (one outcome) and keeps one of that Engine's
 * strategies, or none (no condition: every script of the Engine). The verdict is stored on the campaign and read at every
 * run. No pipe, leg, play, sales funnel id or default play decides it.
 *
 * - An Engine's strategies: every catalogued strategy whose SCRIPT tactics keep at least one runnable script of the
 *   outcome and rule at least one out (`engineStrategyOptions`), plus the ones the caller still carries (a strategy a
 *   campaign runs today on an Engine no script serves yet, e.g. an answering workflow). First option = no condition.
 * - A stored verdict stands while the brief is unchanged (`brief_hash`); a `judge` verdict is also re-asked when the
 *   Engine's options move. A `carried` verdict (written once by the S6 migration from what the campaign ran that day)
 *   is re-asked only when its brief moves: the migration changes nothing that runs.
 */
import { createHash } from "node:crypto";
import { strategyOnSubject, writerSubjectKey, type PlayCatalogue, type Strategy } from "./plays.js";
import { scriptDynastyKey, type RunnableScript } from "./script-catalogue-client.js";
import { scriptsKeptByStrategy } from "./script-strategy.js";

/** `empty_brief` = a pre-S6 row only; never written any more. */
export type EngineStrategySource = "carried" | "judge" | "empty_brief" | "engine_default";

export interface StoredEngineStrategy {
  campaignId: string;
  outcome: string;
  orgId: string;
  strategyId: string | null;
  source: EngineStrategySource;
  briefHash: string | null;
  optionsSignature: string | null;
  confidence: number | null;
  model: string | null;
  carriedFrom: string | null;
  judgedAt: string;
}

export interface EngineStrategyOption {
  /** null = no condition (every script of the Engine). */
  strategyId: string | null;
  name: string;
  /** What the judge reads. */
  description: string;
  /** The option kept when nothing in the brief bears on this Engine: the Engine's default strategy, else no condition. */
  isDefault?: boolean;
}

/**
 * PURE: the Engine's conservative DEFAULT strategy (a strategy whose data names the outcome in `defaultForOutcomes`,
 * MIGRATE-1105 S6): what a campaign keeps when its brief says nothing on this Engine. Null = the Engine states none
 * (its scripts do not differ in who they reach): no condition. Two strategies claiming one Engine = the first by id.
 */
export function engineDefaultStrategy(outcome: string, strategies: ReadonlyMap<string, Strategy>): Strategy | null {
  return [...strategies.values()].filter((s) => (s.defaultForOutcomes ?? []).includes(outcome)).sort((a, b) => (a.id < b.id ? -1 : 1))[0] ?? null;
}

export const NO_CONDITION_OPTION: EngineStrategyOption = {
  strategyId: null,
  name: "No condition",
  description: "No condition: every script of this Engine may run, whoever it reaches and however it works.",
};

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** PURE: the fingerprint of the brief judged (trimmed text); null = no brief. Same spelling as the brief judge's. */
export const briefHashOf = (brief: string | null | undefined): string | null => {
  const t = brief?.trim() ?? "";
  return t === "" ? null : sha256(t);
};

/**
 * PURE: the strategies the judge chooses among for one Engine, no condition first, then by name. A strategy is the
 * Engine's when its script tactics keep some of the Engine's runnable scripts and rule some out, read on JUDGED facts
 * only: a script not yet judged on the strategy's tactics (a dynasty born minutes ago) is never counted as ruled out
 * (2026-11-09, Doc Dinners: dy_brand_team, not yet judged, made « Any contact » look like a choice on the answering
 * Engine; the judge took it on a targeting sentence of the brief and kept the current-client check-in there).
 *
 * `carried` = the stored verdict's strategy, offered though it does not split the scripts, so a verdict is re-asked
 * among what it runs today (an Engine no script serves yet, e.g. an answering workflow; a strategy narrowing what writes,
 * templates or LLMs, which its scripts do not show; one keeping none of the scripts). Never a carried strategy that
 * keeps EVERY script of an Engine with scripts and states no writer condition: it is no choice there, and its words,
 * written for another Engine, only mislead the judge (« Any contact », about who is emailed, on the answering Engine).
 */
export function engineStrategyOptions(
  outcome: string,
  scripts: readonly RunnableScript[],
  c: Pick<PlayCatalogue, "strategies" | "tactics" | "tacticsByWriter">,
  carried: Iterable<string> = [],
): EngineStrategyOption[] {
  const own = scripts.filter((s) => s.outcome === outcome);
  const dynasties = new Set(own.map((x) => x.dynasty)).size;
  const keep = new Set<string>();
  for (const s of c.strategies.values()) {
    if (own.length === 0) break;
    const kept = scriptsKeptByStrategy(own.filter((x) => judgedOn(x, s, c)), s, c);
    if (kept.scriptTacticIds.length > 0 && kept.keptDynasties.length > 0 && kept.scripts.some((x) => !x.kept)) keep.add(s.id);
  }
  for (const id of carried) {
    const s = c.strategies.get(id);
    if (!s) continue;
    const keepsAll = own.length > 0 && scriptsKeptByStrategy(own, s, c).keptDynasties.length >= dynasties;
    const writes = [...s.requiresTacticIds, ...s.excludesTacticIds].some((t) => ["template", "llm"].includes(c.tactics.get(t)?.appliesTo ?? ""));
    if (!keepsAll || writes) keep.add(id);
  }
  // A brief silent on this Engine never widens it: its DEFAULT strategy (data) comes first and is what silence keeps;
  // "no condition" is offered only on an Engine that states no default.
  const def = engineDefaultStrategy(outcome, c.strategies);
  if (def) keep.delete(def.id);
  const listed = [...keep]
    .map((id) => c.strategies.get(id)!)
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))
    .map((s): EngineStrategyOption => ({ strategyId: s.id, name: s.name, description: `${s.name}: ${s.description}` }));
  const first: EngineStrategyOption = def ? { strategyId: def.id, name: def.name, description: `${def.name}: ${def.description}`, isDefault: true } : { ...NO_CONDITION_OPTION, isDefault: true };
  return [first, ...listed];
}

/** PURE: whether a script holds a verdict on every script tactic the strategy names. */
function judgedOn(script: RunnableScript, s: Strategy, c: Pick<PlayCatalogue, "tactics" | "tacticsByWriter">): boolean {
  const st = strategyOnSubject(s, "script", c.tactics);
  const v = c.tacticsByWriter.get(writerSubjectKey("script", scriptDynastyKey(script)));
  return [...st.requiresTacticIds, ...st.excludesTacticIds].every((t) => v?.has(t) === true);
}

/**
 * PURE: what one option RUNS on this Engine: the script dynasties it keeps and the ones it never runs, read the way a run
 * reads them (`scriptsKeptByStrategy`). Empty both = the Engine has no runnable script.
 */
export function engineOptionEffect(outcome: string, scripts: readonly RunnableScript[], strategy: Strategy | null, c: Pick<PlayCatalogue, "tactics" | "tacticsByWriter">): { runs: string[]; neverRuns: string[] } {
  const k = scriptsKeptByStrategy(scripts.filter((s) => s.outcome === outcome), strategy, c);
  return { runs: [...new Set(k.keptDynasties)], neverRuns: [...new Set(k.scripts.filter((x) => !x.kept).map((x) => x.dynasty))] };
}

/** PURE: what the judge chooses among, fingerprinted: a strategy added, removed or reworded moves it. */
export const optionsSignatureOf = (options: readonly EngineStrategyOption[]): string =>
  sha256(JSON.stringify(options.map((o) => [o.strategyId, o.description, o.isDefault === true]).sort()));

/**
 * PURE: whether a stored verdict still stands. `stored` = read it; `ask` = Jev; `hold` = no verdict and no brief to judge:
 * the Engine runs nothing until the campaign states its brief (a blank brief never widens to every script: the Engine's
 * scripts serve different people). A carried verdict stands while its brief is unchanged, whatever the options; a judged
 * one also needs the same options. A brief emptied after a verdict keeps that verdict.
 */
export function engineStrategyNeed(
  stored: Pick<StoredEngineStrategy, "briefHash" | "optionsSignature" | "source"> | null,
  briefHash: string | null,
  optionsSignature: string | null,
): "stored" | "ask" | "hold" {
  if (stored && stored.briefHash === briefHash && (stored.source !== "judge" || stored.optionsSignature === optionsSignature)) return "stored";
  if (briefHash === null) return stored ? "stored" : "hold";
  return "ask";
}

/** PURE: the Jev `choice` question for one Engine (option keys `o0..oN`, mapped back by the caller). */
export function engineStrategyQuestion(options: readonly EngineStrategyOption[]) {
  return {
    type: "choice" as const,
    instructions:
      "A client wrote a BRIEF for one sales campaign, in plain language (in the state). The campaign runs the ENGINE described in the state: " +
      "the scripts that make one outcome. Each option is a STRATEGY for that Engine: a condition deciding who its scripts reach or how they work. " +
      "The state also lists the Engine's scripts, what each does, and which scripts each option runs: an option is what it runs here. " +
      "Pick the strategy the brief asks for on this Engine. When nothing in the brief bears on this Engine, pick the option marked DEFAULT. " +
      "Every strategy already leaves out people who asked to stop, unsubscribed or opted out: a brief asking that does not choose between the options. " +
      "Judge on the brief's words only, never on the options' names.",
    criteria: Object.fromEntries(options.map((o, i) => [`o${i}`, `${o.isDefault ? "DEFAULT. " : ""}${o.description}`])),
  };
}

/**
 * PURE: the state Jev reads: the WHOLE brief, the Engine in words, and every fact we hold on what the options do there:
 * each runnable script of the Engine with what it does (its description), and per option (by its name) the scripts it
 * runs and never runs. In the state, not the options' words: the options' signature (what re-asks a verdict) stays the
 * catalogue's.
 */
export function engineStrategyState(
  brief: string,
  engine: { outcome: string; label: string },
  facts: { scripts: readonly RunnableScript[]; options: readonly EngineStrategyOption[]; c: Pick<PlayCatalogue, "strategies" | "tactics" | "tacticsByWriter"> } | null = null,
): Record<string, unknown> {
  const own = (facts?.scripts ?? []).filter((s) => s.outcome === engine.outcome).sort((a, b) => (a.dynasty < b.dynasty ? -1 : a.dynasty > b.dynasty ? 1 : 0));
  if (!facts || own.length === 0) return { brief, engine: { outcome: engine.outcome, makes: engine.label } };
  return {
    brief,
    engine: {
      outcome: engine.outcome,
      makes: engine.label,
      scripts: own.map((s) => ({ script: s.dynasty, does: s.description })),
      whatEachOptionRuns: Object.fromEntries(
        facts.options.map((o) => [o.name, engineOptionEffect(engine.outcome, own, o.strategyId ? (facts.c.strategies.get(o.strategyId) ?? null) : null, facts.c)]),
      ),
    },
  };
}

/** PURE: the strategy a stored verdict names, null = no condition. Throws when the catalogue no longer holds it. */
export function strategyOfStored(row: Pick<StoredEngineStrategy, "strategyId" | "campaignId" | "outcome">, strategies: ReadonlyMap<string, Strategy>): Strategy | null {
  if (row.strategyId === null) return null;
  const s = strategies.get(row.strategyId);
  if (!s) throw new Error(`campaign ${row.campaignId} keeps strategy ${row.strategyId} on ${row.outcome}, which the catalogue does not hold`);
  return s;
}
