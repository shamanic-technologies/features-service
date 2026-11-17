/**
 * THE COLD EMAIL INDEXES READ ON THE ENGINE'S SCRIPTS (owner 2026-11-17, PUBLIC-INDEXES-NULL-1117). Pure.
 *
 * Since MIGRATE-1105 every campaign runs Engine SCRIPTS and every workflow is retired: the cold email indexes read the old
 * per-pipe leg workflow ranking, whose money workflow (Ballad) stopped running on 2026-11-09, so six of seven public
 * indexes read null from that day. The indexes now read the Engine that sends the cold email (`email_sent`), each of its
 * scripts measured on the general ledger's daily book with THE rule the Research page's Engine measures use
 * (`measureScriptFigures`, RESEARCH-PERF-SCRIPTS-1116): over EVERY campaign of the book (the email scripts run on
 * campaigns stating no leg, so a pipe's campaign set holds none of them), spend = the script's own production + its runs
 * that produced nothing + the counted outcome its sends led to x that stage's own cost; outcomes = the positive replies
 * (or website visits: a real click on a link of our email, instantly-service) made on its sends; contacted = the emails it
 * sent. No pipe, no leg assignment, no workflow decides anything here.
 *
 * Each script is then one row of the ONE leg order (`rankLegWorkflows`, the leg's own maturity rule: 21 days on both cold
 * email legs, mature cohort = runs started before the cut): a runnable script is ACTIVE and runnable, a retired one keeps
 * its figures and is never picked. The index picks with `indexPipePick` (`lib/fleet-indexes.ts`): the best mature runnable
 * script, else the best available one. Public money is VENDOR cost: the same rows read on the vendor book and its unpriced
 * twin (`vendorRankingRows`, the 1% tolerance), so WHO is picked never moves between the two bases.
 *
 * A past day D is read on the book AS OF the end of D (`bookAsOf`: only runs started on or before D; an undated row in no
 * past day), so a recomputed day never sees a later fact.
 */
import type { LedgerPipeBook } from "./ledger-pipe-costs.js";
import { legCutoffIso, legMaturityFigures, outcomeFigures, type LegMaturityFigures } from "./maturity.js";
import { runStartUntilOf } from "./ledger-book.js";
import { computeFleetIndexPoints, isProvenIndexRow, type FleetIndexPoint, type MeetingPipeEvidence } from "./fleet-indexes.js";
import type { DatedIndexPoint } from "./fleet-index-history.js";
import { measureScriptFigures, type LedgerScriptFigures } from "./research/engine-script-performance.js";
import { rankLegWorkflows, type LegWorkflowRankingRow } from "./leg-workflow-ranking.js";
import { vendorRankingRows, type IndexRow } from "./fleet-index-vendor.js";

/** The Engine that sends a cold email: its scripts are what a client buys today on the cold email indexes. */
export const COLD_EMAIL_ENGINE = "email_sent";

/** The three books one index point reads: billed (gross), vendor cost, and the billed spend no vendor cost prices. */
export interface ScriptIndexBooks {
  gross: LedgerPipeBook;
  vendor: LedgerPipeBook;
  unpriced: LedgerPipeBook;
}

/**
 * PURE. The book as it stood at the end of `day`: every row of a run started on or before it. A row naming no run day is
 * in no past day (the history's rule for undated evidence, `asOfPerson`); today's live read keeps it.
 */
export function bookAsOf(book: LedgerPipeBook, day: string): LedgerPipeBook {
  const by = (d: string | null | undefined): boolean => d != null && d <= day;
  return {
    produced: book.produced.filter((r) => by(r.runStartDay)),
    noOutput: book.noOutput.filter((r) => by(r.runStartDay)),
    consumed: book.consumed.filter((r) => by(r.runStartDay)),
  };
}

const figuresOf = (f: LedgerScriptFigures | undefined) => (f ? outcomeFigures(f.spentUsd, f.contacted, f.outcomes) : outcomeFigures(0, 0, 0));

/**
 * PURE. Each script of the cold email Engine on one counted outcome, both halves: flash = every run of the book, mature =
 * runs started on or before `matureCutDay` (null = a leg that matures the day it is bought).
 */
export function scriptLegFigures(
  counts: string,
  legKey: string,
  book: LedgerPipeBook,
  keyOf: (slug: string | null | undefined) => string,
  matureCutDay: string | null,
): Map<string, LegMaturityFigures> {
  const m = { engine: COLD_EMAIL_ENGINE, startsFrom: null, counts };
  const flash = measureScriptFigures(m, book, keyOf);
  const mature = matureCutDay === null ? flash : measureScriptFigures(m, book, keyOf, undefined, matureCutDay);
  const out = new Map<string, LegMaturityFigures>();
  for (const k of [...new Set([...flash.keys(), ...mature.keys()])].sort()) {
    out.set(k, legMaturityFigures(legKey, figuresOf(flash.get(k)), figuresOf(mature.get(k))));
  }
  return out;
}

/**
 * PURE. The rows one cold email index reads: the Engine's scripts in the ONE leg order on the billed book (`billed`), and
 * the same rows with their money on the vendor book (`vendor`, the public series).
 */
export function scriptIndexRows(
  counts: string,
  legKey: string,
  books: ScriptIndexBooks,
  keyOf: (slug: string | null | undefined) => string,
  runnable: ReadonlySet<string>,
  matureCutDay: string | null,
): { billed: LegWorkflowRankingRow[]; vendor: IndexRow[] } {
  const byDynasty = scriptLegFigures(counts, legKey, books.gross, keyOf, matureCutDay);
  const assignments = new Map<string, "active">();
  for (const k of byDynasty.keys()) if (runnable.has(k)) assignments.set(k, "active");
  const billed = rankLegWorkflows({ byDynasty, names: new Map(), assignments, executable: runnable });
  const vendor = vendorRankingRows(billed, {
    vendor: scriptLegFigures(counts, legKey, books.vendor, keyOf, matureCutDay),
    unpriced: scriptLegFigures(counts, legKey, books.unpriced, keyOf, matureCutDay),
  });
  return { billed, vendor };
}

/** One index's rows on both bases (billed = the order, vendor = the public money of the same rows). */
export interface IndexRowsBoth {
  billed: IndexRow[];
  vendor: IndexRow[];
}

/**
 * PURE. A cold email index's candidates, EVERY era (owner 2026-11-17, INDEX-HISTORY-1117: « Mais c'est pas vrai qu'on a pas
 * assez de data !!! »): the `email_sent` Engine's scripts AND the workflow dynasties of the pipe's own leg ranking, each on
 * its own whole history (a workflow that stopped with MIGRATE-1105 keeps its results: prod 2026-11-17 Ballad, 47 positive
 * replies on 20,811 people, mature, read by no index since 2026-11-09). Never pooled: each row stays one script / workflow.
 *
 * Order (billed, so both bases pick the same row): the PROVEN rows (`isProvenIndexRow`: mature, >= the noise bar) by billed
 * cost per outcome, cheapest first, the first one `moneyGoesHere` (the index's pick, `indexPipePick`); then every other
 * row, scripts first in their own leg order, then the workflows in theirs (the best available runnable script below the
 * bar is read from them). The ranking's script rows (`<outcome>/<dynasty>`) are dropped from the history: the scripts are
 * read on the Engine's measure, over every campaign.
 */
export function indexRowsWithHistory(scripts: IndexRowsBoth, history: IndexRowsBoth): IndexRowsBoth {
  const isWorkflow = (r: IndexRow) => !r.workflowDynastySlug.includes("/");
  const billedAll = [...scripts.billed, ...history.billed.filter(isWorkflow)];
  const priced = (r: IndexRow) => isProvenIndexRow(r) && r.costPerOutcomeUsd !== null;
  const head = billedAll.filter(priced).sort((a, b) => a.costPerOutcomeUsd! - b.costPerOutcomeUsd! || (a.workflowDynastySlug < b.workflowDynastySlug ? -1 : 1));
  const ordered = [...head, ...billedAll.filter((r) => !priced(r))];
  const place = new Map(ordered.map((r, i) => [r.workflowDynastySlug, { rank: i + 1, moneyGoesHere: i === 0 && priced(r) }]));
  const placed = (r: IndexRow): IndexRow => ({ ...r, ...place.get(r.workflowDynastySlug)! });
  const vendor = [...scripts.vendor, ...history.vendor.filter(isWorkflow)].filter((r) => place.has(r.workflowDynastySlug)).map(placed);
  return { billed: ordered.map(placed), vendor: vendor.sort((a, b) => a.rank - b.rank) };
}

/** What the scripts-era history reads (`recomputeScriptsEraIndexPoints`). */
export interface ScriptsEraHistoryInputs {
  /** Days to rebuild, oldest first. */
  days: readonly string[];
  books: ScriptIndexBooks;
  keyOf: (slug: string | null | undefined) => string;
  /** Script dynasties runnable today (a script retired since keeps its figures). */
  runnable: ReadonlySet<string>;
  /**
   * The pipe's workflow-era rows AS OF the end of `day` on `legKey`, both bases (the workflow history's `rankingOn` and its
   * vendor twin): merged with the scripts (`indexRowsWithHistory`), so a past day reads every era like the live recorder.
   */
  historyRows: (legKey: string, day: string) => IndexRowsBoth;
  websiteVisitLeg: string;
  positiveReplyLeg: string;
  /**
   * The AI Meeting Booking pipe on both bases, the same on every rebuilt day (the caller proves it did not move over the
   * days: its counts and spend equal to the last day recorded before them); null = the meeting indexes are not rebuilt.
   */
  meeting: { billed: MeetingPipeEvidence; vendor: MeetingPipeEvidence } | null;
}

/** PURE. The run-start day a leg's mature cohort ends on, the index read on `day` (UTC midnight of the day − the duration). */
export function matureCutDayOn(legKey: string, day: string): string | null {
  const cutoffIso = legCutoffIso(legKey, new Date(`${day}T12:00:00.000Z`));
  return cutoffIso ? runStartUntilOf(cutoffIso) : null;
}

/**
 * PURE. Every cold email index (the client-median one aside: it reads no script) of every day of `days`, AS OF the end of
 * that day, billed and vendor: the scripts measured on the book as of the day, the same pick rule as the live recorder.
 */
export function recomputeScriptsEraIndexPoints(i: ScriptsEraHistoryInputs): { billed: DatedIndexPoint[]; vendor: DatedIndexPoint[] } {
  const billed: DatedIndexPoint[] = [];
  const vendor: DatedIndexPoint[] = [];
  for (const day of i.days) {
    const books = { gross: bookAsOf(i.books.gross, day), vendor: bookAsOf(i.books.vendor, day), unpriced: bookAsOf(i.books.unpriced, day) };
    const visit = indexRowsWithHistory(scriptIndexRows("website_visit", i.websiteVisitLeg, books, i.keyOf, i.runnable, matureCutDayOn(i.websiteVisitLeg, day)), i.historyRows(i.websiteVisitLeg, day));
    const reply = indexRowsWithHistory(scriptIndexRows("conversation", i.positiveReplyLeg, books, i.keyOf, i.runnable, matureCutDayOn(i.positiveReplyLeg, day)), i.historyRows(i.positiveReplyLeg, day));
    const stamp = (p: FleetIndexPoint, costBasis: "billed" | "vendor"): DatedIndexPoint => ({ day, point: { ...p, inputs: { ...p.inputs, asOfDay: day, costBasis, source: "email_sent_engine_scripts_and_workflow_history" } } });
    for (const p of computeFleetIndexPoints({ websiteVisitRows: visit.billed, positiveReplyRows: reply.billed, meetingPipe: i.meeting?.billed ?? null, bestAvailableStandsIn: true })) billed.push(stamp(p, "billed"));
    for (const p of computeFleetIndexPoints({ websiteVisitRows: visit.vendor, positiveReplyRows: reply.vendor, meetingPipe: i.meeting?.vendor ?? null, bestAvailableStandsIn: true })) vendor.push(stamp(p, "vendor"));
  }
  return { billed, vendor };
}
