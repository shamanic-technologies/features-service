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

/** A per-slug cost group as runs-service states it (`groupBy=workflowSlug`). */
export interface SlugCostGroup {
  dimensions: Record<string, string | null>;
  totalCostInUsdCents: string;
  runCount?: number | null;
}

/**
 * PURE. A leg's per-SLUG evidence rolled up to workflow DYNASTIES, keyed on each version's OWN
 * `workflowDynastySlug` (workflow-service's field). Spend summed EXACTLY (no per-slug rounding).
 *
 * Every version counts, whatever its status: a dynasty whose every version is deprecated still spent and
 * still earned on the leg, and states it on the same basis as every other dynasty (LEG-SPEND-MISSING-1016:
 * the old roll-up seeded dynasties from ACTIVE versions only, so lithium's $2.2k and 21 positive replies on
 * the conversation leg read 0). Which dynasty may RUN is the reader's question (`executableDynasties`),
 * never a filter on the evidence.
 *
 * A dynasty is present when one of its versions has a cost group (runs-service emits a group only for runs
 * holding a cost row); its outcomes are those of every one of its versions. A cost group whose slug no
 * workflow states is returned in `unmapped` (the caller logs it): never silently dropped.
 */
export function rollUpLegEvidenceByDynasty(
  workflows: ReadonlyArray<{ workflowSlug: string; workflowDynastySlug: string }>,
  costGroups: readonly SlugCostGroup[],
  emailStats: ReadonlyMap<string, Record<string, number>>,
): { byDynasty: Map<string, DynastyLegEvidence>; unmapped: Array<{ workflowSlug: string; spentCents: number }> } {
  const dynastyOf = new Map(workflows.map((w) => [w.workflowSlug, w.workflowDynastySlug]));
  const byDynasty = new Map<string, DynastyLegEvidence>();
  const unmapped: Array<{ workflowSlug: string; spentCents: number }> = [];
  for (const g of costGroups) {
    const slug = g.dimensions.workflowSlug;
    if (!slug || slug === "__total__") continue;
    const cents = Number(g.totalCostInUsdCents);
    const dynasty = dynastyOf.get(slug);
    if (!dynasty) {
      unmapped.push({ workflowSlug: slug, spentCents: cents });
      continue;
    }
    if (Number(g.runCount ?? 1) <= 0) continue;
    const prev = byDynasty.get(dynasty) ?? { spentCents: 0, contacted: 0, clicks: 0, replies: 0 };
    byDynasty.set(dynasty, { ...prev, spentCents: prev.spentCents + cents });
  }
  for (const [slug, o] of emailStats) {
    const dynasty = dynastyOf.get(slug);
    const prev = dynasty ? byDynasty.get(dynasty) : undefined;
    if (!dynasty || !prev) continue;
    byDynasty.set(dynasty, {
      spentCents: prev.spentCents,
      contacted: prev.contacted + (o.recipientsContacted ?? 0),
      clicks: prev.clicks + (o.recipientsClicked ?? 0),
      replies: prev.replies + (o.recipientsRepliesPositive ?? 0),
    });
  }
  return { byDynasty, unmapped };
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
