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
 * EVERY ROW READS ITS OWN FIGURES. Spend, people and outcomes are measured; conversion is measured whenever it emailed
 * somebody (0% included). With no outcome, its ROI and cost per outcome are EXPECTED from ITS OWN PARTS: the geometric
 * mean of what its workflow, its template and its LLM measured on this pipe (each part = every row sharing it, with an
 * outcome of its own), `source: own_parts` + `parts`; no part measured = every combination of the pipe pooled; a return
 * still unknown = the money workflow's. The return is the catalogue's (TPL-ROI-OWN-1022): its workflow's pipeline
 * shared on outcomes ÷ its workflow's billed spend shared on spend; never 0 when expected, null only with a reason.
 *
 * THE ROWS STAND IN THE ORDER THE PIPE PICKS BY (RESEARCH-PICK-ORDER-1023, owner 2026-10-23 « le tri réel que tu
 * utiliserais en prod »): the workflow's leg ranking rank, then the template's and the LLM's place in their own leg
 * order (`rankWriters`), never by ROI (the pick is on cost per outcome, each part on its own).
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
  /**
   * measured: `own`. expected: `own_parts` (the geometric mean of what the row's parts measured on the pipe, named in
   * `parts`), `pipe_combinations` (every combination of the pipe pooled), `pipe_best_workflow` (a return: the money
   * workflow's, else the pipe's best measured).
   */
  source: "own" | "own_parts" | "pipe_combinations" | "pipe_best_workflow" | null;
  /** On `own_parts`: the parts the figure is read from. */
  parts?: PerformancePart[];
  unavailableReason: "no_outcome_on_pipe" | "nobody_emailed_on_pipe" | "no_return_on_pipe" | null;
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
  /** Where the writer comes from: the sequence record, else the workflow version's definition. Null with no writer. */
  writerSource: "sequences" | "workflow_definition" | null;
  /** Set when template and LLM are null: neither the sequences nor the workflow's definition name a writer. */
  writerUnavailableReason: "not_on_record" | null;
  maturity: { isMature: boolean; matureOutcomes: number | null; outcomesRequired: number };
  learning: boolean;
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
  /** The rows stand in the order the pipe PICKS by: workflow rank, then template, then LLM (RESEARCH-PICK-ORDER-1023). */
  rowOrder: "pick_order";
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
  /**
   * Where each part stands in the order the pipe picks it by (1 = picked first): workflow dynasty → its leg ranking
   * `rank`; template page key and LLM key → their place in the catalogue's `rankWriters` order. The rows sort on it.
   */
  pickOrder: PickOrder;
  unpricedBilledUsd: number;
  now: Date;
}

export interface PickOrder {
  workflows: ReadonlyMap<string, number>;
  templates: ReadonlyMap<string, number>;
  llms: ReadonlyMap<string, number>;
}

/** PURE. The pick order of a pipe: its leg ranking's workflow ranks, its catalogue's template and LLM order. */
export function pickOrderOf(ranking: ReadonlyArray<{ workflowDynastySlug: string; rank: number }> | null, catalog: { templates: ReadonlyArray<{ key: string }>; models: ReadonlyArray<{ key: string }> }): PickOrder {
  return {
    workflows: new Map((ranking ?? []).map((r) => [r.workflowDynastySlug, r.rank])),
    templates: new Map(catalog.templates.map((t, i) => [t.key, i + 1])),
    llms: new Map(catalog.models.map((m, i) => [m.key, i + 1])),
  };
}

const placeOf = (order: ReadonlyMap<string, number>, key: string | null | undefined) => (key != null ? (order.get(key) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER);

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
const geoMean = (xs: readonly number[]) => Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);

const nextMonth = (ym: string) => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym.slice(5, 7)} ${ym.slice(0, 4)}`;

/** PURE. One pipe's Performance tab. */
export function pipePerformance(p: PipePerformanceInput): PipePerformance {
  const base = { pipe: p.pipe, figuresBasis: "workflow_bars" as const, rowOrder: "pick_order" as const, outcomeNoun: p.noun, outcomeNounPlural: p.nounPlural, unpricedBilledUsd: p.unpricedBilledUsd };
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
  type Draft = { key: string; e: NonNullable<ReturnType<typeof byCombo.get>>; acc: Acc; months: Map<string, Acc>; isMature: boolean; matureOutcomes: number | null };
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
        drafts.push({ key, e: { dynasty: bar.key, tpl: NONE, llm: NONE, sources: new Set(), cells: [] }, acc, months: new Map([[lastMonth, { ...acc }]]), isMature: false, matureOutcomes: null });
      }
    }
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

  // Each part's own figures on the pipe (every row sharing it).
  const partAcc = new Map<string, Acc>();
  const partKeys = (d: Draft): Array<[PerformancePart, string]> => [
    ["workflow", `w:${d.e.dynasty}`],
    ...(d.e.tpl !== NONE ? ([["template", `t:${d.e.tpl}`]] as Array<[PerformancePart, string]>) : []),
    ...(d.e.llm !== NONE ? ([["llm", `l:${d.e.llm}`]] as Array<[PerformancePart, string]>) : []),
  ];
  for (const d of drafts)
    for (const [, k] of partKeys(d)) {
      const t = partAcc.get(k) ?? zero();
      addInto(t, d.acc);
      partAcc.set(k, t);
    }
  const measuredRoi = (a: Acc) => (printed(a.outcomes) && a.billedUsd > 0 ? a.pipelineUsd / a.billedUsd : null);
  const measuredCost = (a: Acc) => (printed(a.outcomes) && a.spentUsd > 0 ? a.spentUsd / a.outcomes : null);
  const measuredRate = (a: Acc) => (a.contacted > 0 ? (100 * a.outcomes) / a.contacted : null);
  const fromParts = (d: Draft, read: (a: Acc) => number | null): { value: number; parts: PerformancePart[] } | null => {
    const got = partKeys(d).flatMap(([part, k]) => {
      const v = read(partAcc.get(k)!);
      return v != null && v > 0 ? [{ part, v }] : [];
    });
    return got.length ? { value: geoMean(got.map((g) => g.v)), parts: got.map((g) => g.part) } : null;
  };

  // The pipe pooled, and the money workflow's return (the last resort of an expected return).
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

  const rowFigures = (d: Draft): Pick<PerformanceFigures, "roi" | "costPerOutcomeUsd" | "conversionRatePct"> => {
    const a = d.acc;
    const ownRoi = measuredRoi(a);
    const partsRoi = ownRoi === null ? fromParts(d, measuredRoi) : null;
    const roi =
      ownRoi !== null
        ? figure(ownRoi, "measured", "own", roiText)
        : partsRoi
          ? figure(partsRoi.value, "expected", "own_parts", roiText, partsRoi.parts)
          : pooledRoi != null && pooledRoi > 0
            ? figure(pooledRoi, "expected", "pipe_combinations", roiText)
            : moneyRoi != null
              ? figure(moneyRoi, "expected", "pipe_best_workflow", roiText)
              : missing("no_return_on_pipe");
    const ownCost = measuredCost(a);
    const partsCost = ownCost === null ? fromParts(d, measuredCost) : null;
    const cost =
      ownCost !== null
        ? figure(ownCost, "measured", "own", usd)
        : partsCost
          ? figure(partsCost.value, "expected", "own_parts", usd, partsCost.parts)
          : pooledCost != null
            ? figure(pooledCost, "expected", "pipe_combinations", usd)
            : missing("no_outcome_on_pipe");
    // Conversion is MEASURED whenever the row emailed somebody (a measured 0% included).
    const ownRate = measuredRate(a);
    const partsRate = ownRate === null ? fromParts(d, measuredRate) : null;
    const rate =
      ownRate !== null
        ? figure(ownRate, "measured", "own", pctText)
        : partsRate
          ? figure(partsRate.value, "expected", "own_parts", pctText, partsRate.parts)
          : pooledRate != null
            ? figure(pooledRate, "expected", "pipe_combinations", pctText)
            : missing("nobody_emailed_on_pipe");
    return { roi, costPerOutcomeUsd: cost, conversionRatePct: rate };
  };

  const rows: PerformanceRow[] = drafts
    .map((d) => {
      const e = d.e;
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
        writerSource: e.tpl === NONE && e.llm === NONE ? null : e.sources.has(FROM_SEQ) ? ("sequences" as const) : ("workflow_definition" as const),
        writerUnavailableReason: e.tpl === NONE && e.llm === NONE ? ("not_on_record" as const) : null,
        maturity: { isMature: d.isMature, matureOutcomes: d.matureOutcomes, outcomesRequired },
        learning: !d.isMature,
        ...rowFigures(d),
        outcomes: count(d.acc.outcomes, (v) => n(Math.round(v))),
        spentUsd: count(d.acc.spentUsd, usd),
        contacted: count(d.acc.contacted, (v) => n(Math.round(v))),
      };
    })
    // The order the pipe PICKS by (RESEARCH-PICK-ORDER-1023, owner « le tri réel que tu utiliserais en prod »): the
    // workflow's place in the ONE leg order, then the template's and the LLM's in theirs (`rankWriters`); a part the
    // order does not list stands after every listed one. Then outcomes, people, key.
    .sort((a, b) => {
      const byWorkflow = placeOf(p.pickOrder.workflows, a.workflow.key) - placeOf(p.pickOrder.workflows, b.workflow.key);
      if (byWorkflow !== 0) return byWorkflow;
      const byTemplate = placeOf(p.pickOrder.templates, a.template?.key) - placeOf(p.pickOrder.templates, b.template?.key);
      if (byTemplate !== 0) return byTemplate;
      const byLlm = placeOf(p.pickOrder.llms, a.llm?.key) - placeOf(p.pickOrder.llms, b.llm?.key);
      if (byLlm !== 0) return byLlm;
      if (a.outcomes.value !== b.outcomes.value) return b.outcomes.value - a.outcomes.value;
      if (a.contacted.value !== b.contacted.value) return b.contacted.value - a.contacted.value;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    })
    .map((r, i) => ({ ...r, rank: i + 1 }));

  const totalsRoi = pooledRoi !== null ? figure(pooledRoi, "measured", "own", roiText) : moneyRoi != null ? figure(moneyRoi, "expected", "pipe_best_workflow", roiText) : missing("no_return_on_pipe");
  const totals: PerformanceFigures = {
    roi: totalsRoi,
    costPerOutcomeUsd: pooledCost !== null ? figure(pooledCost, "measured", "own", usd) : missing("no_outcome_on_pipe"),
    conversionRatePct: pooledRate !== null ? figure(pooledRate, "measured", "own", pctText) : missing("nobody_emailed_on_pipe"),
    outcomes: count(cum.outcomes, (v) => n(Math.round(v))),
    spentUsd: count(cum.spentUsd, usd),
    contacted: count(cum.contacted, (v) => n(Math.round(v))),
  };
  return { ...base, rows, totals, series: { grain: "month", points }, unavailableReason: null };
}

/** A workflow's return terms per outcome and per dollar of its bar (its ranking pipeline and billed spend shared on them). */
function returnTerms(p: PipePerformanceInput, bar: ResearchBucket): { perOutcome: number; perSpent: number } {
  const pl = p.workflowReturns?.pipelineOf.get(bar.key);
  const bl = p.workflowReturns?.billedOf.get(bar.key);
  if (pl == null || bl == null) return { perOutcome: 0, perSpent: 0 };
  return { perOutcome: bar.figures.outcomes > 0 ? pl / bar.figures.outcomes : 0, perSpent: bar.figures.spentUsd > 0 ? bl / bar.figures.spentUsd : 0 };
}
