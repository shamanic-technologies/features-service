import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchEffectiveEconomics } from "../lib/sales-economics-client.js";
import { projectOutcomeCosts, singleStepRateDecimal, formSubmissionRatesDecimal, orP, type ProjectionEconomics, type SalesEconomics } from "../lib/funnel-registry.js";
import { projectedCostPerOutcome } from "../lib/cost-engine.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { parsePricing, type Pricing } from "../lib/pricing.js";
import { matchSingleStepGoal, matchFormSubmissionGoal, matchWhatsappGoal, matchCombinedSalesGoal, matchWebsitePurchaseGoal, type SingleStepGoal, type Goal } from "../lib/goals.js";
import { SALES_FUNNELS, matchSalesFunnelKey, type MeetingChannel, type SalesFunnelKey } from "../lib/sales-funnels.js";
import { fetchDeclaredSalesFunnels, SalesFunnelsUnavailableError } from "../lib/sales-funnels-client.js";
import {
  fetchPublicWorkflows,
  fetchPublicCosts,
  fetchPublicEmailStats,
  type CostGroup,
  type WorkflowMetadata,
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
export const TARGET_OUTCOMES_PER_MONTH = 10;

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
  /**
   * The GOAL-RESOLVED (expected) outcome COUNT for THIS grain — the numerator this grain's
   * cost-per-outcome is derived from, projected from the grain's OWN observed clicks/replies through the
   * queried goal's funnel. Coherent by construction with the grain's cost-per-outcome: spentUsd / this ==
   * the grain's cost-per-outcome whenever this > 0 (both read the same observed evidence). Uses ONLY
   * observed evidence (no cascade floor), so a grain that observed 0 of the driving outcome yields 0 —
   * never a floored/fabricated count. Null ONLY when economics is null (cold start). Lets the consumer
   * (campaign-service's cost-aware Thompson bandit) sample a Beta on (contacted = trials, this =
   * successes, spentUsd/contacted = cost) WITHOUT re-deciding the funnel metric — an absent audience grain
   * (a never-run couple) carries no block, i.e. a cold arm.
   */
  resolvedOutcomeCount: number | null;
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
  /**
   * The SALES FUNNEL this projection is priced on, when the caller named one (`?funnel=`). Absent on a
   * goal-keyed request, so a consumer that still sends a goal reads a byte-identical body. Present, it is
   * the authoritative answer to "what was this priced as" — `goal`/`objective` are then only echoes, and
   * the two meeting funnels carry the same echo while carrying different numbers.
   */
  funnelKey?: SalesFunnelKey;
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
    case "whatsappConversation":
      return { objective: "whatsapp_conversations", goalEcho: "whatsappConversation", singleStepGoal: null, formSubmissionGoal: false };
    case "signup":
      return { objective: "signup", goalEcho: "signup", singleStepGoal: null, formSubmissionGoal: false };
    case "meetingBooked":
      return { objective: "meeting-booked", goalEcho: "meetingBooked", singleStepGoal: null, formSubmissionGoal: false };
  }
}

/**
 * Map a SALES FUNNEL to the projection compute inputs — the funnel-keyed twin of
 * `goalToProjectionInputs`, and the whole reason the two meeting funnels can finally be priced apart.
 *
 * A goal is the coarser question and keeps its coarser answer: `meetingBooked` funnels a meeting from
 * BOTH channels (clicks × visit→meeting + replies × reply→meeting), which is right when all a caller
 * said is "I want meetings". A FUNNEL states which channel buys the meeting, so it is priced on THAT
 * channel alone — `meetingChannel` carries it, and everything downstream masks the other channel's unit
 * cost and observed evidence away. `sales_meetings_from_conversation` therefore reads
 * `replyUsd / replyToMeetingPct` while `sales_meetings_from_website` reads `clickUsd / visitToMeetingPct`
 * against the same evidence, which is the whole point.
 *
 * The other two funnels need no channel: `website_purchases` is visit → signup → paid (the `signup`
 * chain, click-driven by construction) and `form_magnet` is visit → form → paid. Note
 * `website_purchases` maps to the `signup` objective and NOT to the `websitePurchase` goal — that goal
 * is the full self-serve-plus-meeting close funnel, whose rates are not this chain's.
 *
 * `goal` / `objective` here are ECHOES for consumers that still read them (campaign-service reads
 * `arbitration.goal` in prod); they never re-decide the math, which is keyed on the funnel.
 */
export function funnelToProjectionInputs(key: SalesFunnelKey): {
  objective: Objective;
  goalEcho: GoalEcho;
  singleStepGoal: SingleStepGoal | null;
  formSubmissionGoal: boolean;
  meetingChannel: MeetingChannel | null;
} {
  switch (key) {
    case "sales_meetings_from_conversation":
      return { objective: "meeting-booked", goalEcho: "meetingBooked", singleStepGoal: null, formSubmissionGoal: false, meetingChannel: "reply" };
    case "sales_meetings_from_website":
      return { objective: "meeting-booked", goalEcho: "meetingBooked", singleStepGoal: null, formSubmissionGoal: false, meetingChannel: "click" };
    case "website_purchases":
      return { objective: "signup", goalEcho: "signup", singleStepGoal: null, formSubmissionGoal: false, meetingChannel: null };
    case "form_magnet":
      return { objective: "form_submissions", goalEcho: "formSubmission", singleStepGoal: null, formSubmissionGoal: true, meetingChannel: null };
  }
}

/**
 * Narrow a grain's unit costs to the ONE channel a funnel buys through.
 *
 * A masked channel reads `null`, which every per-budget term in `projectOutcomeCosts` already treats as
 * "this channel contributes nothing" — so the funnel's cost falls out of the EXISTING formulas with no
 * new math to keep in step. `null` channel (every goal caller, and the two click-driven funnels) returns
 * the costs untouched, which is what makes the goal path byte-identical.
 */
function maskUnitCostsForChannel<T extends { clickUsd: number | null; replyUsd: number | null }>(
  unitCosts: T,
  channel: MeetingChannel | null,
): { clickUsd: number | null; replyUsd: number | null } {
  if (channel === "click") return { clickUsd: unitCosts.clickUsd, replyUsd: null };
  if (channel === "reply") return { clickUsd: null, replyUsd: unitCosts.replyUsd };
  return { clickUsd: unitCosts.clickUsd, replyUsd: unitCosts.replyUsd };
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
  meetingChannel: MeetingChannel | null = null,
): number | null {
  const p = projectOutcomeCosts(econ, maskUnitCostsForChannel(unitCosts, meetingChannel));
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
 *
 * EXPORTED because /audience-stats scores fleet workflows with the IDENTICAL routing to pick the single
 * best workflow behind its floor parent (`fetchBrandProjectedParents`) — one goal→cost mapping across
 * both surfaces, so the two can never rank a different workflow best for the same goal. `meetingChannel`
 * threads with it: a funnel-keyed request must floor its per-audience rows against a parent priced on the
 * SAME channel, or the two surfaces disagree again one layer down.
 */
export function outcomeCostForGoal(
  econ: ProjectionEconomics,
  unitCosts: { clickUsd: number | null; replyUsd: number | null },
  objective: Objective,
  singleStepGoal: SingleStepGoal | null,
  formSubmissionGoal: boolean,
  meetingChannel: MeetingChannel | null = null,
): number | null {
  const p = projectOutcomeCosts(econ, maskUnitCostsForChannel(unitCosts, meetingChannel));
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
  // COMBINED-SALES: the outcome IS a sale (paying client) via the BEST channel → cost-per-sale
  // (best-channel MIN of visit→paid vs reply→paid, projectOutcomeCosts.costPerSaleUsd). Equals its
  // cost-per-paid-client.
  if (objective === "sales") return p.costPerSaleUsd;
  if (objective === "website_purchase") return p.costPerPurchaseUsd;
  if (objective === "meeting-booked") return p.costPerMeetingBookedUsd;
  if (formSubmissionGoal) return p.costPerFormSubmissionUsd;
  return p.costPerSignupUsd; // signup / self-serve
}

/**
 * The GOAL-RESOLVED (expected) outcome COUNT for a grain — the numerator its cost-per-outcome is derived
 * from, projected from the grain's OWN observed clicks/replies through the queried goal's funnel. Routes
 * by goal EXACTLY like `outcomeCostForGoal` (same channels, same rates), so cost + count are one basis:
 * spentUsd / count == that grain's cost-per-outcome whenever count > 0.
 *
 *   websiteVisit / whatsapp → clicks                                   (the click IS the outcome)
 *   positiveReply           → replies                                  (the reply IS the outcome)
 *   signup / self-serve     → clicks · v2s                             (expected signups, click route)
 *   form_submissions        → clicks · v2fs                            (expected form submissions)
 *   meeting-booked          → clicks · v2m + replies · r2m             (expected meetings, both channels)
 *   website_purchase        → clicks · orP(v2c, v2m·m2c) + replies · (r2m·m2c)   (expected closes)
 *   sales (combined)        → max(clicks · v2pc, replies · r2pc)       (best-channel sales — mirrors the MIN cost)
 *
 * Uses ONLY OBSERVED evidence (no cascade floor): a grain that observed 0 of the driving outcome yields 0,
 * never a floored count. A rate a goal needs but doesn't populate on `econ` (only `sales` sets v2pc/r2pc;
 * only form_submissions sets v2fs) is treated as 0 for that channel — the SAME zero-contribution the cost
 * side already applies, never a fabricated positive.
 */
function resolvedOutcomeCountForGoal(
  ev: { observedClicks: number; observedPositiveReplies: number },
  econ: ProjectionEconomics,
  objective: Objective,
  singleStepGoal: SingleStepGoal | null,
  formSubmissionGoal: boolean,
  meetingChannel: MeetingChannel | null = null,
): number {
  // A channel-scoped funnel counts outcomes on the channel it buys through and ONLY that one — the same
  // masking the cost side applies, so `spentUsd / count == that grain's cost-per-outcome` still holds.
  const clicks = meetingChannel === "reply" ? 0 : ev.observedClicks;
  const replies = meetingChannel === "click" ? 0 : ev.observedPositiveReplies;
  // whatsapp_conversations: the WhatsApp-link click IS the outcome (same as websiteVisit).
  if (objective === "whatsapp_conversations") return clicks;
  if (singleStepGoal === "websiteVisit") return clicks;
  if (singleStepGoal === "positiveReply") return replies;
  // COMBINED-SALES: a sale via the BEST channel → max(visit sales, reply sales) — mirrors costPerSaleUsd's
  // best-channel MIN (spentUsd / this == costPerSaleUsd by construction).
  if (objective === "sales") return Math.max(clicks * (econ.v2pc ?? 0), replies * (econ.r2pc ?? 0));
  if (objective === "website_purchase") {
    const pCloseClick = orP(econ.v2c, econ.v2m * econ.m2c);
    const pCloseReply = econ.r2m * econ.m2c;
    return clicks * pCloseClick + replies * pCloseReply;
  }
  if (objective === "meeting-booked") return clicks * econ.v2m + replies * econ.r2m;
  if (formSubmissionGoal) return clicks * (econ.v2fs ?? 0);
  return clicks * econ.v2s; // signup / self-serve — click route only
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
  evidence: WorkflowGrainEvidence,
  econ: ProjectionEconomics | null,
  ltrUsd: number | null,
  objective: Objective,
  singleStepGoal: SingleStepGoal | null,
  formSubmissionGoal: boolean,
  parentUnitCosts: GrainUnitCosts | null = null,
  meetingChannel: MeetingChannel | null = null,
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
    // Priced on the funnel's OWN channel when one is stated. `costPerMeetingBookedUsd` rides here too:
    // it sits on the SAME object as the resolved cost-per-outcome, so leaving it on the both-channel
    // blend would print a meeting cost that contradicts the meeting cost one field over.
    const p = projectOutcomeCosts(econ, maskUnitCostsForChannel(unitCosts, meetingChannel));
    const costPerPaidClientUsd = paidClientCostForGoal(econ, unitCosts, objective, singleStepGoal, formSubmissionGoal, meetingChannel);
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

  // Goal-resolved outcome count from THIS grain's OWN observed evidence (no floor). Null at cold start
  // (no economics) — mirrors the projected costs' null gate.
  const resolvedOutcomeCount = econ
    ? resolvedOutcomeCountForGoal({ observedClicks, observedPositiveReplies }, econ, objective, singleStepGoal, formSubmissionGoal, meetingChannel)
    : null;

  return {
    evidence: { spentUsd, observedContacted, observedClicks, observedPositiveReplies },
    unitCosts: { costPerClickUsd, costPerPositiveReplyUsd, costPerContactedUsd },
    resolvedOutcomeCount,
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
export function grainHasObservedOutcome(
  ev: GrainBlock["evidence"],
  objective: Objective,
  singleStepGoal: SingleStepGoal | null,
  meetingChannel: MeetingChannel | null = null,
): boolean {
  // A channel-scoped meeting funnel is MEASURED only on the channel it buys through: a brand with clicks
  // and no replies has observed nothing about `sales_meetings_from_conversation`, so labelling that row
  // "this brand's own results" would be a lie in exactly the way the provenance label exists to prevent.
  if (meetingChannel === "reply") return ev.observedPositiveReplies > 0;
  if (meetingChannel === "click") return ev.observedClicks > 0;
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
 *
 *  • `costPerOutcomeUsd` is ALWAYS a number when economics exist — a workflow that has produced ZERO of
 *    the goal's outcome still reports its cascade floor `max(spend, parent)`. Do NOT null it to keep a
 *    0-outcome workflow from being crowned cheapest (tried 2026-07-29, v0.107.2, REVERTED in v0.107.3).
 *    The floor IS the exploration device, and nulling it STARVES the fleet:
 *      - campaign-service's `selectWorkflowGreedy` SKIPS a null-cost row, so a nulled workflow is never
 *        selected → never runs → never produces an outcome → stays nulled. Absorbing state. A NEWLY
 *        ADDED workflow (zero evidence by definition) could never enter rotation at all.
 *      - The floor self-corrects instead: cheap-because-barely-tried → gets picked → spends → its floor
 *        RISES → it drops out on its own once it outspends the alternatives with nothing to show. That
 *        is the intended explore/exploit behaviour, refined over the cascade + fallback work (crossOrg
 *        best-workflow as the last-resort default), NOT a bug to gate away.
 *    So a 0-outcome workflow legitimately competes, and the two dashboard surfaces are kept coherent the
 *    OTHER way: `fetchBrandProjectedParents` picks the winner with the SAME ungated argmin the Strategy
 *    page's `pickBestBrandRow` uses, so both price an audience off the same workflow.
 *
 *    `resolved.grain` still carries the honest provenance LABEL via `grainHasObservedOutcome` — a floored
 *    row is labelled `crossOrg` (benchmark), never "this brand's own results". Number and label stay
 *    decoupled: the number always exists (rankable), the label never lies (displayable).
 */
function resolvePick(
  estimatesByGrain: Partial<Record<GrainName, GrainBlock>>,
  econ: ProjectionEconomics | null,
  objective: Objective,
  singleStepGoal: SingleStepGoal | null,
  formSubmissionGoal: boolean,
  meetingChannel: MeetingChannel | null = null,
): ResolvedBlock {
  const measured = (g: GrainName): boolean =>
    !!estimatesByGrain[g] && grainHasObservedOutcome(estimatesByGrain[g]!.evidence, objective, singleStepGoal, meetingChannel);
  // NUMBER source: finest grain with spend (its floored unit costs = max(spent, parent) — Kevin's cascade).
  const numberGrain: GrainName =
    estimatesByGrain.audience ? "audience" : estimatesByGrain.brand ? "brand" : "crossOrg";
  const block = estimatesByGrain[numberGrain]!;
  // PROVENANCE label: finest MEASURED grain (observed the outcome), else crossOrg benchmark. Decoupled
  // from `numberGrain` so a 0-outcome grain's spend-floor number is never labelled "this brand/audience".
  const grain: GrainName =
    measured("audience") ? "audience" : measured("brand") ? "brand" : "crossOrg";
  const unitCosts = { clickUsd: block.unitCosts.costPerClickUsd, replyUsd: block.unitCosts.costPerPositiveReplyUsd };
  const costPerOutcomeUsd = econ ? outcomeCostForGoal(econ, unitCosts, objective, singleStepGoal, formSubmissionGoal, meetingChannel) : null;
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
  // A caller may name the SALES FUNNEL it wants priced (`?funnel=`) — the vocabulary brand-service now
  // emits, and the only one that can tell the two meeting funnels apart. When it does, the funnel WINS
  // over any goal param: the goal is the coarser question and cannot answer the finer one. When it does
  // not, nothing below changes and the goal path stays byte-identical.
  const funnelParam = req.query.funnel as string | undefined;
  let funnelKey: SalesFunnelKey | null = null;
  if (funnelParam != null && funnelParam !== "") {
    funnelKey = matchSalesFunnelKey(funnelParam);
    if (!funnelKey) {
      return res.status(400).json({
        error: `funnel must be one of: ${Object.keys(SALES_FUNNELS).join(", ")} (pre-retirement spellings reply_meeting / visit_meeting / visit_signup / visit_form also accepted)`,
      });
    }
  }

  const resolved = funnelKey ? null : resolveGoalInputs(goalParam);
  if (resolved && !resolved.ok) {
    return res.status(400).json({
      error:
        "goal must be one of: signup, meetingBooked, websitePurchase, sales, websiteVisit, positiveReply, formSubmission, whatsappConversation (snake/kebab spellings also accepted)",
    });
  }
  const inputs = funnelKey
    ? (() => {
        const f = funnelToProjectionInputs(funnelKey);
        return { objective: f.objective, goal: f.goalEcho, singleStepGoal: f.singleStepGoal, formSubmissionGoal: f.formSubmissionGoal, meetingChannel: f.meetingChannel };
      })()
    : { ...(resolved as { ok: true } & GoalInputs), meetingChannel: null as MeetingChannel | null };
  const { objective, goal, singleStepGoal, formSubmissionGoal, meetingChannel } = inputs;
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

    // Gold SWR covers the heavy EVIDENCE fan-out ONLY (cross-org + brand + audience cost/outcome
    // reads) — it is economics- AND goal-independent, so it runs off the request path ~once per TTL,
    // keyed on the inputs that shape it (orgId + brand + pricing). The brand's ECONOMICS is read LIVE
    // on every request and the response is projected from it here: a caller that just wrote its sales
    // economics reads the NEW lifetimeRevenueUsd (hence the new roiMultiple / cacPct) with no wait, no
    // opt-in param, and without re-running the fan-out. See "economics is never cached" below.
    const identity: Identity = { orgId, userId, runId, featureSlug: headerFeatureSlug };

    // A funnel the brand never declared has no cost to serve. "We could not estimate this" and "it costs
    // zero" are different statements, and only the first one is true here — so this 404s with the reason
    // rather than pricing a chain the org never said it sells through. Fires ONLY on `?funnel=`, so the
    // goal path takes no extra read.
    if (funnelKey) {
      let declared: string[];
      try {
        declared = (await fetchDeclaredSalesFunnels(brandId, orgId)).map((f) => f.funnelKey);
      } catch (error) {
        if (error instanceof SalesFunnelsUnavailableError) {
          return res.status(502).json({ error: error.message, reason: "declared_funnels_unavailable" });
        }
        throw error;
      }
      if (!declared.includes(funnelKey)) {
        return res.status(404).json({
          error: `this brand has not declared the ${funnelKey} funnel, so there is no cost to estimate for it`,
          reason: "funnel_not_declared",
          declaredFunnelKeys: declared,
        });
      }
    }

    const [evidence, effective] = await Promise.all([
      servedCached({
        view: "workflow-projection-evidence",
        scopeKey: buildScopeKey(featureSlug, { orgId, brandId, pricing }),
        orgId,
        compute: () => fetchWorkflowProjectionEvidence({ featureSlug, brandId, identity, pricing }),
      }),
      fetchEffectiveEconomics(brandId, identity),
    ]);
    const response = projectFromEvidence({
      featureSlug,
      objective,
      goal,
      singleStepGoal,
      formSubmissionGoal,
      meetingChannel,
      ...(funnelKey ? { funnelKey } : {}),
      evidence,
      economics: effective.economics,
    });
    res.json(response);
  } catch (error) {
    console.error("[features-service] Workflow projection error:", error);
    res.status(502).json({ error: "Failed to compute workflow projection" });
  }
});

/**
 * The HEAVY, economics-INDEPENDENT half of the projection: every cross-service read the 3-grain ladder
 * needs (fleet workflows + fleet cost/outcome + brand grain + per-audience grain). It depends ONLY on
 * (featureSlug, brandId, pricing) — NOT on the brand's sales economics and NOT on the queried goal — so
 * it is the part the Gold SWR snapshot caches, and one snapshot serves every goal.
 *
 * SHAPE IS JSON-SERIALIZABLE ON PURPOSE: the snapshot round-trips through a jsonb column, so the Maps
 * the grain fetchers return are flattened to entry arrays here and rebuilt in `projectFromEvidence`.
 * A Map stored in jsonb deserializes as `{}` — a silent all-zero ladder. Keep this shape plain.
 *
 * Throws on any downstream failure (the route maps it to 502; a failed compute is never cached).
 */
export interface WorkflowProjectionEvidence {
  workflows: WorkflowMetadata[];
  /** Fleet (crossOrg) cost groups, `groupBy=workflowSlug`, already gross-or-net per `pricing`. */
  crossOrgCostGroups: CostGroup[];
  /** Fleet (crossOrg) email stats, `groupBy=workflowSlug` — entries of the client's Map. */
  crossOrgEmailStats: Array<[string, Record<string, number>]>;
  /** Brand-grain evidence keyed by the dynasty's ACTIVE workflow slug — entries of the client's Map. */
  brandGrain: Array<[string, WorkflowGrainEvidence]>;
  /** Per active audience, its per-dynasty send-tag evidence — entries of each `byDynasty` Map. */
  audienceEvidence: Array<{ audienceId: string; byDynasty: Array<[string, WorkflowGrainEvidence]> }>;
}

export async function fetchWorkflowProjectionEvidence(input: {
  featureSlug: string;
  brandId: string;
  identity: Identity;
  pricing: Pricing;
}): Promise<WorkflowProjectionEvidence> {
  const { featureSlug, brandId, identity, pricing } = input;

  // The workflow list is needed by the crossOrg AND brand dynasty rollups, so fetch it first; the
  // brand grain then fans out in parallel with the remaining reads.
  const workflows = await fetchPublicWorkflows(featureSlug, "all");
  // Same slug → dynasty map the crossOrg/brand rollups use — passed to the audience grain so its
  // per-audience dynasty attachment aligns with the dynasty-keyed rows (and skips runs-service's
  // lossy workflowDynastySlug regroup, which collapses the co-grouped audienceId).
  const slugToDynasty = new Map(workflows.map((w) => [w.workflowSlug, w.workflowDynastySlug]));
  const [costGroups, emailStats, brandGrain, audienceEvidence] = await Promise.all([
    fetchPublicCosts(featureSlug, "workflowSlug", pricing),
    fetchPublicEmailStats(featureSlug, "workflowSlug"),
    fetchBrandWorkflowEvidence(brandId, featureSlug, workflows, identity, pricing),
    fetchAudienceGrainEvidence(brandId, featureSlug, identity, slugToDynasty, pricing),
  ]);

  return {
    workflows,
    crossOrgCostGroups: costGroups,
    crossOrgEmailStats: [...emailStats.entries()],
    brandGrain: [...brandGrain.entries()],
    audienceEvidence: audienceEvidence.map((ev) => ({ audienceId: ev.audienceId, byDynasty: [...ev.byDynasty.entries()] })),
  };
}

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
  meetingChannel?: MeetingChannel | null;
  funnelKey?: SalesFunnelKey;
  identity: Identity;
  pricing: Pricing;
}): Promise<WorkflowProjectionResponse> {
  const { featureSlug, brandId, objective, goal, singleStepGoal, formSubmissionGoal, identity, pricing } = input;
  const [evidence, effective] = await Promise.all([
    fetchWorkflowProjectionEvidence({ featureSlug, brandId, identity, pricing }),
    fetchEffectiveEconomics(brandId, identity),
  ]);
  return projectFromEvidence({
    featureSlug,
    objective,
    goal,
    singleStepGoal,
    formSubmissionGoal,
    meetingChannel: input.meetingChannel ?? null,
    ...(input.funnelKey ? { funnelKey: input.funnelKey } : {}),
    evidence,
    economics: effective.economics,
  });
}

/**
 * The PURE, economics-DEPENDENT half: derive the goal's 3-grain projection from already-fetched
 * evidence + the brand's economics. No IO, so it runs on EVERY request against LIVE economics — that is
 * what makes a read straight after a sales-economics write reflect the new `lifetimeRevenueUsd` (and
 * therefore the new `roiMultiple` / `cacPct`) without a cache-bypass param and without re-fanning out.
 * NEVER cache this output keyed on the evidence inputs alone; economics is not one of them.
 */
export function projectFromEvidence(input: {
  featureSlug: string;
  objective: Objective;
  goal: GoalEcho;
  singleStepGoal: SingleStepGoal | null;
  formSubmissionGoal: boolean;
  /** Set ONLY on a funnel-keyed projection; narrows every cost + every observed count to that channel. */
  meetingChannel?: MeetingChannel | null;
  /** Echoed on the response when the caller named a funnel. Never shapes the math on its own. */
  funnelKey?: SalesFunnelKey;
  evidence: WorkflowProjectionEvidence;
  economics: SalesEconomics | null;
}): WorkflowProjectionResponse {
  const { featureSlug, objective, goal, singleStepGoal, formSubmissionGoal, evidence, economics } = input;
  const meetingChannel = input.meetingChannel ?? null;
  const workflows = evidence.workflows;
  const costGroups = evidence.crossOrgCostGroups;
  const emailStats = new Map(evidence.crossOrgEmailStats);
  const brandGrain = new Map(evidence.brandGrain);
  const audienceEvidence: AudienceGrainEvidence[] = evidence.audienceEvidence.map((ev) => ({
    audienceId: ev.audienceId,
    byDynasty: new Map(ev.byDynasty),
  }));

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
      ev: WorkflowGrainEvidence,
      parentUnitCosts: GrainUnitCosts | null = null,
    ): GrainBlock =>
      buildGrainBlock(ev, econ, ltrUsd, objective, singleStepGoal, formSubmissionGoal, parentUnitCosts, meetingChannel);
    const resolve = (grains: Partial<Record<GrainName, GrainBlock>>): ResolvedBlock =>
      resolvePick(grains, econ, objective, singleStepGoal, formSubmissionGoal, meetingChannel);

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

    // ── Audience rows — EVERY active audience × EVERY active dynasty ────────────────────────────
    // Send-tag per (audience × dynasty): the audience grain's cost + outcome are keyed per dynasty
    // (ev.byDynasty), on the SAME send-tag basis as the brand grain. We emit a row for every active
    // audience under every active dynasty so a consumer filtering rows to the chosen workflow gets the
    // FULL active-audience set (the enumeration fix). A (audience, dynasty) couple with no attributed
    // audience data has no audience grain → it resolves via the cascade to brand→crossOrg (a projected
    // estimate, never absent, never a false $0). Precedence audience > brand > crossOrg → a couple with
    // real audience spend resolves at the audience grain against THIS dynasty's brand/crossOrg parent.
    // Map dynastySlug → active workflow slug (for crossOrg/brand grain lookup keyed on active slug).
    const activeSlugByDynasty = new Map<string, string>();
    for (const [activeSlug, wf] of workflowBySlug) {
      if (wf.status === "active") activeSlugByDynasty.set(wf.workflowDynastySlug, activeSlug);
    }

    for (const ev of audienceEvidence) {
      for (const [dynastySlug, activeSlug] of activeSlugByDynasty) {
        // Cascade: crossOrg (no parent) → brand (parent crossOrg) → audience (parent brand ?? crossOrg).
        const estimatesByGrain: Partial<Record<GrainName, GrainBlock>> = {};
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
        const audienceParent = estimatesByGrain.brand?.unitCosts ?? estimatesByGrain.crossOrg?.unitCosts ?? null;
        const audEv = ev.byDynasty.get(dynastySlug);
        if (audEv && audEv.totalCostInUsdCents > 0) estimatesByGrain.audience = buildBlock(audEv, audienceParent);

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
      ...(input.funnelKey ? { funnelKey: input.funnelKey } : {}),
      economics: economicsEcho,
      rows,
      recommendedWorkflowDynastySlug: recommended?.workflow.workflowDynastySlug ?? null,
      recommendedBudgetUsd: recommendedCost != null ? TARGET_OUTCOMES_PER_MONTH * recommendedCost : null,
    };
}

export default router;
