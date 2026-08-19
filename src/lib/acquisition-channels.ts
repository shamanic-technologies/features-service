/**
 * AN ACQUISITION CHANNEL IS A FEATURE SLUG, AND IT STATES ITS COMMERCIAL TERMS + WHAT IT CAN PRODUCE.
 *
 * distribute sells reach through more than one channel, and a channel in this fleet's vocabulary IS a
 * feature slug — there is no channel table, no channel concept and none may be introduced. What this
 * module adds to a feature is the two things a BUYER needs before booking one, and neither of them is a
 * measured figure:
 *
 *  1. **COMMERCIAL TERMS** — what it costs us to operate the channel for a day whatever the volume (a
 *     phone channel needs a human on the line; an ad platform imposes its own daily floor; a channel run
 *     by a specialist carries that salary), the minimum commitment in days, and an UPPER BOUND on how
 *     long after booking it starts producing. We SET these; nothing measures them.
 *  2. **WHAT IT CAN PRODUCE** — the kinds of step the channel is capable of producing. A sales funnel
 *     states what step STARTS it (brand-service owns that), so a consumer joins the two to decide which
 *     (funnel, channel) pairings are even possible.
 *
 * ── NO "COMING SOON" ──────────────────────────────────────────────────────────────────────────────
 *
 * Every published channel is bookable. A channel we are slower to deliver says so through its OWN
 * commercial terms — a high daily operating cost, a long `maxDaysToFirstProduction` — never through a
 * flag that hides it from the catalogue. There is deliberately no `available` / `comingSoon` boolean
 * here, and adding one would be the thing this design exists to prevent.
 *
 * ── VOCABULARY (owner-fixed, the fleet is migrating to it) ─────────────────────────────────────────
 *
 * The terminal thing a customer buys is a **SALE**. Each intermediate stage of a funnel is a **STEP**.
 * The step a funnel is named after is its **MILESTONE**. The word "outcome" is deprecated — it used to
 * name a retired per-brand optimization goal — so nothing new here uses it.
 */

import { SALES_FUNNELS, SALES_FUNNEL_KEYS, type SalesFunnelKey } from "./sales-funnels.js";

// ── What a channel can PRODUCE ──────────────────────────────────────────────────────────────────────

/**
 * The kinds of step an acquisition channel can produce. Four are in play, and they are the four things
 * a sales funnel can be STARTED by.
 *
 * Two of them (`in_ad_form_submission`, `in_ad_booked_meeting`) are produced INSIDE THE AD UNIT rather
 * than on the brand's own site, and no funnel in the deployed catalogue starts from
 * either one YET — brand-service ships those chains in parallel. A channel that produces only those
 * therefore sells through nothing TODAY and starts selling the moment the mirror below gains the chain,
 * with no further change here. That is why they are stated now rather than when the funnel lands: what
 * a channel can produce is a fact about the channel, not about what we happen to sell through it.
 *
 * ── WHY THE `in_ad_` PREFIX, AND WHY NEITHER SHORTER NAME WORKS ───────────────────────────────────
 *
 * The prefix is LOAD-BEARING and must not be dropped. "Form filled" and "Meeting booked" ALREADY exist
 * in the deployed funnel catalogue as INTERMEDIATE steps (`form_magnet` step 2, both meeting chains'
 * milestone), reached through a click or a reply onto the brand's own site. What an ad produces is an
 * ENTRY step reached without ever getting there. Naming ours `form_submission` / `booked_meeting` would
 * invite a consumer to read a channel producing one as able to START `form_magnet` — which it cannot,
 * since that chain starts with a website visit. That is the exact nonsense pairing the join prevents.
 *
 * `platform_` was the first spelling and is WRONG here: `platform` is this fleet's word for OUR OWN
 * platform (platform runs, `/internal/platform-complete`, platform prices, `PLATFORM_SCOPE_ORG_ID`), so
 * it reads as "a form filled on distribute.you". `ad_` alone is no better — `ad_form_submission` reads
 * as "a form submission ATTRIBUTED to an ad", i.e. one filled on the brand's site after the click,
 * which is the very reading the prefix exists to block. `in_ad_` says the literal thing: it happened
 * inside the ad unit. Do not shorten it back.
 *
 */
export const PRODUCIBLE_STEP_KEYS = [
  "conversation",
  "website_visit",
  "in_ad_form_submission",
  "in_ad_booked_meeting",
] as const;

export type ProducibleStepKey = (typeof PRODUCIBLE_STEP_KEYS)[number];

export interface ProducibleStepDef {
  key: ProducibleStepKey;
  /** Buyer-facing label. */
  label: string;
  /** What the step actually is, in the buyer's terms. */
  description: string;
}

export const PRODUCIBLE_STEPS: Record<ProducibleStepKey, ProducibleStepDef> = {
  conversation: {
    key: "conversation",
    label: "Conversation",
    description: "A buyer answers and a conversation opens, on whatever medium the channel runs on.",
  },
  website_visit: {
    key: "website_visit",
    label: "Website visit",
    description: "A buyer lands on the brand's own website.",
  },
  in_ad_form_submission: {
    key: "in_ad_form_submission",
    label: "Form filled in the ad",
    description: "A buyer fills a form inside the ad itself, without ever reaching the brand's site.",
  },
  in_ad_booked_meeting: {
    key: "in_ad_booked_meeting",
    label: "Meeting booked from an ad",
    description: "A buyer books a meeting straight from the ad, without ever reaching the brand's site.",
  },
};

const isProducibleStepKey = (value: string): value is ProducibleStepKey =>
  (PRODUCIBLE_STEP_KEYS as readonly string[]).includes(value);

export function matchProducibleStepKey(raw: string): ProducibleStepKey | null {
  const normalised = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return isProducibleStepKey(normalised) ? normalised : null;
}

// ── What STARTS a funnel ────────────────────────────────────────────────────────────────────────────

/**
 * The step that STARTS each declared sales funnel — mirrored from brand-service's catalogue exactly as
 * `SALES_FUNNELS[key].steps` is, and never authored here. `funnelEntryStepGuard` below pins each entry
 * against that chain's own first step, so the mirror cannot drift from the chain it claims to describe.
 *
 * A funnel STARTED by a step is sellable through every channel that can PRODUCE that step. That join is
 * the whole model: possibility is not a second list somebody maintains, it falls out of the two facts.
 */
export const SALES_FUNNEL_ENTRY_STEP: Record<SalesFunnelKey, ProducibleStepKey> = {
  sales_meetings_from_conversation: "conversation",
  sales_meetings_from_website: "website_visit",
  website_purchases: "website_visit",
  form_magnet: "website_visit",
};

/** The first step of each chain, as brand-service words it — the thing `SALES_FUNNEL_ENTRY_STEP` is a
 *  reading of. Guarded in `acquisition-channels.test.ts`; a chain whose wording changes fails there
 *  rather than silently re-pointing a channel at a funnel it cannot start. */
export const FUNNEL_ENTRY_STEP_LABEL: Record<ProducibleStepKey, readonly string[]> = {
  conversation: ["Positive reply"],
  website_visit: ["Website visit"],
  in_ad_form_submission: [],
  in_ad_booked_meeting: [],
};

/**
 * The sales funnels a channel producing `steps` may be SOLD THROUGH — every declared chain whose entry
 * step the channel can produce, in the catalogue's canonical order so the same channel always reads the
 * same list. An empty result is a real statement ("sells through none of the declared chains"), not a
 * gap: it happens exactly when the channel produces nothing any deployed chain starts from.
 */
export function sellableFunnelsFor(steps: readonly ProducibleStepKey[]): SalesFunnelKey[] {
  const producible = new Set(steps);
  return SALES_FUNNEL_KEYS.filter((key) => producible.has(SALES_FUNNEL_ENTRY_STEP[key]));
}

// ── Commercial terms ────────────────────────────────────────────────────────────────────────────────

/**
 * What a buyer is committing to, before any performance is measured. Every figure is one WE set; none
 * of them is derived from spend or from a funnel.
 */
export interface ChannelCommercialTerms {
  /**
   * What operating this channel costs for a day REGARDLESS of volume, in whole cents (money is never a
   * float here). A phone channel carries the person on the line; an ad platform carries its own daily
   * floor; a channel run by a specialist carries that salary. Zero is a legitimate value and means the
   * channel costs nothing to keep open on a day it sends nothing.
   */
  dailyOperatingCostCents: number;
  /** The shortest booking we sell, in days. */
  minimumCommitmentDays: number;
  /**
   * The UPPER BOUND on how many days after booking the channel starts producing — a promise, not an
   * estimate. This is where a channel we are slower to deliver says so; there is no other place for it.
   */
  maxDaysToFirstProduction: number;
}

/** How a channel reaches people. Descriptive grouping for the catalogue; nothing prices off it. */
export const CHANNEL_FAMILIES = ["outbound_one_to_one", "paid_reach", "earned"] as const;
export type ChannelFamily = (typeof CHANNEL_FAMILIES)[number];

/** The whole acquisition-channel statement carried by a feature. `null` on a feature says, out loud,
 *  that the feature is not an acquisition channel (hiring, investor and accelerator outreach, the
 *  internal discovery and page-generation tools) — never that nobody got round to filling it in. */
export interface AcquisitionChannel {
  family: ChannelFamily;
  producibleSteps: readonly ProducibleStepKey[];
  terms: ChannelCommercialTerms;
}

/**
 * The chain a funnel prices through, expressed as its steps with the MILESTONE named. Used by the public
 * per-pair economics read so a consumer never has to know the catalogue to render a row.
 */
export function funnelSteps(key: SalesFunnelKey): readonly string[] {
  return SALES_FUNNELS[key].steps;
}
