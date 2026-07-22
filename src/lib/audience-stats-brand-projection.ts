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
 * The parent is the CROSS-ORG fleet benchmark (a per-unit cost), projected through the goal's funnel. It
 * is NOT floored by the brand's own aggregate spend: the per-audience floor is `max(audience spend, this
 * parent)`, so an audience's own spend still wins when it exceeds the fleet benchmark — mirroring
 * workflow-projection.resolved, which for a 0-outcome brand cascades down to the fleet cost. null per
 * column when the driving input is absent (no fleet clicks / replies, or no economics for the
 * goal-projected columns) → the audience floor then degrades to own spend (never a fabricated parent).
 */

import { fetchPublicCosts, fetchPublicEmailStats } from "./public-stats-clients.js";
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

/**
 * Compute the brand's fleet-backed projected cost-per-outcome parents for /audience-stats. Fans out to
 * the SAME cross-org fleet unit-cost sources as workflow-projection (runs `/v1/stats/public/costs` +
 * email-gateway `/public/stats`, both feature-scoped, no brand filter → the fleet benchmark) plus the
 * brand's effective economics, then runs the shared projection engine. Fails loud on any downstream
 * error (no silent fallback; NET fail-loud via fetchPublicCosts). Cross-org reads are public (api-key
 * only); the economics read is org-scoped.
 */
export async function fetchBrandProjectedParents(
  brandId: string,
  featureSlug: string,
  goal: Goal,
  identity: ProjectionIdentity,
  pricing: Pricing = "gross",
): Promise<BrandProjectedParentsUsd> {
  const [fleetCostGroups, fleetEmail, effective] = await Promise.all([
    fetchPublicCosts(featureSlug, "workflowSlug", pricing),
    fetchPublicEmailStats(featureSlug, "workflowSlug"),
    fetchEffectiveEconomics(brandId, identity),
  ]);

  // crossOrg fleet aggregate (all workflows summed) — the fleet benchmark, grain-matched to
  // audience-stats' workflow-agnostic cost aggregation.
  let fleetSpentCents = 0;
  for (const g of fleetCostGroups) fleetSpentCents += Number(g.totalCostInUsdCents);
  let fleetClicks = 0;
  let fleetReplies = 0;
  for (const stats of fleetEmail.values()) {
    fleetClicks += stats.recipientsClicked ?? 0;
    fleetReplies += stats.recipientsRepliesPositive ?? 0;
  }
  const fleetSpentUsd = fleetSpentCents / 100;
  // Real fleet ratio (the fleet always has clicks/replies); the top grain has no coarser parent → floor
  // degrades to fleet spend, i.e. 0 (null cpc) only at true cold start.
  const crossOrgClickUsd = projectedCostPerOutcome(fleetSpentUsd, fleetClicks, null);
  const crossOrgReplyUsd = projectedCostPerOutcome(fleetSpentUsd, fleetReplies, null);

  // cpc / cppr parents = the raw fleet unit costs (the visit / reply IS the outcome) — available without
  // economics. A 0 value (cold start: no fleet spend) → null, never a false $0 parent.
  const cpcUsd = crossOrgClickUsd > 0 ? crossOrgClickUsd : null;
  const cpprUsd = crossOrgReplyUsd > 0 ? crossOrgReplyUsd : null;

  // The goal-projected columns (cpfs/cps/cpsale) need economics. When absent (cold start) their parents
  // are null → the floor degrades to own spend, never a fabricated parent.
  const economics = effective.economics;
  let cpfsUsd: number | null = null;
  let cpsUsd: number | null = null;
  let cpsaleUsd: number | null = null;
  if (economics) {
    const econ = buildEcon(economics, goal);
    const p = projectOutcomeCosts(econ, { clickUsd: cpcUsd, replyUsd: cpprUsd });
    cpfsUsd = p.costPerFormSubmissionUsd;
    cpsUsd = p.costPerSignupUsd;
    // sales → best-channel cost-per-sale; websitePurchase → multi-step close funnel — mirrors
    // outcomeCostForGoal (both terminate in a paying client, valued distinctly per goal).
    cpsaleUsd = goal === "sales" ? p.costPerSaleUsd : p.costPerPurchaseUsd;
  }

  return { cpcUsd, cpprUsd, cpfsUsd, cpsUsd, cpsaleUsd };
}
