/**
 * runs-service's general ledger as ONE book every pipe is priced on (LEDGER-HISTORY-1024; pure rules in
 * `lib/ledger-pipe-costs.ts`). Three fleet reads since inception, optionally cut at a run-start day (the mature cohort:
 * runs started on or before it, and the occurrences whose consumed input such a run produced), held 15 min per (basis,
 * cut), one read at a time. FAIL-LOUD: a refused read throws; the readers then keep the previous regime for the whole
 * fleet (never half the pipes on each).
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { matureCutParams, type LedgerBasis } from "./outcome-cost-totals-client.js";
import { ledgerReconciliation, type LedgerPipeBook, type LedgerReconciliation } from "./ledger-pipe-costs.js";
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
  reconciliation: LedgerReconciliation;
}

/** PURE. The three wire bodies as one book + the fleet reconciliation. */
export function parseLedgerBook(producedBody: Wire, consumedBody: Wire, scopeBody: Wire, basis: BookBasis): LedgerBookRead {
  const produced = (producedBody.produced ?? []).map((g) => {
    const key = g.dimensions?.outcomeKey;
    if (!key) throw new Error("[features-service] ledger book: a produced group names no outcomeKey");
    return { outcomeKey: key, campaignId: g.dimensions?.campaignId ?? null, workflowSlug: g.dimensions?.workflowSlug ?? null, occurrences: g.occurrences ?? 0, costUsd: usd(g.cost, basis) };
  });
  let consumptions = 0;
  let unknownProvenance = 0;
  const consumed = [];
  for (const g of consumedBody.consumed ?? []) {
    const consumer = g.dimensions?.consumingOutcomeKey;
    const key = g.dimensions?.consumedOutcomeKey;
    if (!key) throw new Error("[features-service] ledger book: a consumed group names no consumedOutcomeKey");
    const count = Number(g.consumptions ?? 0);
    consumptions += count;
    unknownProvenance += Number(g.unknownProvenance ?? 0);
    if (!consumer) continue;
    consumed.push({
      consumerKey: consumer,
      consumedKey: key,
      campaignId: g.dimensions?.campaignId ?? null,
      workflowSlug: g.dimensions?.workflowSlug ?? null,
      sourceCampaignId: g.dimensions?.sourceCampaignId ?? null,
      sourceWorkflowSlug: g.dimensions?.sourceWorkflowSlug ?? null,
      count,
    });
  }
  const scope = (scopeBody.scope ?? []).map((s) => ({
    campaignId: s.dimensions?.campaignId ?? null,
    workflowSlug: s.dimensions?.workflowSlug ?? null,
    spendUsd: usd(s.spend, basis),
    supportUsd: usd(s.support, basis),
    producedUsd: usd(s.producedCost, basis),
    noOutputUsd: usd(s.producedNone, basis),
  }));
  const noOutput = scope.map((s) => ({ campaignId: s.campaignId, workflowSlug: s.workflowSlug, costUsd: Math.max(s.noOutputUsd - s.supportUsd, 0) }));
  const daysMissing = Math.max(...[producedBody, consumedBody, scopeBody].map((b) => (b.daysMissing ?? []).length));
  return { book: { produced, noOutput, consumed }, reconciliation: ledgerReconciliation({ scope, consumptions, unknownProvenance, daysMissing }) };
}

async function read(groupBy: string, runStartUntil?: string): Promise<Wire> {
  const r = await fetchWithRetry(`${process.env.RUNS_SERVICE_URL}/internal/stats/outcome-costs?groupBy=${groupBy}${matureCutParams(runStartUntil)}`, {
    headers: { "x-api-key": process.env.RUNS_SERVICE_API_KEY ?? "" },
  });
  if (!r.ok) throw new Error(`[features-service] runs-service outcome-costs (${groupBy}) ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as Wire;
}

const HELD_MS = 15 * 60_000;
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
      read("outcomeKey,campaignId,workflowSlug", runStartUntil),
      read("outcomeKey,campaignId,workflowSlug,sourceCampaignId,sourceWorkflowSlug", runStartUntil),
      read("campaignId,workflowSlug", runStartUntil),
    ]);
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
 * THE REGIME GATE every reader asks (one answer for the whole fleet): the book when the ledger reconciles, else null (every
 * pipe stays on the previous regime). A read that fails serves the last good book of the same key, whatever its age
 * (logged): a hiccup never flips some pipes back while others stay. `cutoffIso` = a mature cohort's cutoff; a cut the
 * ledger cannot make yet (days not grouped by run day) = null for that half only (the maturity rule: no mature figure,
 * never one on another basis).
 */
export async function ledgerRegime(pricing: string, cutoffIso?: string | null): Promise<LedgerBookRead | null> {
  const basis = bookBasisOf(pricing);
  const gate = await readOrLastGood("gross");
  if (!gate || !gate.reconciliation.reconciled) return null;
  const cut = cutoffIso ? runStartUntilOf(cutoffIso) : undefined;
  const read = basis === "gross" && !cut ? gate : await readOrLastGood(basis, cut);
  if (!read || read.reconciliation.daysMissing > 0) return null;
  return read;
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
