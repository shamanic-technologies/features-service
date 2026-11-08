/**
 * GSC-CONNECTOR-1108 (owner 2026-11-08: « Google search click » tracked on dashboard v2 for every client). PURE.
 *
 * EVERY outcome a brand's general ledger (runs-service) holds Units of, whatever its key: the outcome cost series' `steps[]`
 * walk a fixed list of steps, so an outcome declared by a connector (Search Console clicks, tomorrow any other) was on no
 * read. One row per outcome key, read off the SAME brand ledger the steps read (`scopeOutcomeLedgerRows`), never a list of
 * keys and never another source: the dashboard names each key from the public catalogue.
 *
 * `daily` = one point per UTC day from the earlier of (first Unit, today - 27) to today: the ledger runs since inception, so
 * a day with no Unit is a stated 0, except a day runs-service has not computed yet (`ledgerDaysMissing`) = null.
 */
import { scopeOutcomeLedgerRows, type LedgerProducerGap, type OtherFactoryUnits, type ScopeOutcomeLedgerInput } from "./scope-outcome-ledger.js";

/** The daily series covers at least this many days (today included). */
export const LEDGER_OUTCOME_MIN_DAYS = 28;

export interface BrandLedgerOutcome {
  outcomeKey: string;
  /** TOTAL Units since inception (ours + another factory's). */
  units: number;
  /** OUR factory's Units: the divisor of every money figure. */
  ourUnits: number;
  otherFactoryUnits: OtherFactoryUnits;
  /** $ each over OUR Units (null + reason when none of ours or the ledger prices none). */
  costPerUnitUsd: number | null;
  costPerUnitBasis: "every_path" | "own_production" | null;
  costPerUnitUnavailableReason: string | null;
  /** What OUR Units cost to produce (the spend on them); null with `costPerUnitUsd`. */
  productionCostUsd: number | null;
  producerGap: LedgerProducerGap | null;
  daily: Array<{ date: string; units: number | null; ourUnits: number | null; otherFactoryUnits: number | null }>;
}

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** PURE. One row per outcome key the ledger holds >= 1 Unit of, key order. */
export function brandLedgerOutcomes(ledger: ScopeOutcomeLedgerInput): BrandLedgerOutcome[] {
  const missing = new Set(ledger.daysMissing);
  const windowStart = addDays(ledger.today, -(LEDGER_OUTCOME_MIN_DAYS - 1));
  return scopeOutcomeLedgerRows(ledger)
    .filter((r) => r.units !== null && r.units > 0)
    .map((r) => {
      const byDay = new Map(r.past.map((p) => [p.date, p] as const));
      const first = r.past[0]?.date ?? windowStart;
      const daily: BrandLedgerOutcome["daily"] = [];
      for (let d = first < windowStart ? first : windowStart; d <= ledger.today; d = addDays(d, 1)) {
        const p = byDay.get(d);
        if (missing.has(d) && (p?.units ?? 0) === 0) daily.push({ date: d, units: null, ourUnits: null, otherFactoryUnits: null });
        else daily.push({ date: d, units: p?.units ?? 0, ourUnits: p?.ourUnits ?? 0, otherFactoryUnits: p?.otherFactoryUnits ?? 0 });
      }
      return {
        outcomeKey: r.outcomeKey,
        units: r.units!,
        ourUnits: r.ourUnits!,
        otherFactoryUnits: r.otherFactoryUnits!,
        costPerUnitUsd: r.costPerUnitUsd,
        costPerUnitBasis: r.costPerUnitBasis,
        costPerUnitUnavailableReason: r.costPerUnitUnavailableReason,
        productionCostUsd: r.productionCostUsd,
        producerGap: r.producerGap,
        daily,
      };
    });
}
