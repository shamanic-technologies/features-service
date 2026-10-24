/**
 * runs-service's outcome ledger as totals (`GET /internal/stats/outcome-costs`, COST-ACCOUNTING-1023-P2): the input of
 * the every-path unit cost rollup (`lib/outcome-unit-costs.ts`). One fleet read grouped by (outcome, campaign, org), since
 * inception (owner rule: every stat is since inception): produced occurrences + their own cost, consumptions per
 * (consuming, consumed) outcome under the consuming run's campaign, and the spend split into what an outcome carries and
 * what produced none (coverage). Coverage reads on OUTCOME spend only (COST-SUPPORT-1024-FEATURES): runs-service states the
 * support spend apart per support function (payment fees, brand setup, Copilot, a retired product...: spend that produces
 * no outcome by design, marked by its owner), so coverage = declared ÷ (spend − support). FAIL-LOUD: a 422 (too many groups) or any non-OK throws.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import type { ConsumedRow, ProducedRow, SourcedConsumption, WorkflowProducedRow } from "./outcome-unit-costs.js";

export type LedgerBasis = "gross" | "vendor";

interface WireCost {
  grossCents?: string;
  vendorCents?: string;
}
interface WireTotals {
  daysMissing?: string[];
  supportDaysMissing?: string[];
  produced?: Array<{ dimensions?: Record<string, string | null>; occurrences?: number; cost?: WireCost }>;
  consumed?: Array<{ dimensions?: Record<string, string | null>; consumptions?: string }>;
  scope?: Array<{ dimensions?: Record<string, string | null>; spend?: WireCost; producedCost?: WireCost; support?: WireCost; supportByFunction?: Record<string, WireCost> }>;
}

export interface OutcomeLedgerTotals {
  produced: ProducedRow[];
  consumed: ConsumedRow[];
  /** Share of the OUTCOME spend (spend − support) on the ledger's computed days an outcome carries, 0..100; null when no outcome spend. */
  coveragePct: number | null;
  /** Spend apart (support functions, produce no outcome by design), USD, and per function (runs-service's function key), largest first. */
  supportUsd: number;
  supportByFunction: Array<{ fn: string; usd: number }>;
  /** Computed days runs-service has not split support on yet (their support reads 0: coverage understated there). */
  supportDaysMissing: number;
  /** Days since inception the ledger has not computed yet (its refresher fills them): the figures stand on the others. */
  daysMissing: number;
  /** Per org (the scope rows' `orgId`): share of its OUTCOME spend an outcome carries, 0..100; null when it has none. */
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
  let support = 0;
  const byFn = new Map<string, number>();
  const byOrg = new Map<string, { spend: number; carried: number }>();
  for (const s of body.scope ?? []) {
    const sup = usdOf(s.support, basis);
    // Outcome spend: support is apart by design, never in the coverage denominator.
    const sp = usdOf(s.spend, basis) - sup;
    const ca = usdOf(s.producedCost, basis);
    spend += sp;
    carried += ca;
    support += sup;
    for (const [fn, c] of Object.entries(s.supportByFunction ?? {})) byFn.set(fn, (byFn.get(fn) ?? 0) + usdOf(c, basis));
    const org = s.dimensions?.orgId;
    if (org) {
      const e = byOrg.get(org) ?? { spend: 0, carried: 0 };
      e.spend += sp;
      e.carried += ca;
      byOrg.set(org, e);
    }
  }
  const pctOf = (ca: number, sp: number) => (sp > 0 ? (100 * ca) / sp : null);
  const coverageByOrg = new Map([...byOrg].map(([o, e]) => [o, pctOf(e.carried, e.spend)] as [string, number | null]));
  return {
    produced,
    consumed,
    coveragePct: pctOf(carried, spend),
    supportUsd: support,
    supportByFunction: [...byFn].map(([fn, usd]) => ({ fn, usd })).filter((f) => f.usd > 0).sort((a, b) => b.usd - a.usd),
    supportDaysMissing: (body.supportDaysMissing ?? []).length,
    daysMissing: (body.daysMissing ?? []).length,
    coverageByOrg,
  };
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

export interface OutcomeLedgerByWorkflow {
  produced: WorkflowProducedRow[];
  sourced: SourcedConsumption[];
  /** Days since inception either read does not hold yet: the per-workflow figures stand on the others. */
  daysMissing: number;
}

/** PURE. The two wire bodies (produced by campaign x workflow; consumed by the consumed occurrence's producing workflow). */
export function parseOutcomeLedgerByWorkflow(producedBody: WireTotals, sourcedBody: WireTotals, basis: LedgerBasis): OutcomeLedgerByWorkflow {
  const produced: WorkflowProducedRow[] = (producedBody.produced ?? []).map((g) => {
    const key = g.dimensions?.outcomeKey;
    if (!key) throw new Error("[features-service] outcome ledger by workflow: a produced group names no outcomeKey");
    return { outcomeKey: key, campaignId: g.dimensions?.campaignId ?? null, workflowSlug: g.dimensions?.workflowSlug ?? null, ownCostUsd: usdOf(g.cost, basis) };
  });
  const sourced: SourcedConsumption[] = [];
  for (const g of sourcedBody.consumed ?? []) {
    const consumer = g.dimensions?.consumingOutcomeKey;
    const key = g.dimensions?.consumedOutcomeKey;
    if (!key) throw new Error("[features-service] outcome ledger by workflow: a consumed group names no consumedOutcomeKey");
    if (!consumer) continue;
    sourced.push({ consumerKey: consumer, consumedKey: key, sourceWorkflowSlug: g.dimensions?.sourceWorkflowSlug ?? null, count: Number(g.consumptions ?? 0) });
  }
  return { produced, sourced, daysMissing: Math.max((producedBody.daysMissing ?? []).length, (sourcedBody.daysMissing ?? []).length) };
}

/** The fleet reads, since runs-service's own inception (no `since`, RESEARCH-STALE-1024). */
export async function fetchOutcomeLedgerByWorkflow(basis: LedgerBasis): Promise<OutcomeLedgerByWorkflow> {
  const get = async (groupBy: string) => {
    const r = await fetchWithRetry(`${process.env.RUNS_SERVICE_URL}/internal/stats/outcome-costs?groupBy=${groupBy}`, {
      headers: { "x-api-key": process.env.RUNS_SERVICE_API_KEY ?? "" },
    });
    if (!r.ok) throw new Error(`[features-service] runs-service outcome-costs (${groupBy}) ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as WireTotals;
  };
  const [p, s] = await Promise.all([get("outcomeKey,campaignId,workflowSlug"), get("outcomeKey,sourceWorkflowSlug")]);
  return parseOutcomeLedgerByWorkflow(p, s, basis);
}
