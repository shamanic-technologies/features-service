import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchEffectiveEconomics } from "../lib/sales-economics-client.js";
import { projectOutcomeCosts, singleStepRateDecimal, formSubmissionRatesDecimal, type ProjectionEconomics } from "../lib/funnel-registry.js";
import { projectedCostPerOutcome } from "../lib/cost-engine.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { parsePricing, type Pricing } from "../lib/pricing.js";
import { matchSingleStepGoal, matchFormSubmissionGoal, matchWhatsappGoal, matchCombinedSalesGoal, matchWebsitePurchaseGoal, type SingleStepGoal, type Goal } from "../lib/goals.js";
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
// whatsapp_conversations is a SINGLE-STEP, CLICK-outcome goal (the click on the brand's WhatsApp link
// IS a started conversation). Its cost-per-outcome = CPC and it carries NO paid-client/ROI economics
// (brand-service exposes no whatsapp→paid rate) — see outcomeCostForGoal / paidClientCostForGoal.
// website_purchase is the RENAMED former `purchase` objective (multi-step self-serve / meeting close).
// sales is the NEW COMBINED goal (a paying client won via EITHER the visit→paid OR the reply→paid path,
// valued at CLTV) — its cost-per-outcome == cost-per-paid-client == cost-per-sale (the outcome IS the
// paying client). See outcomeCostForGoal / paidClientCostForGoal.
export type Objective = "meeting-booked" | "self-serve" | "signup" | "website_purchase" | "sales" | "website_visits" | "positive_replies" | "form_submissions" | "whatsapp_conversations";
export type GoalEcho = "meetingBooked" | "signup" | "websitePurchase" | "sales" | "websiteVisit" | "positiveReply" | "formSubmission" | "whatsappConversation";

// ── Response shape (3-grain ladder + resolved pick) ──────────────────────────

export type GrainName = "crossOrg" | "brand" | "audience";

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

export interface ProjectionRow {
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

export interface WorkflowProjectionResponse {
  featureSlug: string;
  objective: Objective;
  goal: GoalEcho;
  economics: EconomicsEcho | null;
  rows: ProjectionRow[];
  recommendedWorkflowDynastySlug: string | null;
  recommendedBudgetUsd: number | null;
}

/**
 * Map a canonical brand `Goal` (brand-service CurrentGoal camelCase, as resolved by
 * `fetchBrandSavedEconomicsWithGoal`) to the four workflow-projection compute inputs (objective echo,
 * goal echo, single-step goal, form-submission flag). Mirrors the route's goalParam→inputs derivation
 * so an internal caller that already holds a resolved `Goal` (e.g. the customer-health board) can invoke
 * `computeWorkflowProjection` with the SAME semantics the dashboard route produces.
 */
export function goalToProjectionInputs(goal: Goal): {
  objective: Objective;
  goalEcho: GoalEcho;
  singleStepGoal: SingleStepGoal | null;
  formSubmissionGoal: boolean;
} {
  switch (goal) {
    case "websiteVisit":
      return { objective: "website_visits", goalEcho: "websiteVisit", singleStepGoal: "websiteVisit", formSubmissionGoal: false };
    case "positiveReply":
      return { objective: "positive_replies", goalEcho: "positiveReply", singleStepGoal: "positiveReply", formSubmissionGoal: false };
    case "formSubmission":
      return { objective: "form_submissions", goalEcho: "formSubmission", singleStepGoal: null, formSubmissionGoal: true };
    case "websitePurchase":
      return { objective: "website_purchase", goalEcho: "websitePurchase", singleStepGoal: null, formSubmissionGoal: false };
    case "sales":
      return { objective: "sales", goalEcho: "sales", singleStepGoal: null, formSubmissionGoal: false };
    case "signup":
      return { objective: "signup", goalEcho: "signup", singleStepGoal: null, formSubmissionGoal: false };
    case "meetingBooked":
      return { objective: "meeting-booked", goalEcho: "meetingBooked", singleStepGoal: null, formSubmissionGoal: false };
  }
}

type GoalInputs = { objective: Objective; goal: GoalEcho; singleStepGoal: SingleStepGoal | null; formSubmissionGoal: boolean };

/**
 * Resolve the request's `goal`/`objective` param (ANY fleet spelling) into the four compute inputs.
 * ABSENT → meeting-booked default (preserved). PRESENT but UNRECOGNISED → `{ ok: false }` (the route
 * returns 400 — unknown goal fails loud, never a silent default). Single source for the route so every
 * goal — including the renamed `websitePurchase` and the new combined `sales` — routes identically.
 */
function resolveGoalInputs(raw: string | undefined): ({ ok: true } & GoalInputs) | { ok: false } {
  if (raw == null || raw === "") {
    return { ok: true, objective: "meeting-booked", goal: "meetingBooked", singleStepGoal: null, formSubmissionGoal: false };
  }
  const single = matchSingleStepGoal(raw);
  if (single === "websiteVisit") return { ok: true, objective: "website_visits", goal: "websiteVisit", singleStepGoal: "websiteVisit", formSubmissionGoal: false };
  if (single === "positiveReply") return { ok: true, objective: "positive_replies", goal: "positiveReply", singleStepGoal: "positiveReply", formSubmissionGoal: false };
  if (matchFormSubmissionGoal(raw)) return { ok: true, objective: "form_submissions", goal: "formSubmission", singleStepGoal: null, formSubmissionGoal: true };
  if (matchWhatsappGoal(raw)) return { ok: true, objective: "whatsapp_conversations", goal: "whatsappConversation", singleStepGoal: null, formSubmissionGoal: false };
  if (matchCombinedSalesGoal(raw)) return { ok: true, objective: "sales", goal: "sales", singleStepGoal: null, formSubmissionGoal: false };
  if (matchWebsitePurchaseGoal(raw)) return { ok: true, objective: "website_purchase", goal: "websitePurchase", singleStepGoal: null, formSubmissionGoal: false };
  if (raw === "self-serve") return { ok: true, objective: "self-serve", goal: "signup", singleStepGoal: null, formSubmissionGoal: false };
  if (raw === "signup" || raw === "signups") return { ok: true, objective: "signup", goal: "signup", singleStepGoal: null, formSubmissionGoal: false };
  const meetingNorm = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (meetingNorm === "meetingbooked" || meetingNorm === "bookedmeetings" || meetingNorm === "bookedmeeting") {
    return { ok: true, objective: "meeting-booked", goal: "meetingBooked", singleStepGoal: null, formSubmissionGoal: false };
  }
  return { ok: false };
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
  // whatsapp_conversations has NO paid-client rate (brand-service exposes none) → null, null-safe. The
  // click on the WhatsApp link IS the tracked outcome; there is no downstream paid-client economics.
  if (objective === "whatsapp_conversations") return null;
  if (singleStepGoal === "websiteVisit") return p.costPerVisitPaidClientUsd;
  if (singleStepGoal === "positiveReply") return p.costPerReplyPaidClientUsd;
  if (formSubmissionGoal) return p.costPerFormSubmissionPaidClientUsd;
  // COMBINED-SALES: the outcome IS the paying client (a sale won via EITHER path), so the paid-client
  // cost == the outcome cost == cost-per-sale. ROI = CLTV / costPerSale.
  if (objective === "sales") return p.costPerSaleUsd;
  // Each goal's paid-client cost chains through ITS OWN funnel (coherent: always ≥ that goal's outcome
  // cost). signup/self-serve → visit→signup→paid; meeting-booked → the meeting→paid routes; website
  // purchase → the full self-serve+meeting close funnel. Do NOT collapse signup/meeting onto the close
  // funnel — its rates are unrelated to their step and read incoherently below the goal's own cost.
  if (objective === "website_purchase") return p.costPerPurchaseUsd;
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
  // whatsapp_conversations: the click on the WhatsApp link IS the outcome (a started conversation) →
  // its RAW unit cost = CPC (reuses the existing click evidence), exactly like websiteVisit.
  if (objective === "whatsapp_conversations") return unitCosts.clickUsd;
  // Single-step goals: the visit / reply IS the tracked outcome → its RAW unit cost (CPC / CPPR), NOT
  // the downstream paid-client cost (that is costPerPaidClient, which differs by the visit/reply→paid
  // rate). Returning the paid-client cost here made cost-per-outcome == cost-per-paid-client — an
  // internally-incoherent pair whenever the rate < 100% (a paid client cannot cost the same as a single
  // positive reply when only 15% of replies convert). Mirrors audience-stats (websiteVisit→CPC,
  // positiveReply→CPPR) + the cross-org objective→cost doctrine ("the visit / reply IS the outcome").
  if (singleStepGoal === "websiteVisit") return unitCosts.clickUsd;
  if (singleStepGoal === "positiveReply") return unitCosts.replyUsd;
  // COMBINED-SALES: the outcome IS a sale (paying client) via EITHER path → cost-per-sale (additive
  // population expected-count, projectOutcomeCosts.costPerSaleUsd). Equals its cost-per-paid-client.
  if (objective === "sales") return p.costPerSaleUsd;
  if (objective === "website_purchase") return p.costPerPurchaseUsd;
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
 * A grain's cost-per-outcome is MEASURED (derived from THIS grain's realized outcomes) only when the
 * grain observed the goal's driving-channel outcome — positive replies for `positiveReply`, clicks for
 * the click-driven goals (websiteVisit / signup / form_submissions), either channel for meeting-booked /
 * purchase (both funnel from clicks + replies). When a grain has spend but 0 of that outcome, its unit
 * cost is a cascade-FLOORED projection, NOT a measured ratio — so it must NOT carry that grain's "own
 * results" provenance ("From this brand's own results"). resolvePick uses this only for the PROVENANCE
 * label (not the number): a non-measured finest grain keeps its floored spend as the resolved NUMBER but
 * is labelled crossOrg (benchmark).
 */
function grainHasObservedOutcome(
  ev: GrainBlock["evidence"],
  objective: Objective,
  singleStepGoal: SingleStepGoal | null,
): boolean {
  if (singleStepGoal === "positiveReply") return ev.observedPositiveReplies > 0;
  if (singleStepGoal === "websiteVisit") return ev.observedClicks > 0;
  // whatsapp_conversations is click-driven (the WhatsApp-link click IS the outcome).
  if (objective === "whatsapp_conversations") return ev.observedClicks > 0;
  if (objective === "signup" || objective === "self-serve" || objective === "form_submissions")
    return ev.observedClicks > 0;
  // meeting-booked / purchase funnel from BOTH channels → either observed outcome makes it measured.
  return ev.observedClicks > 0 || ev.observedPositiveReplies > 0;
}

/**
 * Resolve the `resolved` pick. TWO independent selections that must NOT be conflated:
 *
 *  • NUMBERS (costPer*, roi, cac) come from the finest grain WITH SPEND (audience > brand > crossOrg).
 *    That grain's unit costs already encode the cascade floor `max(spentUsd, parentCost)`, so a brand /
 *    audience that OUTSPENT the coarser grain with 0 outcomes keeps its OWN higher spend floor — the
 *    resolved number is NEVER collapsed down to the fleet value (that would make a money-burning grain
 *    with nothing to show look artificially cheap, the exact bug the cascade prevents).
 *
 *  • PROVENANCE (`grain`, the label the dashboard renders) is the finest grain that actually OBSERVED
 *    the goal's outcome (measured), else crossOrg (benchmark). A grain with spend but 0 outcomes yields
 *    a FLOORED projection, not a measured ratio, so it is NEVER tagged as this brand's / this audience's
 *    own result — even though its NUMBER is that grain's own spend floor. crossOrg (fleet, incl. this
 *    org's own spend) is present whenever any finer grain spent, so a projection always has a benchmark
 *    grain to attribute to.
 *
 * So for a 0-outcome brand that spent $135 (fleet cost $10): resolved cost = $135 (its own floor),
 * grain = crossOrg (benchmark) — the number stays brand-specific, the label stops lying.
 */
function resolvePick(
  estimatesByGrain: Partial<Record<GrainName, GrainBlock>>,
  econ: ProjectionEconomics | null,
  objective: Objective,
  singleStepGoal: SingleStepGoal | null,
  formSubmissionGoal: boolean,
): ResolvedBlock {
  const measured = (g: GrainName): boolean =>
    !!estimatesByGrain[g] && grainHasObservedOutcome(estimatesByGrain[g]!.evidence, objective, singleStepGoal);
  // NUMBER source: finest grain with spend (its floored unit costs = max(spent, parent) — Kevin's cascade).
  const numberGrain: GrainName =
    estimatesByGrain.audience ? "audience" : estimatesByGrain.brand ? "brand" : "crossOrg";
  const block = estimatesByGrain[numberGrain]!;
  // PROVENANCE label: finest MEASURED grain (observed the outcome), else crossOrg benchmark. Decoupled
  // from `numberGrain` so a 0-outcome grain's spend-floor number is never labelled "this brand/audience".
  const grain: GrainName =
    measured("audience") ? "audience" : measured("brand") ? "brand" : "crossOrg";
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

  // Resolve the queried goal → (objective echo, goal echo, singleStep flag, form flag) across every
  // fleet spelling. An ABSENT goalParam defaults to meeting-booked (preserved); a PRESENT but
  // UNRECOGNISED goalParam FAILS LOUD (400) rather than silently defaulting.
  const resolved = resolveGoalInputs(goalParam);
  if (!resolved.ok) {
    return res.status(400).json({
      error:
        "goal must be one of: signup, meetingBooked, websitePurchase, sales, websiteVisit, positiveReply, formSubmission, whatsappConversation (snake/kebab spellings also accepted)",
    });
  }
  const { objective, goal, singleStepGoal, formSubmissionGoal } = resolved;
  const budgetUsd = budgetRaw != null && budgetRaw !== "" ? Number(budgetRaw) : null;

  // GROSS (default) vs NET pricing. Omitted → gross → byte-identical to today.
  const pricing = parsePricing(req.query.pricing);
  if (pricing === null) {
    return res.status(400).json({ error: "pricing must be one of: gross, net" });
  }

  try {
    const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
    if (!feature) {
      return res.status(404).json({ error: "Feature not found" });
    }
    // budgetUsd is accepted for back-compat but does not shape the body (grain ladder +
    // recommendedBudgetUsd cover the projection) → excluded from the cache key.
    void budgetUsd;

    // NET reads runs#179's frozen net cost fields at each grain source (no billing call, no read-time
    // multiply); GROSS is byte-identical. The selector is threaded into the grain fetchers below; a NET
    // request where a frozen net figure is absent throws → 502 (via catch), never cached, no fallback.

    // Gold SWR: the heavy cross-org + brand + audience fan-out runs off the request path ~once per
    // TTL; keyed on the inputs that shape the body (orgId + brand + goal + pricing).
    const identity: Identity = { orgId, userId, runId, featureSlug: headerFeatureSlug };
    const response = await servedCached({
      view: "workflow-projection",
      scopeKey: buildScopeKey(featureSlug, { orgId, brandId, objective, pricing }),
      orgId,
      compute: () =>
        computeWorkflowProjection({ featureSlug, brandId, objective, goal, singleStepGoal, formSubmissionGoal, identity, pricing }),
    });
    res.json(response);
  } catch (error) {
    console.error("[features-service] Workflow projection error:", error);
    res.status(502).json({ error: "Failed to compute workflow projection" });
  }
});

/**
 * Build the full workflow-projection response (3-grain ladder + resolved pick + recommendation) for one
 * (org, brand, goal) from already-parsed inputs. Extracted verbatim from the route handler's compute
 * closure so BOTH the `GET /features/:slug/workflow-projection` route AND internal callers (the
 * customer-health board's "best workflow by CAC") run the IDENTICAL projection — no divergence. The route
 * owns request parsing + the Gold SWR (`servedCached`) wrapper; this is the pure cross-service compute.
 * Runs ORG-ONLY (service api-key + x-org-id; userId/runId optional passthrough on `identity`). Throws on
 * any downstream failure (the route maps it to 502).
 */
export async function computeWorkflowProjection(input: {
  featureSlug: string;
  brandId: string;
  objective: Objective;
  goal: GoalEcho;
  singleStepGoal: SingleStepGoal | null;
  formSubmissionGoal: boolean;
  identity: Identity;
  pricing: Pricing;
}): Promise<WorkflowProjectionResponse> {
  const { featureSlug, brandId, objective, goal, singleStepGoal, formSubmissionGoal, identity, pricing } = input;

    // The workflow list is needed by the crossOrg AND brand dynasty rollups, so fetch it first; the
    // brand grain then fans out in parallel with the remaining reads.
    const workflows = await fetchPublicWorkflows(featureSlug, "all");
    // Same slug → dynasty map the crossOrg/brand rollups use — passed to the audience grain so its
    // per-audience dynasty attachment aligns with the dynasty-keyed rows (and skips runs-service's
    // lossy workflowDynastySlug regroup, which collapses the co-grouped audienceId).
    const slugToDynasty = new Map(workflows.map((w) => [w.workflowSlug, w.workflowDynastySlug]));
    const [costGroups, emailStats, effective, brandGrain, audienceEvidence] = await Promise.all([
      fetchPublicCosts(featureSlug, "workflowSlug", pricing),
      fetchPublicEmailStats(featureSlug, "workflowSlug"),
      fetchEffectiveEconomics(brandId, identity),
      fetchBrandWorkflowEvidence(brandId, featureSlug, workflows, identity, pricing),
      fetchAudienceGrainEvidence(brandId, featureSlug, identity, slugToDynasty, pricing),
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
          // COMBINED sales unions BOTH single-step paid-client rates (visit→paid + reply→paid) — read
          // both fail-loud (a producer gap fails, never a substituted 0). costPerSaleUsd needs both.
          ...(objective === "sales"
            ? { v2pc: singleStepRateDecimal(economics, "websiteVisit"), r2pc: singleStepRateDecimal(economics, "positiveReply") }
            : {}),
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
          // COMBINED sales echoes BOTH single-step paid-client rates it unions.
          ...(objective === "sales"
            ? { visitToPaidClientPct: economics.visitToPaidClientPct, replyToPaidClientPct: economics.replyToPaidClientPct }
            : {}),
          ...(formSubmissionGoal
            ? {
                visitToFormSubmissionPct: economics.visitToFormSubmissionPct,
                formSubmissionToPaidClientPct: economics.formSubmissionToPaidClientPct,
              }
            : {}),
        }
      : null;

    // Each grain's evidence cost is ALREADY gross-or-net: the grain fetchers selected runs#179's frozen
    // net twin (or the gross field) at the source per `pricing`, so the whole crossOrg→brand→audience
    // ladder is on one basis end to end (a mixed gross/net cascade would be incoherent). No post-hoc
    // multiply here — buildGrainBlock consumes the evidence as-is.
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
}

export default router;
