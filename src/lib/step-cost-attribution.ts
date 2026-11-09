/**
 * WHAT EACH OUTCOME STEP COST, PROCESS COSTING (owner 2026-11-09, OUTCOME-COST-CUMUL-1109: « est-ce normal en compta
 * industrielle analytique que le même spent soit sur plusieurs lignes ? », then « go »). PURE.
 *
 * Before: every step of the outcome cost series served the scope's WHOLE spend as its `$ Spent` (Leads found carried
 * the emails, replies and booking spend that happen after it) and divided it by every Unit of the step, another
 * factory's included, so `$ / outcome` and `$ Spent` did not reconcile on one row.
 *
 * Now, one mechanism for every step of every scope:
 *   1. TRACED cost of a step = the ledger's own production cost (runs-service, allocation v6) of the step's own Units,
 *      + the inputs it is the FIRST step to consume on the ledger's consumption graph (found and checked emails make a
 *      Lead found; written messages are first consumed toward a Website visit), + any other Unit made by a campaign
 *      whose catalogue leg ends on the step (`stepTracedCostOf`). A key on no step (a post, a newsletter) traces to none.
 *   2. The scope's WHOLE spend (the `$ Spent` the page shows at the last step) is ABSORBED onto the steps pro rata their
 *      traced cost (an overhead absorption rate on direct cost): what no step traced (support, undeclared, loss,
 *      brand-level work) rides the steps in the same proportion. Σ steps' own spend = the scope's spend, to the cent.
 *   3. $ Spent of a step = its own spend + every step ABOVE it in the chain (Lead found first, Paid client last), never
 *      a step below: non-decreasing down the chain, the last step = the scope's whole spend.
 * When nothing traces to a step (ledger unreadable, or no Unit on a step yet), the whole spend enters at the first step
 * (Lead found), so every step carries it, with the reason stated.
 */
import { STEP_COST_CHAIN, type OutcomeCostStep } from "./outcome-cost-series.js";
import { ledgerKeysOfStep } from "./ledger-counts.js";
import { leadStateOf } from "./lead-states.js";

export { STEP_COST_CHAIN };

/**
 * PURE. The step a ledger outcome key belongs to: the step it IS (or counts, `ledgerKeysOfStep`), else the FIRST step
 * of the chain reaching the same lead state (Lead interested = Positive replies, a purchase = Paid client). Null = on
 * no step.
 */
export function stepOfLedgerKey(key: string): OutcomeCostStep | null {
  const exact = STEP_COST_CHAIN.find((s) => s === key || ledgerKeysOfStep(s).includes(key));
  if (exact) return exact;
  const state = leadStateOf(key);
  return state === null ? null : (STEP_COST_CHAIN.find((s) => leadStateOf(s) === state) ?? null);
}

/** One produced group of the ledger: an outcome, the campaign whose run produced it, their own production cost. */
export interface TracedCostRow {
  outcomeKey: string;
  campaignId: string | null;
  ownCostUsd: number;
}

/** One consumption edge of the ledger: occurrences of `consumedKey` a run producing `consumerKey` consumed. */
export interface ConsumptionEdge {
  consumerKey: string;
  consumedKey: string;
  count: number;
}

/**
 * PURE. The step an INPUT key (one that is no step: email found, message written) is costed at: the EARLIEST step of the
 * chain that consumes it, walking the ledger's consumption graph through other inputs (found emails are checked, checked
 * emails make a Lead found: Lead found; a written message is sent toward a visit or a reply: the first of them). Null =
 * no step consumes it.
 */
export function consumingStepOf(key: string, edges: readonly ConsumptionEdge[]): OutcomeCostStep | null {
  const consumers = new Map<string, Set<string>>();
  for (const e of edges) if (e.count > 0 && e.consumerKey !== e.consumedKey) (consumers.get(e.consumedKey) ?? consumers.set(e.consumedKey, new Set()).get(e.consumedKey)!).add(e.consumerKey);
  const seen = new Set<string>([key]);
  const steps = new Set<OutcomeCostStep>();
  let frontier = [key];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const k of frontier)
      for (const c of consumers.get(k) ?? []) {
        if (seen.has(c)) continue;
        seen.add(c);
        const step = stepOfLedgerKey(c);
        if (step) steps.add(step);
        else next.push(c);
      }
    frontier = next;
  }
  return STEP_COST_CHAIN.find((s) => steps.has(s)) ?? null;
}

/** The ledger's own production cost per step (before absorption) and the cost on no step. */
export interface StepTracedCost {
  tracedCostUsd: ReadonlyMap<OutcomeCostStep, number>;
  /** Ledger cost of outcomes on no step (posts, newsletter...): absorbed with the rest of the untraced spend. */
  offStepCostUsd: number;
}

/**
 * PURE. Each produced group's own cost goes to (1) the step its key IS (`stepOfLedgerKey`), else (2) the earliest step
 * consuming it (`consumingStepOf`, an input is costed where it is used first), else (3) the step its campaign's leg
 * ends on (`campaignOutputsOf`), else nowhere (`offStepCostUsd`). One rule for every key of every brand: no key list.
 */
export function stepTracedCostOf(rows: readonly TracedCostRow[], edges: readonly ConsumptionEdge[], outputOf: (campaignId: string) => string | null): StepTracedCost {
  const traced = new Map<OutcomeCostStep, number>(STEP_COST_CHAIN.map((s) => [s, 0] as const));
  const memo = new Map<string, OutcomeCostStep | null>();
  const inputStep = (k: string) => (memo.has(k) ? memo.get(k)! : memo.set(k, consumingStepOf(k, edges)).get(k)!);
  let off = 0;
  for (const r of rows) {
    const output = r.campaignId ? outputOf(r.campaignId) : null;
    const step = stepOfLedgerKey(r.outcomeKey) ?? inputStep(r.outcomeKey) ?? (output ? stepOfLedgerKey(output) : null);
    if (step === null) off += r.ownCostUsd;
    else traced.set(step, traced.get(step)! + r.ownCostUsd);
  }
  return { tracedCostUsd: traced, offStepCostUsd: off };
}

export interface StepSpendAttribution {
  /** Step -> share of the scope's spend the step carries cumulatively (its own + every step above), 0..1. */
  cumulativeShare: ReadonlyMap<OutcomeCostStep, number>;
  /** Step -> the ledger's own production cost traced to it, USD (before absorption). */
  tracedCostUsd: ReadonlyMap<OutcomeCostStep, number>;
  /** Σ traced cost on every step. */
  totalTracedCostUsd: number;
  /** Ledger cost of keys on no step (posts, newsletter...), USD: absorbed like the rest of the untraced spend. */
  offStepCostUsd: number;
  /** Null when the steps' traced cost is the absorption base; else why the whole spend enters at the first step. */
  unavailableReason: "ledger_unreadable" | "no_cost_traced_to_a_step" | null;
}

/** PURE. The absorption shares from the ledger's traced cost per step (null = the ledger is unreadable). */
export function stepSpendAttribution(traced: StepTracedCost | null): StepSpendAttribution {
  const tracedCostUsd = new Map<OutcomeCostStep, number>(STEP_COST_CHAIN.map((s) => [s, traced?.tracedCostUsd.get(s) ?? 0] as const));
  // A negative step (a refund larger than its cost) never takes a negative share: the base is the positive traced cost.
  const base = [...tracedCostUsd.values()].reduce((a, v) => a + Math.max(0, v), 0);
  const reason = traced === null ? "ledger_unreadable" : base <= 0 ? "no_cost_traced_to_a_step" : null;
  const cumulativeShare = new Map<OutcomeCostStep, number>();
  let running = 0;
  for (const s of STEP_COST_CHAIN) {
    running += reason === null ? Math.max(0, tracedCostUsd.get(s)!) / base : s === STEP_COST_CHAIN[0] ? 1 : 0;
    // The last step carries the whole spend exactly (no float residue).
    cumulativeShare.set(s, s === STEP_COST_CHAIN.at(-1) ? 1 : Math.min(1, running));
  }
  return { cumulativeShare, tracedCostUsd, totalTracedCostUsd: base, offStepCostUsd: traced?.offStepCostUsd ?? 0, unavailableReason: reason };
}
