/**
 * ONE SET OF FIGURES PER WORKFLOW OF A PIPE (RESEARCH-WF-FIGURES-1022, owner 2026-10-22: "two figures that cannot both be
 * true are a BUG"; "a ROI and a % Conversion are never blank: where the measured one is Learning, serve the EXPECTED
 * one, marked expected"). Served on every row of `/public/stats/leg-workflow-ranking` as `figures`, and copied verbatim
 * onto the Research catalogue's workflow pages, so the Workflows list and the workflow page print the same four numbers.
 *
 * Measured vs expected, per figure:
 *   - ROI (lifetime pipeline ÷ what clients were billed, net): MEASURED only once the workflow has an outcome of its own
 *     on the leg (flash count ≥ 1). A workflow with 0 outcomes never reads a measured return: its pipeline is only the
 *     value of people it contacted, which read as a 30x on Keel's $37 and 0 positive replies.
 *   - $ per outcome: measured once the row's half (mature or flash, `basis`) holds an outcome; else expected.
 *   - % conversion: measured once the half holds an outcome or the workflow is MATURE (a mature 0% is a fact); else
 *     expected (a learning 0% is not yet a fact).
 *   - $ spent: always measured (zero is true).
 * EXPECTED = the pipe POOLED over every workflow on the leg (Σ pipeline ÷ Σ billed; Σ spend ÷ Σ outcomes; Σ outcomes ÷
 * Σ contacted, lifetime), the template pages' rule (`pipe_templates`): borrowing the best workflow's figure put an
 * expected return above every workflow that earned one. An expected ROI is never 0: a pooled 0 falls to the money
 * workflow's return; an expected conversion with no outcome on the pipe falls to the leg's seeded default. Every figure
 * also carries `expectedValue` (the pooled figure) beside a measured one.
 *
 * Pure.
 */
import type { LegMaturityFigures, OutcomeFigures } from "./maturity.js";

export type FigurePricing = "gross" | "net";

export interface WorkflowFigure {
  value: number | null;
  basis: "measured" | "expected" | null;
  /** measured: `workflow`. expected: `pipe_pooled`, `pipe_best_workflow` (ROI only), `leg_default` (conversion only). */
  source: "workflow" | "pipe_pooled" | "pipe_best_workflow" | "leg_default" | null;
  /** What the pipe expects of a workflow (the pooled figure, or its fallback), served beside a measured value too. */
  expectedValue: number | null;
  unavailableReason: "no_return_on_pipe" | "no_outcome_on_pipe" | "no_conversion_on_pipe" | "net_not_measured_on_pipe" | null;
}

export interface LegWorkflowFigures {
  pricing: FigurePricing;
  /** The half `costPerOutcomeUsd`, `conversionRatePct`, `spentUsd` are read on (the row's `basis`). ROI is lifetime. */
  half: "mature" | "flash";
  roi: WorkflowFigure;
  costPerOutcomeUsd: WorkflowFigure;
  conversionRatePct: WorkflowFigure;
  spentUsd: { value: number | null; basis: "measured" | null; unavailableReason: "net_not_measured_on_pipe" | null };
  outcomes: number;
  contacted: number;
}

export interface FigureRowInput {
  slug: string;
  /** The row's half on the GROSS ranking (the order's basis): the net figures read the same half. */
  mature: boolean;
  isMature: boolean | null;
  /** The ranking's figures (counts, and the gross money). */
  figures: LegMaturityFigures;
  /** The spend on THIS pricing, per half (gross = `figures`); null = not measured on it (net on an internal / on-demand pipe). */
  spend: { flash: number; mature: number | null } | null;
  pipelineUsd: number | null;
  billedSpendUsd: number | null;
  moneyGoesHere: boolean;
}

export interface PipePool {
  roi: number | null;
  costPerOutcomeUsd: number | null;
  conversionRatePct: number | null;
}

const EMPTY: OutcomeFigures = { spentUsd: 0, contacted: 0, outcomes: 0, costPerOutcomeUsd: null, conversionRatePct: null };
const hasOutcome = (n: number) => Math.round(n) >= 1;
const roiOf = (r: Pick<FigureRowInput, "pipelineUsd" | "billedSpendUsd">) =>
  r.pipelineUsd != null && r.billedSpendUsd != null && r.billedSpendUsd > 0 ? r.pipelineUsd / r.billedSpendUsd : null;

/** PURE. The pipe pooled over every workflow on the leg (lifetime), with the fallbacks that keep ROI and conversion set. */
export function pipePool(rows: readonly FigureRowInput[], defaultConversionPct: number | null): PipePool {
  let pipeline = 0;
  let billed = 0;
  let spend = 0;
  let outcomes = 0;
  let contacted = 0;
  for (const r of rows) {
    if (r.pipelineUsd != null && r.billedSpendUsd != null && r.billedSpendUsd > 0) {
      pipeline += r.pipelineUsd;
      billed += r.billedSpendUsd;
    }
    const f = r.figures.flash ?? EMPTY;
    if (r.spend) spend += Math.max(0, r.spend.flash);
    outcomes += f.outcomes;
    contacted += f.contacted;
  }
  const pooledRoi = billed > 0 ? pipeline / billed : null;
  const money = rows.find((r) => r.moneyGoesHere);
  const moneyRoi = money ? roiOf(money) : null;
  const roi = pooledRoi != null && pooledRoi > 0 ? pooledRoi : moneyRoi != null && moneyRoi > 0 ? moneyRoi : null;
  return {
    roi,
    costPerOutcomeUsd: outcomes > 0 && spend > 0 ? spend / outcomes : null,
    conversionRatePct: outcomes > 0 && contacted > 0 ? (100 * outcomes) / contacted : defaultConversionPct,
  };
}

/** Which fallback the pool's ROI / conversion came from (for `source`). */
function poolSources(rows: readonly FigureRowInput[]): { roi: WorkflowFigure["source"]; conversion: WorkflowFigure["source"] } {
  let billed = 0;
  let pipeline = 0;
  let outcomes = 0;
  for (const r of rows) {
    if (r.pipelineUsd != null && r.billedSpendUsd != null && r.billedSpendUsd > 0) {
      pipeline += r.pipelineUsd;
      billed += r.billedSpendUsd;
    }
    outcomes += r.figures.flash?.outcomes ?? 0;
  }
  return { roi: billed > 0 && pipeline > 0 ? "pipe_pooled" : "pipe_best_workflow", conversion: outcomes > 0 ? "pipe_pooled" : "leg_default" };
}

const expected = (value: number | null, source: WorkflowFigure["source"], reason: WorkflowFigure["unavailableReason"]): WorkflowFigure =>
  value != null ? { value, basis: "expected", source, expectedValue: value, unavailableReason: null } : { value: null, basis: null, source: null, expectedValue: null, unavailableReason: reason };
const measured = (value: number, expectedValue: number | null): WorkflowFigure => ({ value, basis: "measured", source: "workflow", expectedValue, unavailableReason: null });

/** PURE. Every row's figures on one pricing. `rows` = every workflow listed on the pipe (the pool's population). */
export function legWorkflowFigures(rows: readonly FigureRowInput[], pricing: FigurePricing, defaultConversionPct: number | null): Map<string, LegWorkflowFigures> {
  // The pool's cost per outcome is taken only over rows whose spend is measured on this pricing.
  const pool = pipePool(rows, defaultConversionPct);
  const moneyMeasured = rows.some((r) => r.spend != null);
  const src = poolSources(rows);
  const out = new Map<string, LegWorkflowFigures>();
  for (const r of rows) {
    const f = r.figures;
    const half = (r.mature ? f.mature : f.flash) ?? EMPTY;
    const flashOutcomes = f.flash?.outcomes ?? 0;
    const roi = roiOf(r);
    const spent = r.spend ? (r.mature ? r.spend.mature : r.spend.flash) : null;
    const notMeasured = spent == null;
    const cost = !notMeasured && hasOutcome(half.outcomes) && spent > 0 ? spent / half.outcomes : null;
    out.set(r.slug, {
      pricing,
      half: r.mature ? "mature" : "flash",
      roi: hasOutcome(flashOutcomes) && roi != null ? measured(roi, pool.roi) : expected(pool.roi, src.roi, "no_return_on_pipe"),
      costPerOutcomeUsd: notMeasured
        ? { value: null, basis: null, source: null, expectedValue: null, unavailableReason: "net_not_measured_on_pipe" }
        : cost != null
          ? measured(cost, moneyMeasured ? pool.costPerOutcomeUsd : null)
          : expected(pool.costPerOutcomeUsd, "pipe_pooled", "no_outcome_on_pipe"),
      conversionRatePct:
        (hasOutcome(half.outcomes) || r.isMature === true) && half.conversionRatePct != null
          ? measured(half.conversionRatePct, pool.conversionRatePct)
          : expected(pool.conversionRatePct, src.conversion, "no_conversion_on_pipe"),
      spentUsd: notMeasured ? { value: null, basis: null, unavailableReason: "net_not_measured_on_pipe" } : { value: spent, basis: "measured", unavailableReason: null },
      outcomes: half.outcomes,
      contacted: half.contacted,
    });
  }
  return out;
}
