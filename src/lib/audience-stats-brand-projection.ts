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
 * The per-audience floor is `max(audience spend, this parent)`, so an audience's own spend still wins when
 * it exceeds the benchmark — the documented cascade rule, mirroring workflow-projection. null per column
 * when the driving input is absent (no eligible workflow, or no economics for the goal-projected columns)
 * → the audience floor then degrades to own spend (never a fabricated parent).
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
import { fetchBrandWorkflowEvidence, type WorkflowGrainEvidence } from "./workflow-projection-grains.js";
import type { Pricing } from "./pricing.js";
import type { Goal } from "./goals.js";

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
 * Compute the brand's best-workflow projected cost-per-outcome parents for /audience-stats. Rebuilds
 * workflow-projection's BRAND-LEVEL rows from the SAME sources (workflow-service `/public/workflows` +
 * runs `/v1/stats/public/costs` + email-gateway `/public/stats` for the crossOrg grain, the brand-scoped
 * twins for the brand grain, plus the brand's effective economics), rolls version chains into dynasties
 * with the SAME `buildUpgradeChains` / `aggregateAcrossChains` rollup, and takes the winner of the
 * queried goal. Fails loud on any downstream error (no silent fallback; NET fail-loud via
 * fetchPublicCosts). Cross-org reads are public (api-key only); the brand + economics reads are
 * org-scoped.
 */
export async function fetchBrandProjectedParents(
  brandId: string,
  featureSlug: string,
  goal: Goal,
  identity: ProjectionIdentity,
  pricing: Pricing = "gross",
): Promise<BrandProjectedParentsUsd> {
  const workflows = await fetchPublicWorkflows(featureSlug, "all");
  const [fleetCostGroups, fleetEmail, effective, brandGrain] = await Promise.all([
    fetchPublicCosts(featureSlug, "workflowSlug", pricing),
    fetchPublicEmailStats(featureSlug, "workflowSlug"),
    fetchEffectiveEconomics(brandId, identity),
    fetchBrandWorkflowEvidence(brandId, featureSlug, workflows, identity, pricing),
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
    perDynasty.push({ unitCosts, observed: { observedClicks: ev.clicks, observedPositiveReplies: ev.replies } });
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
  let best: DynastyUnitCosts | null = null;
  if (econ) {
    let bestGoalCost: number | null = null;
    for (const d of eligible) {
      const goalCost = outcomeCostForGoal(econ, d.unitCosts, objective, singleStepGoal, formSubmissionGoal);
      if (goalCost == null || !(goalCost > 0)) continue;
      if (bestGoalCost == null || goalCost < bestGoalCost) {
        bestGoalCost = goalCost;
        best = d.unitCosts;
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
    };
  }

  // EVERY column reads THAT one workflow's resolved unit costs — the raw ones for cpc/cppr (the visit /
  // reply IS the outcome) and the shared projection engine for the funnel columns, exactly as the
  // workflow-projection row for that workflow does.
  const cpcUsd = best.clickUsd > 0 ? best.clickUsd : null;
  const cpprUsd = best.replyUsd > 0 ? best.replyUsd : null;
  const p = projectOutcomeCosts(econ!, { clickUsd: cpcUsd, replyUsd: cpprUsd });
  // sales → best-channel cost-per-sale; websitePurchase → multi-step close funnel — mirrors
  // outcomeCostForGoal (both terminate in a paying client, valued distinctly per goal).
  const cpsaleUsd = goal === "sales" ? p.costPerSaleUsd : p.costPerPurchaseUsd;

  return { cpcUsd, cpprUsd, cpfsUsd: p.costPerFormSubmissionUsd, cpsUsd: p.costPerSignupUsd, cpsaleUsd };
}
