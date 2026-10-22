/**
 * EVERY WORKFLOW ON ONE LEG, RANKED AT THE FLEET GRAIN — `GET /public/stats/leg-workflow-ranking`.
 *
 * A research surface asks which workflow is best on a leg across every client we run it for. It names no
 * org, brand, offer, campaign or audience, so nothing it states depends on who is looking. The figures are
 * the byte-same per-workflow fleet leg figures `/public/stats/outcome-prices` picks its winner from
 * (`fetchFleetLegWorkflowMaturity`): flash + mature + the workflow's verdict on the leg.
 *
 * The ORDER is `orderLegWorkflows` (`lib/leg-workflow-order.ts`, owner rule 2026-09-30 / 2026-10-01): the ONE
 * computation the leg-keyed `workflow-projection` answers campaign-service with, here on the fleet evidence
 * alone. Learning workflows whose explore price (fleet spend ÷ max(outcomes, 1); $0 for one never run) is
 * below the best MATURE price go first, then the mature ones cheapest first (the first is where the money
 * goes), then the other learning ones; every workflow a run may not pick (deprecated, unassigned, or with no
 * version workflow-service can run) after, in the same order among themselves.
 *
 * A workflow never put on the leg (`unassigned`) that has never spent on it is not listed: it is not a
 * workflow of this leg. One that has spent on it is listed, and cannot be put forward. A workflow ASSIGNED to
 * the leg is listed even before its first run (owner 2026-10-10: a workflow created for a pipe is active on it
 * at once), with zero figures: a new pipe shows the workflow that will run it, never an empty list.
 *
 * A cost per outcome is observed: null at zero outcomes, never a spend floor. The return is lifetime on the
 * leg (the fleet's pipeline for the workflow ÷ what clients were billed for it), null when either is absent.
 *
 * Pure: the route reads the evidence; this orders it.
 */
import { bestMatureSlug, explorePriceUsd, legWorkflowPlaces, orderLegWorkflows, type LegWorkflowOrderEntry, type LegWorkflowPlace } from "./leg-workflow-order.js";
import { legMaturityFigures, type LegMaturityFigures, type OutcomeFigures } from "./maturity.js";
import { legWorkflowFigures, type FigureRowInput, type LegWorkflowFigures } from "./leg-workflow-figures.js";

export type LegWorkflowAssignment = "active" | "deprecated" | "unassigned";

export interface LegWorkflowRankingRow {
  /** 1-based, total, no gaps. */
  rank: number;
  workflowDynastySlug: string;
  workflowDynastyName: string | null;
  assignment: LegWorkflowAssignment;
  /** workflow-service runs a version of this dynasty (both status axes active on one version). */
  executable: boolean;
  /** TRUE ⟺ `assignment === "active"` AND `executable`: the only rows a run may pick. */
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
  /** The two terms of `roiMultiple`: the fleet pipeline (USD) and what clients were billed (USD) on the leg, lifetime. Null = unknown. */
  pipelineUsd: number | null;
  billedSpendUsd: number | null;
  /** Rank 1 when it is selectable: the first workflow the fleet order puts forward. */
  goesFirst: boolean;
  /** The best mature workflow (rule 1). Exactly one row, or none when nothing selectable is mature. */
  moneyGoesHere: boolean;
  /** The price the order reads for a LEARNING row: fleet spend on the leg ÷ max(outcomes, 1) ($0 never run). Null on a mature row. */
  explorePriceUsd: number | null;
  /** Why the row stands where it does (`LegWorkflowPlace`). */
  place: LegWorkflowPlace;
  /**
   * THE figures the Workflows list and the workflow page print (RESEARCH-WF-FIGURES-1022, `lib/leg-workflow-figures.ts`):
   * one ROI, $/outcome, % conversion and $ spent, each measured or expected, on the read's `pricing` (gross by default).
   */
  figures?: LegWorkflowFigures;
  /** When a run of this workflow last started on the pipe, any org (ISO). Null = never ran, or `lastRunUnavailableReason`. */
  lastRunAt?: string | null;
  lastRunUnavailableReason?: "not_read_on_pipe" | null;
  /** The tactics its current version follows (Jev's verdicts), set at serve time (`?` absent on a stored build). */
  tactics?: Array<{ id: string; name: string }> | null;
  tacticsUnavailableReason?: "tactics_unreadable" | null;
  /** The same on the NET pricing, held in the build; the route serves it as `figures` on `?pricing=net`, never both. */
  figuresNet?: LegWorkflowFigures;
}

export interface RankLegWorkflowsInput {
  byDynasty: ReadonlyMap<string, LegMaturityFigures>;
  names: ReadonlyMap<string, string | null>;
  /** Stored states only (`active` / `deprecated`); a dynasty absent here is `unassigned`. */
  assignments: ReadonlyMap<string, "active" | "deprecated">;
  /** Dynasties workflow-service can run (`executableDynasties`). Assigned active but absent here → not selectable. */
  executable: ReadonlySet<string>;
  /** Fleet pipeline (USD) per dynasty on the leg. Absent → unknown. */
  pipelineUsd: ReadonlyMap<string, number | null>;
  /** Billed spend (USD) per dynasty on the leg. Absent → unknown. */
  billedSpendUsd: ReadonlyMap<string, number>;
  /** NET spend per dynasty on the leg, per half (flash; mature null = not cut). Null/absent = not measured on the pipe. */
  netSpend?: ReadonlyMap<string, { flash: number; mature: number | null }> | null;
  /** Newest run start per dynasty on the pipe (fleet). Null/absent = not read on this pipe. */
  lastRunAt?: ReadonlyMap<string, string> | null;
  /** The leg's seeded conversion (%), the expected conversion of a pipe with no outcome yet. */
  defaultConversionPct?: number | null;
}

const EMPTY: OutcomeFigures = { spentUsd: 0, contacted: 0, outcomes: 0, costPerOutcomeUsd: null, conversionRatePct: null };

/** PURE. The ordered list (see the owner rule above). */
export function rankLegWorkflows(input: RankLegWorkflowsInput): LegWorkflowRankingRow[] {
  const rows: Omit<LegWorkflowRankingRow, "rank" | "goesFirst" | "moneyGoesHere" | "explorePriceUsd" | "place" | "figures" | "figuresNet" | "lastRunAt" | "lastRunUnavailableReason" | "tactics" | "tacticsUnavailableReason">[] = [];
  const figuresOf = new Map<string, LegMaturityFigures>();
  const byDynasty = new Map(input.byDynasty);
  for (const slug of input.assignments.keys()) {
    if (!byDynasty.has(slug)) byDynasty.set(slug, legMaturityFigures(null, EMPTY, null));
  }
  for (const [slug, f] of byDynasty) {
    const assignment: LegWorkflowAssignment = input.assignments.get(slug) ?? "unassigned";
    const mature = f.isMature === true && f.mature != null;
    const half = (mature ? f.mature : f.flash) ?? EMPTY;
    if (assignment === "unassigned" && (f.flash?.spentUsd ?? 0) <= 0) continue;
    figuresOf.set(slug, f);
    const pipeline = input.pipelineUsd.get(slug) ?? null;
    const billed = input.billedSpendUsd.get(slug) ?? null;
    rows.push({
      workflowDynastySlug: slug,
      workflowDynastyName: input.names.get(slug) ?? null,
      assignment,
      executable: input.executable.has(slug),
      selectable: assignment === "active" && input.executable.has(slug),
      isMature: f.isMature,
      basis: mature ? "mature" : "flash",
      costPerOutcomeUsd: half.costPerOutcomeUsd,
      conversionRatePct: half.conversionRatePct,
      outcomes: half.outcomes,
      contacted: half.contacted,
      spentUsd: half.spentUsd,
      roiMultiple: pipeline != null && billed != null && billed > 0 ? pipeline / billed : null,
      pipelineUsd: pipeline,
      billedSpendUsd: billed,
    });
  }

  // The ORDER is the shared leg order (`lib/leg-workflow-order.ts`), the byte-same computation the
  // leg-keyed `workflow-projection` answers campaign-service with: this read only hands it the fleet evidence.
  const entries: LegWorkflowOrderEntry[] = rows.map((r) => ({
    slug: r.workflowDynastySlug,
    selectable: r.selectable,
    mature: r.basis === "mature" && r.costPerOutcomeUsd != null && r.costPerOutcomeUsd > 0 ? { tier: 0, costPerOutcomeUsd: r.costPerOutcomeUsd } : null,
    fleet: { spentUsd: r.spentUsd, outcomes: r.outcomes },
  }));
  const bySlug = new Map(rows.map((r) => [r.workflowDynastySlug, r]));
  const best = bestMatureSlug(entries);
  const places = legWorkflowPlaces(entries);
  const entryOf = new Map(entries.map((e) => [e.slug, e]));
  const figureRows = (spendOf: (r: (typeof rows)[number]) => FigureRowInput["spend"]): FigureRowInput[] =>
    rows.map((r) => ({
      slug: r.workflowDynastySlug,
      mature: r.basis === "mature",
      isMature: r.isMature,
      figures: figuresOf.get(r.workflowDynastySlug)!,
      spend: spendOf(r),
      pipelineUsd: r.pipelineUsd,
      billedSpendUsd: r.billedSpendUsd,
      moneyGoesHere: r.workflowDynastySlug === best,
    }));
  const defaultConversion = input.defaultConversionPct ?? null;
  const gross = legWorkflowFigures(
    figureRows((r) => {
      const f = figuresOf.get(r.workflowDynastySlug)!;
      return { flash: f.flash?.spentUsd ?? 0, mature: f.mature ? f.mature.spentUsd : null };
    }),
    "gross",
    defaultConversion,
  );
  const netSpend = input.netSpend ?? null;
  const net = legWorkflowFigures(
    figureRows((r) => (netSpend ? (netSpend.get(r.workflowDynastySlug) ?? { flash: 0, mature: 0 }) : null)),
    "net",
    defaultConversion,
  );
  return orderLegWorkflows(entries).map((slug, i) => {
    const r = bySlug.get(slug)!;
    const e = entryOf.get(slug)!;
    return {
      ...r,
      rank: i + 1,
      goesFirst: i === 0 && r.selectable,
      moneyGoesHere: slug === best,
      explorePriceUsd: e.mature ? null : explorePriceUsd(e.fleet),
      place: places.get(slug)!,
      figures: gross.get(slug)!,
      figuresNet: net.get(slug)!,
      lastRunAt: input.lastRunAt ? (input.lastRunAt.get(slug) ?? null) : null,
      lastRunUnavailableReason: input.lastRunAt ? null : "not_read_on_pipe",
    };
  });
}
