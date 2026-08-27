/**
 * WHAT A (SALES FUNNEL, ACQUISITION CHANNEL) PAIR HAS ACTUALLY RETURNED — priced per STEP, per SALE,
 * and as a return per dollar, publicly, with no customer identity.
 *
 * A customer buys a PAIR, not a channel and not a funnel: the same funnel costs a very different amount
 * through a phone channel than through paid search, so a brand-level or channel-level aggregate cannot
 * answer the question the marketing site prints one row per pair to answer.
 *
 * ── NOT ENOUGH DATA IS AN ANSWER, AND IT IS THE ONLY ONE WE MAY INVENT ────────────────────────────
 *
 * A pair we have not measured enough SAYS SO — `measured: false` with a `reason` naming which
 * ingredient is missing. It never returns a figure, and it never returns an empty value a consumer
 * would have to interpret. The same rule runs one level down: inside a measured pair, a STEP whose rate
 * the brands never declared reads `costPerStepUsd: null` with its own `unpricedReason`, rather than 0
 * (which would read as "this step is free") or a number funneled through a rate nobody stated.
 *
 * ── HOW A FUNNEL IS PRICED ─────────────────────────────────────────────────────────────────────────
 *
 * Exactly the way every other cost surface in this service prices one, through the SAME
 * `projectOutcomeCosts`, so a public per-pair figure and the customer's own dashboard can never print
 * two prices for one funnel:
 *
 *   1. The channel's pooled all-history spend over its pooled produced steps gives its unit costs —
 *      `clickUsd` (a website visit) and `replyUsd` (a conversation).
 *   2. Those unit costs are MASKED to the funnel's own channel, because a funnel is bought through one of
 *      them: the conversation funnel prices `replyUsd / replyToMeetingPct` and the website funnel
 *      `clickUsd / visitToMeetingPct` against the identical evidence. Blending them would benchmark a
 *      reply-bought meeting against clicks the funnel never buys.
 *   3. The funnel's own rates carry the masked unit cost down to a SALE.
 *
 * Return is `lifetimeRevenueUsd / costPerSaleUsd` — the identical definition `/features/:slug/
 * funnel-ranking` ranks a brand's declared funnels on, so a public row and a customer's own ranking are
 * one statistic at two scopes.
 */

import { projectOutcomeCosts, type ProjectionEconomics, type ProjectionUnitCosts } from "./funnel-registry.js";
import { SALES_FUNNELS, type SalesFunnelKey, type MeetingChannel } from "./sales-funnels.js";

/** Why a pair has no measured economics. Every value names a MISSING INGREDIENT, so a consumer can say
 *  which one we still owe them rather than printing a blank. */
export type PairUnmeasuredReason =
  /** Nothing has ever been spent running this channel, so there is no cost to divide. */
  | "no_spend_recorded"
  /** Spent, but the funnel's own entry step (a conversation / a website visit) was never produced. */
  | "no_entry_step_produced"
  /** No brand running this channel has declared the economics the funnel is made of. */
  | "no_economics_declared";

/** Why one STEP of an otherwise-measured funnel carries no price. */
export type StepUnpricedReason =
  /** The rate that carries the funnel from the previous step to this one was never declared. */
  | "rate_not_declared"
  /** The declared rate is 0, so no spend reaches this step — a price would be a division by zero. */
  | "rate_is_zero";

export interface PricedStep {
  /** The step, worded exactly as brand-service words it in the funnel. */
  step: string;
  /** True for the step the funnel is NAMED after — its MILESTONE. */
  milestone: boolean;
  /** What reaching this step costs, projected through the funnel. Null when it cannot be priced. */
  costPerStepUsd: number | null;
  /** Present exactly when `costPerStepUsd` is null. */
  unpricedReason: StepUnpricedReason | null;
}

export interface PairEconomics {
  /** Every step of the funnel, in order, each priced or explicitly unpriced. */
  steps: PricedStep[];
  /** What one SALE costs through this pair — the terminal step's own price. */
  costPerSaleUsd: number | null;
  /** Present exactly when `costPerSaleUsd` is null. */
  costPerSaleUnpricedReason: StepUnpricedReason | null;
  /** `lifetimeRevenueUsd / costPerSaleUsd` — what a dollar through this pair returns. */
  returnPerDollar: number | null;
  /** The lifetime revenue the return is computed against. Surfaced so a consumer can never pair a
   *  return with a revenue figure this projection did not use. */
  lifetimeRevenueUsd: number | null;
  /** The evidence the prices ride on, so the row can say how much it is standing on. */
  evidence: {
    totalSpentUsd: number;
    conversationsProduced: number;
    websiteVisitsProduced: number;
    /** Brands whose declared economics backed the funnel's rates. */
    brandCount: number;
  };
}

export type PairResult =
  | { measured: true; economics: PairEconomics }
  | { measured: false; reason: PairUnmeasuredReason };

/**
 * The step a funnel is NAMED after — its MILESTONE. It is the step BEFORE the terminal sale for the two
 * self-serve funnels and the booked meeting for the two meeting funnels; naming it explicitly here beats
 * inferring it from the funnel's own wording downstream.
 */
export const FUNNEL_MILESTONE_STEP: Record<SalesFunnelKey, string> = {
  sales_meetings_from_conversation: "Meeting booked",
  sales_meetings_from_website: "Meeting booked",
  website_purchases: "Signup",
  form_magnet: "Form filled",
};

/** A funnel is bought through ONE channel; the other one's evidence is masked away so it cannot dilute
 *  the price. Byte-identical to `workflow-projection`'s own mask, for the same reason. */
function maskUnitCostsForChannel(unitCosts: ProjectionUnitCosts, channel: MeetingChannel | null): ProjectionUnitCosts {
  if (channel === "click") return { clickUsd: unitCosts.clickUsd, replyUsd: null };
  if (channel === "reply") return { clickUsd: null, replyUsd: unitCosts.replyUsd };
  return unitCosts;
}

/** Which unit cost a funnel's ENTRY step is bought with, and therefore which produced step it needs. */
export function funnelEntryChannel(key: SalesFunnelKey): MeetingChannel {
  return key === "sales_meetings_from_conversation" ? "reply" : "click";
}

const priced = (step: string, milestone: boolean, cost: number | null, reason: StepUnpricedReason): PricedStep => ({
  step,
  milestone,
  costPerStepUsd: cost,
  unpricedReason: cost == null ? reason : null,
});

export interface PricePairInput {
  funnelKey: SalesFunnelKey;
  /** Pooled all-history unit costs for the CHANNEL — before the funnel's own channel mask. */
  unitCosts: ProjectionUnitCosts;
  /** The fleet-mean economics of the brands running this channel; null when none declared any. */
  economics: ProjectionEconomics | null;
  /** Mean lifetime revenue across those same brands; null when none stated one. */
  lifetimeRevenueUsd: number | null;
  evidence: PairEconomics["evidence"];
}

/**
 * Price one (funnel, channel) pair, or state which ingredient is missing.
 *
 * The three unmeasured reasons are checked in the order a buyer would ask them: did we spend anything,
 * did the channel produce the step the funnel starts from, and do we know the funnel's rates. Only when
 * all three are answered does a figure get printed.
 */
export function pricePair(input: PricePairInput): PairResult {
  const { funnelKey, unitCosts, economics, lifetimeRevenueUsd, evidence } = input;

  if (evidence.totalSpentUsd <= 0) return { measured: false, reason: "no_spend_recorded" };

  const entryChannel = funnelEntryChannel(funnelKey);
  const entryUnitCost = entryChannel === "reply" ? unitCosts.replyUsd : unitCosts.clickUsd;
  if (entryUnitCost == null) return { measured: false, reason: "no_entry_step_produced" };

  if (!economics) return { measured: false, reason: "no_economics_declared" };

  const def = SALES_FUNNELS[funnelKey];
  const masked = maskUnitCostsForChannel(unitCosts, def.meetingChannel ?? entryChannel);
  const p = projectOutcomeCosts(economics, masked);
  const milestone = FUNNEL_MILESTONE_STEP[funnelKey];
  const isMilestone = (step: string): boolean => step === milestone;

  let steps: PricedStep[];
  let costPerSaleUsd: number | null;

  if (funnelKey === "sales_meetings_from_conversation" || funnelKey === "sales_meetings_from_website") {
    costPerSaleUsd = p.costPerMeetingPaidClientUsd;
    steps = [
      // The funnel's entry step IS the produced step, so its price is the channel's own unit cost.
      priced(def.steps[0], isMilestone(def.steps[0]), entryUnitCost, "rate_is_zero"),
      priced(def.steps[1], isMilestone(def.steps[1]), p.costPerMeetingBookedUsd, "rate_is_zero"),
      // "Meeting attended" has no price of its own and never will from this data: brand-service folds
      // the show-up rate into the booked→paid rate (`meetingFunnelCloseRate`), so there is no separate
      // attended rate to carry spend to. Saying so is the honest answer; inventing one would assert a
      // 100% show-up rate, which is the exact bug the composed rate exists to prevent.
      priced(def.steps[2], isMilestone(def.steps[2]), null, "rate_not_declared"),
      priced(def.steps[3], isMilestone(def.steps[3]), costPerSaleUsd, "rate_is_zero"),
    ];
  } else if (funnelKey === "website_purchases") {
    costPerSaleUsd = p.costPerSignupPaidClientUsd;
    steps = [
      priced(def.steps[0], isMilestone(def.steps[0]), entryUnitCost, "rate_is_zero"),
      priced(def.steps[1], isMilestone(def.steps[1]), p.costPerSignupUsd, "rate_is_zero"),
      priced(def.steps[2], isMilestone(def.steps[2]), costPerSaleUsd, "rate_is_zero"),
    ];
  } else {
    costPerSaleUsd = p.costPerFormSubmissionPaidClientUsd;
    steps = [
      priced(def.steps[0], isMilestone(def.steps[0]), entryUnitCost, "rate_is_zero"),
      priced(def.steps[1], isMilestone(def.steps[1]), p.costPerFormSubmissionUsd, "rate_is_zero"),
      priced(def.steps[2], isMilestone(def.steps[2]), costPerSaleUsd, "rate_is_zero"),
    ];
  }

  // A return needs BOTH a price for the sale and a stated lifetime revenue. Missing either leaves it
  // null — never 0, which would say a dollar through this pair comes back as nothing.
  const returnPerDollar =
    costPerSaleUsd != null && costPerSaleUsd > 0 && lifetimeRevenueUsd != null && lifetimeRevenueUsd > 0
      ? lifetimeRevenueUsd / costPerSaleUsd
      : null;

  return {
    measured: true,
    economics: {
      steps,
      costPerSaleUsd,
      costPerSaleUnpricedReason: costPerSaleUsd == null ? "rate_is_zero" : null,
      returnPerDollar,
      lifetimeRevenueUsd,
      evidence,
    },
  };
}
