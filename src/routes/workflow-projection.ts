import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchEffectiveEconomics } from "../lib/sales-economics-client.js";
import { projectOutcomeCosts, singleStepRateDecimal, formSubmissionRatesDecimal, type ProjectionEconomics } from "../lib/funnel-registry.js";
import { projectedCostPerOutcome } from "../lib/cost-engine.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { matchSingleStepGoal, matchFormSubmissionGoal, type SingleStepGoal } from "../lib/goals.js";
import {
  fetchPublicWorkflows,
  fetchPublicCosts,
  fetchPublicEmailStats,
} from "../lib/public-stats-clients.js";
import { buildUpgradeChains, aggregateAcrossChains } from "./public.js";
import {
  fetchBrandWorkflowEvidence,
  fetchAudienceGrainEvidence,
  type WorkflowGrainEvidence,
  type AudienceGrainEvidence,
  type Identity,
} from "../lib/workflow-projection-grains.js";

const router = Router();

// Target outcomes/month used to size the recommended budget (recommendedBudgetUsd = TARGET × best metric).
const TARGET_OUTCOMES_PER_MONTH = 10;

// website_visits / positive_replies are SINGLE-STEP goals (visit→paid / reply→paid). self-serve is a
// signup alias. The `objective` echo is the canonical snake spelling; the `goal` echo is the canonical
// camel spelling (= brand-service CurrentGoal). Both request params are normalised (any of the fleet's
// snake/camel/kebab spellings) via matchSingleStepGoal / matchFormSubmissionGoal.
type Objective = "meeting-booked" | "self-serve" | "signup" | "purchase" | "website_visits" | "positive_replies" | "form_submissions";
type GoalEcho = "meetingBooked" | "signup" | "purchase" | "websiteVisit" | "positiveReply" | "formSubmission";

// ── Response shape (3-grain ladder + resolved pick) ──────────────────────────

type GrainName = "crossOrg" | "brand" | "audience";

/** The three per-outcome unit costs of a grain — also the shape passed as the PARENT floor for the
 * next finer grain (crossOrg → brand → audience) via the projected cost-engine. */
interface GrainUnitCosts {
  costPerClickUsd: number;
  costPerPositiveReplyUsd: number;
  costPerContactedUsd: number;
}

interface GrainBlock {
  evidence: { spentUsd: number; observedContacted: number; observedClicks: number; observedPositiveReplies: number };
  unitCosts: GrainUnitCosts;
  projected: {
    costPerSignupUsd: number | null;
    costPerPaidClientUsd: number | null;
    costPerMeetingBookedUsd: number | null;
    roiMultiple: number | null;
    cacPct: number | null;
  };
}

interface ResolvedBlock {
  grain: GrainName;
  costPerClickUsd: number;
  costPerOutcomeUsd: number | null;
  costPerPaidClientUsd: number | null;
  costPerMeetingBookedUsd: number | null;
  roiMultiple: number | null;
  cacPct: number | null;
}

interface ProjectionRow {
  audienceId: string | null;
  workflow: { workflowDynastySlug: string; workflowDynastyName: string | null };
  estimatesByGrain: Partial<Record<GrainName, GrainBlock>>;
  resolved: ResolvedBlock;
}

interface EconomicsEcho {
  lifetimeRevenueUsd: number;
  visitToSignupPct: number;
  visitToMeetingPct: number;
  meetingToClosePct: number;
  visitToClosePct: number;
  replyToMeetingPct: number;
  visitToPaidClientPct?: number;
  replyToPaidClientPct?: number;
  visitToFormSubmissionPct?: number;
  formSubmissionToPaidClientPct?: number;
}

interface WorkflowProjectionResponse {
  featureSlug: string;
  objective: Objective;
  goal: GoalEcho;
  economics: EconomicsEcho | null;
  rows: ProjectionRow[];
  recommendedWorkflowDynastySlug: string | null;
  recommendedBudgetUsd: number | null;
}

/**
 * The PAID-CLIENT cost for the queried goal, single-sourced through projectOutcomeCosts. For a
 * single-step goal this is the ONE-rate cost (visit→paid / reply→paid); for form_submissions it is the
 * two-step form route (visit→form→paid); otherwise the multi-step purchase funnel. Drives ROI + the
 * recommended budget (never the zero-collapsing multi-step chain when a single-step goal is active).
 */
function paidClientCostForGoal(
  econ: ProjectionEconomics,
  unitCosts: { clickUsd: number | null; replyUsd: number | null },
  objective: Objective,
  singleStepGoal: SingleStepGoal | null,
  formSubmissionGoal: boolean,
): number | null {
  const p = projectOutcomeCosts(econ, unitCosts);
  if (singleStepGoal === "websiteVisit") return p.costPerVisitPaidClientUsd;
  if (singleStepGoal === "positiveReply") return p.costPerReplyPaidClientUsd;
  if (formSubmissionGoal) return p.costPerFormSubmissionPaidClientUsd;
  // Each goal's paid-client cost chains through ITS OWN funnel (coherent: always ≥ that goal's outcome
  // cost). signup/self-serve → visit→signup→paid; meeting-booked → the meeting→paid routes; purchase →
  // the full self-serve+meeting close funnel. Do NOT collapse signup/meeting onto costPerPurchase — its
  // rates are unrelated to their step and read incoherently below the goal's own outcome cost.
  if (objective === "purchase") return p.costPerPurchaseUsd;
  if (objective === "meeting-booked") return p.costPerMeetingPaidClientUsd;
  return p.costPerSignupPaidClientUsd; // signup / self-serve
}

/**
 * The GOAL metric (what campaign-service ranks on) — cost per signup / meeting-booked / paid-client
 * per goal. Mirrors the legacy `recommendedMetric` selection: single-step goals + purchase + form
 * submission close-route rank on the paid-client cost; meeting-booked on costPerMeetingBooked; signup /
 * self-serve on costPerSignup; form_submissions optimization metric on costPerFormSubmission.
 */
function outcomeCostForGoal(
  econ: ProjectionEconomics,
  unitCosts: { clickUsd: number | null; replyUsd: number | null },
  objective: Objective,
  singleStepGoal: SingleStepGoal | null,
  formSubmissionGoal: boolean,
): number | null {
  const p = projectOutcomeCosts(econ, unitCosts);
  if (singleStepGoal === "websiteVisit") return p.costPerVisitPaidClientUsd;
  if (singleStepGoal === "positiveReply") return p.costPerReplyPaidClientUsd;
  if (objective === "purchase") return p.costPerPurchaseUsd;
  if (objective === "meeting-booked") return p.costPerMeetingBookedUsd;
  if (formSubmissionGoal) return p.costPerFormSubmissionUsd;
  return p.costPerSignupUsd; // signup / self-serve
}

/**
 * Build ONE grain block from a grain's raw evidence + the brand economics. Unit costs run through the
 * PROJECTED cost-engine (`projectedCostPerOutcome`): a real ratio when observedX ≥ 1, else the cascade
 * floor `max(spentUsd, parentCost)` — the parent being the SAME unit cost on the next COARSER grain
 * (crossOrg → brand → audience). `parentUnitCosts = null` for crossOrg (no parent → floor = own spend).
 * Never null → projected goal costs are null ONLY when economics is null (cold start), never from a
 * zero-denominator. Caller only invokes this when spentUsd > 0 (spent-0 grains are omitted, rule 3).
 */
function buildGrainBlock(
  evidence: WorkflowGrainEvidence | AudienceGrainEvidence,
  econ: ProjectionEconomics | null,
  ltrUsd: number | null,
  objective: Objective,
  singleStepGoal: SingleStepGoal | null,
  formSubmissionGoal: boolean,
  parentUnitCosts: GrainUnitCosts | null = null,
): GrainBlock {
  const spentUsd = evidence.totalCostInUsdCents / 100;
  const observedContacted = evidence.contacted;
  const observedClicks = evidence.clicks;
  const observedPositiveReplies = evidence.replies;

  // Projected engine: observedX ≥ 1 → real ratio; observedX = 0 → cascade floor max(spentUsd, parentCost).
  const costPerClickUsd = projectedCostPerOutcome(spentUsd, observedClicks, parentUnitCosts?.costPerClickUsd ?? null);
  const costPerPositiveReplyUsd = projectedCostPerOutcome(spentUsd, observedPositiveReplies, parentUnitCosts?.costPerPositiveReplyUsd ?? null);
  const costPerContactedUsd = projectedCostPerOutcome(spentUsd, observedContacted, parentUnitCosts?.costPerContactedUsd ?? null);

  let projected: GrainBlock["projected"];
  if (!econ) {
    projected = {
      costPerSignupUsd: null,
      costPerPaidClientUsd: null,
      costPerMeetingBookedUsd: null,
      roiMultiple: null,
      cacPct: null,
    };
  } else {
    const unitCosts = { clickUsd: costPerClickUsd, replyUsd: costPerPositiveReplyUsd };
    const p = projectOutcomeCosts(econ, unitCosts);
    const costPerPaidClientUsd = paidClientCostForGoal(econ, unitCosts, objective, singleStepGoal, formSubmissionGoal);
    const roiMultiple = ltrUsd != null && costPerPaidClientUsd != null && costPerPaidClientUsd > 0 ? ltrUsd / costPerPaidClientUsd : null;
    const cacPct = roiMultiple != null && roiMultiple > 0 ? 100 / roiMultiple : null;
    projected = {
      costPerSignupUsd: p.costPerSignupUsd,
      costPerPaidClientUsd,
      costPerMeetingBookedUsd: p.costPerMeetingBookedUsd,
      roiMultiple,
      cacPct,
    };
  }

  return {
    evidence: { spentUsd, observedContacted, observedClicks, observedPositiveReplies },
    unitCosts: { costPerClickUsd, costPerPositiveReplyUsd, costPerContactedUsd },
    projected,
  };
}

/**
 * Resolve the finest-grain block present (precedence audience > brand > crossOrg), producing the
 * `resolved` pick. crossOrg always has spend, so resolved is never null-grain and costPerClickUsd is
 * never 0. costPerOutcomeUsd = the queried goal's metric at the resolved grain.
 */
function resolvePick(
  estimatesByGrain: Partial<Record<GrainName, GrainBlock>>,
  econ: ProjectionEconomics | null,
  objective: Objective,
  singleStepGoal: SingleStepGoal | null,
  formSubmissionGoal: boolean,
): ResolvedBlock {
  const grain: GrainName = estimatesByGrain.audience ? "audience" : estimatesByGrain.brand ? "brand" : "crossOrg";
  const block = estimatesByGrain[grain]!;
  const unitCosts = { clickUsd: block.unitCosts.costPerClickUsd, replyUsd: block.unitCosts.costPerPositiveReplyUsd };
  const costPerOutcomeUsd = econ ? outcomeCostForGoal(econ, unitCosts, objective, singleStepGoal, formSubmissionGoal) : null;
  return {
    grain,
    costPerClickUsd: block.unitCosts.costPerClickUsd,
    costPerOutcomeUsd,
    costPerPaidClientUsd: block.projected.costPerPaidClientUsd,
    costPerMeetingBookedUsd: block.projected.costPerMeetingBookedUsd,
    roiMultiple: block.projected.roiMultiple,
    cacPct: block.projected.cacPct,
  };
}

// ── GET /features/:featureSlug/workflow-projection ───────────────────────────
//
// Serves a 3-grain projection ladder (crossOrg → brand → audience) + a resolved pick, keyed per
// (audienceId?, workflowDynasty). crossOrg = fleet unit costs (same source as /public/stats/best);
// brand = the same path scoped to this brandId; audience = audience-attributed evidence for each active
// human-service audience that ran the workflow. Each grain carries its own evidence, floor-ruled unit
// costs (never null), and projected cost-per-outcome from the brand's EFFECTIVE economics. The consumer
// (campaign-service) ranks on resolved.costPerOutcomeUsd.

router.get("/features/:featureSlug/workflow-projection", apiKeyAuth, async (req, res) => {
  const { featureSlug } = req.params;
  const { orgId, userId, runId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;
  const brandId = req.query.brandId as string | undefined;
  // Accept BOTH `goal` (camel, campaign-service) and `objective` (snake/kebab, dashboard) params.
  const goalParam = (req.query.goal as string | undefined) ?? (req.query.objective as string | undefined);
  const budgetRaw = req.query.budgetUsd as string | undefined;

  if (!brandId) {
    return res.status(400).json({ error: "brandId query parameter is required" });
  }

  const singleStepGoal: SingleStepGoal | null = goalParam ? matchSingleStepGoal(goalParam) : null;
  const formSubmissionGoal: boolean = goalParam ? matchFormSubmissionGoal(goalParam) !== null : false;
  const objective: Objective =
    singleStepGoal === "websiteVisit" ? "website_visits"
      : singleStepGoal === "positiveReply" ? "positive_replies"
      : formSubmissionGoal ? "form_submissions"
      : goalParam === "self-serve" || goalParam === "signup" || goalParam === "purchase"
        ? goalParam
        : "meeting-booked";
  // Canonical camel goal echo (= brand-service CurrentGoal). self-serve aliases signup.
  const goal: GoalEcho =
    objective === "website_visits" ? "websiteVisit"
      : objective === "positive_replies" ? "positiveReply"
      : objective === "form_submissions" ? "formSubmission"
      : objective === "purchase" ? "purchase"
      : objective === "self-serve" || objective === "signup" ? "signup"
      : "meetingBooked";
  const budgetUsd = budgetRaw != null && budgetRaw !== "" ? Number(budgetRaw) : null;

  try {
    const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
    if (!feature) {
      return res.status(404).json({ error: "Feature not found" });
    }
    // budgetUsd is accepted for back-compat but does not shape the body (grain ladder +
    // recommendedBudgetUsd cover the projection) → excluded from the cache key.
    void budgetUsd;

    // Gold SWR: the heavy cross-org + brand + audience fan-out runs off the request path ~once per
    // TTL; keyed on the inputs that shape the body (orgId + brand + goal). Response is byte-identical.
    const response = await servedCached({
      view: "workflow-projection",
      scopeKey: buildScopeKey(featureSlug, { orgId, brandId, objective }),
      orgId,
      compute: async (): Promise<WorkflowProjectionResponse> => {
    const identity: Identity = { orgId, userId, runId, featureSlug: headerFeatureSlug };

    // The workflow list is needed by the crossOrg AND brand dynasty rollups, so fetch it first; the
    // brand grain then fans out in parallel with the remaining reads.
    const workflows = await fetchPublicWorkflows(featureSlug, "all");
    // Fleet slug→dynasty map (cross-org): the audience-grain couples roll their raw workflow slugs up
    // to dynasties LOCALLY with this, matching the crossOrg/brand grains and avoiding runs-service's
    // dynasty-regroup collapse (which drops all-but-one audience per dynasty).
    const slugToDynasty = new Map(workflows.map((w) => [w.workflowSlug, w.workflowDynastySlug]));
    const [costGroups, emailStats, effective, brandGrain, audienceEvidence] = await Promise.all([
      fetchPublicCosts(featureSlug, "workflowSlug"),
      fetchPublicEmailStats(featureSlug, "workflowSlug"),
      fetchEffectiveEconomics(brandId, identity),
      fetchBrandWorkflowEvidence(brandId, featureSlug, workflows, identity),
      fetchAudienceGrainEvidence(brandId, featureSlug, slugToDynasty, identity),
    ]);
    const economics = effective.economics;

    // crossOrg dynasty rollup (identical to /public/stats/best).
    const chains = buildUpgradeChains(workflows);
    const { costMap, aggregatedOutcomes } = aggregateAcrossChains(chains, costGroups, emailStats, "workflowSlug");
    const workflowBySlug = new Map(workflows.map((w) => [w.workflowSlug, w]));
    const dynastyNameBySlug = new Map(workflows.map((w) => [w.workflowDynastySlug, w.workflowDynastyName]));

    // Brand economics as decimals, with the goal's extra rates resolved fail-loud ONLY when needed.
    const econ: ProjectionEconomics | null = economics
      ? {
          r2m: economics.replyToMeetingPct / 100,
          v2m: economics.visitToMeetingPct / 100,
          m2c: economics.meetingToClosePct / 100,
          v2c: economics.visitToClosePct / 100,
          v2s: economics.visitToSignupPct / 100,
          s2pc: economics.signupToPaidClientPct / 100,
          ...(singleStepGoal === "websiteVisit" ? { v2pc: singleStepRateDecimal(economics, "websiteVisit") } : {}),
          ...(singleStepGoal === "positiveReply" ? { r2pc: singleStepRateDecimal(economics, "positiveReply") } : {}),
          ...(formSubmissionGoal ? formSubmissionRatesDecimal(economics) : {}),
        }
      : null;
    const ltrUsd = economics?.lifetimeRevenueUsd ?? null;

    // economics echo — the brand's effective economics, shown ONCE (same across grains). Includes the
    // goal's resolved single-step / form-submission rates, mirroring the econ mapping above.
    const economicsEcho: EconomicsEcho | null = economics
      ? {
          lifetimeRevenueUsd: economics.lifetimeRevenueUsd,
          visitToSignupPct: economics.visitToSignupPct,
          visitToMeetingPct: economics.visitToMeetingPct,
          meetingToClosePct: economics.meetingToClosePct,
          visitToClosePct: economics.visitToClosePct,
          replyToMeetingPct: economics.replyToMeetingPct,
          ...(singleStepGoal === "websiteVisit" ? { visitToPaidClientPct: economics.visitToPaidClientPct } : {}),
          ...(singleStepGoal === "positiveReply" ? { replyToPaidClientPct: economics.replyToPaidClientPct } : {}),
          ...(formSubmissionGoal
            ? {
                visitToFormSubmissionPct: economics.visitToFormSubmissionPct,
                formSubmissionToPaidClientPct: economics.formSubmissionToPaidClientPct,
              }
            : {}),
        }
      : null;

    const buildBlock = (
      ev: WorkflowGrainEvidence | AudienceGrainEvidence,
      parentUnitCosts: GrainUnitCosts | null = null,
    ): GrainBlock =>
      buildGrainBlock(ev, econ, ltrUsd, objective, singleStepGoal, formSubmissionGoal, parentUnitCosts);
    const resolve = (grains: Partial<Record<GrainName, GrainBlock>>): ResolvedBlock =>
      resolvePick(grains, econ, objective, singleStepGoal, formSubmissionGoal);

    const rows: ProjectionRow[] = [];

    // ── Brand-level rows (audienceId: null), one per active workflow dynasty ────────────────────
    // Keyed by the dynasty's active slug. crossOrg grain always present (real fleet spend); brand grain
    // added only when the brand spent on the dynasty (spentUsd > 0).
    for (const [activeSlug, cost] of costMap) {
      const wf = workflowBySlug.get(activeSlug);
      const outcomes = aggregatedOutcomes.get(activeSlug) ?? {};
      const crossOrgEvidence: WorkflowGrainEvidence = {
        totalCostInUsdCents: cost.totalCostInUsdCents,
        completedRuns: cost.completedRuns,
        contacted: outcomes.recipientsContacted ?? 0,
        clicks: outcomes.recipientsClicked ?? 0,
        replies: outcomes.recipientsRepliesPositive ?? 0,
      };

      // Cascade: crossOrg (no parent) → brand floors against crossOrg. Build coarser-first so the
      // finer grain can floor against the coarser grain's resolved unit costs.
      const estimatesByGrain: Partial<Record<GrainName, GrainBlock>> = {};
      if (crossOrgEvidence.totalCostInUsdCents > 0) estimatesByGrain.crossOrg = buildBlock(crossOrgEvidence);
      const brandEv = brandGrain.get(activeSlug);
      if (brandEv && brandEv.totalCostInUsdCents > 0) {
        estimatesByGrain.brand = buildBlock(brandEv, estimatesByGrain.crossOrg?.unitCosts ?? null);
      }

      // crossOrg is (almost) always present, but if a dynasty had 0 crossOrg cost AND 0 brand cost there
      // is no grain to resolve — skip the row (nothing to project).
      if (!estimatesByGrain.crossOrg && !estimatesByGrain.brand) continue;

      rows.push({
        audienceId: null,
        workflow: {
          workflowDynastySlug: wf?.workflowDynastySlug ?? activeSlug,
          workflowDynastyName: wf?.workflowDynastyName ?? null,
        },
        estimatesByGrain,
        resolved: resolve(estimatesByGrain),
      });
    }

    // ── Audience rows — one per (audienceId × workflowDynasty) couple that ran ──────────────────
    // crossOrg + brand grains resolve by the dynasty (keyed on the dynasty's active slug); the audience
    // grain's raw evidence is audience-WIDE (same numbers across the audience's couple rows), but the
    // block is built PER COUPLE because its cascade-floor PARENT (brand → crossOrg) is per-dynasty — an
    // audience with 0 observed outcomes floors against THIS couple's brand/crossOrg cost. When the
    // audience has observed outcomes the ratio is identical across couples (parent unused).
    // Precedence audience > brand > crossOrg → these rows resolve at the audience grain when it has spend.
    // Map dynastySlug → active workflow slug (for crossOrg/brand grain lookup keyed on active slug).
    const activeSlugByDynasty = new Map<string, string>();
    for (const [activeSlug, wf] of workflowBySlug) {
      if (wf.status === "active") activeSlugByDynasty.set(wf.workflowDynastySlug, activeSlug);
    }

    for (const ev of audienceEvidence) {
      for (const dynastySlug of ev.workflowDynastySlugs) {
        const activeSlug = activeSlugByDynasty.get(dynastySlug);

        // Cascade: crossOrg (no parent) → brand (parent crossOrg) → audience (parent brand ?? crossOrg).
        const estimatesByGrain: Partial<Record<GrainName, GrainBlock>> = {};
        if (activeSlug) {
          const cost = costMap.get(activeSlug);
          if (cost && cost.totalCostInUsdCents > 0) {
            const outcomes = aggregatedOutcomes.get(activeSlug) ?? {};
            estimatesByGrain.crossOrg = buildBlock({
              totalCostInUsdCents: cost.totalCostInUsdCents,
              completedRuns: cost.completedRuns,
              contacted: outcomes.recipientsContacted ?? 0,
              clicks: outcomes.recipientsClicked ?? 0,
              replies: outcomes.recipientsRepliesPositive ?? 0,
            });
          }
          const brandEv = brandGrain.get(activeSlug);
          if (brandEv && brandEv.totalCostInUsdCents > 0) {
            estimatesByGrain.brand = buildBlock(brandEv, estimatesByGrain.crossOrg?.unitCosts ?? null);
          }
        }
        const audienceParent = estimatesByGrain.brand?.unitCosts ?? estimatesByGrain.crossOrg?.unitCosts ?? null;
        if (ev.totalCostInUsdCents > 0) estimatesByGrain.audience = buildBlock(ev, audienceParent);

        // A couple with no grain at all (no crossOrg/brand/audience spend) has nothing to project.
        if (!estimatesByGrain.crossOrg && !estimatesByGrain.brand && !estimatesByGrain.audience) continue;

        rows.push({
          audienceId: ev.audienceId,
          workflow: {
            workflowDynastySlug: dynastySlug,
            workflowDynastyName: dynastyNameBySlug.get(dynastySlug) ?? null,
          },
          estimatesByGrain,
          resolved: resolve(estimatesByGrain),
        });
      }
    }

    // Recommendation: the row with the LOWEST resolved cost-per-outcome for the requested goal.
    let recommended: ProjectionRow | null = null;
    for (const row of rows) {
      const metric = row.resolved.costPerOutcomeUsd;
      if (metric == null || metric <= 0) continue;
      const current = recommended?.resolved.costPerOutcomeUsd ?? null;
      if (current == null || metric < current) recommended = row;
    }
    const recommendedCost = recommended?.resolved.costPerOutcomeUsd ?? null;

    return {
      featureSlug,
      objective,
      goal,
      economics: economicsEcho,
      rows,
      recommendedWorkflowDynastySlug: recommended?.workflow.workflowDynastySlug ?? null,
      recommendedBudgetUsd: recommendedCost != null ? TARGET_OUTCOMES_PER_MONTH * recommendedCost : null,
    };
      },
    });
    res.json(response);
  } catch (error) {
    console.error("[features-service] Workflow projection error:", error);
    res.status(502).json({ error: "Failed to compute workflow projection" });
  }
});

export default router;
