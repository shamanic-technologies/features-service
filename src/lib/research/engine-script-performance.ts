/**
 * THE SCRIPTS OF ONE RESEARCH MEASURE, MEASURED ON THE LEDGER (owner 2026-11-16, RESEARCH-PERF-SCRIPTS-1116). Pure.
 *
 * Since MIGRATE-1105 a campaign runs its Engine's SCRIPTS (no workflow slug on any run), so the Performance tab built on the
 * workflow-era evidence (`lib/research/performance.ts`) saw none of today's production: every listed « active » row was a
 * combination nothing runs any more (« untested »), every dollar sat on the history rows (prod 2026-11-16, measure
 * `email_sent/start/conversation`: 1,250 active rows at $0 beside $10,057 on 135 history rows). A pick is always a script,
 * its LLM and template are TACTICS of it (SCRIPT-VALUE-RATING-1113), so a measure's rows of today are its Engine's scripts.
 *
 * A script's figures on a measure (Engine E, counting step C, from step F or nothing), read on runs-service's general ledger
 * daily book with the ONE per-script rule the Engine prices already use (`pipeScriptCosts`, MON-SCRIPT-PRICES-2-1111),
 * over EVERY campaign of the book (a script belongs to its Engine, never to a pipe's campaign set: the email scripts ran on
 * campaigns stating no leg, so the pipe's set held none of them):
 *   spend    = the script's own production + its runs that produced nothing + the C its inputs led to × C's own stage cost
 *   outcomes = the C it made, + the C made elsewhere whose consumed input it made (a reply judged on its send)
 *   contacted (the conversion's base) = from F: the F its runs worked on; from nothing, C after E (an email sent, then a
 *            reply): the Units it made of the kinds C consumes (one per email); C = E: none (no conversion from nothing)
 * Only keys of the Engine (`<E>/<dynasty>`) are rows; a script re-homed under another Engine keeps its runs (`rehome`, the
 * Rating's rule). Runs naming no script (before runs-service named them) cannot be placed on an Engine: never a row.
 *
 * Views: flash = every run; mature = the measure's cohort (runs started on or before the maturity cut of `F_to_C`). A
 * script with NO run in the mature cohort (younger than the window: every script of the 21-day reply measure in Nov 2026)
 * is served on its FLASH figures, `basis: "flash"` (the workflow-projection rule: a grain with no mature evidence is served
 * on its flash block, never dropped, never $0). `untested` = it spent nothing AND ran nothing (flash, board runs).
 * No return on any row (ROI-CONSISTENCY-1103); every figure measured (PERF-COST-ORDER-1024).
 */
import { SCRIPT_POOL, pipeScriptCosts, scriptDynastyOfSlug, type LedgerPipeBook } from "../ledger-pipe-costs.js";
import { isMatureCount, legMaturity } from "../maturity.js";
import { MONTHS, n, pctText, usd } from "./format.js";
import type { PerformanceCount, PerformanceFigure } from "./performance.js";

/** What one Research measure counts (`lib/research/by-engine.ts` `ResearchMeasure`). */
export interface MeasureTerms {
  engine: string;
  startsFrom: string | null;
  counts: string;
}

export interface LedgerScriptFigures {
  spentUsd: number;
  outcomes: number;
  contacted: number;
}

/** PURE. The key a script's runs are filed under: its dynasty, re-homed when its name is runnable under one Engine only. */
export function scriptKeyOf(runnableDynasties: readonly string[]): (slug: string | null | undefined) => string {
  const nameOf = (key: string): string => key.slice(key.indexOf("/") + 1);
  const homes = new Map<string, Set<string>>();
  for (const key of runnableDynasties) homes.set(nameOf(key), (homes.get(nameOf(key)) ?? new Set()).add(key));
  return (slug) => {
    const key = scriptDynastyOfSlug(slug);
    if (!key.includes("/")) return key;
    const home = homes.get(nameOf(key));
    return home && home.size === 1 ? [...home][0]! : key;
  };
}

/** PURE. Every campaign the book names: a script is measured on its Engine's whole production. */
export function bookCampaigns(book: LedgerPipeBook): Set<string> {
  const ids = new Set<string>();
  for (const r of book.produced) if (r.campaignId) ids.add(r.campaignId);
  for (const r of book.noOutput) if (r.campaignId) ids.add(r.campaignId);
  for (const c of book.consumed) {
    if (c.campaignId) ids.add(c.campaignId);
    if (c.sourceCampaignId) ids.add(c.sourceCampaignId);
  }
  return ids;
}

/** PURE. Per script of the measure's Engine, its spend, outcomes and conversion base on the cohort (`cutDay`; none = flash). */
export function measureScriptFigures(
  m: MeasureTerms,
  book: LedgerPipeBook,
  keyOf: (slug: string | null | undefined) => string,
  campaigns: ReadonlySet<string> = bookCampaigns(book),
  cutDay?: string,
): Map<string, LedgerScriptFigures> {
  const mine = (k: string) => k.startsWith(`${m.engine}/`);
  const ran = (day: string | null | undefined) => cutDay === undefined || (day != null && day <= cutDay);
  const costs = pipeScriptCosts(m.counts, campaigns, book, cutDay, keyOf);
  // the conversion's base
  const base = new Map<string, Map<string, number>>();
  const add = (k: string, kind: string, v: number) => {
    const e = base.get(k) ?? new Map<string, number>();
    e.set(kind, (e.get(kind) ?? 0) + v);
    base.set(k, e);
  };
  if (m.startsFrom !== null) {
    for (const c of book.consumed) {
      if (c.workflowSlug !== null || !c.campaignId || c.consumedKey !== m.startsFrom || !ran(c.runStartDay)) continue;
      const k = keyOf(c.scriptSlug);
      if (mine(k)) add(k, c.consumedKey, c.count);
    }
  } else if (m.counts !== m.engine) {
    const answers = new Set(book.consumed.filter((c) => c.consumerKey === m.counts).map((c) => c.consumedKey));
    for (const r of book.produced) {
      if (r.workflowSlug !== null || !r.campaignId || !answers.has(r.outcomeKey) || !ran(r.runStartDay)) continue;
      const k = keyOf(r.scriptSlug);
      if (mine(k)) add(k, r.outcomeKey, r.occurrences);
    }
  }
  const out = new Map<string, LedgerScriptFigures>();
  for (const [k, v] of costs) {
    if (!mine(k)) continue;
    const b = base.get(k);
    out.set(k, { spentUsd: v.costUsd, outcomes: v.outcomes, contacted: b ? Math.max(...b.values()) : 0 });
  }
  for (const [k, b] of base) if (!out.has(k)) out.set(k, { spentUsd: 0, outcomes: 0, contacted: Math.max(...b.values()) });
  return out;
}

/** What Monitoring's script board (and workflow-service's catalogue) say of one script of the Engine. */
export interface ScriptFacts {
  key: string;
  /** workflow-service's short name; null = not named, or no longer runnable. */
  name: string | null;
  runnable: boolean;
  /** Runs of the last 30 days (the board's ledger groups). */
  recentRuns: number;
  llm: { key: string; label: string; provider: string | null } | null;
  template: { key: string; label: string } | null;
}

export interface ScriptRowFigures {
  costPerOutcomeUsd: PerformanceFigure;
  conversionRatePct: PerformanceFigure;
  outcomes: PerformanceCount;
  spentUsd: PerformanceCount;
  contacted: PerformanceCount;
}

/** One script of the measure: the Performance row's shape, in the framework's words. */
export interface ScriptPerformanceRow extends ScriptRowFigures {
  key: string;
  rank: number;
  /** `scripts` = what produces the Engine's outcome today (and the retired scripts that did); `history` = the workflow era. */
  era: "scripts";
  script: { key: string; label: string; name: string | null };
  template: { key: string; label: string; dynasty: null; standaloneReason: null } | null;
  llm: { key: string; label: string; provider: string | null } | null;
  written: true;
  /** The LLM and template are what the script STATES (its tactics), never inferred from what it sent. */
  writerSource: "script_tactics";
  writerUnavailableReason: null;
  /** The half these figures are read on: `flash` on the mature view = the script has no run in the mature cohort yet. */
  basis: "mature" | "flash";
  maturity: { isMature: boolean; matureOutcomes: number | null; outcomesRequired: number };
  learning: boolean;
  /** Runs of the last 30 days (Monitoring's board). */
  recentRuns: number;
  /** `ran_with_no_cost_on_ledger`: it ran (the board counts its runs) and no ledger row holds a cent of it. */
  spendUnavailableReason: "ran_with_no_cost_on_ledger" | null;
  sortCostUsd: number;
  untested: boolean;
  status: "active" | "deprecated";
  deprecatedParts: Array<"script">;
}

export interface ScriptPoint {
  /** `YYYY-MM`, everything to the END of the month (cumulative). */
  month: string;
  spentUsd: number;
  outcomes: number;
  contacted: number;
}

export interface MeasureScripts {
  rows: ScriptPerformanceRow[];
  points: ScriptPoint[];
  /** The counted step made by no-workflow runs that name no script (before runs-service named them): on no Engine, no row. */
  unplacedOutcomes: number;
}

const figure = (value: number, display: (v: number) => string): PerformanceFigure => ({ value, display: display(value), basis: "measured", source: "own", unavailableReason: null });
const missing = (reason: "no_outcome_yet" | "nobody_emailed_yet"): PerformanceFigure => ({ value: null, display: null, basis: null, source: null, unavailableReason: reason });
const count = (v: number, display: (x: number) => string): PerformanceCount => ({ value: v, display: display(v) });
const costOf = (f: LedgerScriptFigures): number | null => (Math.round(f.outcomes) >= 1 && f.spentUsd > 0 ? f.spentUsd / f.outcomes : null);
const rateOf = (f: LedgerScriptFigures): number | null => (f.contacted > 0 ? (100 * f.outcomes) / f.contacted : null);

/** PURE. A script's displayed figures, every one measured (none estimated). */
export function scriptRowFigures(f: LedgerScriptFigures): ScriptRowFigures {
  const cost = costOf(f);
  const rate = rateOf(f);
  return {
    costPerOutcomeUsd: cost !== null ? figure(cost, usd) : missing("no_outcome_yet"),
    conversionRatePct: rate !== null ? figure(rate, pctText) : missing("nobody_emailed_yet"),
    outcomes: count(f.outcomes, (v) => n(Math.round(v))),
    spentUsd: count(f.spentUsd, usd),
    contacted: count(f.contacted, (v) => n(Math.round(v))),
  };
}

const ZERO: LedgerScriptFigures = { spentUsd: 0, outcomes: 0, contacted: 0 };
const monthEnd = (ym: string): string => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const nextMonth = (ym: string) => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};
export const monthText = (ym: string): string => `${MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym.slice(5, 7)} ${ym.slice(0, 4)}`;

/**
 * PURE. The measure's script rows on a view, their order and their cumulative month series. `matureCutDay` = the last run
 * day of the mature cohort (null = the measure has no wait: mature ≡ flash). A script with figures on the ledger, or runs
 * on the board in the last 30 days, is a row; a script of the catalogue that never ran is not (no zero rows).
 */
export function measureScripts(input: {
  measure: MeasureTerms;
  book: LedgerPipeBook;
  view: "mature" | "flash";
  matureCutDay: string | null;
  keyOf: (slug: string | null | undefined) => string;
  facts: ReadonlyMap<string, ScriptFacts>;
  now: Date;
}): MeasureScripts {
  const { measure, book, keyOf } = input;
  const campaigns = bookCampaigns(book);
  const memo = new Map<string, Map<string, LedgerScriptFigures>>();
  const at = (cut: string | undefined) => {
    const k = cut ?? "*";
    let v = memo.get(k);
    if (!v) memo.set(k, (v = measureScriptFigures(measure, book, keyOf, campaigns, cut)));
    return v;
  };
  // everything run up to a day, on the flash rule (the month series of a row read on flash)
  const flashMemo = new Map<string, Map<string, LedgerScriptFigures>>();
  const flashUntil = (day: string) => {
    let v = flashMemo.get(day);
    if (!v) {
      const until = (d: string | null | undefined) => d != null && d <= day;
      const cut: LedgerPipeBook = {
        produced: book.produced.filter((r) => until(r.runStartDay)),
        noOutput: book.noOutput.filter((r) => until(r.runStartDay)),
        consumed: book.consumed.filter((c) => until(c.runStartDay)),
      };
      flashMemo.set(day, (v = measureScriptFigures(measure, cut, keyOf, campaigns)));
    }
    return v;
  };
  const flash = at(undefined);
  const mature = input.matureCutDay ? at(input.matureCutDay) : flash;
  const legKey = `${measure.startsFrom ?? "start"}_to_${measure.counts}`;
  const outcomesRequired = legMaturity(legKey).outcomesRequired;
  const keys = new Set([...flash.keys(), ...[...input.facts.values()].filter((f) => f.recentRuns > 0 && f.key.startsWith(`${measure.engine}/`)).map((f) => f.key)]);
  const drafts = [...keys].map((key) => {
    const f = flash.get(key) ?? ZERO;
    const mf = mature.get(key) ?? null;
    // no run in the mature cohort = no mature evidence: served on its flash figures
    const onMature = input.view === "mature" && mf !== null && mf.spentUsd > 0;
    const shown = input.view === "flash" || !onMature ? f : mf!;
    const facts = input.facts.get(key);
    const matureOutcomes = mf ? mf.outcomes : 0;
    const isMature = isMatureCount(matureOutcomes, legKey) === true;
    const recentRuns = facts?.recentRuns ?? 0;
    const runnable = facts?.runnable ?? false;
    const row: ScriptPerformanceRow = {
      key,
      rank: 0,
      era: "scripts",
      script: { key, label: facts?.name ?? key.slice(key.indexOf("/") + 1), name: facts?.name ?? null },
      template: facts?.template ? { ...facts.template, dynasty: null, standaloneReason: null } : null,
      llm: facts?.llm ?? null,
      written: true,
      writerSource: "script_tactics",
      writerUnavailableReason: null,
      basis: input.view === "mature" && onMature ? "mature" : "flash",
      maturity: { isMature, matureOutcomes, outcomesRequired },
      learning: !isMature,
      recentRuns,
      spendUnavailableReason: recentRuns > 0 && !(f.spentUsd > 0) ? "ran_with_no_cost_on_ledger" : null,
      // the order reads the flash figures whatever the view (PERF-ORDER-FLASH-1023)
      sortCostUsd: costOf(f) ?? f.spentUsd,
      untested: !(f.spentUsd > 0) && recentRuns === 0,
      status: runnable ? "active" : "deprecated",
      deprecatedParts: runnable ? [] : ["script"],
      ...scriptRowFigures(shown),
    };
    return { row, onMature };
  });
  const rows = drafts
    .map((d) => d.row)
    // a script with no cent on the ledger has no measured figure: it stands after the measured ones of its status, never as $0
    .sort(
      (a, b) =>
        (a.status === b.status ? 0 : a.status === "active" ? -1 : 1) ||
        Number(a.spendUnavailableReason !== null) - Number(b.spendUnavailableReason !== null) ||
        a.sortCostUsd - b.sortCostUsd ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
    .map((r, i) => ({ ...r, rank: i + 1 }));

  // The cumulative series: each row on its own half, to the end of each month; the current month IS the rows' figures.
  const onMature = new Map(drafts.map((d) => [d.row.key, d.onMature]));
  const days = [...book.produced, ...book.noOutput]
    .filter((r) => r.workflowSlug === null && r.runStartDay && keys.has(keyOf(r.scriptSlug)))
    .map((r) => r.runStartDay!)
    .sort();
  const thisMonth = input.now.toISOString().slice(0, 7);
  const points: ScriptPoint[] = [];
  if (rows.length > 0) {
    for (let ym = days[0]?.slice(0, 7) ?? thisMonth; ym <= thisMonth; ym = nextMonth(ym)) {
      const p: ScriptPoint = { month: ym, spentUsd: 0, outcomes: 0, contacted: 0 };
      for (const r of rows) {
        let f: LedgerScriptFigures;
        if (ym === thisMonth) f = { spentUsd: r.spentUsd.value, outcomes: r.outcomes.value, contacted: r.contacted.value };
        else {
          const end = monthEnd(ym);
          // a row on the mature cohort: the cohort as of that month (its runs started by then, the cut's rule); else every run to then
          const cohort = onMature.get(r.key) && input.matureCutDay ? (input.matureCutDay < end ? input.matureCutDay : end) : null;
          f = (cohort ? at(cohort) : flashUntil(end)).get(r.key) ?? ZERO;
        }
        p.spentUsd += f.spentUsd;
        p.outcomes += f.outcomes;
        p.contacted += f.contacted;
      }
      points.push(p);
    }
  }
  const unplacedOutcomes = pipeScriptCosts(measure.counts, campaigns, book, undefined, keyOf).get(SCRIPT_POOL)?.outcomes ?? 0;
  return { rows, points, unplacedOutcomes };
}
