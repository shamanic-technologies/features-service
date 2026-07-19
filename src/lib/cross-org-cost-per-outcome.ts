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

import { GOALS, matchSingleStepGoal, matchFormSubmissionGoal, matchCombinedSalesGoal, matchWebsitePurchaseGoal, matchWhatsappGoal, type Goal } from "./goals.js";
import {
  projectOutcomeCosts,
  type ProjectionEconomics,
  type ProjectionUnitCosts,
  type SalesEconomics,
} from "./funnel-registry.js";
import { fetchFeatureMemberships } from "./feature-memberships-client.js";
import {
  fetchEffectiveEconomics,
  fetchBrandSavedEconomicsWithGoal,
  BrandOwnershipError,
} from "./sales-economics-client.js";
import { fetchFleetSpendByDay, fetchPublicEmailStats } from "./public-stats-clients.js";
import { mapWithConcurrency } from "./concurrency.js";

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
  if (matchCombinedSalesGoal(raw)) return "sales";
  if (matchWebsitePurchaseGoal(raw)) return "websitePurchase"; // incl. legacy `purchase`
  if (matchWhatsappGoal(raw)) return "whatsappConversation";
  switch (raw) {
    case "signup":
    case "self-serve":
      return "signup";
    case "meetingBooked":
    case "meeting-booked":
    case "meeting_booked":
      return "meetingBooked";
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
  // whatsappConversation: the click on the brand's WhatsApp link IS the started conversation → CPC, like
  // websiteVisit (no paid-client economics; the outcome IS the click).
  if (goal === "whatsappConversation") return unitCosts.clickUsd;
  if (goal === "positiveReply") return unitCosts.replyUsd;
  const p = projectOutcomeCosts(econ, unitCosts);
  switch (goal) {
    case "signup":
      return p.costPerSignupUsd;
    case "formSubmission":
      return p.costPerFormSubmissionUsd;
    case "meetingBooked":
      return p.costPerMeetingBookedUsd;
    case "websitePurchase":
      return p.costPerPurchaseUsd;
    case "sales":
      return p.costPerSaleUsd;
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
    case "websitePurchase":
    case "sales":
      return clicks + replies; // multi-channel close / combined goals draw from both channels
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
    websiteVisit: [], positiveReply: [], signup: [], formSubmission: [], meetingBooked: [], websitePurchase: [], sales: [], whatsappConversation: [],
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

/**
 * The SINGLE most-recent trailing-window moving-average cost-per-outcome for one dated spend/outcome
 * series (a workflow dynasty), for ONE objective — the per-workflow analogue of the fleet-wide
 * `buildCostPerOutcomeTrend`'s latest point. Same window semantics: walk backward from `todayIso`
 * accumulating the objective's base outcomes until ≥ `windowOutcomes` (or `maxLookbackDays`), then the
 * window's spend ÷ outcomes (projected objectives pushed through the fleet-mean economics). Reduced to
 * the today-anchored point (days = 1). Null (never a false $0) when the trailing window holds no base
 * outcome for the objective (an unbacked recent window), the fleet economics are absent, or the
 * projected objective's rate is absent — identical null semantics to a trend point.
 */
export function recentWindowCostPerOutcome(params: {
  objective: Goal;
  todayIso: string;
  windowOutcomes: number;
  maxLookbackDays: number;
  spendByDay: Map<string, number>;
  outcomesByDay: Map<string, DayOutcome>;
  fleetEcon: ProjectionEconomics | null;
}): number | null {
  const [point] = buildCostPerOutcomeTrend({ ...params, days: 1 });
  return point ? point.costPerOutcomeUsd : null;
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
  /** Populated cost-per-outcome for the objective — real ratio when the outcome was observed, else the
   * own-spend floor (`max(spent, 0) = spent`, crossOrg being the top grain: no cross-workflow parent), so
   * it is NEVER null when the workflow has spend and economics exist. Null only at cold start (no fleet
   * economics) or for a projected objective whose rate is absent. This is the LIFETIME (all-history) rate
   * — what the workflow has cost per outcome over all history. A 0-outcome workflow reads its OWN spend
   * (honest "spent $X, produced nothing"), NOT the fleet average — so consumers that pick a "best" per
   * outcome MUST exclude 0-outcome workflows (a workflow with 0 of the outcome is not the best at it). */
  costPerOutcomeUsd: number | null;
  /** The workflow's RECENT going rate: the trailing-window moving-average cost-per-outcome over its most
   * recent ~windowOutcomes of the objective's base outcomes (same window semantics as the fleet
   * cost-per-outcome trend, scoped to THIS dynasty). Distinct from the lifetime `costPerOutcomeUsd`.
   * Null (never a false $0) when the workflow has no backed recent window (0 recent base outcomes),
   * no fleet economics, or the projected objective's rate is absent. */
  recentCostPerOutcomeUsd: number | null;
}

/**
 * Per-workflow (dynasty) cross-org cost-per-outcome for ONE objective, guaranteed to POPULATE when the
 * workflow has spend: the unit costs run through the PROJECTED cost-engine (`projectedCostPerOutcome`),
 * flooring to `max(spent, 0) = spent` when the outcome denominator is 0 — so a workflow with spend but
 * 0 tracked outcomes yields its OWN spend, never a cross-workflow pooled average. crossOrg is the TOP
 * grain of the cost cascade (a workflow's cost has no coarser parent — the fleet-pooled cross-workflow
 * rate is NOT its parent), so its 0-outcome base case is own spend, matching the workflow-projection
 * ladder. Projected objectives push the own-spend-floored unit costs through the fleet-mean economics.
 * Sorted by spend desc.
 *
 * Pure: caller supplies per-dynasty evidence + the fleet-mean economics. `projectedFloor` is injected
 * (= cost-engine `projectedCostPerOutcome`) to keep this lib free of a cost-engine import cycle and to
 * make the floor rule explicit at the call site; passing `null` as the parent floors 0-outcome to own
 * spend (the crossOrg base case).
 */
export function buildWorkflowCostPerOutcome(params: {
  objective: Goal;
  rows: WorkflowGrainInput[];
  fleetEcon: ProjectionEconomics | null;
  projectedFloor: (spentUsd: number, observedCount: number, parentCost: number | null) => number;
  /** Per-dynasty RECENT trailing-window cost-per-outcome (see `recentWindowCostPerOutcome`), keyed by
   * dynasty slug. Computed by the route from each dynasty's dated spend/outcomes. A dynasty absent from
   * the map (or mapping to null) → `recentCostPerOutcomeUsd: null`. */
  recentByDynasty?: Map<string, number | null>;
}): WorkflowCostRow[] {
  const { objective, rows, fleetEcon, projectedFloor, recentByDynasty } = params;

  return rows
    .map((r): WorkflowCostRow => {
      // crossOrg is the top grain: a 0-outcome workflow floors to its OWN spend (parent = null), never a
      // cross-workflow pooled average.
      const clickUsd = projectedFloor(r.spentUsd, r.clicks, null);
      const replyUsd = projectedFloor(r.spentUsd, r.replies, null);
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
        recentCostPerOutcomeUsd: recentByDynasty?.get(r.workflowDynastySlug) ?? null,
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

// ── Goal-bucketed cost per outcome (per-brand-goal scoping) ───────────────────
//
// A brand's spend + outcomes count toward a cost-per-outcome CARD only when the brand's optimization
// goal is RELEVANT to that card — otherwise a brand that optimizes for meetings/replies dilutes the
// fleet CPC. So each objective's fleet spend + outcomes are summed over ONLY the brands whose declared
// `optimizationGoal` sits in that objective's bucket below. Because runs/email cost rows are NOT
// goal-tagged (0 of ~42k carry a non-null goal), the bucketing is done consumer-side: enumerate the
// feature's brands, resolve each brand's goal (brand-service saved economics), fetch each brand's dated
// spend (runs, brandId-filtered) + dated outcomes (email-gateway, brandId-filtered), then aggregate per
// bucket. This is composition of data the fleet already owns, NOT a read-side derivation of a missing tag.

/**
 * Which `optimizationGoal`s contribute to each objective's cost-per-outcome bucket.
 *
 * - **websiteVisit (CPC)** — every click-driven goal EXCEPT the reply-driven + meeting-driven ones
 *   (websitePurchase closes via a meeting, so it belongs to the meeting bucket, not CPC).
 * - **positiveReply / signup / formSubmission** — their own goal only.
 * - **meetingBooked** — meetingBooked + websitePurchase (a website purchase closes partly through a meeting).
 * - **websitePurchase** — its own goal only.
 * - **sales** — its own goal only (the combined goal has its own denominator; the visit + reply channels
 *   are already unioned inside its cost, so it is NOT folded into the CPC or reply buckets).
 *
 * A brand may fall in SEVERAL buckets (a `signup` brand feeds both CPC and cost-per-signup) — intended:
 * each card is a distinct ratio over a distinct denominator, and the same spend legitimately produced
 * clicks AND signups.
 */
export const OBJECTIVE_GOAL_BUCKET: Record<Goal, readonly Goal[]> = {
  websiteVisit: ["websiteVisit", "signup", "formSubmission"],
  positiveReply: ["positiveReply"],
  signup: ["signup"],
  formSubmission: ["formSubmission"],
  meetingBooked: ["meetingBooked", "websitePurchase"],
  websitePurchase: ["websitePurchase"],
  sales: ["sales"],
  // Click-outcome goal (the WhatsApp-link click IS the outcome) — its own CPC denominator, like a
  // single-outcome objective; not folded into the websiteVisit CPC bucket.
  whatsappConversation: ["whatsappConversation"],
};

/** True when a brand whose optimization goal is `goal` contributes to `objective`'s cost bucket. */
export function goalInObjectiveBucket(objective: Goal, goal: Goal): boolean {
  return OBJECTIVE_GOAL_BUCKET[objective].includes(goal);
}

/** One feature brand's goal + saved economics + its dated spend / outcome evidence (cross-org). */
export interface BucketedBrand {
  brandId: string;
  goal: Goal;
  economics: SalesEconomics;
  /** Dated fleet spend for THIS brand (USD per UTC day). */
  spendByDay: Map<string, number>;
  /** Dated clicks / positive replies for THIS brand (per UTC day). */
  outcomesByDay: Map<string, DayOutcome>;
}

/** The brands of a feature that belong to `objective`'s cost bucket. */
export function bucketBrandsForObjective(brands: BucketedBrand[], objective: Goal): BucketedBrand[] {
  return brands.filter((b) => goalInObjectiveBucket(objective, b.goal));
}

/** Sum a set of brands' dated spend into one day→USD map. */
export function mergeSpendByDay(brands: BucketedBrand[]): Map<string, number> {
  const merged = new Map<string, number>();
  for (const b of brands) {
    for (const [day, spend] of b.spendByDay) merged.set(day, (merged.get(day) ?? 0) + spend);
  }
  return merged;
}

/** Sum a set of brands' dated clicks + replies into one day→{clicks,replies} map. */
export function mergeOutcomesByDay(brands: BucketedBrand[]): Map<string, DayOutcome> {
  const merged = new Map<string, DayOutcome>();
  for (const b of brands) {
    for (const [day, o] of b.outcomesByDay) {
      const prev = merged.get(day) ?? { clicks: 0, replies: 0 };
      merged.set(day, { clicks: prev.clicks + o.clicks, replies: prev.replies + o.replies });
    }
  }
  return merged;
}

/**
 * Pooled all-history cost-per-outcome for EVERY objective, each summed over ITS OWN goal bucket:
 * per objective, sum the bucket brands' total spend + total clicks / replies (over all days), form the
 * pooled unit costs, and push through `objectiveCostPerOutcome` (websiteVisit / positiveReply = pooled
 * CPC / CPPR; the rest project through the bucket's fleet-mean economics). Null (never a false $0) when a
 * bucket has 0 spend, a 0 denominator, or no economics. Same math as a trend point, so each objective's
 * lifetime average is the window→∞ limit of its (bucketed) trend.
 */
export function buildBucketedLifetimeAverages(brands: BucketedBrand[]): ObjectiveAverages {
  const objectives = {} as ObjectiveAverages;
  for (const goal of OBJECTIVES) {
    const bucket = bucketBrandsForObjective(brands, goal);
    let totalSpentUsd = 0;
    let totalClicks = 0;
    let totalReplies = 0;
    for (const b of bucket) {
      for (const spend of b.spendByDay.values()) totalSpentUsd += spend;
      for (const o of b.outcomesByDay.values()) {
        totalClicks += o.clicks;
        totalReplies += o.replies;
      }
    }
    const fleetEcon = meanFleetEconomics(bucket.map((b) => b.economics));
    const unitCosts: ProjectionUnitCosts = {
      clickUsd: totalClicks > 0 && totalSpentUsd > 0 ? totalSpentUsd / totalClicks : null,
      replyUsd: totalReplies > 0 && totalSpentUsd > 0 ? totalSpentUsd / totalReplies : null,
    };
    objectives[goal] = fleetEcon ? objectiveCostPerOutcome(goal, unitCosts, fleetEcon) : null;
  }
  return objectives;
}

// ── Cost-per-outcome DISTRIBUTION (per-brand histogram + central tendency + spread) ───────────
//
// The staff/marketing "going rate" view: not one flat average but the SPREAD of an objective's
// cost-per-outcome ACROSS the brands the fleet runs (a cheap tail, a bulk, an expensive tail). The
// distribution UNIT is the BRAND — each brand contributes ONE data point = its pooled all-history
// cost-per-outcome (its total spend ÷ its total outcomes, pushed through the objective's cost math),
// exactly the per-brand version of the lifetime pooled number. Goal-bucketed like the trend/lifetime
// surfaces (a brand feeds an objective only when its optimization goal is in that objective's bucket),
// so the set of contributing brands agrees with those surfaces by construction.
//
// The response carries ONLY aggregate histogram buckets + summary stats — NEVER per-brand values or
// ids — so a public (no-auth) caller sees the spread without any brand's individual cost being exposed.

/** One histogram bar: the count of brands whose cost-per-outcome falls in [minUsd, maxUsd). */
export interface DistributionBucket {
  /** Lower edge of the bar (USD, inclusive). */
  minUsd: number;
  /** Upper edge of the bar (USD). Exclusive except on the LAST bar, where the max value lands. */
  maxUsd: number;
  /** Number of brands whose per-brand cost-per-outcome falls in this bar. */
  count: number;
}

export interface CostPerOutcomeDistribution {
  /** Number of brands that contributed a usable ( > 0 ) per-brand cost-per-outcome data point. */
  brandCount: number;
  /** Histogram bars over [min, max] (empty when brandCount < the minimum to form a distribution). */
  buckets: DistributionBucket[];
  /** Unweighted mean of the per-brand costs (the "going rate" across brands). Null under the minimum. */
  mean: number | null;
  /** Median per-brand cost (50th percentile, linear-interpolated). Null under the minimum. */
  median: number | null;
  /** Cheapest brand's cost-per-outcome (the cheap tail). Null under the minimum. */
  min: number | null;
  /** Most expensive brand's cost-per-outcome (the expensive tail). Null under the minimum. */
  max: number | null;
  /** 25th percentile — the lower edge of the bulk. Null under the minimum. */
  p25: number | null;
  /** 75th percentile — the upper edge of the bulk. Null under the minimum. */
  p75: number | null;
  /** Population standard deviation of the per-brand costs (a scalar sense of the spread). Null under the minimum. */
  stddev: number | null;
}

/** Linear-interpolated quantile of a NON-EMPTY ascending-sorted array (q in [0,1]). */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Bin an ascending-sorted, non-empty value array into `bucketCount` equal-width bars over [min, max].
 * All values equal (max == min) → a single bar holding every value. The max value lands in the LAST
 * bar (its upper edge is inclusive) so no data point falls outside the histogram.
 */
function histogram(sorted: number[], bucketCount: number): DistributionBucket[] {
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (max === min) return [{ minUsd: min, maxUsd: max, count: sorted.length }];

  const width = (max - min) / bucketCount;
  const buckets: DistributionBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    buckets.push({ minUsd: min + i * width, maxUsd: min + (i + 1) * width, count: 0 });
  }
  for (const v of sorted) {
    let idx = Math.floor((v - min) / width);
    if (idx >= bucketCount) idx = bucketCount - 1; // the max value lands in the last bar
    if (idx < 0) idx = 0;
    buckets[idx].count += 1;
  }
  return buckets;
}

/**
 * Per-brand pooled all-history cost-per-outcome for an objective, over a set of (already goal-bucketed)
 * brands: sum each brand's spend + clicks / replies over all days, form its unit costs, and push through
 * `objectiveCostPerOutcome` (websiteVisit / positiveReply = the brand's CPC / CPPR; the rest project
 * through the brand's OWN economics). A brand whose cost is null or ≤ 0 (0 outcomes, or an absent rate)
 * contributes NO data point — never a false $0. Returns one number per contributing brand (unsorted).
 */
export function perBrandCostPerOutcome(brands: BucketedBrand[], objective: Goal): number[] {
  const values: number[] = [];
  for (const b of brands) {
    let spend = 0;
    let clicks = 0;
    let replies = 0;
    for (const s of b.spendByDay.values()) spend += s;
    for (const o of b.outcomesByDay.values()) {
      clicks += o.clicks;
      replies += o.replies;
    }
    const unitCosts: ProjectionUnitCosts = {
      clickUsd: clicks > 0 && spend > 0 ? spend / clicks : null,
      replyUsd: replies > 0 && spend > 0 ? spend / replies : null,
    };
    const cost = objectiveCostPerOutcome(objective, unitCosts, buildLenientProjectionEconomics(b.economics));
    if (cost != null && cost > 0) values.push(cost);
  }
  return values;
}

/**
 * The cross-org DISTRIBUTION of per-brand cost-per-outcome for ONE objective: a histogram (equal-width
 * bars + counts) plus the central tendency (mean, median) and the spread (min / p25 / p75 / max / stddev).
 * The unit is the BRAND. `brands` should already be the objective's goal bucket (`bucketBrandsForObjective`).
 *
 * Empty/soft below `minBrands`: fewer than `minBrands` usable data points cannot form a meaningful spread
 * (and could reveal an individual brand's cost on a public surface), so buckets = [] and every scalar is
 * null — the consumer shows "not enough data yet". `brandCount` is always the true count of data points.
 * Pure.
 */
export function buildCostPerOutcomeDistribution(params: {
  objective: Goal;
  brands: BucketedBrand[];
  bucketCount: number;
  minBrands: number;
}): CostPerOutcomeDistribution {
  const { objective, brands, bucketCount, minBrands } = params;
  const values = perBrandCostPerOutcome(brands, objective).sort((a, b) => a - b);
  const brandCount = values.length;

  if (brandCount < minBrands) {
    return { brandCount, buckets: [], mean: null, median: null, min: null, max: null, p25: null, p75: null, stddev: null };
  }

  const meanVal = values.reduce((a, b) => a + b, 0) / brandCount;
  const variance = values.reduce((a, v) => a + (v - meanVal) ** 2, 0) / brandCount;
  return {
    brandCount,
    buckets: histogram(values, bucketCount),
    mean: meanVal,
    median: quantile(values, 0.5),
    min: values[0],
    max: values[brandCount - 1],
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
    stddev: Math.sqrt(variance),
  };
}

/**
 * Fetch the goal-bucketed per-brand dataset for a feature (cross-org): enumerate the feature's distinct
 * brands, resolve each brand's saved economics + optimization goal, and fetch each brand's dated spend
 * (runs) + dated clicks / positive replies (email-gateway). A brand with no saved goal/economics is
 * OMITTED (it cannot be bucketed). One fetch per brand, run concurrently. Feature-level (objective-
 * independent) so the trend + lifetime surfaces can share ONE cached dataset. Fails loud on any
 * transport / non-OK error (essential input, not optional enrichment); a stale membership
 * (BrandOwnershipError) is skipped, mirroring `fetchFleetBrandEconomics`.
 */
// Cap the per-brand fan-out so the dataset build does not burst ~3×N concurrent sockets at
// runs-service / email-gateway / brand-service at once. Even a single (single-flighted) build of N≈30
// brands would otherwise open ~90 simultaneous cross-service connections, spiking load on cold-Neon
// siblings; a bounded pool smooths it into waves. Fail-loud is preserved — any worker rejection
// propagates out of the pool.
const GOAL_BUCKET_BRAND_CONCURRENCY = 8;

export async function fetchGoalBucketDataset(featureSlug: string): Promise<BucketedBrand[]> {
  const memberships = await fetchFeatureMemberships(featureSlug);
  const brandIds = [...new Set(memberships.map((m) => m.brandId))];

  const perBrand = await mapWithConcurrency(
    brandIds,
    GOAL_BUCKET_BRAND_CONCURRENCY,
    async (brandId): Promise<BucketedBrand | null> => {
      const { economics, goal } = await fetchBrandSavedEconomicsWithGoal(brandId);
      if (!economics || !goal) return null;

      const [spendByDay, dayOutcomeMap] = await Promise.all([
        fetchFleetSpendByDay(featureSlug, brandId),
        fetchPublicEmailStats(featureSlug, "day", [brandId]),
      ]);

      const outcomesByDay = new Map<string, DayOutcome>();
      for (const [day, fields] of dayOutcomeMap) {
        if (day === "__total__") continue;
        outcomesByDay.set(day, {
          clicks: fields.recipientsClicked ?? 0,
          replies: fields.recipientsRepliesPositive ?? 0,
        });
      }

      return { brandId, goal, economics, spendByDay, outcomesByDay };
    },
  );

  return perBrand.filter((b): b is BucketedBrand => b != null);
}
