/**
 * THE RATING RATES LLMs PER ENGINE (LLM-RATING-PER-ENGINE-1112, owner 2026-11-12, option A; GTM Factory framework v10
 * section 8: « the same LLM Engine called by the writer and by the reply judge makes two candidate places, and each can
 * settle on a different model »). PURE; the IO lives in `lib/engine-llm-rating-io.ts`, the routes in
 * `routes/engine-llm-rating.ts`.
 *
 * Why: since 2026-11-07 every X and LinkedIn post of our brand was written on Claude Fable, picked by the per-pipe leg
 * writer ranking (BEST-TPL-LLM-1022), keyed on the vocabulary v10 removed. Here an LLM is a candidate like a script:
 *
 * - A PLACE is (Engine outcome, the name a script gives one of its LLM calls: `writer`, `angles`, `judge`...). Never a
 *   pipe, a leg, a channel or a slug.
 * - Its CANDIDATES are the Engine's UNIVERSE (`universeOf`: the Engine's own row, else the fleet row `*`; seeded = every
 *   LLM dynasty chat-service serves except Claude Fable and Claude Opus), served today, its vendor in credit.
 * - EVIDENCE is every LLM call the fleet ever made (runs-service: each call is a chat-service run under the decision's
 *   root run, its model read off its cost lines by chat-service's mapping), workflow era included: a call works for the
 *   Engine its script states (`<outcome>/<dynasty>/v<n>`), else for the outcome of the pipe its workflow is assigned on.
 *   A DECISION is a root run; it made the Engine's Unit when the ledger credits one to it (traceability: a Unit declared
 *   by a child run belongs to the root decision). Spend = the LLM's own money on the call (what the choice moves).
 * - BELIEFS ARE POOLED Engine -> LLM at the Engine (every place, all history) -> LLM at the place (the calls a recorded
 *   pick placed there), each level pulled toward the one above (the engine-shadow rule: method-of-moments strength,
 *   variances add), every day FADED by `HALF_LIFE_DAYS`. A past call never lost: history with no place seeds the LLM's
 *   belief at every place of its Engine.
 * - THE PICK is Thompson sampling on value per dollar: draw a rate (share of decisions making the Unit) and a cost per
 *   decision from each candidate's belief, score rate / cost (every candidate makes the same Unit, so its value cancels),
 *   take the highest.
 */
import { betaDraw, fitStrength, gammaDraw, HALF_LIFE_DAYS, rngOf } from "./engine-shadow.js";

/** The fleet row of the universe store: every Engine without a row of its own. */
export const FLEET_UNIVERSE = "*";

export interface UniverseRule {
  outcome: string;
  /** null = every LLM dynasty chat-service serves today. */
  allowed: string[] | null;
  excluded: string[];
  decidedBy: string;
  note: string | null;
  decidedAt: string;
}

/** An LLM dynasty as chat-service states it (the fields the Rating reads). */
export interface LlmLine {
  slug: string;
  name: string;
  provider: string;
  servedToday: boolean;
}

export interface Universe {
  /** `engine` = the Engine's own row, `fleet` = the `*` row, `none` = no row at all (every served LLM). */
  source: "engine" | "fleet" | "none";
  allowed: string[];
  excluded: string[];
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
}

/** PURE: the LLM dynasties an Engine may use: its own row, else the fleet row; served today only, sorted. */
export function universeOf(outcome: string, rules: readonly UniverseRule[], lines: readonly LlmLine[]): Universe {
  const rule = rules.find((r) => r.outcome === outcome) ?? rules.find((r) => r.outcome === FLEET_UNIVERSE) ?? null;
  const served = lines.filter((l) => l.servedToday).map((l) => l.slug);
  const excluded = new Set(rule?.excluded ?? []);
  const base = rule?.allowed ? rule.allowed.filter((s) => served.includes(s)) : served;
  return {
    source: !rule ? "none" : rule.outcome === FLEET_UNIVERSE ? "fleet" : "engine",
    allowed: [...new Set(base.filter((s) => !excluded.has(s)))].sort(),
    excluded: [...excluded].sort(),
    decidedBy: rule?.decidedBy ?? null,
    decidedAt: rule?.decidedAt ?? null,
    note: rule?.note ?? null,
  };
}

// ── Evidence ───────────────────────────────────────────────────────────────────────────────────────

/** One LLM call (a chat-service run), as the IO resolved it. */
export interface LlmCall {
  callRunId: string;
  /** The decision it was part of. */
  rootRunId: string;
  /** UTC day it ran (YYYY-MM-DD). */
  day: string;
  /** The Engine it worked for (its script's outcome, else its workflow's pipe outcome); null = none known. */
  outcome: string | null;
  /** chat-service's dynasty of the call's model; null = chat-service places it in none. */
  llmDynastySlug: string | null;
  spentUsd: number;
  /** Staff support work or a dry run: never evidence. */
  support: boolean;
}

/** A pick the Rating answered (`engine_llm_picks`). */
export interface PickRecord {
  outcome: string;
  place: string;
  llmDynastySlug: string;
  runId: string | null;
  day: string;
}

/** The place a call's root run was given by a recorded pick naming the same LLM; none = unplaced history. */
export const UNPLACED = "*";

export interface LlmDay {
  day: string;
  calls: number;
  decisions: number;
  /** Decisions that made the Engine's Unit (each counted once). */
  successes: number;
  /** Units the ledger credits to those decisions. */
  outcomes: number;
  spentUsd: number;
}

/** What one LLM did at one Engine (every place), and per place. */
export interface LlmEvidence {
  outcome: string;
  llmDynastySlug: string;
  days: LlmDay[];
  byPlace: Map<string, LlmDay[]>;
  firstCallDay: string;
  lastCallDay: string;
}

const addDay = (m: Map<string, LlmDay>, day: string): LlmDay => {
  let d = m.get(day);
  if (!d) {
    d = { day, calls: 0, decisions: 0, successes: 0, outcomes: 0, spentUsd: 0 };
    m.set(day, d);
  }
  return d;
};

/**
 * PURE: per (Engine, LLM), what its calls did, per decision day. A decision (root run) counts once per LLM it called, on
 * the day of its first call to that LLM; it succeeds when the ledger credits it a Unit of its Engine's outcome
 * (`unitsOf(root, outcome)`). A call's place = the place a recorded pick of the same root run named for that LLM.
 */
export function llmEvidence(
  calls: readonly LlmCall[],
  unitsOf: (rootRunId: string, outcome: string) => number,
  picks: readonly PickRecord[],
): Map<string, LlmEvidence> {
  const placeOf = new Map<string, string>();
  for (const p of picks) if (p.runId) placeOf.set(`${p.runId}|${p.outcome}|${p.llmDynastySlug}`, p.place);
  // (engine, llm, root) -> first day, calls, spend
  const roots = new Map<string, { outcome: string; llm: string; root: string; day: string; calls: number; spentUsd: number; dailyCalls: Map<string, { calls: number; spentUsd: number }> }>();
  for (const c of calls) {
    if (c.support || !c.outcome || !c.llmDynastySlug) continue;
    const k = `${c.outcome}|${c.llmDynastySlug}|${c.rootRunId}`;
    const r = roots.get(k) ?? { outcome: c.outcome, llm: c.llmDynastySlug, root: c.rootRunId, day: c.day, calls: 0, spentUsd: 0, dailyCalls: new Map() };
    if (c.day < r.day) r.day = c.day;
    r.calls += 1;
    r.spentUsd += c.spentUsd;
    const dc = r.dailyCalls.get(c.day) ?? { calls: 0, spentUsd: 0 };
    dc.calls += 1;
    dc.spentUsd += c.spentUsd;
    r.dailyCalls.set(c.day, dc);
    roots.set(k, r);
  }
  const out = new Map<string, LlmEvidence>();
  const dayMaps = new Map<string, { all: Map<string, LlmDay>; places: Map<string, Map<string, LlmDay>> }>();
  for (const r of roots.values()) {
    const key = `${r.outcome}|${r.llm}`;
    let ev = out.get(key);
    if (!ev) {
      ev = { outcome: r.outcome, llmDynastySlug: r.llm, days: [], byPlace: new Map(), firstCallDay: r.day, lastCallDay: r.day };
      out.set(key, ev);
      dayMaps.set(key, { all: new Map(), places: new Map() });
    }
    const maps = dayMaps.get(key)!;
    const units = Math.max(0, unitsOf(r.root, r.outcome));
    const place = placeOf.get(`${r.root}|${r.outcome}|${r.llm}`) ?? UNPLACED;
    const placeDays = maps.places.get(place) ?? new Map<string, LlmDay>();
    maps.places.set(place, placeDays);
    for (const target of [maps.all, placeDays]) {
      const d = addDay(target, r.day);
      d.decisions += 1;
      d.successes += units > 0 ? 1 : 0;
      d.outcomes += units;
      // Calls and money land on the day they happened (a decision's calls can span days).
      for (const [day, dc] of r.dailyCalls) {
        const x = addDay(target, day);
        x.calls += dc.calls;
        x.spentUsd += dc.spentUsd;
      }
    }
    for (const day of r.dailyCalls.keys()) {
      if (day < ev.firstCallDay) ev.firstCallDay = day;
      if (day > ev.lastCallDay) ev.lastCallDay = day;
    }
  }
  for (const [key, ev] of out) {
    const maps = dayMaps.get(key)!;
    const sorted = (m: Map<string, LlmDay>) => [...m.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
    ev.days = sorted(maps.all);
    ev.byPlace = new Map([...maps.places].map(([p, m]) => [p, sorted(m)]));
  }
  return out;
}

// ── Beliefs ────────────────────────────────────────────────────────────────────────────────────────

export interface Weighed {
  decisions: number;
  successes: number;
  spentUsd: number;
}

const DAY_MS = 86_400_000;

/** PURE: days faded by age (half-life), as of `asOfDay` (days strictly before it count). */
export function weigh(days: readonly LlmDay[], asOfDay: string, halfLifeDays = HALF_LIFE_DAYS): Weighed {
  const out: Weighed = { decisions: 0, successes: 0, spentUsd: 0 };
  const asOf = Date.parse(`${asOfDay}T00:00:00Z`);
  for (const d of days) {
    if (d.day >= asOfDay) continue;
    const w = Math.pow(0.5, (asOf - Date.parse(`${d.day}T00:00:00Z`)) / DAY_MS / halfLifeDays);
    out.decisions += w * d.decisions;
    out.successes += w * Math.min(d.successes, d.decisions);
    out.spentUsd += w * d.spentUsd;
  }
  return out;
}

export interface LlmBelief {
  alpha: number;
  beta: number;
  costMeanUsd: number;
  costShape: number;
}

/** Strength of the Engine's rate prior when nothing is measured (a coin: explore). */
const ENGINE_RATE_PRIOR_STRENGTH = 2;
/** Pseudo-decisions behind a cost prior handed down a level: a few real calls outweigh it. */
const COST_PRIOR_STRENGTH = 3;
const MIN_COST_USD = 0.000001;
/** The cost an Engine nobody ever ran is drawn around (USD per decision): every candidate shares it, so rates decide. */
const UNMEASURED_ENGINE_COST_USD = 0.01;

const rateOf = (s: number, n: number, prior: number, k: number) => (s + k * prior) / (n + k);
const pull = (fitted: number, above: number) => 1 / (1 / fitted + 1 / Math.max(above, 1e-9));

/**
 * PURE: each candidate LLM's belief at one place of one Engine, pooled Engine -> LLM (all places) -> LLM at the place.
 * `evidence` = every LLM's evidence at the Engine (candidates or not: an LLM taken out of the universe still informs the
 * Engine's level). A candidate nobody ever ran keeps the Engine's rate and cost, wide: it gets explored.
 */
export function llmBeliefs(candidates: readonly string[], evidence: readonly LlmEvidence[], place: string, asOfDay: string): Map<string, LlmBelief> {
  const byLlm = new Map(evidence.map((e) => [e.llmDynastySlug, e]));
  const llmWeighed = new Map(evidence.map((e) => [e.llmDynastySlug, weigh(e.days, asOfDay)]));
  const engine: Weighed = { decisions: 0, successes: 0, spentUsd: 0 };
  for (const w of llmWeighed.values()) {
    engine.decisions += w.decisions;
    engine.successes += w.successes;
    engine.spentUsd += w.spentUsd;
  }
  const engineRate = rateOf(engine.successes, engine.decisions, 0.5, ENGINE_RATE_PRIOR_STRENGTH);
  const engineStrength = engine.decisions + ENGINE_RATE_PRIOR_STRENGTH;
  const engineCost = engine.decisions > 0 && engine.spentUsd > 0 ? engine.spentUsd / engine.decisions : UNMEASURED_ENGINE_COST_USD;
  const llmFit = fitStrength([...llmWeighed.values()].map((w) => ({ successes: w.successes, trials: w.decisions })));
  const out = new Map<string, LlmBelief>();
  for (const slug of candidates) {
    const w = llmWeighed.get(slug) ?? { decisions: 0, successes: 0, spentUsd: 0 };
    const k1 = pull(llmFit, engineStrength);
    const llmRate = rateOf(w.successes, w.decisions, engineRate, k1);
    const llmStrength = w.decisions + k1;
    const llmCost = w.decisions > 0 && w.spentUsd > 0 ? (w.spentUsd + COST_PRIOR_STRENGTH * engineCost) / (w.decisions + COST_PRIOR_STRENGTH) : engineCost;
    const llmCostStrength = (w.spentUsd > 0 ? w.decisions : 0) + COST_PRIOR_STRENGTH;
    const p = place === UNPLACED ? { decisions: 0, successes: 0, spentUsd: 0 } : weigh(byLlm.get(slug)?.byPlace.get(place) ?? [], asOfDay);
    const k2 = pull(llmFit, llmStrength);
    const successes = Math.min(p.successes, p.decisions);
    const kc = Math.min(COST_PRIOR_STRENGTH, llmCostStrength);
    const cost = p.decisions > 0 && p.spentUsd > 0 ? (p.spentUsd + kc * llmCost) / (p.decisions + kc) : llmCost;
    out.set(slug, {
      alpha: Math.max(1e-3, successes + k2 * llmRate),
      beta: Math.max(1e-3, p.decisions - successes + k2 * (1 - llmRate)),
      costMeanUsd: Math.max(MIN_COST_USD, cost),
      costShape: Math.max(1, (p.spentUsd > 0 ? p.decisions : 0) + llmCostStrength),
    });
  }
  return out;
}

export interface LlmThompson {
  /** This draw's pick (draw 0). */
  pick: string | null;
  /** The LLM most draws pick: the favourite. */
  favourite: string | null;
  /** Share of draws each candidate wins (0..1). */
  shares: Map<string, number>;
}

/** PURE: Thompson sampling on rate per dollar over the candidates' beliefs. */
export function thompsonLlm(beliefs: ReadonlyMap<string, LlmBelief>, seed: string, draws = 1000): LlmThompson {
  const ids = [...beliefs.keys()].sort();
  const shares = new Map(ids.map((id) => [id, 0]));
  if (ids.length === 0) return { pick: null, favourite: null, shares };
  const rng = rngOf(seed);
  let pick: string | null = null;
  for (let i = 0; i < draws; i++) {
    let best = ids[0]!;
    let bestScore = -Infinity;
    for (const id of ids) {
      const b = beliefs.get(id)!;
      const rate = betaDraw(b.alpha, b.beta, rng);
      const cost = (gammaDraw(b.costShape, rng) * b.costMeanUsd) / b.costShape;
      const score = rate / Math.max(cost, MIN_COST_USD);
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    if (i === 0) pick = best;
    shares.set(best, shares.get(best)! + 1);
  }
  for (const id of ids) shares.set(id, shares.get(id)! / draws);
  const favourite = [...shares].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
  return { pick, favourite, shares };
}

// ── The staff read ─────────────────────────────────────────────────────────────────────────────────

/** Days of the daily spend series served per LLM. */
export const SPEND_SERIES_DAYS = 30;

export interface LlmRow {
  llmDynastySlug: string;
  name: string;
  provider: string | null;
  /** In the Engine's universe today. */
  allowed: boolean;
  /** Why it cannot be picked now (null = it can). */
  notPickableReason: "not_in_engine_universe" | "not_served_today" | "vendor_out_of_credit" | null;
  /** 1 = the favourite; null for an LLM that cannot be picked. */
  rank: number | null;
  /** Share of the Rating's draws it wins today (0..1); null when it cannot be picked. */
  shareOfDraws: number | null;
  /** Share of the picks the Rating answered for this Engine in the last `SPEND_SERIES_DAYS` days (0..1); null = no pick recorded. */
  shareOfPicks: number | null;
  picks: number;
  calls: number;
  decisions: number;
  outcomes: number;
  spentUsdToDate: number;
  /** Mean spend per day over the last `SPEND_SERIES_DAYS` days (today included). */
  spentUsdPerDay: number;
  /** One point per day of the last `SPEND_SERIES_DAYS` days, oldest first, zeros included. */
  dailySpend: Array<{ day: string; calls: number; spentUsd: number }>;
  /** LLM spend per Unit made; null with `costPerOutcomeUnavailableReason`. */
  costPerOutcomeUsd: number | null;
  costPerOutcomeUnavailableReason: "no_outcome_yet" | "never_used" | null;
  /** Share of its decisions that made the Unit (0..1); null = never used. */
  outcomeRate: number | null;
  firstCallDay: string | null;
  lastCallDay: string | null;
}

export interface EngineLlmBody {
  outcome: string;
  universe: Universe;
  favourite: { llmDynastySlug: string; name: string } | null;
  /** Places the Engine's scripts named in a pick, with their pick counts (last `SPEND_SERIES_DAYS` days). */
  places: Array<{ place: string; picks: number }>;
  /** Allowed LLMs, ranked (favourite first), then the allowed ones that cannot be picked now. */
  llms: LlmRow[];
  /** Every LLM outside the Engine's universe today (excluded, not served) and every one it used before, with their history (rank null). */
  outsideUniverse: LlmRow[];
  totals: { calls: number; decisions: number; outcomes: number; spentUsdToDate: number };
}

const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

export const lastDays = (today: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => new Date(Date.parse(`${today}T00:00:00Z`) - (n - 1 - i) * DAY_MS).toISOString().slice(0, 10));

/** PURE: one Engine's staff body: its universe, every LLM's ranking and usage, today's favourite. */
export function engineLlmBody(input: {
  outcome: string;
  rules: readonly UniverseRule[];
  lines: readonly LlmLine[];
  evidence: readonly LlmEvidence[];
  picks: readonly PickRecord[];
  outOfCreditProviders: ReadonlySet<string>;
  today: string;
}): EngineLlmBody {
  const { outcome, lines, evidence, today } = input;
  const universe = universeOf(outcome, input.rules, lines);
  const lineOf = new Map(lines.map((l) => [l.slug, l]));
  const evOf = new Map(evidence.map((e) => [e.llmDynastySlug, e]));
  const pickable = (slug: string) => {
    const l = lineOf.get(slug);
    if (!universe.allowed.includes(slug)) return "not_in_engine_universe" as const;
    if (!l?.servedToday) return "not_served_today" as const;
    if (l.provider && input.outOfCreditProviders.has(l.provider.toLowerCase())) return "vendor_out_of_credit" as const;
    return null;
  };
  const candidates = universe.allowed.filter((s) => pickable(s) === null);
  const t = thompsonLlm(llmBeliefs(candidates, evidence, UNPLACED, today), `${outcome}|${today}`);
  const window = lastDays(today, SPEND_SERIES_DAYS);
  const recentPicks = input.picks.filter((p) => p.outcome === outcome && p.day >= window[0]!);
  const picksOf = (slug: string) => recentPicks.filter((p) => p.llmDynastySlug === slug).length;
  const rowOf = (slug: string): LlmRow => {
    const l = lineOf.get(slug);
    const e = evOf.get(slug);
    const days = e?.days ?? [];
    const sum = (f: (d: LlmDay) => number) => days.reduce((s, d) => s + f(d), 0);
    const decisions = sum((d) => d.decisions);
    const outcomes = sum((d) => d.outcomes);
    const spent = sum((d) => d.spentUsd);
    const byDay = new Map(days.map((d) => [d.day, d]));
    const dailySpend = window.map((day) => ({ day, calls: byDay.get(day)?.calls ?? 0, spentUsd: round(byDay.get(day)?.spentUsd ?? 0) }));
    const reason = pickable(slug);
    const p = picksOf(slug);
    return {
      llmDynastySlug: slug,
      name: l?.name ?? slug,
      provider: l?.provider || null,
      allowed: universe.allowed.includes(slug),
      notPickableReason: reason,
      rank: null,
      shareOfDraws: reason === null ? round(t.shares.get(slug) ?? 0, 4) : null,
      shareOfPicks: recentPicks.length > 0 ? round(p / recentPicks.length, 4) : null,
      picks: p,
      calls: sum((d) => d.calls),
      decisions,
      outcomes,
      spentUsdToDate: round(spent),
      spentUsdPerDay: round(dailySpend.reduce((s, d) => s + d.spentUsd, 0) / window.length),
      dailySpend,
      costPerOutcomeUsd: outcomes > 0 ? round(spent / outcomes) : null,
      costPerOutcomeUnavailableReason: outcomes > 0 ? null : decisions > 0 ? "no_outcome_yet" : "never_used",
      outcomeRate: decisions > 0 ? round(sum((d) => Math.min(d.successes, d.decisions)) / decisions, 4) : null,
      firstCallDay: e?.firstCallDay ?? null,
      lastCallDay: e?.lastCallDay ?? null,
    };
  };
  const ranked = candidates
    .map(rowOf)
    .sort((a, b) => (b.shareOfDraws ?? 0) - (a.shareOfDraws ?? 0) || b.spentUsdToDate - a.spentUsdToDate || (a.llmDynastySlug < b.llmDynastySlug ? -1 : 1))
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const allowedNotPickable = universe.allowed.filter((s) => pickable(s) !== null).map(rowOf);
  // Every line outside the universe (excluded, not served) and every LLM it used before, with their history.
  const outsideUniverse = [...new Set([...evidence.map((e) => e.llmDynastySlug), ...lines.map((l) => l.slug)])]
    .filter((s) => !universe.allowed.includes(s))
    .map(rowOf)
    .sort((a, b) => b.spentUsdToDate - a.spentUsdToDate || (a.llmDynastySlug < b.llmDynastySlug ? -1 : 1));
  const placeCounts = new Map<string, number>();
  for (const p of recentPicks) placeCounts.set(p.place, (placeCounts.get(p.place) ?? 0) + 1);
  const all = [...ranked, ...allowedNotPickable, ...outsideUniverse];
  return {
    outcome,
    universe,
    favourite: t.favourite ? { llmDynastySlug: t.favourite, name: lineOf.get(t.favourite)?.name ?? t.favourite } : null,
    places: [...placeCounts].map(([place, picks]) => ({ place, picks })).sort((a, b) => b.picks - a.picks || (a.place < b.place ? -1 : 1)),
    llms: [...ranked, ...allowedNotPickable],
    outsideUniverse,
    totals: {
      calls: all.reduce((s, r) => s + r.calls, 0),
      decisions: evidence.reduce((s, e) => s + e.days.reduce((x, d) => x + d.decisions, 0), 0),
      outcomes: evidence.reduce((s, e) => s + e.days.reduce((x, d) => x + d.outcomes, 0), 0),
      spentUsdToDate: round(all.reduce((s, r) => s + r.spentUsdToDate, 0)),
    },
  };
}

/** PURE: the pick for one LLM call of a run: Thompson over the Engine's pickable universe at that place. */
export function pickLlm(input: {
  outcome: string;
  place: string;
  rules: readonly UniverseRule[];
  lines: readonly LlmLine[];
  evidence: readonly LlmEvidence[];
  outOfCreditProviders: ReadonlySet<string>;
  today: string;
  seed: string;
  /** The campaign's strategy on this subject: a reason = ruled out (tactics), null = kept. Absent = no strategy. */
  ruledOut?: (slug: string) => string | null;
}): { llmDynastySlug: string; candidates: string[]; shares: Map<string, number> } | { llmDynastySlug: null; reason: "no_llm_in_engine_universe"; candidates: string[] } {
  const universe = universeOf(input.outcome, input.rules, input.lines);
  const lineOf = new Map(input.lines.map((l) => [l.slug, l]));
  const candidates = universe.allowed.filter((s) => {
    const l = lineOf.get(s);
    return !!l?.servedToday && !(l.provider && input.outOfCreditProviders.has(l.provider.toLowerCase())) && !input.ruledOut?.(s);
  });
  if (candidates.length === 0) return { llmDynastySlug: null, reason: "no_llm_in_engine_universe", candidates };
  const t = thompsonLlm(llmBeliefs(candidates, input.evidence, input.place, input.today), input.seed, 1);
  return { llmDynastySlug: t.pick!, candidates, shares: t.shares };
}
