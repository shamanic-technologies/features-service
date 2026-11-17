/**
 * OUTCOME-FORECAST-1117, SILVER IO: the copy of the ledger's produced Units, the SQL groups and the daily sweep.
 *
 * BRONZE = runs-service's ledger (`run_outcomes` + costs). It serves each Unit dated, priced and tagged on
 * `GET /internal/outcome-occurrences` (1,000 a page, ~4 s a page in prod: the read prices each Unit). We COPY the produced
 * Units once (`outcome_units`), one outcome at a time, one page at a time with a pause, resumable (cursor stored per
 * outcome), then follow each outcome from two days before its last pass (a Unit declared late lands in the overlap).
 * LIMITS, said: a Unit back-dated more than the overlap, or reversed after it, is seen only by a full re-copy (bump
 * `FORMAT`); a Unit's subject is copied as declared (runs-service's subject equivalences are not applied).
 *
 * The sweep then groups the copy in SQL (never a figure computed in SQL), builds every stat in `lib/outcome-silver.ts`
 * and replaces `outcome_silver_stats` whole. Daily, counted from the STORED last sweep; never on listen(), never on a read.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { outcomeSilverStats, outcomeUnits } from "../db/schema.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { loadFleetCell, storeFleetCell } from "./fleet-cell-store.js";
import { storedCopyIsFresh } from "./boot-warms.js";
import { buildSilverStats, DELAY_EDGES_HOURS, SILVER_RULE, type PairBinRow, type SilverScope, type SilverStatRow, type UnitCostRow, type UnitDayRow } from "./outcome-silver.js";

const PAGE = 1000;
/** Between two pages of the copy: the ledger read prices 1,000 Units a page, never two at once, never back to back. */
const PAGE_GAP_MS = Number(process.env.OUTCOME_UNITS_PAGE_GAP_MS ?? 2000);
const OVERLAP_MS = 2 * 86_400_000;
const SWEEP_EVERY_MS = 24 * 3_600_000;
const FIRST_TICK_MS = 5 * 60_000;
const RETRY_MS = 15 * 60_000;
/** Bump to re-copy every Unit from the start. */
const FORMAT = "v1";
const COPY_CELL = `outcome-units-copy:${FORMAT}`;
export const SILVER_SWEEP_CELL = "outcome-silver-sweep";

interface CopyState {
  keys: Record<string, { cursor: string | null; backfilled: boolean; through: string | null }>;
}

export interface LedgerUnit {
  id: string;
  organizationId: string | null;
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  declaredAt: string;
  tags: { brandIds: string[]; campaignId: string | null };
  reversal: unknown | null;
  cost: { netCents: string; grossCents: string } | null;
}

export type OutcomeUnitRow = typeof outcomeUnits.$inferInsert;

/** PURE. One produced Unit of the ledger as the row we keep. */
export function unitRowOf(u: LedgerUnit): OutcomeUnitRow {
  const num = (v: string | undefined) => (v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    id: u.id,
    outcomeKey: u.outcomeKey,
    subject: `${u.subjectService}:${u.subjectId}`,
    declaredAt: new Date(u.declaredAt),
    orgId: u.organizationId,
    brandId: u.tags.brandIds.length === 1 ? u.tags.brandIds[0]! : null,
    campaignId: u.tags.campaignId,
    costNetCents: num(u.cost?.netCents),
    costGrossCents: num(u.cost?.grossCents),
    reversed: u.reversal !== null && u.reversal !== undefined,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

async function runsGet(path: string): Promise<unknown> {
  const url = process.env.RUNS_SERVICE_URL;
  const key = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !key) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  const r = await fetchWithRetry(`${url}${path}`, { headers: { "x-api-key": key } }, { backgroundShare: false });
  if (!r.ok) throw new Error(`runs-service ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/** Every outcome any run ever declared producing (fleet), from the ledger's performers read. */
async function ledgerOutcomeKeys(): Promise<string[]> {
  // The read's widest range (400 days): an outcome nobody produced in over a year is not copied.
  const since = new Date(Date.now() - 399 * 86_400_000).toISOString().slice(0, 10);
  const body = (await runsGet(`/internal/stats/outcome-performers?since=${since}&groupBy=outcomeKey`)) as { groups?: Array<{ outcomeKey?: string | null }> };
  if (!Array.isArray(body.groups)) throw new Error("runs-service outcome-performers served no groups");
  return [...new Set(body.groups.map((g) => g.outcomeKey).filter((k): k is string => typeof k === "string" && k !== ""))].sort();
}

async function upsertUnits(rows: OutcomeUnitRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(outcomeUnits)
    .values(rows)
    .onConflictDoUpdate({
      target: outcomeUnits.id,
      set: {
        declaredAt: sql`excluded.declared_at`,
        brandId: sql`excluded.brand_id`,
        campaignId: sql`excluded.campaign_id`,
        costNetCents: sql`excluded.cost_net_cents`,
        costGrossCents: sql`excluded.cost_gross_cents`,
        reversed: sql`excluded.reversed`,
        syncedAt: sql`now()`,
      },
    });
}

/** Copy what is new of every outcome. Resolves to the pages read and whether every outcome is copied through now. */
export async function copyOutcomeUnits(): Promise<{ pages: number; units: number; complete: boolean }> {
  const stored = await loadFleetCell(COPY_CELL);
  const state: CopyState = stored ? (JSON.parse(stored.text) as CopyState) : { keys: {} };
  const save = () => storeFleetCell(COPY_CELL, JSON.stringify(state), Date.now());
  let pages = 0;
  let units = 0;
  for (const key of await ledgerOutcomeKeys()) {
    const st = (state.keys[key] ??= { cursor: null, backfilled: false, through: null });
    const passStart = new Date().toISOString();
    const after = st.backfilled && st.through ? `&declaredAfter=${encodeURIComponent(new Date(Date.parse(st.through) - OVERLAP_MS).toISOString())}` : "";
    let cursor = st.backfilled ? null : st.cursor;
    for (;;) {
      const page = (await runsGet(`/internal/outcome-occurrences?outcomeKey=${encodeURIComponent(key)}&direction=produced&limit=${PAGE}${after}${cursor ? `&cursor=${cursor}` : ""}`)) as { occurrences?: LedgerUnit[]; nextCursor?: string | null };
      if (!Array.isArray(page.occurrences)) throw new Error(`runs-service outcome-occurrences served no occurrences for ${key}`);
      await upsertUnits(page.occurrences.map(unitRowOf));
      pages += 1;
      units += page.occurrences.length;
      cursor = page.nextCursor ?? null;
      if (!st.backfilled) {
        st.cursor = cursor;
        await save();
      }
      if (cursor === null) break;
      await sleep(PAGE_GAP_MS);
    }
    // A first copy started before this pass may have missed what was declared while it ran: the next pass overlaps it.
    st.through = st.backfilled ? passStart : st.through ?? passStart;
    st.backfilled = true;
    st.cursor = null;
    await save();
    await sleep(PAGE_GAP_MS);
  }
  return { pages, units, complete: true };
}

// ── SQL groups (grouping only: every figure is computed in lib/outcome-silver.ts) ──

/** 3 significant digits of a cost (the histogram's resolution). */
const SIG3 = sql.raw(`CASE WHEN cost_net_cents IS NULL OR cost_net_cents <= 0 THEN 0 ELSE round(cost_net_cents::numeric, 2 - floor(log(cost_net_cents::numeric))::int)::float8 END`);

export async function readUnitDays(): Promise<UnitDayRow[]> {
  const rows = (await db.execute(sql`
    SELECT outcome_key, campaign_id, brand_id, to_char(declared_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS units
    FROM outcome_units WHERE NOT reversed GROUP BY 1, 2, 3, 4`)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({ outcomeKey: r.outcome_key as string, campaignId: (r.campaign_id as string | null) ?? null, brandId: (r.brand_id as string | null) ?? null, day: r.day as string, units: Number(r.units) }));
}

export async function readUnitCosts(): Promise<UnitCostRow[]> {
  const rows = (await db.execute(sql`
    SELECT outcome_key, campaign_id, brand_id, ${SIG3} AS cost, count(*)::int AS units, sum(cost_net_cents)::float8 AS net, sum(cost_gross_cents)::float8 AS gross
    FROM outcome_units WHERE NOT reversed AND cost_net_cents IS NOT NULL GROUP BY 1, 2, 3, 4`)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({ outcomeKey: r.outcome_key as string, campaignId: (r.campaign_id as string | null) ?? null, brandId: (r.brand_id as string | null) ?? null, costNetCents: Number(r.cost), units: Number(r.units), sumNetCents: Number(r.net), sumGrossCents: Number(r.gross ?? 0) }));
}

/**
 * The pairs landing on ONE outcome: each of its Units with, per other outcome, the LATEST Unit of the same subject at or
 * before it (one index probe per Unit, `outcome_units_subject`), binned by delay. One statement per outcome, never the
 * whole copy at once.
 */
export async function readPairBins(toKey: string): Promise<PairBinRow[]> {
  const edges = `{${DELAY_EDGES_HOURS.join(",")}}`;
  const rows = (await db.execute(sql`
    SELECT a.k AS from_key, a.campaign_id AS from_campaign, b.campaign_id AS to_campaign, b.brand_id,
           width_bucket(extract(epoch FROM b.declared_at - a.t) / 3600.0, ${edges}::float8[]) AS bin,
           count(*)::int AS pairs, sum(extract(epoch FROM b.declared_at - a.t) / 3600.0)::float8 AS sum_hours
    FROM outcome_units b
    CROSS JOIN LATERAL (
      SELECT DISTINCT ON (x.outcome_key) x.outcome_key AS k, x.declared_at AS t, x.campaign_id
      FROM outcome_units x
      WHERE x.subject = b.subject AND x.outcome_key <> b.outcome_key AND x.declared_at <= b.declared_at AND NOT x.reversed
      ORDER BY x.outcome_key, x.declared_at DESC
    ) a
    WHERE b.outcome_key = ${toKey} AND NOT b.reversed
    GROUP BY 1, 2, 3, 4, 5`)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    fromKey: r.from_key as string,
    toKey,
    fromCampaignId: (r.from_campaign as string | null) ?? null,
    toCampaignId: (r.to_campaign as string | null) ?? null,
    brandId: (r.brand_id as string | null) ?? null,
    bin: Number(r.bin),
    pairs: Number(r.pairs),
    sumHours: Number(r.sum_hours),
  }));
}

/** Every unit campaign's sales funnel campaign (campaign-service's whole list). */
export async function readFunnelOfUnitCampaigns(): Promise<Map<string, string>> {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("CAMPAIGN_SERVICE_URL or CAMPAIGN_SERVICE_API_KEY not configured");
  const response = await fetchWithRetry(`${url}/campaigns/list`, { headers: { "x-api-key": apiKey } });
  if (!response.ok) throw new Error(`campaign-service /campaigns/list failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  const data = (await response.json()) as { campaigns?: Array<{ id?: unknown; salesFunnelCampaignId?: unknown }> };
  if (!Array.isArray(data.campaigns)) throw new Error("campaign-service /campaigns/list returned no campaigns array");
  const out = new Map<string, string>();
  for (const c of data.campaigns) if (typeof c.id === "string" && typeof c.salesFunnelCampaignId === "string") out.set(c.id, c.salesFunnelCampaignId);
  return out;
}

async function replaceStats(rows: readonly SilverStatRow[], computedAt: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(outcomeSilverStats);
    for (let i = 0; i < rows.length; i += 500)
      await tx.insert(outcomeSilverStats).values(rows.slice(i, i + 500).map((r) => ({ scope: r.scope, scopeId: r.scopeId, fromKey: r.fromKey, toKey: r.toKey, sampleSize: r.sampleSize, body: r.body, computedAt })));
  });
}

export interface StoredSilverStat extends SilverStatRow {
  computedAt: string;
}

/** The stored stats of one scope (optionally one transition / one outcome's cost row). Fails loud. */
export async function readSilverStats(scope: SilverScope, scopeId: string, filter: { fromKey?: string; toKey?: string } = {}): Promise<StoredSilverStat[]> {
  const rows = (await db.execute(sql`
    SELECT scope, scope_id, from_key, to_key, sample_size, body, computed_at FROM outcome_silver_stats
    WHERE scope = ${scope} AND scope_id = ${scopeId}
      ${filter.fromKey !== undefined ? sql`AND from_key = ${filter.fromKey}` : sql``} ${filter.toKey !== undefined ? sql`AND to_key = ${filter.toKey}` : sql``}
    ORDER BY from_key, to_key`)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    scope: r.scope as SilverScope,
    scopeId: r.scope_id as string,
    fromKey: r.from_key as string,
    toKey: r.to_key as string,
    sampleSize: Number(r.sample_size),
    body: (typeof r.body === "string" ? JSON.parse(r.body) : r.body) as SilverStatRow["body"],
    computedAt: new Date(r.computed_at as string).toISOString(),
  }));
}

export interface SilverSweepRecord {
  sweptAt: string;
  /** The rule the stats were built on (`SILVER_RULE`); absent on a sweep before it existed. */
  rule?: string;
  copy: { pages: number; units: number };
  units: number;
  stats: number;
  copyMs: number;
  buildMs: number;
}

let sweeping: Promise<SilverSweepRecord> | null = null;
const afterSweep: Array<() => Promise<void>> = [];
/** What runs after each completed sweep (the Gold forecasts read the fresh stats). */
export function onSilverSweep(fn: () => Promise<void>): void {
  afterSweep.push(fn);
}

/** One sweep: copy what is new, group, build, replace. Single flight. */
export function runOutcomeSilverSweep(): Promise<SilverSweepRecord> {
  sweeping ??= (async () => {
    try {
      const t0 = Date.now();
      const copy = await copyOutcomeUnits();
      const t1 = Date.now();
      const [unitDays, unitCosts, funnels] = [await readUnitDays(), await readUnitCosts(), await readFunnelOfUnitCampaigns()];
      const pairBins: PairBinRow[] = [];
      for (const key of [...new Set(unitDays.map((r) => r.outcomeKey))].sort()) {
        pairBins.push(...(await readPairBins(key)));
        await sleep(250);
      }
      const now = new Date();
      const stats = buildSilverStats({ unitDays, unitCosts, pairBins, funnelOf: (c) => funnels.get(c) ?? null, today: now.toISOString().slice(0, 10) });
      await replaceStats(stats, now);
      const record: SilverSweepRecord = { sweptAt: now.toISOString(), rule: SILVER_RULE, copy: { pages: copy.pages, units: copy.units }, units: unitDays.reduce((a, r) => a + r.units, 0), stats: stats.length, copyMs: t1 - t0, buildMs: Date.now() - t1 };
      await storeFleetCell(SILVER_SWEEP_CELL, JSON.stringify(record), now.getTime());
      console.log(`[features-service] outcome silver sweep: ${copy.units} Units copied in ${copy.pages} pages (${record.copyMs} ms), ${record.units} Units held, ${stats.length} stats built in ${record.buildMs} ms`);
      for (const fn of afterSweep) await fn().catch((err) => console.error("[features-service] outcome silver sweep follower failed:", err));
      return record;
    } finally {
      sweeping = null;
    }
  })();
  return sweeping;
}

export async function readSilverSweepRecord(): Promise<SilverSweepRecord | null> {
  const cell = await loadFleetCell(SILVER_SWEEP_CELL);
  return cell ? (JSON.parse(cell.text) as SilverSweepRecord) : null;
}

async function tick(): Promise<void> {
  let waitMs = RETRY_MS;
  try {
    const last = await loadFleetCell(SILVER_SWEEP_CELL);
    if (storedCopyIsFresh(last?.computedAt, SWEEP_EVERY_MS) && (JSON.parse(last!.text) as SilverSweepRecord).rule === SILVER_RULE) waitMs = (last!.computedAt as number) + SWEEP_EVERY_MS - Date.now();
    else {
      await runOutcomeSilverSweep();
      waitMs = SWEEP_EVERY_MS;
    }
  } catch (err) {
    console.error(`[features-service] outcome silver sweep failed (the stored stats stand, retry in ${RETRY_MS / 60_000} min, the copy resumes where it stopped):`, err);
  }
  setTimeout(() => void tick(), Math.max(60_000, waitMs)).unref();
}

/** Five minutes after listen, then daily counted from the STORED last sweep (a deploy never re-runs a sweep made today). */
export function startOutcomeSilverLoop(): void {
  if (process.env.OUTCOME_SILVER_ENABLED === "false") return;
  setTimeout(() => void tick(), FIRST_TICK_MS).unref();
}
