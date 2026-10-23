/**
 * THE PERFORMANCE TAB OF ONE PIPE (owner 2026-10-23, RESEARCH-PERFORMANCE-1023). Pure.
 *
 * Since BEST-TPL-LLM-1022 a workflow fixes neither its template nor its LLM: each send takes the pipe's best of each. So
 * what actually sent a pipe's emails is a COMBINATION (workflow dynasty, template version, LLM dynasty), one per person:
 * the template and LLM that wrote their sequence (content-generation's record, carried by the fleet person cell) under
 * the workflow whose version served them. Each version's spend, people and outcomes (the ranking's per-version evidence)
 * are shared out on its people (`splitCellsByGroup`), so the combinations PARTITION the pipe:
 *
 *   Σ rows = the pipe's totals (spend, people, outcomes), and the last point of each series = its card.
 *
 * A person whose sequence is not on record stays in the table, on a row whose template and LLM are null
 * (`writerUnavailableReason: not_on_record`), never dropped, so the partition holds.
 *
 * Every figure is SINCE INCEPTION (the flash half: one basis, so rows add up); each row states its maturity verdict on
 * the leg's rule (`isMatureCount` on its pooled mature outcomes) and is Learning until then. The return is the
 * catalogue's (TPL-ROI-OWN-1022): the pipeline its own outcomes carry (its workflow's pipeline shared on outcomes) ÷ what
 * its own people were billed (its workflow's billed spend shared on spend), MEASURED only with an outcome of its own,
 * else EXPECTED (every combination of the pipe pooled, else the money workflow's), never 0, null only with a reason. A
 * row with no outcome never serves its spend as a cost per outcome: its cost per outcome is EXPECTED (the pipe pooled).
 */
import { isMatureCount, legMaturity } from "../maturity.js";
import { bucketOf, type SlugCell } from "./buckets.js";
import { splitCellsByGroup, type SlugCellsInput } from "./slug-cells.js";
import { MONTHS, n, pctText, templateLabel, usd } from "./format.js";
import type { FleetPersonBucket } from "../fleet-positive-repliers.js";
import { NO_TEMPLATE_DYNASTIES, type TemplateDynastyIndex } from "./template-dynasties.js";
import { NO_LLM_DYNASTIES, type LlmDynastyIndex } from "../llm-dynasties.js";
import type { ResearchPipeId } from "./types.js";

export interface PerformanceFigure {
  value: number | null;
  display: string | null;
  basis: "measured" | "expected" | null;
  /**
   * measured: `own` (the row's or the pipe's own figures). expected: `pipe_combinations` (every combination of the pipe
   * pooled), `pipe_best_workflow` (a return: the workflow the pipe puts its money on, else its best measured return).
   */
  source: "own" | "pipe_combinations" | "pipe_best_workflow" | null;
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
  /** `<workflow dynasty>|<template version or ->|<LLM dynasty or ->`. */
  key: string;
  rank: number;
  workflow: { key: string; label: string; name: string | null };
  /** The template VERSION that wrote these people's sequences, and the dynasty (= its Research page) it belongs to. */
  template: { key: string; label: string; dynasty: { key: string; label: string } | null } | null;
  /** The LLM DYNASTY (= its Research model page); `key` is a model key when chat-service places the model in none. */
  llm: { key: string; label: string; provider: string | null } | null;
  /** Set when template and LLM are null: what wrote these people is not on record. */
  writerUnavailableReason: "not_on_record" | null;
  maturity: { isMature: boolean; matureOutcomes: number | null; outcomesRequired: number };
  learning: boolean;
}

export interface PerformancePoint {
  /** `YYYY-MM`. */
  month: string;
  label: string;
  /** Everything to the END of the month (cumulative since inception). */
  roi: number | null;
  costPerOutcomeUsd: number | null;
  conversionRatePct: number | null;
  outcomes: number;
  spentUsd: number;
}

export interface PipePerformance {
  pipe: ResearchPipeId;
  /** Every figure is since inception (the flash half): the rows add up to the totals. */
  figuresBasis: "since_inception";
  outcomeNoun: string;
  outcomeNounPlural: string;
  rows: PerformanceRow[];
  totals: PerformanceFigures | null;
  series: { grain: "month"; points: PerformancePoint[] } | null;
  /** Spend billed on the pipe that no vendor cost prices, left out of every figure (actual basis; 0 on the billed one). */
  unpricedBilledUsd: number;
  unavailableReason: "no_writer_recorded_on_pipe" | null;
}

export interface PipePerformanceInput {
  pipe: ResearchPipeId;
  noun: string;
  nounPlural: string;
  legKey: string;
  cells: readonly SlugCell[];
  persons: readonly FleetPersonBucket[];
  split: Pick<SlugCellsInput, "screened" | "signal" | "cutoffDay">;
  /** Version slug → its workflow dynasty. */
  dynastyOf: (slug: string) => string;
  workflowLabelOf: (dynasty: string) => string;
  workflowNameOf: (dynasty: string) => string | null;
  templateDynasties?: TemplateDynastyIndex;
  llmDynasties?: LlmDynastyIndex;
  /** Concrete model id → its display name (chat-service); a model chat-service places in no dynasty keys on it. */
  modelLabel: (id: string) => string;
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
  unpricedBilledUsd: number;
  now: Date;
}

const SEP = "\u001f";
const NONE = "-";

const figure = (value: number, basis: "measured" | "expected", source: PerformanceFigure["source"], display: (v: number) => string): PerformanceFigure => ({
  value,
  display: display(value),
  basis,
  source,
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

/** PURE. One pipe's Performance tab. */
export function pipePerformance(p: PipePerformanceInput): PipePerformance {
  const empty = (reason: PipePerformance["unavailableReason"]): PipePerformance => ({
    pipe: p.pipe,
    figuresBasis: "since_inception",
    outcomeNoun: p.noun,
    outcomeNounPlural: p.nounPlural,
    rows: [],
    totals: null,
    series: null,
    unpricedBilledUsd: p.unpricedBilledUsd,
    unavailableReason: reason,
  });
  if (!p.persons.some((b) => b.generation)) return empty("no_writer_recorded_on_pipe");
  const dyn = p.templateDynasties ?? NO_TEMPLATE_DYNASTIES;
  const llmDyn = p.llmDynasties ?? NO_LLM_DYNASTIES;
  const groupOf = (b: FleetPersonBucket) => {
    const tpl = b.generation?.promptType ? dyn.versionOf(b.generation.promptType) : NONE;
    const llm = b.generation ? p.llmKeyOf(b.generation.model) : NONE;
    return `${tpl}${SEP}${llm}`;
  };
  // Every person on a row (a person not on record = the null-writer row), and a version with spend but no person
  // bucket kept whole on its own null-writer row: the rows partition the pipe.
  const split = splitCellsByGroup(p.cells, p.persons, p.split, groupOf);
  const withPersons = new Set(p.persons.map((b) => b.workflowSlug));
  const cells: SlugCell[] = [...split.cells, ...p.cells.filter((c) => !withPersons.has(c.slug)).map((c) => ({ ...c, slug: `${c.slug}\t${NONE}${SEP}${NONE}` }))];

  // Each workflow dynasty's whole (spend, outcomes) the return terms are shared on.
  const dynTotals = new Map<string, { spentUsd: number; outcomes: number }>();
  for (const c of p.cells) {
    const d = p.dynastyOf(c.slug);
    const t = dynTotals.get(d) ?? { spentUsd: 0, outcomes: 0 };
    t.spentUsd += c.flash.figures.spentUsd;
    t.outcomes += c.flash.figures.outcomes;
    dynTotals.set(d, t);
  }
  const pipelinePerOutcome = (d: string) => {
    const pl = p.workflowReturns?.pipelineOf.get(d);
    const t = dynTotals.get(d);
    return pl == null || p.workflowReturns?.billedOf.get(d) == null || !t || !(t.outcomes > 0) ? 0 : pl / t.outcomes;
  };
  const billedPerSpent = (d: string) => {
    const b = p.workflowReturns?.billedOf.get(d);
    const t = dynTotals.get(d);
    return b == null || p.workflowReturns?.pipelineOf.get(d) == null || !t || !(t.spentUsd > 0) ? 0 : b / t.spentUsd;
  };

  // Combination → its split cells.
  const byCombo = new Map<string, { dynasty: string; tpl: string; llm: string; cells: SlugCell[] }>();
  for (const c of cells) {
    const tab = c.slug.indexOf("\t");
    const version = c.slug.slice(0, tab);
    const [tpl = NONE, llm = NONE] = c.slug.slice(tab + 1).split(SEP);
    const dynasty = p.dynastyOf(version);
    const key = `${dynasty}|${tpl}|${llm}`;
    const e = byCombo.get(key) ?? { dynasty, tpl, llm, cells: [] };
    e.cells.push(c);
    byCombo.set(key, e);
  }

  const outcomesRequired = legMaturity(p.legKey).outcomesRequired;
  const lastMonth = p.now.toISOString().slice(0, 7);
  const monthly = new Map<string, Acc>();
  const rows: Array<Omit<PerformanceRow, "rank" | "roi" | "costPerOutcomeUsd" | "conversionRatePct"> & { acc: Acc }> = [];
  for (const [key, e] of byCombo) {
    const b = bucketOf({ key, label: key, legKey: p.legKey, cells: e.cells, forceBasis: "flash" });
    const ppo = pipelinePerOutcome(e.dynasty);
    const bps = billedPerSpent(e.dynasty);
    const acc: Acc = { ...b.figures, pipelineUsd: b.figures.outcomes * ppo, billedUsd: b.figures.spentUsd * bps };
    // Dated by month (scaled onto the row, `bucketOf`); a row with no dated evidence lands whole on the last month.
    const months = b.months ?? [{ month: lastMonth, ...b.figures }];
    for (const m of months) {
      // a run dated after this month (never expected) counts on this month, never off the series
      const ym = m.month > lastMonth ? lastMonth : m.month;
      const t = monthly.get(ym) ?? zero();
      addInto(t, { spentUsd: m.spentUsd, contacted: m.contacted, outcomes: m.outcomes, pipelineUsd: m.outcomes * ppo, billedUsd: m.spentUsd * bps });
      monthly.set(ym, t);
    }
    const matureCut = e.cells.every((c) => c.mature !== null);
    const matureOutcomes = matureCut ? e.cells.reduce((s, c) => s + c.mature!.figures.outcomes, 0) : null;
    const isMature = isMatureCount(matureOutcomes, p.legKey) === true;
    const dynOfVersion = e.tpl === NONE ? null : dyn.dynastyOfVersion(e.tpl);
    const llmDynasty = e.llm === NONE ? null : llmDyn.bySlug(e.llm);
    rows.push({
      key,
      workflow: { key: e.dynasty, label: p.workflowLabelOf(e.dynasty), name: p.workflowNameOf(e.dynasty) },
      template: e.tpl === NONE ? null : { key: e.tpl, label: templateLabel(e.tpl), dynasty: dynOfVersion ? { key: dynOfVersion.slug, label: dynOfVersion.name } : null },
      llm: e.llm === NONE ? null : { key: e.llm, label: p.llmLabelOf(e.llm), provider: llmDynasty?.provider || null },
      writerUnavailableReason: e.tpl === NONE && e.llm === NONE ? "not_on_record" : null,
      maturity: { isMature, matureOutcomes, outcomesRequired },
      learning: !isMature,
      outcomes: count(acc.outcomes, (v) => n(Math.round(v))),
      spentUsd: count(acc.spentUsd, usd),
      contacted: count(acc.contacted, (v) => n(Math.round(v))),
      acc,
    });
  }

  // The series: every month from the first to this one, cumulative; its last point IS the totals (the cards).
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

  // Expected figures: every combination pooled (= the pipe), else the money workflow's return.
  const w = p.workflowReturns;
  const moneyRoi = (() => {
    if (!w) return null;
    const money = w.moneyGoesHere ? w.roiOf.get(w.moneyGoesHere) : null;
    if (money != null && money > 0) return money;
    return [...w.roiOf.values()].filter((v): v is number => v != null && v > 0).sort((a, b) => b - a)[0] ?? null;
  })();
  const pooledRoi = cum.billedUsd > 0 && printed(cum.outcomes) ? cum.pipelineUsd / cum.billedUsd : null;
  const expectedRoi = (): PerformanceFigure =>
    pooledRoi != null && pooledRoi > 0
      ? figure(pooledRoi, "expected", "pipe_combinations", roiText)
      : moneyRoi != null
        ? figure(moneyRoi, "expected", "pipe_best_workflow", roiText)
        : missing("no_return_on_pipe");
  const pooledCost = printed(cum.outcomes) && cum.spentUsd > 0 ? cum.spentUsd / cum.outcomes : null;
  const pooledRate = cum.contacted > 0 ? (100 * cum.outcomes) / cum.contacted : null;
  const figuresOf = (a: Acc, isMature: boolean, own: "row" | "pipe"): Pick<PerformanceFigures, "roi" | "costPerOutcomeUsd" | "conversionRatePct"> => {
    const measured = printed(a.outcomes);
    // The pipe's own return is the pooled one; with no outcome yet it expects the money workflow's.
    const roi =
      measured && a.billedUsd > 0
        ? figure(a.pipelineUsd / a.billedUsd, "measured", "own", roiText)
        : own === "row"
          ? expectedRoi()
          : moneyRoi != null
            ? figure(moneyRoi, "expected", "pipe_best_workflow", roiText)
            : missing("no_return_on_pipe");
    const cost =
      measured && a.spentUsd > 0
        ? figure(a.spentUsd / a.outcomes, "measured", "own", usd)
        : own === "row" && pooledCost != null
          ? figure(pooledCost, "expected", "pipe_combinations", usd)
          : missing("no_outcome_on_pipe");
    const rate =
      a.contacted > 0 && (measured || isMature)
        ? figure((100 * a.outcomes) / a.contacted, "measured", "own", pctText)
        : own === "row" && pooledRate != null
          ? figure(pooledRate, "expected", "pipe_combinations", pctText)
          : missing("nobody_emailed_on_pipe");
    return { roi, costPerOutcomeUsd: cost, conversionRatePct: rate };
  };

  const ranked = rows
    .map((r) => ({ ...r, ...figuresOf(r.acc, r.maturity.isMature, "row") }))
    .sort((a, b) => {
      const am = a.roi.basis === "measured";
      const bm = b.roi.basis === "measured";
      if (am !== bm) return am ? -1 : 1;
      if (am && bm && a.roi.value !== b.roi.value) return b.roi.value! - a.roi.value!;
      if (a.outcomes.value !== b.outcomes.value) return b.outcomes.value - a.outcomes.value;
      if (a.contacted.value !== b.contacted.value) return b.contacted.value - a.contacted.value;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    })
    .map(({ acc: _acc, ...r }, i) => ({ ...r, rank: i + 1 }));

  const pipeMatureCut = p.cells.every((c) => c.mature !== null);
  const pipeMature = isMatureCount(pipeMatureCut ? p.cells.reduce((s, c) => s + c.mature!.figures.outcomes, 0) : null, p.legKey) === true;
  const totals: PerformanceFigures = {
    ...figuresOf(cum, pipeMature, "pipe"),
    outcomes: count(cum.outcomes, (v) => n(Math.round(v))),
    spentUsd: count(cum.spentUsd, usd),
    contacted: count(cum.contacted, (v) => n(Math.round(v))),
  };
  return {
    pipe: p.pipe,
    figuresBasis: "since_inception",
    outcomeNoun: p.noun,
    outcomeNounPlural: p.nounPlural,
    rows: ranked,
    totals,
    series: { grain: "month", points },
    unpricedBilledUsd: p.unpricedBilledUsd,
    unavailableReason: null,
  };
}

