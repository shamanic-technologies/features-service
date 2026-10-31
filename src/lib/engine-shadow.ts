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
 * - EVIDENCE IS READ PER DECISION DAY (the daily ledger book): each day FADES with a half-life (`HALF_LIFE_DAYS`) and is
 *   CENSORED like for like: a decision counts for the share of its outcomes already due at its age (outcomes arriving
 *   evenly over the leg's maturity window), a closed one in full.
 * - A BRANCH IS RATED WITH ITS OWN SUB-PICKS AT THEIR BEST (`upliftOf`): its value is multiplied by its best measured
 *   template x LLM combination's outcomes per dollar over the mix it ran (Research Performance rows), capped.
 * - CREDIT THROUGH TRACEABILITY is the ledger's (`lib/ledger-pipe-costs.ts`): an outcome produced off campaign is credited to
 *   the workflow that produced what it consumed (a reply credited to the send).
 *
 * Stated on every served body (`limits`): the uplift reads each workflow's lifetime mix (v10: the last week's), and a
 * belief counts every outcome its decisions have today (the ledger cut is on the decision day). Nothing here changes what runs.
 */
import { createHash } from "node:crypto";
import type { LedgerPipeBook } from "./ledger-pipe-costs.js";

// ── Evidence ───────────────────────────────────────────────────────────────────────────────────────

/** What one workflow did on one pipe, already weighed (a grain: the fleet, or one client). */
export interface Evidence {
  /** Decisions taken (people the workflow worked on the leg), faded by age. */
  decisions: number;
  /** The same decisions censored: each counts for the share of its outcomes already due (like for like per day). */
  trials: number;
  outcomes: number;
  spentUsd: number;
}

export const EMPTY_EVIDENCE: Evidence = { decisions: 0, trials: 0, outcomes: 0, spentUsd: 0 };

/** Old evidence fades: a decision this many days old weighs half (v10 §8: a world that changes is read again). */
export const HALF_LIFE_DAYS = 45;

/** One decision day of one workflow on one pipe (the daily ledger book). */
export interface DayCounts {
  day: string;
  decisions: number;
  outcomes: number;
  spentUsd: number;
}

const DAY = 86_400_000;
const daysBetween = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY;

/** PURE: the share of a decision's outcomes already due at `ageDays`, outcomes arriving evenly over the leg's window. */
export const dueShare = (ageDays: number, maturityDays: number): number => (maturityDays <= 0 ? 1 : Math.max(0, Math.min(1, ageDays / maturityDays)));

/**
 * PURE: a workflow's evidence as it stood on `asOfDay` (decision days strictly before it), each day FADED by its age then
 * (half-life) and CENSORED by its age when its outcomes were counted (`countedOnDay`: the ledger counts every outcome to
 * date): an open decision counts for the share of outcomes already due, a closed one in full (v10 §8 worked example).
 */
export function weighEvidence(days: Iterable<DayCounts>, asOfDay: string, countedOnDay: string, maturityDays: number, halfLifeDays = HALF_LIFE_DAYS): Evidence {
  const out: Evidence = { decisions: 0, trials: 0, outcomes: 0, spentUsd: 0 };
  for (const d of days) {
    if (d.day >= asOfDay) continue;
    const w = Math.pow(0.5, daysBetween(d.day, asOfDay) / halfLifeDays);
    out.decisions += w * d.decisions;
    out.trials += w * d.decisions * dueShare(daysBetween(d.day, countedOnDay), maturityDays);
    out.outcomes += w * d.outcomes;
    out.spentUsd += w * d.spentUsd;
  }
  return out;
}

/** PURE: the trials a grain's decisions are worth (censored). */
export const censoredTrials = (e: Evidence): number => e.trials;

/** PURE: a grain less another one (the fleet without the client), never below zero. */
export function minusEvidence(a: Evidence, b: Evidence | null): Evidence {
  if (!b) return a;
  const sub = (x: number, y: number) => Math.max(0, x - y);
  return { decisions: sub(a.decisions, b.decisions), trials: sub(a.trials, b.trials), outcomes: sub(a.outcomes, b.outcomes), spentUsd: sub(a.spentUsd, b.spentUsd) };
}

export function sumEvidence(list: readonly Evidence[]): Evidence {
  const out: Evidence = { decisions: 0, trials: 0, outcomes: 0, spentUsd: 0 };
  for (const e of list) {
    out.decisions += e.decisions;
    out.trials += e.trials;
    out.outcomes += e.outcomes;
    out.spentUsd += e.spentUsd;
  }
  return out;
}

/**
 * PURE: per (campaign, workflow version, decision day), what one pipe's workflows did, from the DAILY ledger book: the
 * `pipeWorkflowCosts` rule (cost = everything its runs produced in the pipe's campaigns + their no-output spend + its
 * off-campaign outcomes x their own unit cost; decisions = the inputs its runs consumed from outside the pipe, the largest
 * kind; outcomes = the pipe's outcome its runs produced + the off-campaign ones crediting what it produced), each on the
 * day its deciding run started (an off-campaign reply on the day of the send it answers). `unitCost` = the off-campaign
 * unit cost of the outcome over the whole book. Keyed `<campaignId>|<workflowSlug>|<day>`.
 */
export function pipeDailyEvidence(s: string, campaignIds: ReadonlySet<string>, book: LedgerPipeBook, unitCost: number): Map<string, { campaignId: string; workflowSlug: string; day: string } & Omit<DayCounts, "day">> {
  const out = new Map<string, { campaignId: string; workflowSlug: string; day: string; decisions: number; outcomes: number; spentUsd: number }>();
  const row = (c: string, w: string, d: string) => {
    const k = `${c}|${w}|${d}`;
    const e = out.get(k) ?? { campaignId: c, workflowSlug: w, day: d, decisions: 0, outcomes: 0, spentUsd: 0 };
    out.set(k, e);
    return e;
  };
  for (const r of book.produced) {
    if (!r.campaignId || !r.workflowSlug || !r.runStartDay || !campaignIds.has(r.campaignId)) continue;
    const e = row(r.campaignId, r.workflowSlug, r.runStartDay);
    e.spentUsd += r.costUsd;
    if (r.outcomeKey === s) e.outcomes += r.occurrences;
  }
  for (const r of book.noOutput) {
    if (!r.campaignId || !r.workflowSlug || !r.runStartDay || !campaignIds.has(r.campaignId)) continue;
    row(r.campaignId, r.workflowSlug, r.runStartDay).spentUsd += r.costUsd;
  }
  const credit = new Map<string, Map<string, number>>();
  const inputs = new Map<string, Map<string, number>>();
  const bump = (m: Map<string, Map<string, number>>, k: string, kind: string, n: number) => {
    const x = m.get(k) ?? new Map<string, number>();
    x.set(kind, (x.get(kind) ?? 0) + n);
    m.set(k, x);
  };
  for (const c of book.consumed) {
    // A run of no workflow (off campaign, or the reply judge under the campaign it answers) credits what it consumed.
    if (c.workflowSlug === null) {
      if (c.consumerKey !== s || !c.sourceCampaignId || !c.sourceWorkflowSlug || !c.sourceRunStartDay || !campaignIds.has(c.sourceCampaignId)) continue;
      bump(credit, `${c.sourceCampaignId}|${c.sourceWorkflowSlug}|${c.sourceRunStartDay}`, c.consumedKey, c.count);
      continue;
    }
    if (!c.workflowSlug || !c.runStartDay || !campaignIds.has(c.campaignId)) continue;
    if (c.sourceCampaignId !== null && campaignIds.has(c.sourceCampaignId)) continue;
    bump(inputs, `${c.campaignId}|${c.workflowSlug}|${c.runStartDay}`, c.consumedKey, c.count);
  }
  const split = (k: string) => {
    const [c, w, d] = k.split("|");
    return row(c!, w!, d!);
  };
  for (const [k, m] of inputs) split(k).decisions = Math.max(...m.values());
  for (const [k, m] of credit) {
    const n = Math.max(...m.values());
    const e = split(k);
    e.outcomes += n;
    e.spentUsd += n * unitCost;
  }
  return out;
}

// ── Branch uplift ──────────────────────────────────────────────────────────────────────────────────

/** A sub-pick combination's measured figures under one workflow (Research Performance rows: template x LLM). */
export interface SubPickRow {
  outcomes: number;
  spentUsd: number;
}

/** A combination is "at its best" only on this many outcomes of its own (fewer is noise). */
export const UPLIFT_MIN_OUTCOMES = 5;
/** Never more than this: the best sub-pick's edge over the mix is a forecast, capped. */
export const UPLIFT_CAP = 3;

/**
 * PURE: a workflow rated with its own sub-picks at their best (v10 §8): its best measured template x LLM combination's
 * outcomes per dollar over the mix it actually ran (every combination it wrote with), between 1 and `UPLIFT_CAP`. 1 when
 * no combination has `UPLIFT_MIN_OUTCOMES` outcomes or nothing was spent.
 */
export function upliftOf(rows: readonly SubPickRow[]): number {
  const spent = rows.reduce((a, r) => a + r.spentUsd, 0);
  const outcomes = rows.reduce((a, r) => a + r.outcomes, 0);
  if (spent <= 0 || outcomes <= 0) return 1;
  const mix = outcomes / spent;
  const best = Math.max(0, ...rows.filter((r) => r.outcomes >= UPLIFT_MIN_OUTCOMES && r.spentUsd > 0).map((r) => r.outcomes / r.spentUsd));
  return best <= 0 ? 1 : Math.max(1, Math.min(UPLIFT_CAP, best / mix));
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
  /** Its sub-picks at their best over the mix it ran (`upliftOf`, >= 1): multiplies its value. */
  uplift: number;
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
export const scoreValueOf = (c: Pick<EngineCandidate, "valueAddedUsd"> & { uplift?: number }, targetValued: boolean): number => (targetValued ? (c.valueAddedUsd ?? 0) : 1) * (c.uplift ?? 1);

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
  uplift: number;
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
      uplift: round(c.uplift, 3),
      fleetDecisions: round(c.fleet.decisions, 1),
      fleetOutcomes: round(c.fleet.outcomes, 1),
      clientDecisions: c.client ? round(c.client.decisions, 1) : null,
      clientOutcomes: c.client ? round(c.client.outcomes, 1) : null,
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
export const ENGINE_LIMITS = ["uplift_reads_lifetime_mix", "beliefs_count_outcomes_to_date"] as const;
/** The model's knobs, served beside every pick. */
export const ENGINE_MODEL = { halfLifeDays: HALF_LIFE_DAYS, upliftCap: UPLIFT_CAP, upliftMinOutcomes: UPLIFT_MIN_OUTCOMES, draws: THOMPSON_DRAWS } as const;

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
  clientEvidence: "ledger" | "ledger_unreconciled" | "ledger_unreadable";
  limits: readonly string[];
  /** The knobs this pick ran with (`ENGINE_MODEL`). Absent on a body stored before 2026-10-31 tuning. */
  model?: typeof ENGINE_MODEL;
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
    model: ENGINE_MODEL,
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
  model: ENGINE_MODEL,
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

/** One candidate of a family in the replay: its fleet decision days and what the model reads it with. */
export interface ReplayCandidate {
  id: string;
  basePipeId: string;
  channelName: string;
  dynastySlug: string;
  valueAddedUsd: number | null;
  uplift: number;
  expectedCostPerOutcomeUsd: number | null;
  defaultRatePct: number | null;
  /** The leg's maturity window (days): how fast its outcomes come due. */
  maturityDays: number;
  /** Fleet evidence per decision day (every outcome counted to `countedOnDay`). */
  days: readonly DayCounts[];
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
  /** Checkpoints (decision days of the window) the Engine picked on: one per day with decisions. */
  checkpoints: number;
  /** The best measured value per dollar of the window, and whose. Censored like for like: value x (outcomes / due trials)
   *  / (spend per decision), so a workflow run late in the window is not read as worse for its open decisions. */
  bestValuePerDollar: number | null;
  bestCandidateId: string | null;
  /** Today's rule as it ran (the window's decisions as they were split), graded on its GRADABLE picks only:
   *  Σ share x (1 − value per dollar / best) ÷ the gradable share. */
  todayRegret: number | null;
  todayValuePerDollar: number | null;
  /** Share of today's decisions on candidates the window cannot grade (%), never counted as value lost. */
  todayUngradedPct: number | null;
  /** The Engine: each decision day its Thompson shares on the evidence as of that day, graded the same way (gradable
   *  picks only), weighted by that day's decisions. */
  engineRegret: number | null;
  engineValuePerDollar: number | null;
  /** Share of the Engine's picks on candidates the window cannot grade (exploration), never counted as value lost (%). */
  engineUngradedPct: number | null;
  /** today − engine: positive = the Engine would have bought more value per dollar. */
  regretGain: number | null;
  reason: string | null;
}

/** PURE: the window's measured value per dollar of one candidate (censored like for like), or null when not gradable. */
export function windowValuePerDollar(c: ReplayCandidate, sinceDay: string, countedOnDay: string, targetValued: boolean, untilDay: string = countedOnDay): number | null {
  let decisions = 0;
  let trials = 0;
  let outcomes = 0;
  let spent = 0;
  for (const d of c.days) {
    if (d.day < sinceDay || d.day >= untilDay) continue;
    decisions += d.decisions;
    trials += d.decisions * dueShare(daysBetween(d.day, countedOnDay), c.maturityDays);
    outcomes += d.outcomes;
    spent += d.spentUsd;
  }
  const v = targetValued ? (c.valueAddedUsd ?? 0) : 1;
  if (decisions < REPLAY_MIN_DECISIONS || spent <= 0 || trials <= 0 || v <= 0) return null;
  return (v * Math.min(1, outcomes / trials)) / (spent / decisions);
}

/** PURE: a split of picks graded against the best (gradable picks only; the rest reported apart). */
function gradeSplit(split: ReadonlyMap<string, number>, vpd: ReadonlyMap<string, number>, best: number) {
  let graded = 0;
  let regret = 0;
  let value = 0;
  let all = 0;
  for (const [id, w] of split) {
    all += w;
    const v = vpd.get(id);
    if (v === undefined) continue;
    graded += w;
    regret += w * (1 - v / best);
    value += w * v;
  }
  return { graded, all, regret: graded > 0 ? regret / graded : null, value: graded > 0 ? value / graded : null };
}

/**
 * PURE: replay one outcome's Engine over the window, ONE CHECKPOINT PER DECISION DAY: each day the Engine draws on the
 * evidence as of that day (faded, censored), and that day's decisions are split by its pick shares. Grading (the regret
 * proxy, v10 §8 with the measured window in place of the hidden truth) reads gradable picks only: a draw on a workflow
 * the window cannot grade is exploration, reported apart, never counted as value lost.
 */
export function replayFamily(
  outcome: string,
  outcomeName: string,
  candidates: readonly ReplayCandidate[],
  targetValued: boolean,
  window: { sinceDay: string; countedOnDay: string; untilDay?: string },
  seed: string,
  draws = 300,
): ReplayFamily {
  const until = window.untilDay ?? window.countedOnDay;
  const vpd = new Map<string, number>();
  for (const c of candidates) {
    const v = windowValuePerDollar(c, window.sinceDay, window.countedOnDay, targetValued, until);
    if (v !== null) vpd.set(c.id, v);
  }
  const days = [...new Set(candidates.flatMap((c) => c.days.filter((d) => d.day >= window.sinceDay && d.day < until && d.decisions > 0).map((d) => d.day)))].sort();
  const decisionsOn = (c: ReplayCandidate, day: string) => c.days.find((d) => d.day === day)?.decisions ?? 0;
  const windowDecisions = days.reduce((a, day) => a + candidates.reduce((b, c) => b + decisionsOn(c, day), 0), 0);
  const base = { outcome, outcomeName, candidates: candidates.length, graded: vpd.size, windowDecisions: round(windowDecisions, 1), checkpoints: days.length };
  const best = [...vpd].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0] ?? null;
  const none = { bestValuePerDollar: null, bestCandidateId: null, todayRegret: null, todayValuePerDollar: null, todayUngradedPct: null, engineRegret: null, engineValuePerDollar: null, engineUngradedPct: null, regretGain: null };
  if (!best || best[1] <= 0) return { ...base, ...none, reason: vpd.size === 0 ? "no_candidate_graded" : "no_value_measured" };
  const today = gradeSplit(new Map(candidates.map((c) => [c.id, days.reduce((a, day) => a + decisionsOn(c, day), 0)])), vpd, best[1]);
  let eReg = 0;
  let eVal = 0;
  let eW = 0;
  let eUng = 0;
  let eAll = 0;
  for (const day of days) {
    const weight = candidates.reduce((a, c) => a + decisionsOn(c, day), 0);
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
      uplift: c.uplift,
      fleet: weighEvidence(c.days, day, window.countedOnDay, c.maturityDays),
      client: null,
      expectedCostPerOutcomeUsd: c.expectedCostPerOutcomeUsd,
      defaultRatePct: c.defaultRatePct,
    }));
    const byId = new Map(asOf.map((c) => [c.id, c]));
    const t = thompson(placeBeliefs(asOf).beliefs, (id) => scoreValueOf(byId.get(id)!, targetValued), `${seed}|${day}`, draws);
    const g = gradeSplit(t.shares, vpd, best[1]);
    eAll += weight;
    eUng += weight * (g.all > 0 ? (g.all - g.graded) / g.all : 1);
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
    todayUngradedPct: today.all > 0 ? round(((today.all - today.graded) / today.all) * 100, 1) : null,
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
  /** The window's decision days [sinceDay, untilDay): it ends where runs-service's stored decision days end. */
  window?: { sinceDay: string; untilDay: string };
  /** Decision days the Engine picked on (each day of the window). */
  checkpoints: string[];
  families: ReplayFamily[];
  /** Over every family with both regrets, weighted by window decisions. */
  totals: { todayRegret: number | null; engineRegret: number | null; regretGain: number | null; families: number };
  caveats: readonly string[];
  /** runs-service's ledger was reconciled for the read (false = read anyway, `ledgerDaysMissing` days stale). */
  ledgerReconciled?: boolean;
  ledgerDaysMissing?: number;
  /** The knobs the replay ran with. */
  model?: typeof ENGINE_MODEL;
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

export const REPLAY_CAVEATS = ["beliefs_count_outcomes_to_date", "candidates_are_todays_selectable_workflows", "uplift_reads_lifetime_mix"] as const;

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
