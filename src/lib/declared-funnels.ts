/**
 * The sales funnels a brand DECLARED it sells through, prepared for ranking.
 *
 * OWNERSHIP: the declared set is BRAND-SERVICE's. A brand declares its funnels
 * (`GET /internal/brands/:brandId/sales-funnels`), each funnel carrying the goal it optimizes for and
 * the economics that chain is priced on. features-service reads that declaration and ranks it. It is
 * NEVER supplied by the caller and it is NEVER inferred here — in particular a brand's single
 * `optimizationGoal` is ONE goal, not a set, and brand-service is explicit that the brand-wide
 * economics row cannot stand in for a declaration (every rate on it is NOT NULL with a server default,
 * so a brand that configured nothing still reads back plausible-looking numbers and no absence signals
 * anything).
 *
 * ── ONE ENTRY PER FUNNEL — funnels sharing a goal are NO LONGER MERGED ────────────────────────────
 *
 * This used to collapse `reply_meeting` and `visit_meeting` into a single `meetingBooked` entry whose
 * declared rates unioned, because the answer was ONE elected goal and a goal-grain answer cannot carry
 * two funnels. That is no longer the question. The customer now funds each funnel separately
 * (billing-service brand_funnel_budgets) and campaign-service works every funded funnel, so the answer
 * this service owes is "which FUNNEL returns best, and how do the others compare" — and a ranking that
 * merges two funnels into one row cannot answer "where should I move my budget?" for either of them.
 *
 * Nothing is lost by dropping the merge. A funnel that declares only its own leg (a reply→meeting rate,
 * say) is projected on the brand's EFFECTIVE economics for every rate it does not state — not on zero,
 * and not on half a funnel. And each funnel is now priced on its OWN lifetime revenue rather than the
 * lowest across the goal, which is the whole point of per-funnel economics: a brand selling a $200
 * self-serve plan and a $20k contract is ranked on each funnel's own revenue instead of one blend.
 *
 * A SHARED FIELD NAME IS NOT A SHARED MEANING. The two services' rate keys line up 1:1 except on the
 * meeting chain, where brand-service prices one more step than we model — see `meetingChainCloseRate`.
 * Copying that one across by name overstates the meeting funnel's return by the show-up rate.
 */

import type { SalesEconomics } from "./funnel-registry.js";
import { matchBrandServiceGoal, type Goal } from "./goals.js";
import type { DeclaredSalesFunnel } from "./sales-funnels-client.js";

/** Raised when a declared funnel names a goal features-service cannot map. Fails loud — a funnel the
 * brand declared must never be silently dropped from the ranking. */
export class UnknownFunnelGoalError extends Error {
  constructor(readonly raw: string) {
    super(`brand-service declared funnel goal "${raw}" is not a recognised optimization goal`);
    this.name = "UnknownFunnelGoalError";
  }
}

/** One declared funnel to rank: its identity, the goal it optimizes for, and its own declared terms. */
export interface RankableFunnel {
  /** brand-service's key for the funnel — the SAME key billing funds and campaign-service paces on. */
  funnelKey: string;
  /** The brand's own label for the funnel, echoed so the ranking reads as the customer named it. */
  name: string;
  goal: Goal;
  /**
   * This funnel's OWN declared economics, merged over the brand's effective economics when projecting
   * it. `null` when the brand declared no usable number for the funnel; the brand's effective economics
   * then apply unchanged (today's semantics, not a fabricated value). A rate the brand never declared
   * reads `null` upstream and is DROPPED here — never coerced to 0, which would zero-collapse a funnel.
   */
  economics: Partial<SalesEconomics> | null;
}

/**
 * The rates a declared funnel can carry that features-service's projection consumes UNCHANGED, i.e.
 * where the two services' identically-named fields also mean the same thing.
 *
 * `meetingToClosePct` and `meetingBookedToAttendedPct` are deliberately ABSENT — they are handled by
 * `meetingChainCloseRate` below, because on a declared FUNNEL the name means something else than it
 * does on the brand-wide economics row.
 */
const CONSUMED_RATE_KEYS = [
  "replyToMeetingPct",
  "visitToMeetingPct",
  "visitToSignupPct",
  "signupToPaidClientPct",
  "visitToFormSubmissionPct",
  "formSubmissionToPaidClientPct",
  "visitToClosePct",
  "visitToPaidClientPct",
  "replyToPaidClientPct",
] as const;

/**
 * Map ONE declared funnel to its canonical goal.
 *
 * Reads brand-service's WIRE `goal` first and only then `currentGoal`, because `currentGoal` is LOSSY
 * for this purpose: brand-service deliberately collapses `form_submissions` onto the `signup` runtime
 * token ("consumers never see a new value"), while features-service models form submissions as their
 * OWN goal with their own funnel (visit→form→paid). Reading the runtime token would price a Form Magnet
 * funnel on signup economics — a wrong answer that looks right.
 *
 * Both fields are BRAND-SERVICE PAYLOAD values, so they resolve through `matchBrandServiceGoal` — where
 * `sales` means WEBSITE PURCHASE and the combined goal arrives as `combined_sales` / `combinedSales`.
 * Never resolve a payload value with the request-param resolvers (see the `goals.ts` header).
 */
function goalOfFunnel(funnel: DeclaredSalesFunnel): Goal {
  // The payload fields FIRST, unchanged, so every brand-service that still sends
  // them resolves exactly as it does today. `goal` before `currentGoal` because
  // the runtime token is lossy here (it collapses form submissions onto signup,
  // which would price a Form Magnet on signup economics).
  const wire = typeof funnel.goal === "string" ? matchBrandServiceGoal(funnel.goal) : null;
  if (wire) return wire;
  const runtime = typeof funnel.currentGoal === "string" ? matchBrandServiceGoal(funnel.currentGoal) : null;
  if (runtime) return runtime;

  // Then the KEY, because brand-service is retiring the goal off this payload
  // entirely (brand-service#434) and this is what keeps the funnel resolving once
  // the fields are gone. Last rather than first on purpose: reading it first
  // would override a payload goal that disagrees with the key, which is a change
  // to how funnels are priced — not something to slip into a fix that stops a 502.
  const fromKey = goalOfFunnelKey(funnel.funnelKey);
  if (fromKey) return fromKey;

  throw new UnknownFunnelGoalError(funnel.goal ?? funnel.currentGoal ?? JSON.stringify(funnel));
}

/**
 * The goal each funnel chain optimizes for, by key — both the spellings
 * brand-service stores today and the ones it is renaming to.
 *
 * These are exactly the pairings brand-service's own catalogue used to send on
 * the payload, so resolving from the key reproduces today's answer rather than
 * changing how anything is priced. Deliberately NOT an improvement: both meeting
 * funnels still resolve to `meetingBooked` here, which is lossy in the way the
 * retirement exists to fix. Pricing them apart is a separate change with its own
 * evidence, not something to slip into a fix that stops a 502.
 *
 * Returns null for a key we do not know, so the payload fallback still gets its
 * turn and an unknown funnel still throws rather than being priced on a guess.
 */
function goalOfFunnelKey(funnelKey: string): Goal | null {
  switch (funnelKey) {
    case "reply_meeting":
    case "sales_meetings_from_conversation":
    case "visit_meeting":
    case "sales_meetings_from_website":
      return "meetingBooked";
    case "visit_signup":
    case "website_purchases":
      return "signup";
    case "visit_form":
    case "form_magnet":
      return "formSubmission";
    default:
      return null;
  }
}

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * `SalesEconomics.meetingToClosePct` for a declared meeting funnel — the SAME NAME on the two services
 * does NOT mean the same thing, and copying it across is a silent overstatement.
 *
 * Our projection multiplies `meetingToClosePct` by `visitToMeetingPct` / `replyToMeetingPct`, and both
 * of those produce a meeting BOOKED — so ours is BOOKED → paid. brand-service's meeting chains are
 * `… → Meeting booked → Meeting attended → Paid client` with `legs[i]` sitting between `steps[i]` and
 * `steps[i+1]`, so the funnel's `meetingToClosePct` is ATTENDED → paid and `meetingBookedToAttendedPct`
 * is the show-up rate in between. Reading the funnel's value as ours therefore asserts a 100% show-up
 * rate: a brand declaring 50% show-up and 40% attended→close would be scored at 40% booked→paid instead
 * of 20%, halving its cost per paid client and doubling the return the meeting funnel is ranked on —
 * enough to hand it a rank it should not have.
 *
 * So the two legs COMPOSE: `booked→paid = attended% × close%`. When the brand declared no show-up rate
 * we use the close rate alone — exactly the brand-wide semantics, whose economics row has no show-up
 * column at all — rather than discarding a number the brand did give us. This is the ONE place the
 * show-up rate is read; it never reaches `SalesEconomics` under its own name, which has no field for it.
 */
export function meetingChainCloseRate(rates: Record<string, number | null> | null | undefined): number | null {
  const close = finite(rates?.meetingToClosePct);
  if (close === null) return null;
  const showUp = finite(rates?.meetingBookedToAttendedPct);
  return showUp === null ? close : (close * showUp) / 100;
}

/** The declared numbers on one funnel, dropping every rate the brand never gave us. */
function declaredEconomics(funnel: DeclaredSalesFunnel): Partial<SalesEconomics> | null {
  const out: Record<string, number> = {};
  const rates = funnel.rates;
  if (rates && typeof rates === "object") {
    for (const key of CONSUMED_RATE_KEYS) {
      const value = rates[key];
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
  }
  const bookedToPaid = meetingChainCloseRate(rates);
  if (bookedToPaid !== null) out.meetingToClosePct = bookedToPaid;
  if (typeof funnel.lifetimeRevenueUsd === "number" && Number.isFinite(funnel.lifetimeRevenueUsd)) {
    out.lifetimeRevenueUsd = funnel.lifetimeRevenueUsd;
  }
  return Object.keys(out).length > 0 ? (out as Partial<SalesEconomics>) : null;
}

/**
 * Turn the funnels a brand declared into the set the ranking scores — ONE entry per funnel, in the
 * producer's order.
 *
 * `[]` in ⇒ `[]` out: the brand declared nothing, which the ranking reports as having nothing to rank.
 * Throws `UnknownFunnelGoalError` on a goal value that maps to nothing — dropping it would silently
 * rank a smaller set than the brand declared, and the customer would compare against a list missing one
 * of their own funnels.
 *
 * NOTHING HERE READS FUNDING. Whether a funnel currently has a daily ceiling is billing's data and
 * campaign-service's question at run time; it has no bearing on what that funnel HAS RETURNED, which is
 * the only thing being ranked. Ranking only the funded funnels would answer "where should I move my
 * budget?" with just the places the budget already is.
 */
export function declaredFunnelsToRank(funnels: DeclaredSalesFunnel[]): RankableFunnel[] {
  return funnels.map((funnel) => ({
    funnelKey: funnel.funnelKey,
    name: funnel.name,
    goal: goalOfFunnel(funnel),
    economics: declaredEconomics(funnel),
  }));
}
