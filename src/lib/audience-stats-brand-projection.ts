/**
 * Brand-level FLEET-BACKED projected cost-per-outcome — the floor parent for /audience-stats.
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
 *   - A dynasty that OBSERVED none of the goal's driving outcome is INELIGIBLE (shared
 *     `grainHasObservedOutcome`): with the cascade floor its unit costs collapse to its own spend, so a
 *     barely-spent husk would otherwise be crowned the cheapest workflow. Its ratio is meaningless.
 *   - Version chains collapse first (`buildUpgradeChains` + `aggregateAcrossChains`, the SAME rollup
 *     crossOrg/brand use in workflow-projection) so a dynasty's versions are one workflow, not several.
 *
 * Having picked the winner, the module continues the SAME ladder ONE grain finer and returns, per
 * audience, that workflow's FUNNEL costs at the AUDIENCE grain (`byAudience`) — the value every DERIVED
 * column (form submission / signup / sale) takes at 0 outcomes:
 *   - The audience's own per-(audience × winning dynasty) send-tag evidence runs through the SAME
 *     `grainUnitCosts` cascade, floored against the winner's brand-level unit costs, then through
 *     `projectOutcomeCosts` — byte-for-byte what `resolvePick` resolves for that row, so the Audiences
 *     table and the Strategy page report ONE number for one concept.
 *   - An audience with no send-tag evidence on the winner is absent from the map and inherits the
 *     brand-level fields, the same audience → brand fallback `resolvePick` makes.
 *
 * Why the derived columns can NOT floor on the audience's raw dollar total (the bug this fixes): a raw
 * total is a sound lower bound only for a RAW column, where the driving outcome IS the outcome. Answering
 * "cost per form submission" with a total spend is a units error, and it discards the clicks the audience
 * did observe — prod showed three audiences whose cost-per-form-submission equalled their own net spend to
 * the cent while the Strategy page priced the same audiences 2-4x lower. The RAW columns (cpc / cppr) keep
 * the plain `max(audience spend, this parent)` floor, and the "own spend wins above the benchmark" rule
 * survives on the derived columns too — one grain down, inside `grainUnitCosts`, where a 0-click audience
 * grain floors its click to `max(own spend, parent)` before the funnel converts it into a per-outcome cost.
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
import { goalToProjectionInputs, outcomeCostForGoal, grainHasObservedOutcome } from "../routes/workflow-projection.js";
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
}

/**
 * Fleet-backed projected cost-per-outcome (USD) per /audience-stats cost column. Each field is the
 * PARENT the corresponding column floors against at 0 outcomes. null when the driving input is absent.
 */
export interface BrandProjectedParentsUsd {
  cpcUsd: number | null; // cost per website visit (raw fleet CPC)
  cpprUsd: number | null; // cost per positive reply (raw fleet CPPR)
  cpfsUsd: number | null; // cost per form submission (projected)
  cpsUsd: number | null; // cost per signup (projected)
  cpsaleUsd: number | null; // cost per sale (goal=sales → best-channel; goal=websitePurchase → close funnel)
  /**
   * Per-audience FUNNEL costs under the winning workflow — the value each DERIVED column takes at 0
   * outcomes, instead of the audience's raw dollar total. Keyed by audienceId; an audience absent from
   * the map (no send-tag evidence on the winner) inherits the brand-level fields above, exactly as
   * `resolvePick` falls back from the audience grain to the brand grain. Empty at cold start.
   */
  byAudience: Map<string, AudienceProjectedCostsUsd>;
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
export async function fetchBrandProjectedParents(
  brandId: string,
  featureSlug: string,
  goal: Goal,
  identity: ProjectionIdentity,
  pricing: Pricing = "gross",
  // The caller's already-resolved audience ids (it fetched them by requested status) — reused for the
  // audience grain so this adds no human-service round-trip and covers every row the caller will render.
  audienceIds?: string[],
): Promise<BrandProjectedParentsUsd> {
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

  const economics = effective.economics;
  const econ = economics ? buildEcon(economics, goal) : null;

  // THE single best workflow for the queried goal: among the dynasties that OBSERVED the goal's driving
  // outcome (shared `grainHasObservedOutcome` — a 0-outcome husk's cascade-floored unit costs collapse
  // to its own spend and would otherwise be crowned cheapest), the LOWEST cost of the goal's own outcome
  // scored through the shared `outcomeCostForGoal` — the SAME goal→cost routing workflow-projection
  // ranks its rows on, so both surfaces crown the same workflow for a goal.
  const { objective, singleStepGoal, formSubmissionGoal } = goalToProjectionInputs(goal);
  const eligible = perDynasty.filter((d) =>
    grainHasObservedOutcome({ spentUsd: 0, observedContacted: 0, ...d.observed }, objective, singleStepGoal),
  );
  let best: DynastyRow | null = null;
  if (econ) {
    let bestGoalCost: number | null = null;
    for (const d of eligible) {
      const goalCost = outcomeCostForGoal(econ, d.unitCosts, objective, singleStepGoal, formSubmissionGoal);
      if (goalCost == null || !(goalCost > 0)) continue;
      if (bestGoalCost == null || goalCost < bestGoalCost) {
        bestGoalCost = goalCost;
        best = d;
      }
    }
  }

  if (!best) {
    // COLD START / unscoreable goal: no economics (workflow-projection reports no cost-per-outcome
    // either, so there is nothing to be coherent with) or no eligible dynasty scores the goal. Still
    // serve the two RAW unit-cost parents — each the best ELIGIBLE workflow at that outcome — so the
    // cpc/cppr columns keep a benchmark floor instead of collapsing to each audience's own tiny spend.
    // The goal-projected columns stay null (never a fabricated parent).
    return {
      cpcUsd: bestOf(eligible.map((d) => (d.observed.observedClicks > 0 ? d.unitCosts.clickUsd : null))),
      cpprUsd: bestOf(eligible.map((d) => (d.observed.observedPositiveReplies > 0 ? d.unitCosts.replyUsd : null))),
      cpfsUsd: null,
      cpsUsd: null,
      cpsaleUsd: null,
      byAudience: new Map(),
    };
  }

  // EVERY column reads THAT one workflow's resolved unit costs — the raw ones for cpc/cppr (the visit /
  // reply IS the outcome) and the shared projection engine for the funnel columns, exactly as the
  // workflow-projection row for that workflow does.
  const bestUnits = best.unitCosts;
  const funnelCosts = (units: DynastyUnitCosts): AudienceProjectedCostsUsd & { cpcUsd: number | null; cpprUsd: number | null } => {
    const cpcUsd = units.clickUsd > 0 ? units.clickUsd : null;
    const cpprUsd = units.replyUsd > 0 ? units.replyUsd : null;
    const p = projectOutcomeCosts(econ!, { clickUsd: cpcUsd, replyUsd: cpprUsd });
    // sales → best-channel cost-per-sale; websitePurchase → multi-step close funnel — mirrors
    // outcomeCostForGoal (both terminate in a paying client, valued distinctly per goal).
    const cpsaleUsd = goal === "sales" ? p.costPerSaleUsd : p.costPerPurchaseUsd;
    return { cpcUsd, cpprUsd, cpfsUsd: p.costPerFormSubmissionUsd, cpsUsd: p.costPerSignupUsd, cpsaleUsd };
  };
  const brandLevel = funnelCosts(bestUnits);

  // Continue the SAME ladder ONE grain finer, for the winning dynasty only: an audience with send-tag
  // evidence on that dynasty resolves at its OWN unit costs, cascade-floored against the brand-level
  // winner (`grainUnitCosts` = `buildGrainBlock`'s unit costs), then pushed through the SAME funnel. That
  // is byte-for-byte `resolvePick`'s NUMBER selection for the (audience × winning dynasty) row, so the
  // Audiences table and the Strategy page report the identical number. An audience with no evidence on
  // the winner is absent here and inherits the brand-level fields — again mirroring `resolvePick`, which
  // falls back to the brand grain when the audience grain has no spend.
  const byAudience = new Map<string, AudienceProjectedCostsUsd>();
  for (const ev of audienceGrain) {
    const audEv = ev.byDynasty.get(best.dynastySlug);
    if (!audEv || audEv.totalCostInUsdCents <= 0) continue;
    const { cpfsUsd, cpsUsd, cpsaleUsd } = funnelCosts(grainUnitCosts(audEv, bestUnits));
    byAudience.set(ev.audienceId, { cpfsUsd, cpsUsd, cpsaleUsd });
  }

  return {
    cpcUsd: brandLevel.cpcUsd,
    cpprUsd: brandLevel.cpprUsd,
    cpfsUsd: brandLevel.cpfsUsd,
    cpsUsd: brandLevel.cpsUsd,
    cpsaleUsd: brandLevel.cpsaleUsd,
    byAudience,
  };
}
