/**
 * PER-FUNNEL COMMERCIAL TERMS — how long a buyer runs a SALES FUNNEL before the result is judgeable,
 * and how that composes with the same figure on the CHANNEL they buy it through.
 *
 * ── WHAT `minimumCommitmentDays` MEANS, AND WHAT IT DOES NOT ─────────────────────────────────────
 *
 * It is a MINIMUM RUN LENGTH, not a lock-in. Nothing here binds anyone: the product has no contract
 * period and no cancellation penalty, and the ONLY thing a buyer commits to is the channel's
 * `terms.dailyOperatingCostCents` — which is already published beside it. So a channel stating 90 days
 * is saying "SEO takes three months to show you anything", not "you owe us three months". Nothing
 * ENFORCES this figure anywhere in the fleet, and that is correct rather than a gap: there is no
 * lock-in to enforce. It is an informative term the payment screen states so a buyer knows what they
 * are signing up to read, and a consumer that renders it as a contractual commitment is misreading it.
 *
 * ── ONE NUMBER BINDS, AND WE SERVE IT ────────────────────────────────────────────────────────────
 *
 * A funnel is bought THROUGH a channel, so two figures are in play — the channel's own
 * `terms.minimumCommitmentDays` and, when a funnel legitimately needs longer than the channel it is
 * sold through, this one. The figure that answers "how long before I can judge this" is the LONGER of
 * the two, so that is what is published (`effectiveMinimumCommitmentDays`) alongside which side it came
 * from (`governedBy`). **Do NOT publish the two halves and leave the consumer to `max()` them** — a
 * browser dividing or combining two of our fields is how two surfaces come to print two numbers for
 * one statistic, which is the same reason `costOfAcquisitionPct` is served beside the return it is the
 * reciprocal of rather than derived downstream.
 *
 * ── ABSENT IS A FIRST-CLASS STATE ────────────────────────────────────────────────────────────────
 *
 * `null` = this funnel adds NOTHING to its channel: whatever the channel says is the answer. That is
 * the state of every funnel today, and it is written out per funnel rather than left to a missing key
 * — a consumer probing for a field cannot tell "adds nothing" from "not stated". Never fabricate a
 * value: a funnel carrying a figure equal to (or below) its channel's is a number that can never
 * govern, i.e. a term that reads as a decision and changes nothing. If a funnel genuinely needs longer
 * than its channel, state THAT — a value only earns its place by exceeding the channel it is read
 * under.
 */

import { SALES_FUNNEL_KEYS, type SalesFunnelKey } from "./sales-funnels.js";

/** Per-funnel minimum run length, in whole days, BEYOND what its channel already states. `null` = this
 *  funnel adds nothing. One entry PER funnel — a missing key is a corrupt map, never a default.
 *
 *  Every funnel is `null` today, measured rather than assumed: the shortest channel in the catalogue
 *  states 30 days and `sales_meetings_from_conversation` — the one a conversation-bought funnel would
 *  need longest for — is judgeable in 30. So no funnel exceeds the channel it is sold through, and
 *  stating a figure equal to the channel's would publish a term that can never govern. */
export const FUNNEL_MINIMUM_COMMITMENT_DAYS: Record<SalesFunnelKey, number | null> = {
  sales_meetings_from_conversation: null,
  sales_meetings_from_website: null,
  website_purchases: null,
  form_magnet: null,
};

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** Fail loud at boot time of any read: a funnel missing from the map, or a fractional / non-positive
 *  run length, is a corrupt term nobody set — never something to round into shape. */
for (const key of SALES_FUNNEL_KEYS) {
  const value = FUNNEL_MINIMUM_COMMITMENT_DAYS[key];
  if (!(value === null || isPositiveInt(value))) {
    throw new Error(`FUNNEL_MINIMUM_COMMITMENT_DAYS[${key}] is neither null nor a whole number of days > 0`);
  }
}

/** The funnel's own minimum run length in days, `null` = it adds nothing to its channel. */
export function minimumCommitmentDaysFor(funnelKey: SalesFunnelKey): number | null {
  return FUNNEL_MINIMUM_COMMITMENT_DAYS[funnelKey];
}

/** Which side of the pair the published figure came from. `"channel"` also covers the tie: a funnel
 *  stating exactly what its channel states adds nothing, so the channel is what answers. */
export type MinimumCommitmentGovernor = "channel" | "funnel";

export interface ComposedMinimumCommitment {
  /** The funnel's own figure, `null` = it adds nothing. Published so a reader can see WHY the
   *  effective figure is what it is, never so a consumer can recombine it. */
  funnelMinimumCommitmentDays: number | null;
  /** The figure that actually answers "how long before this is judgeable" — the longer of the two.
   *  NEVER null: a channel always states one, so a pair always has an answer. */
  effectiveMinimumCommitmentDays: number;
  /** Which side produced it. A consumer renders the effective figure; this says where it came from. */
  governedBy: MinimumCommitmentGovernor;
}

/**
 * Compose the pair's answer from the channel's figure and the funnel's own.
 *
 * The funnel governs ONLY when it states strictly more than the channel — anything else means the
 * channel already covers it. Resolved HERE, once, so `/public/channels` and
 * `/public/channel-funnel-economics` cannot come to publish two answers for one pair.
 */
export function composeMinimumCommitment(
  channelMinimumCommitmentDays: number,
  funnelMinimumCommitmentDays: number | null,
): ComposedMinimumCommitment {
  const funnelGoverns = funnelMinimumCommitmentDays != null && funnelMinimumCommitmentDays > channelMinimumCommitmentDays;
  return {
    funnelMinimumCommitmentDays,
    effectiveMinimumCommitmentDays: funnelGoverns ? funnelMinimumCommitmentDays : channelMinimumCommitmentDays,
    governedBy: funnelGoverns ? "funnel" : "channel",
  };
}
