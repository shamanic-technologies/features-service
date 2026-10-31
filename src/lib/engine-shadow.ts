/**
 * GTM FACTORY P5.3: ONE ENGINE PER OUTCOME, SHADOW ONLY (owner 2026-10-31, ENGINE-PER-OUTCOME-SHADOW; GTM Factory v10
 * framework sections 2, 3 and 8). PURE; the IO lives in `routes/factory-shadow.ts` (the stored 3-hourly pass), the daily
 * counts in `factory_shadow_daily` (migration 0058), the replay in the fleet cell `engine-shadow:replay`.
 *
 * Today the choice happens per PIPE: the plan picks one pipe per leg, then features picks the best-ROI workflow inside it
 * (the leg workflow ranking's `goesFirst`). In v10 an ENGINE makes one outcome and every script producing it competes:
 *
 * - A CANDIDATE PLACE is (consuming Engine, outcome it calls): per campaign, each leg of the line it runs, up to its Target,
 *   whose outcome is the leg's `to` step and whose consumer is the next leg's outcome (the campaign itself at the Target).
 * - Its CANDIDATES are every workflow dynasty of every pipe WE run whose leg ends on that outcome, under the campaign's brief
 *   verdicts (a pipe the pipe judge rules out never enters; a pipe the play judge narrowed offers only its play's
 *   workflows), runnable today (`selectable` on the leg ranking), starting from a step the campaign holds (Start, Lead
 *   found, its start step, or a step its line reaches before the outcome), and answering the campaign's trigger when the
 *   pipe needs one.
 * - THE PICK is Thompson sampling on value per dollar: draw a rate (share of decisions reaching the outcome) and a cost
 *   (per decision) from each candidate's belief, score rate x value added / cost, take the highest. The value added is the
 *   outcome's catalogue value on the offer's lifetime revenue less the value of the step the candidate starts from (the
 *   catalogue's `valueAddedTo`); a Target with no value (after Paid client) scores rate / cost.
 * - BELIEFS ARE POOLED: place (every candidate of the outcome, fleet) -> pipe -> workflow (fleet, the client's own runs
 *   taken out) -> the client (its own runs on that workflow, the ledger at the brand's campaigns). Each level is pulled
 *   toward the one above with a strength fitted from the spread between its siblings (method of moments), combined with
 *   how sure the level above is (variances add): a candidate with little data keeps a wide belief and is explored.
 * - DELAYS ARE CENSORED: a decision older than its leg's maturity window counts in full; a younger one counts for
 *   `YOUNG_DUE_SHARE` of a trial (decisions spread evenly over the window, outcomes arriving evenly over it).
 * - CREDIT THROUGH TRACEABILITY is the ledger's (`lib/ledger-pipe-costs.ts`): an outcome produced off campaign is credited to
 *   the workflow that produced what it consumed (a reply credited to the send).
 *
 * Not modelled yet, said so on every served body (`limits`): the half-life fade of old evidence, the like-for-like day
 * reading, and the uplift of a branch by its own sub-picks at their best (v10 section 8). Nothing here changes what runs.
 */
import { createHash } from "node:crypto";

// ── Evidence ───────────────────────────────────────────────────────────────────────────────────────

/** What one workflow did on one pipe (a grain: the fleet, or one client). */
export interface Evidence {
  /** Decisions taken (people the workflow worked on the leg: the ledger's inputs). */
  decisions: number;
  outcomes: number;
  spentUsd: number;
  /** The same counts on decisions older than the leg's maturity window; null = not cut (every decision counts in full). */
  matureDecisions: number | null;
  matureOutcomes: number | null;
}

export const EMPTY_EVIDENCE: Evidence = { decisions: 0, outcomes: 0, spentUsd: 0, matureDecisions: 0, matureOutcomes: 0 };

/** A decision younger than its leg's window counts for this share of a trial (uniform ages, uniform arrival). */
export const YOUNG_DUE_SHARE = 0.5;

/** PURE: the trials a grain's decisions are worth once each young one counts for the share of outcomes already due. */
export function censoredTrials(e: Evidence): number {
  if (e.matureDecisions === null) return e.decisions;
  const mature = Math.min(e.matureDecisions, e.decisions);
  return mature + (e.decisions - mature) * YOUNG_DUE_SHARE;
}

/** PURE: a grain less another one (the fleet without the client), never below zero. */
export function minusEvidence(a: Evidence, b: Evidence | null): Evidence {
  if (!b) return a;
  const sub = (x: number, y: number) => Math.max(0, x - y);
  return {
    decisions: sub(a.decisions, b.decisions),
    outcomes: sub(a.outcomes, b.outcomes),
    spentUsd: sub(a.spentUsd, b.spentUsd),
    matureDecisions: a.matureDecisions === null ? null : sub(a.matureDecisions, b.matureDecisions ?? 0),
    matureOutcomes: a.matureOutcomes === null ? null : sub(a.matureOutcomes, b.matureOutcomes ?? 0),
  };
}

export function sumEvidence(list: readonly Evidence[]): Evidence {
  const out: Evidence = { decisions: 0, outcomes: 0, spentUsd: 0, matureDecisions: 0, matureOutcomes: 0 };
  for (const e of list) {
    out.decisions += e.decisions;
    out.outcomes += e.outcomes;
    out.spentUsd += e.spentUsd;
    out.matureDecisions = out.matureDecisions === null || e.matureDecisions === null ? null : out.matureDecisions + e.matureDecisions;
    out.matureOutcomes = out.matureOutcomes === null || e.matureOutcomes === null ? null : out.matureOutcomes + e.matureOutcomes;
  }
  return out;
}

// ── Candidates and beliefs ─────────────────────────────────────────────────────────────────────────

export interface EngineCandidate {
  /** `<base pipe id>::<workflow dynasty>`. */
  id: string;
  basePipeId: string;
  /** The pipe or play it runs under (a play when the brief picked one). */
  pipeId: string;
  channelSlug: string;
  channelName: string;
  legKey: string;
  fromStep: string | null;
  dynastySlug: string;
  dynastyName: string | null;
  /** Outcome value less the value of the step it starts from; null = not valued (the Target has no value). */
  valueAddedUsd: number | null;
  /** The fleet's evidence on this workflow on this pipe (the client's included). */
  fleet: Evidence;
  /** The client's own evidence; null = not read (the ledger unreadable). */
  client: Evidence | null;
  /** The pipe's stated cost per outcome (the catalogue's expected cost), the cost prior of a pipe that never spent. */
  expectedCostPerOutcomeUsd: number | null;
  /** The catalogue's leg rate (%), the rate prior of a place nobody worked. */
  defaultRatePct: number | null;
}

export interface Belief {
  /** Beta on the rate. */
  alpha: number;
  beta: number;
  /** Gamma on the cost per decision (USD): mean and shape. */
  costMeanUsd: number;
  costShape: number;
}

/** Prior strength used when the siblings cannot fit one (fewer than two with data): the v10 worked example's 200 trials. */
export const DEFAULT_STRENGTH = 200;
/** Strength of the catalogue's default rate at the top of the tree. */
export const CATALOGUE_STRENGTH = 20;
/** Pseudo-decisions behind a cost prior at each level. */
export const COST_STRENGTH = 20;
const MIN_GROUP_TRIALS = 10;
const MIN_COST_USD = 0.0001;

/**
 * PURE: how strongly the siblings of one level pull toward their pooled mean (pseudo-trials), fitted by the method of
 * moments: the spread of their rates beyond what binomial noise explains. Little spread = strong pooling.
 */
export function fitStrength(groups: ReadonlyArray<{ successes: number; trials: number }>): number {
  const g = groups.filter((x) => x.trials >= MIN_GROUP_TRIALS);
  if (g.length < 2) return DEFAULT_STRENGTH;
  const n = g.reduce((s, x) => s + x.trials, 0);
  const m = Math.min(1, g.reduce((s, x) => s + x.successes, 0) / n);
  if (m <= 0 || m >= 1) return DEFAULT_STRENGTH;
  const observed = g.reduce((s, x) => s + x.trials * (Math.min(1, x.successes / x.trials) - m) ** 2, 0) / n;
  const noise = (m * (1 - m) * g.length) / n;
  const between = observed - noise;
  if (between <= 0) return 1000;
  return Math.min(1000, Math.max(5, (m * (1 - m)) / between - 1));
}

const rateOf = (s: number, n: number, prior: number, k: number) => (s + k * prior) / (n + k);
/** The pull of a level's prior: its siblings' fitted spread AND how sure the level above is, combined as variances add
 *  (a prior resting on little data cannot pull hard, so a new candidate keeps a wide belief). */
const pull = (fitted: number, above: number) => 1 / (1 / fitted + 1 / Math.max(above, 1e-9));
const costOf = (spent: number, n: number, prior: number, k: number) => (spent + k * prior) / (n + k);

export interface PlaceBeliefs {
  beliefs: Map<string, Belief>;
  /** Candidates nothing can price (no spend anywhere at the place, no stated cost): never picked. */
  unpriced: string[];
  strengths: { pipe: number; workflow: number };
}

/** PURE: every candidate's belief at one place, pooled place -> pipe -> workflow -> client. */
export function placeBeliefs(candidates: readonly EngineCandidate[]): PlaceBeliefs {
  const own = (c: EngineCandidate) => minusEvidence(c.fleet, c.client);
  // Place: every candidate's fleet evidence, toward the catalogue's leg rate.
  const placeEv = sumEvidence(candidates.map((c) => c.fleet));
  const defaults = candidates.map((c) => c.defaultRatePct).filter((v): v is number => v !== null && v > 0);
  const defaultRate = defaults.length > 0 ? defaults.reduce((a, b) => a + b, 0) / defaults.length / 100 : 0.01;
  const placeTrials = censoredTrials(placeEv);
  const placeRate = rateOf(placeEv.outcomes, placeTrials, defaultRate, CATALOGUE_STRENGTH);
  const placeStrength = placeTrials + CATALOGUE_STRENGTH;
  // Pipes.
  const byPipe = new Map<string, EngineCandidate[]>();
  for (const c of candidates) byPipe.set(c.basePipeId, [...(byPipe.get(c.basePipeId) ?? []), c]);
  const pipeEv = new Map([...byPipe].map(([id, cs]) => [id, sumEvidence(cs.map((c) => c.fleet))]));
  const pipeStrengthFit = fitStrength([...pipeEv.values()].map((e) => ({ successes: e.outcomes, trials: censoredTrials(e) })));
  const workflowStrengthFit = fitStrength(candidates.map((c) => ({ successes: c.fleet.outcomes, trials: censoredTrials(c.fleet) })));
  // Cost prior at the place: its spend per decision; else the stated costs per outcome at the default rate.
  const stated = candidates
    .filter((c) => c.expectedCostPerOutcomeUsd !== null && c.expectedCostPerOutcomeUsd > 0)
    .map((c) => c.expectedCostPerOutcomeUsd! * ((c.defaultRatePct ?? defaultRate * 100) / 100));
  const placeCost = placeEv.decisions > 0 && placeEv.spentUsd > 0 ? placeEv.spentUsd / placeEv.decisions : stated.length > 0 ? stated.reduce((a, b) => a + b, 0) / stated.length : null;
  const beliefs = new Map<string, Belief>();
  const unpriced: string[] = [];
  for (const [pipeId, cs] of byPipe) {
    const pe = pipeEv.get(pipeId)!;
    const pTrials = censoredTrials(pe);
    const k1 = pull(pipeStrengthFit, placeStrength);
    const pipeRate = rateOf(pe.outcomes, pTrials, placeRate, k1);
    const pipeStrength = pTrials + k1;
    const statedPipe = cs[0]!.expectedCostPerOutcomeUsd;
    const pipeCostPrior = statedPipe !== null && statedPipe > 0 ? statedPipe * pipeRate : placeCost;
    const pipeCost = pe.decisions > 0 && pe.spentUsd > 0 ? costOf(pe.spentUsd, pe.decisions, pipeCostPrior ?? pe.spentUsd / pe.decisions, COST_STRENGTH) : pipeCostPrior;
    const pipeCostStrength = (pe.spentUsd > 0 ? pe.decisions : 0) + COST_STRENGTH;
    for (const c of cs) {
      if (pipeCost === null) {
        unpriced.push(c.id);
        continue;
      }
      const w = own(c);
      const wTrials = censoredTrials(w);
      const k2 = pull(workflowStrengthFit, pipeStrength);
      const wRate = rateOf(w.outcomes, wTrials, pipeRate, k2);
      const wStrength = wTrials + k2;
      const kc2 = Math.min(COST_STRENGTH, pipeCostStrength);
      const wCost = w.spentUsd > 0 && w.decisions > 0 ? costOf(w.spentUsd, w.decisions, pipeCost, kc2) : pipeCost;
      const wCostStrength = (w.spentUsd > 0 ? w.decisions : 0) + kc2;
      const cl = c.client ?? EMPTY_EVIDENCE;
      const clTrials = censoredTrials(cl);
      const k3 = pull(workflowStrengthFit, wStrength);
      const clOutcomes = Math.min(cl.outcomes, clTrials);
      const kc3 = Math.min(COST_STRENGTH, wCostStrength);
      const cost = cl.spentUsd > 0 && cl.decisions > 0 ? costOf(cl.spentUsd, cl.decisions, wCost, kc3) : wCost;
      beliefs.set(c.id, {
        alpha: Math.max(1e-3, clOutcomes + k3 * wRate),
        beta: Math.max(1e-3, clTrials - clOutcomes + k3 * (1 - wRate)),
        costMeanUsd: Math.max(MIN_COST_USD, cost),
        costShape: Math.max(1, (cl.spentUsd > 0 ? cl.decisions : 0) + kc3),
      });
    }
  }
  return { beliefs, unpriced: unpriced.sort(), strengths: { pipe: round(pipeStrengthFit), workflow: round(workflowStrengthFit) } };
}

// ── Thompson sampling ──────────────────────────────────────────────────────────────────────────────

/** PURE: a seeded uniform generator (mulberry32): one tick's draws are the same on every replay of that tick. */
export function rngOf(seed: string): () => number {
  let a = parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** PURE: a Gamma(shape, 1) draw (Marsaglia-Tsang). */
export function gammaDraw(shape: number, rng: () => number): number {
  if (shape < 1) return gammaDraw(shape + 1, rng) * Math.pow(Math.max(rng(), 1e-12), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export const betaDraw = (a: number, b: number, rng: () => number): number => {
  const x = gammaDraw(a, rng);
  return x / (x + gammaDraw(b, rng));
};

/** Draws behind each pick share (the tick's own pick is draw 0). */
export const THOMPSON_DRAWS = 1000;

export interface ThompsonResult {
  /** This tick's pick: the first draw. Null with no priced candidate. */
  tickPick: string | null;
  /** The candidate most draws pick. */
  modalPick: string | null;
  /** Share of draws each candidate wins (0..1). */
  shares: Map<string, number>;
}

/** PURE: Thompson sampling on value per dollar over the priced candidates. */
export function thompson(beliefs: ReadonlyMap<string, Belief>, valueOf: (id: string) => number, seed: string, draws = THOMPSON_DRAWS): ThompsonResult {
  const ids = [...beliefs.keys()].filter((id) => valueOf(id) > 0).sort();
  const shares = new Map(ids.map((id) => [id, 0]));
  if (ids.length === 0) return { tickPick: null, modalPick: null, shares };
  const rng = rngOf(seed);
  let tickPick: string | null = null;
  for (let i = 0; i < draws; i++) {
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const id of ids) {
      const b = beliefs.get(id)!;
      const rate = betaDraw(b.alpha, b.beta, rng);
      const cost = (gammaDraw(b.costShape, rng) * b.costMeanUsd) / b.costShape;
      const score = (rate * valueOf(id)) / Math.max(cost, MIN_COST_USD);
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    if (i === 0) tickPick = best;
    shares.set(best!, shares.get(best!)! + 1);
  }
  for (const id of ids) shares.set(id, shares.get(id)! / draws);
  const modalPick = [...shares].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
  return { tickPick, modalPick, shares };
}

/** PURE: the value a candidate's score multiplies (its value added; 1 on an unvalued Target, which ranks on cost). */
export const scoreValueOf = (c: Pick<EngineCandidate, "valueAddedUsd">, targetValued: boolean): number => (targetValued ? (c.valueAddedUsd ?? 0) : 1);

// ── One place, served ──────────────────────────────────────────────────────────────────────────────

export interface EnginePickRef {
  candidateId: string;
  pipeId: string;
  channelName: string;
  workflowDynastySlug: string;
  workflowDynastyName: string | null;
}

export interface EngineCandidateRow extends EnginePickRef {
  fromStep: string | null;
  valueAddedUsd: number | null;
  fleetDecisions: number;
  fleetOutcomes: number;
  clientDecisions: number | null;
  clientOutcomes: number | null;
  /** The belief's means: rate (%), cost per decision (USD), value per dollar (value added x rate / cost). */
  rateMeanPct: number | null;
  costPerDecisionMeanUsd: number | null;
  valuePerDollarMean: number | null;
  /** Share of the Thompson draws it wins (%); null when it cannot be priced. */
  pickSharePct: number | null;
  isToday: boolean;
  isEnginePick: boolean;
}

export interface EnginePlace {
  /** The outcome this place calls (a catalogue step) and who calls it (the next outcome, or `campaign` at the Target). */
  outcome: string;
  outcomeName: string;
  consumer: string;
  consumerName: string;
  /** Today's pick: the pipe the campaign runs on this leg and its best-ROI workflow (the leg ranking's `goesFirst`). */
  today: EnginePickRef | null;
  todayUnavailableReason: string | null;
  /** The Engine's pick on this tick (one Thompson draw) and the pick most draws make. */
  engine: EnginePickRef | null;
  engineModal: EnginePickRef | null;
  /** Today's pick is the Engine's pick on this tick; null when either is missing. */
  agrees: boolean | null;
  /** Share of Thompson draws that pick today's pick (%): the expected agreement. */
  todayPickSharePct: number | null;
  /** `ok`, or why no Engine pick: `no_candidate`, `no_candidate_priced`. A not-yet, never a failure. */
  state: "ok" | "no_candidate" | "no_candidate_priced";
  candidates: EngineCandidateRow[];
  strengths: { pipe: number; workflow: number };
}

/** PURE: one place's Thompson pick beside today's. */
export function enginePlaceOf(
  input: { outcome: string; outcomeName: string; consumer: string; consumerName: string; targetValued: boolean; seed: string },
  candidates: readonly EngineCandidate[],
  today: { candidateId: string | null; ref: EnginePickRef | null; unavailableReason: string | null },
): EnginePlace {
  const pooled = placeBeliefs(candidates);
  const valueOf = (id: string) => scoreValueOf(candidates.find((c) => c.id === id)!, input.targetValued);
  const t = thompson(pooled.beliefs, valueOf, input.seed);
  const refOf = (id: string | null): EnginePickRef | null => {
    const c = id ? candidates.find((x) => x.id === id) : undefined;
    return c ? { candidateId: c.id, pipeId: c.pipeId, channelName: c.channelName, workflowDynastySlug: c.dynastySlug, workflowDynastyName: c.dynastyName } : null;
  };
  const rows: EngineCandidateRow[] = candidates.map((c) => {
    const b = pooled.beliefs.get(c.id) ?? null;
    const rate = b ? b.alpha / (b.alpha + b.beta) : null;
    const v = scoreValueOf(c, input.targetValued);
    return {
      ...refOf(c.id)!,
      fromStep: c.fromStep,
      valueAddedUsd: c.valueAddedUsd,
      fleetDecisions: c.fleet.decisions,
      fleetOutcomes: c.fleet.outcomes,
      clientDecisions: c.client?.decisions ?? null,
      clientOutcomes: c.client?.outcomes ?? null,
      rateMeanPct: rate === null ? null : round(rate * 100, 4),
      costPerDecisionMeanUsd: b ? round(b.costMeanUsd, 4) : null,
      valuePerDollarMean: b && rate !== null ? round((rate * v) / b.costMeanUsd, 4) : null,
      pickSharePct: t.shares.has(c.id) ? round(t.shares.get(c.id)! * 100, 1) : null,
      isToday: c.id === today.candidateId,
      isEnginePick: c.id === t.tickPick,
    };
  });
  rows.sort((a, b) => (b.pickSharePct ?? -1) - (a.pickSharePct ?? -1) || (a.candidateId < b.candidateId ? -1 : 1));
  const state: EnginePlace["state"] = candidates.length === 0 ? "no_candidate" : t.tickPick === null ? "no_candidate_priced" : "ok";
  return {
    outcome: input.outcome,
    outcomeName: input.outcomeName,
    consumer: input.consumer,
    consumerName: input.consumerName,
    today: today.ref,
    todayUnavailableReason: today.unavailableReason,
    engine: refOf(t.tickPick),
    engineModal: refOf(t.modalPick),
    agrees: today.candidateId && t.tickPick ? today.candidateId === t.tickPick : null,
    todayPickSharePct: today.candidateId && t.tickPick ? round((t.shares.get(today.candidateId) ?? 0) * 100, 1) : null,
    state,
    candidates: rows,
    strengths: pooled.strengths,
  };
}

/** What the served body says the model does not do yet (v10 section 8), so nobody reads it as the whole rule. */
export const ENGINE_LIMITS = ["no_half_life_fade", "no_like_for_like_day_reading", "no_branch_uplift"] as const;

export interface EngineShadow {
  computedAt: string;
  /** `ok`; `failed` = the Engine could not be computed for this campaign (red on Monitoring). */
  status: "ok" | "failed";
  failure: string | null;
  places: EnginePlace[];
  /** Places with both picks, and those where they agree. */
  comparable: number;
  agreed: number;
  /** Mean share of draws picking today's pick over the comparable places (%). */
  expectedAgreementPct: number | null;
  /** Client evidence read on the ledger (else the client level is empty and the fleet decides). */
  clientEvidence: "ledger" | "ledger_unreadable";
  limits: readonly string[];
}

/** PURE: a campaign's Engine summary from its places. */
export function engineShadowOf(places: EnginePlace[], computedAt: string, clientEvidence: EngineShadow["clientEvidence"]): EngineShadow {
  const comparable = places.filter((p) => p.agrees !== null);
  return {
    computedAt,
    status: "ok",
    failure: null,
    places,
    comparable: comparable.length,
    agreed: comparable.filter((p) => p.agrees === true).length,
    expectedAgreementPct: comparable.length === 0 ? null : round(comparable.reduce((s, p) => s + (p.todayPickSharePct ?? 0), 0) / comparable.length, 1),
    clientEvidence,
    limits: ENGINE_LIMITS,
  };
}

export const failedEngineShadow = (failure: string, computedAt: string): EngineShadow => ({
  computedAt,
  status: "failed",
  failure: failure.slice(0, 500),
  places: [],
  comparable: 0,
  agreed: 0,
  expectedAgreementPct: null,
  clientEvidence: "ledger_unreadable",
  limits: ENGINE_LIMITS,
});

/** One org's Engine counts for the day (summed into the fleet series). */
export interface EngineDayCounts {
  enginePlaces: number;
  engineAgreed: number;
  /** Σ over comparable places of the share of draws picking today's pick (0..1). */
  engineTodayShareSum: number;
  engineFailed: number;
}

/** PURE: per org, the day's Engine counts. */
export function engineDayCountsOf(rows: ReadonlyArray<{ orgId: string; engine?: EngineShadow | null }>): Map<string, EngineDayCounts> {
  const out = new Map<string, EngineDayCounts>();
  for (const r of rows) {
    const c = out.get(r.orgId) ?? { enginePlaces: 0, engineAgreed: 0, engineTodayShareSum: 0, engineFailed: 0 };
    if (r.engine?.status === "failed") c.engineFailed += 1;
    for (const p of r.engine?.places ?? []) {
      if (p.agrees === null) continue;
      c.enginePlaces += 1;
      if (p.agrees) c.engineAgreed += 1;
      c.engineTodayShareSum += (p.todayPickSharePct ?? 0) / 100;
    }
    out.set(r.orgId, c);
  }
  return out;
}

// ── The replay ─────────────────────────────────────────────────────────────────────────────────────

/** One candidate of a family in the replay: what it had as of each checkpoint, and what it did in the window. */
export interface ReplayCandidate {
  id: string;
  basePipeId: string;
  channelName: string;
  dynastySlug: string;
  valueAddedUsd: number | null;
  expectedCostPerOutcomeUsd: number | null;
  defaultRatePct: number | null;
  /** Fleet evidence as of each checkpoint (decisions started before it, every outcome they have now). */
  asOf: Evidence[];
  /** Decisions, outcomes and spend of the decisions taken in each checkpoint's following period (what ran). */
  period: Array<{ decisions: number; outcomes: number; spentUsd: number }>;
}

/** A candidate's window is graded only on this many decisions at least. */
export const REPLAY_MIN_DECISIONS = 20;

export interface ReplayFamily {
  outcome: string;
  outcomeName: string;
  candidates: number;
  /** Candidates with enough window decisions and spend to measure a value per dollar. */
  graded: number;
  windowDecisions: number;
  /** The best measured value per dollar of the window (value added x outcomes / spend), and whose. */
  bestValuePerDollar: number | null;
  bestCandidateId: string | null;
  /** Today's rule, as it ran: the window's decisions as they were split, graded (1 - value per dollar / best). */
  todayRegret: number | null;
  todayValuePerDollar: number | null;
  /** Share of today's window decisions on candidates too thin to grade (%). */
  todayUngradedPct: number | null;
  /** The Engine: at each checkpoint its Thompson pick shares on the evidence as of then, graded the same way, each period
   *  weighted by the decisions taken in it. */
  engineRegret: number | null;
  engineValuePerDollar: number | null;
  /** Share of the Engine's picks on candidates the window cannot grade (exploration) (%). */
  engineUngradedPct: number | null;
  /** today − engine: positive = the Engine would have bought more value per dollar. */
  regretGain: number | null;
  reason: string | null;
}

/**
 * PURE: replay one outcome's Engine over the window. Grading (the regret proxy, v10 section 8 with the measured window in
 * place of the hidden truth): a candidate's value per dollar = value added x its window outcomes / its window spend; the
 * regret of a split = Σ share x (1 - its value per dollar / the best's), over the graded candidates.
 */
export function replayFamily(outcome: string, outcomeName: string, candidates: readonly ReplayCandidate[], targetValued: boolean, seed: string, draws = 400): ReplayFamily {
  const periods = candidates[0]?.period.length ?? 0;
  const windowOf = (c: ReplayCandidate) => c.period.reduce((s, p) => ({ decisions: s.decisions + p.decisions, outcomes: s.outcomes + p.outcomes, spentUsd: s.spentUsd + p.spentUsd }), { decisions: 0, outcomes: 0, spentUsd: 0 });
  const vpd = new Map<string, number>();
  for (const c of candidates) {
    const w = windowOf(c);
    const v = scoreValueOf(c, targetValued);
    if (w.decisions >= REPLAY_MIN_DECISIONS && w.spentUsd > 0 && v > 0) vpd.set(c.id, (v * w.outcomes) / w.spentUsd);
  }
  const windowDecisions = candidates.reduce((s, c) => s + windowOf(c).decisions, 0);
  const base = { outcome, outcomeName, candidates: candidates.length, graded: vpd.size, windowDecisions };
  const best = [...vpd].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0] ?? null;
  const none = { bestValuePerDollar: null, bestCandidateId: null, todayRegret: null, todayValuePerDollar: null, todayUngradedPct: null, engineRegret: null, engineValuePerDollar: null, engineUngradedPct: null, regretGain: null };
  if (!best || best[1] <= 0) return { ...base, ...none, reason: vpd.size === 0 ? "no_candidate_graded" : "no_value_measured" };
  const grade = (split: ReadonlyMap<string, number>) => {
    let graded = 0;
    let regret = 0;
    let value = 0;
    let all = 0;
    for (const [id, w] of split) {
      all += w;
      const v = vpd.get(id);
      if (v === undefined) continue;
      graded += w;
      regret += w * (1 - v / best[1]);
      value += w * v;
    }
    return graded > 0 ? { regret: regret / graded, value: value / graded, ungradedPct: all > 0 ? ((all - graded) / all) * 100 : 0, weight: all } : { regret: null, value: null, ungradedPct: all > 0 ? 100 : null, weight: all };
  };
  const today = grade(new Map(candidates.map((c) => [c.id, windowOf(c).decisions])));
  let eReg = 0;
  let eVal = 0;
  let eW = 0;
  let eUng = 0;
  let eAll = 0;
  for (let k = 0; k < periods; k++) {
    const weight = candidates.reduce((s, c) => s + c.period[k]!.decisions, 0);
    if (weight <= 0) continue;
    const asOf: EngineCandidate[] = candidates.map((c) => ({
      id: c.id,
      basePipeId: c.basePipeId,
      pipeId: c.basePipeId,
      channelSlug: c.basePipeId,
      channelName: c.channelName,
      legKey: c.basePipeId,
      fromStep: null,
      dynastySlug: c.dynastySlug,
      dynastyName: null,
      valueAddedUsd: c.valueAddedUsd,
      fleet: c.asOf[k]!,
      client: null,
      expectedCostPerOutcomeUsd: c.expectedCostPerOutcomeUsd,
      defaultRatePct: c.defaultRatePct,
    }));
    const pooled = placeBeliefs(asOf);
    const t = thompson(pooled.beliefs, (id) => scoreValueOf(candidates.find((c) => c.id === id)!, targetValued), `${seed}|${k}`, draws);
    const g = grade(t.shares);
    eAll += weight;
    eUng += weight * ((g.ungradedPct ?? 100) / 100);
    if (g.regret === null) continue;
    eReg += weight * g.regret;
    eVal += weight * g.value!;
    eW += weight;
  }
  const engineRegret = eW > 0 ? eReg / eW : null;
  return {
    ...base,
    bestValuePerDollar: round(best[1], 4),
    bestCandidateId: best[0],
    todayRegret: today.regret === null ? null : round(today.regret, 4),
    todayValuePerDollar: today.value === null ? null : round(today.value, 4),
    todayUngradedPct: today.ungradedPct === null ? null : round(today.ungradedPct, 1),
    engineRegret: engineRegret === null ? null : round(engineRegret, 4),
    engineValuePerDollar: eW > 0 ? round(eVal / eW, 4) : null,
    engineUngradedPct: eAll > 0 ? round((eUng / eAll) * 100, 1) : null,
    regretGain: today.regret !== null && engineRegret !== null ? round(today.regret - engineRegret, 4) : null,
    reason: null,
  };
}

export interface EngineReplay {
  computedAt: string;
  windowDays: number;
  /** Run-start days the beliefs were read as of (each period runs to the next one, the last to today). */
  checkpoints: string[];
  families: ReplayFamily[];
  /** Over every graded family, weighted by window decisions. */
  totals: { todayRegret: number | null; engineRegret: number | null; regretGain: number | null; families: number };
  /** Beliefs as of a checkpoint read the outcomes those decisions have NOW (the ledger cut is on run start). */
  caveats: readonly string[];
  failure: string | null;
}

/** PURE: the fleet totals of a replay. */
export function replayTotals(families: readonly ReplayFamily[]): EngineReplay["totals"] {
  const graded = families.filter((f) => f.todayRegret !== null && f.engineRegret !== null);
  const w = graded.reduce((s, f) => s + f.windowDecisions, 0);
  if (w === 0) return { todayRegret: null, engineRegret: null, regretGain: null, families: 0 };
  const today = graded.reduce((s, f) => s + f.windowDecisions * f.todayRegret!, 0) / w;
  const engine = graded.reduce((s, f) => s + f.windowDecisions * f.engineRegret!, 0) / w;
  return { todayRegret: round(today, 4), engineRegret: round(engine, 4), regretGain: round(today - engine, 4), families: graded.length };
}

export const REPLAY_CAVEATS = [
  "beliefs_read_later_outcomes_of_earlier_decisions",
  "window_outcomes_still_maturing",
  "candidates_are_todays_selectable_workflows",
] as const;

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
