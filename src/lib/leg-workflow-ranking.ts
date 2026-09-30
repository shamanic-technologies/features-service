/**
 * EVERY WORKFLOW ON ONE LEG, RANKED AT THE FLEET GRAIN — `GET /public/stats/leg-workflow-ranking`.
 *
 * A research surface asks which workflow is best on a leg across every client we run it for. It names no
 * org, brand, offer, campaign or audience, so nothing it states depends on who is looking. The figures are
 * the byte-same per-workflow fleet leg figures `/public/stats/outcome-prices` picks its winner from
 * (`fetchFleetLegWorkflowMaturity`): flash + mature + the workflow's verdict on the leg.
 *
 * OWNER RULE (2026-09-30), the ORDER:
 *
 *   1. The BEST MATURE workflow is where the money goes: the cheapest MATURE cost per outcome among the
 *      selectable workflows mature on the leg.
 *   2. ABOVE it, the LEARNING workflows whose early (flash) cost per outcome is already CHEAPER than it,
 *      cheapest first. They are what is worth exploring: they beat the proven price on early evidence.
 *   3. BELOW it, the other mature workflows, cheapest first.
 *   4. Then the learning workflows that do not beat it, cheapest first; one with no outcome (no price) last.
 *   5. Then every workflow deprecated on the leg, in the same order among themselves. It keeps its history
 *      on screen but can never be put forward.
 *
 * With no mature workflow at all, every selectable one is ordered by its flash price. Ties break on the
 * dynasty slug, so the order is total and the same evidence always gives the same list.
 *
 * A workflow never put on the leg (`unassigned`) that has never spent on it is not listed: it is not a
 * workflow of this leg. One that has spent on it is listed, and cannot be put forward.
 *
 * A cost per outcome is observed: null at zero outcomes, never a spend floor. The return is lifetime on the
 * leg (the fleet's pipeline for the workflow ÷ what clients were billed for it), null when either is absent.
 *
 * Pure: the route reads the evidence; this orders it.
 */
import type { LegMaturityFigures, OutcomeFigures } from "./maturity.js";

export type LegWorkflowAssignment = "active" | "deprecated" | "unassigned";

export interface LegWorkflowRankingRow {
  /** 1-based, total, no gaps. */
  rank: number;
  workflowDynastySlug: string;
  workflowDynastyName: string | null;
  assignment: LegWorkflowAssignment;
  /** TRUE ⟺ `assignment === "active"`: the only state a run may pick. */
  selectable: boolean;
  /** The workflow's verdict on the fleet of the leg. Null when the mature cut could not be made. */
  isMature: boolean | null;
  /** Which half the figures below are read on: `mature` when the workflow is mature, else `flash`. */
  basis: "mature" | "flash";
  costPerOutcomeUsd: number | null;
  conversionRatePct: number | null;
  outcomes: number;
  contacted: number;
  spentUsd: number;
  /** Lifetime on the leg: pipeline ÷ billed spend. Null when either is absent. */
  roiMultiple: number | null;
  /** Rank 1 when it is selectable: the first workflow the fleet order puts forward. */
  goesFirst: boolean;
  /** The best mature workflow (rule 1). Exactly one row, or none when nothing selectable is mature. */
  moneyGoesHere: boolean;
}

export interface RankLegWorkflowsInput {
  byDynasty: ReadonlyMap<string, LegMaturityFigures>;
  names: ReadonlyMap<string, string | null>;
  /** Stored states only (`active` / `deprecated`); a dynasty absent here is `unassigned`. */
  assignments: ReadonlyMap<string, "active" | "deprecated">;
  /** Fleet pipeline (USD) per dynasty on the leg. Absent → unknown. */
  pipelineUsd: ReadonlyMap<string, number | null>;
  /** Billed spend (USD) per dynasty on the leg. Absent → unknown. */
  billedSpendUsd: ReadonlyMap<string, number>;
}

const EMPTY: OutcomeFigures = { spentUsd: 0, contacted: 0, outcomes: 0, costPerOutcomeUsd: null, conversionRatePct: null };

/** PURE. The ordered list (see the owner rule above). */
export function rankLegWorkflows(input: RankLegWorkflowsInput): LegWorkflowRankingRow[] {
  const rows: Omit<LegWorkflowRankingRow, "rank" | "goesFirst" | "moneyGoesHere">[] = [];
  for (const [slug, f] of input.byDynasty) {
    const assignment: LegWorkflowAssignment = input.assignments.get(slug) ?? "unassigned";
    const mature = f.isMature === true && f.mature != null;
    const half = (mature ? f.mature : f.flash) ?? EMPTY;
    if (assignment === "unassigned" && (f.flash?.spentUsd ?? 0) <= 0) continue;
    const pipeline = input.pipelineUsd.get(slug) ?? null;
    const billed = input.billedSpendUsd.get(slug) ?? null;
    rows.push({
      workflowDynastySlug: slug,
      workflowDynastyName: input.names.get(slug) ?? null,
      assignment,
      selectable: assignment === "active",
      isMature: f.isMature,
      basis: mature ? "mature" : "flash",
      costPerOutcomeUsd: half.costPerOutcomeUsd,
      conversionRatePct: half.conversionRatePct,
      outcomes: half.outcomes,
      contacted: half.contacted,
      spentUsd: half.spentUsd,
      roiMultiple: pipeline != null && billed != null && billed > 0 ? pipeline / billed : null,
    });
  }

  type Row = (typeof rows)[number];
  const byCost = (a: Row, b: Row) => {
    const ca = a.costPerOutcomeUsd;
    const cb = b.costPerOutcomeUsd;
    if (ca != null && cb != null && ca !== cb) return ca - cb;
    if (ca == null && cb != null) return 1;
    if (ca != null && cb == null) return -1;
    return a.workflowDynastySlug < b.workflowDynastySlug ? -1 : a.workflowDynastySlug > b.workflowDynastySlug ? 1 : 0;
  };
  const isMature = (r: Row) => r.basis === "mature" && r.costPerOutcomeUsd != null;

  const orderGroup = (group: Row[]): { ordered: Row[]; best: Row | null } => {
    const matures = group.filter(isMature).sort(byCost);
    const best = matures[0] ?? null;
    const learning = group.filter((r) => !isMature(r)).sort(byCost);
    if (!best) return { ordered: [...matures, ...learning], best: null };
    const bar = best.costPerOutcomeUsd!;
    const beating = learning.filter((r) => r.costPerOutcomeUsd != null && r.costPerOutcomeUsd < bar);
    const rest = learning.filter((r) => !beating.includes(r));
    return { ordered: [...beating, best, ...matures.slice(1), ...rest], best };
  };

  const selectable = orderGroup(rows.filter((r) => r.selectable));
  const excluded = orderGroup(rows.filter((r) => !r.selectable));
  return [...selectable.ordered, ...excluded.ordered].map((r, i) => ({
    ...r,
    rank: i + 1,
    goesFirst: i === 0 && r.selectable,
    moneyGoesHere: r === selectable.best,
  }));
}
