/**
 * LEDGER-ONLY-1107 IO: a brand's outcome Units from runs-service's general ledger (the pure rule is `scope-outcome-ledger.ts`).
 *
 *  - Units per outcome per day + their own cost + the consumptions of unknown provenance:
 *    `GET /internal/stats/outcome-costs?groupBy=outcomeKey,day&brandId=` (since the ledger's inception).
 *  - The every-path unit cost: the same ledger grouped `outcomeKey,campaignId,orgId` for the brand, rolled up by
 *    `rollUpOutcomeUnitCosts` (each campaign's output = its stated (channel, leg) catalogue `to` step, `campaignOutputsOf`).
 *  - Who declares each outcome anywhere: `GET /internal/stats/outcome-performers?groupBy=outcomeKey,serviceName` (fleet).
 *
 * FAIL-LOUD: the caller decides how to degrade. Brand reads held 60 s, fleet reads 15 min.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { parseOutcomeLedgerTotals, type LedgerBasis } from "./outcome-cost-totals-client.js";
import { rollUpOutcomeUnitCosts } from "./outcome-unit-costs.js";
import { fetchFleetCampaignRows } from "./fleet-leg-campaigns.js";
import { loadChannelCatalogue } from "./channel-declarations-store.js";
import { campaignOutputsOf } from "./campaign-outputs.js";
import type { ScopeOutcomeLedgerInput, LedgerOutcomeCost } from "./scope-outcome-ledger.js";

interface WireCost {
  grossCents?: string;
  netCents?: string;
  vendorCents?: string;
}
interface WireByDay {
  daysMissing?: string[];
  produced?: Array<{ dimensions?: Record<string, string | null>; occurrences?: number; cost?: WireCost }>;
  consumed?: Array<{ dimensions?: Record<string, string | null>; unknownProvenance?: string }>;
}

const usd = (c: WireCost | undefined, basis: LedgerBasis): number => {
  const v = basis === "vendor" ? c?.vendorCents : basis === "net" ? c?.netCents : c?.grossCents;
  if (v === undefined) throw new Error(`[features-service] scope outcome ledger: a cost carries no ${basis} figure`);
  return Number(v) / 100;
};

/** PURE. The by-day wire body as Units per outcome per day, own cost per outcome, undeclared consumptions per outcome. */
export function parseScopeLedgerByDay(body: WireByDay, basis: LedgerBasis) {
  const producedByDay = new Map<string, Map<string, number>>();
  const ownCostUsd = new Map<string, number>();
  for (const g of body.produced ?? []) {
    const key = g.dimensions?.outcomeKey;
    const day = g.dimensions?.day;
    if (!key || !day) throw new Error("[features-service] scope outcome ledger: a produced group names no outcomeKey or day");
    const days = producedByDay.get(key) ?? producedByDay.set(key, new Map()).get(key)!;
    days.set(day, (days.get(day) ?? 0) + (g.occurrences ?? 0));
    ownCostUsd.set(key, (ownCostUsd.get(key) ?? 0) + usd(g.cost, basis));
  }
  const undeclaredConsumptions = new Map<string, number>();
  for (const g of body.consumed ?? []) {
    const key = g.dimensions?.consumedOutcomeKey;
    if (!key) throw new Error("[features-service] scope outcome ledger: a consumed group names no consumedOutcomeKey");
    const n = Number(g.unknownProvenance ?? 0);
    if (n > 0) undeclaredConsumptions.set(key, (undeclaredConsumptions.get(key) ?? 0) + n);
  }
  return { producedByDay, ownCostUsd, undeclaredConsumptions, daysMissing: [...(body.daysMissing ?? [])].sort() };
}

/** PURE. Fleet performers body as outcome -> services declaring it. */
export function parseFleetProducers(body: { groups?: Array<{ outcomeKey?: string | null; serviceName?: string | null; count?: number }> }): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const g of body.groups ?? []) {
    if (!g.outcomeKey || !g.serviceName || (g.count ?? 0) <= 0) continue;
    (out.get(g.outcomeKey) ?? out.set(g.outcomeKey, new Set()).get(g.outcomeKey)!).add(g.serviceName);
  }
  return new Map([...out].map(([k, s]) => [k, [...s].sort()]));
}

const runs = (path: string) =>
  fetchWithRetry(`${process.env.RUNS_SERVICE_URL}${path}`, { headers: { "x-api-key": process.env.RUNS_SERVICE_API_KEY ?? "" } }).then(async (r) => {
    if (!r.ok) throw new Error(`[features-service] runs-service ${path.split("?")[0]} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  });

function held<T>(store: Map<string, { at: number; value: Promise<T> }>, key: string, ms: number, make: () => Promise<T>): Promise<T> {
  const h = store.get(key);
  if (h && Date.now() - h.at < ms) return h.value;
  const value = make();
  value.catch(() => store.delete(key));
  store.set(key, { at: Date.now(), value });
  return value;
}

const fleetStore = new Map<string, { at: number; value: Promise<unknown> }>();
const brandStore = new Map<string, { at: number; value: Promise<ScopeOutcomeLedgerInput> }>();
const FLEET_MS = 15 * 60_000;
const BRAND_MS = 60_000;

function fleetProducers(): Promise<Map<string, string[]>> {
  return held(fleetStore, "producers", FLEET_MS, async () => {
    const since = new Date(Date.now() - 399 * 86_400_000).toISOString().slice(0, 10);
    return parseFleetProducers((await runs(`/internal/stats/outcome-performers?since=${since}&groupBy=outcomeKey,serviceName`)) as never);
  }) as Promise<Map<string, string[]>>;
}

function campaignOutputs(): Promise<ReturnType<typeof campaignOutputsOf>> {
  return held(fleetStore, "outputs", FLEET_MS, async () => {
    const [rows, catalogue] = await Promise.all([fetchFleetCampaignRows(), loadChannelCatalogue({ publishedOnly: false })]);
    return campaignOutputsOf(rows, catalogue.channels);
  }) as Promise<ReturnType<typeof campaignOutputsOf>>;
}

/** The brand's ledger, every outcome, since inception, on the pricing basis (gross | net). */
export function fetchBrandOutcomeLedger(brandId: string, basis: LedgerBasis): Promise<ScopeOutcomeLedgerInput> {
  return held(brandStore, `${brandId}|${basis}`, BRAND_MS, async () => {
    const b = encodeURIComponent(brandId);
    const [byDay, totals, producers, outputs] = await Promise.all([
      runs(`/internal/stats/outcome-costs?groupBy=outcomeKey,day&brandId=${b}`),
      runs(`/internal/stats/outcome-costs?groupBy=outcomeKey,campaignId,orgId&brandId=${b}`),
      fleetProducers(),
      campaignOutputs(),
    ]);
    const parsed = parseScopeLedgerByDay(byDay as WireByDay, basis);
    const t = parseOutcomeLedgerTotals(totals as never, basis);
    const units = rollUpOutcomeUnitCosts(t.produced, t.consumed, outputs.outputOf, outputs.pipeOutputs).units;
    const unitCosts = new Map<string, LedgerOutcomeCost>([...units].map(([k, u]) => [k, { unitCostUsd: u.unitCostUsd }]));
    return { ...parsed, unitCosts, fleetProducers: producers, today: new Date().toISOString().slice(0, 10) };
  });
}
