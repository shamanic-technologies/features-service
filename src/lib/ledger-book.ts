/**
 * runs-service's general ledger as ONE book every pipe is priced on (LEDGER-HISTORY-1024; pure rules in
 * `lib/ledger-pipe-costs.ts`). Three fleet reads since inception, optionally cut at a run-start day (the mature cohort:
 * runs started on or before it, and the occurrences whose consumed input such a run produced), held 15 min per (basis,
 * cut), one read at a time. FAIL-LOUD: a refused read throws; the readers then keep the previous regime for the whole
 * fleet (never half the pipes on each).
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { matureCutParams, type LedgerBasis } from "./outcome-cost-totals-client.js";
import type { LedgerPipeBook } from "./ledger-pipe-costs.js";
import { loadChannelCatalogue } from "./channel-declarations-store.js";
import { legMaturity } from "./maturity.js";
import { pipeLegKeyOf } from "./funnel-legs.js";

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
}

/** The run-start day of a group, only when the read grouped by it (the daily book): absent otherwise, rows unchanged. */
const dayDims = (d: Record<string, string | null> | undefined): { runStartDay?: string | null } =>
  d && "runStartDay" in d ? { runStartDay: d.runStartDay ?? null } : {};

/** PURE. The three wire bodies as one book + the fleet reconciliation. */
export function parseLedgerBook(producedBody: Wire, consumedBody: Wire, scopeBody: Wire, basis: BookBasis): LedgerBookRead {
  const produced = (producedBody.produced ?? []).map((g) => {
    const key = g.dimensions?.outcomeKey;
    if (!key) throw new Error("[features-service] ledger book: a produced group names no outcomeKey");
    return { outcomeKey: key, campaignId: g.dimensions?.campaignId ?? null, workflowSlug: g.dimensions?.workflowSlug ?? null, audienceId: g.dimensions?.audienceId ?? null, occurrences: g.occurrences ?? 0, costUsd: usd(g.cost, basis), ...dayDims(g.dimensions) };
  });
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
    });
  }
  // runs-service's "produced none" holds the support marks too: only the rest is a pipe's loss
  const noOutput = (scopeBody.scope ?? []).map((s) => ({
    campaignId: s.dimensions?.campaignId ?? null,
    workflowSlug: s.dimensions?.workflowSlug ?? null,
    audienceId: s.dimensions?.audienceId ?? null,
    costUsd: Math.max(usd(s.producedNone, basis) - usd(s.support, basis), 0),
    ...dayDims(s.dimensions),
  }));
  const daysMissing = Math.max(...[producedBody, consumedBody, scopeBody].map((b) => (b.daysMissing ?? []).length));
  const missingDays = [...new Set([producedBody, consumedBody, scopeBody].flatMap((b) => b.daysMissing ?? []))].sort();
  return { book: { produced, noOutput, consumed }, daysMissing, missingDays };
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

async function readRange(groupBy: string, since: string, until: string, runStartUntil?: string): Promise<Wire> {
  const r = await fetchWithRetry(`${process.env.RUNS_SERVICE_URL}/internal/stats/outcome-costs?groupBy=${groupBy}&since=${since}&until=${until}${matureCutParams(runStartUntil)}`, {
    headers: { "x-api-key": process.env.RUNS_SERVICE_API_KEY ?? "" },
  });
  // over runs-service's group cap: the range splits in halves (every section is additive over disjoint days)
  if (r.status === 422 && since < until) {
    const mid = new Date((Date.parse(`${since}T00:00:00Z`) + Date.parse(`${until}T00:00:00Z`)) / 2).toISOString().slice(0, 10);
    const after = new Date(Date.parse(`${mid}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    return concatWire([await readRange(groupBy, since, mid, runStartUntil), await readRange(groupBy, after, until, runStartUntil)]);
  }
  if (!r.ok) throw new Error(`[features-service] runs-service outcome-costs (${groupBy} ${since}..${until}) ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as Wire;
}

/** PURE. Disjoint day ranges of one read as one body: rows concatenated (every reader sums them), missing days unioned. */
export function concatWire(parts: readonly Wire[]): Wire {
  return {
    daysMissing: [...new Set(parts.flatMap((p) => p.daysMissing ?? []))],
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
  const p = (async () => {
    const produced = await read("outcomeKey,campaignId,workflowSlug,runStartDay", undefined, sinceDay);
    const consumed = await read("outcomeKey,campaignId,workflowSlug,sourceCampaignId,sourceWorkflowSlug,runStartDay,sourceRunStartDay", undefined, sinceDay);
    const scope = await read("campaignId,workflowSlug,runStartDay", undefined, sinceDay);
    const value = parseLedgerBook(produced, consumed, scope, basis);
    held.set(key, { at: Date.now(), value });
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

/** The per-slug stat a leg's outcome is read from (the click on a visit leg, else the outcome slot every other leg reads). */
export function outcomeStatKeyOf(legKey: string): "recipientsRepliesPositive" | "recipientsClicked" {
  return legMaturity(legKey).outcomeSignal === "clicked" ? "recipientsClicked" : "recipientsRepliesPositive";
}
