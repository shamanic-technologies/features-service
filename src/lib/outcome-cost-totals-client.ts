/**
 * runs-service's outcome ledger as totals (`GET /internal/stats/outcome-costs`, COST-ACCOUNTING-1023-P2): the input of
 * the every-path unit cost rollup (`lib/outcome-unit-costs.ts`). One fleet read grouped by (outcome, campaign, org), since
 * inception (owner rule: every stat is since inception): produced occurrences + their own cost, consumptions per
 * (consuming, consumed) outcome under the consuming run's campaign, and the spend split into what an outcome carries and
 * what produced none (coverage). FAIL-LOUD: a 422 (too many groups) or any non-OK throws.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import type { ConsumedRow, ProducedRow } from "./outcome-unit-costs.js";

export type LedgerBasis = "gross" | "vendor";

interface WireCost {
  grossCents?: string;
  vendorCents?: string;
}
interface WireTotals {
  daysMissing?: string[];
  produced?: Array<{ dimensions?: Record<string, string | null>; occurrences?: number; cost?: WireCost }>;
  consumed?: Array<{ dimensions?: Record<string, string | null>; consumptions?: string }>;
  scope?: Array<{ dimensions?: Record<string, string | null>; spend?: WireCost; producedCost?: WireCost }>;
}

export interface OutcomeLedgerTotals {
  produced: ProducedRow[];
  consumed: ConsumedRow[];
  /** Share of the spend on the ledger's computed days an outcome carries, 0..100; null when nothing was spent. */
  coveragePct: number | null;
  /** Days since inception the ledger has not computed yet (its refresher fills them): the figures stand on the others. */
  daysMissing: number;
  /** Per org (the scope rows' `orgId`): share of its spend an outcome carries, 0..100; null when it spent nothing. */
  coverageByOrg: Map<string, number | null>;
}

const usdOf = (c: WireCost | undefined, basis: LedgerBasis): number => {
  const v = basis === "vendor" ? c?.vendorCents : c?.grossCents;
  if (v === undefined) throw new Error(`[features-service] outcome ledger totals: a cost carries no ${basis} figure`);
  return Number(v) / 100;
};

/** PURE. The wire body as the rollup reads it. */
export function parseOutcomeLedgerTotals(body: WireTotals, basis: LedgerBasis): OutcomeLedgerTotals {
  const produced: ProducedRow[] = (body.produced ?? []).map((g) => {
    const key = g.dimensions?.outcomeKey;
    if (!key) throw new Error("[features-service] outcome ledger totals: a produced group names no outcomeKey");
    return { outcomeKey: key, campaignId: g.dimensions?.campaignId ?? null, orgId: g.dimensions?.orgId ?? null, produced: g.occurrences ?? 0, ownCostUsd: usdOf(g.cost, basis) };
  });
  const consumed: ConsumedRow[] = [];
  for (const g of body.consumed ?? []) {
    const consumer = g.dimensions?.consumingOutcomeKey;
    const key = g.dimensions?.consumedOutcomeKey;
    if (!key) throw new Error("[features-service] outcome ledger totals: a consumed group names no consumedOutcomeKey");
    // No consuming outcome = the consuming run declared none (its consumption prices nothing here).
    if (!consumer) continue;
    consumed.push({ consumerKey: consumer, consumedKey: key, campaignId: g.dimensions?.campaignId ?? null, orgId: g.dimensions?.orgId ?? null, count: Number(g.consumptions ?? 0) });
  }
  let spend = 0;
  let carried = 0;
  const byOrg = new Map<string, { spend: number; carried: number }>();
  for (const s of body.scope ?? []) {
    const sp = usdOf(s.spend, basis);
    const ca = usdOf(s.producedCost, basis);
    spend += sp;
    carried += ca;
    const org = s.dimensions?.orgId;
    if (org) {
      const e = byOrg.get(org) ?? { spend: 0, carried: 0 };
      e.spend += sp;
      e.carried += ca;
      byOrg.set(org, e);
    }
  }
  const coverageByOrg = new Map([...byOrg].map(([o, e]) => [o, e.spend > 0 ? (100 * e.carried) / e.spend : null] as [string, number | null]));
  return { produced, consumed, coveragePct: spend > 0 ? (100 * carried) / spend : null, daysMissing: (body.daysMissing ?? []).length, coverageByOrg };
}

/**
 * The fleet read, every day since inception. NO `since`: runs-service states its own inception (RESEARCH-STALE-1024: asked
 * `since=2026-01-01`, a month before its ledger starts on 2026-02-02, it counted those 32 days as missing forever and every
 * every-path study read "32 days still computing" over a complete ledger).
 */
export async function fetchOutcomeLedgerTotals(basis: LedgerBasis): Promise<OutcomeLedgerTotals> {
  const r = await fetchWithRetry(`${process.env.RUNS_SERVICE_URL}/internal/stats/outcome-costs?groupBy=outcomeKey,campaignId,orgId`, {
    headers: { "x-api-key": process.env.RUNS_SERVICE_API_KEY ?? "" },
  });
  if (!r.ok) throw new Error(`[features-service] runs-service outcome-costs ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return parseOutcomeLedgerTotals((await r.json()) as WireTotals, basis);
}
