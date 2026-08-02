/**
 * The sales funnels a brand DECLARED it sells through, prepared for ranking.
 *
 * OWNERSHIP: the declared set is BRAND-SERVICE's. A brand declares its funnels
 * (`GET /internal/brands/:brandId/sales-funnels`), each funnel carrying the economics that chain is
 * priced on. features-service reads that declaration and ranks it. It is NEVER supplied by the caller
 * and it is NEVER inferred here — in particular a brand's single `optimizationGoal` is ONE goal, not a
 * set, and brand-service is explicit that the brand-wide economics row cannot stand in for a
 * declaration (every rate on it is NOT NULL with a server default, so a brand that configured nothing
 * still reads back plausible-looking numbers and no absence signals anything).
 *
 * ── THE FUNNEL KEY IS THE WHOLE VOCABULARY — no funnel carries a goal any more ─────────────────────
 *
 * A funnel used to arrive with a `goal` beside its key and this module resolved it. brand-service
 * retired that field (#434) because it was the poorer word: `sales_meetings_from_conversation` and
 * `sales_meetings_from_website` both mapped onto one `meetingBooked`, so this service priced a meeting
 * won from a REPLY and one won on the WEBSITE identically — it charged a reply-driven brand against
 * clicks it never buys. The key now drives the pricing directly (`funnelToProjectionInputs`), so the two
 * chains are priced on their own channel and finally read apart. A goal ECHO is derived FROM the key for
 * the consumers that still read one; nothing derives a price from a goal on this path.
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
import type { DeclaredSalesFunnel, SalesFunnelKey } from "./sales-funnels-client.js";

/** One declared funnel to rank: its identity and its own declared terms.
 *
 * NO `goal`. The funnel key IS what this is priced on — that is the whole retirement: two funnels that
 * shared the `meetingBooked` goal are two different chains bought through two different channels, and a
 * goal-keyed entry could only give them one price. The goal ECHO a consumer still reads is derived from
 * the key downstream (`funnelToProjectionInputs`), never carried here as an input. */
export interface RankableFunnel {
  /** brand-service's key for the funnel — the SAME key billing funds and campaign-service paces on. */
  funnelKey: SalesFunnelKey;
  /** The brand's own label for the funnel, echoed so the ranking reads as the customer named it. */
  name: string;
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
 * An unrecognised funnel key already failed loud at the client (`UnknownSalesFunnelError`) — dropping
 * one would silently rank a smaller set than the brand declared, and the customer would compare against
 * a list missing one of their own funnels.
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
    economics: declaredEconomics(funnel),
  }));
}

/**
 * The declared economics of ONE funnel, for a read that names it (`?funnel=`).
 *
 * WHY THIS EXISTS: the ranking already prices each funnel on its OWN declared terms — that is the whole
 * point of per-funnel economics. A read that asks for the same funnel must do the same, or the two
 * surfaces print different prices for one brand + one funnel + one moment. Prod caught exactly that on
 * `b97440f6…`: the brand declares `replyToMeetingPct: 100` on its conversation funnel, so the ranking
 * said $73.74 per meeting while `?funnel=` — projecting on the brand-wide effective set, where the rate
 * is ~31% — said $237.87. Same funnel, same evidence, two numbers.
 *
 * Returns `null` when the brand declared no usable number for the funnel: the brand's effective
 * economics then apply unchanged, which is the correct answer and not a fabricated one.
 * Throws `UnknownSalesFunnelError` upstream via the client if the producer serves a key we cannot map.
 */
export function declaredEconomicsForFunnel(
  funnels: DeclaredSalesFunnel[],
  funnelKey: SalesFunnelKey,
): Partial<SalesEconomics> | null {
  const match = declaredFunnelsToRank(funnels).find((f) => f.funnelKey === funnelKey);
  return match?.economics ?? null;
}

/**
 * Merge a funnel's declared terms OVER a brand's effective economics — the SAME merge the ranking does
 * (`mergeEconomics` in goal-arbitration.ts): only stated fields win, and a rate the brand never declared
 * is absent here rather than 0, so it falls through to the effective value instead of zero-collapsing
 * the chain.
 */
export function mergeFunnelEconomics<T extends SalesEconomics>(
  base: T | null,
  override: Partial<SalesEconomics> | null,
): T | null {
  if (!base) return null;
  if (!override) return base;
  return { ...base, ...override };
}
