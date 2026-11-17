/**
 * OUTCOME-FORECAST-1117, SILVER IO: the copy of the ledger's produced Units, the SQL groups and the daily sweep.
 *
 * BRONZE = runs-service's ledger (`run_outcomes` + costs). It serves each Unit dated, priced and tagged on
 * `GET /internal/outcome-occurrences` (1,000 a page, ~4 s a page in prod: the read prices each Unit). We COPY the produced
 * Units once (`outcome_units`), one outcome at a time, one page at a time with a pause, resumable (cursor stored per
 * outcome), then follow each outcome from two days before its last pass (a Unit declared late lands in the overlap).
 * LIMITS, said: a Unit back-dated more than the overlap, or reversed after it, is seen only by a full re-copy (bump
 * `FORMAT`).
 *
 * UNIT-LINKS-CONSUME-1117: which Unit a Unit came from is the ledger's STORED link (`GET
 * /internal/stats/outcome-chains/unit-links`: both Units, both dates, `delaySeconds`, the campaign(s) each carries,
 * subject equivalences followed). We copy the links whole once (`outcome_unit_links`, page by page with a pause, the
 * cursor stored after each page), then follow the cursor after each of the ledger's builds (~15 min): a link served again
 * replaces ours, a link served with `removedAt` is dropped. Every pair and every delay is read off that copy; nothing is
 * paired here by subject and date. Prod 2026-11-17: 451,692 links, 91 pages read in 139 s, no load moved on the box.
 *
 * The sweep then groups the copies in SQL (never a figure computed in SQL), builds every stat in `lib/outcome-silver.ts`
 * and replaces `outcome_silver_stats` whole. Daily, counted from the STORED last sweep; never on listen(), never on a read.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { outcomeSilverStats, outcomeUnitLinks, outcomeUnits } from "../db/schema.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { loadFleetCell, loadFleetCellStrict, storeFleetCell } from "./fleet-cell-store.js";
import { storedCopyIsFresh } from "./boot-warms.js";
import { buildSilverStats, DELAY_EDGES_HOURS, EXACT_DELAY_MAX_PAIRS, SILVER_RULE, type LinkedToRow, type PairBinRow, type SilverScope, type SilverStatRow, type UnitCostRow, type UnitDayRow } from "./outcome-silver.js";

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

class RunsReadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function runsGet(path: string): Promise<unknown> {
  const url = process.env.RUNS_SERVICE_URL;
  const key = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !key) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  const r = await fetchWithRetry(`${url}${path}`, { headers: { "x-api-key": key } }, { backgroundShare: false });
  if (!r.ok) throw new RunsReadError(`runs-service ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
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

// ── The copy of the ledger's stored links ──

const LINKS_PAGE = Number(process.env.OUTCOME_UNIT_LINKS_PAGE ?? 5000);
const LINKS_PAGE_GAP_MS = Number(process.env.OUTCOME_UNIT_LINKS_PAGE_GAP_MS ?? 500);
const LINKS_FOLLOW_EVERY_MS = 15 * 60_000;
const LINKS_FIRST_TICK_MS = 2 * 60_000;
/** Bump to copy every link again from the start. */
const LINKS_FORMAT = "v1";
const LINKS_CELL = `outcome-unit-links-copy:${LINKS_FORMAT}`;

interface LinksCopyState {
  cursor: string | null;
  /** The whole copy was read through once: the table holds every standing link as of `builtAt`. */
  copied: boolean;
  builtAt: string | null;
  /** The first whole copy, measured: links read, pages, wall time. */
  firstCopy: { links: number; pages: number; ms: number } | null;
}

export interface LedgerLinkUnit {
  id: string;
  outcomeKey: string;
  at: string;
  brandIds: string[];
  campaignId: string | null;
  campaignIds: string[];
}

export interface LedgerUnitLink {
  fromUnit: LedgerLinkUnit;
  toUnit: LedgerLinkUnit;
  delaySeconds: number;
  removedAt: string | null;
}

export type OutcomeUnitLinkRow = typeof outcomeUnitLinks.$inferInsert;

/** PURE. One stored link of the ledger as the row we keep: the delay is the one the ledger states. */
export function linkRowOf(l: LedgerUnitLink): OutcomeUnitLinkRow {
  if (!Number.isFinite(l.delaySeconds)) throw new Error(`[features-service] unit link ${l.fromUnit.id} -> ${l.toUnit.id} states no delaySeconds`);
  return {
    fromUnitId: l.fromUnit.id,
    toUnitId: l.toUnit.id,
    fromKey: l.fromUnit.outcomeKey,
    toKey: l.toUnit.outcomeKey,
    fromAt: new Date(l.fromUnit.at),
    toAt: new Date(l.toUnit.at),
    delaySeconds: l.delaySeconds,
    fromCampaignIds: [...l.fromUnit.campaignIds].sort(),
    toCampaignId: l.toUnit.campaignId,
    toCampaignIds: [...l.toUnit.campaignIds].sort(),
    fromBrandId: l.fromUnit.brandIds.length === 1 ? l.fromUnit.brandIds[0]! : null,
  };
}

/**
 * PURE. What one served page does to our copy. Links come in write order and a link is served again when it moved: the
 * LAST state of each (fromUnit, toUnit) wins; a link served with `removedAt` no longer stands and is dropped.
 */
export function linkPageChanges(links: readonly LedgerUnitLink[]): { upserts: OutcomeUnitLinkRow[]; removals: Array<{ fromUnitId: string; toUnitId: string }> } {
  const last = new Map<string, LedgerUnitLink>();
  for (const l of links) last.set(`${l.fromUnit.id}\u0000${l.toUnit.id}`, l);
  const upserts: OutcomeUnitLinkRow[] = [];
  const removals: Array<{ fromUnitId: string; toUnitId: string }> = [];
  for (const l of last.values()) {
    if (l.removedAt !== null && l.removedAt !== undefined) removals.push({ fromUnitId: l.fromUnit.id, toUnitId: l.toUnit.id });
    else upserts.push(linkRowOf(l));
  }
  return { upserts, removals };
}

async function applyLinkPage(links: readonly LedgerUnitLink[]): Promise<{ upserted: number; removed: number }> {
  const { upserts, removals } = linkPageChanges(links);
  for (let i = 0; i < upserts.length; i += 1000)
    await db
      .insert(outcomeUnitLinks)
      .values(upserts.slice(i, i + 1000))
      .onConflictDoUpdate({
        target: [outcomeUnitLinks.fromUnitId, outcomeUnitLinks.toUnitId],
        set: {
          fromKey: sql`excluded.from_key`,
          toKey: sql`excluded.to_key`,
          fromAt: sql`excluded.from_at`,
          toAt: sql`excluded.to_at`,
          delaySeconds: sql`excluded.delay_seconds`,
          fromCampaignIds: sql`excluded.from_campaign_ids`,
          toCampaignId: sql`excluded.to_campaign_id`,
          toCampaignIds: sql`excluded.to_campaign_ids`,
          fromBrandId: sql`excluded.from_brand_id`,
          syncedAt: sql`now()`,
        },
      });
  for (const r of removals) await db.execute(sql`DELETE FROM outcome_unit_links WHERE from_unit_id = ${r.fromUnitId} AND to_unit_id = ${r.toUnitId}`);
  return { upserted: upserts.length, removed: removals.length };
}

export interface LinksFollowResult {
  /** The table holds the whole copy (a first copy still running, or the ledger not built yet, = false). */
  copied: boolean;
  pages: number;
  links: number;
  removed: number;
  ms: number;
  builtAt: string | null;
}

let following: Promise<LinksFollowResult> | null = null;

/**
 * Read what the ledger wrote since our cursor (everything on the first pass) into `outcome_unit_links`. Single flight,
 * resumable: the cursor is stored after each page. The ledger answers 503 until its first build after a deploy: nothing
 * is read then, our copy stands.
 */
export function followUnitLinks(): Promise<LinksFollowResult> {
  following ??= (async () => {
    try {
      const t0 = Date.now();
      // Read LOUD: a state that cannot be read must never look like "no copy yet" (the table would be emptied).
      const stored = await loadFleetCellStrict(LINKS_CELL);
      // No state under this FORMAT = a first copy: start from an empty table (rows of an older format are not ours).
      if (!stored) await db.execute(sql`DELETE FROM outcome_unit_links`);
      const state: LinksCopyState = stored ? (JSON.parse(stored.text) as LinksCopyState) : { cursor: null, copied: false, builtAt: null, firstCopy: null };
      const save = () => storeFleetCell(LINKS_CELL, JSON.stringify(state), Date.now());
      if (!stored) await save();
      let pages = 0;
      let links = 0;
      let removed = 0;
      for (;;) {
        const pageStart = Date.now();
        let page: { builtAt?: string; links?: LedgerUnitLink[]; nextCursor?: string | null; caughtUp?: boolean };
        try {
          page = (await runsGet(`/internal/stats/outcome-chains/unit-links?limit=${LINKS_PAGE}${state.cursor ? `&cursor=${encodeURIComponent(state.cursor)}` : ""}`)) as typeof page;
        } catch (err) {
          if (err instanceof RunsReadError && err.status === 503) {
            console.log("[features-service] unit links: the ledger has not built since its deploy (503), our copy stands until its next build");
            return { copied: state.copied, pages, links, removed, ms: Date.now() - t0, builtAt: state.builtAt };
          }
          throw err;
        }
        if (!Array.isArray(page.links) || typeof page.caughtUp !== "boolean") throw new Error("runs-service unit-links served no links or no caughtUp");
        const applied = await applyLinkPage(page.links);
        pages += 1;
        links += page.links.length;
        removed += applied.removed;
        // The cursor to come back with: the page's own; a caught-up page with none keeps the one we hold.
        state.cursor = page.nextCursor ?? state.cursor;
        state.builtAt = page.builtAt ?? state.builtAt;
        const more = !page.caughtUp;
        if (more && (page.nextCursor === null || page.nextCursor === undefined)) throw new Error("runs-service unit-links served no nextCursor before caughtUp");
        if (more) await sleep(LINKS_PAGE_GAP_MS);
        if (!state.copied) {
          // The first whole copy, measured as it goes (a copy resumed after a restart keeps what it had read).
          state.firstCopy = { links: (state.firstCopy?.links ?? 0) + page.links.length, pages: (state.firstCopy?.pages ?? 0) + 1, ms: (state.firstCopy?.ms ?? 0) + (Date.now() - pageStart) };
          if (!more) {
            // A table filled in one go has no statistics yet: the walks and joins that follow are planned on real ones.
            await db.execute(sql`ANALYZE outcome_unit_links`);
            state.copied = true;
            console.log(`[features-service] unit links: first whole copy done, ${state.firstCopy.links} links in ${state.firstCopy.pages} pages, ${state.firstCopy.ms} ms`);
          }
        }
        await save();
        if (!more) break;
      }
      return { copied: state.copied, pages, links, removed, ms: Date.now() - t0, builtAt: state.builtAt };
    } finally {
      following = null;
    }
  })();
  return following;
}

export async function readLinksCopyState(): Promise<LinksCopyState | null> {
  const cell = await loadFleetCell(LINKS_CELL);
  return cell ? (JSON.parse(cell.text) as LinksCopyState) : null;
}

// ── SQL groups (grouping only: every figure is computed in lib/outcome-silver.ts) ──

/** 3 significant digits of a cost (the histogram's resolution). */
const SIG3 = sql.raw(`CASE WHEN u.cost_net_cents IS NULL OR u.cost_net_cents <= 0 THEN 0 ELSE round(u.cost_net_cents::numeric, 2 - floor(log(u.cost_net_cents::numeric))::int)::float8 END`);

/**
 * The campaign(s) a Unit carries: its own run's; else, on a Unit whose run names none, the ones the ledger serves on a
 * link leading to it (`toUnit.campaignIds`: the campaigns of the Units it came from); else none.
 */
const CARRIED = sql.raw(`CASE WHEN u.campaign_id IS NOT NULL THEN ARRAY[u.campaign_id] ELSE COALESCE(c.ids, '{}'::text[]) END`);
/** The few Units carried without a campaign of their own (prod 2026-11-17: 1,468), read once per statement off the partial index. */
const CARRIED_CTE = sql.raw(`WITH carried AS MATERIALIZED (SELECT DISTINCT ON (to_unit_id) to_unit_id, to_campaign_ids AS ids FROM outcome_unit_links WHERE to_campaign_id IS NULL AND to_campaign_ids <> '{}'::text[] ORDER BY to_unit_id)`);
const CARRIED_JOIN = sql.raw(`LEFT JOIN carried c ON c.to_unit_id = u.id AND u.campaign_id IS NULL`);
const textArray = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

export async function readUnitDays(): Promise<UnitDayRow[]> {
  const rows = (await db.execute(sql`
    ${CARRIED_CTE}
    SELECT u.outcome_key, ${CARRIED} AS campaign_ids, u.brand_id, to_char(u.declared_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS units
    FROM outcome_units u ${CARRIED_JOIN} WHERE NOT u.reversed GROUP BY 1, 2, 3, 4`)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({ outcomeKey: r.outcome_key as string, campaignIds: textArray(r.campaign_ids), brandId: (r.brand_id as string | null) ?? null, day: r.day as string, units: Number(r.units) }));
}

export async function readUnitCosts(): Promise<UnitCostRow[]> {
  const rows = (await db.execute(sql`
    ${CARRIED_CTE}
    SELECT u.outcome_key, ${CARRIED} AS campaign_ids, u.brand_id, ${SIG3} AS cost, count(*)::int AS units, sum(u.cost_net_cents)::float8 AS net, sum(u.cost_gross_cents)::float8 AS gross
    FROM outcome_units u ${CARRIED_JOIN} WHERE NOT u.reversed AND u.cost_net_cents IS NOT NULL GROUP BY 1, 2, 3, 4`)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({ outcomeKey: r.outcome_key as string, campaignIds: textArray(r.campaign_ids), brandId: (r.brand_id as string | null) ?? null, costNetCents: Number(r.cost), units: Number(r.units), sumNetCents: Number(r.net), sumGrossCents: Number(r.gross ?? 0) }));
}

/** A walk follows at most this many links (prod 2026-11-17: the longest holds 5). */
const MAX_WALK_LINKS = 12;

/**
 * The pairs leaving ONE outcome: each of its Units with every Unit the stored links lead to from it, directly or through
 * other Units (each pair once; the delay = the links' stated `delaySeconds` added along the walk), binned by delay, each
 * small group with its pairs' own delays (exact quantiles on a small sample). A `to` Unit dated before its `from` Unit (a
 * past fact recorded late: a negative stated delay) is a pair of delay zero. Beside them, the `to` Units those pairs tie
 * (each once, by the campaigns and brand the `to` Unit carries): the link coverage of the Units counted. One statement
 * per outcome, never the whole copy at once.
 */
export async function readPairBins(fromKey: string): Promise<{ pairBins: PairBinRow[]; linkedTo: LinkedToRow[] }> {
  const edges = `{${DELAY_EDGES_HOURS.join(",")}}`;
  const rows = (await db.execute(sql`
    WITH RECURSIVE walk AS (
      SELECT l.from_unit_id AS src, l.from_campaign_ids AS campaigns, l.from_brand_id AS brand, l.to_unit_id AS unit, l.to_key AS k, l.to_campaign_ids AS to_campaigns, l.delay_seconds AS delay, 1 AS depth
      FROM outcome_unit_links l WHERE l.from_key = ${fromKey}
      UNION ALL
      SELECT w.src, w.campaigns, w.brand, l.to_unit_id, l.to_key, l.to_campaign_ids, w.delay + l.delay_seconds, w.depth + 1
      FROM walk w JOIN outcome_unit_links l ON l.from_unit_id = w.unit WHERE w.depth < ${MAX_WALK_LINKS}
    ), pairs AS MATERIALIZED (
      SELECT * FROM (SELECT DISTINCT ON (src, unit) unit, campaigns, brand, k, to_campaigns, GREATEST(delay, 0) / 3600.0 AS hours FROM walk ORDER BY src, unit, depth) p WHERE k <> ${fromKey}
    )
    SELECT 'bin' AS kind, k AS to_key, campaigns, brand, width_bucket(hours, ${edges}::float8[]) AS bin, count(*)::int AS n, sum(hours)::float8 AS sum_hours,
           CASE WHEN count(*) <= ${EXACT_DELAY_MAX_PAIRS} THEN array_agg(hours::float8) END AS samples
    FROM pairs GROUP BY 2, 3, 4, 5
    UNION ALL
    SELECT 'linked', t.k, t.to_campaigns, u.brand_id, NULL, count(*)::int, NULL, NULL
    FROM (SELECT DISTINCT unit, k, to_campaigns FROM pairs) t JOIN outcome_units u ON u.id = t.unit AND NOT u.reversed GROUP BY 2, 3, 4`)) as unknown as Array<Record<string, unknown>>;
  const pairBins: PairBinRow[] = [];
  const linkedTo: LinkedToRow[] = [];
  for (const r of rows) {
    if (r.kind === "linked") linkedTo.push({ fromKey, toKey: r.to_key as string, campaignIds: textArray(r.campaigns), brandId: (r.brand as string | null) ?? null, units: Number(r.n) });
    else pairBins.push({ fromKey, toKey: r.to_key as string, fromCampaignIds: textArray(r.campaigns), brandId: (r.brand as string | null) ?? null, bin: Number(r.bin), pairs: Number(r.n), sumHours: Number(r.sum_hours), samplesHours: Array.isArray(r.samples) ? (r.samples as unknown[]).map(Number) : null });
  }
  return { pairBins, linkedTo };
}

/** Every outcome a stored link leaves from. */
export async function readLinkFromKeys(): Promise<string[]> {
  const rows = (await db.execute(sql`SELECT DISTINCT from_key FROM outcome_unit_links ORDER BY 1`)) as unknown as Array<{ from_key: string }>;
  return rows.map((r) => r.from_key);
}

/** One Unit a campaign carries without its run naming it (declared late on a run with no campaign), as the links serve it. */
export interface CarriedUnitRow {
  outcomeKey: string;
  day: string;
  campaignIds: string[];
}

/**
 * The Units these unit campaigns CARRY though their own run names no campaign: the `to` Units of a stored link whose
 * `campaignIds` hold one of them (each Unit once). Read off our copy, as fresh as the last follow (~15 min).
 */
export async function readCarriedUnits(unitCampaignIds: readonly string[]): Promise<CarriedUnitRow[]> {
  if (unitCampaignIds.length === 0) return [];
  const ids = sql.join(unitCampaignIds.map((c) => sql`${c}`), sql`, `);
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (to_unit_id) to_key, to_char(to_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, to_campaign_ids
    FROM outcome_unit_links WHERE to_campaign_id IS NULL AND to_campaign_ids && ARRAY[${ids}]::text[]
    ORDER BY to_unit_id`)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({ outcomeKey: r.to_key as string, day: r.day as string, campaignIds: textArray(r.to_campaign_ids) }));
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
  /** The follow of the ledger's stored links made by this sweep, and the links then held. */
  links?: { pages: number; read: number; removed: number; held: number; ms: number; builtAt: string | null };
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
      const follow = await followUnitLinks();
      // Never a stat built on half the links: the sweep waits for the whole copy (retried by the tick).
      if (!follow.copied) throw new Error("the ledger's unit links are not copied through yet (first copy running, or the ledger has not built since its deploy)");
      const t1 = Date.now();
      const [unitDays, unitCosts, funnels] = [await readUnitDays(), await readUnitCosts(), await readFunnelOfUnitCampaigns()];
      const pairBins: PairBinRow[] = [];
      const linkedTo: LinkedToRow[] = [];
      for (const key of await readLinkFromKeys()) {
        const r = await readPairBins(key);
        pairBins.push(...r.pairBins);
        linkedTo.push(...r.linkedTo);
        await sleep(250);
      }
      const [{ held }] = (await db.execute(sql`SELECT count(*)::int AS held FROM outcome_unit_links`)) as unknown as [{ held: number }];
      const now = new Date();
      const stats = buildSilverStats({ unitDays, unitCosts, pairBins, linkedTo, funnelOf: (c) => funnels.get(c) ?? null, today: now.toISOString().slice(0, 10) });
      await replaceStats(stats, now);
      const record: SilverSweepRecord = { sweptAt: now.toISOString(), rule: SILVER_RULE, copy: { pages: copy.pages, units: copy.units }, links: { pages: follow.pages, read: follow.links, removed: follow.removed, held: Number(held), ms: follow.ms, builtAt: follow.builtAt }, units: unitDays.reduce((a, r) => a + r.units, 0), stats: stats.length, copyMs: t1 - t0, buildMs: Date.now() - t1 };
      await storeFleetCell(SILVER_SWEEP_CELL, JSON.stringify(record), now.getTime());
      console.log(`[features-service] outcome silver sweep: ${copy.units} Units copied in ${copy.pages} pages (${record.copyMs} ms), ${follow.links} links followed in ${follow.ms} ms (${held} held), ${record.units} Units held, ${stats.length} stats built in ${record.buildMs} ms`);
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

/**
 * The last sweep, only when its stats were built on TODAY's rule: stats stored under another rule are not served (a
 * reader treats them as not built yet, until the sweep the rule change triggers replaces them).
 */
export async function readCurrentSilverSweep(): Promise<SilverSweepRecord | null> {
  const record = await readSilverSweepRecord();
  return record !== null && record.rule === SILVER_RULE ? record : null;
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

async function linksTick(): Promise<void> {
  try {
    const r = await followUnitLinks();
    if (r.links > 0) console.log(`[features-service] unit links followed: ${r.links} links in ${r.pages} pages, ${r.removed} dropped, ${r.ms} ms`);
  } catch (err) {
    console.error(`[features-service] unit links follow failed (our copy stands, the cursor resumes in ${LINKS_FOLLOW_EVERY_MS / 60_000} min):`, err);
  }
  setTimeout(() => void linksTick(), LINKS_FOLLOW_EVERY_MS).unref();
}

/**
 * After listen, never on it: the links are followed from two minutes in then every 15 (the ledger's build cadence); the
 * sweep five minutes in, then daily counted from the STORED last sweep (a deploy never re-runs a sweep made today).
 */
export function startOutcomeSilverLoop(): void {
  if (process.env.OUTCOME_SILVER_ENABLED === "false") return;
  setTimeout(() => void linksTick(), LINKS_FIRST_TICK_MS).unref();
  setTimeout(() => void tick(), FIRST_TICK_MS).unref();
}
