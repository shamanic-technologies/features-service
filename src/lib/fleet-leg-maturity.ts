/**
 * ONE LEG'S FLEET FIGURES PER WORKFLOW, ON BOTH VERSIONS, AND THE BENCHMARK TAKEN OVER MATURE WORKFLOWS
 * ONLY (`lib/maturity.ts`, features-service#1196).
 *
 * The public per-workflow read (`/public/stats/workflow-cost-per-outcome`) answers for a WORKFLOW across
 * every org. Its maturity is the workflow's figure on ONE leg of the channel — every org's campaigns
 * performing that leg, never the whole channel (a workflow's figure is its figure on one leg × one
 * channel) — on the SAME evidence workflow-projection's crossOrg grain reads for that leg:
 *
 *   - FLASH: the leg campaigns' whole-history spend (runs) over their sends (email-gateway), the positive
 *     replies counted on PEOPLE (the fleet person cell), exactly as the crossOrg grain counts them.
 *   - MATURE: the spend of runs STARTED before the leg's cutoff over the outcomes — whenever they landed —
 *     of the leads those runs SERVED (`fetchLegFleetMatureEvidence`). Null when the cut cannot be made.
 *   - `isMature`: the workflow's MATURE outcomes against the leg's count.
 *
 * THE BENCHMARK IS TAKEN OVER MATURE WORKFLOWS ONLY (owner decision): a workflow still inside its first
 * three weeks prices its young spend with none of that spend's outcomes, so its figure is noise in a
 * median and a lucky early read in a minimum. `best` and `median` read the MATURE figure of the workflows
 * whose `isMature` is true, and `matureWorkflowCount` says how many that was.
 *
 * Pure: the route reads the evidence and rolls it up to dynasties; this states it.
 */
import { legMaturity, legMaturityFigures, outcomeFigures, type LegMaturityFigures, type OutcomeFigures } from "./maturity.js";

/** One dynasty's evidence on one leg, on one version. Cents are exact (never rounded per slug). */
export interface DynastyLegEvidence {
  spentCents: number;
  contacted: number;
  clicks: number;
  replies: number;
}

/** The figures of one dynasty on one version: the leg's own outcome is its counted signal. */
export function legFiguresOf(legKey: string, ev: DynastyLegEvidence | undefined): OutcomeFigures {
  const signal = legMaturity(legKey).outcomeSignal;
  const outcomes = !ev ? 0 : signal === "positiveReply" ? ev.replies : signal === "clicked" ? ev.clicks : 0;
  return outcomeFigures((ev?.spentCents ?? 0) / 100, ev?.contacted ?? 0, outcomes);
}

/**
 * PURE. Every dynasty's leg figures on both versions. `dynasties` lists the rows the read serves — a
 * dynasty with no evidence on the leg reads zeros (a measured absence: it has done nothing on this leg),
 * never a borrowed figure. `mature` null = the cut could not be made → every mature half and verdict null.
 */
export function buildFleetLegMaturity(
  legKey: string,
  dynasties: readonly string[],
  flash: ReadonlyMap<string, DynastyLegEvidence>,
  mature: ReadonlyMap<string, DynastyLegEvidence> | null,
): Map<string, LegMaturityFigures> {
  const out = new Map<string, LegMaturityFigures>();
  for (const dynasty of dynasties) {
    out.set(
      dynasty,
      legMaturityFigures(legKey, legFiguresOf(legKey, flash.get(dynasty)), mature ? legFiguresOf(legKey, mature.get(dynasty)) : null),
    );
  }
  return out;
}

/** The fleet's benchmark on one leg, over MATURE workflows only. */
export interface FleetMatureBenchmark {
  legKey: string;
  /** Always `mature`: the figures below are mature figures of mature workflows. */
  basis: "mature";
  /** How many workflows were mature on the leg (their mature outcomes ≥ the leg's count). */
  matureWorkflowCount: number;
  /** The mature workflow with the lowest MATURE cost per outcome. Null when no workflow is mature. */
  best: { workflowDynastySlug: string; costPerOutcomeUsd: number } | null;
  /** The median MATURE cost per outcome across the mature workflows. Null when none is mature. */
  median: { costPerOutcomeUsd: number } | null;
}

/** Linear-interpolated median of a NON-EMPTY ascending array (the same rule the fleet return medians use). */
function medianOf(sorted: readonly number[]): number {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) / 2;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * PURE. The benchmark over the MATURE workflows of `byDynasty`: `best` = lowest mature cost per outcome
 * (the slug breaks a tie, so the same evidence always names the same workflow), `median` over them.
 */
export function buildFleetMatureBenchmark(
  legKey: string,
  byDynasty: ReadonlyMap<string, LegMaturityFigures>,
): FleetMatureBenchmark {
  const mature = [...byDynasty]
    .filter(([, f]) => f.isMature === true && f.mature?.costPerOutcomeUsd != null)
    .map(([slug, f]) => ({ slug, cost: f.mature!.costPerOutcomeUsd! }))
    .sort((a, b) => (a.cost !== b.cost ? a.cost - b.cost : a.slug < b.slug ? -1 : 1));
  return {
    legKey,
    basis: "mature",
    matureWorkflowCount: mature.length,
    best: mature[0] ? { workflowDynastySlug: mature[0].slug, costPerOutcomeUsd: mature[0].cost } : null,
    median: mature.length > 0 ? { costPerOutcomeUsd: medianOf(mature.map((m) => m.cost)) } : null,
  };
}
