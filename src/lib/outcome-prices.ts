/**
 * THE EXPECTED PRICE OF ONE OUTCOME A NEW CUSTOMER CAN BUY — website visits, or meetings booked.
 *
 * The public onboarding asks a signed-out visitor what they want to buy, before their brand has any data
 * of its own. Each option states what one outcome is expected to cost, read at the FLEET grain (every
 * org's campaigns on the leg) — the only evidence a brand created minutes ago has.
 *
 * OWNER RULE (2026-09-29), per leg: take the BEST workflow's price for that leg — its MATURE figure when
 * any workflow is mature on the leg (`lib/maturity.ts`), otherwise the best FLASH (early) figure. A
 * workflow the owner DEPRECATED on the leg is not a price anybody can buy, so it never competes; every
 * other workflow does.
 *
 *   - WEBSITE VISITS = one campaign, cold email, leg start → website visit: that leg's best cost per visit.
 *   - MEETINGS BOOKED = two campaigns chained: cold email (start → positive reply) then the AI meeting
 *     booking (positive reply → meeting booked). Per meeting:
 *
 *         price = replyCost / (meetingRatePct / 100) + meetingLegCost
 *
 *     `replyCost` = the cold-email leg's best cost per positive reply; `meetingRatePct` = the meeting leg's
 *     best workflow's conversion (meetings booked ÷ conversations it answered); `meetingLegCost` = that
 *     same workflow's own cost per meeting booked. The reply cost is divided by the rate because a meeting
 *     needs 1/rate replies; the meeting leg's own spend is added on top.
 *
 * NOTHING IS INVENTED: a leg with no workflow that has produced an outcome is `unmeasured` with a named
 * reason, and a composite that needs it is `unmeasured` too — never a default price, never a 0.
 *
 * Pure: the route reads the evidence; this picks and composes.
 */
import type { LegMaturityFigures, OutcomeFigures } from "./maturity.js";

/** Why a leg (or the composite resting on it) states no price. */
export type OutcomePriceUnmeasuredReason =
  /** No campaign of any org performs the leg yet. */
  | "no_campaigns_on_leg"
  /** Campaigns exist, but no eligible workflow has produced one outcome of the leg. */
  | "no_workflow_with_outcomes"
  /** The meetings price: one of its two legs states no price. */
  | "leg_unmeasured";

/** One leg's price, as served: the chosen workflow, which version priced it, and its figures. */
export interface LegPrice {
  legKey: string;
  featureSlug: string;
  /** `mature` = the workflow is mature on the leg and priced on its mature evidence; `flash` = early. */
  basis: "mature" | "flash" | null;
  workflowDynastySlug: string | null;
  /** The chosen workflow's cost per outcome of the leg, on `basis`. Null ⟺ unmeasured. */
  costPerOutcomeUsd: number | null;
  /** The chosen workflow's conversion on the leg (outcomes ÷ people it worked), on `basis`. */
  conversionRatePct: number | null;
  /** The figures the price was read off (the chosen workflow on `basis`). */
  figures: OutcomeFigures | null;
  /** How many eligible workflows are mature on the leg. */
  matureWorkflowCount: number;
  unmeasuredReason: OutcomePriceUnmeasuredReason | null;
}

/**
 * PURE. The best workflow's price on one leg. `byDynasty` = every workflow's figures on the leg (both
 * versions); `excluded` = dynasties the owner deprecated on it; `campaignCount` = the leg's campaigns.
 */
export function pickLegPrice(input: {
  legKey: string;
  featureSlug: string;
  byDynasty: ReadonlyMap<string, LegMaturityFigures>;
  excluded: ReadonlySet<string>;
  campaignCount: number;
}): LegPrice {
  const eligible = [...input.byDynasty].filter(([slug]) => !input.excluded.has(slug));
  const cheapest = (rows: Array<{ slug: string; figures: OutcomeFigures }>) =>
    rows.sort((a, b) =>
      a.figures.costPerOutcomeUsd! !== b.figures.costPerOutcomeUsd!
        ? a.figures.costPerOutcomeUsd! - b.figures.costPerOutcomeUsd!
        : a.slug < b.slug
          ? -1
          : 1,
    )[0] ?? null;
  const mature = eligible
    .filter(([, f]) => f.isMature === true && f.mature?.costPerOutcomeUsd != null)
    .map(([slug, f]) => ({ slug, figures: f.mature! }));
  const flash = eligible
    .filter(([, f]) => f.flash?.costPerOutcomeUsd != null)
    .map(([slug, f]) => ({ slug, figures: f.flash! }));
  const matureBest = cheapest(mature);
  const pick = matureBest ?? cheapest(flash);
  const basis = matureBest ? "mature" : pick ? "flash" : null;
  return {
    legKey: input.legKey,
    featureSlug: input.featureSlug,
    basis,
    workflowDynastySlug: pick?.slug ?? null,
    costPerOutcomeUsd: pick?.figures.costPerOutcomeUsd ?? null,
    conversionRatePct: pick?.figures.conversionRatePct ?? null,
    figures: pick?.figures ?? null,
    matureWorkflowCount: mature.length,
    unmeasuredReason: pick ? null : input.campaignCount === 0 ? "no_campaigns_on_leg" : "no_workflow_with_outcomes",
  };
}

/** One outcome a customer can buy, priced. */
export interface OutcomePrice {
  /** `mature` when EVERY leg it rests on is priced on mature evidence; `early` when any leg is flash. */
  maturity: "mature" | "early" | null;
  priceUsd: number | null;
  unmeasuredReason: OutcomePriceUnmeasuredReason | null;
}

/** PURE. Website visits: the visit leg's price, verbatim. */
export function websiteVisitPrice(visitLeg: LegPrice): OutcomePrice {
  if (visitLeg.costPerOutcomeUsd == null) {
    return { maturity: null, priceUsd: null, unmeasuredReason: visitLeg.unmeasuredReason };
  }
  return { maturity: visitLeg.basis === "mature" ? "mature" : "early", priceUsd: visitLeg.costPerOutcomeUsd, unmeasuredReason: null };
}

/** The arithmetic of the meetings price, stated so a reader can re-do it by hand. */
export interface MeetingPriceArithmetic {
  replyCostUsd: number;
  meetingRatePct: number;
  /** replyCost / (meetingRatePct / 100): the cold-email spend behind one meeting. */
  repliesCostPerMeetingUsd: number;
  meetingLegCostUsd: number;
}

/** PURE. Meetings booked: replyCost / (rate / 100) + meeting leg cost. */
export function meetingBookedPrice(replyLeg: LegPrice, meetingLeg: LegPrice): OutcomePrice & { arithmetic: MeetingPriceArithmetic | null } {
  const replyCost = replyLeg.costPerOutcomeUsd;
  const rate = meetingLeg.conversionRatePct;
  const meetingCost = meetingLeg.costPerOutcomeUsd;
  // A priced meeting leg has ≥1 outcome, so its rate is > 0; the guard keeps a division by zero impossible.
  if (replyCost == null || rate == null || rate <= 0 || meetingCost == null) {
    return { maturity: null, priceUsd: null, unmeasuredReason: "leg_unmeasured", arithmetic: null };
  }
  const repliesCostPerMeetingUsd = replyCost / (rate / 100);
  return {
    maturity: replyLeg.basis === "mature" && meetingLeg.basis === "mature" ? "mature" : "early",
    priceUsd: repliesCostPerMeetingUsd + meetingCost,
    unmeasuredReason: null,
    arithmetic: { replyCostUsd: replyCost, meetingRatePct: rate, repliesCostPerMeetingUsd, meetingLegCostUsd: meetingCost },
  };
}
