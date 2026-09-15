/**
 * PER-FUNNEL COMMERCIAL TERMS — what a buyer commits to when they buy a SALES FUNNEL, before any
 * performance is measured.
 *
 * The channel catalogue already publishes the CHANNEL's commercial terms (daily operating cost,
 * minimum commitment in days, first-production promise) on `AcquisitionChannel.terms`. What was not
 * published anywhere is a commitment at the FUNNEL's own grain — and the dashboard's sell-first
 * onboarding renders a budget/payment screen PER SALES FUNNEL, so it needs one figure it can state
 * before checkout. This module owns it, for the same reason the channel terms live here: it is a
 * figure WE set, never measured, and a page that restates it is a page that can drift.
 *
 * ── ABSENT IS A FIRST-CLASS STATE ─────────────────────────────────────────────────────────────────
 *
 * `null` = NO commitment. That is the DEFAULT for most funnels today, and it is written out per
 * funnel rather than left to a missing key: a consumer that had to probe for a field would not be
 * able to tell "none" from "not stated". Never fabricate a value for a funnel that carries none —
 * a made-up commitment would be us inventing a promise nobody set.
 *
 * ── WHY HERE AND NOT ON THE CHANNEL ───────────────────────────────────────────────────────────────
 *
 * A funnel is bought through a channel, and the CHANNEL's own `minimumCommitmentDays` still stands —
 * a buyer is bound by BOTH (the stricter of the two governs the booking). This field says what the
 * FUNNEL itself carries beyond that. `sales_meetings_from_conversation` carries 30 days because a
 * conversation-bought funnel needs the sending infrastructure warmed and a real conversation window
 * to convert in; the click-driven funnels carry none today.
 */

import { SALES_FUNNEL_KEYS, type SalesFunnelKey } from "./sales-funnels.js";

/** Per-funnel minimum commitment, in whole days. `null` = none. One entry PER funnel — a missing key
 *  is a corrupt map, never a default. */
export const FUNNEL_MINIMUM_COMMITMENT_DAYS: Record<SalesFunnelKey, number | null> = {
  sales_meetings_from_conversation: 30,
  sales_meetings_from_website: null,
  website_purchases: null,
  form_magnet: null,
};

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** Fail loud at boot time of any read: a funnel missing from the map, or a fractional / non-positive
 *  commitment, is a corrupt term nobody set — never something to round into shape. */
for (const key of SALES_FUNNEL_KEYS) {
  const value = FUNNEL_MINIMUM_COMMITMENT_DAYS[key];
  if (!(value === null || isPositiveInt(value))) {
    throw new Error(`FUNNEL_MINIMUM_COMMITMENT_DAYS[${key}] is neither null nor a whole number of days > 0`);
  }
}

/** The funnel's minimum commitment in days, `null` = none. */
export function minimumCommitmentDaysFor(funnelKey: SalesFunnelKey): number | null {
  return FUNNEL_MINIMUM_COMMITMENT_DAYS[funnelKey];
}
