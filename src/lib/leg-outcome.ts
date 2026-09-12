/**
 * A LEG-KEYED READ IS PRICED ON THE LEG'S OWN STEP — never on the step its funnel is named after.
 *
 * `?leg=` names the thing a customer is putting a budget behind: one arrow of one funnel. Until this
 * module existed the leg was resolved to its basis FUNNEL and then priced through that funnel's GOAL,
 * so `start_to_conversation` — whose outcome is a conversation — was answered with the price of a
 * BOOKED MEETING. On a brand converting 20% of its conversations into meetings that is five times the
 * real figure, and nothing about the body said so: the number was real, it simply answered a question
 * nobody asked. Measured in prod 2026-09-12 on brand `75d7e3e8…`, leg `start_to_conversation`: the
 * Lithium workflow had 13 observed conversations on $2,141.76 of brand spend — $164.75 each — and the
 * read served $823.75.
 *
 * ── THE OUTCOME OF A LEG IS ITS `toStep`, AND NOTHING ELSE ───────────────────────────────────────
 *
 * So every figure a leg-keyed answer states as a cost-per-outcome, an outcome count, or a conversion
 * rate is denominated in the leg's `toStep`. The funnel is still resolved — it decides WHICH rates
 * price the walk from the observed signal to that step — but it no longer decides which step is being
 * bought. `costPerPaidClientUsd`, `costPerMeetingBookedUsd`, `roiMultiple` and `cacPct` keep their own
 * names and their own meanings: a paid-client cost is a paid-client cost whatever leg was named.
 *
 * ── WHAT A GRAIN CAN ACTUALLY OBSERVE ────────────────────────────────────────────────────────────
 *
 * A grain's evidence is spend plus two counted signals: clicks and positive replies. Each funnel is
 * entered through exactly ONE of them (`driver`), so the leg's outcome count is that driver's observed
 * count walked forward through the funnel's own declared rates, and its cost is the driver's unit cost
 * walked the same way. For an ENTRY leg the walk is empty — the driver signal IS the outcome — so the
 * count is a raw OBSERVATION and the cost is the driver's own unit cost. That is the case that was
 * wrong, and it is the one this makes exact rather than merely closer.
 *
 * ── A RATE THE BRAND NEVER DECLARED STAYS ABSENT ─────────────────────────────────────────────────
 *
 * A step whose walk needs a rate that is not on the wire is UNPRICEABLE: `rateFromDriver` is null, the
 * cost and the count are null, and nothing is defaulted, averaged or borrowed from a neighbouring
 * funnel. A declared `0` is a real answer and passes through as 0 (a step nobody reaches costs
 * infinitely much, which is stated as null rather than as a number).
 */
import { funnelStepKeys, type ChannelStepKey } from "./acquisition-channels.js";
import type { SalesFunnelKey } from "./sales-funnels.js";
import type { ProjectionEconomics } from "./funnel-registry.js";

/** The counted signal a funnel is entered through — the only two a grain observes. */
export type LegDriver = "click" | "reply";

/** Which signal a funnel is entered through. A meeting funnel's whole identity is this one thing. */
export const FUNNEL_DRIVER: Record<SalesFunnelKey, LegDriver> = {
  sales_meetings_from_conversation: "reply",
  sales_meetings_from_website: "click",
  website_purchases: "click",
  form_magnet: "click",
};

export interface LegOutcomeTerms {
  /** The funnel the walk was priced through. */
  funnelKey: SalesFunnelKey;
  /** The leg's own step — what every figure on a leg-keyed answer is denominated in. */
  outcomeStep: ChannelStepKey;
  /** The observed signal the walk starts from. */
  driver: LegDriver;
  /**
   * P(a lead reaches the leg's own step | one driver signal), as a decimal. **1 for an ENTRY leg** —
   * the driver signal IS the outcome, so the count is a raw observation and the cost is the driver's
   * own unit cost. NULL when the walk needs a rate the brand never declared: unpriceable, never 0.
   */
  rateFromDriver: number | null;
  /** TRUE ⟺ the leg's step IS the driver signal, so its count is OBSERVED rather than projected. */
  outcomeObserved: boolean;
}

/** Multiply, propagating "we have no rate for this" rather than collapsing it to 0. */
const chain = (...rates: Array<number | null | undefined>): number | null => {
  let out = 1;
  for (const r of rates) {
    if (r == null || !Number.isFinite(r)) return null;
    out *= r;
  }
  return out;
};

/**
 * The terms a leg's own step is priced on, for ONE basis funnel.
 *
 * `bookedToAttended` is the show-up rate — the one rung brand-service states no field for. Its
 * `meetingToClosePct` is BOOKED→paid (already the composition `show-up × attended→paid` on a declared
 * funnel), and `meetingAttendedToPaidClientPct` is the ATTENDED→paid half, so the show-up rate is the
 * ratio of the two. A brand that declared no attended→paid rate has said nothing that tells a meeting
 * somebody took apart from one they booked and missed, so it stands in at 1 — the SAME fallback
 * `SalesEconomics.meetingAttendedToPaidClientPct` documents, never a fabricated discount.
 *
 * Returns null when the step is not a step of this funnel — the caller then has no leg to price and
 * says so, rather than pricing a step through a route the funnel does not contain.
 */
export function legOutcomeTerms(
  funnelKey: SalesFunnelKey,
  outcomeStep: ChannelStepKey,
  econ: ProjectionEconomics,
  bookedToAttended: number,
): LegOutcomeTerms | null {
  const steps = funnelStepKeys(funnelKey);
  if (!steps.includes(outcomeStep)) return null;
  const driver = FUNNEL_DRIVER[funnelKey];
  const entryStep = steps[0]!;
  const outcomeObserved = outcomeStep === entryStep;

  const rateFromDriver = ((): number | null => {
    if (outcomeObserved) return 1;
    switch (funnelKey) {
      case "sales_meetings_from_conversation":
        if (outcomeStep === "meeting_booked") return chain(econ.r2m);
        if (outcomeStep === "meeting_attended") return chain(econ.r2m, bookedToAttended);
        if (outcomeStep === "paid_client") return chain(econ.r2m, econ.m2c);
        return null;
      case "sales_meetings_from_website":
        if (outcomeStep === "meeting_booked") return chain(econ.v2m);
        if (outcomeStep === "meeting_attended") return chain(econ.v2m, bookedToAttended);
        if (outcomeStep === "paid_client") return chain(econ.v2m, econ.m2c);
        return null;
      case "website_purchases":
        if (outcomeStep === "signup") return chain(econ.v2s);
        if (outcomeStep === "paid_client") return chain(econ.v2s, econ.s2pc);
        return null;
      case "form_magnet":
        if (outcomeStep === "form_filled") return chain(econ.v2fs);
        if (outcomeStep === "paid_client") return chain(econ.v2fs, econ.fs2pc);
        return null;
    }
  })();

  return { funnelKey, outcomeStep, driver, rateFromDriver, outcomeObserved };
}

/**
 * The SHOW-UP rate, derived from the two rates brand-service does state. See `legOutcomeTerms`.
 * Clamped to 1: a composition that reads above 1 is two rates that disagree, and a probability
 * above certainty is not a number we may serve.
 */
export function bookedToAttendedRate(economics: {
  meetingToClosePct: number;
  meetingAttendedToPaidClientPct?: number;
}): number {
  const attendedToPaid = economics.meetingAttendedToPaidClientPct;
  if (attendedToPaid == null || !Number.isFinite(attendedToPaid) || attendedToPaid <= 0) return 1;
  return Math.min(1, economics.meetingToClosePct / attendedToPaid);
}

/** What ONE grain's evidence says about the leg's own outcome. */
export interface GrainLegOutcome {
  /** The dollars one outcome OF THE LEG costs at this grain. Null when the walk is unpriceable. */
  costPerOutcomeUsd: number | null;
  /** How many of the leg's own outcomes this grain's evidence accounts for. Null when unpriceable. */
  outcomeCount: number | null;
  /** TRUE ⟺ that count is a raw OBSERVATION (an entry leg) rather than a projection from the driver. */
  outcomeObserved: boolean;
  /** The spend behind them, at this grain — the third figure a panel needs and cannot derive. */
  spentUsd: number;
}

/**
 * Price the leg's own step off ONE grain's evidence.
 *
 * `driverUnitCost` is the grain's own cascade-floored unit cost for the driver signal, so an unproven
 * grain still reports a floor rather than nothing — the explore device is untouched, it is simply
 * denominated in the leg's step now. `driverObserved` is the grain's raw count of that signal: 0 is a
 * MEASUREMENT (this grain reached people and none of them answered) and `outcomeObserved` says whether
 * the count above it was counted or walked.
 */
export function grainLegOutcome(
  terms: LegOutcomeTerms,
  grain: { spentUsd: number; driverUnitCostUsd: number; driverObserved: number },
): GrainLegOutcome {
  const rate = terms.rateFromDriver;
  return {
    costPerOutcomeUsd: rate != null && rate > 0 ? grain.driverUnitCostUsd / rate : null,
    outcomeCount: rate != null ? grain.driverObserved * rate : null,
    outcomeObserved: terms.outcomeObserved,
    spentUsd: grain.spentUsd,
  };
}
