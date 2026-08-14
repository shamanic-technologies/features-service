/**
 * Brand-level FLEET-BACKED projected cost-per-outcome — the floor parent for /audience-stats AND for
 * the /revenue `spend` block's AGGREGATE cost-per-outcome columns (brand + campaign grain). Both
 * surfaces price a 0-outcome cell off the SAME winning workflow, so the Audiences table, the Overview
 * card and the Strategy page can never print two benchmarks for one brand + goal + moment.
 *
 * A 0-outcome audience's per-audience cost-per-outcome must bottom out at the SAME projected cost the
 * Strategy page's `workflow-projection.resolved` shows (the cross-org fleet benchmark cascaded with the
 * brand's effective economics), NOT a brand-own raw-spend aggregate computed from audience-stats' own
 * numbers. So this reuses the EXACT shared projection engine (`projectedCostPerOutcome` +
 * `projectOutcomeCosts`) on the cross-org fleet unit costs + the brand's effective economics — one
 * source of truth for "projected cost per outcome" across both surfaces → they agree by construction.
 *
 * The parent is the **BEST-WORKFLOW** benchmark — NEVER a cross-workflow POOLED average (Σ fleet spend ÷
 * Σ fleet outcomes). Standing product rule: we never surface a cross-org PLUS cross-workflow pooled
 * estimate; a fleet-wide estimate is cross-org plus the BEST workflow, only. The pooled parent read ~3x
 * the Strategy page's number for the same brand + goal + moment (both labelled "fleet benchmark" in the
 * UI → two prices for one thing). This module therefore REBUILDS workflow-projection's BRAND-LEVEL rows
 * (the `audienceId: null` ones the Strategy page ranks) and takes the winner:
 *   - Per workflow DYNASTY, the crossOrg → brand grain LADDER, unit costs through the SAME
 *     `projectedCostPerOutcome` cascade `buildGrainBlock` uses (a 0-outcome grain floors to
 *     `max(own spend, parent)`), and the row's numbers taken from the finest grain WITH SPEND — byte-for-
 *     byte `resolvePick`'s NUMBER selection. Skipping the brand grain is NOT an option: a brand that
 *     outspent the fleet rate on a dynasty with 0 outcomes keeps its own higher floor there, which is
 *     exactly what flipped the prod winner (Osprey's brand grain floors its click to $4.16 > its fleet
 *     $2.43, handing the goal to Pelican).
 *   - ONE dynasty is then picked — the LOWEST cost of the QUERIED GOAL's outcome, scored with the shared
 *     `outcomeCostForGoal`. EVERY column derives from THAT dynasty's resolved unit costs, exactly like a
 *     workflow-projection row derives all of its costs from one grain. Picking a different best workflow
 *     per column would blend workflows and re-open the incoherence one layer down.
 *   - EVERY dynasty competes, including one that has produced 0 of the goal's outcome — its cascade floor
 *     `max(spend, parent)` is a real rankable number, and the Strategy page's `pickBestBrandRow` ranks it
 *     too. (A `grainHasObservedOutcome` gate lived here from v0.106.3 until v0.107.5; it made this module
 *     crown a different workflow than the dashboard for the same brand+goal, which IS the incoherence.)
 *   - Version chains collapse first (`buildUpgradeChains` + `aggregateAcrossChains`, the SAME rollup
 *     crossOrg/brand use in workflow-projection) so a dynasty's versions are one workflow, not several.
 *
 * The module ALSO returns, per audience, that audience's FUNNEL costs at the AUDIENCE grain
 * (`byAudience`) — the value every DERIVED column (form submission / signup / sale) takes at 0 outcomes.
 * This half mirrors a DIFFERENT consumer rule and must not be conflated with the brand-level pick above:
 * the Strategy page's per-audience table (`strategy-model.ts pickAudienceOrBrandRow` →
 * `pickAudienceGrainRow`) is **WORKFLOW-AGNOSTIC** — among ALL of an audience's rows whose RESOLVED GRAIN
 * is "audience", it renders the one with the lowest `resolved.costPerClickUsd`. So:
 *   - Candidates are the dynasties where the audience has send-tag spend AND MEASURED the goal's driving
 *     outcome (`grainHasObservedOutcome`) — `resolvePick` labels a 0-outcome audience block
 *     `brand`/`crossOrg`, so those rows are not candidates on the dashboard and must not be here either.
 *   - The min is taken on the resolved CLICK cost, then that ONE row's unit costs feed the funnel.
 *   - Do NOT key this to the brand-level winner: an audience that mostly ran a DIFFERENT workflow is
 *     rendered on that other workflow's row (prod: the CEO audience renders `pelican` at $3.035/click =
 *     $12.14 per form submission, where the brand-best row says $13.49).
 *   - An audience with NO measured audience grain anywhere is ABSENT from the map — it has observed none
 *     of the driving outcome, which is exactly the regime where a raw dollar total IS the legitimate
 *     answer, so the caller falls through to `flooredCostPerOutcome`'s `max(own spend, parent)`.
 *
 * Why a derived column can NOT floor on the raw dollar total once the audience HAS clicks (the bug this
 * fixes): a raw total is a sound lower bound only for a RAW column, where the driving outcome IS the
 * outcome. Answering "cost per form submission" with a total spend is a units error, and it discards the
 * clicks the audience did observe — prod showed three audiences whose cost-per-form-submission equalled
 * their own net spend to the cent while the Strategy page priced the same audiences 2-4x lower.
 *
 * null per column when the driving input is absent (no eligible workflow, or no economics for the
 * goal-projected columns) → the derived columns then degrade to the raw cascade floor (never a fabricated
 * parent, and there is no projection on either surface to be coherent with at cold start).
 */

import { fetchPublicCosts, fetchPublicEmailStats, fetchPublicWorkflows } from "./public-stats-clients.js";
import { buildUpgradeChains, aggregateAcrossChains } from "../routes/public.js";
import { fetchEffectiveEconomics } from "./sales-economics-client.js";
import {
  projectOutcomeCosts,
  singleStepRateDecimal,
  formSubmissionRatesDecimal,
  type ProjectionEconomics,
  type SalesEconomics,
} from "./funnel-registry.js";
import { projectedCostPerOutcome } from "./cost-engine.js";
import { goalToProjectionInputs, funnelToProjectionInputs, outcomeCostForGoal, paidClientCostForGoal, grainHasObservedOutcome } from "../routes/workflow-projection.js";
import type { MeetingChannel, SalesFunnelKey } from "./sales-funnels.js";
import { mergeFunnelEconomics } from "./declared-funnels.js";
import {
  fetchBrandWorkflowEvidence,
  fetchAudienceGrainEvidence,
  type WorkflowGrainEvidence,
} from "./workflow-projection-grains.js";
import type { Pricing } from "./pricing.js";
import type { Goal } from "./goals.js";

/**
 * The FUNNEL (derived) cost columns projected for ONE audience under the goal's winning workflow —
 * `resolvePick`'s NUMBER selection carried down to the audience grain, so each equals the number
 * `workflow-projection` resolves for that same (audience × winning dynasty) row.
 */
export interface AudienceProjectedCostsUsd {
  cpfsUsd: number | null; // cost per form submission (projected)
  cpsUsd: number | null; // cost per signup (projected)
  cpsaleUsd: number | null; // cost per sale (goal=sales → best-channel; goal=websitePurchase → close funnel)
  /**
   * What it costs THIS audience to win one PAYING CLIENT — its own unit costs pushed through the
   * queried goal's chain by the SAME `paidClientCostForGoal` `/workflow-projection` and
   * `/funnel-ranking` route through. The denominator of the audience's return per dollar. null when
   * the chain has no path to a paying client on the brand's declared rates (never 0, which would
   * read as an infinite return).
   */
  costPerPaidClientUsd: number | null;
}

/**
 * Fleet-backed projected cost-per-outcome (USD) per /audience-stats cost column. Each field is the
 * PARENT the corresponding column floors against at 0 outcomes. null when the driving input is absent.
 */
/**
 * Why a projection carries no defined RETURN. Same vocabulary `/funnel-ranking` reports per declared
 * funnel (`UnrankableReason`), deliberately spelled the same so a consumer reads one set of words for
 * "this chain could not be priced" wherever it meets it. Never a substituted number — the reason IS the
 * answer.
 */
export type FunnelPricingReason =
  /** No effective economics for this brand (cold start) — nothing to normalise through. */
  | "no_economics"
  /** No workflow carries a usable cost of this chain's outcome. */
  | "no_workflow_evidence"
  /** The chain has no defined path to a paying client (a leg is undeclared or sits at 0). */
  | "no_paid_client_path"
  /** A paid-client cost exists but the brand states no lifetime revenue, so there is no return. */
  | "no_return_defined";

export interface BrandProjectedParentsUsd {
  cpcUsd: number | null; // cost per website visit (raw fleet CPC)
  cpprUsd: number | null; // cost per positive reply (raw fleet CPPR)
  cpfsUsd: number | null; // cost per form submission (projected)
  cpsUsd: number | null; // cost per signup (projected)
  cpsaleUsd: number | null; // cost per sale (goal=sales → best-channel; goal=websitePurchase → close funnel)
  /**
   * Cost per BOOKED MEETING (projected, both channels: click→meeting + reply→meeting). /audience-stats
   * has no per-audience meeting column, so this is consumed only by the /revenue aggregate spend block
   * (`cpsmCents`), which prices the same five outcomes off the SAME winning workflow.
   */
  cpsmUsd: number | null;
  /**
   * Per-audience FUNNEL costs under the winning workflow — the value each DERIVED column takes at 0
   * outcomes, instead of the audience's raw dollar total. Keyed by audienceId; an audience absent from
   * the map (no send-tag evidence on the winner) inherits the brand-level fields above, exactly as
   * `resolvePick` falls back from the audience grain to the brand grain. Empty at cold start.
   */
  byAudience: Map<string, AudienceProjectedCostsUsd>;
  /**
   * The brand's cost per PAYING CLIENT on the winning workflow — the brand-level twin of each
   * audience's `costPerPaidClientUsd`, and the number an audience with no measured grain of its own
   * inherits (the same brand-level fallback every derived column already takes).
   */
  costPerPaidClientUsd: number | null;
  /**
   * The brand's lifetime revenue per paying client, from the resolved (declared-funnel-priced)
   * economics this projection was built on — the NUMERATOR of every return per dollar reported
   * beside it. Surfaced so a consumer never has to source it from a second endpoint (and so cannot
   * pair a return with an LTR the projection did not use). null at cold start / no economics.
   */
  lifetimeRevenueUsd: number | null;
  /**
   * Null ⟺ this projection HAS a defined, positive return (`lifetimeRevenueUsd / costPerPaidClientUsd`).
   * Otherwise the reason it does not — so a consumer combining several chains can say which of the
   * brand's funnels went into a figure and why the others did not, instead of showing a silent gap.
   */
  pricingReason: FunnelPricingReason | null;
}

/**
 * RETURN PER DOLLAR — how many dollars of lifetime revenue one dollar of spend buys, for whatever
 * grain the two inputs describe.
 *
 * This is the ONE definition of "return" in this service, shared verbatim with `/funnel-ranking`
 * (which ranks a brand's declared funnels on it) so an audience's return and the brand's return are
 * the same statistic at two grains — a brand cannot read two different returns on two pages.
 *
 * PROJECTED, not realized: it prices what the grain's OWN observed unit costs imply under the
 * brand's OWN declared economics. That is what makes audiences comparable — cost per outcome alone
 * ranks them by CHEAPNESS, so an audience that converts to nothing outranks an expensive one that
 * pays.
 *
 * null (never 0) whenever either input is missing or non-positive: no economics, no path to a
 * paying client, or a cost of 0 that would read as an infinite return.
 */
export function returnPerDollar(
  lifetimeRevenueUsd: number | null,
  costPerPaidClientUsd: number | null,
): number | null {
  if (lifetimeRevenueUsd == null || !(lifetimeRevenueUsd > 0)) return null;
  if (costPerPaidClientUsd == null || !(costPerPaidClientUsd > 0)) return null;
  return lifetimeRevenueUsd / costPerPaidClientUsd;
}

/**
 * COST OF ACQUISITION, AS A SHARE OF WHAT A CUSTOMER IS WORTH — the third unit the same statement is
 * read in: `100 × costPerPaidClientUsd / lifetimeRevenueUsd`, i.e. exactly `100 / returnPerDollar`.
 *
 * Defined AS the reciprocal, deliberately, rather than recomputed from the two inputs: the two
 * figures then null together, and a reader can never be shown a return and a %CAC that disagree by a
 * rounding step. Same relation `/workflow-projection` states between `roiMultiple` and `cacPct`, and
 * `/revenue` between `roiMultiple` and `costOfAcquisitionPct`.
 *
 * PROJECTED wherever `returnPerDollar` is projected — it inherits that field's provenance exactly,
 * because it IS that field. null (never 0) on the same conditions: a 0 would say winning a customer
 * costs nothing.
 */
export function costOfAcquisitionPct(
  lifetimeRevenueUsd: number | null,
  costPerPaidClientUsd: number | null,
): number | null {
  const perDollar = returnPerDollar(lifetimeRevenueUsd, costPerPaidClientUsd);
  if (perDollar == null || !(perDollar > 0)) return null;
  return 100 / perDollar;
}

export interface ProjectionIdentity {
  orgId: string;
  userId?: string;
  runId?: string;
  campaignId?: string;
  featureSlug?: string;
}

/**
 * Map a brand's effective economics → the projection engine's decimal inputs, resolving ONLY the extra
 * rates the queried goal needs (fail-loud via singleStepRateDecimal / formSubmissionRatesDecimal when a
 * required rate is genuinely absent). Mirrors computeWorkflowProjection's econ mapping so both surfaces
 * project on the same rates.
 */
function buildEcon(economics: SalesEconomics, goal: Goal): ProjectionEconomics {
  return {
    r2m: economics.replyToMeetingPct / 100,
    v2m: economics.visitToMeetingPct / 100,
    m2c: economics.meetingToClosePct / 100,
    v2c: economics.visitToClosePct / 100,
    v2s: economics.visitToSignupPct / 100,
    s2pc: economics.signupToPaidClientPct / 100,
    ...(goal === "websiteVisit" ? { v2pc: singleStepRateDecimal(economics, "websiteVisit") } : {}),
    ...(goal === "positiveReply" ? { r2pc: singleStepRateDecimal(economics, "positiveReply") } : {}),
    ...(goal === "sales"
      ? { v2pc: singleStepRateDecimal(economics, "websiteVisit"), r2pc: singleStepRateDecimal(economics, "positiveReply") }
      : {}),
    ...(goal === "formSubmission" ? formSubmissionRatesDecimal(economics) : {}),
  };
}

/** One workflow DYNASTY's RESOLVED unit costs — the finest grain WITH SPEND (brand, else crossOrg),
 * cascade-floored exactly like a workflow-projection brand-level row. */
interface DynastyUnitCosts {
  clickUsd: number;
  replyUsd: number;
}

/** One workflow DYNASTY as a workflow-projection BRAND-LEVEL row: its resolved unit costs plus the
 * observed evidence the eligibility gate reads. */
interface DynastyRow {
  /** The DYNASTY slug — the key the per-(audience × dynasty) send-tag evidence is stored under. */
  dynastySlug: string;
  unitCosts: DynastyUnitCosts;
  /** Observed outcomes of the COARSEST grain present (crossOrg ⊇ brand) — what "this workflow has
   * produced the goal's outcome somewhere" means. */
  observed: { observedClicks: number; observedPositiveReplies: number };
}

/** The lowest POSITIVE value. null when nothing is backed → the audience floor degrades to own spend,
 * never a fabricated parent. */
function bestOf(values: Array<number | null>): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (value == null || !(value > 0)) continue;
    if (best == null || value < best) best = value;
  }
  return best;
}

/** One grain's unit costs through the shared PROJECTED engine — a real ratio at ≥1 observed outcome,
 * else the cascade floor `max(own spend, parent)`. Byte-identical to `buildGrainBlock`'s unit costs. */
function grainUnitCosts(ev: WorkflowGrainEvidence, parent: DynastyUnitCosts | null): DynastyUnitCosts {
  const spentUsd = ev.totalCostInUsdCents / 100;
  return {
    clickUsd: projectedCostPerOutcome(spentUsd, ev.clicks, parent?.clickUsd ?? null),
    replyUsd: projectedCostPerOutcome(spentUsd, ev.replies, parent?.replyUsd ?? null),
  };
}

/**
 * Compute the brand's best-workflow projected cost-per-outcome parents for /audience-stats — plus, per
 * audience, the FUNNEL columns' value under that winning workflow. Rebuilds workflow-projection's
 * BRAND-LEVEL rows from the SAME sources (workflow-service `/public/workflows` + runs
 * `/v1/stats/public/costs` + email-gateway `/public/stats` for the crossOrg grain, the brand-scoped twins
 * for the brand grain, plus the brand's effective economics), rolls version chains into dynasties with the
 * SAME `buildUpgradeChains` / `aggregateAcrossChains` rollup, and takes the winner of the queried goal.
 * It then continues the SAME ladder one grain finer — the winner's per-(audience × dynasty) send-tag
 * evidence — so every audience's derived columns equal what workflow-projection resolves for it.
 * Fails loud on any downstream error (no silent fallback; NET fail-loud via fetchPublicCosts). Cross-org
 * reads are public (api-key only); the brand + audience + economics reads are org-scoped.
 */
/**
 * Everything the brand-level projection reads from the network, for ONE (brand, feature, pricing).
 *
 * GOAL- AND FUNNEL-INDEPENDENT by construction — nothing here is priced. That is what lets a caller that
 * must price the SAME brand through SEVERAL declared funnels (the funnel-less `/audience-stats` read) pay
 * for the fan-out ONCE and then run N pure projections, exactly as `/funnel-ranking` reuses one
 * `WorkflowProjectionEvidence` for every funnel it ranks. Fetching per funnel instead would multiply the
 * per-audience email fan-out by the number of funnels the brand declared.
 */
export interface BrandProjectionEvidence {
  workflows: Awaited<ReturnType<typeof fetchPublicWorkflows>>;
  slugToDynasty: Map<string, string>;
  fleetCostGroups: Awaited<ReturnType<typeof fetchPublicCosts>>;
  fleetEmail: Awaited<ReturnType<typeof fetchPublicEmailStats>>;
  effective: Awaited<ReturnType<typeof fetchEffectiveEconomics>>;
  brandGrain: Awaited<ReturnType<typeof fetchBrandWorkflowEvidence>>;
  audienceGrain: Awaited<ReturnType<typeof fetchAudienceGrainEvidence>>;
}

/**
 * The network half of `fetchBrandProjectedParents` — the cross-org fleet reads, the brand grain, the
 * per-(audience × dynasty) grain and the brand's effective economics. Fails loud on any downstream error.
 */
export async function fetchBrandProjectionEvidence(
  brandId: string,
  featureSlug: string,
  identity: ProjectionIdentity,
  pricing: Pricing = "gross",
  audienceIds?: string[],
): Promise<BrandProjectionEvidence> {
  const workflows = await fetchPublicWorkflows(featureSlug, "all");
  // The SAME slug → dynasty map the crossOrg/brand rollups use, so the audience grain's dynasty keys line
  // up with the dynasty-keyed rows (and skips runs-service's lossy workflowDynastySlug regroup).
  const slugToDynasty = new Map(workflows.map((w) => [w.workflowSlug, w.workflowDynastySlug]));
  const [fleetCostGroups, fleetEmail, effective, brandGrain, audienceGrain] = await Promise.all([
    fetchPublicCosts(featureSlug, "workflowSlug", pricing),
    fetchPublicEmailStats(featureSlug, "workflowSlug"),
    fetchEffectiveEconomics(brandId, identity),
    fetchBrandWorkflowEvidence(brandId, featureSlug, workflows, identity, pricing),
    fetchAudienceGrainEvidence(brandId, featureSlug, identity, slugToDynasty, pricing, audienceIds),
  ]);
  return { workflows, slugToDynasty, fleetCostGroups, fleetEmail, effective, brandGrain, audienceGrain };
}

export async function fetchBrandProjectedParents(
  brandId: string,
  featureSlug: string,
  goal: Goal,
  identity: ProjectionIdentity,
  pricing: Pricing = "gross",
  // The caller's already-resolved audience ids (it fetched them by requested status) — reused for the
  // audience grain so this adds no human-service round-trip and covers every row the caller will render.
  audienceIds?: string[],
  // The SALES FUNNEL the caller asked to be priced on, when it named one. It OVERRIDES `goal`: the goal
  // cannot distinguish a meeting bought with a reply from one bought with a click, and this parent is
  // the number every per-audience cost floors against, so it must be priced on the same chain the row is.
  funnelKey?: SalesFunnelKey,
  // That funnel's OWN declared terms, merged over the brand's effective economics — the SAME merge the
  // ranking does. Without it this parent prices on the brand-wide rates while the projection row prices
  // on the funnel's, and the two surfaces split apart for one funnel.
  funnelEconomics?: Partial<SalesEconomics> | null,
): Promise<BrandProjectedParentsUsd> {
  const evidence = await fetchBrandProjectionEvidence(brandId, featureSlug, identity, pricing, audienceIds);
  return projectBrandParents(evidence, goal, funnelKey, funnelEconomics);
}

/**
 * The PURE half: price one already-fetched evidence set through ONE chain (a funnel when named, else the
 * goal). No IO — so a caller may run it once per declared funnel over the same evidence.
 */
export function projectBrandParents(
  evidence: BrandProjectionEvidence,
  goal: Goal,
  funnelKey?: SalesFunnelKey,
  funnelEconomics?: Partial<SalesEconomics> | null,
): BrandProjectedParentsUsd {
  const { workflows, slugToDynasty, fleetCostGroups, fleetEmail, effective, brandGrain, audienceGrain } = evidence;

  // Collapse each workflow's version chain into ONE dynasty before comparing — the EXACT rollup
  // workflow-projection's crossOrg/brand grains use, so "a workflow" means the same thing on both
  // surfaces (treating versioned slugs as independent workflows would corrupt the best pick).
  const { costMap, aggregatedOutcomes } = aggregateAcrossChains(
    buildUpgradeChains(workflows),
    fleetCostGroups,
    fleetEmail,
    "workflowSlug",
  );

  // Per-dynasty BRAND-LEVEL row: the crossOrg → brand grain ladder, unit costs through the shared
  // cascade (`projectedCostPerOutcome`), numbers taken from the finest grain WITH SPEND — byte-for-byte
  // what workflow-projection's `audienceId: null` rows resolve to.
  const perDynasty: DynastyRow[] = [];
  for (const activeSlug of new Set([...costMap.keys(), ...brandGrain.keys()])) {
    const cost = costMap.get(activeSlug);
    const outcomes = aggregatedOutcomes.get(activeSlug) ?? {};
    const crossOrgEv: WorkflowGrainEvidence | null =
      cost && cost.totalCostInUsdCents > 0
        ? {
            totalCostInUsdCents: cost.totalCostInUsdCents,
            completedRuns: cost.completedRuns,
            contacted: outcomes.recipientsContacted ?? 0,
            clicks: outcomes.recipientsClicked ?? 0,
            replies: outcomes.recipientsRepliesPositive ?? 0,
          }
        : null;
    const brandEvRaw = brandGrain.get(activeSlug);
    const brandEv = brandEvRaw && brandEvRaw.totalCostInUsdCents > 0 ? brandEvRaw : null;
    if (!crossOrgEv && !brandEv) continue;

    const crossOrgUnits = crossOrgEv ? grainUnitCosts(crossOrgEv, null) : null;
    const unitCosts = brandEv ? grainUnitCosts(brandEv, crossOrgUnits) : crossOrgUnits!;
    // Eligibility reads the COARSEST grain (crossOrg ⊇ brand): "has this workflow ever produced the
    // goal's outcome". The brand grain alone is routinely 0-outcome even for the winning workflow.
    const ev = crossOrgEv ?? brandEv!;
    perDynasty.push({
      dynastySlug: slugToDynasty.get(activeSlug) ?? activeSlug,
      unitCosts,
      observed: { observedClicks: ev.clicks, observedPositiveReplies: ev.replies },
    });
  }

  // A FUNNEL, when the caller named one, decides the pricing outright — the goal is the coarser question
  // and cannot tell the two meeting chains apart. `meetingChannel` is the whole difference between them,
  // and it MUST thread into this parent too: an audience row floored against a both-channel benchmark
  // while its own row is priced on one channel is the same two-prices-for-one-thing split this module
  // exists to close, reappearing one grain down.
  const funnelInputs = funnelKey ? funnelToProjectionInputs(funnelKey) : null;
  const meetingChannel: MeetingChannel | null = funnelInputs?.meetingChannel ?? null;
  const pricedGoal: Goal = funnelInputs ? (funnelInputs.goalEcho as Goal) : goal;

  const economics = mergeFunnelEconomics(effective.economics, funnelEconomics ?? null);
  const econ = economics ? buildEcon(economics, pricedGoal) : null;

  // THE single best workflow for the queried goal: the LOWEST cost of the goal's own outcome, scored
  // through the shared `outcomeCostForGoal` over EVERY dynasty — byte-for-byte the argmin the Strategy
  // page's `pickBestBrandRow` runs over the brand-level rows, so both surfaces crown the SAME workflow.
  //
  // NO observed-outcome filter, deliberately (a `grainHasObservedOutcome` gate lived here from v0.106.3
  // until v0.107.5). Standing product rule: a workflow that has produced 0 of the outcome still carries a
  // real, RANKABLE number — its cascade floor `max(spend, parent)` — and it competes on equal footing.
  // Excluding those workflows HERE while the Strategy page includes them is exactly what made the two
  // surfaces price the same audience differently: prod 2026-07-29 (brand `b97440f6…`, positiveReply) this
  // module crowned `arcadia` ($64.11, 1 observed reply) while the dashboard crowned `dawn` ($61.73, zero
  // replies), both labelled "fleet benchmark". Matching the consumer's argmin is what keeps them coherent.
  // Honesty lives on the LABEL instead — `resolvePick` still tags a floored row `crossOrg` (benchmark),
  // never "this brand's own results".
  const { objective, singleStepGoal, formSubmissionGoal } = funnelInputs
    ? { objective: funnelInputs.objective, singleStepGoal: funnelInputs.singleStepGoal, formSubmissionGoal: funnelInputs.formSubmissionGoal }
    : goalToProjectionInputs(goal);
  let best: DynastyRow | null = null;
  if (econ) {
    let bestGoalCost: number | null = null;
    for (const d of perDynasty) {
      const goalCost = outcomeCostForGoal(econ, d.unitCosts, objective, singleStepGoal, formSubmissionGoal, meetingChannel);
      if (goalCost == null || !(goalCost > 0)) continue;
      if (bestGoalCost == null || goalCost < bestGoalCost) {
        bestGoalCost = goalCost;
        best = d;
      }
    }
  }

  if (!best) {
    // COLD START / unscoreable goal: no economics (workflow-projection reports no cost-per-outcome
    // either, so there is nothing to be coherent with) or no dynasty scores the goal. Still serve the two
    // RAW unit-cost parents — the cheapest workflow at that outcome, floors included, same ungated rule as
    // the goal pick above — so the cpc/cppr columns keep a benchmark floor instead of collapsing to each
    // audience's own tiny spend. The goal-projected columns stay null (never a fabricated parent).
    return {
      cpcUsd: bestOf(perDynasty.map((d) => d.unitCosts.clickUsd)),
      cpprUsd: bestOf(perDynasty.map((d) => d.unitCosts.replyUsd)),
      cpfsUsd: null,
      cpsUsd: null,
      cpsaleUsd: null,
      cpsmUsd: null,
      byAudience: new Map(),
      costPerPaidClientUsd: null,
      lifetimeRevenueUsd: economics?.lifetimeRevenueUsd ?? null,
      // Told apart because a combining caller reports them apart: "this brand has no economics" and "no
      // workflow carries a cost of this chain's outcome" are different gaps with different fixes.
      pricingReason: econ ? "no_workflow_evidence" : "no_economics",
    };
  }

  // EVERY column reads THAT one workflow's resolved unit costs — the raw ones for cpc/cppr (the visit /
  // reply IS the outcome) and the shared projection engine for the funnel columns, exactly as the
  // workflow-projection row for that workflow does.
  const bestUnits = best.unitCosts;
  const funnelCosts = (
    units: DynastyUnitCosts,
  ): AudienceProjectedCostsUsd & { cpcUsd: number | null; cpprUsd: number | null; cpsmUsd: number | null } => {
    const cpcUsd = units.clickUsd > 0 ? units.clickUsd : null;
    const cpprUsd = units.replyUsd > 0 ? units.replyUsd : null;
    // Masked to the funnel's own channel when one is stated — `null` on the other side is what every
    // per-budget term in projectOutcomeCosts already reads as "this channel funds nothing".
    const p = projectOutcomeCosts(econ!, {
      clickUsd: meetingChannel === "reply" ? null : cpcUsd,
      replyUsd: meetingChannel === "click" ? null : cpprUsd,
    });
    // sales → best-channel cost-per-sale; websitePurchase → multi-step close funnel — mirrors
    // outcomeCostForGoal (both terminate in a paying client, valued distinctly per goal).
    const cpsaleUsd = pricedGoal === "sales" ? p.costPerSaleUsd : p.costPerPurchaseUsd;
    return {
      cpcUsd,
      cpprUsd,
      cpfsUsd: p.costPerFormSubmissionUsd,
      cpsUsd: p.costPerSignupUsd,
      cpsaleUsd,
      cpsmUsd: p.costPerMeetingBookedUsd,
      // The grain's own path to a paying client, routed by the SAME function `/workflow-projection`
      // and `/funnel-ranking` use — masked to the funnel's channel exactly like every column above.
      costPerPaidClientUsd: paidClientCostForGoal(
        econ!,
        { clickUsd: cpcUsd, replyUsd: cpprUsd },
        objective,
        singleStepGoal,
        formSubmissionGoal,
        meetingChannel,
      ),
    };
  };
  const brandLevel = funnelCosts(bestUnits);

  // Continue the SAME ladder ONE grain finer — and pick the audience's row the way the Strategy page's
  // per-audience table does (`strategy-model.ts pickAudienceGrainRow`), which is WORKFLOW-AGNOSTIC:
  // among ALL of this audience's rows whose RESOLVED GRAIN is "audience", the one with the lowest
  // `resolved.costPerClickUsd`. Two conditions come straight from that consumer:
  //   - grain "audience" means the audience block exists (spend > 0) AND it MEASURED the goal's driving
  //     outcome — `resolvePick` labels a 0-outcome audience block `brand`/`crossOrg`, so those rows are
  //     not candidates there and must not be here either.
  //   - the min is taken on the resolved CLICK cost (the dashboard's stable tie-break), then that ONE
  //     row's unit costs feed the funnel — never a per-column blend.
  // Do NOT lock this to the brand-level winner: an audience that mostly ran a DIFFERENT workflow is
  // rendered on that other workflow's row, so keying on the winner reports a number the customer never
  // sees (prod: the CEO audience renders `pelican` at $3.035/click = $12.14 per form submission, while
  // the brand-best row would say $13.49 and `recommendedWorkflowDynastySlug` $23.08).
  // An audience with NO measured audience grain anywhere is absent here and inherits the brand-level
  // fields — mirroring `pickAudienceOrBrandRow`'s fallback to the best workflow's brand row.
  const byAudience = new Map<string, AudienceProjectedCostsUsd>();
  for (const ev of audienceGrain) {
    let audienceUnits: DynastyUnitCosts | null = null;
    for (const dynasty of perDynasty) {
      const audEv = ev.byDynasty.get(dynasty.dynastySlug);
      if (!audEv || audEv.totalCostInUsdCents <= 0) continue;
      const measured = grainHasObservedOutcome(
        {
          spentUsd: audEv.totalCostInUsdCents / 100,
          observedContacted: audEv.contacted,
          observedClicks: audEv.clicks,
          observedPositiveReplies: audEv.replies,
        },
        objective,
        singleStepGoal,
        meetingChannel,
      );
      if (!measured) continue;
      const units = grainUnitCosts(audEv, dynasty.unitCosts);
      if (audienceUnits == null || units.clickUsd < audienceUnits.clickUsd) audienceUnits = units;
    }
    if (!audienceUnits) continue;
    const { cpfsUsd, cpsUsd, cpsaleUsd, costPerPaidClientUsd } = funnelCosts(audienceUnits);
    byAudience.set(ev.audienceId, { cpfsUsd, cpsUsd, cpsaleUsd, costPerPaidClientUsd });
  }

  return {
    cpcUsd: brandLevel.cpcUsd,
    cpprUsd: brandLevel.cpprUsd,
    cpfsUsd: brandLevel.cpfsUsd,
    cpsUsd: brandLevel.cpsUsd,
    cpsaleUsd: brandLevel.cpsaleUsd,
    cpsmUsd: brandLevel.cpsmUsd,
    byAudience,
    costPerPaidClientUsd: brandLevel.costPerPaidClientUsd,
    lifetimeRevenueUsd: economics?.lifetimeRevenueUsd ?? null,
    // A chain with no path to a paying client and one whose brand states no lifetime revenue both carry
    // no return, and they are NOT the same gap: the first is a leg the brand never declared, the second
    // is a price it never put on a customer.
    pricingReason:
      brandLevel.costPerPaidClientUsd == null || !(brandLevel.costPerPaidClientUsd > 0)
        ? "no_paid_client_path"
        : returnPerDollar(economics?.lifetimeRevenueUsd ?? null, brandLevel.costPerPaidClientUsd) == null
          ? "no_return_defined"
          : null,
  };
}
