/**
 * runs-service's general ledger as ONE book every pipe is priced on (LEDGER-HISTORY-1024; pure rules in
 * `lib/ledger-pipe-costs.ts`). Three fleet reads since inception, optionally cut at a run-start day (the mature cohort:
 * runs started on or before it, and the occurrences whose consumed input such a run produced), held 15 min per (basis,
 * cut), one read at a time. FAIL-LOUD: a refused read throws; the readers then keep the previous regime for the whole
 * fleet (never half the pipes on each).
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { readRunsLedger } from "./runs-ledger-read.js";
import { standingUnitsByDay } from "./scope-outcome-ledger.js";
import { matureCutParams, type LedgerBasis } from "./outcome-cost-totals-client.js";
import type { LedgerPipeBook } from "./ledger-pipe-costs.js";
import { loadChannelCatalogue } from "./channel-declarations-store.js";
import { legMaturity } from "./maturity.js";
import { pipeLegKeyOf, servedLegKeyOf } from "./funnel-legs.js";

interface WireCost {
  grossCents?: string;
  netCents?: string;
  vendorCents?: string;
  unpricedGrossCents?: string;
}

/** A book basis: the three money bases + the staff "spend with no vendor price" twin (the actual-cost reads). */
export type BookBasis = LedgerBasis | "unpricedGross";
interface Wire {
  daysMissing?: string[];
  /** The part of daysMissing that IS stored, computed before a fact recorded later (runs-service `daysStale`). */
  daysStale?: string[];
  produced?: Array<{ dimensions?: Record<string, string | null>; occurrences?: number; cost?: WireCost }>;
  consumed?: Array<{ dimensions?: Record<string, string | null>; consumptions?: string; unknownProvenance?: string }>;
  scope?: Array<{ dimensions?: Record<string, string | null>; spend?: WireCost; producedCost?: WireCost; producedNone?: WireCost; support?: WireCost }>;
}

const usd = (c: WireCost | undefined, basis: BookBasis): number => {
  const v = basis === "vendor" ? c?.vendorCents : basis === "net" ? c?.netCents : basis === "unpricedGross" ? c?.unpricedGrossCents : c?.grossCents;
  if (v === undefined) throw new Error(`[features-service] ledger book: a cost carries no ${basis} figure`);
  return Number(v) / 100;
};

export interface LedgerBookRead {
  book: LedgerPipeBook;
  /** Days of the read runs-service has not computed yet, or computed before a fact recorded later (stale). */
  daysMissing: number;
  /** The same days, listed (sorted). */
  missingDays?: string[];
  /** Of `missingDays`, the days that ARE stored, only computed before a later fact (their rows are read, a tick behind). */
  staleDays?: string[];
}

/** The run-start day of a group, only when the read grouped by it (the daily book): absent otherwise, rows unchanged. */
const dayDims = (d: Record<string, string | null> | undefined): { runStartDay?: string | null } =>
  d && "runStartDay" in d ? { runStartDay: d.runStartDay ?? null } : {};

/** The script of a group (and of its consumed input's producer), only when the read grouped by it (the daily book). */
const scriptDims = (d: Record<string, string | null> | undefined): { scriptSlug?: string | null; sourceScriptSlug?: string | null } => ({
  ...(d && "scriptSlug" in d ? { scriptSlug: d.scriptSlug ?? null } : {}),
  ...(d && "sourceScriptSlug" in d ? { sourceScriptSlug: d.sourceScriptSlug ?? null } : {}),
});

/**
 * LEDGER-NEGATIVE-DAYS-1110: each produced group (outcome × campaign × workflow × audience) netted of its withdrawn Units by
 * THE rule (`standingUnitsByDay` over its run-start days; one bucket when the read has no day), in place.
 */
function standProduced(rows: Array<{ outcomeKey: string; campaignId: string | null; workflowSlug: string | null; audienceId: string | null; occurrences: number; runStartDay?: string | null; scriptSlug?: string | null }>): void {
  if (!rows.some((r) => r.occurrences < 0)) return;
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = JSON.stringify([r.outcomeKey, r.campaignId, r.workflowSlug, r.audienceId, r.scriptSlug ?? null]);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  for (const g of groups.values()) {
    if (!g.some((r) => r.occurrences < 0)) continue;
    const standing = standingUnitsByDay(g.map((r) => [r.runStartDay ?? "", r.occurrences] as const));
    for (const r of g) {
      const d = r.runStartDay ?? "";
      r.occurrences = standing.get(d) ?? 0;
      standing.delete(d);
    }
  }
}

/** PURE. The three wire bodies as one book + the fleet reconciliation. */
export function parseLedgerBook(producedBody: Wire, consumedBody: Wire, scopeBody: Wire, basis: BookBasis): LedgerBookRead {
  const produced = (producedBody.produced ?? []).map((g) => {
    const key = g.dimensions?.outcomeKey;
    if (!key) throw new Error("[features-service] ledger book: a produced group names no outcomeKey");
    return { outcomeKey: key, campaignId: g.dimensions?.campaignId ?? null, workflowSlug: g.dimensions?.workflowSlug ?? null, audienceId: g.dimensions?.audienceId ?? null, occurrences: g.occurrences ?? 0, costUsd: usd(g.cost, basis), ...dayDims(g.dimensions), ...scriptDims(g.dimensions) };
  });
  standProduced(produced);
  const consumed = [];
  for (const g of consumedBody.consumed ?? []) {
    const consumer = g.dimensions?.consumingOutcomeKey;
    const key = g.dimensions?.consumedOutcomeKey;
    if (!key) throw new Error("[features-service] ledger book: a consumed group names no consumedOutcomeKey");
    const count = Number(g.consumptions ?? 0);
    if (!consumer) continue;
    consumed.push({
      consumerKey: consumer,
      consumedKey: key,
      campaignId: g.dimensions?.campaignId ?? null,
      workflowSlug: g.dimensions?.workflowSlug ?? null,
      audienceId: g.dimensions?.audienceId ?? null,
      sourceCampaignId: g.dimensions?.sourceCampaignId ?? null,
      sourceWorkflowSlug: g.dimensions?.sourceWorkflowSlug ?? null,
      sourceAudienceId: g.dimensions?.sourceAudienceId ?? null,
      count,
      ...dayDims(g.dimensions),
      ...(g.dimensions && "sourceRunStartDay" in g.dimensions ? { sourceRunStartDay: g.dimensions.sourceRunStartDay ?? null } : {}),
      ...scriptDims(g.dimensions),
    });
  }
  // runs-service's "produced none" holds the support marks too: only the rest is a pipe's loss
  const noOutput = (scopeBody.scope ?? []).map((s) => ({
    campaignId: s.dimensions?.campaignId ?? null,
    workflowSlug: s.dimensions?.workflowSlug ?? null,
    audienceId: s.dimensions?.audienceId ?? null,
    costUsd: Math.max(usd(s.producedNone, basis) - usd(s.support, basis), 0),
    ...dayDims(s.dimensions),
    ...scriptDims(s.dimensions),
  }));
  const daysMissing = Math.max(...[producedBody, consumedBody, scopeBody].map((b) => (b.daysMissing ?? []).length));
  const missingDays = [...new Set([producedBody, consumedBody, scopeBody].flatMap((b) => b.daysMissing ?? []))].sort();
  // a day is only stale when every section stores it (a section missing it outright is missing)
  const staleIn = (b: Wire) => new Set(b.daysStale ?? []);
  const stale = [producedBody, consumedBody, scopeBody].map(staleIn);
  const staleDays = missingDays.filter((d) => stale.every((s, i) => s.has(d) || !([producedBody, consumedBody, scopeBody][i]!.daysMissing ?? []).includes(d)));
  return { book: { produced, noOutput, consumed }, daysMissing, missingDays, staleDays };
}

/** The ledger's first month (runs-service states its own inception, 2026-02-02). */
export const LEDGER_FIRST_DAY = "2026-02-01";

/** PURE. Calendar months from `first` to `last` (inclusive UTC days), each as [since, until]. */
export function monthRanges(first: string, last: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let d = new Date(`${first.slice(0, 7)}-01T00:00:00Z`);
  while (d.toISOString().slice(0, 10) <= last) {
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const since = d.toISOString().slice(0, 10) < first ? first : d.toISOString().slice(0, 10);
    const end = new Date(next.getTime() - 86_400_000).toISOString().slice(0, 10);
    out.push([since, end > last ? last : end]);
    d = next;
  }
  return out;
}

/**
 * A month read answers every basis's book built within 5 min of it (the books of one fleet build ask gross, net, vendor and
 * unpriced back to back); a book is then held 15 min as before, so it stands on a read at most 20 min old.
 */
const BOOK_READ_HOLD_MS = 5 * 60_000;

async function readRange(groupBy: string, since: string, until: string, runStartUntil?: string, depth = 0): Promise<Wire> {
  // LEDGER-LOAD-1107: one runs-service read per month URL for EVERY basis (gross, net, vendor, unpriced each parse it),
  // shared process-wide and held as long as a book is.
  const r = await readRunsLedger(`/internal/stats/outcome-costs?groupBy=${groupBy}&since=${since}&until=${until}${matureCutParams(runStartUntil)}`, BOOK_READ_HOLD_MS);
  // over runs-service's group cap: the range splits in halves (every section is additive over disjoint days)
  // ...and on a server error too, up to 3 halvings: a month that times out under load (runs-service 500, statement
  // timeout, 2026-11-01) reads as two smaller ones. Every section is additive over disjoint days either way.
  if ((r.status === 422 || (r.status >= 500 && depth < 3)) && since < until) {
    if (r.status >= 500) console.warn(`[features-service] runs-service outcome-costs ${r.status} on ${groupBy} ${since}..${until}, read in halves`);
    const mid = new Date((Date.parse(`${since}T00:00:00Z`) + Date.parse(`${until}T00:00:00Z`)) / 2).toISOString().slice(0, 10);
    const after = new Date(Date.parse(`${mid}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    return concatWire([await readRange(groupBy, since, mid, runStartUntil, depth + 1), await readRange(groupBy, after, until, runStartUntil, depth + 1)]);
  }
  if (!r.ok) throw new Error(`[features-service] runs-service outcome-costs (${groupBy} ${since}..${until}) ${r.status}: ${r.text.slice(0, 200)}`);
  return r.json as Wire;
}

/** PURE. Disjoint day ranges of one read as one body: rows concatenated (every reader sums them), missing days unioned. */
export function concatWire(parts: readonly Wire[]): Wire {
  return {
    daysMissing: [...new Set(parts.flatMap((p) => p.daysMissing ?? []))],
    daysStale: [...new Set(parts.flatMap((p) => p.daysStale ?? []))],
    produced: parts.flatMap((p) => p.produced ?? []),
    consumed: parts.flatMap((p) => p.consumed ?? []),
    scope: parts.flatMap((p) => p.scope ?? []),
  };
}

/** One grouping since inception (or `sinceDay`), read month by month (runs-service's group cap holds per read, never per history). */
async function read(groupBy: string, runStartUntil?: string, sinceDay: string = LEDGER_FIRST_DAY): Promise<Wire> {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const months = monthRanges(sinceDay < LEDGER_FIRST_DAY ? LEDGER_FIRST_DAY : sinceDay, today > yesterday ? today : yesterday);
  const parts: Wire[] = [];
  for (const [since, until] of months) parts.push(await readRange(groupBy, since, until, runStartUntil));
  return concatWire(parts);
}

const HELD_MS = 15 * 60_000;
const DAILY_HELD_MS = 150 * 60_000;
const held = new Map<string, { at: number; value: LedgerBookRead }>();
const inFlight = new Map<string, Promise<LedgerBookRead>>();

/** The book, held 15 min per (basis, cut). `runStartUntil` = inclusive last run-start UTC day of a mature cohort. */
export async function loadLedgerBook(basis: BookBasis, runStartUntil?: string): Promise<LedgerBookRead> {
  const key = `${basis}|${runStartUntil ?? ""}`;
  const h = held.get(key);
  if (h && Date.now() - h.at < HELD_MS) return h.value;
  const running = inFlight.get(key);
  if (running) return running;
  const p = (async () => {
    // a runs build that does not serve the run-day cut ignores it and answers lifetime: ask the run-day dimension first
    if (runStartUntil) await read("outcomeKey,sourceRunStartDay", runStartUntil);
    const [produced, consumed, scope] = await Promise.all([
      read("outcomeKey,campaignId,workflowSlug,audienceId", runStartUntil),
      read("outcomeKey,campaignId,workflowSlug,audienceId,sourceCampaignId,sourceWorkflowSlug,sourceAudienceId", runStartUntil),
      read("campaignId,workflowSlug,audienceId", runStartUntil),
    ]);
    const value = parseLedgerBook(produced, consumed, scope, basis);
    held.set(key, { at: Date.now(), value });
    return value;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/**
 * The DAILY book (ENGINE-PER-OUTCOME-SHADOW): the same three reads grouped also by the day each run STARTED (and, on the
 * consumed section, the day the producing run started: the send a reply answers), without the audience. One read gives
 * every decision day: the Engine's faded, censored beliefs and its replay read it, never one cut per checkpoint (five
 * cuts made runs-service 500 under load, 2026-10-31). From `sinceDay` only (older evidence has faded), held 2.5 h (one
 * read per 3-hourly pass: a month of it took ~70 s under load). Days runs-service has not stored with their run-start day
 * yet are absent and listed in `missingDays`.
 */
export async function loadDailyLedgerBook(basis: BookBasis, sinceDay: string): Promise<LedgerBookRead> {
  const key = `${basis}|daily|${sinceDay}`;
  const h = held.get(key);
  if (h && Date.now() - h.at < DAILY_HELD_MS) return h.value;
  const running = inFlight.get(key);
  if (running) return running;
  try {
    return await readDailyBook(basis, sinceDay, key);
  } catch (error) {
    // The last good daily book (any since-day) for up to a day: one failed read never blanks every Engine pick.
    const last = lastGoodDaily.get(basis);
    if (last && Date.now() - last.at < DAILY_LAST_GOOD_MS) {
      console.error(`[features-service] daily ledger book unreadable, serving the copy of ${new Date(last.at).toISOString()}:`, error);
      return last.value;
    }
    throw error;
  }
}

/** How far back the shared daily book is read: a decision this old weighs (1/2)^(150/45) ≈ 10% (Engine `HALF_LIFE_DAYS`). */
export const DAILY_BOOK_DAYS = 150;

/** PURE. The since-day of THE shared daily book (every reader asks the same key, so one read serves them all). */
export function dailyBookSinceDay(now: number = Date.now()): string {
  return new Date(now - DAILY_BOOK_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/** The first UTC day a campaign ran an Engine script (MIGRATE-1105 S0, runs-service `script:%` tasks, prod 2026-10-29). */
export const SCRIPTS_FIRST_DAY = "2026-10-29";

const lastGoodDaily = new Map<BookBasis, { at: number; value: LedgerBookRead }>();
const DAILY_LAST_GOOD_MS = 24 * 3_600_000;

async function readDailyBook(basis: BookBasis, sinceDay: string, key: string): Promise<LedgerBookRead> {
  const p = (async () => {
    // + the script each run works for (MON-SCRIPT-PRICES-2-1111, runs-service 0111): a pipe's scripts are measured apart.
    const produced = await read("outcomeKey,campaignId,workflowSlug,scriptSlug,runStartDay", undefined, sinceDay);
    const consumed = await read("outcomeKey,campaignId,workflowSlug,scriptSlug,sourceCampaignId,sourceWorkflowSlug,sourceScriptSlug,runStartDay,sourceRunStartDay", undefined, sinceDay);
    const scope = await read("campaignId,workflowSlug,scriptSlug,runStartDay", undefined, sinceDay);
    const value = parseLedgerBook(produced, consumed, scope, basis);
    held.set(key, { at: Date.now(), value });
    lastGoodDaily.set(basis, { at: Date.now(), value });
    return value;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/** The book basis of a reader's pricing. */
export function bookBasisOf(pricing: string): BookBasis {
  if (pricing === "gross" || pricing === "net" || pricing === "vendor") return pricing;
  if (pricing === "vendorUnpriced") return "unpricedGross";
  throw new Error(`[features-service] ledger book: no book basis for pricing ${pricing}`);
}

const lastGood = new Map<string, LedgerBookRead>();

/**
 * THE REGIME GATE every reader asks (one answer for the whole fleet): runs-service's own reconciliation
 * (`/internal/outcome-costs/reconciliation`, since its first spend day): every day, spend = declared production + loss
 * + support to the cent, nothing undeclared, every consumption placed (`reconciled`, strict, no tolerance). Reconciled =
 * the book, else null (every pipe stays on the previous regime). A read that fails serves the last good answer of the
 * same key, whatever its age (logged): a hiccup never flips some pipes back while others stay. `cutoffIso` = a mature
 * cohort's cutoff; a cut runs-service has not computed yet (or computed before a later fact) = null for that half only
 * (the maturity rule: no mature figure, never one on another basis).
 */
export async function ledgerRegime(pricing: string, cutoffIso?: string | null): Promise<LedgerBookRead | null> {
  const basis = bookBasisOf(pricing);
  if (!(await reconciledOrLastGood())) return null;
  const read = await readOrLastGood(basis, cutoffIso ? runStartUntilOf(cutoffIso) : undefined);
  if (!read || read.daysMissing > 0) return null;
  return read;
}

let reconciliationHeld: { at: number; reconciled: boolean } | null = null;
let lastReconciled: boolean | null = null;

/** PURE. runs-service's verdict, read strictly: a body without it is not reconciled. */
export function reconciledOf(body: unknown): boolean {
  return (body as { reconciled?: unknown } | null)?.reconciled === true;
}

async function reconciledOrLastGood(): Promise<boolean> {
  if (reconciliationHeld && Date.now() - reconciliationHeld.at < HELD_MS) return reconciliationHeld.reconciled;
  try {
    const r = await fetchWithRetry(`${process.env.RUNS_SERVICE_URL}/internal/outcome-costs/reconciliation`, {
      headers: { "x-api-key": process.env.RUNS_SERVICE_API_KEY ?? "" },
    });
    if (!r.ok) throw new Error(`[features-service] runs-service reconciliation ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const reconciled = reconciledOf(await r.json());
    reconciliationHeld = { at: Date.now(), reconciled };
    lastReconciled = reconciled;
    return reconciled;
  } catch (error) {
    console.error(`[features-service] ledger reconciliation unreadable; ${lastReconciled === null ? "previous regime kept" : "serving the last verdict"}:`, error);
    return lastReconciled ?? false;
  }
}

async function readOrLastGood(basis: BookBasis, cut?: string): Promise<LedgerBookRead | null> {
  const key = `${basis}|${cut ?? ""}`;
  try {
    const r = await loadLedgerBook(basis, cut);
    lastGood.set(key, r);
    return r;
  } catch (error) {
    const prior = lastGood.get(key) ?? null;
    console.error(`[features-service] ledger book ${key} unreadable; ${prior ? "serving the last good book" : "no book yet, previous regime kept"}:`, error);
    return prior;
  }
}

/** The inclusive last run-start UTC day of a mature cohort: runs started before the cutoff (UTC midnight). */
export function runStartUntilOf(cutoffIso: string): string {
  return new Date(Date.parse(cutoffIso) - 86_400_000).toISOString().slice(0, 10);
}

/** Test seam. */
export function __resetLedgerBook(): void {
  held.clear();
  lastGood.clear();
  reconciliationHeld = null;
  lastReconciled = null;
  inFlight.clear();
}

/** The outcome a pipe produces: its leg's `to` step in the channel catalogue (every pipe, coded or declared). */
export async function pipeOutcomeKey(featureSlug: string, legKey: string): Promise<string> {
  const catalogue = await loadChannelCatalogue({ publishedOnly: false });
  const pipeLeg = pipeLegKeyOf(featureSlug, legKey);
  const to = catalogue.channels.find((c) => c.slug === featureSlug)?.stepTransitions.find((t) => pipeLegKeyOf(featureSlug, t.legKey) === pipeLeg)?.to.key;
  if (!to) throw new Error(`[features-service] no catalogue pipe ${featureSlug}|${legKey}`);
  return to;
}

/** The step a pipe starts from, as the catalogue serves it (a pipe respelled from Lead found starts there, `buildPipes`):
 *  null for a pipe from Start (it consumes no step of the funnel). */
export async function pipeFromKey(featureSlug: string, legKey: string): Promise<string | null> {
  const catalogue = await loadChannelCatalogue({ publishedOnly: false });
  const pipeLeg = pipeLegKeyOf(featureSlug, legKey);
  const t = catalogue.channels.find((c) => c.slug === featureSlug)?.stepTransitions.find((x) => pipeLegKeyOf(featureSlug, x.legKey) === pipeLeg);
  if (!t) throw new Error(`[features-service] no catalogue pipe ${featureSlug}|${legKey}`);
  return servedLegKeyOf(featureSlug, t.legKey) !== t.legKey ? "lead_found" : (t.from?.key ?? null);
}

/** The per-slug stat a leg's outcome is read from (the click on a visit leg, else the outcome slot every other leg reads). */
export function outcomeStatKeyOf(legKey: string): "recipientsRepliesPositive" | "recipientsClicked" {
  return legMaturity(legKey).outcomeSignal === "clicked" ? "recipientsClicked" : "recipientsRepliesPositive";
}
