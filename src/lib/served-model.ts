/**
 * THE MODEL THAT ACTUALLY WROTE IS THE ONE CREDITED AND SHOWN (owner 2026-11-16, SERVED-MODEL-1116: « si on utilise un
 * fallback modèle, c'est ce fallback qui doit être nommé partout dans les logs / monitoring, rating, etc. »). PURE.
 *
 * A script is a combination (its LLM x its template, its tactics). The ledger names the model that served each script
 * decision: runs-service states the LLM cost names billed in MAKING the decision's Units (the writing behind a send
 * included), chat-service maps every LLM cost name to its LLM dynasty. A decision belongs to its script's OWN combination
 * only when the script states no LLM, the ledger names none, or one of the LLMs it names is one the script states.
 * Otherwise another model wrote it (a fallback: Kimi out of credit since 2026-11-14 15:35, chat-service rerouted to GPT
 * Terra; or the history a dynasty inherited when it was re-pointed onto another LLM on 2026-11-13): the decision leaves
 * its script's score and is shown under the model(s) that served it. No vendor, script or model is named here.
 */
import type { ReachGroup } from "./script-value-rating.js";

/** The LLM dynasties a script states (its `llm` / `llms` tactics, the dynasty slug in `model`); empty = states none. */
export type StatedLlms = ReadonlyMap<string, ReadonlySet<string>>;

/** The LLM dynasties the ledger names for one decision group, sorted; null = the ledger does not say. */
export function servedLlmsOf(g: Pick<ReachGroup, "writerCostNames">, llmOfCostName: ReadonlyMap<string, string>): string[] | null {
  if (g.writerCostNames === null || g.writerCostNames === undefined) return null;
  const out = new Set<string>();
  for (const name of g.writerCostNames) {
    const llm = llmOfCostName.get(name);
    if (llm) out.add(llm);
  }
  return [...out].sort();
}

/** Whether a decision group ran as its script's own combination (see the module doc). */
export function isOwnCombination(stated: ReadonlySet<string> | undefined, served: readonly string[] | null): boolean {
  if (!stated || stated.size === 0 || served === null || served.length === 0) return true;
  return served.some((llm) => stated.has(llm));
}

/** Decisions of a script another model wrote, by the model(s) the ledger names. */
export interface OtherModelRuns {
  scriptDynasty: string;
  /** The LLM dynasties that served (sorted). */
  servedLlms: string[];
  runs: number;
  spentUsd: number | null;
  /** What those runs made and reached, as the Rating reads a run (outcome keys, deduped, sorted). */
  producedOutcomes: string[];
  reachedOutcomes: string[];
}

/**
 * Split the decision groups: `own` = the groups the Rating scores (each script's own combination), `otherModels` =
 * the groups another model wrote, one row per (script, served LLMs). Every group lands in exactly one of the two.
 */
export function splitByServedModel(input: {
  groups: readonly ReachGroup[];
  stated: StatedLlms;
  llmOfCostName: ReadonlyMap<string, string>;
}): { own: ReachGroup[]; otherModels: OtherModelRuns[] } {
  const own: ReachGroup[] = [];
  const other = new Map<string, { row: OtherModelRuns; produced: Set<string>; reached: Set<string>; spendKnown: boolean; spent: number }>();
  for (const g of input.groups) {
    const served = servedLlmsOf(g, input.llmOfCostName);
    if (isOwnCombination(input.stated.get(g.scriptDynasty), served)) {
      own.push(g);
      continue;
    }
    const llms = served!;
    const key = JSON.stringify([g.scriptDynasty, llms]);
    const a = other.get(key) ?? {
      row: { scriptDynasty: g.scriptDynasty, servedLlms: llms, runs: 0, spentUsd: null, producedOutcomes: [], reachedOutcomes: [] },
      produced: new Set<string>(),
      reached: new Set<string>(),
      spendKnown: true,
      spent: 0,
    };
    a.row.runs += g.runs;
    if (g.spentUsd === null) a.spendKnown = false;
    else a.spent += g.spentUsd;
    for (const o of g.producedOutcomes) a.produced.add(o);
    for (const o of g.reachedOutcomes) a.reached.add(o);
    other.set(key, a);
  }
  const otherModels = [...other.values()]
    .map((a) => ({
      ...a.row,
      spentUsd: a.spendKnown ? Math.round(a.spent * 1e6) / 1e6 : null,
      producedOutcomes: [...a.produced].sort(),
      reachedOutcomes: [...a.reached].sort(),
    }))
    .sort((x, y) => x.scriptDynasty.localeCompare(y.scriptDynasty) || y.runs - x.runs || x.servedLlms.join().localeCompare(y.servedLlms.join()));
  return { own, otherModels };
}

/** Every decision group of every script by the LLM(s) that served it: `own` true = the script's stated LLM wrote it. */
export interface ServedByRow {
  servedLlms: string[] | null;
  own: boolean;
  runs: number;
}

/** PURE: per script, its runs by the model(s) that served them (Monitoring's « written by »). */
export function servedByScript(input: {
  groups: readonly ReachGroup[];
  stated: StatedLlms;
  llmOfCostName: ReadonlyMap<string, string>;
}): Map<string, ServedByRow[]> {
  const acc = new Map<string, Map<string, ServedByRow>>();
  for (const g of input.groups) {
    if (!(g.runs > 0)) continue;
    const served = servedLlmsOf(g, input.llmOfCostName);
    const own = isOwnCombination(input.stated.get(g.scriptDynasty), served);
    const rows = acc.get(g.scriptDynasty) ?? new Map<string, ServedByRow>();
    const key = JSON.stringify([served, own]);
    const r = rows.get(key) ?? { servedLlms: served, own, runs: 0 };
    r.runs += g.runs;
    rows.set(key, r);
    acc.set(g.scriptDynasty, rows);
  }
  return new Map(
    [...acc.entries()].map(([k, rows]) => [k, [...rows.values()].sort((a, b) => Number(b.own) - Number(a.own) || b.runs - a.runs || String(a.servedLlms).localeCompare(String(b.servedLlms)))]),
  );
}

/**
 * PURE: the LLM dynasties each runnable script states (its `llm` / `llms` tactics), each name placed by chat-service's
 * own mapping (`resolve`: a dynasty slug, model id or legacy alias -> its dynasty slug; a name it places nowhere is kept
 * as written). Keyed `<outcome>/<dynasty>`. A script stating no LLM is absent (every decision of it is its own).
 */
export function statedLlmsOf(
  runnable: ReadonlyArray<{ key: string; llms: ReadonlyArray<{ model: string | null }> }>,
  resolve: (name: string) => string | null,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const s of runnable) {
    const set = new Set<string>();
    for (const l of s.llms) if (l.model) set.add(resolve(l.model) ?? l.model);
    if (set.size) out.set(s.key, set);
  }
  return out;
}
