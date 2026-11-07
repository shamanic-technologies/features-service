/**
 * LEDGER-ONLY-1107 IO: a brand's outcome Units from runs-service's general ledger (the pure rule is `scope-outcome-ledger.ts`).
 *
 *  - Units per outcome per day + their own cost + the consumptions of unknown provenance:
 *    `GET /internal/stats/outcome-costs?groupBy=outcomeKey,day&brandId=` (since the ledger's inception); on the same body,
 *    `producedElsewhere[]` = the lead-state Units another factory produced (LEDGER-OTHER-FACTORY-1107, `factory` dimension).
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
import type { ScopeOutcomeLedgerInput, LedgerOutcomeCost, OtherFactory } from "./scope-outcome-ledger.js";

interface WireCost {
  grossCents?: string;
  netCents?: string;
  vendorCents?: string;
}
interface WireByDay {
  daysMissing?: string[];
  produced?: Array<{ dimensions?: Record<string, string | null>; occurrences?: number; cost?: WireCost }>;
  consumed?: Array<{ dimensions?: Record<string, string | null>; unknownProvenance?: string }>;
  producedElsewhere?: Array<{ dimensions?: Record<string, string | null>; occurrences?: number }>;
}

const OTHER_FACTORIES: readonly OtherFactory[] = ["another_factory", "no_proof"];

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
  // LEDGER-OTHER-FACTORY-1107: another factory's Units (no run, no cost). A group with no day (a non-day groupBy) is no Unit of a day.
  const elsewhereByDay = new Map<string, Map<string, Map<OtherFactory, number>>>();
  for (const g of body.producedElsewhere ?? []) {
    const key = g.dimensions?.outcomeKey;
    const day = g.dimensions?.day;
    const factory = g.dimensions?.factory as OtherFactory | undefined;
    if (!key || !day) throw new Error("[features-service] scope outcome ledger: a producedElsewhere group names no outcomeKey or day");
    if (!factory || !OTHER_FACTORIES.includes(factory)) throw new Error(`[features-service] scope outcome ledger: a producedElsewhere group names an unknown factory ${String(factory)}`);
    const days = elsewhereByDay.get(key) ?? elsewhereByDay.set(key, new Map()).get(key)!;
    const byFactory = days.get(day) ?? days.set(day, new Map()).get(day)!;
    byFactory.set(factory, (byFactory.get(factory) ?? 0) + (g.occurrences ?? 0));
  }
  return { producedByDay, ownCostUsd, undeclaredConsumptions, elsewhereByDay, daysMissing: [...(body.daysMissing ?? [])].sort() };
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

let lastGoodProducers: Map<string, string[]> | null = null;

/**
 * Who declares each outcome anywhere (fleet, 15 min). LEDGER-ONLY-1107-P2: SOFT. It only names a producer gap, never a
 * count, so a failed read (runs-service's fleet performers read hits its statement timeout under load, prod 2026-11-07)
 * serves the last good map, else `null` (unknown: no gap claimed), logged; never every count of every scope nulled.
 */
async function fleetProducers(): Promise<Map<string, string[]> | null> {
  try {
    const m = (await held(fleetStore, "producers", FLEET_MS, async () => {
      const since = new Date(Date.now() - 399 * 86_400_000).toISOString().slice(0, 10);
      return parseFleetProducers((await runs(`/internal/stats/outcome-performers?since=${since}&groupBy=outcomeKey,serviceName`)) as never);
    })) as Map<string, string[]>;
    lastGoodProducers = m;
    return m;
  } catch (err) {
    console.error(`[features-service] scope outcome ledger: fleet producers unreadable (${lastGoodProducers ? "last good map served" : "no producer gap named"}): ${(err as Error).message}`);
    return lastGoodProducers;
  }
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
    return { ...parsed, unitCosts, fleetProducers: producers ?? new Map(), fleetProducersKnown: producers !== null, today: new Date().toISOString().slice(0, 10) };
  });
}

const campaignStore = new Map<string, { at: number; value: Promise<ReturnType<typeof parseScopeLedgerByDay>> }>();

function campaignByDay(campaignId: string, basis: LedgerBasis) {
  return held(campaignStore, `${campaignId}|${basis}`, BRAND_MS, async () =>
    parseScopeLedgerByDay((await runs(`/internal/stats/outcome-costs?groupBy=outcomeKey,day&campaignId=${encodeURIComponent(campaignId)}`)) as WireByDay, basis),
  );
}

/**
 * LEDGER-ONLY-1107-P2: the ledger of a SET of campaigns (a funnel campaign's units, one pipe, a campaign identity): the
 * Units their runs produced per outcome per day, their own cost, the consumptions of unknown provenance in that scope
 * (one runs-service read per campaign, held 60 s, summed: a Unit is declared by ONE run, so of ONE campaign). The
 * every-path unit cost ($ each, the standard) and who declares each outcome are the BRAND's (a cost is a brand figure).
 */
export async function fetchCampaignSetOutcomeLedger(campaignIds: readonly string[], brandId: string, basis: LedgerBasis): Promise<ScopeOutcomeLedgerInput> {
  const ids = [...new Set(campaignIds)].sort();
  const [parts, brand] = await Promise.all([Promise.all(ids.map((id) => campaignByDay(id, basis))), fetchBrandOutcomeLedger(brandId, basis)]);
  const producedByDay = new Map<string, Map<string, number>>();
  const ownCostUsd = new Map<string, number>();
  const undeclaredConsumptions = new Map<string, number>();
  const elsewhereByDay = new Map<string, Map<string, Map<OtherFactory, number>>>();
  const daysMissing = new Set<string>();
  for (const p of parts) {
    // Another factory's Units carry no campaign (a reach has no run): a campaign-scoped read holds none, merged all the same.
    for (const [k, days] of p.elsewhereByDay) {
      const into = elsewhereByDay.get(k) ?? elsewhereByDay.set(k, new Map()).get(k)!;
      for (const [d, byF] of days) {
        const f = into.get(d) ?? into.set(d, new Map()).get(d)!;
        for (const [x, n] of byF) f.set(x, (f.get(x) ?? 0) + n);
      }
    }
    for (const [k, days] of p.producedByDay) {
      const into = producedByDay.get(k) ?? producedByDay.set(k, new Map()).get(k)!;
      for (const [d, n] of days) into.set(d, (into.get(d) ?? 0) + n);
    }
    for (const [k, c] of p.ownCostUsd) ownCostUsd.set(k, (ownCostUsd.get(k) ?? 0) + c);
    for (const [k, n] of p.undeclaredConsumptions) undeclaredConsumptions.set(k, (undeclaredConsumptions.get(k) ?? 0) + n);
    for (const d of p.daysMissing) daysMissing.add(d);
  }
  return {
    producedByDay,
    ownCostUsd,
    undeclaredConsumptions,
    elsewhereByDay,
    unitCosts: brand.unitCosts,
    fleetProducers: brand.fleetProducers,
    fleetProducersKnown: brand.fleetProducersKnown,
    daysMissing: [...daysMissing].sort(),
    today: brand.today,
  };
}

const audienceStore = new Map<string, { at: number; value: Promise<Map<string, Map<string, number>>> }>();

/** LEDGER-ONLY-1107-P2: a brand's (or a set of its campaigns') ledger Units per audience (the one each run was SERVED under) per outcome. */
export async function fetchAudienceUnits(brandId: string, campaignIds: readonly string[] | null): Promise<Map<string, Map<string, number>>> {
  const read = (q: string) =>
    held(audienceStore, q, BRAND_MS, async () => {
      const body = (await runs(`/internal/stats/outcome-costs?groupBy=outcomeKey,audienceId&${q}`)) as WireByDay;
      const out = new Map<string, Map<string, number>>();
      for (const g of body.produced ?? []) {
        const a = g.dimensions?.audienceId;
        const k = g.dimensions?.outcomeKey;
        if (!a || !k) continue;
        const m = out.get(a) ?? out.set(a, new Map()).get(a)!;
        m.set(k, (m.get(k) ?? 0) + (g.occurrences ?? 0));
      }
      return out;
    });
  const parts = await Promise.all(
    campaignIds === null ? [read(`brandId=${encodeURIComponent(brandId)}`)] : [...new Set(campaignIds)].map((id) => read(`campaignId=${encodeURIComponent(id)}`)),
  );
  const out = new Map<string, Map<string, number>>();
  for (const p of parts)
    for (const [a, m] of p) {
      const into = out.get(a) ?? out.set(a, new Map()).get(a)!;
      for (const [k, n] of m) into.set(k, (into.get(k) ?? 0) + n);
    }
  return out;
}

const workflowStore = new Map<string, { at: number; value: Promise<Map<string, Map<string, Map<string, number>>>> }>();

/**
 * LEDGER-ONLY-1107-P2: Units per workflow version (`workflowSlug` of the producing run) per outcome per day, for a brand
 * or a set of its campaigns: one scope ledger per workflow (`ledgerOfWorkflowSlugs`).
 */
export async function fetchWorkflowUnits(brandId: string, campaignIds: readonly string[] | null): Promise<Map<string, Map<string, Map<string, number>>>> {
  const read = (q: string) =>
    held(workflowStore, q, BRAND_MS, async () => {
      const body = (await runs(`/internal/stats/outcome-costs?groupBy=outcomeKey,workflowSlug,day&${q}`)) as WireByDay;
      const out = new Map<string, Map<string, Map<string, number>>>();
      for (const g of body.produced ?? []) {
        const w = g.dimensions?.workflowSlug;
        const k = g.dimensions?.outcomeKey;
        const d = g.dimensions?.day;
        if (!w || !k || !d) continue;
        const byKey = out.get(w) ?? out.set(w, new Map()).get(w)!;
        const byDay = byKey.get(k) ?? byKey.set(k, new Map()).get(k)!;
        byDay.set(d, (byDay.get(d) ?? 0) + (g.occurrences ?? 0));
      }
      return out;
    });
  const parts = await Promise.all(
    campaignIds === null ? [read(`brandId=${encodeURIComponent(brandId)}`)] : [...new Set(campaignIds)].map((id) => read(`campaignId=${encodeURIComponent(id)}`)),
  );
  const out = new Map<string, Map<string, Map<string, number>>>();
  for (const p of parts)
    for (const [w, byKey] of p) {
      const wk = out.get(w) ?? out.set(w, new Map()).get(w)!;
      for (const [k, byDay] of byKey) {
        const kd = wk.get(k) ?? wk.set(k, new Map()).get(k)!;
        for (const [d, n] of byDay) kd.set(d, (kd.get(d) ?? 0) + n);
      }
    }
  return out;
}

/** PURE. One scope ledger for the Units of a workflow's versions; reasons (producers, undeclared) from the brand's. */
export function ledgerOfWorkflowSlugs(units: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, number>>>, slugs: readonly string[], brand: ScopeOutcomeLedgerInput): ScopeOutcomeLedgerInput {
  const producedByDay = new Map<string, Map<string, number>>();
  for (const s of slugs)
    for (const [k, byDay] of units.get(s) ?? []) {
      const into = producedByDay.get(k) ?? producedByDay.set(k, new Map()).get(k)!;
      for (const [d, n] of byDay) into.set(d, (into.get(d) ?? 0) + n);
    }
  return { ...brand, producedByDay, elsewhereByDay: new Map(), ownCostUsd: new Map() };
}
