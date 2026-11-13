/**
 * THE SCRIPT RATING ON VALUE (owner 2026-11-13, SCRIPT-VALUE-RATING-1113). PURE; IO in `script-value-rating-io.ts`.
 *
 * Why: a decision "succeeded" as soon as its own Unit existed, so every candidate read 96 to 100 % and the cheapest always
 * won (prod, 30 days of email writing: Flash-Lite 98 %, Haiku 99.7 %, Opus 96 %). Now:
 *
 * - A PICK IS ALWAYS A SCRIPT (a dynasty `<outcome>/<dynasty>`, every version pooled; the run keeps its exact version).
 * - THE VALUE OF AN OUTCOME flows DOWN from the offer's lifetime revenue (a Paid client is worth it), one step at a time:
 *   V(X) = the best over Y of rate(X -> Y) x V(Y), where rate(X -> Y) is MEASURED in the ledger (of the Units of X some
 *   run consumed, the share whose consuming run produced Y: runs-service outcome chains). A step the ledger cannot
 *   measure (too few consumed Units, or never chained) takes the DECLARED value of X (the catalogue's step value: the
 *   client's stated rates, else the defaults); neither = the outcome is worth nothing, never guessed.
 * - A RUN IS CREDITED the value of the STRONGEST outcome it made or its chain reached (the runs that consumed its Unit,
 *   then theirs, any depth), LESS the value of what it made itself. Why the subtraction: the value of an outcome is
 *   already the average of what its Units lead to, so crediting it whole to a run that led no further counts the
 *   successes twice and hands every run the same floor, which favours the cheapest (the owner's example, 500 runs each,
 *   4 against 12 interested leads at twice the price: unsubtracted, the cheap writer won 1,441 to 1,217 per dollar;
 *   subtracted, the dear one wins 749 to 506). A run that led nowhere beyond its own Unit is credited nothing.
 *   No Plan, no age, no lead ladder, no outcome named here: only the produced / consumed graph.
 * - THE NOTE of a script = value credited per run ÷ cost per run. A decision figure: never served as a return (a return
 *   exists only at a campaign's Target); readers show costs per Unit and rates.
 * - THE PICK is Thompson sampling: each candidate's mix of strongest outcomes is a Dirichlet belief pulled toward its
 *   Engine's mix (a new script starts at the Engine's average, wide), one draw each, value drawn ÷ cost per run.
 */
import { gammaDraw } from "./engine-shadow.js";

/** A measured step needs this many consumed Units to be a rate (the fleet's "measured from reached" bar). */
export const MIN_CONSUMED_UNITS = 10;
/** How many runs of the Engine's own mix a candidate's belief starts with. */
export const ENGINE_PRIOR_RUNS = 5;

export interface StepRate {
  fromOutcome: string;
  toOutcome: string;
  /** Distinct Units of `fromOutcome` some run consumed. */
  consumedUnits: number;
  /** Of those, the Units whose consuming run produced a Unit of `toOutcome`. */
  ledUnits: number;
}

export interface OutcomeValue {
  outcome: string;
  valueUsd: number;
  /** `anchor` = a Paid client (the lifetime revenue); `measured` = through a ledger step; `declared` = the catalogue's. */
  source: "anchor" | "measured" | "declared";
  via: { toOutcome: string; share: number } | null;
}

/** The value of every outcome that leads, measured or declared, to the anchor. An outcome absent from the map is worth 0. */
export function outcomeValues(input: {
  steps: readonly StepRate[];
  anchor: { outcome: string; valueUsd: number | null };
  declared: ReadonlyMap<string, number>;
}): Map<string, OutcomeValue> {
  const out = new Map<string, OutcomeValue>();
  const anchorValue = input.anchor.valueUsd;
  if (anchorValue === null || !(anchorValue > 0)) return out;
  out.set(input.anchor.outcome, { outcome: input.anchor.outcome, valueUsd: anchorValue, source: "anchor", via: null });
  const edges = new Map<string, Array<{ toOutcome: string; share: number }>>();
  for (const s of input.steps) {
    if (s.fromOutcome === s.toOutcome || s.fromOutcome === input.anchor.outcome) continue;
    if (!(s.consumedUnits >= MIN_CONSUMED_UNITS) || !(s.ledUnits > 0)) continue;
    const list = edges.get(s.fromOutcome) ?? [];
    list.push({ toOutcome: s.toOutcome, share: Math.min(1, s.ledUnits / s.consumedUnits) });
    edges.set(s.fromOutcome, list);
  }
  const outcomes = new Set<string>([...edges.keys(), ...input.declared.keys()]);
  outcomes.delete(input.anchor.outcome);
  for (let pass = 0; pass < 200; pass++) {
    let moved = false;
    for (const x of outcomes) {
      let best: OutcomeValue | null = null;
      for (const e of edges.get(x) ?? []) {
        const v = out.get(e.toOutcome);
        if (!v) continue;
        const value = e.share * v.valueUsd;
        if (value > 0 && (!best || value > best.valueUsd)) best = { outcome: x, valueUsd: value, source: "measured", via: e };
      }
      if (!best) {
        const d = input.declared.get(x);
        if (d !== undefined && d > 0) best = { outcome: x, valueUsd: d, source: "declared", via: null };
      }
      const prev = out.get(x);
      if (!best) {
        if (prev) {
          out.delete(x);
          moved = true;
        }
        continue;
      }
      if (!prev || Math.abs(prev.valueUsd - best.valueUsd) > 1e-9 || prev.source !== best.source) moved = true;
      out.set(x, best);
    }
    if (!moved) break;
  }
  return out;
}

/** Script runs of one dynasty on one day that share what they made and what their chain reached. */
export interface ReachGroup {
  /** `<outcome>/<dynasty>`. */
  scriptDynasty: string;
  day: string;
  producedOutcomes: readonly string[];
  reachedOutcomes: readonly string[];
  runs: number;
  /** What those runs cost (the decision and everything under it); null = the ledger does not serve it. */
  spentUsd: number | null;
}

/** The strongest outcome a run made or reached: the most valued one; none valued = nothing. */
export function strongestOf(g: Pick<ReachGroup, "producedOutcomes" | "reachedOutcomes">, values: ReadonlyMap<string, OutcomeValue>): { outcome: string | null; valueUsd: number } {
  let best: { outcome: string | null; valueUsd: number } = { outcome: null, valueUsd: 0 };
  for (const o of [...g.producedOutcomes, ...g.reachedOutcomes]) {
    const v = values.get(o)?.valueUsd ?? 0;
    if (v > best.valueUsd || (v === best.valueUsd && v > 0 && best.outcome !== null && o < best.outcome)) best = { outcome: o, valueUsd: v };
  }
  return best;
}

/** What a run is credited: its strongest outcome's value less the value of what it made itself, never below zero. */
export function creditOf(g: Pick<ReachGroup, "producedOutcomes" | "reachedOutcomes">, values: ReadonlyMap<string, OutcomeValue>): { outcome: string | null; creditUsd: number } {
  const s = strongestOf(g, values);
  const own = g.producedOutcomes.reduce((m, o) => Math.max(m, values.get(o)?.valueUsd ?? 0), 0);
  const creditUsd = Math.max(0, s.valueUsd - own);
  return { outcome: creditUsd > 0 ? s.outcome : null, creditUsd };
}

export interface ScriptRating {
  scriptDynasty: string;
  /** The Engine: the outcome the script makes. */
  outcome: string;
  runs: number;
  /** Runs by the strongest outcome they reached beyond their own Unit, most credited first; `outcome` null = none. */
  reached: Array<{ outcome: string | null; runs: number; creditUsd: number }>;
  valueUsd: number;
  valuePerRunUsd: number;
  spentUsd: number | null;
  costPerRunUsd: number | null;
  /** The decision figure the pick reads. Never shown as a return. */
  valuePerDollar: number | null;
  valuePerDollarUnavailableReason: "spend_not_served" | "no_spend" | null;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
export const engineOfDynasty = (scriptDynasty: string): string => scriptDynasty.slice(0, Math.max(0, scriptDynasty.indexOf("/"))) || scriptDynasty;

/** One row per script dynasty, the best value per dollar first (unknown last, then the slug). */
export function scriptRatings(input: { groups: readonly ReachGroup[]; values: ReadonlyMap<string, OutcomeValue> }): ScriptRating[] {
  const acc = new Map<string, { runs: number; value: number; spent: number; spendKnown: boolean; reached: Map<string | null, { runs: number; credit: number }> }>();
  for (const g of input.groups) {
    if (!(g.runs > 0)) continue;
    const a = acc.get(g.scriptDynasty) ?? { runs: 0, value: 0, spent: 0, spendKnown: true, reached: new Map() };
    const s = creditOf(g, input.values);
    a.runs += g.runs;
    a.value += g.runs * s.creditUsd;
    if (g.spentUsd === null) a.spendKnown = false;
    else a.spent += g.spentUsd;
    const r = a.reached.get(s.outcome) ?? { runs: 0, credit: 0 };
    a.reached.set(s.outcome, { runs: r.runs + g.runs, credit: r.credit + g.runs * s.creditUsd });
    acc.set(g.scriptDynasty, a);
  }
  const rows = [...acc.entries()].map(([scriptDynasty, a]): ScriptRating => {
    const spentUsd = a.spendKnown ? round6(a.spent) : null;
    const priced = spentUsd !== null && spentUsd > 0;
    return {
      scriptDynasty,
      outcome: engineOfDynasty(scriptDynasty),
      runs: a.runs,
      reached: [...a.reached.entries()]
        .map(([outcome, r]) => ({ outcome, runs: r.runs, creditUsd: round6(r.credit) }))
        .sort((x, y) => y.creditUsd / y.runs - x.creditUsd / x.runs || String(x.outcome).localeCompare(String(y.outcome))),
      valueUsd: round6(a.value),
      valuePerRunUsd: a.value / a.runs,
      spentUsd,
      costPerRunUsd: spentUsd === null ? null : round6(spentUsd / a.runs),
      valuePerDollar: priced ? a.value / spentUsd : null,
      valuePerDollarUnavailableReason: priced ? null : spentUsd === null ? "spend_not_served" : "no_spend",
    };
  });
  return rows.sort((x, y) => (y.valuePerDollar ?? -1) - (x.valuePerDollar ?? -1) || x.scriptDynasty.localeCompare(y.scriptDynasty));
}

export interface ScriptPick {
  outcome: string;
  scriptDynasty: string | null;
  /** `value_per_dollar` = the rule; `value_only` = no cost known at this Engine; `cost_only` = no value known at it. */
  basis: "value_per_dollar" | "value_only" | "cost_only" | "no_candidate";
  /** Every candidate with what this draw scored it, the pick first. */
  candidates: Array<{ scriptDynasty: string; runs: number; score: number | null }>;
}

/** One Thompson draw among the candidates of an Engine (the scripts the campaign's strategy keeps, runnable today). */
export function pickScript(input: {
  outcome: string;
  candidates: readonly string[];
  ratings: readonly ScriptRating[];
  values: ReadonlyMap<string, OutcomeValue>;
  rng: () => number;
}): ScriptPick {
  const names = [...new Set(input.candidates)].sort();
  if (!names.length) return { outcome: input.outcome, scriptDynasty: null, basis: "no_candidate", candidates: [] };
  const rows = new Map(input.ratings.filter((r) => names.includes(r.scriptDynasty)).map((r) => [r.scriptDynasty, r]));
  const engineMix = new Map<string | null, number>();
  const engineCredit = new Map<string | null, number>();
  let engineRuns = 0;
  let engineSpent = 0;
  let engineSpentRuns = 0;
  let engineValue = 0;
  for (const r of rows.values()) {
    engineRuns += r.runs;
    engineValue += r.valueUsd;
    if (r.spentUsd !== null) {
      engineSpent += r.spentUsd;
      engineSpentRuns += r.runs;
    }
    for (const x of r.reached) {
      engineMix.set(x.outcome, (engineMix.get(x.outcome) ?? 0) + x.runs);
      engineCredit.set(x.outcome, (engineCredit.get(x.outcome) ?? 0) + x.creditUsd);
    }
  }
  const engineCost = engineSpentRuns > 0 && engineSpent > 0 ? engineSpent / engineSpentRuns : null;
  const costOf = (name: string): number | null => {
    const own = rows.get(name)?.costPerRunUsd;
    return own !== null && own !== undefined && own > 0 ? own : engineCost;
  };
  if (!(engineValue > 0)) {
    const order = names.map((n) => ({ scriptDynasty: n, runs: rows.get(n)?.runs ?? 0, cost: costOf(n) })).sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity) || a.scriptDynasty.localeCompare(b.scriptDynasty));
    return { outcome: input.outcome, scriptDynasty: order[0]!.scriptDynasty, basis: "cost_only", candidates: order.map((o) => ({ scriptDynasty: o.scriptDynasty, runs: o.runs, score: null })) };
  }
  const kinds = [...engineMix.keys()];
  const valueOf = (o: string | null): number => (engineCredit.get(o) ?? 0) / (engineMix.get(o) ?? 1);
  const basis = engineCost === null ? "value_only" : "value_per_dollar";
  const scored = names.map((name) => {
    const own = new Map((rows.get(name)?.reached ?? []).map((x) => [x.outcome, x.runs]));
    const draws = kinds.map((k) => gammaDraw(Math.max(1e-3, (own.get(k) ?? 0) + (ENGINE_PRIOR_RUNS * (engineMix.get(k) ?? 0)) / engineRuns), input.rng));
    const total = draws.reduce((s, d) => s + d, 0);
    const value = kinds.reduce((s, k, i) => s + (draws[i]! / total) * valueOf(k), 0);
    const cost = costOf(name);
    return { scriptDynasty: name, runs: rows.get(name)?.runs ?? 0, score: cost === null ? value : value / cost };
  });
  scored.sort((a, b) => b.score - a.score || a.scriptDynasty.localeCompare(b.scriptDynasty));
  return { outcome: input.outcome, scriptDynasty: scored[0]!.scriptDynasty, basis, candidates: scored };
}

/**
 * A script re-homed under another outcome keeps its runs: a dynasty name runnable under exactly ONE outcome today takes
 * every run recorded under that name, whatever outcome it was filed under then (`conversation/dy_follow_up_due` ->
 * `lead_interested/dy_follow_up_due`). A name runnable under several outcomes, or under none, keeps its own keys.
 */
export function rehomeGroups(groups: readonly ReachGroup[], runnableDynasties: readonly string[]): ReachGroup[] {
  const nameOf = (key: string): string => key.slice(key.indexOf("/") + 1);
  const homes = new Map<string, Set<string>>();
  for (const key of runnableDynasties) homes.set(nameOf(key), (homes.get(nameOf(key)) ?? new Set()).add(key));
  return groups.map((g) => {
    const home = homes.get(nameOf(g.scriptDynasty));
    return home && home.size === 1 ? { ...g, scriptDynasty: [...home][0]! } : g;
  });
}

/** One script decision a client reported (an edit of what it wrote, or a "Report"), in a reach group's own terms. */
export interface ReportedDecision {
  scriptDynasty: string;
  day: string;
  producedOutcomes: readonly string[];
  reachedOutcomes: readonly string[];
  spentUsd: number | null;
}

/**
 * A reported Unit is worth nothing for the script that made it (owner 2026-11-13): its decision leaves its group and
 * stands alone as a run that made and reached nothing, its cost kept. A decision the groups no longer hold (the ledger
 * rebuilt since) changes nothing. Each decision is passed once, however many times its Units were reported.
 */
export function applyReports(groups: readonly ReachGroup[], reported: readonly ReportedDecision[]): ReachGroup[] {
  const keyOf = (g: Pick<ReachGroup, "scriptDynasty" | "day" | "producedOutcomes" | "reachedOutcomes">): string => JSON.stringify([g.scriptDynasty, g.day, [...g.producedOutcomes].sort(), [...g.reachedOutcomes].sort()]);
  const out = groups.map((g) => ({ ...g }));
  const index = new Map<string, ReachGroup>();
  for (const g of out) if (!index.has(keyOf(g))) index.set(keyOf(g), g);
  for (const r of reported) {
    const g = index.get(keyOf(r));
    if (!g || !(g.runs > 0)) continue;
    g.runs -= 1;
    if (g.spentUsd !== null && r.spentUsd !== null) g.spentUsd = Math.max(0, g.spentUsd - r.spentUsd);
    out.push({ scriptDynasty: r.scriptDynasty, day: r.day, producedOutcomes: [], reachedOutcomes: [], runs: 1, spentUsd: g.spentUsd === null ? null : r.spentUsd });
  }
  return out;
}
