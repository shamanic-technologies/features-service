/**
 * WHAT ONE WORKFLOW HAS COST, EARNED AND RETURNED ACROSS THE WHOLE FLEET, DAY BY DAY — the dated
 * history behind the cross-org per-workflow figure (`/public/stats/workflow-cost-per-outcome`), for
 * the workflow page's three charts (cost to run it, value generated, return on spend).
 *
 * At brand grain a workflow's history is nearly empty (most workflows ran for one brand on a couple
 * of days), so a brand-scoped curve draws nothing. The fleet is the grain where a workflow HAS a
 * history, and it is the grain the page's "Global" column already speaks.
 *
 * ── ONE DYNASTY, NEVER A BLEND ──────────────────────────────────────────────────────────────────
 *
 * A workflow is a DYNASTY (its identity across versions), exactly as on every other surface here.
 * One series per dynasty; nothing is pooled across workflows.
 *
 * ── THE TWO LEGS, AND WHERE EACH COMES FROM ─────────────────────────────────────────────────────
 *
 *   - VALUE: the SAME pipeline definition the per-brand revenue engine uses — for every (org, brand)
 *     that ran the feature, the engine's own dated, cumulative pipeline for this dynasty (the series
 *     `/revenue?groupBy=workflow` prices, `WorkflowRevenueGroup.pipelineTimeSeries`), priced on that
 *     pair's own declared funnels and economics. Summed across pairs as daily INCREMENTS: a lead
 *     belongs to exactly one org, so the pairs are disjoint and the sum counts nobody twice.
 *   - SPEND: runs-service's dated spend for the dynasty across every org — BILLED (what clients were
 *     charged, net of their discount) on the customer read, VENDOR (what it really cost us) on the
 *     staff read. Read straight from the producer's dated ledger for the dynasty, never summed from
 *     the per-pair passes, so it is the same row set as the untimed cross-org total and its last
 *     cumulative point IS that total (runs' own sum-equals-untimed-total invariant).
 *
 * ── NO ORG IS NAMED ─────────────────────────────────────────────────────────────────────────────
 *
 * The output is an aggregate: dates and dollars. Which orgs contributed never reaches the wire; only
 * how many pairs were priced and how many could not be (`valueCoverage`), so a reader can see when
 * the value leg is a partial sum.
 */

import type { TimeSeriesPoint } from "./revenue-engine.js";

/** One (org, brand)'s dated pipeline for one dynasty. */
export interface PairDynastyPipeline {
  workflowDynastySlug: string;
  /** The engine's cumulative pipeline series for this dynasty at this pair. */
  pipelineTimeSeries: TimeSeriesPoint[];
  /** The pair's headline pipeline for the dynasty. Null = could not be priced (no economics / funnel). */
  totalPipelineUsd: number | null;
}

/** One dynasty's value leg, summed across every pair that ran it. */
export interface FleetDynastyPipeline {
  /** Cumulative across the fleet, one point per UTC day with a new dated outcome. */
  pipelineTimeSeries: TimeSeriesPoint[];
  /** Sum of the pairs' non-null headline pipelines. Null iff no pair could price the dynasty. */
  totalPipelineUsd: number | null;
}

/**
 * PURE: fold every pair's per-dynasty pipeline into one fleet series per dynasty. Each pair's
 * cumulative series becomes daily increments (a day keeps its LAST, highest point, as `buildRoiHistory`
 * does), the increments are summed across pairs per day, and re-accumulated.
 */
export function foldFleetPipelines(pairs: PairDynastyPipeline[][]): Map<string, FleetDynastyPipeline> {
  const deltas = new Map<string, Map<string, number>>();
  const totals = new Map<string, number | null>();
  for (const pair of pairs) {
    for (const g of pair) {
      const byDay = deltas.get(g.workflowDynastySlug) ?? new Map<string, number>();
      deltas.set(g.workflowDynastySlug, byDay);
      const dayLast = new Map<string, number>();
      for (const p of g.pipelineTimeSeries) {
        const day = p.date.slice(0, 10);
        const prev = dayLast.get(day);
        if (prev == null || p.cumulativePipelineUsd > prev) dayLast.set(day, p.cumulativePipelineUsd);
      }
      let previous = 0;
      for (const day of [...dayLast.keys()].sort()) {
        const value = dayLast.get(day)!;
        const delta = value - previous;
        previous = value;
        if (delta !== 0) byDay.set(day, (byDay.get(day) ?? 0) + delta);
      }
      const prevTotal = totals.get(g.workflowDynastySlug);
      if (g.totalPipelineUsd !== null) totals.set(g.workflowDynastySlug, (prevTotal ?? 0) + g.totalPipelineUsd);
      else if (!totals.has(g.workflowDynastySlug)) totals.set(g.workflowDynastySlug, null);
    }
  }
  const out = new Map<string, FleetDynastyPipeline>();
  for (const [dynasty, byDay] of deltas) {
    let cumulative = 0;
    const pipelineTimeSeries: TimeSeriesPoint[] = [...byDay.keys()].sort().map((date) => {
      cumulative += byDay.get(date)!;
      return { date, cumulativePipelineUsd: cumulative };
    });
    out.set(dynasty, { pipelineTimeSeries, totalPipelineUsd: totals.get(dynasty) ?? null });
  }
  return out;
}
