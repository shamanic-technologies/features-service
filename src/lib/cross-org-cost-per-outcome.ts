/**
 * Cross-org cost-per-outcome — the shared vocabulary + math behind the three PLATFORM-WIDE
 * (all-org, no-auth) cost-per-outcome surfaces the staff admin analytics page reads:
 *
 *   1. `/public/stats/cost-projection`        — fleet-average cost per outcome for EVERY objective.
 *   2. `/public/stats/cost-per-outcome-trend` — dated moving-average series per objective.
 *   3. `/public/stats/workflow-cost-per-outcome` — per-workflow (dynasty) populated ratio per objective.
 *
 * All three key on the SAME objective set (the brand optimization-goal family) and the SAME
 * objective→cost mapping defined here, so the three surfaces never disagree on what a given
 * objective's cost-per-outcome means. The projected costs single-source through the funnel-registry's
 * `projectOutcomeCosts`; CPC / CPPR are the raw unit costs (the visit / positive-reply IS the outcome,
 * matching audience-stats' sort metric).
 */

import { GOALS, matchSingleStepGoal, matchFormSubmissionGoal, type Goal } from "./goals.js";
import {
  projectOutcomeCosts,
  type ProjectionEconomics,
  type ProjectionUnitCosts,
  type SalesEconomics,
} from "./funnel-registry.js";
import { fetchFeatureMemberships } from "./feature-memberships-client.js";
import { fetchEffectiveEconomics, BrandOwnershipError } from "./sales-economics-client.js";

/** The objective family the admin page charts, = the brand optimization-goal set. */
export const OBJECTIVES: readonly Goal[] = GOALS;

/**
 * Normalise an `objective` query param to a canonical camelCase Goal, accepting every fleet spelling
 * (camel `websiteVisit`, snake `website_visits`, kebab `website-visits`; `self-serve` aliases signup).
 * Returns null when `raw` is not a recognised objective (the caller 400s). Input tolerance, NOT a
 * missing-data fallback.
 */
export function normalizeObjective(raw: string | undefined): Goal | null {
  if (!raw) return null;
  const single = matchSingleStepGoal(raw);
  if (single) return single;
  if (matchFormSubmissionGoal(raw)) return "formSubmission";
  switch (raw) {
    case "signup":
    case "self-serve":
      return "signup";
    case "meetingBooked":
    case "meeting-booked":
    case "meeting_booked":
      return "meetingBooked";
    case "purchase":
      return "purchase";
    default:
      return null;
  }
}

/**
 * Build the full ProjectionEconomics (decimals) from a brand's SalesEconomics — LENIENT: every optional
 * rate maps only when the field is a finite number, else stays undefined so its objective's projected
 * cost is null (never a substituted zero). Used by the cross-org averages / trend / per-workflow
 * surfaces, which span ALL objectives at once and so cannot fail-loud on a single brand's missing rate
 * (a brand lacking one objective's economics simply contributes null to THAT objective's average).
 */
export function buildLenientProjectionEconomics(e: SalesEconomics): ProjectionEconomics {
  const dec = (v: number | undefined): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v / 100 : undefined;
  // Required rates fall back to 0 (not NaN) when a partial fixture omits one → the objective's
  // zero-denominator gate yields null, never a NaN that poisons an unrelated objective.
  const req = (v: number | undefined): number => dec(v) ?? 0;
  return {
    r2m: req(e.replyToMeetingPct),
    v2m: req(e.visitToMeetingPct),
    m2c: req(e.meetingToClosePct),
    v2c: req(e.visitToClosePct),
    v2s: req(e.visitToSignupPct),
    s2pc: dec(e.signupToPaidClientPct),
    v2pc: dec(e.visitToPaidClientPct),
    r2pc: dec(e.replyToPaidClientPct),
    v2fs: dec(e.visitToFormSubmissionPct),
    fs2pc: dec(e.formSubmissionToPaidClientPct),
  };
}

/**
 * The COUNT-LEVEL cost-per-outcome for one objective, given global unit costs + a brand's (or the
 * fleet-mean) economics. websiteVisit / positiveReply → the raw unit cost (the visit / reply IS the
 * outcome = CPC / CPPR); the other four project through the funnel. Null where the denominator rate is
 * absent / 0 (zero-denominator gate) — never a false $0.
 */
export function objectiveCostPerOutcome(
  goal: Goal,
  unitCosts: ProjectionUnitCosts,
  econ: ProjectionEconomics,
): number | null {
  if (goal === "websiteVisit") return unitCosts.clickUsd;
  if (goal === "positiveReply") return unitCosts.replyUsd;
  const p = projectOutcomeCosts(econ, unitCosts);
  switch (goal) {
    case "signup":
      return p.costPerSignupUsd;
    case "formSubmission":
      return p.costPerFormSubmissionUsd;
    case "meetingBooked":
      return p.costPerMeetingBookedUsd;
    case "purchase":
      return p.costPerPurchaseUsd;
    default:
      return null;
  }
}

/**
 * The engagement outcome that SIZES the trailing window for an objective's moving average: the
 * denominator whose ~N most-recent occurrences the window should span. Visit-driven objectives count
 * clicks; positiveReply counts replies; the multi-channel close goals count clicks + replies.
 */
export function windowBaseOutcome(goal: Goal, clicks: number, replies: number): number {
  switch (goal) {
    case "positiveReply":
      return replies;
    case "meetingBooked":
    case "purchase":
      return clicks + replies;
    default:
      return clicks; // websiteVisit / signup / formSubmission
  }
}

export const mean = (vals: number[]): number | null =>
  vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;

/**
 * Fetch the list of USABLE effective economics across every client brand of a feature (cross-org).
 * One economics fetch per DISTINCT brand (forwarding any owning org — the /orgs/* tier needs only
 * x-org-id). A brand whose membership is stale (BrandOwnershipError) or which has no economics yet
 * contributes nothing. Shared by all three cross-org cost surfaces so they agree on the brand set.
 */
export async function fetchFleetBrandEconomics(featureSlug: string): Promise<SalesEconomics[]> {
  const memberships = await fetchFeatureMemberships(featureSlug);
  const brandToOrg = new Map<string, string>();
  for (const m of memberships) {
    if (!brandToOrg.has(m.brandId)) brandToOrg.set(m.brandId, m.orgId);
  }

  const perBrand = await Promise.all(
    [...brandToOrg.entries()].map(async ([brandId, orgId]) => {
      try {
        const effective = await fetchEffectiveEconomics(brandId, { orgId, featureSlug });
        return effective.economics;
      } catch (error) {
        if (error instanceof BrandOwnershipError) {
          console.log(
            `[features-service] skipping stale feature membership for cross-org cost-per-outcome: featureSlug=${featureSlug}, orgId=${orgId}, brandId=${brandId}`,
          );
          return null;
        }
        throw error;
      }
    }),
  );

  return perBrand.filter((e): e is SalesEconomics => e != null);
}

/**
 * The fleet-mean economics across a set of brands — the SINGLE representative economics vector the
 * cross-org trend + per-workflow surfaces push global unit costs through (a fleet aggregate is one
 * number per objective, so it needs one economics). Each rate is the unweighted mean over the brands
 * that carry it; an optional rate no brand carries stays undefined (that objective → null downstream).
 * Returns null when the brand set is empty.
 */
export function meanFleetEconomics(list: SalesEconomics[]): ProjectionEconomics | null {
  if (list.length === 0) return null;
  const decs = list.map(buildLenientProjectionEconomics);
  const meanOf = (pick: (d: ProjectionEconomics) => number | undefined): number | undefined => {
    const vals = decs.map(pick).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
  };
  return {
    r2m: meanOf((d) => d.r2m) ?? 0,
    v2m: meanOf((d) => d.v2m) ?? 0,
    m2c: meanOf((d) => d.m2c) ?? 0,
    v2c: meanOf((d) => d.v2c) ?? 0,
    v2s: meanOf((d) => d.v2s) ?? 0,
    s2pc: meanOf((d) => d.s2pc),
    v2pc: meanOf((d) => d.v2pc),
    r2pc: meanOf((d) => d.r2pc),
    v2fs: meanOf((d) => d.v2fs),
    fs2pc: meanOf((d) => d.fs2pc),
  };
}

// ── Gap #1 — all-objective fleet averages ────────────────────────────────────

export type ObjectiveAverages = Record<Goal, number | null>;

/**
 * Fleet-average cost-per-outcome for EVERY objective: per brand, the BEST (lowest) cost across the
 * fleet's global per-workflow unit costs, then the unweighted mean across brands (null where no brand
 * is backed for that objective). Mirrors the legacy meeting/purchase methodology, one objective at a
 * time. brandCount = brands contributing ≥1 non-null objective.
 */
export function buildObjectiveAverages(
  unitCostList: ProjectionUnitCosts[],
  perBrandEconomics: SalesEconomics[],
): { objectives: ObjectiveAverages; brandCount: number } {
  const perObjectiveBrandBests: Record<Goal, number[]> = {
    websiteVisit: [], positiveReply: [], signup: [], formSubmission: [], meetingBooked: [], purchase: [],
  };
  let brandCount = 0;

  for (const economics of perBrandEconomics) {
    const econ = buildLenientProjectionEconomics(economics);
    let contributed = false;
    for (const goal of OBJECTIVES) {
      let best: number | null = null;
      for (const unitCosts of unitCostList) {
        const cost = objectiveCostPerOutcome(goal, unitCosts, econ);
        if (cost != null && cost > 0 && (best == null || cost < best)) best = cost;
      }
      if (best != null) {
        perObjectiveBrandBests[goal].push(best);
        contributed = true;
      }
    }
    if (contributed) brandCount += 1;
  }

  const objectives = {} as ObjectiveAverages;
  for (const goal of OBJECTIVES) objectives[goal] = mean(perObjectiveBrandBests[goal]);
  return { objectives, brandCount };
}

// ── Lifetime (all-history) pooled averages — the trend's window→∞ limit ───────
//
// The staff admin table's "All-time avg" column. A TRUE lifetime average cannot be recovered from the
// moving-average trend (avg-of-windows ≠ lifetime avg), so it is a backend-owned field. It is the pooled
// all-history cost-per-outcome: total fleet spend ÷ total fleet outcomes (over ALL dated days), the exact
// value the trend's cost line converges to as its window grows unbounded (window unit cost
// windowSpend/windowOutcomes → totalSpend/totalOutcomes). Computing it the SAME way as a trend point —
// projected objectives push the pooled unit costs through the fleet-mean economics — keeps the column and
// the trend coherent by construction (the all-time number IS where the trend converges). Extends #485.

/**
 * Pooled lifetime cost-per-outcome for EVERY objective, from all-history fleet totals: `clickUsd =
 * totalSpentUsd / totalClicks`, `replyUsd = totalSpentUsd / totalPositiveReplies`, then per objective
 * `objectiveCostPerOutcome` (websiteVisit / positiveReply = pooled CPC / CPPR; the rest project through
 * the fleet-mean economics). Null (never a false $0) when the denominator is 0 or the objective's rate is
 * absent — mirrors a trend point exactly, so the lifetime average is the window→∞ limit of the trend.
 */
export function buildLifetimeObjectiveAverages(params: {
  totalSpentUsd: number;
  totalClicks: number;
  totalPositiveReplies: number;
  fleetEcon: ProjectionEconomics | null;
}): ObjectiveAverages {
  const { totalSpentUsd, totalClicks, totalPositiveReplies, fleetEcon } = params;
  const unitCosts: ProjectionUnitCosts = {
    clickUsd: totalClicks > 0 && totalSpentUsd > 0 ? totalSpentUsd / totalClicks : null,
    replyUsd: totalPositiveReplies > 0 && totalSpentUsd > 0 ? totalSpentUsd / totalPositiveReplies : null,
  };
  const objectives = {} as ObjectiveAverages;
  for (const goal of OBJECTIVES) {
    objectives[goal] = fleetEcon ? objectiveCostPerOutcome(goal, unitCosts, fleetEcon) : null;
  }
  return objectives;
}

// ── Gap #2 — dated moving-average trend ──────────────────────────────────────

export interface TrendPoint {
  /** UTC day (YYYY-MM-DD) this moving-average point is anchored to (the window's most recent day). */
  date: string;
  /** Moving-average cost-per-outcome over the trailing window ending at `date`. Null when the window
   * holds < 1 base outcome or the objective's rate is absent — never a false $0. */
  costPerOutcomeUsd: number | null;
  /** Count of the objective's base engagement outcomes (clicks / replies / clicks+replies) in the window. */
  windowOutcomeCount: number;
  /** Total fleet spend (USD) over the window's days. */
  windowSpentUsd: number;
  /** First UTC day included in the trailing window. */
  windowStartDate: string;
}

export interface DayOutcome {
  clicks: number;
  replies: number;
}

/**
 * Dated moving-average cost-per-outcome series for ONE objective. Each display day D anchors a trailing
 * window that walks backward accumulating the objective's base outcomes until it holds ≥ `windowOutcomes`
 * of them (or hits `maxLookbackDays`); the window's total spend ÷ its outcomes (pushed through the
 * fleet-mean economics for the projected objectives) is the point. This is the "moving average of the
 * last ~N outcomes" rendered as a dense dated series a chart can plot.
 *
 * Pure: caller supplies dated fleet spend (per UTC day) + dated fleet clicks/replies (per UTC day) +
 * the fleet-mean economics. `days` = how many trailing display days to emit (anchored at `todayIso`).
 */
export function buildCostPerOutcomeTrend(params: {
  objective: Goal;
  todayIso: string;
  days: number;
  windowOutcomes: number;
  maxLookbackDays: number;
  spendByDay: Map<string, number>;
  outcomesByDay: Map<string, DayOutcome>;
  fleetEcon: ProjectionEconomics | null;
}): TrendPoint[] {
  const { objective, todayIso, days, windowOutcomes, maxLookbackDays, spendByDay, outcomesByDay, fleetEcon } = params;
  const points: TrendPoint[] = [];

  for (let i = days - 1; i >= 0; i--) {
    const anchor = addUtcDays(todayIso, -i);
    let windowSpend = 0;
    let windowClicks = 0;
    let windowReplies = 0;
    let windowStart = anchor;

    // Walk backward from the anchor until the base outcome count reaches the target (or max lookback).
    for (let back = 0; back < maxLookbackDays; back++) {
      const day = addUtcDays(anchor, -back);
      windowSpend += spendByDay.get(day) ?? 0;
      const o = outcomesByDay.get(day);
      if (o) {
        windowClicks += o.clicks;
        windowReplies += o.replies;
      }
      windowStart = day;
      if (windowBaseOutcome(objective, windowClicks, windowReplies) >= windowOutcomes) break;
    }

    const windowOutcomeCount = windowBaseOutcome(objective, windowClicks, windowReplies);
    const unitCosts: ProjectionUnitCosts = {
      clickUsd: windowClicks > 0 ? windowSpend / windowClicks : null,
      replyUsd: windowReplies > 0 ? windowSpend / windowReplies : null,
    };
    const costPerOutcomeUsd = fleetEcon ? objectiveCostPerOutcome(objective, unitCosts, fleetEcon) : null;

    points.push({
      date: anchor,
      costPerOutcomeUsd,
      windowOutcomeCount,
      windowSpentUsd: windowSpend,
      windowStartDate: windowStart,
    });
  }

  return points;
}

// ── Gap #3 — per-workflow populated ratio ────────────────────────────────────

export interface WorkflowGrainInput {
  workflowDynastySlug: string;
  workflowDynastyName: string;
  spentUsd: number;
  clicks: number;
  replies: number;
}

export interface WorkflowCostRow {
  workflowDynastySlug: string;
  workflowDynastyName: string;
  spentUsd: number;
  observedClicks: number;
  observedPositiveReplies: number;
  /** Populated cost-per-outcome for the objective — projected cascade floor (parent = fleet unit cost)
   * so it is NEVER null when the workflow has spend and economics exist. Null only at cold start (no
   * fleet economics) or for a projected objective whose rate is absent. */
  costPerOutcomeUsd: number | null;
}

/**
 * Per-workflow (dynasty) cross-org cost-per-outcome for ONE objective, guaranteed to POPULATE when the
 * workflow has spend: the unit costs run through the PROJECTED cost-engine (`projectedCostPerOutcome`),
 * flooring to `max(spent, fleetParentCost)` when the outcome denominator is 0 — so a workflow with spend
 * but 0 tracked outcomes yields a rankable floor instead of null. Projected objectives push the floored
 * unit costs through the fleet-mean economics. Sorted by spend desc.
 *
 * Pure: caller supplies per-dynasty evidence + the fleet parent unit costs (fleet-wide CPC / CPPR) + the
 * fleet-mean economics. `projectedFloor` is injected (= cost-engine `projectedCostPerOutcome`) to keep
 * this lib free of a cost-engine import cycle and to make the floor rule explicit at the call site.
 */
export function buildWorkflowCostPerOutcome(params: {
  objective: Goal;
  rows: WorkflowGrainInput[];
  fleetParentClickUsd: number | null;
  fleetParentReplyUsd: number | null;
  fleetEcon: ProjectionEconomics | null;
  projectedFloor: (spentUsd: number, observedCount: number, parentCost: number | null) => number;
}): WorkflowCostRow[] {
  const { objective, rows, fleetParentClickUsd, fleetParentReplyUsd, fleetEcon, projectedFloor } = params;

  return rows
    .map((r): WorkflowCostRow => {
      const clickUsd = projectedFloor(r.spentUsd, r.clicks, fleetParentClickUsd);
      const replyUsd = projectedFloor(r.spentUsd, r.replies, fleetParentReplyUsd);
      const costPerOutcomeUsd = fleetEcon
        ? objectiveCostPerOutcome(objective, { clickUsd, replyUsd }, fleetEcon)
        : null;
      return {
        workflowDynastySlug: r.workflowDynastySlug,
        workflowDynastyName: r.workflowDynastyName,
        spentUsd: r.spentUsd,
        observedClicks: r.clicks,
        observedPositiveReplies: r.replies,
        costPerOutcomeUsd,
      };
    })
    .sort((a, b) => b.spentUsd - a.spentUsd || a.workflowDynastySlug.localeCompare(b.workflowDynastySlug));
}

/**
 * Add `delta` whole UTC days to a YYYY-MM-DD string, returning YYYY-MM-DD. Local copy (the send-forecast
 * helper of the same name lives in a route module); avoids a cross-module import for a 3-line date op.
 */
export function addUtcDays(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
