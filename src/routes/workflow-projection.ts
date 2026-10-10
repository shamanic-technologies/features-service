import { Router, type Request, type Response } from "express";
import { getInternalPipeFleet, internalPipeCountsByDynasty, type MeetingLegFleet } from "../lib/meeting-leg-fleet.js";
import { internalPipeToStep } from "../lib/pipe-kind.js";
import type { ChannelStepKey } from "../lib/acquisition-channels.js";
import { overlayVendorProjection } from "../lib/actual-cost-projection.js";
import { fetchActiveAudienceAvailabilitySoft } from "../lib/human-client.js";
import { fetchPricingFunnels } from "../lib/reading-funnels.js";
import { FUNNEL_RETIRED_BODY, namesRetiredFunnel } from "../lib/retired-funnel-param.js";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { economicsFromTerms } from "../lib/offer-priced-economics.js";
import { fetchFunnelPricedEconomics } from "../lib/offer-pricing.js";
import { projectOutcomeCosts, singleStepRateDecimal, formSubmissionRatesDecimal, orP, type ProjectionEconomics, type SalesEconomics } from "../lib/funnel-registry.js";
import { projectedCostPerOutcome } from "../lib/cost-engine.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { parsePricing, type Pricing } from "../lib/pricing.js";
import { type CostBasis } from "../lib/cost-basis.js";
import { matchSingleStepGoal, matchFormSubmissionGoal, matchWhatsappGoal, matchCombinedSalesGoal, matchWebsitePurchaseGoal, type SingleStepGoal, type Goal } from "../lib/goals.js";
import { salesFunnelIndex, type PricingChannel, type SalesFunnelKey } from "../lib/sales-funnels.js";
import {
  describeSeveralOffers,
  SalesFunnelsUnavailableError,
  SeveralOffersDeclaredError,
  OfferNotOfBrandError,
} from "../lib/sales-funnels-client.js";
import { declaredEconomicsForFunnel, declaredFunnelsToRank } from "../lib/declared-funnels.js";
import {
  FUNNEL_LEG_KEYS,
  funnelLeg,
  funnelsContainingLeg,
  matchFunnelLegKey,
  matchChannelLegKey,
  type FunnelLegDef,
} from "../lib/funnel-legs.js";
import {
  bookedToAttendedRate,
  entryLegOutcomeTerms,
  grainLegOutcome,
  legOutcomeTerms,
  type GrainLegOutcome,
  type LegOutcomeTerms,
} from "../lib/leg-outcome.js";
import { fetchCampaignFamiliesSoft } from "../lib/campaign-identity-client.js";
import { fetchOfferScopeIdsSoft } from "../lib/offer-scope.js";
import { withInteractiveReads } from "../lib/lead-copy.js";
import { describeIdentity, type CampaignIdentity, type CampaignIdentityView } from "../lib/campaign-identity.js";
import { DEFAULT_MAXIMIZE, MAXIMIZE_ERROR, parseMaximize, type Maximize } from "../lib/maximize.js";
import {
  buildObservedPicks,
  fetchCampaignTriggerRunsSoft,
  OBSERVED_PICKS_DEFAULT,
  OBSERVED_PICKS_MAX,
} from "../lib/observed-picks.js";
import { rankDeclaredFunnels } from "../lib/funnel-ranking.js";
import {
  fetchLegAssignments,
  legAssignmentVerdict,
  type LegAssignmentVerdict,
} from "../lib/workflow-leg-assignments.js";
import { fetchWorkflowContentModelsSoft } from "../lib/workflow-content-model-client.js";
import {
  fetchPublicWorkflows,
  fetchPublicCosts,
  fetchPublicEmailStats,
  type CostGroup,
  type WorkflowMetadata,
} from "../lib/public-stats-clients.js";
import { aggregateAcrossDynasties } from "./public.js";
import { fetchPositiveRepliers, fetchScopePersons, setReplyCountsOnSlugStats } from "../lib/crm-only-repliers.js";
import { fetchFleetPositiveRepliesBySlug } from "../lib/fleet-positive-repliers.js";
import { fetchLegFleetEvidence, fetchLegFleetMatureEvidence } from "../lib/leg-fleet-evidence.js";
import {
  fetchBrandWorkflowEvidenceWithRetired,
  fetchCampaignWorkflowEvidenceWithRetired,
  fetchCampaignWorkflowMatureEvidence,
  fetchAudienceGrainEvidence,
  fetchAudienceMatureEvidence,
  brandGrainDynasties,
  type GrainEvidenceWithRetired,
  type WorkflowGrainEvidence,
  type AudienceGrainEvidence,
  type Identity,
} from "../lib/workflow-projection-grains.js";
import {
  isMatureCount,
  legMaturity,
  maturityCutoffIso,
  maturityPair,
  outcomeFigures,
  type LegMaturity,
  type MaturityPair,
  type OutcomeFigures,
} from "../lib/maturity.js";
import { serveDatesStated } from "../lib/mature-evidence.js";
import { missionPriceOf, orderMissionWorkflows } from "../lib/mission-workflow-order.js";
import type { EnginePerson } from "../lib/revenue-engine.js";

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

export type GrainName = "crossOrg" | "brand" | "offer" | "campaign" | "audience";

/** The three per-outcome unit costs of a grain — also the shape passed as the PARENT floor for the
 * next finer grain (crossOrg → brand → audience) via the projected cost-engine. */
interface GrainUnitCosts {
  costPerClickUsd: number;
  costPerPositiveReplyUsd: number;
  costPerContactedUsd: number;
}

/**
 * WHICH ACCOUNTING QUESTION EACH GRAIN ANSWERS — the CHARGED / INCURRED axis (`lib/cost-basis.ts`).
 *
 * This payload is the ONE place both questions sit side by side, and they share the label
 * "cost per outcome", so each grain SAYS which it is rather than leaving a reader to infer it.
 *
 *  - `crossOrg` is the FLEET BENCHMARK: what a workflow costs to produce an outcome across every org.
 *    Comped spend counts at full value — one org being comped must not make the workflow look cheaper
 *    to everybody else.
 *  - `brand` / `audience` are THIS CUSTOMER'S OWN MONEY, the figures their dashboard displays and
 *    divides into ROI/%CAC. Comped spend is absent: they did not pay it.
 */
const GRAIN_COST_BASIS: Record<GrainName, CostBasis> = {
  crossOrg: "incurred",
  brand: "charged",
  // A campaign's money is the same customer's own billed money, one narrowing finer than the brand's.
  campaign: "charged",
  // An offer's money is the same customer's billed money over the campaigns selling that offer.
  offer: "charged",
  audience: "charged",
};

/** Stamp each present grain with the basis it was read on (see {@link GRAIN_COST_BASIS}). */
function stampGrainBases(estimatesByGrain: Partial<Record<GrainName, GrainBlock>>): Partial<Record<GrainName, GrainBlock>> {
  for (const g of Object.keys(estimatesByGrain) as GrainName[]) {
    estimatesByGrain[g]!.costBasis = GRAIN_COST_BASIS[g];
  }
  return estimatesByGrain;
}

interface GrainBlock {
  /** Which accounting question this grain answers — see {@link GRAIN_COST_BASIS}. */
  costBasis?: CostBasis;
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
  /**
   * WHAT THIS GRAIN'S EVIDENCE SAYS ABOUT THE LEG'S OWN STEP — present ⟺ the caller named a `?leg=`,
   * absent on every funnel- or goal-keyed request so those bodies are byte-identical.
   *
   * Three figures, because a panel comparing grains needs all three and may derive none of them: what
   * ONE outcome OF THE LEG costs here, how many of those outcomes this grain accounts for, and the
   * spend behind them. `outcomeObserved` says whether that count was COUNTED (an entry leg, whose step
   * IS the observed signal) or walked forward through the basis funnel's declared rates. A grain with
   * no evidence carries no block at all; a rate the brand never declared reads null, never 0.
   */
  legOutcome?: GrainLegOutcome;
  projected: {
    costPerSignupUsd: number | null;
    costPerPaidClientUsd: number | null;
    costPerMeetingBookedUsd: number | null;
    roiMultiple: number | null;
    cacPct: number | null;
  };
  /**
   * WHICH VERSION OF THE EVIDENCE this block's own fields (`evidence`, `unitCosts`, `legOutcome`,
   * `resolvedOutcomeCount`, `projected`) are on — present ⟺ the caller named a `?leg=` (`lib/maturity.ts`).
   * `mature` for a workflow that is mature on the fleet of its leg (its young spend counts nowhere),
   * `flash` otherwise (its exploration phase, priced exactly as before). The ROW decides, except for a grain
   * of a MATURE row that holds no mature evidence yet (a young brand / offer / mission): that grain is still
   * served, on its flash block, with `basis: "flash"` and its own `isMature: false` — never dropped.
   */
  basis?: MaturityBasis;
  /** This grain's figures on BOTH bases, observed (never floored) — see `OutcomeFigures`. */
  flash?: OutcomeFigures | null;
  /** NULL only when the mature cut could not be made; a cut that holds nothing here reads zeros. */
  mature?: OutcomeFigures | null;
  /** This grain's MATURE outcomes against the leg's bar. NULL when the mature cut could not be made. */
  isMature?: boolean | null;
}

/** The two versions every figure exists in (`lib/maturity.ts`). */
export type MaturityBasis = "flash" | "mature";

/** The price a row resolves to on one basis — what `resolved` says, reduced to what a reader compares. */
export interface ResolvedFigures {
  grain: GrainName | null;
  costPerOutcomeUsd: number | null;
  conversionRatePct: number | null;
}

/** Why a grain holds no price on one basis (`GrainHeldPrice.unpricedReason`). */
export type GrainPriceUnpricedReason =
  /** Neither this grain nor any grain it inherits from holds evidence on this basis. */
  | "no_evidence"
  /** The grain that holds the evidence cannot walk it to the leg's step (an undeclared rate). */
  | "leg_unpriceable"
  /** The mature cut could not be made for this read, so nothing is held on the mature basis. */
  | "mature_cut_unavailable"
  /** Actual-cost read only: the grain the price comes from (or one it floors against) holds unpriced spend. */
  | "vendor_cost_unknown";

/**
 * THE PRICE THIS SERVICE HOLDS FOR A WORKFLOW AT ONE GRAIN, ON ONE BASIS — the cascade resolved here so
 * no reader re-walks it. A grain with its own evidence on the basis states its own block's cost per
 * outcome (a real ratio, or its floor `max(own spend, parent)` when it observed no outcome); a grain
 * without inherits the price of the nearest coarser grain that holds one (offer/campaign → brand →
 * crossOrg; audience → campaign → brand → crossOrg), exactly what the floor would hand it.
 */
export interface GrainHeldPrice {
  costPerOutcomeUsd: number | null;
  /** `own` = this grain's evidence; `inherited` = a coarser grain's price; null ⟺ nothing is held. */
  source: "own" | "inherited" | null;
  /** The grain whose block the price was read from (this grain when `own`). Null ⟺ nothing is held. */
  fromGrain: GrainName | null;
  /** Why `costPerOutcomeUsd` is null. Null ⟺ a price is held. */
  unpricedReason: GrainPriceUnpricedReason | null;
}

/** One grain's held price on BOTH bases (see {@link GrainHeldPrice}). */
export interface GrainHeldPrices {
  flash: GrainHeldPrice;
  mature: GrainHeldPrice;
}

/** The grains a grain inherits from when it holds no evidence, nearest first. */
const INHERITS_FROM: Record<GrainName, GrainName[]> = {
  crossOrg: [],
  brand: ["crossOrg"],
  offer: ["brand", "crossOrg"],
  campaign: ["brand", "crossOrg"],
  audience: ["campaign", "brand", "crossOrg"],
};

const NOTHING_HELD = (reason: GrainPriceUnpricedReason): GrainHeldPrice => ({
  costPerOutcomeUsd: null,
  source: null,
  fromGrain: null,
  unpricedReason: reason,
});

/**
 * The price held for `grain` on one version's ladder. `grains` is that version's ladder (null = the cut
 * could not be made). Pure: the nearest grain WITH a block decides, never a cheaper one further up.
 */
export function heldPriceOn(
  grains: Partial<Record<GrainName, { legOutcome?: { costPerOutcomeUsd: number | null } }>> | null,
  grain: GrainName,
): GrainHeldPrice {
  if (!grains) return NOTHING_HELD("mature_cut_unavailable");
  const from = [grain, ...INHERITS_FROM[grain]].find((g) => grains[g]);
  if (!from) return NOTHING_HELD("no_evidence");
  const cost = grains[from]!.legOutcome?.costPerOutcomeUsd ?? null;
  return {
    costPerOutcomeUsd: cost,
    source: from === grain ? "own" : "inherited",
    fromGrain: from,
    unpricedReason: cost == null ? "leg_unpriceable" : null,
  };
}

/**
 * THE ROW'S MATURITY — present ⟺ the caller named a `?leg=`. `isMature` is the WORKFLOW's verdict on the
 * fleet of its leg (every org's campaigns performing the leg): at least the leg's required MATURE outcomes.
 * It decides `basis`, the version `estimatesByGrain` and `resolved` are priced on — and therefore what
 * campaign-service ranks, and the audience evidence it draws on. `resolved` states BOTH prices.
 */
export interface RowMaturity {
  basis: MaturityBasis;
  isMature: boolean | null;
  /** The workflow's mature outcomes of the leg's step on the fleet. NULL when the cut could not be made. */
  matureOutcomes: number | null;
  resolved: MaturityPair<ResolvedFigures>;
}

/**
 * THE LEG'S MATURITY RULE, echoed on a leg-keyed answer, and whether this answer could apply it.
 * `measured: false` names why (`unmeasuredReason`): every row is then priced on flash, as before.
 */
export interface ProjectionMaturity extends LegMaturity {
  /** Runs started, and leads served, before this instant are mature. NULL on a 0-day leg (mature ≡ flash). */
  cutoffIso: string | null;
  measured: boolean;
  unmeasuredReason: MatureUnavailableReason | "leg_scope_unavailable" | null;
}

interface ResolvedBlock {
  /**
   * The grain the number came from. NULL on an UNMEASURED row — nothing measured it, so there is
   * nothing to label, and a row priced on the EXPLORE ALLOWANCE borrows no other workflow's provenance.
   */
  grain: GrainName | null;
  /**
   * The basis the resolved NUMBERS were read on — the basis of the grain they came from (which is
   * `numberGrain`, the finest grain WITH SPEND, not the provenance `grain` label). "charged" = this
   * customer's own billed money; "incurred" = the fleet benchmark, comped spend included. NULL on an
   * UNMEASURED row, where the number is an explore allowance rather than a measured cost.
   */
  costBasis: CostBasis | null;
  /**
   * NULL when there is no evidence AND no allowance to state. On an UNMEASURED row it carries the
   * channel's outreach price (the explore allowance's floor) — never 0, which would say a click is free.
   */
  costPerClickUsd: number | null;
  costPerOutcomeUsd: number | null;
  costPerPaidClientUsd: number | null;
  costPerMeetingBookedUsd: number | null;
  roiMultiple: number | null;
  cacPct: number | null;
  /**
   * HOW MUCH OF THE LIST THIS WORKFLOW BURNS PER OUTCOME, as a percentage of the people it reached —
   * `100 × resolvedOutcomeCount / observedContacted`, read off the SAME grain the numbers above came
   * from (`numberGrain`), so the three figures describe one body of evidence: that grain's spend over
   * its outcomes is `costPerOutcomeUsd`, and its outcomes over its people are this.
   *
   * It is the figure a caller maximises when the binding constraint is the INVENTORY rather than the
   * budget (`?maximize=conversionRate`). A measured 0 is a real answer — a workflow that reached people
   * and converted nobody genuinely converts at 0% — while NULL is "we could not count this": the grain
   * reached nobody, or there is no economics to resolve an outcome count through (cold start), or this
   * is an UNMEASURED row whose figures are an explore allowance rather than a measurement.
   */
  conversionRatePct: number | null;
}

export interface ProjectionRow {
  audienceId: string | null;
  workflow: { workflowDynastySlug: string; workflowDynastyName: string | null };
  estimatesByGrain: Partial<Record<GrainName, GrainBlock>>;
  resolved: ResolvedBlock;
  /**
   * TRUE ⟺ this row rests on real evidence (at least one grain with spend) — every row an established
   * channel serves. FALSE marks a row for a workflow this channel has measured NOTHING for:
   * `estimatesByGrain` is empty, and `resolved` carries the EXPLORE ALLOWANCE — a cost FLOOR (the price
   * of one outreach through the goal's funnel) and no return at all, so an unproven workflow is
   * RANKABLE by a serving consumer while every display / benchmark surface filters on this flag rather
   * than probing for nulls. When the channel has measured nothing whatsoever there is no allowance to
   * state either and every `resolved` figure is null (features-service#805).
   * A row is never half-measured: the two states are what the row rests on, not how much it has.
   */
  measured: boolean;
  /**
   * TRUE on a row for a RETIRED lineage — a workflow dynasty with no active version left (or a slug the
   * catalogue does not describe) that this brand / campaign still spent on. Absent on every other row.
   * It carries its real brand / campaign evidence so the per-workflow rows add up to the scope's own
   * total, and it can NEVER be put forward: `resolved` is all null, so it is unrankable, never
   * recommended and skipped by every consumer that selects on `resolved.costPerOutcomeUsd`.
   */
  retired?: true;
  /**
   * HOW MANY PEOPLE THIS ROW'S AUDIENCE CAN STILL BE SERVED — human-service's own
   * `availableToContactCount`, read LIVE beside the cached evidence (features-service#1035). Present on
   * every audience row (`audienceId` non-null), absent on the brand / campaign column. `0` is the
   * producer saying the audience is served out (every member inside the 3-month re-contact window), so
   * a consumer picking an audience for a serve can skip it while another still has people instead of
   * paying a serve round-trip to learn it; `null` is "we could not read this" and must be treated as
   * unknown, never as 0. It moves no figure and no order here — the rows are what they were.
   */
  availableToContactCount?: number | null;
  /**
   * THIS WORKFLOW'S POSITION IN THE ORDER THIS SERVICE SELECTS ON — 1-based, present ⟺ the caller
   * named a `?leg=`, so every existing body is byte-unchanged.
   *
   * It exists so NO consumer ever re-derives one. A dashboard ranking the subset it happens to display
   * produces a second order, and the two disagree: measured in prod 2026-09-12, the workflow this
   * service recommends sat 18th of 24 on a page that said the list was ranked the way we pick, because
   * the page ranked one row per workflow while the recommendation was chosen over every row.
   *
   * So the rank is a property of the WORKFLOW, not of the row: every row of one dynasty carries the
   * same number, and `recommendedWorkflowDynastySlug` is rank 1 BY CONSTRUCTION rather than by
   * coincidence. It is a TOTAL order — no ties and no gaps — broken deterministically on the dynasty
   * slug, and a workflow that has never run (the explore allowance) can never outrank one with
   * measured evidence.
   *
   * ON A MISSION READ (`?leg=&campaignId=` whose campaign states an offer) the order is instead MATURE
   * cost per outcome, finest grain first (owner rules 2026-09-30, 2026-10-01): mature on the offer, then
   * mature on the brand, then on the fleet, each ascending; the rest keep the order above. When rank 1
   * holds a mature price it is `recommendedWorkflowDynastySlug`, so the two never disagree.
   */
  rank?: number;
  /**
   * THIS ROW'S POSITION AMONG THE ROWS IT IS COMPARABLE WITH — 1-based, present ⟺ `rank` is (the
   * caller named a `?leg=`), so every existing body is byte-unchanged.
   *
   * `rank` is a property of the WORKFLOW, scored over EVERY row a dynasty has. That is the right
   * answer to "which workflow do we pick" and the wrong number to print beside ONE grain's figures,
   * because the cell that won the argmin is usually not the cell on screen. Measured in prod
   * 2026-09-13 (brand `75d7e3e8…`, leg `start_to_conversation`): the rank-1 workflow reads **$175**
   * on its campaign row and **$20.35** on the audience cell that crowned it — 3 conversations on
   * $61 against 13 on $2,272 — so a page ordering its campaign column on `rank` shows an order with
   * no visible relation to the number beside it, and reads as arbitrary. 21 of that channel's 24
   * workflows have no per-audience evidence at all and read the same fleet floor in every column,
   * which is what makes the 3 that DO diverge look like noise rather than the whole story.
   *
   * So a row also states where it sits among the rows sharing its `audienceId` (`null` = the brand /
   * campaign column). Within one scope a dynasty appears exactly ONCE, so there is no argmin to
   * take: the rows sort on their own resolved metric, under the SAME objective (`?maximize=`), the
   * SAME three groups and the SAME tie-break as the workflow order — so no scope can rank an
   * unproven workflow above a measured one, and no consumer ever re-derives an order.
   *
   * The two numbers legitimately DISAGREE, and that disagreement is the point: `rank` says what we
   * would put the customer on next, `scopeRank` says what the column they are reading actually says.
   */
  scopeRank?: number;
  /**
   * WHETHER THIS WORKFLOW IS ASSIGNED TO THE LEG THE READ NAMED — present ⟺ the caller named a
   * `?leg=`, so every funnel- and goal-keyed body is byte-unchanged. A STATED assignment
   * (`lib/workflow-leg-assignments.ts`), never derived from the workflow's model or price:
   * `active` = selectable here; `deprecated` = retired on this leg only, history kept; `unassigned` =
   * never put on this leg. The row is served whatever the state and its figures are unchanged, but the
   * ORDERS act on it: a non-selectable workflow ranks after every selectable one in `rank` and
   * `scopeRank`, and is never `recommendedWorkflowDynastySlug`.
   */
  legAssignment?: LegAssignmentVerdict;
  /**
   * TRANSITIONAL — the pre-assignment verdict block, kept byte-compatible for readers that have not
   * moved to `legAssignment` yet (campaign-service filters on `eligible`). `eligible` ===
   * `legAssignment.selectable`, `ineligibleReason` === `legAssignment.reason`. The model-tier rule is
   * gone: `modelTier` and `unknownTierReason` are always null. `modelAlias` is still the model the
   * workflow's DAG names (display only; it decides nothing). Remove once every reader is on
   * `legAssignment`.
   */
  modelEligibility?: TransitionalModelEligibility;
  /** Present ⟺ the caller named a `?leg=`. See {@link RowMaturity}. */
  maturity?: RowMaturity;
  /**
   * THE PRICE HELD FOR THIS WORKFLOW AT EVERY GRAIN THE ROW'S CASCADE COVERS, ON BOTH BASES — present ⟺
   * the caller named a `?leg=`. A grain with no evidence of its own is still priced (inherited from its
   * parent, provenance stated), so a page never shows a dash where this service holds an opinion and
   * never re-walks the cascade. Additive: `estimatesByGrain` (observed + floored blocks) is untouched.
   * Grains listed: crossOrg, brand, plus campaign on a `?campaignId=` read, offer where the read has an
   * offer grain (brand-level rows), audience on audience rows.
   */
  priceByGrain?: Partial<Record<GrainName, GrainHeldPrices>>;
}

/** See `ProjectionRow.modelEligibility`. */
export interface TransitionalModelEligibility {
  modelAlias: string | null;
  modelTier: null;
  eligible: boolean;
  ineligibleReason: string | null;
  unknownTierReason: null;
}

/**
 * Why a projection carries no measured row. Named rather than left to a bare empty `rows`, because a
 * caller acts very differently on each: "this brand has no active audiences" is a brand fact it cannot
 * work around, while "this channel has nothing measured yet" is a channel that is ready to be served and
 * is simply waiting for its first run.
 */
export type UnmeasuredProjectionReason = "no_active_audiences" | "no_active_workflows" | "no_spend_recorded";

/** The `resolved` block of an UNMEASURED row — every figure absent, nothing borrowed, nothing invented. */
const UNMEASURED_RESOLVED: ResolvedBlock = {
  grain: null,
  costBasis: null,
  costPerClickUsd: null,
  costPerOutcomeUsd: null,
  costPerPaidClientUsd: null,
  costPerMeetingBookedUsd: null,
  roiMultiple: null,
  cacPct: null,
  conversionRatePct: null,
};

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

/**
 * WHICH FUNNEL A LEG WAS PRICED THROUGH, AND WHAT THAT ANSWER RESTS ON.
 *
 * A caller that names a LEG names no funnel — a leg belongs to several at once, and an ENTRY
 * leg feeds every declared funnel that contains it AT ONCE (nobody can buy traffic that travels
 * down only one of them). So one leg must yield ONE recommendation, and the funnel it is priced
 * through is chosen HERE rather than by whichever funnel the caller happened to have in mind.
 *
 * The choice is the brand's BEST-RETURNING declared funnel containing the leg — the identical
 * `returnPerDollar` basis the audience-stats brand-level read combines on, so the two surfaces can never
 * name two different funnels for one brand. It is deliberately NOT the cheapest leg: a dollar buys
 * a paying client through whichever route converts best, and the cheap leg of a funnel worth little
 * is a worse buy than the dear leg of one worth a lot. Same doctrine as the brand-level `max` over
 * declared funnels' returns and the combined-`sales` `min` over routes.
 */
export interface ProjectionLeg {
  /** The leg's single canonical identifier, echoed back. Never parsed into its parts by anybody. */
  legKey: string;
  /** The step a lead is taken out of. `null` — "from nothing" — is an entry leg, not a special case. */
  fromStep: FunnelLegDef["fromStep"];
  /** The step a lead is moved to. */
  toStep: FunnelLegDef["toStep"];
  /** Every DECLARED funnel this leg is a leg of — what the pick below chose between. Their figures
   *  overlap (a shared leg is on all of them) and must never be summed. */
  candidateFunnelKeys: SalesFunnelKey[];
  /** The funnel the numbers on this body were priced through. Equals `funnelKey`. */
  basisFunnelKey: SalesFunnelKey;
  /** WHY that funnel: it was the only declared one containing the leg, it scored best on whatever the
   *  caller is maximising, or nothing containing the leg has that figure yet and the catalogue's
   *  canonical order broke the tie. A caller reads this rather than assuming the answer rests on
   *  measured evidence — and it names WHICH figure won, so it can never say "returned best" about a
   *  pick made on conversion rate. */
  basis:
    | "sole_declared_funnel"
    | "best_returning_declared_funnel"
    | "best_converting_declared_funnel"
    | "no_return_evidence"
    | "no_conversion_evidence";
  /** The basis funnel's return per dollar. Null when nothing measurable stated one — 0 would say the
   *  funnel returns nothing. Stated whether or not the pick was made on it, so the two objectives'
   *  answers are readable side by side. */
  returnPerDollar: number | null;
  /** The basis funnel's conversion rate, on the same terms — its best workflow's measured outcomes per
   *  100 people reached. The figure `?maximize=conversionRate` picks on. Null when unmeasured. */
  conversionRatePct: number | null;
  /**
   * HOW MUCH THE RECOMMENDATION RESTS ON. A recommendation standing on a handful of terminal outcomes
   * is noise, and this states it in the vocabulary the rows already use rather than hiding it:
   * `grain` says WHOSE results the numbers are (`crossOrg` is the fleet benchmark, not this brand's
   * own), `measured` says whether any evidence exists at all, and `resolvedOutcomeCount` is how many
   * of the basis funnel's outcomes were actually observed behind the recommended workflow. Null is
   * "we could not count this", never 0.
   */
  evidence: {
    grain: GrainName | null;
    measured: boolean;
    resolvedOutcomeCount: number | null;
  };
}

export interface WorkflowProjectionResponse {
  featureSlug: string;
  objective: Objective;
  /**
   * WHAT THIS ANSWER WAS RANKED UNDER — always stated, so a consumer can never present a recommendation
   * without knowing what it optimised for. `return` is the default and what every caller that names
   * nothing gets. NOT the same question as `objective`/`goal`, which name the OUTCOME being bought.
   */
  maximize: Maximize;
  goal: GoalEcho;
  /**
   * The SALES FUNNEL a LEG-keyed projection was priced through (equals `leg.basisFunnelKey`). Absent on a
   * goal-keyed request, so a consumer that still sends a goal reads a byte-identical body. Present, it is
   * the authoritative answer to "what was this priced as" — `goal`/`objective` are then only echoes, and
   * the two meeting funnels carry the same echo while carrying different numbers.
   */
  funnelKey?: SalesFunnelKey;
  /**
   * Present ⟺ the caller named a LEG (`?leg=`). It states which of the brand's declared funnels
   * the leg was priced through and what that rests on. Absent on every funnel- or goal-keyed
   * request, so those bodies are byte-identical to what they have always been.
   */
  leg?: ProjectionLeg;
  /**
   * WHAT THE CAMPAIGN GRAIN ANSWERED FOR — present ⟺ the caller named a `?campaignId=`. The byte-same
   * block `/revenue?campaignId=` and `/audience-stats` already carry, so the fleet speaks ONE
   * vocabulary about one campaign: the figures are totalled over the whole IDENTITY (org × brand ×
   * sales funnel × acquisition channel), never over the newest stored row of a campaign that has been
   * running for weeks. A consumer must be able to SEE that the subject is the family rather than infer
   * it from a number that moved.
   */
  campaignIdentity?: CampaignIdentityView;
  economics: EconomicsEcho | null;
  rows: ProjectionRow[];
  recommendedWorkflowDynastySlug: string | null;
  recommendedBudgetUsd: number | null;
  /**
   * TRUE ⟺ at least one row rests on real evidence — every answer an established channel gives.
   * FALSE says this channel has measured nothing for this brand yet; `unmeasuredReason` then names
   * what is missing, so an empty `rows` can never be read as "this brand has nobody to contact".
   */
  measured: boolean;
  /** Present ⟺ `measured` is false. */
  unmeasuredReason?: UnmeasuredProjectionReason;
  /**
   * Present ⟺ a leg-keyed read has workflows but NONE of them is assigned active on the leg, so
   * `recommendedWorkflowDynastySlug` is null by refusal rather than for want of evidence. Never a fall
   * back to an unassigned or deprecated workflow.
   */
  recommendationWithheldReason?: "no_eligible_workflow";
  /**
   * Present ⟺ a leg-keyed read has NO priced workflow but at least one selectable one: the
   * recommendation is then the rank-1 selectable workflow, named so the leg can start, and its cost
   * fields stay null (never an invented price). Absent on every priced recommendation.
   */
  recommendationBasis?: "cold_start";
  /** Present ⟺ the caller named a `?leg=`: the leg's maturity rule and whether it was applied. */
  maturity?: ProjectionMaturity;
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
 * funnel, click-driven by construction) and `form_magnet` is visit → form → paid. Note
 * `website_purchases` maps to the `signup` objective and NOT to the `websitePurchase` goal — that goal
 * is the full self-serve-plus-meeting close funnel, whose rates are not this funnel's.
 *
 * `goal` / `objective` here are ECHOES for consumers that still read them (campaign-service reads
 * `arbitration.goal` in prod); they never re-decide the math, which is keyed on the funnel.
 */
export function funnelToProjectionInputs(key: SalesFunnelKey): {
  objective: Objective;
  goalEcho: GoalEcho;
  singleStepGoal: SingleStepGoal | null;
  formSubmissionGoal: boolean;
  meetingChannel: PricingChannel;
} {
  switch (key) {
    case "sales_meetings_from_conversation":
      return { objective: "meeting-booked", goalEcho: "meetingBooked", singleStepGoal: null, formSubmissionGoal: false, meetingChannel: "reply" };
    case "sales_meetings_from_website":
      return { objective: "meeting-booked", goalEcho: "meetingBooked", singleStepGoal: null, formSubmissionGoal: false, meetingChannel: "click" };
    // The instant-call funnel is the reply funnel with a call inserted: same meeting, bought with a reply.
    case "sales_meetings_from_call":
      return { objective: "meeting-booked", goalEcho: "meetingBooked", singleStepGoal: null, formSubmissionGoal: false, meetingChannel: "reply" };
    case "website_purchases":
      return { objective: "signup", goalEcho: "signup", singleStepGoal: null, formSubmissionGoal: false, meetingChannel: null };
    case "form_magnet":
      return { objective: "form_submissions", goalEcho: "formSubmission", singleStepGoal: null, formSubmissionGoal: true, meetingChannel: null };
    // The two SINGLE-STEP funnels are EXACTLY the two single-step goals this service already prices —
    // `replyUsd / replyToPaidClientPct` and `clickUsd / visitToPaidClientPct` — so they route onto
    // those rather than onto a new word that would price the same thing a second way.
    case "sales_from_conversation":
      return { objective: "positive_replies", goalEcho: "positiveReply", singleStepGoal: "positiveReply", formSubmissionGoal: false, meetingChannel: "reply" };
    case "sales_from_website":
      return { objective: "website_visits", goalEcho: "websiteVisit", singleStepGoal: "websiteVisit", formSubmissionGoal: false, meetingChannel: "click" };
    // The two AD funnels: the advertising platform DELIVERS their first step and no counted signal
    // observes it, so `"none"` masks BOTH unit costs away and every projected figure reads null. That is
    // the honest answer — a projection built on click or reply evidence would price an ad-delivered
    // step against evidence the funnel never buys. The goal echoes stay the nearest existing words, and
    // are lossy exactly as every other echo here is.
    case "sales_meetings_from_ads":
      return { objective: "meeting-booked", goalEcho: "meetingBooked", singleStepGoal: null, formSubmissionGoal: false, meetingChannel: "none" };
    case "lead_forms_from_ads":
      return { objective: "form_submissions", goalEcho: "formSubmission", singleStepGoal: null, formSubmissionGoal: true, meetingChannel: "none" };
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
  channel: PricingChannel,
): { clickUsd: number | null; replyUsd: number | null } {
  if (channel === "click") return { clickUsd: unitCosts.clickUsd, replyUsd: null };
  if (channel === "reply") return { clickUsd: null, replyUsd: unitCosts.replyUsd };
  // NEITHER channel buys the funnel's entry step (an ad delivers it), so nothing may price it and
  // every projected figure downstream reads null rather than a number off the wrong evidence.
  if (channel === "none") return { clickUsd: null, replyUsd: null };
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
 * recommended budget (never the zero-collapsing multi-step funnel when a single-step goal is active).
 *
 * EXPORTED for the SAME reason `outcomeCostForGoal` is: /audience-stats now reports each audience's
 * RETURN PER DOLLAR (`lifetimeRevenueUsd / costPerPaidClientUsd`), which is the identical quantity
 * the funnel ranking (`lib/funnel-ranking.ts`) ranks a leg's candidate funnels on. Routing both through this one function is
 * what stops one brand reading two different returns on two pages.
 */
export function paidClientCostForGoal(
  econ: ProjectionEconomics,
  unitCosts: { clickUsd: number | null; replyUsd: number | null },
  objective: Objective,
  singleStepGoal: SingleStepGoal | null,
  formSubmissionGoal: boolean,
  meetingChannel: PricingChannel = null,
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
  // Each goal's paid-client cost funnels through ITS OWN funnel (coherent: always ≥ that goal's outcome
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
  meetingChannel: PricingChannel = null,
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
  meetingChannel: PricingChannel = null,
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
  meetingChannel: PricingChannel = null,
  // Present ⟺ the caller named a `?leg=`: the grain's cost-per-outcome and outcome COUNT are then
  // denominated in the LEG's own step rather than in the step its basis funnel is named after.
  legTerms: LegOutcomeTerms | null = null,
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

  // WHAT THIS GRAIN'S EVIDENCE SAYS ABOUT THE LEG'S OWN STEP. A leg-keyed read is priced on the step
  // the leg MOVES A LEAD TO — never on the step its basis funnel is named after, which is the whole
  // substitution this removes. The grain's own cascade-floored driver cost is walked forward through
  // the basis funnel's declared rates, so the explore device is untouched and only the denomination
  // moved; an ENTRY leg walks nothing, so its count is a raw observation and its cost the driver's own.
  const legOutcome: GrainLegOutcome | null = legTerms
    ? grainLegOutcome(legTerms, {
        spentUsd,
        driverUnitCostUsd: legTerms.driver === "click" ? costPerClickUsd : costPerPositiveReplyUsd,
        driverObserved: legTerms.driver === "click" ? observedClicks : observedPositiveReplies,
      })
    : null;

  // Goal-resolved outcome count from THIS grain's OWN observed evidence (no floor). Null at cold start
  // (no economics) — mirrors the projected costs' null gate. On a LEG request it is the LEG's own
  // outcome count, so a consumer can never read a count of one step beside the cost of another.
  const resolvedOutcomeCount = legTerms
    ? (legOutcome?.outcomeCount ?? null)
    : econ
      ? resolvedOutcomeCountForGoal({ observedClicks, observedPositiveReplies }, econ, objective, singleStepGoal, formSubmissionGoal, meetingChannel)
      : null;

  return {
    evidence: { spentUsd, observedContacted, observedClicks, observedPositiveReplies },
    unitCosts: { costPerClickUsd, costPerPositiveReplyUsd, costPerContactedUsd },
    resolvedOutcomeCount,
    ...(legOutcome ? { legOutcome } : {}),
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
  meetingChannel: PricingChannel = null,
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
  meetingChannel: PricingChannel = null,
  legTerms: LegOutcomeTerms | null = null,
): ResolvedBlock {
  const measured = (g: GrainName): boolean =>
    !!estimatesByGrain[g] && grainHasObservedOutcome(estimatesByGrain[g]!.evidence, objective, singleStepGoal, meetingChannel);
  // NUMBER source: finest grain with spend (its floored unit costs = max(spent, parent) — Kevin's cascade).
  const numberGrain: GrainName =
    estimatesByGrain.audience
      ? "audience"
      : estimatesByGrain.campaign
        ? "campaign"
        : estimatesByGrain.brand
          ? "brand"
          : "crossOrg";
  const block = estimatesByGrain[numberGrain]!;
  // PROVENANCE label: finest MEASURED grain (observed the outcome), else crossOrg benchmark. Decoupled
  // from `numberGrain` so a 0-outcome grain's spend-floor number is never labelled "this brand/audience".
  const grain: GrainName =
    measured("audience") ? "audience" : measured("campaign") ? "campaign" : measured("brand") ? "brand" : "crossOrg";
  const unitCosts = { clickUsd: block.unitCosts.costPerClickUsd, replyUsd: block.unitCosts.costPerPositiveReplyUsd };
  // A LEG-keyed read states the cost of ONE OUTCOME OF THE LEG. The goal routing below prices the step
  // the basis funnel is NAMED after, which for an entry leg is several rungs further down the funnel.
  const costPerOutcomeUsd = legTerms
    ? (block.legOutcome?.costPerOutcomeUsd ?? null)
    : econ
      ? outcomeCostForGoal(econ, unitCosts, objective, singleStepGoal, formSubmissionGoal, meetingChannel)
      : null;
  return {
    grain,
    costBasis: GRAIN_COST_BASIS[numberGrain],
    costPerClickUsd: block.unitCosts.costPerClickUsd,
    costPerOutcomeUsd,
    costPerPaidClientUsd: block.projected.costPerPaidClientUsd,
    costPerMeetingBookedUsd: block.projected.costPerMeetingBookedUsd,
    roiMultiple: block.projected.roiMultiple,
    cacPct: block.projected.cacPct,
    // Same grain, same evidence as the costs above — never a blend of a measured rate with a floored
    // cost. Null rather than 0 when the grain reached nobody or nothing resolved an outcome count.
    conversionRatePct: conversionRatePctOf(block),
  };
}

/**
 * The conversion rate of ONE grain: its resolved outcomes over the people it actually reached.
 *
 * `resolvedOutcomeCount` uses ONLY observed evidence (no cascade floor), so this is a measurement and
 * never a projection dressed as one — which is exactly what makes it rankable against its siblings.
 * There is deliberately no floor here: the cascade floors a COST so a barely-tried workflow cannot look
 * free, and the mirror of that for a RATE is to report the honest measured rate. A workflow with no
 * evidence at all is `measured: false` and is excluded from every recommendation on that flag already.
 */
function conversionRatePctOf(block: GrainBlock): number | null {
  const contacted = block.evidence.observedContacted;
  if (block.resolvedOutcomeCount == null || contacted <= 0) return null;
  return (100 * block.resolvedOutcomeCount) / contacted;
}

/**
 * The price of ONE OUTREACH in this channel — Σ measured spend ÷ Σ measured leads contacted. It is the
 * smallest amount of real money that can buy an UNPROVEN workflow its first piece of evidence, so it is
 * the first rung of the same floor ladder every measured row stands on (`max(own spend, parent)`, and an
 * unproven workflow's own spend is still 0). The brand's OWN measured evidence prices it when the brand
 * has any — that is the money this brand actually pays for an outreach — else the fleet's.
 *
 * NULL when the channel has measured nothing at all: there is then no price to state, and the projection
 * falls back to the all-null unmeasured row (features-service#805's answer, unchanged).
 *
 * Do NOT replace this with the channel's pooled cost-per-OUTCOME. That figure is dominated by the
 * workflows that have already spent — prod 2026-08-25, brand `75d7e3e8…`: $643 per meeting against a
 * $337 measured leader — so an unproven workflow priced there is never picked by a consumer ranking on
 * cost and stays exactly as invisible as it is today.
 */
function channelOutreachPriceUsd(
  brandGrain: Map<string, WorkflowGrainEvidence>,
  costMap: Map<string, { totalCostInUsdCents: number; completedRuns: number }>,
  aggregatedOutcomes: Map<string, Record<string, number>>,
): number | null {
  let brandCents = 0;
  let brandContacted = 0;
  for (const ev of brandGrain.values()) {
    brandCents += ev.totalCostInUsdCents;
    brandContacted += ev.contacted;
  }
  if (brandCents > 0 && brandContacted > 0) return brandCents / 100 / brandContacted;

  let fleetCents = 0;
  let fleetContacted = 0;
  for (const [activeSlug, cost] of costMap) {
    fleetCents += cost.totalCostInUsdCents;
    fleetContacted += aggregatedOutcomes.get(activeSlug)?.recipientsContacted ?? 0;
  }
  if (fleetCents > 0 && fleetContacted > 0) return fleetCents / 100 / fleetContacted;
  return null;
}

/**
 * The `resolved` block of an UNPROVEN row: the EXPLORE ALLOWANCE, priced through the goal's own funnel
 * from the channel's outreach price so it is denominated in the same unit every other row reports.
 *
 * It states a COST FLOOR and nothing else. `costPerPaidClientUsd`, `roiMultiple` and `cacPct` stay NULL
 * because a return needs evidence that this workflow converts, and it has none — a return computed off
 * an exploration floor would print the biggest number on the page. `grain` stays null: no grain measured
 * this, so there is no provenance to label and nothing is borrowed from the workflows that do have one.
 */
function exploreResolved(
  outreachUsd: number,
  // Null only on a LEG read (`legTerms` present), whose allowance is denominated in the leg's step and
  // reads no economics.
  econ: ProjectionEconomics | null,
  objective: Objective,
  singleStepGoal: SingleStepGoal | null,
  formSubmissionGoal: boolean,
  meetingChannel: PricingChannel,
  legTerms: LegOutcomeTerms | null = null,
): ResolvedBlock {
  const unitCosts = { clickUsd: outreachUsd, replyUsd: outreachUsd };
  // On a LEG request the allowance is denominated in the leg's own step, exactly as every measured row
  // is — an allowance priced on a different step than the rows it is ranked beside is not comparable.
  const legAllowance =
    legTerms && legTerms.rateFromDriver != null && legTerms.rateFromDriver > 0
      ? outreachUsd / legTerms.rateFromDriver
      : null;
  return {
    grain: null,
    // An explore allowance is a FLOOR, not a measured cost, so it states no accounting basis.
    costBasis: null,
    costPerClickUsd: outreachUsd,
    costPerOutcomeUsd: legTerms
      ? legAllowance
      : econ
        ? outcomeCostForGoal(econ, unitCosts, objective, singleStepGoal, formSubmissionGoal, meetingChannel)
        : null,
    costPerPaidClientUsd: null,
    costPerMeetingBookedUsd: null,
    roiMultiple: null,
    cacPct: null,
    // An allowance says what a first outreach costs; it says NOTHING about how many of the people it
    // reaches convert, because it has reached none. A 0 there would rank an unproven workflow last on
    // a claim nobody measured.
    conversionRatePct: null,
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

/**
 * WHICH COST the ladder's money is read on. `billed` = what the client is charged, the only basis a
 * customer read ever answers on. `actual` = what running each workflow really cost us (vendor cost,
 * before our markup) — STAFF ONLY, served on its own `/internal/...` path the gateway mounts behind its
 * staff gate. The ORDER (rank, scopeRank, the recommendation) stays the billed one on both: it is what
 * campaign-service acts on. See lib/actual-cost-projection.ts.
 */
type ProjectionCostBasis = "billed" | "actual";

export async function handleWorkflowProjection(req: Request, res: Response, costBasis: ProjectionCostBasis) {
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
  // `?funnel=` is RETIRED (wave C2): refused, never silently ignored. See lib/retired-funnel-param.ts.
  if (namesRetiredFunnel(req.query as Record<string, unknown>)) {
    return res.status(400).json(FUNNEL_RETIRED_BODY);
  }

  // A caller may instead name ONE LEG (`?leg=`) — the leg it is putting a budget behind — with no
  // sales funnel at all, which is the whole point: a leg belongs to several funnels, so a campaign
  // can no longer be identified by one of them. The funnel this is priced through is resolved BELOW,
  // from the brand's own declared set, and stated back on `leg`.
  const legParam = req.query.leg as string | undefined;
  let legKey: string | null = null;
  if (legParam != null && legParam !== "") {
    // Both spellings of an outbound leg are one identity (wave 1, `lib/funnel-legs.ts`): resolved to the stored one.
    legKey = matchChannelLegKey(featureSlug, legParam);
    if (!legKey) {
      return res.status(400).json({
        error: `leg must be one of: ${FUNNEL_LEG_KEYS.join(", ")}`,
        reason: "leg_unrecognised",
      });
    }
  }

  // A caller may narrow the ladder to ONE CAMPAIGN, so the grains a screen compares — this campaign,
  // this brand, every client we run the channel for — all come from one answer instead of being
  // stitched together from two endpoints. It is only answerable BESIDE a leg: a campaign is bought for
  // exactly one leg, and adding a grain to a funnel- or goal-keyed body would move an answer
  // campaign-service's production workflow selection reads. So it FAILS LOUD rather than being ignored.
  const campaignIdParam = req.query.campaignId as string | undefined;
  const campaignId = campaignIdParam != null && campaignIdParam !== "" ? campaignIdParam : null;
  if (campaignId && !legKey) {
    return res.status(400).json({
      error: "campaignId is answered beside the leg the campaign is bought for: name a leg as well",
      reason: "campaign_requires_leg",
    });
  }

  // A caller may name the OFFER a leg is priced for WITHOUT a campaign — the case of a brand being set
  // up, where the customer picks one offer and asks what each leg would cost before any campaign
  // exists (so there is no campaign to name the offer through). Leg reads only, like `campaignId`: a
  // funnel- or goal-keyed body must not move. Beside a campaign it is a 400: the campaign already
  // names its offer, and two answers to one question would contradict each other.
  const offerIdParam = ((req.query.offerId as string | undefined) ?? "").trim();
  const namedOfferId = offerIdParam !== "" ? offerIdParam : null;
  if (namedOfferId && !legKey) {
    return res.status(400).json({
      error: "offerId is answered beside a leg: name the leg this offer's budget would buy",
      reason: "offer_requires_leg",
    });
  }
  if (namedOfferId && campaignId) {
    return res.status(400).json({
      error: "offerId and campaignId are mutually exclusive: a campaign already sells exactly one offer",
      reason: "offer_and_campaign",
    });
  }

  const resolved = legKey ? null : resolveGoalInputs(goalParam);
  if (resolved && !resolved.ok) {
    return res.status(400).json({
      error:
        "goal must be one of: signup, meetingBooked, websitePurchase, sales, websiteVisit, positiveReply, formSubmission, whatsappConversation (snake/kebab spellings also accepted)",
    });
  }
  const inputsForFunnel = (key: SalesFunnelKey) => {
    const f = funnelToProjectionInputs(key);
    return { objective: f.objective, goal: f.goalEcho, singleStepGoal: f.singleStepGoal, formSubmissionGoal: f.formSubmissionGoal, meetingChannel: f.meetingChannel };
  };
  // On a LEG request these are placeholders until the basis funnel is resolved inside the try below
  // (it needs the brand's declared set and the shared evidence). Nothing is projected from them.
  const inputs = legKey
    ? inputsForFunnel(funnelsContainingLeg(legKey)[0])
    : { ...(resolved as { ok: true } & GoalInputs), meetingChannel: null as PricingChannel };
  let { objective, goal, singleStepGoal, formSubmissionGoal, meetingChannel } = inputs;
  const budgetUsd = budgetRaw != null && budgetRaw !== "" ? Number(budgetRaw) : null;

  // The actual-cost basis has no discount axis: vendor cost is what the vendor charged us whatever the
  // client pays. A pricing selector is refused, never silently ignored.
  if (costBasis === "actual" && req.query.pricing !== undefined) {
    return res.status(400).json({ error: "pricing not supported on the actual-cost basis", reason: "not_on_actual_cost_basis" });
  }
  // GROSS (default) vs NET pricing. Omitted → gross → byte-identical to today.
  const pricing = parsePricing(req.query.pricing);
  if (pricing === null) {
    return res.status(400).json({ error: "pricing must be one of: gross, net" });
  }

  // WHAT THE CALLER IS MAXIMISING. Absent → `return`, byte-identically to every answer given before
  // this existed; a present-but-unrecognised word FAILS LOUD rather than quietly ranking on return.
  const maximizeParam = parseMaximize(req.query as Record<string, unknown>);
  if (!maximizeParam.ok) {
    return res.status(400).json({ error: MAXIMIZE_ERROR, reason: "maximize_unrecognised" });
  }
  const maximize = maximizeParam.maximize;

  // HOW MANY OBSERVED PICKS the body states. Only ever read beside a `?campaignId=` (the block is a
  // fact about ONE campaign's own triggers), bounded because a debug panel must not be able to ask for
  // a campaign's whole history, and `0` is a real answer — "do not spend the read". An unreadable or
  // out-of-range value FAILS LOUD rather than being clamped into something the caller did not ask for.
  const picksRaw = req.query.picks as string | undefined;
  let picksLimit = OBSERVED_PICKS_DEFAULT;
  if (picksRaw != null && picksRaw !== "") {
    const parsed = Number(picksRaw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > OBSERVED_PICKS_MAX) {
      return res.status(400).json({
        error: `picks must be a whole number between 0 and ${OBSERVED_PICKS_MAX}`,
        reason: "picks_unrecognised",
      });
    }
    picksLimit = parsed;
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

    // The basis funnel's own offer terms (its effective leg rates, the offer's lifetime revenue). Set only
    // on a LEG read (priced through one of the funnels the brand's leads walk).
    let funnelEconomics: Partial<SalesEconomics> | null = null;
    // THE CAMPAIGN'S IDENTITY, resolved BEFORE the declared-funnel read below — it is what names the
    // OFFER that read is priced on. A campaign as a customer knows it is (org, brand, sales funnel,
    // acquisition channel) — campaign-service mints a new row on every workflow switch and keeps the
    // ancestors, so a figure scoped to the newest row would describe the last few days of a campaign
    // that has been running for weeks. FAIL-SOFT, like every other surface that reads it: with
    // campaign-service unreachable the campaign falls back to its own family of one, which is a real
    // answer about a real subset, never the brand's numbers under its name.
    let campaignIdentity: CampaignIdentity | null = null;
    let campaignIdentityView: CampaignIdentityView | null = null;
    let campaignScopeIds: string[] | null = null;
    // THE OFFER GRAIN'S SCOPE — the campaigns (of this channel) selling the offer the named campaign
    // sells. It exists so a screen comparing "this brand" against "this offer" for one workflow reads
    // BOTH off this one ladder, on one basis: the same spend, the same counted outcomes, the same
    // cascade floor. Read from any other surface (the realized `/revenue?groupBy=workflow&offerId=`
    // ratio divides the MATURE cohort and nulls at 0 outcomes), the two columns disagreed on a brand
    // selling ONE offer, where they describe the identical set of campaigns (features-service#1172).
    let offerScopeIds: string[] | null = null;
    if (campaignId) {
      const families = await fetchCampaignFamiliesSoft(brandId, featureSlug, { orgId, userId, runId });
      campaignIdentity = families.identityOf(campaignId);
      campaignIdentityView = describeIdentity(campaignIdentity, campaignId);
      campaignScopeIds = campaignIdentityView.campaignIds;
      if (legKey && campaignIdentity?.offerId) {
        offerScopeIds = await fetchOfferScopeIdsSoft(campaignIdentity.offerId, brandId, featureSlug, { orgId, userId, runId });
      }
    }

    // ── WHICH OFFER'S TERMS THIS READ IS PRICED ON ──────────────────────────────────────────
    //
    // A declared funnel hangs off an OFFER: each carries its own conversion rates, its own lifetime
    // revenue and its own value proposition, so brand-service refuses (409 SEVERAL_OFFERS) a
    // brand-scoped read for a brand selling more than one rather than serve one proposition's economics
    // under another's name. A campaign sells exactly ONE offer, so naming a campaign names the offer
    // transitively — no extra call, and no new query parameter for a consumer to learn. Absent → today's
    // brand-scoped read, which brand-service answers for every brand selling one thing, so a
    // single-offer brand is byte-unchanged.
    // `?offerId=` names it directly for a (brand, offer) pair that has no campaign yet.
    const scopeOfferId = campaignIdentity?.offerId ?? namedOfferId ?? null;

    // The LIVE reads beside the cached evidence need nothing the pricing-funnel read below answers, so
    // they start now and are awaited with the evidence (see the `Promise.all` below for what each is).
    const liveReads = {
      triggerRuns:
        campaignScopeIds && picksLimit > 0
          ? fetchCampaignTriggerRunsSoft(campaignScopeIds, { orgId, userId, runId, brandId }, picksLimit)
          : Promise.resolve(null),
      contentModels: legKey ? fetchWorkflowContentModelsSoft(featureSlug, identity) : Promise.resolve(null),
      legAssignments: legKey ? fetchLegAssignments(featureSlug, legKey) : Promise.resolve(null),
      audienceAvailability: fetchActiveAudienceAvailabilitySoft(brandId, { orgId, userId, runId, featureSlug: headerFeatureSlug }),
    };
    // Awaited below (fail-loud there); a refusal answered before then must not leave it unhandled.
    liveReads.legAssignments.catch(() => {});

    let declaredFunnels: Awaited<ReturnType<typeof fetchPricingFunnels>> | null = null;
    if (legKey) {
      try {
        // Wave C1: no declared set is read. A named LEG is read through the funnels the brand's leads
        // walk from the step it lands on (reading-funnels.ts).
        declaredFunnels = await fetchPricingFunnels(brandId, orgId, scopeOfferId, { legKeys: [legKey] });
      } catch (error) {
        // SEVERAL OFFERS, none named. A LEG read cannot degrade: the funnel set is not a refinement
        // here, it is the ANSWER to "which of this brand's funnels is this leg priced through" —
        // widening to every catalogue funnel containing the leg would price the brand on propositions
        // it may not sell. So the refusal is passed on as what it is: a question with several answers,
        // naming them, and naming the one thing that resolves it. A 409 rather than a 502 — the caller
        // is not looking at an outage, it is looking at a choice it can make.
        if (error instanceof OfferNotOfBrandError) {
          return res.status(404).json({ error: error.message, reason: "offer_not_found", offerId: error.offerId });
        }
        if (error instanceof SeveralOffersDeclaredError) {
          const unresolved = describeSeveralOffers(error)!;
          return res.status(409).json({
            error: `${unresolved.message} A leg is priced through one of the brand's declared funnels, so name the campaign this leg is bought for (a campaign sells exactly one offer).`,
            reason: "several_offers",
            offers: unresolved.offers,
          });
        }
        if (error instanceof SalesFunnelsUnavailableError) {
          return res.status(502).json({ error: error.message, reason: "declared_funnels_unavailable" });
        }
        throw error;
      }
    }

    // A leg the brand's funnels do not contain has no cost to serve. Never an empty body, never a
    // substituted funnel.
    let legCandidates: SalesFunnelKey[] = [];
    if (legKey && declaredFunnels) {
      const containing = funnelsContainingLeg(legKey);
      const declared = declaredFunnels.map((f) => f.funnelKey);
      legCandidates = declared.filter((k) => containing.includes(k));
      if (legCandidates.length === 0) {
        return res.status(404).json({
          error: `none of the sales funnels this brand declared contains the ${legKey} leg, so there is no cost to estimate for it`,
          reason: "leg_not_declared",
          legKey,
          declaredFunnelKeys: declared,
        });
      }
    }

    // WHAT ACTUALLY RAN — read LIVE beside the cached evidence, never from the snapshot: a figure whose
    // job is to say what is happening right now cannot be served from a cell half an hour old. Fired in
    // the same round trip as the fan-out (it needs only the campaign ids, not the ladder), so it costs
    // no extra wall-clock, and FAIL-SOFT so a runs blip nulls one block rather than a whole page.
    // The ladder's evidence on one cost basis. The billed body reads it on `pricing`; the staff
    // actual-cost body ALSO reads it on the vendor basis (priced rows at vendor cost) and on the
    // unpriced basis (billed amount of the rows with no known vendor cost) — same scope, same outcomes,
    // one Gold cell each (`pricing` is in the key).
    const evidenceScopeKey = (evidencePricing: Pricing | "actual") =>
        buildScopeKey(featureSlug, {
          orgId,
          brandId,
          pricing: evidencePricing,
          // The IDENTITY, not the campaign: every member of one family asks the same question, so they
          // land on ONE cell instead of paying a full fan-out per stopped ancestor.
          ...(campaignIdentityView ? { campaign: campaignIdentityView.key } : {}),
          // The offer's campaign SET, not only its id: a campaign minted under the offer changes the
          // grain's evidence while no other key part moves.
          ...(offerScopeIds ? { offerCampaigns: offerScopeIds.join("+") } : {}),
          // A leg-keyed read's evidence is scoped to the leg's campaigns, so it never shares a cell with
          // a leg-less read (or the other leg).
          ...(legKey ? { leg: legKey } : {}),
        });
    const computeEvidence = (evidencePricing: Pricing) =>
      fetchWorkflowProjectionEvidence({
        featureSlug,
        brandId,
        identity,
        pricing: evidencePricing,
        campaignIds: campaignScopeIds,
        offerCampaignIds: offerScopeIds,
        legKey,
      });
    const evidenceOn = (evidencePricing: Pricing) =>
      servedCached({
        view: "workflow-projection-evidence",
        scopeKey: evidenceScopeKey(evidencePricing),
        orgId,
        compute: () => computeEvidence(evidencePricing),
      });
    // The actual-cost body JOINS three versions of the evidence row by row (billed counts, vendor money,
    // unpriced money), so they must be ONE snapshot of the world: three cells refreshed independently
    // served a 13-hour-old billed cell beside fresh vendor cells (prod 2026-10-01, campaign 583a4e74…:
    // 64 contacted / 1 visit beside the billed read's 126 / 2, and a $33.74 grain stated "unknown" with
    // 0 priced and 0 unpriced). One cell, computed together, always one age.
    const actualEvidence = () =>
      servedCached({
        view: "workflow-projection-evidence-actual",
        scopeKey: evidenceScopeKey("actual"),
        orgId,
        compute: async () => {
          const [billed, vendor, unpriced] = await Promise.all([
            computeEvidence(pricing),
            computeEvidence("vendor"),
            computeEvidence("vendorUnpriced"),
          ]);
          return { billed, vendor, unpriced };
        },
      });
    const [evidenceSet, goalEconomics, triggerRuns, contentModels, legAssignments, audienceAvailability] = await Promise.all([
      costBasis === "actual"
        ? actualEvidence()
        : evidenceOn(pricing).then((billed) => ({ billed, vendor: null, unpriced: null })),
      // A GOAL-keyed read prices on the offer's terms over every funnel the scope walks; a LEG read
      // prices on its basis funnel's own terms below, so it reads nothing here.
      legKey
        ? Promise.resolve(null)
        : fetchFunnelPricedEconomics(brandId, orgId, undefined, scopeOfferId).then((priced) => priced.economics.economics),
      liveReads.triggerRuns,
      // Read ONLY beside a `?leg=`, so a funnel- or goal-keyed request issues ZERO extra reads and its
      // body is byte-unchanged. The model each workflow names is DISPLAY ONLY (fail-soft); the leg
      // assignment is what decides, so it is read LIVE from our own table and FAILS LOUD — a swallowed
      // read would say "nothing is assigned" and exclude every workflow on a database blip.
      liveReads.contentModels,
      liveReads.legAssignments,
      // HOW MANY PEOPLE EACH AUDIENCE CAN STILL BE SERVED — live, never from the snapshot: an audience
      // served out an hour ago must not be offered for a serve off a cell that predates it
      // (features-service#1035). Shared 30s (keyed on org + brand) with the evidence compute's own list
      // read; fail-soft.
      liveReads.audienceAvailability,
    ]);
    const { billed: evidence, vendor: vendorEvidence, unpriced: unpricedEvidence } = evidenceSet;
    // THE LEG'S BASIS FUNNEL. Ranked on the IDENTICAL `returnPerDollar` every per-brand return uses
    // (`rankDeclaredFunnels`, one implementation) and restricted to the funnels that actually contain the leg. Pure: it
    // projects the SAME already-fetched evidence once per candidate and issues no further IO.
    let legBlock: ProjectionLeg | undefined;
    let legBasisFunnelKey: SalesFunnelKey | null = null;
    let legBasis: ProjectionLeg["basis"] = "sole_declared_funnel";
    let legReturnPerDollar: number | null = null;
    let legConversionRatePct: number | null = null;
    if (legKey && declaredFunnels) {
      const ranked = rankDeclaredFunnels({
        featureSlug,
        funnels: declaredFunnelsToRank(declaredFunnels).filter((f) => legCandidates.includes(f.funnelKey)),
        evidence,
        // The leg is priced through the funnel that is best AT WHAT THE CALLER ASKED FOR. Ranking the
        // basis funnel on return while ranking the workflows on conversion rate would make one body
        // answer two questions at once, which is the contradiction this parameter exists to remove.
        maximize,
        // Each candidate is projected on the LEG's own terms, so the maturity rule prices it exactly as the
        // rows below are priced: a funnel is never picked on a flash return while its rows read mature.
        legKey,
      });
      // Nothing containing the leg has a measurable return yet — the leg is still answerable, so the
      // catalogue's canonical order breaks the tie deterministically and `basis` says so out loud.
      legBasisFunnelKey =
        ranked.recommendation?.funnelKey ??
        [...legCandidates].sort((a, b) => salesFunnelIndex(a) - salesFunnelIndex(b))[0];
      const basisEntry = ranked.ranking.find((r) => r.funnelKey === legBasisFunnelKey) ?? null;
      legReturnPerDollar = basisEntry?.returnPerDollar ?? null;
      legConversionRatePct = basisEntry?.conversionRatePct ?? null;
      legBasis =
        legCandidates.length === 1
          ? "sole_declared_funnel"
          : ranked.recommendation
            ? maximize === "conversionRate"
              ? "best_converting_declared_funnel"
              : "best_returning_declared_funnel"
            : maximize === "conversionRate"
              ? "no_conversion_evidence"
              : "no_return_evidence";
      funnelEconomics = declaredEconomicsForFunnel(declaredFunnels, legBasisFunnelKey);
      ({ objective, goal, singleStepGoal, formSubmissionGoal, meetingChannel } = inputsForFunnel(legBasisFunnelKey));
    }

    // THE LEG'S OWN STEP is what a leg-keyed answer is denominated in. The basis funnel above decides
    // WHICH rates walk the observed signal forward to that step; it no longer decides which step is
    // being bought. Resolved here, once the basis funnel and the brand's merged economics are known.
    let legTerms: LegOutcomeTerms | null = null;
    // Offer terms only (owner 2026-10-05): the leg's basis funnel on a leg read, every priced funnel on a
    // goal read. Null (no stated lifetime revenue / nothing priced) → rows with no projected figure.
    const mergedEconomics = legKey
      ? legBasisFunnelKey
        ? economicsFromTerms(funnelEconomics, [legBasisFunnelKey]).economics
        : null
      : goalEconomics;
    const internalToStep = legKey ? await internalPipeToStep(featureSlug, legKey) : null;
    if (legKey && legBasisFunnelKey && internalToStep) {
      // An INTERNAL pipe's outcome is OBSERVED (the follow-up ledger: who it acted on reached its step,
      // `withInternalPipeCounts`), exactly like an entry pipe's: nothing is walked from another step.
      legTerms = { funnelKey: legBasisFunnelKey, outcomeStep: internalToStep as ChannelStepKey, driver: "reply", rateFromDriver: 1, outcomeObserved: true };
    } else if (legKey && legBasisFunnelKey && mergedEconomics) {
      legTerms = legTermsForFunnel(legKey, legBasisFunnelKey, mergedEconomics);
    } else if (legKey && legBasisFunnelKey) {
      // No offer terms: nothing is PROJECTED (no paid-client cost, return, %CAC), but an ENTRY leg's cost
      // per outcome is the observed signal's own unit cost and needs no rate, so it is still served
      // (`entryLegOutcomeTerms`). A later leg walks declared rates and stays unpriced (null).
      const leg = funnelLeg(legKey);
      legTerms = leg ? entryLegOutcomeTerms(legBasisFunnelKey, leg.toStep.key) : null;
    }

    // ── IS EACH WORKFLOW ASSIGNED TO THIS LEG ─────────────────────────────────────────────────────
    //
    // One verdict per DYNASTY, read from the stated assignment (never from the workflow's model or
    // price), attached to every row of that dynasty inside `projectFromEvidence`.
    let legAssignmentByDynasty: Map<string, LegAssignmentVerdict> | null = null;
    let modelAliasByDynasty: Map<string, string | null> | null = null;
    if (legKey && legAssignments) {
      const leg = funnelLeg(legKey)!;
      const dynastySlugs = new Set(evidence.workflows.map((w) => w.workflowDynastySlug));
      legAssignmentByDynasty = new Map(
        [...dynastySlugs].map((slug) => [slug, legAssignmentVerdict(legAssignments.get(slug), leg.toStep.label)]),
      );
      modelAliasByDynasty = contentModels;
    }

    const pricedFunnelKey = legBasisFunnelKey;
    const projectOn = (ev: WorkflowProjectionEvidence) => projectFromEvidence({
      featureSlug,
      objective,
      goal,
      singleStepGoal,
      formSubmissionGoal,
      meetingChannel,
      ...(pricedFunnelKey ? { funnelKey: pricedFunnelKey } : {}),
      legTerms,
      ...(legTerms ? { legKey } : {}),
      legAssignmentByDynasty,
      modelAliasByDynasty,
      evidence: ev,
      economics: mergedEconomics,
      maximize,
    });
    const response = projectOn(evidence);

    if (legKey && legBasisFunnelKey) {
      const leg = funnelLeg(legKey)!;
      // What the recommendation rests on, read off the row it rests on: the brand-level row of the
      // recommended workflow. A count of a handful is noise and the caller is owed the number, not a
      // verdict — so it is stated beside the grain that says whose results these are.
      const recommendedRow =
        response.rows.find(
          (r) => r.audienceId === null && r.workflow.workflowDynastySlug === response.recommendedWorkflowDynastySlug,
        ) ?? null;
      legBlock = {
        legKey,
        fromStep: leg.fromStep,
        toStep: leg.toStep,
        candidateFunnelKeys: legCandidates,
        basisFunnelKey: legBasisFunnelKey,
        basis: legBasis,
        returnPerDollar: legReturnPerDollar,
        conversionRatePct: legConversionRatePct,
        evidence: {
          grain: recommendedRow?.resolved.grain ?? null,
          measured: recommendedRow?.measured ?? false,
          resolvedOutcomeCount:
            recommendedRow?.estimatesByGrain.brand?.resolvedOutcomeCount ??
            recommendedRow?.estimatesByGrain.crossOrg?.resolvedOutcomeCount ??
            null,
        },
      };
    }

    // The bandit's OWN choices, newest first. Present ⟺ the caller named a campaign and asked for a
    // non-zero window; `null` there is "we could not read this", and it is deliberately NOT the
    // campaign row's CONFIGURED workflow, which is the number badging this as "running" got wrong.
    const observedPicks =
      campaignScopeIds && picksLimit > 0
        ? triggerRuns
          ? buildObservedPicks(triggerRuns, evidence.workflows, picksLimit)
          : null
        : undefined;

    if (costBasis === "actual" && vendorEvidence && unpricedEvidence) {
      // The ORDER is the billed one; only the money is read at vendor cost (lib/actual-cost-projection.ts).
      const actual = overlayVendorProjection(response, projectOn(vendorEvidence), projectOn(unpricedEvidence));
      // The leg's basis-funnel RETURN is a money ratio: re-read on vendor spend, and null when any spend
      // behind it could not be priced — never the billed ratio under the actual name.
      if (legBlock && legBasisFunnelKey && declaredFunnels) {
        const vendorRanked = rankDeclaredFunnels({
          featureSlug,
          funnels: declaredFunnelsToRank(declaredFunnels).filter((f) => f.funnelKey === legBasisFunnelKey),
          evidence: vendorEvidence,
          maximize,
          legKey,
        });
        legBlock = {
          ...legBlock,
          returnPerDollar: actual.unpricedBilledCostUsd > 0 ? null : (vendorRanked.ranking[0]?.returnPerDollar ?? null),
        };
      }
      const actualRows = withAudienceAvailability(actual.rows as unknown as ProjectionRow[], audienceAvailability);
      return res.json({
        ...actual,
        costBasis: "actual" as const,
        rows: actualRows,
        ...(legBlock ? { leg: legBlock } : {}),
        ...(campaignIdentityView ? { campaignIdentity: campaignIdentityView } : {}),
        ...(observedPicks !== undefined ? { observedPicks } : {}),
      });
    }

    const rows = withAudienceAvailability(response.rows, audienceAvailability);

    res.json({
      ...response,
      rows,
      ...(legBlock ? { leg: legBlock } : {}),
      ...(campaignIdentityView ? { campaignIdentity: campaignIdentityView } : {}),
      ...(observedPicks !== undefined ? { observedPicks } : {}),
    });
  } catch (error) {
    console.error("[features-service] Workflow projection error:", error);
    res.status(502).json({ error: "Failed to compute workflow projection" });
  }
}

// The customer read: ALWAYS the billed basis, whatever it is sent. Its gateway forward is transparent,
// so the actual basis must not be reachable through any parameter of this path.
//
// Both run inside the interactive read scope (lib/lead-copy.ts withInteractiveReads), like the offer
// revenue read: the live reads this handler makes on the REQUEST path beside the cached evidence (the
// campaign's family, the offer's scope, the pricing funnels, the workflow catalogue, the observed picks,
// the audiences' availability) are then shared across the views a page polls at once (3s, the catalogue
// 30s; fetch-retry.ts), instead of each poll of each leg re-asking every sibling. Measured in prod
// 2026-10-08 (owner's org, warm Gold cell): the catalogue read alone cost 300-1000ms per request.
router.get("/features/:featureSlug/workflow-projection", apiKeyAuth, (req, res) =>
  withInteractiveReads(() => handleWorkflowProjection(req, res, "billed")),
);

// STAFF ONLY — the same ladder with every money figure at VENDOR cost (before our markup); the order is
// the billed one. The api-service gateway mounts this path behind requireStaff; it is never proxied on
// a customer route. See lib/actual-cost-projection.ts.
router.get("/internal/features/:featureSlug/workflow-projection/actual-cost", apiKeyAuth, (req, res) =>
  withInteractiveReads(() => handleWorkflowProjection(req, res, "actual")),
);

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
  /**
   * CAMPAIGN-grain evidence keyed by the dynasty's ACTIVE workflow slug — present ⟺ the caller named a
   * `?campaignId=`, and totalled over that campaign's whole IDENTITY. It rides the evidence object (and
   * therefore the Gold snapshot's `scope_key`, which carries the identity) so a campaign-scoped read
   * never replays a body computed for the brand.
   */
  campaignGrain?: Array<[string, WorkflowGrainEvidence]>;
  /**
   * OFFER-grain evidence keyed by the dynasty's ACTIVE workflow slug — present ⟺ a leg-keyed read named
   * a `?campaignId=` whose campaign states an offer. Totalled over every campaign of this channel
   * selling that offer, by the byte-same reader the campaign grain uses, so the offer column and the
   * brand column differ only by which campaigns they cover.
   */
  offerGrain?: Array<[string, WorkflowGrainEvidence]>;
  retiredOfferGrain?: Array<[string, WorkflowGrainEvidence]>;
  /**
   * RETIRED lineages (a dynasty with no active version left, or a slug the catalogue does not describe)
   * this brand / this campaign identity spent on — keyed by the dynasty slug. They are real spend and
   * real outcomes, so they get a row (never rankable, never recommended — see `retired` on the row),
   * and the per-workflow rows then sum to the scope's own total. Optional: a snapshot written before
   * they existed reads as none.
   */
  retiredBrandGrain?: Array<[string, WorkflowGrainEvidence]>;
  retiredCampaignGrain?: Array<[string, WorkflowGrainEvidence]>;
  /**
   * The LEG this evidence is scoped to (every grain counts only that leg's campaigns). Absent on a
   * leg-less read. It also makes a grain count only when it REACHED somebody on the leg.
   */
  legKey?: string;
  /**
   * THE MATURE TWIN of every grain above (`lib/maturity.ts`), present ⟺ a leg-keyed read on a leg whose
   * maturity duration is > 0: the spend of runs STARTED before `cutoffIso` over the outcomes — whenever
   * they landed — of the leads those runs SERVED. NULL when the cut could not be made
   * (`matureUnavailableReason`); ABSENT on a leg-less read or a 0-day leg (mature ≡ flash there).
   */
  mature?: MatureEvidence | null;
  matureUnavailableReason?: MatureUnavailableReason;
}

/** Why a leg-keyed read could not cut its mature cohort. */
export type MatureUnavailableReason = "serve_dates_unavailable" | "mature_evidence_unavailable";

/** The mature twin of the grain evidence — same shapes, cut at `cutoffIso` (see `WorkflowProjectionEvidence.mature`). */
export interface MatureEvidence {
  cutoffIso: string;
  durationDays: number;
  crossOrgCostGroups: CostGroup[];
  crossOrgEmailStats: Array<[string, Record<string, number>]>;
  brandGrain: Array<[string, WorkflowGrainEvidence]>;
  retiredBrandGrain: Array<[string, WorkflowGrainEvidence]>;
  campaignGrain?: Array<[string, WorkflowGrainEvidence]>;
  retiredCampaignGrain?: Array<[string, WorkflowGrainEvidence]>;
  offerGrain?: Array<[string, WorkflowGrainEvidence]>;
  retiredOfferGrain?: Array<[string, WorkflowGrainEvidence]>;
  audienceEvidence: Array<{ audienceId: string; byDynasty: Array<[string, WorkflowGrainEvidence]> }>;
}

export async function fetchWorkflowProjectionEvidence(input: {
  featureSlug: string;
  brandId: string;
  identity: Identity;
  pricing: Pricing;
  /** Every member of ONE campaign identity, when the caller narrowed to a campaign. Absent otherwise,
   *  and the campaign grain is then never read — a brand-wide request asks campaign-service nothing. */
  campaignIds?: string[] | null;
  /** Every campaign of this channel selling the named campaign's offer. Absent ⟹ no offer grain. */
  offerCampaignIds?: string[] | null;
  /**
   * The LEG a leg-keyed read names. Present ⟹ EVERY grain counts only the spend, sends and outcomes of
   * campaigns performing THAT leg of the channel (owner rule 2026-09-27: a workflow's figure is always
   * its figure on one leg × one channel). A workflow with no evidence on the leg has no grain at all —
   * it reads unmeasured on this leg, never priced off another leg's campaigns. Absent ⟹ unchanged.
   */
  legKey?: string | null;
}): Promise<WorkflowProjectionEvidence> {
  const { featureSlug, brandId, identity, pricing } = input;
  const legKey = input.legKey ?? null;
  // Every org's campaigns on the leg, and the fleet's evidence narrowed to them (cached, fleet-wide).
  const legFleet = legKey ? await fetchLegFleetEvidence(featureSlug, legKey, pricing) : null;
  const legSet = legFleet ? new Set(legFleet.campaigns.map((c) => c.campaignId)) : null;
  const onLeg = (ids: string[] | null | undefined): string[] | null =>
    ids && legSet ? ids.filter((id) => legSet.has(id)) : (ids ?? null);
  const brandLegIds = legFleet
    ? legFleet.campaigns.filter((c) => c.brandId === brandId && c.orgId === identity.orgId).map((c) => c.campaignId)
    : null;
  const campaignIds = onLeg(input.campaignIds);
  const offerScoped = onLeg(input.offerCampaignIds);
  const offerCampaignIds = offerScoped && offerScoped.length > 0 ? offerScoped : null;
  // An offer sold through ONE campaign identity on this channel IS that identity: reuse its read.
  const offerIsCampaign =
    offerCampaignIds !== null &&
    campaignIds !== null &&
    offerCampaignIds.length === campaignIds.length &&
    [...campaignIds].sort().every((id, i) => id === [...offerCampaignIds].sort()[i]);

  // The workflow list is needed by the crossOrg AND brand dynasty rollups, so fetch it first; the
  // brand grain then fans out in parallel with the remaining reads.
  const workflows = await fetchPublicWorkflows(featureSlug, "all");
  // Same slug → dynasty map the crossOrg/brand rollups use — passed to the audience grain so its
  // per-audience dynasty attachment aligns with the dynasty-keyed rows (and skips runs-service's
  // lossy workflowDynastySlug regroup, which collapses the co-grouped audienceId).
  const slugToDynasty = new Map(workflows.map((w) => [w.workflowSlug, w.workflowDynastySlug]));
  // The positive repliers, one per PERSON (lib/crm-only-repliers.ts) — the set `/stats` counts, CRM
  // evidence included. The brand and campaign grains count replies on it instead of email-gateway's
  // per-slug sums; the audience grain adds its CRM-only ones by membership. Read once per scope and
  // FAIL-LOUD like every other input here: a grain must never silently fall back to the sender's count.
  const readOffer = offerCampaignIds !== null && !offerIsCampaign;
  // THE MATURE CUT (`lib/maturity.ts`) — a leg-keyed read on a leg whose outcomes lag its spend. It needs
  // each scope's PERSONS (their serve dates); every other read makes no person read at all.
  const rule = legFleet && legKey ? legMaturity(legKey) : null;
  const cutoffIso = rule && rule.durationDays > 0 ? maturityCutoffIso(rule.durationDays) : null;
  let allBrandPersons: EnginePerson[] | null = null;
  let campaignPersons: EnginePerson[] | null = null;
  let offerPersons: EnginePerson[] | null = null;
  // A mature read that fails DEGRADES the answer to flash (named on the wire), never 502s it: the flash
  // figures are what every row was priced on before, and they are read below whatever happens here.
  let matureReadFailed = false;
  if (cutoffIso) {
    try {
      [allBrandPersons, campaignPersons, offerPersons] = await Promise.all([
        fetchScopePersons(brandId, undefined, identity),
        campaignIds && campaignIds.length > 0 ? fetchScopePersons(brandId, campaignIds, identity) : Promise.resolve(null),
        readOffer ? fetchScopePersons(brandId, offerCampaignIds!, identity) : Promise.resolve(null),
      ]);
    } catch (err) {
      matureReadFailed = true;
      console.error(`[features-service] workflow-projection: mature person read failed (brand ${brandId}, leg ${legKey}); pricing on flash:`, err);
    }
  }
  // The flash grains' repliers are read exactly as before (the same lead walk as the persons above,
  // shared in-process), so the flash figures cannot move whatever the mature cut does.
  const [allBrandRepliers, campaignRepliers, offerRepliers] = await Promise.all([
    fetchPositiveRepliers(brandId, undefined, identity),
    campaignIds && campaignIds.length > 0 ? fetchPositiveRepliers(brandId, campaignIds, identity) : Promise.resolve(null),
    readOffer ? fetchPositiveRepliers(brandId, offerCampaignIds!, identity) : Promise.resolve(null),
  ]);
  // On a leg, the brand's repliers are those served under its campaigns ON THE LEG (the brand grain's
  // own population); the lead walk is the same, only the persons kept differ.
  const brandRepliers = legSet
    ? allBrandRepliers.filter((r) => r.campaignId !== null && legSet.has(r.campaignId))
    : allBrandRepliers;
  const [costGroups, emailStats, fleetReplies, brandGrain, audienceEvidence, campaignGrain, offerGrainRead] = await Promise.all([
    legFleet ? Promise.resolve(legFleet.costGroups) : fetchPublicCosts(featureSlug, "workflowSlug", pricing),
    legFleet ? Promise.resolve(legFleet.emailStats) : fetchPublicEmailStats(featureSlug, "workflowSlug"),
    // The FLEET's positive repliers on the SAME per-person basis as the finer grains (this brand's own
    // repliers included live), so every finer grain is a subset of crossOrg (lib/fleet-positive-repliers.ts).
    fetchFleetPositiveRepliesBySlug(featureSlug, { orgId: identity.orgId, brandId, repliers: brandRepliers }, legSet ?? undefined),
    brandLegIds
      ? brandLegIds.length > 0
        ? fetchCampaignWorkflowEvidenceWithRetired(brandId, featureSlug, brandLegIds, workflows, identity, pricing, "charged", brandRepliers)
        : Promise.resolve({ active: new Map<string, WorkflowGrainEvidence>(), retired: new Map<string, WorkflowGrainEvidence>() })
      : fetchBrandWorkflowEvidenceWithRetired(brandId, featureSlug, workflows, identity, pricing, "charged", brandRepliers),
    fetchAudienceGrainEvidence(brandId, featureSlug, identity, slugToDynasty, pricing, undefined, brandRepliers, brandLegIds),
    campaignIds && campaignIds.length > 0
      ? fetchCampaignWorkflowEvidenceWithRetired(brandId, featureSlug, campaignIds, workflows, identity, pricing, "charged", campaignRepliers ?? undefined)
      : Promise.resolve(null),
    readOffer
      ? fetchCampaignWorkflowEvidenceWithRetired(brandId, featureSlug, offerCampaignIds!, workflows, identity, pricing, "charged", offerRepliers ?? undefined)
      : Promise.resolve(null),
  ]);
  const offerGrain = offerIsCampaign ? campaignGrain : offerGrainRead;
  // Always a Map in production; only the suite-wide test default (src/vitest.setup.ts) leaves it unset.
  if (fleetReplies) setReplyCountsOnSlugStats(emailStats, fleetReplies);

  // ── THE MATURE TWIN of every grain above, on the SAME populations (leg campaigns, identity, offer).
  let mature: MatureEvidence | null | undefined;
  let matureUnavailableReason: MatureUnavailableReason | undefined;
  if (cutoffIso && matureReadFailed) {
    mature = null;
    matureUnavailableReason = "mature_evidence_unavailable";
  } else if (cutoffIso && rule && legKey && legSet && brandLegIds && allBrandPersons) {
    try {
      const stated =
        serveDatesStated(allBrandPersons) &&
        (!campaignPersons || serveDatesStated(campaignPersons)) &&
        (!offerPersons || serveDatesStated(offerPersons));
      // The FLEET decides every row's version, so it is read first: a fleet that cannot be cut makes the
      // whole answer flash, and the finer mature reads are not worth making.
      const fleetMature = stated
        ? await fetchLegFleetMatureEvidence(featureSlug, legKey, pricing, cutoffIso, { orgId: identity.orgId, brandId, persons: allBrandPersons }, legSet)
        : null;
      const emptyGrain = (): GrainEvidenceWithRetired => ({ active: new Map(), retired: new Map() });
      const [brandMature, campaignMature, offerMatureRead, audienceMature] = fleetMature
        ? await Promise.all([
            fetchCampaignWorkflowMatureEvidence(brandId, featureSlug, brandLegIds, workflows, identity, pricing, "charged", allBrandPersons, cutoffIso),
            campaignIds && campaignIds.length > 0 && campaignPersons
              ? fetchCampaignWorkflowMatureEvidence(brandId, featureSlug, campaignIds, workflows, identity, pricing, "charged", campaignPersons, cutoffIso)
              : Promise.resolve(null),
            readOffer && offerPersons
              ? fetchCampaignWorkflowMatureEvidence(brandId, featureSlug, offerCampaignIds!, workflows, identity, pricing, "charged", offerPersons, cutoffIso)
              : Promise.resolve(null),
            fetchAudienceMatureEvidence(
              brandId,
              featureSlug,
              identity,
              slugToDynasty,
              pricing,
              audienceEvidence.map((a) => a.audienceId),
              allBrandPersons,
              brandLegIds,
              cutoffIso,
            ),
          ])
        : [emptyGrain(), null, null, []];
      if (!stated || !fleetMature) {
        mature = null;
        matureUnavailableReason = "serve_dates_unavailable";
      } else {
        const offerMature = offerIsCampaign ? campaignMature : offerMatureRead;
        mature = {
          cutoffIso,
          durationDays: rule.durationDays,
          crossOrgCostGroups: fleetMature.costGroups,
          crossOrgEmailStats: [...fleetMature.emailStats.entries()],
          brandGrain: [...brandMature.active.entries()],
          retiredBrandGrain: [...brandMature.retired.entries()],
          ...(campaignMature
            ? { campaignGrain: [...campaignMature.active.entries()], retiredCampaignGrain: [...campaignMature.retired.entries()] }
            : {}),
          ...(offerMature
            ? { offerGrain: [...offerMature.active.entries()], retiredOfferGrain: [...offerMature.retired.entries()] }
            : {}),
          audienceEvidence: audienceMature.map((ev) => ({ audienceId: ev.audienceId, byDynasty: [...ev.byDynasty.entries()] })),
        };
      }
    } catch (err) {
      // A mature cost or person read failed: every row is priced on flash, as before, and the answer says so.
      console.error(`[features-service] workflow-projection: mature evidence read failed (brand ${brandId}, leg ${legKey}); pricing on flash:`, err);
      mature = null;
      matureUnavailableReason = "mature_evidence_unavailable";
    }
  }

  const out: WorkflowProjectionEvidence = {
    ...(legFleet && legKey ? { legKey } : {}),
    ...(mature !== undefined ? { mature } : {}),
    ...(matureUnavailableReason ? { matureUnavailableReason } : {}),
    workflows,
    crossOrgCostGroups: costGroups,
    crossOrgEmailStats: [...emailStats.entries()],
    brandGrain: [...brandGrain.active.entries()],
    retiredBrandGrain: [...brandGrain.retired.entries()],
    audienceEvidence: audienceEvidence.map((ev) => ({ audienceId: ev.audienceId, byDynasty: [...ev.byDynasty.entries()] })),
    ...(campaignGrain
      ? { campaignGrain: [...campaignGrain.active.entries()], retiredCampaignGrain: [...campaignGrain.retired.entries()] }
      : {}),
    ...(offerGrain
      ? { offerGrain: [...offerGrain.active.entries()], retiredOfferGrain: [...offerGrain.retired.entries()] }
      : {}),
  };
  // An INTERNAL pipe (its leg starts on a step other than Lead found) serves nobody, so the sends above
  // count no one: its people and outcomes are the follow-up ledger's, at every grain (the one rule every
  // pipe follows, `fleetPipeFigures` in routes/public.ts).
  const internalToStep = legKey ? await internalPipeToStep(featureSlug, legKey) : null;
  if (internalToStep) {
    const fleet = await getInternalPipeFleet(featureSlug, legKey!, internalToStep);
    return withInternalPipeCounts(out, fleet, {
      brand: (c) => c.brandId === brandId && c.orgId === identity.orgId,
      campaign: campaignIds ? (c) => campaignIds.includes(c.campaignId) : null,
      offer: offerCampaignIds ? (c) => offerCampaignIds.includes(c.campaignId) : null,
    });
  }
  return out;
}

/**
 * PURE: an internal pipe's evidence with every grain's people and outcomes read off the follow-up ledger
 * (`internalPipeCountsByDynasty`): `contacted` = the people its campaigns acted on, `replies` = those who
 * reached the pipe's `to` step (the observed-outcome slot its leg terms read, rate 1), `clicks` = 0.
 * Spend is untouched (runs, same campaigns). The audience grain keeps its own (an internal pipe serves no
 * audience). Exported for tests.
 */
export function withInternalPipeCounts(
  ev: WorkflowProjectionEvidence,
  fleet: Pick<MeetingLegFleet, "perCampaign">,
  scopes: {
    brand: (c: MeetingLegFleet["perCampaign"][number]) => boolean;
    campaign: ((c: MeetingLegFleet["perCampaign"][number]) => boolean) | null;
    offer: ((c: MeetingLegFleet["perCampaign"][number]) => boolean) | null;
  },
): WorkflowProjectionEvidence {
  const dynastyOf = new Map(ev.workflows.map((w) => [w.workflowSlug, w.workflowDynastySlug]));
  const activeOf = new Map(ev.workflows.filter((w) => w.status === "active").map((w) => [w.workflowDynastySlug, w.workflowSlug]));
  const counted = (stats: Map<string, { contacted: number; reached: number }>, dynasty: string) => stats.get(dynasty) ?? { contacted: 0, reached: 0 };
  const regrain = (rows: Array<[string, WorkflowGrainEvidence]> | undefined, scope: ((c: MeetingLegFleet["perCampaign"][number]) => boolean) | null, keyIsDynasty: boolean) => {
    if (!rows || !scope) return rows;
    const stats = internalPipeCountsByDynasty(fleet, scope);
    return rows.map(([key, e]): [string, WorkflowGrainEvidence] => {
      const n = counted(stats, keyIsDynasty ? key : (dynastyOf.get(key) ?? key));
      return [key, { ...e, contacted: n.contacted, replies: n.reached, clicks: 0 }];
    });
  };
  const fleetStats = internalPipeCountsByDynasty(fleet, () => true);
  // Per slug: every version's recipient counts reset, the dynasty's put on its active slug (else any of its
  // slugs) so the per-dynasty sum the ladder takes is the ledger's count exactly.
  const zero = { recipientsContacted: 0, recipientsRepliesPositive: 0, recipientsClicked: 0 };
  const emailStats = new Map<string, Record<string, number>>(ev.crossOrgEmailStats.map(([slug, r]) => [slug, { ...r, ...zero }]));
  for (const [dynasty, n] of fleetStats) {
    const slug = activeOf.get(dynasty) ?? ev.workflows.find((w) => w.workflowDynastySlug === dynasty)?.workflowSlug ?? dynasty;
    emailStats.set(slug, { ...(emailStats.get(slug) ?? {}), ...zero, recipientsContacted: n.contacted, recipientsRepliesPositive: n.reached });
  }
  return {
    ...ev,
    crossOrgEmailStats: [...emailStats.entries()],
    brandGrain: regrain(ev.brandGrain, scopes.brand, false)!,
    retiredBrandGrain: regrain(ev.retiredBrandGrain, scopes.brand, true)!,
    ...(ev.campaignGrain ? { campaignGrain: regrain(ev.campaignGrain, scopes.campaign, false), retiredCampaignGrain: regrain(ev.retiredCampaignGrain, scopes.campaign, true) } : {}),
    ...(ev.offerGrain ? { offerGrain: regrain(ev.offerGrain, scopes.offer, false), retiredOfferGrain: regrain(ev.retiredOfferGrain, scopes.offer, true) } : {}),
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
  meetingChannel?: PricingChannel;
  funnelKey?: SalesFunnelKey;
  identity: Identity;
  pricing: Pricing;
}): Promise<WorkflowProjectionResponse> {
  const { featureSlug, brandId, objective, goal, singleStepGoal, formSubmissionGoal, identity, pricing } = input;
  const [evidence, priced] = await Promise.all([
    fetchWorkflowProjectionEvidence({ featureSlug, brandId, identity, pricing }),
    // The offer's terms on the funnels the brand walks, narrowed to the named funnel when there is one.
    fetchFunnelPricedEconomics(brandId, identity.orgId, input.funnelKey),
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
    economics: priced.economics.economics,
  });
}

/**
 * The PURE, economics-DEPENDENT half: derive the goal's 3-grain projection from already-fetched
 * evidence + the brand's economics. No IO, so it runs on EVERY request against LIVE economics — that is
 * what makes a read straight after an offer-terms write reflect the new `lifetimeRevenueUsd` (and
 * therefore the new `roiMultiple` / `cacPct`) without a cache-bypass param and without re-fanning out.
 * NEVER cache this output keyed on the evidence inputs alone; economics is not one of them.
 */
/**
 * Stamp each AUDIENCE row with how many people its audience can still be served (features-service#1035).
 * The brand / campaign column (`audienceId: null`) carries nothing. An audience the producer did not
 * state a count for — or a read that failed (`availability` null) — reads `null`, never 0: only
 * human-service may say an audience is served out.
 */
export function withAudienceAvailability(
  rows: ProjectionRow[],
  availability: Map<string, number> | null,
): ProjectionRow[] {
  return rows.map((r) =>
    r.audienceId == null ? r : { ...r, availableToContactCount: availability?.get(r.audienceId) ?? null },
  );
}

/**
 * ONE LEG'S OUTCOME TERMS THROUGH ONE FUNNEL — the counted signal that drives it and the rate that walks
 * that signal to the leg's own step, on the given economics. NULL when the leg's step is not a step of the
 * funnel, or no counted signal enters it. Shared by the leg-keyed read and the basis-funnel ranking
 * (`lib/funnel-ranking.ts`), so a funnel is ranked on the SAME leg terms — and the same maturity rule —
 * its rows are priced on.
 */
export function legTermsForFunnel(legKey: string, funnelKey: SalesFunnelKey, e: SalesEconomics): LegOutcomeTerms | null {
  const leg = funnelLeg(legKey);
  if (!leg) return null;
  return legOutcomeTerms(
    funnelKey,
    leg.toStep.key,
    {
      r2m: e.replyToMeetingPct / 100,
      v2m: e.visitToMeetingPct / 100,
      m2c: e.meetingToClosePct / 100,
      v2c: e.visitToClosePct / 100,
      v2s: e.visitToSignupPct / 100,
      s2pc: e.signupToPaidClientPct / 100,
      ...(e.visitToFormSubmissionPct != null ? { v2fs: e.visitToFormSubmissionPct / 100 } : {}),
      ...(e.formSubmissionToPaidClientPct != null ? { fs2pc: e.formSubmissionToPaidClientPct / 100 } : {}),
    },
    bookedToAttendedRate(e),
  );
}

export function projectFromEvidence(input: {
  featureSlug: string;
  objective: Objective;
  goal: GoalEcho;
  singleStepGoal: SingleStepGoal | null;
  formSubmissionGoal: boolean;
  /** Set ONLY on a funnel-keyed projection; narrows every cost + every observed count to that channel. */
  meetingChannel?: PricingChannel;
  /** Echoed on the response when the caller named a funnel. Never shapes the math on its own. */
  funnelKey?: SalesFunnelKey;
  /**
   * Present ⟺ the caller named a `?leg=`. It denominates every cost-per-outcome, outcome count and
   * conversion rate in the LEG's own step, and it is what turns on the per-workflow `rank`.
   */
  legTerms?: LegOutcomeTerms | null;
  /**
   * The LEG the read names (canonical key) — present ⟺ `legTerms` is. It selects the leg's maturity rule
   * (`lib/maturity.ts`): its duration, its required outcomes, and so which version each row is priced on.
   */
  legKey?: string | null;
  /**
   * The leg-assignment verdict per workflow DYNASTY. Read ONLY beside a `?leg=`, and attached verbatim
   * to every row of that dynasty. Absent on every funnel- and goal-keyed read, which is what keeps
   * those bodies byte-unchanged. It never filters or reprices; it is the outermost key of the orders.
   */
  legAssignmentByDynasty?: ReadonlyMap<string, LegAssignmentVerdict> | null;
  /** The model alias each dynasty's DAG names — display only, echoed on the transitional block. */
  modelAliasByDynasty?: ReadonlyMap<string, string | null> | null;
  evidence: WorkflowProjectionEvidence;
  economics: SalesEconomics | null;
  /**
   * WHAT THE RECOMMENDATION IS RANKED ON. Absent ⟺ `return` — the objective this has always had, so
   * every existing caller reads a byte-identical body. It shapes ONLY the pick (and the echo): every
   * row carries both figures either way, so the two answers are comparable side by side.
   */
  maximize?: Maximize;
}): WorkflowProjectionResponse {
  const { featureSlug, objective, goal, singleStepGoal, formSubmissionGoal, evidence, economics } = input;
  const maximize = input.maximize ?? DEFAULT_MAXIMIZE;
  const meetingChannel = input.meetingChannel ?? null;
  const legTerms = input.legTerms ?? null;
  const workflows = evidence.workflows;
  const costGroups = evidence.crossOrgCostGroups;
  const emailStats = new Map(evidence.crossOrgEmailStats);
  const brandGrain = new Map(evidence.brandGrain);
  const campaignGrain = evidence.campaignGrain ? new Map(evidence.campaignGrain) : null;
  const offerGrain = evidence.offerGrain ? new Map(evidence.offerGrain) : null;
  const retiredOfferGrain = new Map(evidence.retiredOfferGrain ?? []);
  const retiredBrandGrain = new Map(evidence.retiredBrandGrain ?? []);
  const retiredCampaignGrain = new Map(evidence.retiredCampaignGrain ?? []);
  const audienceEvidence: AudienceGrainEvidence[] = evidence.audienceEvidence.map((ev) => ({
    audienceId: ev.audienceId,
    byDynasty: new Map(ev.byDynasty),
  }));

    // crossOrg dynasty rollup — the SAME membership rule the brand / offer / campaign grains roll up by
    // (`brandGrainDynasties`: a version the upgrade chain never reached folds into its active dynasty), so
    // a finer grain can never count a slug its crossOrg row leaves out.
    const dynasties = brandGrainDynasties(
      workflows,
      costGroups.map((g) => g.dimensions.workflowSlug).filter((s): s is string => Boolean(s)),
    ).active;
    const { costMap, aggregatedOutcomes } = aggregateAcrossDynasties(dynasties, costGroups, emailStats, "workflowSlug");
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
      buildGrainBlock(ev, econ, ltrUsd, objective, singleStepGoal, formSubmissionGoal, parentUnitCosts, meetingChannel, legTerms);
    const resolve = (grains: Partial<Record<GrainName, GrainBlock>>): ResolvedBlock =>
      resolvePick(grains, econ, objective, singleStepGoal, formSubmissionGoal, meetingChannel, legTerms);

    const rows: ProjectionRow[] = [];

    // Map dynastySlug → active workflow slug. Needed by the audience rows below AND by the unmeasured
    // enumeration at the bottom, so it is resolved once here.
    const activeSlugByDynasty = new Map<string, string>();
    for (const [activeSlug, wf] of workflowBySlug) {
      if (wf.status === "active") activeSlugByDynasty.set(wf.workflowDynastySlug, activeSlug);
    }

    // A grain COUNTS when it spent — and, on a LEG read, when it also REACHED somebody on that leg. A
    // workflow that only ran discovery / enrichment on the leg's campaigns (prod 2026-09-27: cerulean,
    // $0.47 of visit-leg spend, nobody contacted) has not been measured on the leg: counting it would
    // floor its price to that spend and put a workflow that never sent on the leg at the top of it. It
    // falls to the explore allowance instead, like any workflow the leg has not tried. Leg-less reads
    // keep the spend-only rule, byte-unchanged.
    const grainCounts = (ev: WorkflowGrainEvidence | undefined | null): ev is WorkflowGrainEvidence =>
      Boolean(ev) && ev!.totalCostInUsdCents > 0 && (!evidence.legKey || ev!.contacted > 0);

    // ── THE TWO VERSIONS OF THE EVIDENCE (`lib/maturity.ts`) ──────────────────────────────────
    //
    // A leg-keyed read builds every ladder TWICE: on FLASH evidence (everything to date — what every
    // figure was before) and on MATURE evidence (runs started before the leg's cutoff, over the outcomes
    // — whenever they landed — of the leads those runs served). The workflow's verdict on the FLEET of its
    // leg decides which one the row is PRICED on:
    //   • MATURE on the fleet (≥ the leg's required mature outcomes) → every grain of every row of that
    //     workflow is the mature one, cascade included. Its young spend counts nowhere, so today's sends
    //     can no longer inflate its price while their outcomes are still on their way.
    //   • not mature → priced exactly as before, on flash evidence with the cascade floor: that is its
    //     exploration phase, and the floor is what lets it be tried at all.
    // Both versions ride every block (`flash` / `mature` / `isMature`) and the row states both prices
    // (`maturity.resolved`), so a consumer reads either without re-deriving anything. A leg-less read
    // builds one ladder, byte-unchanged; a 0-day leg is its own mature version (mature ≡ flash).
    const legKey = legTerms ? (input.legKey ?? null) : null;
    const rule = legKey ? legMaturity(legKey) : null;

    interface LadderSources {
      costMap: Map<string, { totalCostInUsdCents: number; completedRuns: number }>;
      aggregatedOutcomes: Map<string, Record<string, number>>;
      brandGrain: Map<string, WorkflowGrainEvidence>;
      campaignGrain: Map<string, WorkflowGrainEvidence> | null;
      offerGrain: Map<string, WorkflowGrainEvidence> | null;
      retiredBrandGrain: Map<string, WorkflowGrainEvidence>;
      retiredCampaignGrain: Map<string, WorkflowGrainEvidence>;
      retiredOfferGrain: Map<string, WorkflowGrainEvidence>;
      audienceByAudience: Map<string, Map<string, WorkflowGrainEvidence>>;
    }
    const flashSources: LadderSources = {
      costMap,
      aggregatedOutcomes,
      brandGrain,
      campaignGrain,
      offerGrain,
      retiredBrandGrain,
      retiredCampaignGrain,
      retiredOfferGrain,
      audienceByAudience: new Map(audienceEvidence.map((ev) => [ev.audienceId, ev.byDynasty])),
    };
    const matureSourcesOf = (m: MatureEvidence): LadderSources => {
      // The SAME dynasty membership rule as the flash rollup, over every slug either version names.
      const matureDynasties = brandGrainDynasties(workflows, [
        ...costGroups.map((g) => g.dimensions.workflowSlug),
        ...m.crossOrgCostGroups.map((g) => g.dimensions.workflowSlug),
      ].filter((slug): slug is string => Boolean(slug))).active;
      const rollup = aggregateAcrossDynasties(
        matureDynasties,
        m.crossOrgCostGroups,
        new Map(m.crossOrgEmailStats),
        "workflowSlug",
        { exactCents: true },
      );
      return {
        costMap: rollup.costMap,
        aggregatedOutcomes: rollup.aggregatedOutcomes,
        brandGrain: new Map(m.brandGrain),
        campaignGrain: m.campaignGrain ? new Map(m.campaignGrain) : null,
        offerGrain: m.offerGrain ? new Map(m.offerGrain) : null,
        retiredBrandGrain: new Map(m.retiredBrandGrain),
        retiredCampaignGrain: new Map(m.retiredCampaignGrain ?? []),
        retiredOfferGrain: new Map(m.retiredOfferGrain ?? []),
        audienceByAudience: new Map(m.audienceEvidence.map((ev) => [ev.audienceId, new Map(ev.byDynasty)])),
      };
    };
    // Mature evidence exists only on a leg-scoped read (the fleet of the leg is the verdict's population).
    const matureSources: LadderSources | null =
      !rule || !evidence.legKey
        ? null
        : rule.durationDays === 0
          ? flashSources
          : evidence.mature
            ? matureSourcesOf(evidence.mature)
            : null;

    type GrainEvidenceMap = Partial<Record<GrainName, WorkflowGrainEvidence>>;
    interface Ladder {
      grains: Partial<Record<GrainName, GrainBlock>>;
      evidence: GrainEvidenceMap;
    }
    const crossOrgEvidenceOf = (src: LadderSources, activeSlug: string): WorkflowGrainEvidence | undefined => {
      const cost = src.costMap.get(activeSlug);
      if (!cost) return undefined;
      const outcomes = src.aggregatedOutcomes.get(activeSlug) ?? {};
      return {
        totalCostInUsdCents: cost.totalCostInUsdCents,
        completedRuns: cost.completedRuns,
        contacted: outcomes.recipientsContacted ?? 0,
        clicks: outcomes.recipientsClicked ?? 0,
        replies: outcomes.recipientsRepliesPositive ?? 0,
      };
    };
    // One ACTIVE workflow's ladder. The cascade — crossOrg (no parent) → brand → campaign → offer on the
    // brand-level row, crossOrg → brand → campaign → audience on an audience row — is built coarser-first
    // so a finer grain floors against the coarser grain's unit costs ON THE SAME VERSION of the evidence.
    const activeLadder = (src: LadderSources, activeSlug: string, audience: { audienceId: string; dynastySlug: string } | null): Ladder => {
      const grains: Partial<Record<GrainName, GrainBlock>> = {};
      const ev: GrainEvidenceMap = {};
      ev.crossOrg = crossOrgEvidenceOf(src, activeSlug);
      if (grainCounts(ev.crossOrg)) grains.crossOrg = buildBlock(ev.crossOrg);
      ev.brand = src.brandGrain.get(activeSlug);
      if (grainCounts(ev.brand)) grains.brand = buildBlock(ev.brand, grains.crossOrg?.unitCosts ?? null);
      // … → brand → CAMPAIGN: one narrowing finer than the brand, floored against it, so a campaign
      // that has barely spent reads its brand's price rather than looking free.
      ev.campaign = src.campaignGrain?.get(activeSlug);
      if (grainCounts(ev.campaign)) {
        grains.campaign = buildBlock(ev.campaign, grains.brand?.unitCosts ?? grains.crossOrg?.unitCosts ?? null);
      }
      if (!audience) {
        // … → brand → OFFER: the campaigns selling one offer, floored against the brand exactly as the
        // brand is floored against the fleet — so on a brand selling one offer the two columns are the
        // same number. A STATED grain only: it never enters `resolved`, `rank` or the recommendation, and
        // the campaign grain keeps its BRAND parent, so nothing campaign-service reads moves.
        ev.offer = src.offerGrain?.get(activeSlug);
        if (grainCounts(ev.offer)) {
          grains.offer = buildBlock(ev.offer, grains.brand?.unitCosts ?? grains.crossOrg?.unitCosts ?? null);
        }
      } else {
        const audienceParent =
          grains.campaign?.unitCosts ?? grains.brand?.unitCosts ?? grains.crossOrg?.unitCosts ?? null;
        ev.audience = src.audienceByAudience.get(audience.audienceId)?.get(audience.dynastySlug);
        if (grainCounts(ev.audience)) grains.audience = buildBlock(ev.audience, audienceParent);
      }
      return { grains, evidence: ev };
    };
    // A RETIRED lineage's ladder: brand (no parent) → campaign / offer (parent brand), on spend alone.
    const retiredLadder = (src: LadderSources, dynastySlug: string): Ladder => {
      const grains: Partial<Record<GrainName, GrainBlock>> = {};
      const ev: GrainEvidenceMap = {};
      ev.brand = src.retiredBrandGrain.get(dynastySlug);
      if (ev.brand && ev.brand.totalCostInUsdCents > 0) grains.brand = buildBlock(ev.brand);
      ev.campaign = src.retiredCampaignGrain.get(dynastySlug);
      if (ev.campaign && ev.campaign.totalCostInUsdCents > 0) {
        grains.campaign = buildBlock(ev.campaign, grains.brand?.unitCosts ?? null);
      }
      ev.offer = src.retiredOfferGrain.get(dynastySlug);
      if (ev.offer && ev.offer.totalCostInUsdCents > 0) grains.offer = buildBlock(ev.offer, grains.brand?.unitCosts ?? null);
      return { grains, evidence: ev };
    };

    // The leg's own outcomes in a body of evidence — its driver signal walked to the leg's step (raw on an
    // entry leg). A grain the version holds no evidence for has 0; an unpriceable walk has no count at all.
    const outcomesOf = (ev: WorkflowGrainEvidence | undefined): number | null => {
      if (!legTerms || legTerms.rateFromDriver == null) return null;
      if (!ev) return 0;
      return (legTerms.driver === "click" ? ev.clicks : ev.replies) * legTerms.rateFromDriver;
    };
    const figuresOf = (ev: WorkflowGrainEvidence | undefined): OutcomeFigures | null => {
      const outcomes = outcomesOf(ev);
      if (outcomes == null) return null;
      return outcomeFigures(ev ? ev.totalCostInUsdCents / 100 : 0, ev?.contacted ?? 0, outcomes);
    };
    // THE VERDICT that picks the version: the workflow's MATURE outcomes on the FLEET of its leg.
    const verdictOf = (activeSlug: string): { isMature: boolean | null; matureOutcomes: number | null } => {
      if (!matureSources || !legKey) return { isMature: null, matureOutcomes: null };
      const matureOutcomes = outcomesOf(crossOrgEvidenceOf(matureSources, activeSlug));
      return { isMature: isMatureCount(matureOutcomes, legKey), matureOutcomes };
    };
    const resolvedFiguresOf = (r: ResolvedBlock): ResolvedFigures => ({
      grain: r.grain,
      costPerOutcomeUsd: r.costPerOutcomeUsd,
      conversionRatePct: r.conversionRatePct,
    });
    const NOTHING_RESOLVED: ResolvedFigures = { grain: null, costPerOutcomeUsd: null, conversionRatePct: null };
    // Stamp every block of the PRICED ladder with its version, both versions' figures, and its verdict.
    // `basisOf` names a grain served on another version than the row (a young grain of a mature row).
    const stampVersions = (
      priced: Ladder["grains"],
      basis: MaturityBasis,
      flash: Ladder,
      mature: Ladder | null,
      basisOf: (g: GrainName) => MaturityBasis = () => basis,
    ): void => {
      for (const g of Object.keys(priced) as GrainName[]) {
        const block = priced[g]!;
        const matureFigures = mature ? figuresOf(mature.evidence[g]) : null;
        block.basis = basisOf(g);
        block.flash = figuresOf(flash.evidence[g]);
        block.mature = matureFigures;
        block.isMature = mature && matureFigures ? isMatureCount(matureFigures.outcomes, legKey) : null;
      }
    };
    // The grains a row's cascade covers (see `ProjectionRow.priceByGrain`): the fleet and the brand on every
    // row, the campaign on a `?campaignId=` read, the offer where the read has one (brand-level rows), the
    // audience on its own rows.
    const heldGrainsOf = (audienceRow: boolean): GrainName[] => [
      "crossOrg",
      "brand",
      ...(flashSources.campaignGrain ? (["campaign"] as const) : []),
      ...(audienceRow ? (["audience"] as const) : flashSources.offerGrain ? (["offer"] as const) : []),
    ];
    // The price held at each of those grains on BOTH versions, each walked on its own version's ladder
    // (never one version's price under the other's name). `matureGrains` null = the cut could not be made.
    const heldPrices = (
      heldGrains: GrainName[],
      flashGrains: Ladder["grains"],
      matureGrains: Ladder["grains"] | null,
    ): Partial<Record<GrainName, GrainHeldPrices>> =>
      Object.fromEntries(
        heldGrains.map((g) => [g, { flash: heldPriceOn(flashGrains, g), mature: heldPriceOn(matureGrains, g) }]),
      );
    // The row PRICED by the rule: its ladder, its resolved pick, and (leg reads) its maturity block.
    const priceRow = (
      flash: Ladder,
      mature: Ladder | null,
      verdict: { isMature: boolean | null; matureOutcomes: number | null },
      heldGrains: GrainName[],
    ): Pick<ProjectionRow, "estimatesByGrain" | "resolved" | "maturity" | "priceByGrain"> => {
      if (!legTerms) return { estimatesByGrain: stampGrainBases(flash.grains), resolved: resolve(flash.grains) };
      // The OFFER grain is a stated grain only (never resolved), so a ladder holding nothing else has no price.
      const matureHasGrain =
        mature !== null && (["crossOrg", "brand", "campaign", "audience"] as const).some((g) => mature.grains[g]);
      const basis: MaturityBasis = verdict.isMature === true && matureHasGrain ? "mature" : "flash";
      const flashResolved = resolve(flash.grains);
      const matureResolved = matureHasGrain ? resolve(mature!.grains) : null;
      // A MATURE row prices on its mature ladder, but a grain that holds no mature evidence yet (a brand,
      // offer or mission younger than the leg's cut) is still a scope with evidence: it is served on its
      // FLASH block, stamped `basis: "flash"`, with its own (empty) mature half and `isMature: false`.
      // The fleet verdict never decides whether a grain EXISTS (prod 2026-10-01: osprey's $33.74 and 2
      // visits on a 2-day-old mission vanished because the workflow was mature on the fleet). `resolved`
      // stays the mature ladder's pick, so nothing campaign-service ranks moves. The AUDIENCE grain is
      // NOT filled: campaign-service's audience draw reads its evidence, and on a mature workflow that
      // evidence is the mature one by design (young spend must not enter the draw).
      const youngGrains: GrainName[] =
        basis === "mature"
          ? (Object.keys(flash.grains) as GrainName[]).filter((g) => g !== "audience" && !mature!.grains[g])
          : [];
      // Read BEFORE the ladders are merged into the served blocks (a mature row's priced ladder holds both).
      const priceByGrain = heldPrices(heldGrains, flash.grains, mature ? mature.grains : null);
      const priced: Ladder["grains"] =
        basis === "mature"
          ? { ...mature!.grains, ...Object.fromEntries(youngGrains.map((g) => [g, flash.grains[g]])) }
          : flash.grains;
      stampVersions(priced, basis, flash, mature, (g) => (youngGrains.includes(g) ? "flash" : basis));
      return {
        estimatesByGrain: stampGrainBases(priced),
        resolved: basis === "mature" ? matureResolved! : flashResolved,
        maturity: {
          basis,
          isMature: verdict.isMature,
          matureOutcomes: verdict.matureOutcomes,
          resolved: maturityPair(
            resolvedFiguresOf(flashResolved),
            mature ? (matureResolved ? resolvedFiguresOf(matureResolved) : NOTHING_RESOLVED) : null,
            verdict.isMature,
          ),
        },
        priceByGrain,
      };
    };

    // ── Brand-level rows (audienceId: null), one per active workflow dynasty ────────────────────
    // Keyed by the dynasty's active slug. crossOrg grain always present (real fleet spend); brand grain
    // added only when the brand spent on the dynasty (spentUsd > 0).
    for (const [activeSlug] of costMap) {
      const wf = workflowBySlug.get(activeSlug);
      const flash = activeLadder(flashSources, activeSlug, null);
      // crossOrg is (almost) always present, but if a dynasty had 0 crossOrg cost AND 0 brand cost there
      // is no grain to resolve — skip the row (nothing to project).
      if (!flash.grains.crossOrg && !flash.grains.brand && !flash.grains.campaign) continue;
      const mature = matureSources ? activeLadder(matureSources, activeSlug, null) : null;
      const priced = priceRow(flash, mature, verdictOf(activeSlug), heldGrainsOf(false));
      rows.push({
        audienceId: null,
        workflow: {
          workflowDynastySlug: wf?.workflowDynastySlug ?? activeSlug,
          workflowDynastyName: wf?.workflowDynastyName ?? null,
        },
        estimatesByGrain: priced.estimatesByGrain,
        resolved: priced.resolved,
        measured: true,
        ...(priced.maturity ? { maturity: priced.maturity } : {}),
        ...(priced.priceByGrain ? { priceByGrain: priced.priceByGrain } : {}),
      });
    }

    // ── RETIRED lineages — real spend, real outcomes, never put forward ─────────────────────────
    // A dynasty nobody runs any more still holds this brand's spend and replies; without a row they
    // vanished and the rows summed to less than the scope (Doc Dinners 2026-09-25: 23 of 26 positive
    // replies). The row states the brand / campaign evidence and an all-null `resolved`, so no ranking,
    // recommendation or selector can pick a workflow that no longer runs. It is never priced, so it is
    // stated on flash with both versions' figures beside each block.
    for (const dynastySlug of new Set([
      ...retiredBrandGrain.keys(),
      ...retiredCampaignGrain.keys(),
      ...retiredOfferGrain.keys(),
    ])) {
      const flash = retiredLadder(flashSources, dynastySlug);
      if (!flash.grains.brand && !flash.grains.campaign && !flash.grains.offer) continue;
      const mature = matureSources ? retiredLadder(matureSources, dynastySlug) : null;
      // A retired lineage has no fleet grain: its held prices are its own brand / campaign / offer blocks.
      const retiredHeld = legTerms ? heldPrices(heldGrainsOf(false), flash.grains, mature ? mature.grains : null) : null;
      if (legTerms) stampVersions(flash.grains, "flash", flash, mature);
      rows.push({
        audienceId: null,
        workflow: { workflowDynastySlug: dynastySlug, workflowDynastyName: dynastyNameBySlug.get(dynastySlug) ?? null },
        estimatesByGrain: stampGrainBases(flash.grains),
        resolved: { ...UNMEASURED_RESOLVED },
        measured: true,
        retired: true,
        ...(legTerms
          ? { maturity: { basis: "flash" as const, isMature: null, matureOutcomes: null, resolved: maturityPair<ResolvedFigures>(null, null, null) } }
          : {}),
        ...(retiredHeld ? { priceByGrain: retiredHeld } : {}),
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
    // On a MATURE workflow the audience grain is the MATURE one (spend of runs started before the cutoff,
    // the leads they served, attributed to the audience their serve drew them from) — which is exactly the
    // evidence campaign-service's audience draw reads, so young spend does not enter the draw either.
    for (const ev of audienceEvidence) {
      for (const [dynastySlug, activeSlug] of activeSlugByDynasty) {
        const target = { audienceId: ev.audienceId, dynastySlug };
        const flash = activeLadder(flashSources, activeSlug, target);
        // A couple with no grain at all (no crossOrg/brand/campaign/audience spend) has nothing to project.
        if (!flash.grains.crossOrg && !flash.grains.brand && !flash.grains.campaign && !flash.grains.audience) continue;
        const mature = matureSources ? activeLadder(matureSources, activeSlug, target) : null;
        const priced = priceRow(flash, mature, verdictOf(activeSlug), heldGrainsOf(true));
        rows.push({
          audienceId: ev.audienceId,
          workflow: {
            workflowDynastySlug: dynastySlug,
            workflowDynastyName: dynastyNameBySlug.get(dynastySlug) ?? null,
          },
          estimatesByGrain: priced.estimatesByGrain,
          resolved: priced.resolved,
          measured: true,
          ...(priced.maturity ? { maturity: priced.maturity } : {}),
          ...(priced.priceByGrain ? { priceByGrain: priced.priceByGrain } : {}),
        });
      }
    }

    // ── AN ACTIVE WORKFLOW WITH NO HISTORY IS STILL REACHABLE — the EXPLORE ALLOWANCE ──────────
    //
    // Every row above rests on spend, so an active dynasty with no grain ANYWHERE produces no row at
    // all — and a consumer that picks a workflow by ranking these rows cannot pick what it cannot see.
    // So it never spends, which is the one thing that would have given it a row: it cannot start
    // because it has not started.
    //
    // features-service#805 stated that for a channel where NOTHING was measured. The case that actually
    // occurs is the MIXED one — prod 2026-08-25: 75 workflows created on 15-16 August inside
    // `sales-cold-email-outreach`, a channel with 18 workflows that DO have spend, so the
    // whole-channel guard never fired; those 75 logged ZERO runs and ZERO emails for their entire
    // eight-day life while nine already-spent, zero-outcome workflows rotated on a live customer.
    //
    // So an unproven dynasty gets its brand-level row plus one row per active audience, carrying the
    // EXPLORE ALLOWANCE (`exploreResolved`): the price of ONE OUTREACH in this channel, projected
    // through the goal's funnel. Read the number for what it is — not a claim about how this workflow
    // performs, but the smallest amount of real money that can buy it its FIRST evidence, and the first
    // rung of the floor ladder every measured row already stands on.
    //
    // BOUNDED and SELF-EXTINGUISHING, which is what keeps it from becoming the cheap-forever number the
    // fleet already suffers from:
    //   • it applies ONLY while the dynasty has no grain at all. One run gives it real spend, it leaves
    //     this path for good, and from then on its OWN floor `max(spend, parent)` prices it — rising as
    //     it spends, exactly as a barely-tried workflow's does today.
    //   • it is stated UNMEASURED (`measured: false`, `grain: null`, `estimatesByGrain: {}`), so nothing
    //     can read it as this brand's own result, it can never be RECOMMENDED (below), and every
    //     DISPLAY / benchmark surface ranks measured rows only (the funnel ranking, the customer-health
    //     board, the audience-stats floor parent — which builds its own brand rows and never sees these
    //     — and the dashboard's Strategy pick).
    //   • it states a COST FLOOR and nothing else: no paid-client cost, no return, no %CAC.
    //   • only ACTIVE dynasties are enumerated, so a deprecated or retired workflow stays unreachable.
    //   • no active audience ⇒ nothing is serveable through ANY channel, so nothing is enumerated —
    //     that is the brand fact `no_active_audiences` names, and it is unchanged.
    //
    // A channel with no measured evidence whatsoever has no outreach price either, so its rows carry
    // the all-null resolved block: #805's answer, byte for byte.
    const measuredRowCount = rows.length;
    const measuredDynasties = new Set(rows.map((r) => r.workflow.workflowDynastySlug));
    // Ascending dynasty slug — deterministic, so the same evidence always offers the same order.
    const unprovenDynasties = [...activeSlugByDynasty.keys()].filter((d) => !measuredDynasties.has(d)).sort();
    const outreachUsd = channelOutreachPriceUsd(brandGrain, costMap, aggregatedOutcomes);
    const unprovenResolved: ResolvedBlock =
      outreachUsd != null && (econ || legTerms)
        ? exploreResolved(outreachUsd, econ, objective, singleStepGoal, formSubmissionGoal, meetingChannel, legTerms)
        : UNMEASURED_RESOLVED;

    // An unproven workflow is priced on the allowance (flash, its exploration phase) whatever its verdict.
    // Its held prices: nothing on any grain (no evidence anywhere on the leg) — the explore allowance is
    // the price of a first try, not a price of the workflow, so it is never stated as one.
    const unprovenMaturity = (dynastySlug: string, audienceRow: boolean): Pick<ProjectionRow, "maturity" | "priceByGrain"> => {
      if (!legTerms) return {};
      const activeSlug = activeSlugByDynasty.get(dynastySlug);
      const verdict = activeSlug ? verdictOf(activeSlug) : { isMature: null, matureOutcomes: null };
      return {
        priceByGrain: heldPrices(heldGrainsOf(audienceRow), {}, matureSources ? {} : null),
        maturity: {
          basis: "flash",
          isMature: verdict.isMature,
          matureOutcomes: verdict.matureOutcomes,
          resolved: maturityPair(resolvedFiguresOf(unprovenResolved), matureSources ? NOTHING_RESOLVED : null, verdict.isMature),
        },
      };
    };
    if (audienceEvidence.length > 0) {
      for (const dynastySlug of unprovenDynasties) {
        const workflow = {
          workflowDynastySlug: dynastySlug,
          workflowDynastyName: dynastyNameBySlug.get(dynastySlug) ?? null,
        };
        rows.push({ audienceId: null, workflow, estimatesByGrain: {}, resolved: { ...unprovenResolved }, measured: false, ...unprovenMaturity(dynastySlug, false) });
        for (const ev of audienceEvidence) {
          rows.push({ audienceId: ev.audienceId, workflow, estimatesByGrain: {}, resolved: { ...unprovenResolved }, measured: false, ...unprovenMaturity(dynastySlug, true) });
        }
      }
    }

    // `measured` / `unmeasuredReason` describe the EVIDENCE, so they are read off the MEASURED rows
    // only — an explore-allowance row is not a measurement and must not make a history-less channel
    // claim it has one.
    const unmeasuredReason: UnmeasuredProjectionReason | null =
      measuredRowCount > 0
        ? null
        : audienceEvidence.length === 0
          ? "no_active_audiences"
          : activeSlugByDynasty.size === 0
            ? "no_active_workflows"
            : "no_spend_recorded";

    // RECOMMENDATION — ranked on whatever the caller said it is maximising, and on nothing else.
    //
    //  • `return` (the default, and what this has always done): the row with the LOWEST resolved
    //    cost-per-outcome. A dollar buys the most outcome here.
    //  • `conversionRate`: the row with the HIGHEST measured conversion rate. A PERSON buys the most
    //    outcome here — which is the question when the list, not the budget, is what runs out.
    //
    // Both skip UNMEASURED rows for the same reason: the explore allowance is what makes a workflow
    // REACHABLE, not a recommendation to put a customer's budget behind it.
    //
    // ── THE ORDER IS SERVED, AND THE RECOMMENDATION IS ITS HEAD BY CONSTRUCTION ──────────────────
    //
    // A rank is a property of the WORKFLOW, so it is scored per DYNASTY over every row that dynasty
    // has — the identical population the recommendation is chosen from. A consumer that re-derived an
    // order over the subset it displays would produce a second one, and the two disagree: in prod the
    // recommended workflow sat 18th of 24 on a page ranking one row per workflow while the pick was
    // made over all of them. Ranked here, rank 1 IS the recommendation and nobody can re-derive.
    //
    // A TOTAL order: dynasties sort into three groups — rankable (measured, with a usable metric),
    // then measured-but-unrankable, then never-run (the explore allowance, which may never outrank
    // measured evidence) — and ties inside a group break on the dynasty slug, so there are no ties and
    // no gaps and the same evidence always produces the same list.
    const better = (a: number, b: number): boolean => (maximize === "conversionRate" ? a > b : a < b);

    // ── A WORKFLOW NOT ASSIGNED ACTIVE ON THE LEG IS NEVER PUT FORWARD ────────────────────────────
    //
    // The leg assignment (leg-keyed reads only) is the OUTERMOST key of every order below: a workflow
    // that is unassigned or deprecated on the leg sorts after EVERY selectable one — measured or not —
    // in `rank` and in each scope's `scopeRank`, and it can never be the recommendation. Its rows stay
    // in the body with their state (a workflow that already ran keeps its spend visible).
    const assignment = legTerms ? (input.legAssignmentByDynasty ?? null) : null;
    const excludedTier = (slug: string): number =>
      assignment && assignment.get(slug)?.selectable !== true ? 1 : 0;
    const metricOf = (row: ProjectionRow): number | null =>
      maximize === "conversionRate" ? row.resolved.conversionRatePct : row.resolved.costPerOutcomeUsd;
    const rankableMetric = (row: ProjectionRow): number | null => {
      if (!row.measured) return null;
      const m = metricOf(row);
      return m == null || m <= 0 ? null : m;
    };

    // Per dynasty: its BEST rankable row's metric — the same argmin the recommendation has always used,
    // simply kept per workflow instead of collapsed to one winner.
    const bestByDynasty = new Map<string, { metric: number | null; row: ProjectionRow; measured: boolean }>();
    for (const row of rows) {
      const slug = row.workflow.workflowDynastySlug;
      const metric = rankableMetric(row);
      const current = bestByDynasty.get(slug);
      if (!current) {
        bestByDynasty.set(slug, { metric, row, measured: row.measured });
        continue;
      }
      current.measured = current.measured || row.measured;
      if (metric != null && (current.metric == null || better(metric, current.metric))) {
        current.metric = metric;
        current.row = row;
      }
    }

    const orderedDynasties = [...bestByDynasty.entries()].sort((a, b) => {
      const ea = excludedTier(a[0]);
      const eb = excludedTier(b[0]);
      if (ea !== eb) return ea - eb;
      const ga = a[1].measured ? (a[1].metric == null ? 1 : 0) : 2;
      const gb = b[1].measured ? (b[1].metric == null ? 1 : 0) : 2;
      if (ga !== gb) return ga - gb;
      if (ga === 0) {
        const ma = a[1].metric!;
        const mb = b[1].metric!;
        if (ma !== mb) return better(ma, mb) ? -1 : 1;
      }
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

    // ── ON A MISSION READ: CHEAPER LEARNING WORKFLOWS, THEN THE CHEAPEST MATURE FOR THE OFFER ─────
    //
    // A mission (a `?campaignId=` beside the `?leg=`, whose campaign states an offer — i.e. the offer
    // grain was read) is ordered on MATURE cost per outcome, finest grain first: the offer's own price
    // (owner rule 2026-09-30), and for a workflow not mature on the offer yet its brand, then its fleet
    // mature price (owner rule 2026-10-01; `lib/mission-workflow-order.ts`). Workflows no mature price
    // places keep the general order below; the slug breaks a tie only after every price.
    //
    //   selectable before non-selectable (leg assignment) → learning workflows cheaper than the best
    //   mature one → mature on the offer → mature on the brand → mature on the fleet (each ascending) →
    //   the rest in the general order → retired.
    //
    // A LEARNING workflow (no mature price anywhere) whose general-order figure (its best rankable
    // resolved cost per outcome, flash with its cascade floor) is already cheaper than the best mature
    // one's mature price sits ABOVE it, cheapest first: the general order's rule and figure (owner
    // 2026-10-01; withdraws "learning below every mature on a mission" from #1233).
    //
    // ONE answer: rank 1 IS `recommendedWorkflowDynastySlug` (below), mature or learning, so
    // the row a page marks "money goes here" and the recommendation cannot disagree (prod 2026-10-01:
    // the page said dawn while the recommendation and the money were osprey). `scopeRank` is untouched.
    const missionOrder: string[] | null =
      legTerms && evidence.offerGrain
        ? (() => {
            const brandRowBySlug = new Map<string, ProjectionRow>();
            for (const row of rows) {
              if (row.audienceId === null && !brandRowBySlug.has(row.workflow.workflowDynastySlug)) {
                brandRowBySlug.set(row.workflow.workflowDynastySlug, row);
              }
            }
            const generalPosition = new Map(orderedDynasties.map(([slug], i) => [slug, i]));
            return orderMissionWorkflows(
              [...bestByDynasty.keys()].map((slug) => {
                const row = brandRowBySlug.get(slug);
                const g = row?.estimatesByGrain;
                return {
                  slug,
                  excluded: excludedTier(slug) === 1,
                  retired: row?.retired === true,
                  grains: { offer: g?.offer ?? null, brand: g?.brand ?? null, crossOrg: g?.crossOrg ?? null },
                  fallbackPosition: generalPosition.get(slug)!,
                  // The general order's own figure: a learning workflow cheaper on it than the best
                  // mature one goes above it, exactly as in the general order (owner 2026-10-01).
                  learningCostPerOutcomeUsd: maximize === "conversionRate" ? null : bestByDynasty.get(slug)!.metric,
                };
              }),
            );
          })()
        : null;

    const rankByDynasty = new Map<string, number>();
    (missionOrder ?? orderedDynasties.map(([slug]) => slug)).forEach((slug, i) => rankByDynasty.set(slug, i + 1));
    // Only a leg-keyed answer carries the rank on the wire — every funnel- and goal-keyed body is
    // byte-unchanged, which is what keeps campaign-service's production workflow selection untouched.
    if (legTerms) {
      for (const row of rows) row.rank = rankByDynasty.get(row.workflow.workflowDynastySlug);

      // ── AND WHETHER THIS WORKFLOW IS ASSIGNED TO THE LEG ─────────────────────────────────────
      //
      // Stated per row, and acted on ONLY by the orders (see `excludedTier` above): the figures are
      // untouched and the row is always served, so a deprecated workflow keeps its history on screen.
      if (assignment) {
        for (const row of rows) {
          const slug = row.workflow.workflowDynastySlug;
          const verdict = assignment.get(slug);
          if (!verdict) continue;
          row.legAssignment = verdict;
          row.modelEligibility = {
            modelAlias: input.modelAliasByDynasty?.get(slug) ?? null,
            modelTier: null,
            eligible: verdict.selectable,
            ineligibleReason: verdict.reason,
            unknownTierReason: null,
          };
        }
      }

      // ── AND THE ORDER WITHIN ONE SCOPE, so a surface showing ONE grain can be read ─────────────
      //
      // Rows sharing an `audienceId` are the rows a reader compares: one audience's column, or the
      // brand / campaign column (`audienceId: null`). A dynasty appears exactly once inside a scope,
      // so this is a plain sort of the rows on their OWN resolved metric — the same `better` and the
      // same three groups the dynasty order above uses, which is what keeps an unproven workflow
      // below every measured one here too. See `ProjectionRow.scopeRank` for why it is served.
      const byScope = new Map<string | null, ProjectionRow[]>();
      for (const row of rows) {
        const bucket = byScope.get(row.audienceId);
        if (bucket) bucket.push(row);
        else byScope.set(row.audienceId, [row]);
      }
      for (const scopeRows of byScope.values()) {
        scopeRows
          .slice()
          .sort((a, b) => {
            const ea = excludedTier(a.workflow.workflowDynastySlug);
            const eb = excludedTier(b.workflow.workflowDynastySlug);
            if (ea !== eb) return ea - eb;
            const ma = rankableMetric(a);
            const mb = rankableMetric(b);
            const ga = a.measured ? (ma == null ? 1 : 0) : 2;
            const gb = b.measured ? (mb == null ? 1 : 0) : 2;
            if (ga !== gb) return ga - gb;
            if (ga === 0 && ma !== mb) return better(ma!, mb!) ? -1 : 1;
            const sa = a.workflow.workflowDynastySlug;
            const sb = b.workflow.workflowDynastySlug;
            return sa < sb ? -1 : sa > sb ? 1 : 0;
          })
          .forEach((row, i) => {
            row.scopeRank = i + 1;
          });
      }
    }

    // The recommendation is the head of that order: the best rankable row of the rank-1 dynasty. The
    // groups above put every rankable dynasty before every unrankable one, so this is non-null exactly
    // when some row is rankable — the byte-same condition the previous argmin answered on.
    // An excluded head means NO workflow is assigned active on the leg (the assignment is the outermost
    // key), and the answer is then no recommendation, stated with its reason — never a fall back.
    const head = orderedDynasties[0];
    const headExcluded = head != null && excludedTier(head[0]) === 1;
    // On a mission read the recommendation IS rank 1: its brand-level row when it holds a mature price,
    // else its best rankable row (a learning workflow cheaper than the best mature).
    const missionHeadRow: ProjectionRow | null = (() => {
      const slug = missionOrder?.[0];
      if (!slug || excludedTier(slug) === 1) return null;
      const row = rows.find((r) => r.audienceId === null && r.workflow.workflowDynastySlug === slug);
      if (!row || row.retired) return null;
      const g = row.estimatesByGrain;
      if (missionPriceOf({ grains: { offer: g.offer ?? null, brand: g.brand ?? null, crossOrg: g.crossOrg ?? null } })) return row;
      // A learning workflow placed first (cheaper than the best mature): its best rankable row, as the
      // general order recommends it.
      const best = bestByDynasty.get(slug);
      return best && best.metric != null ? best.row : null;
    })();
    const pricedRecommendation: ProjectionRow | null =
      missionHeadRow ?? (head && !headExcluded && head[1].metric != null ? head[1].row : null);
    // ── COLD START: a leg whose selectable workflows have no price yet still names one to run ──────
    //
    // Without it a consumer that launches "the recommended workflow" cannot start the leg at all, and
    // the leg never gets the evidence that would price it (prod 2026-10-03: conversation_to_meeting_booked
    // had rhodium assigned active, no evidence, no recommendation, so every onboarding launch failed).
    // Only on a leg read, only when no priced workflow exists: the rank-1 selectable, non-retired
    // dynasty (rank already puts measured-unrankable before never-run, slug ties). Its cost fields stay
    // null and `recommendationBasis: "cold_start"` says so; `recommendedBudgetUsd` stays null.
    const coldStartRow: ProjectionRow | null =
      legTerms && !pricedRecommendation
        ? (() => {
            for (const slug of missionOrder ?? orderedDynasties.map(([s]) => s)) {
              if (excludedTier(slug) === 1) continue;
              const row =
                rows.find((r) => r.audienceId === null && r.workflow.workflowDynastySlug === slug) ??
                bestByDynasty.get(slug)!.row;
              if (row.retired) continue;
              return row;
            }
            return null;
          })()
        : null;
    const recommended: ProjectionRow | null = pricedRecommendation ?? coldStartRow;
    // The budget still answers "what does a month of this cost", whichever way the pick was made — it is
    // priced off the RECOMMENDED row's own cost per outcome, so it describes the workflow that was
    // actually chosen rather than the one the other objective would have chosen.
    // A cold-start pick has no price (its row may carry the explore allowance, a floor, never a price).
    const recommendedCost = pricedRecommendation?.resolved.costPerOutcomeUsd ?? null;

    return {
      featureSlug,
      objective,
      maximize,
      goal,
      ...(input.funnelKey ? { funnelKey: input.funnelKey } : {}),
      economics: economicsEcho,
      rows,
      recommendedWorkflowDynastySlug: recommended?.workflow.workflowDynastySlug ?? null,
      recommendedBudgetUsd: recommendedCost != null ? TARGET_OUTCOMES_PER_MONTH * recommendedCost : null,
      measured: unmeasuredReason === null,
      ...(unmeasuredReason ? { unmeasuredReason } : {}),
      ...(headExcluded ? { recommendationWithheldReason: "no_eligible_workflow" as const } : {}),
      ...(coldStartRow ? { recommendationBasis: "cold_start" as const } : {}),
      ...(legKey && rule
        ? {
            maturity: {
              ...rule,
              cutoffIso: rule.durationDays > 0 ? (evidence.mature?.cutoffIso ?? maturityCutoffIso(rule.durationDays)) : null,
              measured: matureSources !== null,
              unmeasuredReason: matureSources
                ? null
                : evidence.legKey
                  ? (evidence.matureUnavailableReason ?? "serve_dates_unavailable")
                  : ("leg_scope_unavailable" as const),
            },
          }
        : {}),
    };
}

export default router;
