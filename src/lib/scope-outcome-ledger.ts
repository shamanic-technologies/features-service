/**
 * LEDGER-ONLY-1107 (owner 2026-11-07, « ON VEUT LE TOTAL ET LES STATS PAR OUTCOME!!!!! COMPTA ANALYTIQUE INDUSTRIELLE!!!!!!
 * INDEPENDAMMENT DES SOURCES »; doctrine: agent-config skill `cost-accounting`). PURE; IO in `scope-outcome-ledger-io.ts`.
 *
 * Per OUTCOME of a scope (a brand): the TOTAL Units of that outcome the general ledger (runs-service) holds, every source and
 * every campaign, never the subset one campaign attributed to itself; its $ each (the ledger's every-path unit cost); its
 * count over time. A Unit is ONE produced occurrence declared by ONE run, so a brand-scoped read counts it once whatever
 * campaigns its lead was reached under (two campaigns sharing a Target never double count).
 *
 * When the ledger holds no Unit of an outcome the scope DID consume (a consumption of unknown provenance: the occurrence
 * exists, no run declared producing it), the count is NULL with `outcome_not_declared_in_ledger` and the producer gap
 * named, never a 0 and never a count from another source (CRM, PostHog, Clerk).
 */

export interface LedgerOutcomeCost {
  /** Every-path unit cost (own production + inputs at their unit cost), null when the outcome is no pipe's output in scope. */
  unitCostUsd: number | null;
}

export interface ScopeOutcomeLedgerInput {
  /** outcome key -> UTC day -> produced Units in scope. */
  producedByDay: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** outcome key -> Σ own production cost of the Units produced in scope (the ledger's allocation), USD. */
  ownCostUsd: ReadonlyMap<string, number>;
  /** outcome key -> the roll-up's every-path unit cost in scope. */
  unitCosts: ReadonlyMap<string, LedgerOutcomeCost>;
  /** outcome key -> consumptions in scope of occurrences no run declared producing (unknown provenance). */
  undeclaredConsumptions: ReadonlyMap<string, number>;
  /** outcome key -> the services that declare producing it anywhere in the fleet (empty = nobody does). */
  fleetProducers: ReadonlyMap<string, readonly string[]>;
  /** Ledger days runs-service has not computed yet (counts there may still move). */
  daysMissing: readonly string[];
  /** TODAY (UTC day): the curve runs to it. */
  today: string;
}

export interface LedgerProducerGap {
  /** The services that declare this outcome for other scopes (empty = no service declares it anywhere). */
  declaredElsewhereBy: string[];
  /** Occurrences the scope consumed that no run declared producing. */
  undeclaredConsumptions: number;
}

export interface ScopeOutcomeLedgerRow {
  /** The outcome keys counted (one, or the finer outcomes an Engine makes for it). */
  outcomeKeys: string[];
  /** Total Units in the ledger; null = the ledger cannot state them (reason). */
  units: number | null;
  unitsUnavailableReason: "outcome_not_declared_in_ledger" | "no_producer_declares_outcome" | null;
  /** Who must declare it, when the ledger lacks it. */
  producerGap: LedgerProducerGap | null;
  /** $ each: the every-path unit cost when the outcome is a pipe's output in scope, else its own production cost per Unit. */
  costPerUnitUsd: number | null;
  costPerUnitBasis: "every_path" | "own_production" | null;
  costPerUnitUnavailableReason: string | null;
  /** What those Units cost to produce (units × $ each). */
  productionCostUsd: number | null;
  /** One point per UTC day from the first Unit to today. */
  past: Array<{ date: string; units: number; cumulativeUnits: number }>;
  ledgerDaysMissing: string[];
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** PURE. One row for a set of outcome keys counted together (a Unit has ONE outcome: summing keys never double counts). */
export function scopeOutcomeLedgerRowOf(keysIn: readonly string[], i: ScopeOutcomeLedgerInput): ScopeOutcomeLedgerRow {
  const keys = [...new Set(keysIn)].sort();
  const byDay = new Map<string, number>();
  for (const k of keys) for (const [d, n] of i.producedByDay.get(k) ?? []) byDay.set(d, (byDay.get(d) ?? 0) + n);
  const units = [...byDay.values()].reduce((a, n) => a + n, 0);
  const undeclared = keys.reduce((a, k) => a + (i.undeclaredConsumptions.get(k) ?? 0), 0);
  const producers = [...new Set(keys.flatMap((k) => i.fleetProducers.get(k) ?? []))].sort();
  const ledgerDaysMissing = [...i.daysMissing];

  let unitsUnavailableReason: ScopeOutcomeLedgerRow["unitsUnavailableReason"] = null;
  if (units === 0 && undeclared > 0) unitsUnavailableReason = "outcome_not_declared_in_ledger";
  else if (units === 0 && producers.length === 0) unitsUnavailableReason = "no_producer_declares_outcome";
  if (unitsUnavailableReason !== null) {
    return {
      outcomeKeys: keys,
      units: null,
      unitsUnavailableReason,
      producerGap: { declaredElsewhereBy: producers, undeclaredConsumptions: round(undeclared, 4) },
      costPerUnitUsd: null,
      costPerUnitBasis: null,
      costPerUnitUnavailableReason: unitsUnavailableReason,
      productionCostUsd: null,
      past: [],
      ledgerDaysMissing,
    };
  }

  // $ each: weighted over the keys by their Units; each key on its every-path cost when it is an output in scope, else its own.
  let cost = 0;
  let everyPath = true;
  let priced = true;
  for (const k of keys) {
    const n = [...(i.producedByDay.get(k)?.values() ?? [])].reduce((a, x) => a + x, 0);
    if (n === 0) continue;
    const ep = i.unitCosts.get(k)?.unitCostUsd ?? null;
    if (ep !== null) cost += ep * n;
    else {
      everyPath = false;
      const own = i.ownCostUsd.get(k);
      if (own === undefined) priced = false;
      else cost += own;
    }
  }
  const costPerUnitUsd = units > 0 && priced ? round(cost / units, 4) : null;
  const costPerUnitUnavailableReason = units === 0 ? "no_unit_yet" : priced ? null : "unit_cost_not_in_ledger";

  const past: ScopeOutcomeLedgerRow["past"] = [];
  const days = [...byDay.keys()].filter((d) => d <= i.today).sort();
  if (days.length > 0) {
    let acc = 0;
    for (let d = days[0]!; d <= i.today; d = addDays(d, 1)) {
      const n = byDay.get(d) ?? 0;
      acc += n;
      past.push({ date: d, units: n, cumulativeUnits: acc });
    }
  }
  return {
    outcomeKeys: keys,
    units,
    unitsUnavailableReason: null,
    producerGap: null,
    costPerUnitUsd,
    costPerUnitBasis: costPerUnitUsd === null ? null : everyPath ? "every_path" : "own_production",
    costPerUnitUnavailableReason,
    productionCostUsd: costPerUnitUsd !== null ? round(cost, 4) : null,
    past,
    ledgerDaysMissing,
  };
}

/** PURE. One row per outcome the scope's ledger names (produced, or consumed without a declared producer), key order. */
export function scopeOutcomeLedgerRows(i: ScopeOutcomeLedgerInput): Array<ScopeOutcomeLedgerRow & { outcomeKey: string }> {
  const keys = [...new Set([...i.producedByDay.keys(), ...[...i.undeclaredConsumptions].filter(([, n]) => n > 0).map(([k]) => k)])].sort();
  return keys.map((k) => ({ outcomeKey: k, ...scopeOutcomeLedgerRowOf([k], i) }));
}

export interface LedgerRealizedReturn {
  closedWonCount: number;
  closedWonRevenueUsd: number;
  spentUsd: number | null;
  roiMultiple: number | null;
}

/**
 * PURE. LEDGER-ONLY-1107: the realized return from the ledger's Paid client Units of the scope (never the CRM's deals):
 * Units × the offer's lifetime revenue ÷ every dollar actually spent. The ledger lacking Paid client Units (consumed, no
 * run declares them) = null + the row's reason, never a 0 nor a count from another source.
 */
export function ledgerRealizedReturn(
  paidClient: ScopeOutcomeLedgerRow | null,
  lifetimeRevenueUsd: number | null,
  spentUsd: number | null,
): { realizedReturn: LedgerRealizedReturn | null; unavailableReason: string | null } {
  if (paidClient === null) return { realizedReturn: null, unavailableReason: "ledger_unreadable" };
  if (paidClient.units === null) return { realizedReturn: null, unavailableReason: paidClient.unitsUnavailableReason };
  if (lifetimeRevenueUsd === null) return { realizedReturn: null, unavailableReason: "lifetime_revenue_not_stated" };
  const revenue = round(paidClient.units * lifetimeRevenueUsd, 2);
  return {
    realizedReturn: { closedWonCount: paidClient.units, closedWonRevenueUsd: revenue, spentUsd, roiMultiple: spentUsd !== null && spentUsd > 0 ? round(revenue / spentUsd, 2) : null },
    unavailableReason: null,
  };
}
