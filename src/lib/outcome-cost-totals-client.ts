/**
 * runs-service's outcome ledger as totals (`GET /internal/stats/outcome-costs`, COST-ACCOUNTING-1023-P2): the input of
 * the every-path unit cost rollup (`lib/outcome-unit-costs.ts`). One fleet read grouped by outcome key: produced
 * occurrences + their own cost, consumptions per (consuming, consumed) outcome, and the scope's spend split into what
 * an outcome carries and what produced none (coverage). FAIL-LOUD: a 422 (too many groups) or any non-OK throws.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import type { OutcomeConsumption, OutcomeTotals } from "./outcome-unit-costs.js";

export type LedgerBasis = "gross" | "vendor";

interface WireCost {
  grossCents?: string;
  netCents?: string;
  vendorCents?: string;
  unpricedGrossCents?: string;
}
interface WireTotals {
  complete?: boolean;
  daysMissing?: string[];
  produced?: Array<{ dimensions?: Record<string, string | null>; occurrences?: number; cost?: WireCost }>;
  consumed?: Array<{ dimensions?: Record<string, string | null>; consumptions?: string }>;
  scope?: Array<{ spend?: WireCost; producedCost?: WireCost }>;
}

export interface OutcomeLedgerTotals {
  totals: OutcomeTotals[];
  consumptions: OutcomeConsumption[];
  /** Share of the fleet's spend an outcome carries, 0..100; null when nothing was spent. */
  coveragePct: number | null;
  /** Days of the range the ledger has not stored yet (its refresher fills them). */
  daysMissing: string[];
}

const usdOf = (c: WireCost | undefined, basis: LedgerBasis): number => {
  const v = basis === "vendor" ? c?.vendorCents : c?.grossCents;
  if (v === undefined) throw new Error(`[features-service] outcome ledger totals: a cost carries no ${basis} figure`);
  return Number(v) / 100;
};

/** PURE. The wire body as the rollup reads it. */
export function parseOutcomeLedgerTotals(body: WireTotals, basis: LedgerBasis): OutcomeLedgerTotals {
  const totals: OutcomeTotals[] = (body.produced ?? []).map((g) => {
    const key = g.dimensions?.outcomeKey;
    if (!key) throw new Error("[features-service] outcome ledger totals: a produced group names no outcomeKey");
    return { outcomeKey: key, produced: g.occurrences ?? 0, ownCostUsd: usdOf(g.cost, basis) };
  });
  const consumptions: OutcomeConsumption[] = [];
  for (const g of body.consumed ?? []) {
    const consumer = g.dimensions?.consumingOutcomeKey;
    const consumed = g.dimensions?.consumedOutcomeKey;
    if (!consumed) throw new Error("[features-service] outcome ledger totals: a consumed group names no consumedOutcomeKey");
    // No consuming outcome = the consuming run declared none (its consumption prices nothing here).
    if (!consumer) continue;
    consumptions.push({ consumerKey: consumer, consumedKey: consumed, count: Number(g.consumptions ?? 0) });
  }
  const scope = body.scope?.[0];
  const spend = scope ? usdOf(scope.spend, basis) : 0;
  const carried = scope ? usdOf(scope.producedCost, basis) : 0;
  return { totals, consumptions, coveragePct: spend > 0 ? (100 * carried) / spend : null, daysMissing: body.daysMissing ?? [] };
}

/** The fleet read, every day the ledger holds. */
export async function fetchOutcomeLedgerTotals(basis: LedgerBasis): Promise<OutcomeLedgerTotals> {
  const r = await fetchWithRetry(`${process.env.RUNS_SERVICE_URL}/internal/stats/outcome-costs?groupBy=outcomeKey`, {
    headers: { "x-api-key": process.env.RUNS_SERVICE_API_KEY ?? "" },
  });
  if (!r.ok) throw new Error(`[features-service] runs-service outcome-costs ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return parseOutcomeLedgerTotals((await r.json()) as WireTotals, basis);
}
