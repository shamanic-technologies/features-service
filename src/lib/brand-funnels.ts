/**
 * WHAT A BRAND SELLS THROUGH — the one question this service asks about a brand's configuration, and
 * the replacement for every read of its `optimizationGoal`.
 *
 * A brand no longer has a goal. It has the SALES FUNNELS it declared it sells through, and the answer
 * is a SET, not a single value. This module is the one place that resolves that set for the surfaces
 * which used to branch on the goal: the Overview spend columns, the staff customer-health board, and
 * the cross-org cost-per-outcome buckets.
 *
 * ── WHY THE GOAL HAD TO GO, not merely be renamed ─────────────────────────────────────────────────
 *
 * Two reasons, and the second is the one that made it urgent:
 *  1. It could not say what it was for. `sales_meetings_from_conversation` and
 *     `sales_meetings_from_website` both collapsed onto one `meetingBooked`, so a meeting bought with a
 *     positive REPLY and one bought with a CLICK were charged the same blended both-channel price.
 *  2. It was WRONG AT THE SOURCE. brand-service's `optimizationGoal` column is NOT NULL with a server
 *     default, so a brand that never chose one read back as selling through website purchases. Nobody
 *     stated that; a default did — and every surface that bucketed, benchmarked or priced on it
 *     inherited the fiction. The declared funnel set has no default behind it: it is either stated or
 *     absent, and absent is a producer gap we surface rather than fill.
 *
 * ── THE RULES ─────────────────────────────────────────────────────────────────────────────────────
 *
 * - **Never invent a funnel.** An unreadable or EMPTY declaration throws `SalesFunnelsUnavailableError`
 *   and each caller decides how loudly to surface it. There is no default funnel, and there must never
 *   be one — that is the exact failure mode being removed.
 * - **The org is part of the question.** A brand id is a shared global identity (every org claiming the
 *   same domain lands on the same row), so what it sells through is the data of an (org, brand) PAIR.
 *   `orgId` is a required argument, never resolved to a stand-in.
 * - **The OFFER is part of the question too, whenever the brand sells more than one.** A declared
 *   funnel hangs off an offer, each with its own rates and its own lifetime revenue, so brand-service
 *   refuses a brand-scoped read for a brand selling several rather than blending them. A caller that
 *   knows which proposition it is pricing names one; the SET question below composes across them,
 *   because a set composes where a rate does not.
 * - **A surface that can only carry ONE funnel takes the brand's FIRST DECLARED one in catalogue
 *   order.** That is a deterministic pick over the brand's OWN declarations — not a default, and not an
 *   inference: every candidate is a funnel the brand said it sells through. Any surface that can carry
 *   several (the ranking, and any caller passing an explicit `?funnel=`) prices each on its own funnel
 *   instead, which is always the better answer where the shape allows it.
 */

import { fetchDeclaredSalesFunnels, SeveralOffersError } from "./sales-funnels-client.js";
import { salesFunnelIndex, type SalesFunnelKey } from "./sales-funnels.js";

/**
 * The funnel keys an org declared it sells this brand through, in catalogue order.
 *
 * Throws `SalesFunnelsUnavailableError` when the declaration cannot be READ **or is empty** — the
 * producer's own rule is that "answered, but sells through nothing" does not exist (brand-service
 * refuses to switch off an org's last active funnel), so an empty list is a gap, never an answer.
 *
 * ── A BRAND SELLING SEVERAL OFFERS STILL HAS ONE ANSWER HERE, and that is why it is not a refusal ──
 *
 * brand-service refuses a brand-scoped read for a brand selling several offers, because the things it
 * would have to blend — the conversion RATES and the LIFETIME REVENUE — genuinely differ per offer and
 * there is no honest single value. This function asks a strictly narrower question: WHICH FUNNELS, as a
 * SET. A set composes where a rate does not, so the answer is the UNION of what each offer declares,
 * read from the offers the producer itself named on its 409. Nothing is averaged, nothing is picked on
 * the org's behalf, and no funnel appears that some offer did not declare.
 *
 * An offer whose own declaration cannot be read is LOGGED and left out of the union rather than taking
 * the whole brand down with it — one unanswerable offer must not erase the funnels its sibling did
 * state. With NO offer answering, the producer's refusal is re-thrown unchanged: at that point we know
 * nothing, which is exactly what the caller's own fail-loud path is for.
 */
export async function fetchDeclaredFunnelKeys(
  brandId: string,
  orgId: string,
  /** The ONE offer whose declaration is wanted. Omitted → the brand's whole set (see above). */
  offerId?: string | null,
): Promise<SalesFunnelKey[]> {
  const sortKeys = (keys: SalesFunnelKey[]): SalesFunnelKey[] =>
    [...new Set(keys)].sort((a, b) => salesFunnelIndex(a) - salesFunnelIndex(b));
  try {
    const declared = await fetchDeclaredSalesFunnels(brandId, orgId, offerId);
    return sortKeys(declared.map((f) => f.funnelKey));
  } catch (error) {
    // A caller that NAMED an offer asked a question the producer could answer; a 409 cannot occur, and
    // any other failure is the caller's own to surface.
    if (offerId || !(error instanceof SeveralOffersError)) throw error;
    const perOffer = await Promise.all(
      error.offers.map(async (offer) => {
        try {
          return (await fetchDeclaredSalesFunnels(brandId, orgId, offer.offerId)).map((f) => f.funnelKey);
        } catch (offerError) {
          console.warn(
            `[features-service] declared funnels unreadable for offer ${offer.offerId} of brand ${brandId} (left out of the brand's set, never substituted): ${(offerError as Error).message}`,
          );
          return null;
        }
      }),
    );
    const answered = perOffer.filter((keys): keys is SalesFunnelKey[] => keys !== null);
    if (answered.length === 0) throw error;
    return sortKeys(answered.flat());
  }
}

/**
 * The ONE funnel a single-valued surface prices on: the brand's first declared funnel in catalogue
 * order. Deterministic, so the same declaration always produces the same answer, and every candidate is
 * a funnel the brand itself declared. `null` for an empty set — a caller must never substitute one.
 */
export function primaryDeclaredFunnel(keys: readonly SalesFunnelKey[]): SalesFunnelKey | null {
  if (keys.length === 0) return null;
  return [...keys].sort((a, b) => salesFunnelIndex(a) - salesFunnelIndex(b))[0]!;
}
