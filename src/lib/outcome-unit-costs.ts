/**
 * WHAT AN OUTCOME COSTS TO PRODUCE, EVERY PATH (owner 2026-10-23, COST-ACCOUNTING-1023-P2; doctrine: agent-config
 * skill `cost-accounting`). Pure.
 *
 * runs-service is the general ledger: each run states the outcome occurrences it produced and consumed, and every
 * produced occurrence carries its own production cost. This module prices one occurrence of an outcome S by the
 * doctrine's three rules, on totals grouped by (outcome, campaign):
 *
 *  - Rule 3, the DECLARED output takes the pipe's whole cost: everything the campaigns whose leg ends on S produced
 *    (leads found, emails checked, messages written and sent, follow-ups included) is S's production.
 *  - Rule 2, normal loss is absorbed by the good units: the sends nobody answered are part of that production, so they
 *    ride the replies (a positive reply carries the ~1,000 sends behind it, never only the one it answered).
 *  - An input S's production consumed from ANOTHER pipe (a booked meeting consuming a positive reply) enters at that
 *    input's own unit cost, every occurrence of it IN THE ORGS WHERE S HAPPENED counted (rule 2 again: the replies
 *    that never booked ride the meetings; an org with no S is left out, so a client that never reports a meeting is
 *    never read as one that books none, the meeting-population rule made generic, at the finest grain every
 *    declaration states), solved over the whole graph (Leontief; a cycle is solved as a Neumann series, a diverging
 *    one is named). A reused input is charged again (standard cost on reuse).
 *
 *   unit(S) = [ own spend of S's production + Σ_q cross(S, q) × unit(q) ] ÷ n(S)
 *
 * n(S) counts S's occurrences from S's own pipes and from runs on no campaign (a reply judged off any campaign); an S
 * a pipe aimed elsewhere caused is a $0 BY-PRODUCT (rule 3), counted apart, never in n(S). Spend of a campaign whose leg
 * is unknown, or with no campaign and an outcome that is no one's output (our newsletter's sends), is unattributed,
 * stated, never spread.
 */

export interface ProducedRow {
  outcomeKey: string;
  campaignId: string | null;
  /**
   * The producing run's org: the population an input's loss is counted in. Org, not brand: a reply judged on a run per
   * org and day states no brand (prod 2026-10-24: 78 of 87 replies), so a brand pool found 9 of them.
   */
  orgId?: string | null;
  produced: number;
  /** Their own production cost (the producing runs' spend), USD, on the basis read. */
  ownCostUsd: number;
}

export interface ConsumedRow {
  /** The outcome whose occurrences consumed (the consuming run's output). */
  consumerKey: string;
  consumedKey: string;
  /** The consuming run's campaign. */
  campaignId: string | null;
  orgId?: string | null;
  count: number;
}

export interface StageContribution {
  outcomeKey: string;
  /** Occurrences of this stage one unit of the outcome needs (losses included). */
  requirementPerUnit: number;
  /** USD of one unit of the outcome spent at this stage. */
  costPerUnitUsd: number;
  /** `own` = done by the outcome's own pipes; `input` = bought from another pipe at its unit cost. */
  source: "own" | "input";
}

export interface OutcomeUnitCost {
  outcomeKey: string;
  /** Occurrences counted (own pipes + no campaign). */
  produced: number;
  /** Occurrences a pipe aimed at another outcome caused: $0 by-products, never in the figure. */
  byProducts: number;
  /** Full production cost of one occurrence. Null when nothing was produced (or the cycle diverges). */
  unitCostUsd: number | null;
  /** Its own pipes' spend per occurrence, inputs from other pipes left out. */
  ownUnitCostUsd: number | null;
  /** Every stage it stands on, largest cost first; they add up to `unitCostUsd`. */
  stages: StageContribution[];
  /** Inputs consumed that nothing in the scope produced: their cost is unknown here, so `unitCostUsd` is a floor. */
  unpricedInputs: string[];
  unpricedReason?: "consumption_cycle_diverges";
}

export interface RollUp {
  units: Map<string, OutcomeUnitCost>;
  /** Spend on no outcome's production (unknown leg, or no campaign and no one's output), USD. */
  unattributedCostUsd: number;
}

/**
 * PURE. `outputOf(campaignId)` = the step the campaign's leg ends on (null = unknown); `pipeOutputs` = every step a
 * catalogue pipe ends on (the customer's own team's pipes included): only those are outcomes a pipe produces, so an
 * occurrence on no campaign counts only for one of them (a reply judged off any campaign does; our newsletter's sends,
 * no pipe's output, do not).
 */
export function rollUpOutcomeUnitCosts(
  produced: readonly ProducedRow[],
  consumed: readonly ConsumedRow[],
  outputOf: (campaignId: string) => string | null,
  pipeOutputs: ReadonlySet<string>,
  /** A scope's input produced OUTSIDE it (a lead another client paid for) at its standard cost: the fleet unit cost. */
  externalUnitCost: (outcomeKey: string) => number | null = () => null,
): RollUp {
  const out = (c: string | null) => (c ? outputOf(c) : null);
  // n(S): own pipes + no campaign; by-products apart
  const n = new Map<string, number>();
  const nByOrg = new Map<string, Map<string, number>>();
  const byProducts = new Map<string, number>();
  for (const r of produced) {
    const o = out(r.campaignId);
    if ((r.campaignId === null && pipeOutputs.has(r.outcomeKey)) || o === r.outcomeKey) {
      n.set(r.outcomeKey, (n.get(r.outcomeKey) ?? 0) + r.produced);
      const b = r.orgId ?? "";
      const m = nByOrg.get(r.outcomeKey) ?? new Map<string, number>();
      m.set(b, (m.get(b) ?? 0) + r.produced);
      nByOrg.set(r.outcomeKey, m);
    } else byProducts.set(r.outcomeKey, (byProducts.get(r.outcomeKey) ?? 0) + r.produced);
  }
  const isOutput = (k: string) => (n.get(k) ?? 0) > 0;
  // own spend of each S's production, by key; what each S's pipes produced inside
  const ownByKey = new Map<string, Map<string, { count: number; cost: number }>>();
  let unattributedCostUsd = 0;
  const add = (s: string, key: string, count: number, cost: number) => {
    const m = ownByKey.get(s) ?? new Map<string, { count: number; cost: number }>();
    const e = m.get(key) ?? { count: 0, cost: 0 };
    e.count += count;
    e.cost += cost;
    m.set(key, e);
    ownByKey.set(s, m);
  };
  for (const r of produced) {
    const o = out(r.campaignId);
    if (o && isOutput(o)) add(o, r.outcomeKey, r.produced, r.ownCostUsd); // the campaign's pipe production (a by-product's spend too: rule 3)
    else if (r.campaignId === null && isOutput(r.outcomeKey)) add(r.outcomeKey, r.outcomeKey, r.produced, r.ownCostUsd); // S's own stage off any campaign
    else unattributedCostUsd += r.ownCostUsd;
  }
  // inputs from OTHER pipes: consumptions by S's production of a key S's pipes do not produce
  const cross = new Map<string, Map<string, number>>();
  for (const c of consumed) {
    if (c.count <= 0) continue;
    const o = out(c.campaignId);
    const s = o && isOutput(o) ? o : c.campaignId === null && isOutput(c.consumerKey) ? c.consumerKey : null;
    if (!s || c.consumedKey === s || ownByKey.get(s)?.has(c.consumedKey)) continue;
    const m = cross.get(s) ?? new Map<string, number>();
    m.set(c.consumedKey, (m.get(c.consumedKey) ?? 0) + c.count);
    cross.set(s, m);
  }
  // Normal loss on a cross-pipe input: every occurrence of it in the orgs where S happened, never fewer than consumed.
  for (const [s, inputs] of cross) {
    const orgs = new Set([...(nByOrg.get(s) ?? new Map<string, number>()).entries()].filter(([, v]) => v > 0).map(([b]) => b));
    for (const [q, consumedCount] of inputs) {
      const pool = [...(nByOrg.get(q) ?? new Map<string, number>()).entries()].reduce((a, [b, v]) => a + (orgs.has(b) ? v : 0), 0);
      inputs.set(q, Math.max(consumedCount, pool));
    }
  }

  const ownUnit = (s: string) => [...(ownByKey.get(s)?.values() ?? [])].reduce((a, e) => a + e.cost, 0) / n.get(s)!;
  // Requirement of one unit of root over the cross-pipe graph (Neumann series; diverges = no finite cost).
  const requirementOf = (root: string) => {
    const req = new Map<string, number>();
    const unpriced = new Set<string>();
    let term = new Map<string, number>([[root, 1]]);
    for (let step = 0; step < 10_000; step++) {
      let size = 0;
      for (const [k, q] of term) {
        req.set(k, (req.get(k) ?? 0) + q);
        size += q;
      }
      if (size < 1e-12) return { req, unpriced, diverges: false };
      if (size > 1e9) break;
      const next = new Map<string, number>();
      for (const [k, q] of term) {
        if (!isOutput(k)) {
          if (k !== root && externalUnitCost(k) === null) unpriced.add(k);
          continue;
        }
        for (const [input, count] of cross.get(k) ?? []) next.set(input, (next.get(input) ?? 0) + (q * count) / n.get(k)!);
      }
      term = next;
    }
    return { req, unpriced, diverges: true };
  };

  const units = new Map<string, OutcomeUnitCost>();
  const keys = new Set([...produced.map((r) => r.outcomeKey), ...consumed.map((c) => c.consumerKey)]);
  for (const s of keys) {
    const bp = byProducts.get(s) ?? 0;
    if (!isOutput(s)) {
      units.set(s, { outcomeKey: s, produced: 0, byProducts: bp, unitCostUsd: null, ownUnitCostUsd: null, stages: [], unpricedInputs: [] });
      continue;
    }
    const { req, unpriced, diverges } = requirementOf(s);
    if (diverges) {
      units.set(s, { outcomeKey: s, produced: n.get(s)!, byProducts: bp, unitCostUsd: null, ownUnitCostUsd: ownUnit(s), stages: [], unpricedInputs: [], unpricedReason: "consumption_cycle_diverges" });
      continue;
    }
    // stages: every pipe on the path, each split by the keys its production holds
    const stages = new Map<string, StageContribution>();
    for (const [pipeOut, r] of req) {
      if (!isOutput(pipeOut)) {
        const ext = pipeOut === s ? null : externalUnitCost(pipeOut);
        if (ext !== null) stages.set(pipeOut, { outcomeKey: pipeOut, requirementPerUnit: r, costPerUnitUsd: r * ext, source: "input" });
        continue;
      }
      for (const [key, e] of ownByKey.get(pipeOut) ?? []) {
        const st = stages.get(key) ?? { outcomeKey: key, requirementPerUnit: 0, costPerUnitUsd: 0, source: pipeOut === s ? ("own" as const) : ("input" as const) };
        st.requirementPerUnit += (r * e.count) / n.get(pipeOut)!;
        st.costPerUnitUsd += (r * e.cost) / n.get(pipeOut)!;
        stages.set(key, st);
      }
    }
    const list = [...stages.values()].sort((a, b) => b.costPerUnitUsd - a.costPerUnitUsd || a.outcomeKey.localeCompare(b.outcomeKey));
    units.set(s, {
      outcomeKey: s,
      produced: n.get(s)!,
      byProducts: bp,
      unitCostUsd: list.reduce((a, x) => a + x.costPerUnitUsd, 0),
      ownUnitCostUsd: ownUnit(s),
      stages: list,
      unpricedInputs: [...unpriced].sort(),
    });
  }
  return { units, unattributedCostUsd };
}

/**
 * PURE. Per ORG (a client), the same roll-up on its own rows; an input produced outside the org (a lead another client's
 * run paid for) enters at the fleet unit cost (standard cost on reuse). The per-client figure of the doctrine's "two
 * figures per customer": production cost at standard.
 */
export function rollUpByOrg(produced: readonly ProducedRow[], consumed: readonly ConsumedRow[], outputOf: (campaignId: string) => string | null, pipeOutputs: ReadonlySet<string>): Map<string, RollUp> {
  const fleet = rollUpOutcomeUnitCosts(produced, consumed, outputOf, pipeOutputs);
  const ext = (k: string) => fleet.units.get(k)?.unitCostUsd ?? null;
  const orgs = new Set([...produced.map((r) => r.orgId ?? ""), ...consumed.map((c) => c.orgId ?? "")].filter((o) => o !== ""));
  const out = new Map<string, RollUp>();
  for (const org of orgs) {
    out.set(org, rollUpOutcomeUnitCosts(produced.filter((r) => r.orgId === org), consumed.filter((c) => c.orgId === org), outputOf, pipeOutputs, ext));
  }
  return out;
}

export interface WorkflowProducedRow {
  outcomeKey: string;
  campaignId: string | null;
  workflowSlug: string | null;
  ownCostUsd: number;
}

export interface SourcedConsumption {
  consumerKey: string;
  consumedKey: string;
  /** The workflow of the run that PRODUCED the consumed occurrence (null = unknown provenance or untagged). */
  sourceWorkflowSlug: string | null;
  count: number;
}

export interface WorkflowUnitCost {
  workflowSlug: string;
  /** Occurrences of the outcome whose hand-off input (the send a reply answered) this workflow produced. */
  outcomes: number;
  /** The workflow's own production for the outcome (losses included) ÷ its outcomes, + the outcome's shared stages per unit. */
  unitCostUsd: number | null;
  ownCostUsd: number;
}

/**
 * PURE. Per WORKFLOW (version), the unit cost of outcome S: everything the workflow produced inside the pipes whose leg
 * ends on S (rule 3; the sends nobody answered included, rule 2) ÷ the S occurrences whose hand-off input it produced
 * (the reply answering its send: runs-service groups a consumption by the producing run's workflow), + per unit what
 * every S carries beyond its pipes' workflow runs (S's own stage off any campaign, inputs bought from other pipes), at
 * the fleet's figure. `fleet` = the fleet roll-up of S. S occurrences of unknown source count in no workflow.
 */
export function workflowUnitCosts(
  s: string,
  produced: readonly WorkflowProducedRow[],
  sourced: readonly SourcedConsumption[],
  outputOf: (campaignId: string) => string | null,
  fleet: OutcomeUnitCost,
): WorkflowUnitCost[] {
  const own = new Map<string, number>();
  const handOffKeys = new Set<string>();
  for (const r of produced) {
    if (!r.campaignId || outputOf(r.campaignId) !== s || !r.workflowSlug) continue;
    own.set(r.workflowSlug, (own.get(r.workflowSlug) ?? 0) + r.ownCostUsd);
    if (r.outcomeKey !== s) handOffKeys.add(r.outcomeKey);
  }
  // per workflow, per hand-off key: the S occurrences that consumed what it produced; an S counts once (max over keys)
  const byKey = new Map<string, Map<string, number>>();
  for (const c of sourced) {
    if (c.consumerKey !== s || !c.sourceWorkflowSlug || !handOffKeys.has(c.consumedKey)) continue;
    const m = byKey.get(c.sourceWorkflowSlug) ?? new Map<string, number>();
    m.set(c.consumedKey, (m.get(c.consumedKey) ?? 0) + c.count);
    byKey.set(c.sourceWorkflowSlug, m);
  }
  const workflowsCost = [...own.values()].reduce((a, v) => a + v, 0);
  // what one S carries beyond its pipes' workflow runs, fleet-wide: its unit cost minus the workflow part per unit
  const shared = fleet.unitCostUsd !== null && fleet.produced > 0 ? Math.max(fleet.unitCostUsd - workflowsCost / fleet.produced, 0) : 0;
  const slugs = new Set([...own.keys(), ...byKey.keys()]);
  return [...slugs]
    .map((w) => {
      const outcomes = Math.max(0, ...(byKey.get(w)?.values() ?? []));
      const ownCostUsd = own.get(w) ?? 0;
      return { workflowSlug: w, outcomes, ownCostUsd, unitCostUsd: outcomes > 0 ? ownCostUsd / outcomes + shared : null };
    })
    .sort((a, b) => (a.unitCostUsd ?? Infinity) - (b.unitCostUsd ?? Infinity) || a.workflowSlug.localeCompare(b.workflowSlug));
}
