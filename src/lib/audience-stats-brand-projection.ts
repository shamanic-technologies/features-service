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
 * The parent is the CROSS-ORG **BEST-WORKFLOW** benchmark, projected through the goal's funnel — NEVER a
 * cross-workflow POOLED average (Σ fleet spend ÷ Σ fleet outcomes). Standing product rule: we never
 * surface a cross-org PLUS cross-workflow pooled estimate; a fleet-wide estimate is cross-org plus the
 * BEST workflow, only. The pooled parent read ~3x the Strategy page's number for the same brand + goal +
 * moment (both labelled "fleet benchmark" in the UI → two prices for one thing). Per COLUMN, the parent is
 * therefore the MINIMUM cost of that outcome across workflow DYNASTIES:
 *   - a dynasty is eligible for a column only when it OBSERVED that column's driving outcome (clicks for
 *     the click-driven columns, positive replies for the reply-driven one). A dynasty with spend but 0 of
 *     the outcome has a meaningless ratio and must not win nor pollute the comparison — its channel reads
 *     null and simply contributes nothing (the SAME zero-contribution `projectOutcomeCosts` already
 *     applies to an absent channel).
 *   - version chains collapse first (`buildUpgradeChains` + `aggregateAcrossChains`, the SAME rollup
 *     crossOrg/brand use in workflow-projection) so a dynasty's versions are one workflow, not several.
 *
 * It is NOT floored by the brand's own aggregate spend: the per-audience floor is `max(audience spend, this
 * parent)`, so an audience's own spend still wins when it exceeds the fleet benchmark — mirroring
 * workflow-projection.resolved, which for a 0-outcome brand cascades down to the fleet cost. null per
 * column when the driving input is absent (no fleet clicks / replies on ANY workflow, or no economics for
 * the goal-projected columns) → the audience floor then degrades to own spend (never a fabricated parent).
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

/** One workflow DYNASTY's cross-org unit costs. A channel is null when the dynasty observed 0 of that
 * outcome — it is then INELIGIBLE for every column that outcome drives (never a meaningless ratio). */
interface DynastyUnitCosts {
  clickUsd: number | null;
  replyUsd: number | null;
}

/** The lowest POSITIVE value — the single best-performing workflow for that outcome. null when no
 * workflow is backed (no dynasty observed the driving outcome) → the audience floor degrades to own
 * spend, never a fabricated parent. */
function bestOf(values: Array<number | null>): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (value == null || !(value > 0)) continue;
    if (best == null || value < best) best = value;
  }
  return best;
}

/**
 * Compute the brand's fleet-backed projected cost-per-outcome parents for /audience-stats. Fans out to
 * the SAME cross-org sources as workflow-projection's crossOrg grain (workflow-service
 * `/public/workflows` + runs `/v1/stats/public/costs` + email-gateway `/public/stats`, all
 * feature-scoped, no brand filter → the fleet benchmark) plus the brand's effective economics, rolls the
 * version chains up into dynasties with the SAME `buildUpgradeChains` / `aggregateAcrossChains` rollup,
 * projects EACH dynasty through the shared engine, and takes the BEST (lowest) cost per column. Fails
 * loud on any downstream error (no silent fallback; NET fail-loud via fetchPublicCosts). Cross-org reads
 * are public (api-key only); the economics read is org-scoped.
 */
export async function fetchBrandProjectedParents(
  brandId: string,
  featureSlug: string,
  goal: Goal,
  identity: ProjectionIdentity,
  pricing: Pricing = "gross",
): Promise<BrandProjectedParentsUsd> {
  const [workflows, fleetCostGroups, fleetEmail, effective] = await Promise.all([
    fetchPublicWorkflows(featureSlug, "all"),
    fetchPublicCosts(featureSlug, "workflowSlug", pricing),
    fetchPublicEmailStats(featureSlug, "workflowSlug"),
    fetchEffectiveEconomics(brandId, identity),
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

  // Per-dynasty cross-org unit costs. A channel is populated ONLY when the dynasty OBSERVED that
  // outcome (clicks / positive replies > 0) — a 0-outcome dynasty's ratio is meaningless, so it stays
  // null and contributes nothing to any column it would drive (the same zero-contribution
  // projectOutcomeCosts already applies to an absent channel). No cascade floor here: this IS the top
  // grain, and flooring a 0-outcome dynasty to its own spend would let a barely-spent husk win the
  // comparison.
  const perDynasty: DynastyUnitCosts[] = [];
  for (const [activeSlug, cost] of costMap) {
    const spentUsd = cost.totalCostInUsdCents / 100;
    if (!(spentUsd > 0)) continue;
    const outcomes = aggregatedOutcomes.get(activeSlug) ?? {};
    const clicks = outcomes.recipientsClicked ?? 0;
    const replies = outcomes.recipientsRepliesPositive ?? 0;
    perDynasty.push({
      clickUsd: clicks > 0 ? projectedCostPerOutcome(spentUsd, clicks, null) : null,
      replyUsd: replies > 0 ? projectedCostPerOutcome(spentUsd, replies, null) : null,
    });
  }

  // cpc / cppr parents = the BEST workflow's raw unit cost (the visit / reply IS the outcome) —
  // available without economics. null when no workflow observed that outcome, never a false $0 parent.
  const cpcUsd = bestOf(perDynasty.map((d) => d.clickUsd));
  const cpprUsd = bestOf(perDynasty.map((d) => d.replyUsd));

  // The goal-projected columns (cpfs/cps/cpsale) need economics. When absent (cold start) their parents
  // are null → the floor degrades to own spend, never a fabricated parent. Each column projects EVERY
  // dynasty through the shared engine and takes the best — so the parent is the cost of the workflow
  // that is cheapest AT THAT OUTCOME, not a blend across workflows.
  const economics = effective.economics;
  let cpfsUsd: number | null = null;
  let cpsUsd: number | null = null;
  let cpsaleUsd: number | null = null;
  if (economics) {
    const econ = buildEcon(economics, goal);
    const projections = perDynasty.map((d) => projectOutcomeCosts(econ, { clickUsd: d.clickUsd, replyUsd: d.replyUsd }));
    cpfsUsd = bestOf(projections.map((p) => p.costPerFormSubmissionUsd));
    cpsUsd = bestOf(projections.map((p) => p.costPerSignupUsd));
    // sales → best-channel cost-per-sale; websitePurchase → multi-step close funnel — mirrors
    // outcomeCostForGoal (both terminate in a paying client, valued distinctly per goal).
    cpsaleUsd = bestOf(projections.map((p) => (goal === "sales" ? p.costPerSaleUsd : p.costPerPurchaseUsd)));
  }

  return { cpcUsd, cpprUsd, cpfsUsd, cpsUsd, cpsaleUsd };
}
