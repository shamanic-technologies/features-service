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
import type { PlayCatalogue, Strategy } from "./plays.js";
import type { RunnableScript } from "./script-catalogue-client.js";
import { scriptsKeptByStrategy } from "./script-strategy.js";

export type EngineStrategySource = "carried" | "judge" | "empty_brief";

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
 * Engine's when its script tactics keep some of the Engine's runnable scripts and rule some out (a strategy keeping all
 * of them, or none, is no choice on this Engine). `carried` strategy ids are offered whatever their scripts say.
 */
export function engineStrategyOptions(
  outcome: string,
  scripts: readonly RunnableScript[],
  c: Pick<PlayCatalogue, "strategies" | "tactics" | "tacticsByWriter">,
  carried: Iterable<string> = [],
): EngineStrategyOption[] {
  const own = scripts.filter((s) => s.outcome === outcome);
  const keep = new Set<string>();
  for (const s of c.strategies.values()) {
    if (own.length === 0) break;
    const kept = scriptsKeptByStrategy(own, s, c);
    if (kept.scriptTacticIds.length > 0 && kept.keptDynasties.length > 0 && kept.keptDynasties.length < new Set(own.map((x) => x.dynasty)).size) keep.add(s.id);
  }
  for (const id of carried) if (c.strategies.has(id)) keep.add(id);
  const listed = [...keep]
    .map((id) => c.strategies.get(id)!)
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))
    .map((s): EngineStrategyOption => ({ strategyId: s.id, name: s.name, description: `${s.name}: ${s.description}` }));
  return [NO_CONDITION_OPTION, ...listed];
}

/** PURE: what the judge chooses among, fingerprinted: a strategy added, removed or reworded moves it. */
export const optionsSignatureOf = (options: readonly EngineStrategyOption[]): string =>
  sha256(JSON.stringify(options.map((o) => [o.strategyId, o.description]).sort()));

/**
 * PURE: whether a stored verdict still stands. `stored` = read it; `empty_brief` = no brief, no condition; `ask` = Jev.
 * A carried verdict stands while its brief is unchanged, whatever the options; a judged one also needs the same options.
 */
export function engineStrategyNeed(
  stored: Pick<StoredEngineStrategy, "briefHash" | "optionsSignature" | "source"> | null,
  briefHash: string | null,
  optionsSignature: string | null,
): "stored" | "empty_brief" | "ask" {
  if (stored && stored.briefHash === briefHash && (stored.source !== "judge" || stored.optionsSignature === optionsSignature)) return "stored";
  if (briefHash === null) return "empty_brief";
  return "ask";
}

/** PURE: the Jev `choice` question for one Engine (option keys `o0..oN`, mapped back by the caller). */
export function engineStrategyQuestion(options: readonly EngineStrategyOption[]) {
  return {
    type: "choice" as const,
    instructions:
      "A client wrote a BRIEF for one sales campaign, in plain language (in the state). The campaign runs the ENGINE described in the state: " +
      "the scripts that make one outcome. Each option is a STRATEGY for that Engine: a condition deciding who its scripts reach or how they work. " +
      "Pick the strategy the brief asks for on this Engine. When nothing in the brief bears on this Engine, pick the option marked NO CONDITION. " +
      "Judge on the brief's words only, never on the options' names.",
    criteria: Object.fromEntries(options.map((o, i) => [`o${i}`, `${o.strategyId === null ? "NO CONDITION. " : ""}${o.description}`])),
  };
}

/** PURE: the state Jev reads: the brief and the Engine, in words. */
export function engineStrategyState(brief: string, engine: { outcome: string; label: string }): Record<string, unknown> {
  return { brief, engine: { outcome: engine.outcome, makes: engine.label } };
}

/** PURE: the strategy a stored verdict names, null = no condition. Throws when the catalogue no longer holds it. */
export function strategyOfStored(row: Pick<StoredEngineStrategy, "strategyId" | "campaignId" | "outcome">, strategies: ReadonlyMap<string, Strategy>): Strategy | null {
  if (row.strategyId === null) return null;
  const s = strategies.get(row.strategyId);
  if (!s) throw new Error(`campaign ${row.campaignId} keeps strategy ${row.strategyId} on ${row.outcome}, which the catalogue does not hold`);
  return s;
}
