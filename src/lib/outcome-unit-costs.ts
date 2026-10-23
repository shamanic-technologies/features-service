/**
 * WHAT AN OUTCOME COSTS TO PRODUCE, EVERY PATH (owner 2026-10-23, COST-ACCOUNTING-1023-P2; doctrine: agent-config
 * skill `cost-accounting`). Pure.
 *
 * runs-service is the general ledger: each run states the outcome occurrences it produced and consumed, and every
 * produced occurrence carries its OWN production cost (its run's spend). This module rolls those totals up the graph
 * the declarations themselves draw (Leontief / bill of materials):
 *
 *   unit(S) = own(S) / n(S) + Σ_q  consumed(S, q) / n(S) × unit(q)
 *
 * where `consumed(S, q)` counts the occurrences of q that S's occurrences consumed. A reused input is charged its
 * unit cost again (standard cost on reuse: a past figure never moves); the gap with what was really spent is the
 * ledger's reuse gain, never folded in here. The provenance is MEASURED (who consumed what), never the catalogue's
 * guess. An input outcome nobody produced in the scope prices at nothing it has (`unpricedInputs`), stated, never 0.
 *
 * The same walk splits a unit cost by STAGE: how much of one positive reply is lead finding, email checking,
 * writing, sending. `requirement(q)` = the occurrences of q one unit of S needs, along every path; contribution(q) =
 * requirement(q) × own(q) / n(q). The contributions add up to unit(S) exactly (up to float rounding).
 */

export interface OutcomeTotals {
  outcomeKey: string;
  /** Occurrences produced in the scope. */
  produced: number;
  /** Their own production cost (the producing runs' spend), USD, on the basis read. */
  ownCostUsd: number;
}

export interface OutcomeConsumption {
  /** The outcome whose occurrences consumed. */
  consumerKey: string;
  /** The outcome consumed. */
  consumedKey: string;
  /** Consumptions in the scope. */
  count: number;
}

export interface StageContribution {
  outcomeKey: string;
  /** Occurrences of this stage one unit of the outcome needs, every path summed. */
  requirementPerUnit: number;
  /** USD of one unit of the outcome spent at this stage. */
  costPerUnitUsd: number;
}

export interface OutcomeUnitCost {
  outcomeKey: string;
  produced: number;
  /** Full production cost of one occurrence, every upstream stage included. Null when nothing was produced. */
  unitCostUsd: number | null;
  /** Its own stage only (the producing runs' spend per occurrence). */
  ownUnitCostUsd: number | null;
  /** Every stage it stands on (itself first), largest cost first. */
  stages: StageContribution[];
  /** Inputs consumed that nothing in the scope produced: their cost is unknown here, so `unitCostUsd` is a floor. */
  unpricedInputs: string[];
}

/** PURE. Unit cost of every produced outcome of the scope. A consumption cycle throws (the ledger forbids none, but a cycle has no unique unit cost here). */
export function rollUpOutcomeUnitCosts(totals: readonly OutcomeTotals[], consumptions: readonly OutcomeConsumption[]): Map<string, OutcomeUnitCost> {
  const byKey = new Map(totals.map((t) => [t.outcomeKey, t]));
  const inputsOf = new Map<string, Map<string, number>>();
  for (const c of consumptions) {
    if (c.count <= 0) continue;
    const m = inputsOf.get(c.consumerKey) ?? new Map<string, number>();
    m.set(c.consumedKey, (m.get(c.consumedKey) ?? 0) + c.count);
    inputsOf.set(c.consumerKey, m);
  }

  const own = (k: string): number | null => {
    const t = byKey.get(k);
    return t && t.produced > 0 ? t.ownCostUsd / t.produced : null;
  };

  // requirement vector of one unit of `root`: occurrences of every stage, every path (DFS, cycle-checked)
  const requirementOf = (root: string): { req: Map<string, number>; unpriced: Set<string> } => {
    const req = new Map<string, number>();
    const unpriced = new Set<string>();
    const walk = (k: string, qty: number, path: Set<string>) => {
      if (path.has(k)) throw new Error(`[features-service] outcome unit costs: consumption cycle through ${[...path, k].join(" -> ")}`);
      req.set(k, (req.get(k) ?? 0) + qty);
      const t = byKey.get(k);
      if (!t || t.produced <= 0) {
        if (k !== root) unpriced.add(k);
        return;
      }
      const inputs = inputsOf.get(k);
      if (!inputs) return;
      const next = new Set(path).add(k);
      for (const [q, count] of inputs) walk(q, (qty * count) / t.produced, next);
    };
    walk(root, 1, new Set());
    return { req, unpriced };
  };

  const out = new Map<string, OutcomeUnitCost>();
  for (const t of totals) {
    if (t.produced <= 0) {
      out.set(t.outcomeKey, { outcomeKey: t.outcomeKey, produced: 0, unitCostUsd: null, ownUnitCostUsd: null, stages: [], unpricedInputs: [] });
      continue;
    }
    const { req, unpriced } = requirementOf(t.outcomeKey);
    const stages: StageContribution[] = [];
    for (const [k, r] of req) {
      const o = own(k);
      if (o === null) continue;
      stages.push({ outcomeKey: k, requirementPerUnit: r, costPerUnitUsd: r * o });
    }
    stages.sort((a, b) => b.costPerUnitUsd - a.costPerUnitUsd || a.outcomeKey.localeCompare(b.outcomeKey));
    out.set(t.outcomeKey, {
      outcomeKey: t.outcomeKey,
      produced: t.produced,
      unitCostUsd: stages.reduce((s, x) => s + x.costPerUnitUsd, 0),
      ownUnitCostUsd: own(t.outcomeKey),
      stages,
      unpricedInputs: [...unpriced].sort(),
    });
  }
  return out;
}
