/**
 * THE PERFORMANCE TAB OF ONE PIPE (owner 2026-10-23, RESEARCH-PERFORMANCE-1023). Pure.
 *
 * Since BEST-TPL-LLM-1022 a workflow fixes neither its template nor its LLM: each send takes the pipe's best of each. So
 * what actually sent a pipe's emails is a COMBINATION (workflow dynasty × template DYNASTY × LLM dynasty, owner
 * 2026-10-23: « quand je parle de colonne template et LLM je parle des dynasties »), one per person: what wrote their
 * sequence (content-generation's record in the fleet person cell; a person without one takes the writer of the workflow
 * version that served them, its DAG, else its dynasty's newest writing version, the catalogue's `wroteWith` rule) under
 * the workflow whose version served them.
 *
 * ONE FIGURE PER PIPE: each workflow's rows are read on that workflow's catalogue bar (`workflowBuckets`: the leg
 * ranking row, MATURE for a mature workflow) and scaled onto it, so a workflow's rows add up to its Workflows-tab figures
 * and the pipe totals are the Workflows tab's sum. Each version's evidence is shared on its people
 * (`splitCellsByGroup`), so the rows PARTITION the pipe:
 *
 *   Σ rows = the totals = Σ the Workflows tab's bars; the last point of each series = its card.
 *
 * EVERY ROW READS ITS OWN MEASURED FIGURES, nothing estimated (owner 2026-10-24, PERF-COST-ORDER-1024: « Tu ne fais pas
 * tes calculs mathématiques compliqués pour estimer la vraie valeur de ce $/outcome »; supersedes RESEARCH-COMBO-ESTIMATE-1023
 * and PRIOR-PART-EFFECTS-1023). Spend, people and outcomes are measured; conversion is measured whenever it emailed somebody
 * (0% included); cost per outcome and ROI only with an outcome of its own, else null with the reason. A measured ROI is the
 * catalogue's (TPL-ROI-OWN-1022): its workflow's pipeline shared on outcomes ÷ its workflow's billed spend shared on spend.
 *
 * THE ROWS STAND ON THE FIGURE THE TABLE SHOWS (PERF-COST-ORDER-1024, supersedes PERF-LEG-ORDER-1023's pick order, which put
 * 150 never-used combinations above every combination that had proven itself): active first, then cost per outcome
 * ascending, a row with no outcome standing on its $ spent instead (`sortCostUsd`). Read on the FLASH figures whatever the
 * view (`inFlashOrder`, owner same day: « c'est à moi de m'habituer que ça sort sur la vue flash »). A row that spent
 * nothing on the flash view is `untested`: the dashboard hides those by default.
 *
 * Only the FIRST combination the pipe runs today is a real pick: the pipe chooses its workflow, its template and its LLM
 * separately (BEST-TPL-LLM-1022), never a combination. That one is served beside the rows at read (`servedNow`).
 *
 * A combination any part of which can no longer run (workflow not runnable, template dynasty deprecated, LLM served
 * under no alias or only deprecated ones) is DEPRECATED and stands after every active one.
 */
import { isMatureCount, legMaturity } from "../maturity.js";
import { bucketOf, type SlugCell } from "./buckets.js";
import { splitCellsByGroup, type SlugCellsInput } from "./slug-cells.js";
import { MONTHS, n, pctText, templateLabel, usd } from "./format.js";
import type { FleetPersonBucket } from "../fleet-positive-repliers.js";
import { NO_TEMPLATE_DYNASTIES, type TemplateDynastyIndex } from "./template-dynasties.js";
import { NO_LLM_DYNASTIES, type LlmDynastyIndex } from "../llm-dynasties.js";
import type { ResearchBucket } from "./studies.js";
import type { ResearchPipeId } from "./types.js";

export type PerformancePart = "workflow" | "template" | "llm";

export interface PerformanceFigure {
  value: number | null;
  display: string | null;
  basis: "measured" | "expected" | null;
  /** measured: `own`. expected (the pipe totals' return only): `pipe_best_workflow` (the money workflow's, else the best measured). */
  source: "own" | "pipe_best_workflow" | null;
  /** `no_outcome_yet` / `nobody_emailed_yet` / `no_return_yet`: a row that has not measured it (never estimated). */
  unavailableReason: "no_outcome_on_pipe" | "nobody_emailed_on_pipe" | "no_return_on_pipe" | "no_outcome_yet" | "nobody_emailed_yet" | "no_return_yet" | null;
}

export interface PerformanceCount {
  value: number;
  display: string;
}

export interface PerformanceFigures {
  roi: PerformanceFigure;
  costPerOutcomeUsd: PerformanceFigure;
  conversionRatePct: PerformanceFigure;
  outcomes: PerformanceCount;
  spentUsd: PerformanceCount;
  /** People emailed (a visit pipe: emailed through our own sender, the only ones a visit can come from). */
  contacted: PerformanceCount;
}

export interface PerformanceRow extends PerformanceFigures {
  /** `<workflow dynasty>|<template page key or ->|<LLM dynasty or ->`. */
  key: string;
  rank: number;
  workflow: { key: string; label: string; name: string | null };
  /**
   * The template DYNASTY (= its Research template page): `key` = the page key (the dynasty slug; a version no dynasty of
   * the pipe lists keeps its own page, keyed on its id, `dynasty: null` + `standaloneReason`).
   */
  template: { key: string; label: string; dynasty: { key: string; label: string } | null; standaloneReason: "no_dynasty_on_pipe" | null } | null;
  /** The LLM DYNASTY (= its Research model page); `key` is a model key when chat-service places the model in none. */
  llm: { key: string; label: string; provider: string | null } | null;
  /** False = a technically valid combination that never wrote an email yet (listed with zero figures, ranked on its parts). */
  written: boolean;
  /** Where the writer comes from: the sequence record, else the workflow version's definition. Null with no writer or never written. */
  writerSource: "sequences" | "workflow_definition" | null;
  /** Set when template and LLM are null: neither the sequences nor the workflow's definition name a writer. */
  writerUnavailableReason: "not_on_record" | null;
  maturity: { isMature: boolean; matureOutcomes: number | null; outcomesRequired: number };
  learning: boolean;
  /** What it stands on in the order: its cost per outcome, else (no outcome) its $ spent; read on the flash view. */
  sortCostUsd: number;
  /** Spent nothing on the flash view (never sent, or a combination no email was written with yet). */
  untested: boolean;
  /** Deprecated as soon as one part can no longer run (`deprecatedParts` names which); deprecated rows stand last. */
  status: "active" | "deprecated";
  deprecatedParts: PerformancePart[];
}

export interface PerformancePoint {
  /** `YYYY-MM`. */
  month: string;
  label: string;
  /** Everything to the END of the month (cumulative). */
  roi: number | null;
  costPerOutcomeUsd: number | null;
  conversionRatePct: number | null;
  outcomes: number;
  spentUsd: number;
}

export interface PipePerformance {
  pipe: ResearchPipeId;
  /** Each workflow's rows on its Workflows-tab bar's basis (mature for a mature workflow): the totals are that tab's sum. */
  figuresBasis: "workflow_bars";
  /** Active rows first, each group by cost per outcome ascending, else $ spent (PERF-COST-ORDER-1024). */
  rowOrder: "cost_per_outcome";
  /** The order is read on the FLASH figures whatever the view (PERF-ORDER-FLASH-1023): the view moves figures, never rows. */
  orderView: "flash";
  /** Every technically valid combination is a row, not only those that wrote (RESEARCH-ALL-COMBOS-1023). */
  rowsCover: "all_valid_combinations";
  /** The pipe the rows are of: what `servedNow` is read on. */
  featureSlug: string | null;
  legKey: string | null;
  outcomeNoun: string;
  outcomeNounPlural: string;
  rows: PerformanceRow[];
  totals: PerformanceFigures | null;
  series: { grain: "month"; points: PerformancePoint[] } | null;
  /** Spend billed on the pipe that no vendor cost prices, left out of every figure (actual basis; 0 on the billed one). */
  unpricedBilledUsd: number;
  unavailableReason: "no_writer_recorded_on_pipe" | null;
}

/** What a workflow VERSION's definition says it writes with (its DAG, else its dynasty's newest writing version). */
export interface VersionWriter {
  /** Template id. */
  template: string | null;
  /** A model id, alias or LLM dynasty slug (`llmKeyOf` places it). */
  model: string | null;
}

export interface PipePerformanceInput {
  pipe: ResearchPipeId;
  noun: string;
  nounPlural: string;
  /** The pipe's feature (channel) slug; absent = `servedNow` cannot be read on it. */
  featureSlug?: string;
  legKey: string;
  cells: readonly SlugCell[];
  persons: readonly FleetPersonBucket[];
  split: Pick<SlugCellsInput, "screened" | "signal" | "cutoffDay">;
  /** The Workflows tab's bars of the pipe (`workflowBuckets`): key = workflow dynasty, its basis and figures. */
  bars: readonly ResearchBucket[];
  /** Version slug → its workflow dynasty. */
  dynastyOf: (slug: string) => string;
  workflowLabelOf: (dynasty: string) => string;
  workflowNameOf: (dynasty: string) => string | null;
  /** Version slug → what its definition writes with; null = unreadable or no writing step. */
  writerOfVersion?: (slug: string) => VersionWriter | null;
  templateDynasties?: TemplateDynastyIndex;
  llmDynasties?: LlmDynastyIndex;
  /** Model id / alias → its LLM bar key (dynasty slug, else model key) and that bar's label (`generationBuckets`). */
  llmKeyOf: (id: string) => string;
  llmLabelOf: (key: string) => string;
  /** The leg workflow ranking's return terms per workflow dynasty (the catalogue's). Absent = no return readable. */
  workflowReturns?: {
    roiOf: ReadonlyMap<string, number | null>;
    moneyGoesHere: string | null;
    pipelineOf: ReadonlyMap<string, number | null>;
    billedOf: ReadonlyMap<string, number | null>;
  };
  /** The parts that can no longer run (keys as on the rows); a combination with any of them is deprecated. */
  deprecated?: DeprecatedParts;
  /**
   * The parts a run may pick today (keys as on the rows): every runnable workflow x selectable template x selectable LLM is
   * listed, a combination that never wrote with zero figures (RESEARCH-ALL-COMBOS-1023). Absent = only what wrote.
   */
  candidates?: { workflows: readonly string[]; templates: readonly string[]; llms: readonly string[] };
  unpricedBilledUsd: number;
  now: Date;
}

export interface DeprecatedParts {
  workflows: ReadonlySet<string>;
  templates: ReadonlySet<string>;
  llms: ReadonlySet<string>;
}

/**
 * PURE. Which parts of a pipe's catalogue can no longer run: a workflow the leg ranking marks not runnable, a template
 * dynasty content-generation deprecated, an LLM chat-service serves under no alias (or content-generation deprecated
 * every alias it is served under). A status nobody could read deprecates nothing.
 */
export function deprecatedPartsOf(
  catalog: {
    workflows: ReadonlyArray<{ key: string; runnable: boolean }>;
    templates: ReadonlyArray<{ key: string; status: string | null }>;
    models: ReadonlyArray<{ key: string; aliases: readonly string[]; aliasesUnavailableReason: string | null }>;
  },
  aliasStatus: ReadonlyMap<string, "active" | "deprecated"> | null,
): DeprecatedParts {
  return {
    workflows: new Set(catalog.workflows.filter((w) => !w.runnable).map((w) => w.key)),
    templates: new Set(catalog.templates.filter((t) => t.status === "deprecated").map((t) => t.key)),
    llms: new Set(
      catalog.models
        .filter((m) => (m.aliases.length === 0 ? m.aliasesUnavailableReason === "no_alias_serves_it" : aliasStatus !== null && m.aliases.every((a) => aliasStatus.get(a) === "deprecated")))
        .map((m) => m.key),
    ),
  };
}

/**
 * PURE. The parts a run may pick today, from the pipe's catalogue (RESEARCH-ALL-COMBOS-1023): every runnable workflow,
 * every template dynasty with a head that is not deprecated, every LLM dynasty served today under at least one alias;
 * minus every deprecated part.
 */
export function candidatePartsOf(
  catalog: {
    workflows: ReadonlyArray<{ key: string; runnable: boolean }>;
    templates: ReadonlyArray<{ key: string; status: string | null; dynasty: { head: unknown } | null }>;
    models: ReadonlyArray<{ key: string; aliases: readonly string[]; dynasty: { servedToday: boolean } | null }>;
  },
  deprecated: DeprecatedParts,
): { workflows: string[]; templates: string[]; llms: string[] } {
  return {
    workflows: catalog.workflows.filter((w) => w.runnable && !deprecated.workflows.has(w.key)).map((w) => w.key),
    templates: catalog.templates.filter((t) => t.dynasty !== null && t.dynasty.head != null && t.status !== "deprecated" && !deprecated.templates.has(t.key)).map((t) => t.key),
    llms: catalog.models.filter((m) => m.dynasty !== null && m.dynasty.servedToday && m.aliases.length > 0 && !deprecated.llms.has(m.key)).map((m) => m.key),
  };
}

const SEP = "\u001f";
const NONE = "-";
const FROM_DAG = "dag";
const FROM_SEQ = "seq";

const figure = (value: number, basis: "measured" | "expected", source: PerformanceFigure["source"], display: (v: number) => string, parts?: PerformancePart[]): PerformanceFigure => ({
  value,
  display: display(value),
  basis,
  source,
  ...(parts ? { parts } : {}),
  unavailableReason: null,
});
const missing = (reason: NonNullable<PerformanceFigure["unavailableReason"]>): PerformanceFigure => ({ value: null, display: null, basis: null, source: null, unavailableReason: reason });
const roiText = (v: number) => `${v.toFixed(2)}x`;
const count = (v: number, display: (x: number) => string): PerformanceCount => ({ value: v, display: display(v) });
const printed = (outcomes: number) => Math.round(outcomes) >= 1;

interface Acc {
  spentUsd: number;
  contacted: number;
  outcomes: number;
  pipelineUsd: number;
  billedUsd: number;
}
const zero = (): Acc => ({ spentUsd: 0, contacted: 0, outcomes: 0, pipelineUsd: 0, billedUsd: 0 });
const addInto = (a: Acc, b: Acc) => {
  a.spentUsd += b.spentUsd;
  a.contacted += b.contacted;
  a.outcomes += b.outcomes;
  a.pipelineUsd += b.pipelineUsd;
  a.billedUsd += b.billedUsd;
};

const nextMonth = (ym: string) => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym.slice(5, 7)} ${ym.slice(0, 4)}`;

/**
 * PURE. The tab on a view, in the FLASH tab's order (PERF-ORDER-FLASH-1023, kept by PERF-COST-ORDER-1024): `rank`,
 * `sortCostUsd` and `untested` are the flash tab's; only the figures are the view's. A row the flash tab lacks keeps its own
 * order, last.
 */
export function inFlashOrder(shown: PipePerformance, flash: PipePerformance): PipePerformance {
  const at = new Map(flash.rows.map((r) => [r.key, r] as const));
  const listed = shown.rows.filter((r) => at.has(r.key)).sort((a, b) => at.get(a.key)!.rank - at.get(b.key)!.rank);
  const rest = shown.rows.filter((r) => !at.has(r.key));
  const rows = [...listed, ...rest].map((r, i) => {
    const f = at.get(r.key);
    return { ...r, rank: i + 1, sortCostUsd: f?.sortCostUsd ?? r.sortCostUsd, untested: f?.untested ?? r.untested };
  });
  return { ...shown, rows };
}

/** One part of the combination the pipe runs today: its key as on the rows and its name. */
export interface ServedPart {
  key: string;
  label: string;
}

/**
 * The combination the pipe runs TODAY (owner 2026-10-24, PERF-COST-ORDER-1024: « la ligne de la combinaison actuelle qui est
 * servie en prod »): the leg workflow ranking's rank 1 (what campaign-service runs) x the writer pick's rank 1 template and
 * rank 1 LLM (what every email of the pipe is written with, default play). `row` = that combination's row on this view.
 */
export interface PerformanceServedNow {
  workflow: ServedPart | null;
  template: ServedPart | null;
  llm: ServedPart | null;
  row: PerformanceRow | null;
  unavailableReason: "pipe_not_read" | "workflow_ranking_not_computed_yet" | "no_runnable_workflow" | "writer_ranking_not_computed_yet" | "no_template_picked" | "no_llm_picked" | "combination_not_listed" | "served_pick_unreadable" | null;
}

/** PURE. The served combination's block: its parts, its row when the tab lists it, else why not. */
export function servedNowOf(
  perf: Pick<PipePerformance, "rows">,
  parts: { workflow: ServedPart | null; template: ServedPart | null; llm: ServedPart | null; unavailableReason: PerformanceServedNow["unavailableReason"] },
): PerformanceServedNow {
  const { workflow, template, llm } = parts;
  if (parts.unavailableReason || !workflow || !template || !llm) {
    const reason = parts.unavailableReason ?? (!workflow ? "no_runnable_workflow" : !template ? "no_template_picked" : "no_llm_picked");
    return { workflow, template, llm, row: null, unavailableReason: reason };
  }
  const row = perf.rows.find((r) => r.key === `${workflow.key}|${template.key}|${llm.key}`) ?? null;
  return { workflow, template, llm, row, unavailableReason: row ? null : "combination_not_listed" };
}

/** PURE. The order of the rows (PERF-COST-ORDER-1024): active first, then `sortCostUsd` ascending, then key. */
export function byShownCost<T extends { status: "active" | "deprecated"; sortCostUsd: number; key: string }>(a: T, b: T): number {
  return (a.status === b.status ? 0 : a.status === "active" ? -1 : 1) || a.sortCostUsd - b.sortCostUsd || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** PURE. One pipe's Performance tab. */
export function pipePerformance(p: PipePerformanceInput): PipePerformance {
  const base = { pipe: p.pipe, figuresBasis: "workflow_bars" as const, rowOrder: "cost_per_outcome" as const, orderView: "flash" as const, rowsCover: "all_valid_combinations" as const, featureSlug: p.featureSlug ?? null, legKey: p.legKey, outcomeNoun: p.noun, outcomeNounPlural: p.nounPlural, unpricedBilledUsd: p.unpricedBilledUsd };
  if (!p.persons.some((b) => b.generation)) return { ...base, rows: [], totals: null, series: null, unavailableReason: "no_writer_recorded_on_pipe" };
  const dyn = p.templateDynasties ?? NO_TEMPLATE_DYNASTIES;
  const llmDyn = p.llmDynasties ?? NO_LLM_DYNASTIES;
  // The writer group of a person: its sequence's template dynasty + LLM dynasty, else its version's definition's.
  const fromDag = (slug: string) => {
    const w = p.writerOfVersion?.(slug) ?? null;
    const tpl = w?.template ? dyn.keyOf(w.template) : NONE;
    const llm = w?.model ? p.llmKeyOf(w.model) : NONE;
    return tpl === NONE && llm === NONE ? `${NONE}${SEP}${NONE}${SEP}${NONE}` : `${tpl}${SEP}${llm}${SEP}${FROM_DAG}`;
  };
  const groupOf = (b: FleetPersonBucket) =>
    b.generation ? `${b.generation.promptType ? dyn.keyOf(b.generation.promptType) : NONE}${SEP}${p.llmKeyOf(b.generation.model)}${SEP}${FROM_SEQ}` : fromDag(b.workflowSlug);
  const split = splitCellsByGroup(p.cells, p.persons, p.split, groupOf);
  const withPersons = new Set(p.persons.map((b) => b.workflowSlug));
  const cells: SlugCell[] = [...split.cells, ...p.cells.filter((c) => !withPersons.has(c.slug)).map((c) => ({ ...c, slug: `${c.slug}\t${fromDag(c.slug)}` }))];

  // Combination → its split cells (a person's writer source is part of the cell, never of the row: merged here).
  const byCombo = new Map<string, { dynasty: string; tpl: string; llm: string; sources: Set<string>; cells: SlugCell[] }>();
  for (const c of cells) {
    const tab = c.slug.indexOf("\t");
    const [tpl = NONE, llm = NONE, src = NONE] = c.slug.slice(tab + 1).split(SEP);
    const dynasty = p.dynastyOf(c.slug.slice(0, tab));
    const key = `${dynasty}|${tpl}|${llm}`;
    const e = byCombo.get(key) ?? { dynasty, tpl, llm, sources: new Set<string>(), cells: [] };
    e.cells.push(c);
    if (src !== NONE) e.sources.add(src);
    byCombo.set(key, e);
  }

  // Each workflow's rows on its bar's basis, scaled onto its bar (one figure per pipe, both tabs).
  const lastMonth = p.now.toISOString().slice(0, 7);
  const outcomesRequired = legMaturity(p.legKey).outcomesRequired;
  type Terms = { perOutcome: number; perSpent: number };
  type Draft = { key: string; e: NonNullable<ReturnType<typeof byCombo.get>>; acc: Acc; months: Map<string, Acc>; isMature: boolean; matureOutcomes: number | null; terms: Terms | null; candidate?: true };
  const drafts: Draft[] = [];
  const combosOf = new Map<string, string[]>();
  for (const [key, e] of byCombo) combosOf.set(e.dynasty, [...(combosOf.get(e.dynasty) ?? []), key]);
  for (const bar of p.bars) {
    const keys = combosOf.get(bar.key) ?? [];
    const raw = keys.map((key) => {
      const e = byCombo.get(key)!;
      const b = bucketOf({ key, label: key, legKey: p.legKey, cells: e.cells, forceBasis: bar.basis });
      const matureCut = e.cells.every((c) => c.mature !== null);
      const matureOutcomes = matureCut ? e.cells.reduce((s, c) => s + c.mature!.figures.outcomes, 0) : null;
      return { key, e, b, matureOutcomes };
    });
    const sum = { spentUsd: 0, contacted: 0, outcomes: 0 };
    for (const r of raw) {
      sum.spentUsd += r.b.figures.spentUsd;
      sum.contacted += r.b.figures.contacted;
      sum.outcomes += r.b.figures.outcomes;
    }
    const k = (part: number, whole: number) => (part > 0 ? whole / part : 0);
    const ks = { spentUsd: k(sum.spentUsd, bar.figures.spentUsd), contacted: k(sum.contacted, bar.figures.contacted), outcomes: k(sum.outcomes, bar.figures.outcomes) };
    // What the bar holds that no row carries (a component its rows read 0 on) sits on the workflow's not-on-record row.
    const rest = {
      spentUsd: sum.spentUsd > 0 ? 0 : bar.figures.spentUsd,
      contacted: sum.contacted > 0 ? 0 : bar.figures.contacted,
      outcomes: sum.outcomes > 0 ? 0 : bar.figures.outcomes,
    };
    const terms = returnTerms(p, bar);
    for (const r of raw) {
      const f = { spentUsd: r.b.figures.spentUsd * ks.spentUsd, contacted: r.b.figures.contacted * ks.contacted, outcomes: r.b.figures.outcomes * ks.outcomes };
      const months = new Map<string, Acc>();
      for (const m of r.b.months ?? [{ month: lastMonth, ...r.b.figures }]) {
        const ym = m.month > lastMonth ? lastMonth : m.month;
        const t = months.get(ym) ?? zero();
        const mf = { spentUsd: m.spentUsd * ks.spentUsd, contacted: m.contacted * ks.contacted, outcomes: m.outcomes * ks.outcomes };
        addInto(t, { ...mf, pipelineUsd: mf.outcomes * terms.perOutcome, billedUsd: mf.spentUsd * terms.perSpent });
        months.set(ym, t);
      }
      drafts.push({
        key: r.key,
        e: r.e,
        acc: { ...f, pipelineUsd: f.outcomes * terms.perOutcome, billedUsd: f.spentUsd * terms.perSpent },
        months,
        isMature: isMatureCount(r.matureOutcomes, p.legKey) === true,
        matureOutcomes: r.matureOutcomes,
        terms,
      });
    }
    if (rest.spentUsd > 0 || rest.contacted > 0 || rest.outcomes > 0) {
      const key = `${bar.key}|${NONE}|${NONE}`;
      const acc = { ...rest, pipelineUsd: rest.outcomes * terms.perOutcome, billedUsd: rest.spentUsd * terms.perSpent };
      const existing = drafts.find((d) => d.key === key);
      if (existing) {
        addInto(existing.acc, acc);
        const t = existing.months.get(lastMonth) ?? zero();
        addInto(t, acc);
        existing.months.set(lastMonth, t);
      } else {
        drafts.push({ key, e: { dynasty: bar.key, tpl: NONE, llm: NONE, sources: new Set(), cells: [] }, acc, months: new Map([[lastMonth, { ...acc }]]), isMature: false, matureOutcomes: null, terms });
      }
    }
  }

  // Every technically valid combination is listed (owner 2026-10-23, RESEARCH-ALL-COMBOS-1023, « je veux dans cette table
  // toutes les combinaisons valides techniquement et que tu ranks tout »): one that never wrote gets a zero row. It adds
  // nothing to the totals or the series.
  const written = new Set(drafts.map((d) => d.key));
  const c = p.candidates;
  const termsOfWorkflow = new Map(p.bars.map((bar) => [bar.key, returnTerms(p, bar)] as const));
  if (c)
    for (const w of c.workflows)
      for (const t of c.templates)
        for (const l of c.llms) {
          const key = `${w}|${t}|${l}`;
          if (written.has(key)) continue;
          written.add(key);
          drafts.push({ key, e: { dynasty: w, tpl: t, llm: l, sources: new Set(), cells: [] }, acc: zero(), months: new Map(), isMature: false, matureOutcomes: null, terms: termsOfWorkflow.get(w) ?? null, candidate: true });
        }

  // The series: every month from the first to this one, cumulative; its last point IS the totals (the cards).
  const monthly = new Map<string, Acc>();
  for (const d of drafts)
    for (const [ym, m] of d.months) {
      const t = monthly.get(ym) ?? zero();
      addInto(t, m);
      monthly.set(ym, t);
    }
  const first = [...monthly.keys()].sort()[0] ?? lastMonth;
  const points: PerformancePoint[] = [];
  const cum = zero();
  for (let ym = first; ym <= lastMonth; ym = nextMonth(ym)) {
    const m = monthly.get(ym);
    if (m) addInto(cum, m);
    points.push({
      month: ym,
      label: monthLabel(ym),
      roi: cum.billedUsd > 0 && printed(cum.outcomes) ? cum.pipelineUsd / cum.billedUsd : null,
      costPerOutcomeUsd: printed(cum.outcomes) && cum.spentUsd > 0 ? cum.spentUsd / cum.outcomes : null,
      conversionRatePct: cum.contacted > 0 ? (100 * cum.outcomes) / cum.contacted : null,
      outcomes: cum.outcomes,
      spentUsd: cum.spentUsd,
    });
  }

  const measuredRoi = (a: Acc) => (printed(a.outcomes) && a.billedUsd > 0 ? a.pipelineUsd / a.billedUsd : null);
  const measuredCost = (a: Acc) => (printed(a.outcomes) && a.spentUsd > 0 ? a.spentUsd / a.outcomes : null);
  const measuredRate = (a: Acc) => (a.contacted > 0 ? (100 * a.outcomes) / a.contacted : null);

  // The money workflow's return: the pipe totals' expected return while the pipe measured none of its own.
  const w = p.workflowReturns;
  const moneyRoi = (() => {
    if (!w) return null;
    const money = w.moneyGoesHere ? w.roiOf.get(w.moneyGoesHere) : null;
    if (money != null && money > 0) return money;
    return [...w.roiOf.values()].filter((v): v is number => v != null && v > 0).sort((a, b) => b - a)[0] ?? null;
  })();
  const pooledRoi = measuredRoi(cum);
  const pooledCost = measuredCost(cum);
  const pooledRate = measuredRate(cum);

  // Every row reads its own measured figures, nothing estimated (PERF-COST-ORDER-1024).
  const rowFigures = (d: Draft): Pick<PerformanceFigures, "roi" | "costPerOutcomeUsd" | "conversionRatePct"> => {
    const a = d.acc;
    const roi = measuredRoi(a);
    const cost = measuredCost(a);
    const rate = measuredRate(a);
    return {
      roi: roi !== null ? figure(roi, "measured", "own", roiText) : missing(printed(a.outcomes) ? "no_return_yet" : "no_outcome_yet"),
      costPerOutcomeUsd: cost !== null ? figure(cost, "measured", "own", usd) : missing("no_outcome_yet"),
      conversionRatePct: rate !== null ? figure(rate, "measured", "own", pctText) : missing("nobody_emailed_yet"),
    };
  };

  const dep = p.deprecated;
  const deprecatedOf = (e: Draft["e"]): PerformancePart[] =>
    dep
      ? ([
          ["workflow", dep.workflows.has(e.dynasty)],
          ["template", e.tpl !== NONE && dep.templates.has(dyn.keyOf(e.tpl))],
          ["llm", e.llm !== NONE && dep.llms.has(e.llm)],
        ] as Array<[PerformancePart, boolean]>).flatMap(([part, on]) => (on ? [part] : []))
      : [];
  const unordered = drafts
    .map((d) => {
      const e = d.e;
      const cost = measuredCost(d.acc);
      const deprecatedParts = deprecatedOf(e);
      const standalone = e.tpl !== NONE ? dyn.dynastyOf(e.tpl) === null : false;
      const tplDynasty = e.tpl !== NONE ? dyn.dynastyOf(e.tpl) : null;
      const llmDynasty = e.llm !== NONE ? llmDyn.bySlug(e.llm) : null;
      return {
        key: d.key,
        rank: 0,
        workflow: { key: e.dynasty, label: p.workflowLabelOf(e.dynasty), name: p.workflowNameOf(e.dynasty) },
        template:
          e.tpl === NONE
            ? null
            : {
                key: e.tpl,
                label: tplDynasty ? tplDynasty.name : templateLabel(e.tpl),
                dynasty: tplDynasty ? { key: tplDynasty.slug, label: tplDynasty.name } : null,
                standaloneReason: standalone ? ("no_dynasty_on_pipe" as const) : null,
              },
        llm: e.llm === NONE ? null : { key: e.llm, label: p.llmLabelOf(e.llm), provider: llmDynasty?.provider || null },
        written: !d.candidate,
        writerSource: d.candidate || (e.tpl === NONE && e.llm === NONE) ? null : e.sources.has(FROM_SEQ) ? ("sequences" as const) : ("workflow_definition" as const),
        writerUnavailableReason: e.tpl === NONE && e.llm === NONE ? ("not_on_record" as const) : null,
        maturity: { isMature: d.isMature, matureOutcomes: d.matureOutcomes, outcomesRequired },
        learning: !d.isMature,
        sortCostUsd: cost ?? d.acc.spentUsd,
        untested: !(d.acc.spentUsd > 0),
        status: deprecatedParts.length ? ("deprecated" as const) : ("active" as const),
        deprecatedParts,
        ...rowFigures(d),
        outcomes: count(d.acc.outcomes, (v) => n(Math.round(v))),
        spentUsd: count(d.acc.spentUsd, usd),
        contacted: count(d.acc.contacted, (v) => n(Math.round(v))),
      };
    });
  // The order (PERF-COST-ORDER-1024): active first, then cost per outcome, else $ spent, ascending.
  const ranked: PerformanceRow[] = [...unordered].sort(byShownCost).map((r, i) => ({ ...r, rank: i + 1 }));

  const totalsRoi = pooledRoi !== null ? figure(pooledRoi, "measured", "own", roiText) : moneyRoi != null ? figure(moneyRoi, "expected", "pipe_best_workflow", roiText) : missing("no_return_on_pipe");
  const totals: PerformanceFigures = {
    roi: totalsRoi,
    costPerOutcomeUsd: pooledCost !== null ? figure(pooledCost, "measured", "own", usd) : missing("no_outcome_on_pipe"),
    conversionRatePct: pooledRate !== null ? figure(pooledRate, "measured", "own", pctText) : missing("nobody_emailed_on_pipe"),
    outcomes: count(cum.outcomes, (v) => n(Math.round(v))),
    spentUsd: count(cum.spentUsd, usd),
    contacted: count(cum.contacted, (v) => n(Math.round(v))),
  };
  return { ...base, rows: ranked, totals, series: { grain: "month", points }, unavailableReason: null };
}

/** A workflow's return terms per outcome and per dollar of its bar (its ranking pipeline and billed spend shared on them). */
function returnTerms(p: PipePerformanceInput, bar: ResearchBucket): { perOutcome: number; perSpent: number } {
  const pl = p.workflowReturns?.pipelineOf.get(bar.key);
  const bl = p.workflowReturns?.billedOf.get(bar.key);
  if (pl == null || bl == null) return { perOutcome: 0, perSpent: 0 };
  return { perOutcome: bar.figures.outcomes > 0 ? pl / bar.figures.outcomes : 0, perSpent: bar.figures.spentUsd > 0 ? bl / bar.figures.spentUsd : 0 };
}
