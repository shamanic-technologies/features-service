/**
 * THE SALES FUNNEL IS THE VOCABULARY — features-service's mirror of brand-service's deployed catalogue.
 *
 * A funnel is ONE funnel, from the first signal outreach can buy (a positive reply, or a click onto the
 * brand's site) down to a paying client. brand-service OWNS the catalogue; everything here CONFORMS to
 * what it deploys (`GET /internal/brands/:brandId/sales-funnels`, `src/services/salesFunnelCatalogue.ts`
 * in `shamanic-technologies/brand-service`) and nothing here is authored by features-service.
 *
 * ── WHY THE GOAL WENT AWAY ────────────────────────────────────────────────────────────────────────
 *
 * A funnel used to carry a `goal` beside its key, and the goal was strictly the poorer word: a meeting
 * won from a positive REPLY and a meeting won from a click onto the brand's WEBSITE both collapsed onto
 * one `meetingBooked`, so this service could not price them apart. It charged both against the SAME
 * both-channel blend — which benchmarks a reply-driven brand against clicks it never buys. brand-service
 * retired the goal from every funnel read (#434) and backfilled every brand onto the keys below.
 *
 * The two meeting funnels differ in EXACTLY one thing — which channel buys the meeting — and that is the
 * whole reason they must be priced apart, so it is the whole content of `meetingChannel` here.
 *
 * ── TRANSITION TOLERANCE ──────────────────────────────────────────────────────────────────────────
 *
 * `matchSalesFunnelKey` accepts every canonical key AND the four pre-retirement spellings
 * (`reply_meeting`, `visit_meeting`, `visit_signup`, `visit_form`) forever, plus separator/case variance
 * — the same input tolerance brand-service keeps on write. Nothing here EMITS a legacy spelling.
 *
 * The `goal` request params (`?goal=`, `?objective=`, `?lens=`) are NOT touched by any of this: a
 * consumer that still asks for a goal gets byte-identically the answer it got before, through
 * `goalToProjectionInputs`. A goal is a coarser question, and it keeps its coarser answer.
 */

/**
 * The funnels a brand can sell through. Wire values, owner-locked, byte-equal with brand-service's
 * `SALES_FUNNEL_KEYS` and with the dashboard's own `apps/dashboard/src/lib/sales-funnels.ts`.
 *
 * The first four are the original catalogue, written while cold email was the only channel we ran:
 * every journey began either in a conversation we started or on the brand's own website. The last four
 * describe journeys those could not, and they exist because roughly thirty acquisition channels are
 * opening. They are ADDED, never renamed over the first four — live brands, live budgets and the cost
 * ledger reference those tokens.
 *
 * A KEY IS NEVER RENAMED, A NAME IS. `website_purchases` reads "Signups" and the mismatch is
 * deliberate: the key is a wire token nobody renders, and that funnel's middle rung is a SIGNUP, so
 * "Website Purchase" named the wrong thing. That name belongs to `sales_from_website`, the funnel that
 * really does go visit -> purchase.
 */
export const SALES_FUNNEL_KEYS = [
  "sales_meetings_from_conversation",
  "sales_meetings_from_website",
  "website_purchases",
  "form_magnet",
  "sales_from_conversation",
  "sales_meetings_from_ads",
  "lead_forms_from_ads",
  "sales_from_website",
] as const;

export type SalesFunnelKey = (typeof SALES_FUNNEL_KEYS)[number];

/**
 * Every pre-retirement funnel spelling, resolved to its canonical key. Accepted FOREVER on the way IN
 * (a caller sending yesterday's word keeps working), never emitted on the way out.
 */
const LEGACY_SALES_FUNNEL_KEYS: Record<string, SalesFunnelKey> = {
  reply_meeting: "sales_meetings_from_conversation",
  visit_meeting: "sales_meetings_from_website",
  visit_signup: "website_purchases",
  visit_form: "form_magnet",
};

/** Which engagement channel a funnel's funnel buys its first signal through, when that is the ONE thing
 * distinguishing two otherwise-identical funnels. Only the two meeting funnels carry it. */
export type MeetingChannel = "click" | "reply";

/**
 * Which counted signal a cost surface may price a funnel's ENTRY step with.
 *
 *  - `"click"` / `"reply"` — that channel alone funds the funnel, and the other one is masked away so
 *    it cannot dilute the price.
 *  - `null` — do not mask. The goal path (which names no funnel) and the click-driven funnels whose own
 *    math already names their channel.
 *  - `"none"` — NEITHER. The funnel's first step is DELIVERED by the channel itself (a meeting booked
 *    inside an ad, a lead form filled inside an ad) and no signal this fleet counts observes it, so
 *    nothing may price it: both unit costs are masked away and every cost surface states "we do not
 *    measure this step" rather than funnelling an ad-delivered step through click or reply evidence it
 *    never buys.
 */
export type PricingChannel = MeetingChannel | "none" | null;

export interface SalesFunnelDef {
  key: SalesFunnelKey;
  /** brand-service's own label for the funnel, used when the producer serves no name. */
  name: string;
  /** The funnel, in order — brand-service's `steps`, mirrored for readability of the mapping below. */
  steps: readonly string[];
  /**
   * The channel THIS funnel buys through, when the funnel's identity depends on it. `null` means the
   * funnel's own math already names its channel (a signup / form funnel is click-driven by construction).
   * `"none"` means neither channel buys it — see `PricingChannel`.
   */
  meetingChannel: PricingChannel;
}

export const SALES_FUNNELS: Record<SalesFunnelKey, SalesFunnelDef> = {
  sales_meetings_from_conversation: {
    key: "sales_meetings_from_conversation",
    // brand-service's own name. "Conversation" is banned from every customer-facing name in the fleet,
    // and what the funnel actually starts from is a positive reply.
    name: "Sales Meeting from Positive Reply",
    steps: ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"],
    // The meeting is bought with a positive REPLY. Its cost is replyUsd / replyToMeetingPct — the click
    // channel does not fund it, and must not dilute it.
    meetingChannel: "reply",
  },
  sales_meetings_from_website: {
    key: "sales_meetings_from_website",
    name: "Sales Meeting from Website",
    steps: ["Website visit", "Meeting booked", "Meeting attended", "Paid client"],
    // Same terminal outcome, bought with a CLICK: clickUsd / visitToMeetingPct.
    meetingChannel: "click",
  },
  website_purchases: {
    key: "website_purchases",
    // KEY/NAME MISMATCH ON PURPOSE, mirrored from brand-service: the key is frozen (live declarations
    // reference it) while the name is what a customer reads, and this funnel's middle rung is a SIGNUP.
    // "Website Purchase" now names `sales_from_website`, which really does go visit -> purchase.
    name: "Signups",
    steps: ["Website visit", "Signup", "Paid client"],
    meetingChannel: null,
  },
  form_magnet: {
    key: "form_magnet",
    name: "Form Magnet",
    // ONE form step across the whole catalogue (see `CHANNEL_STEPS.form_submitted`). brand-service's
    // deployed catalogue still spells this rung "Form filled"; its wording stays resolvable on the way
    // IN, so a rate a brand stated on a "Form filled" arrow is not lost. Only what we publish moved.
    steps: ["Website visit", "Form submitted", "Paid client"],
    meetingChannel: null,
  },
  sales_from_conversation: {
    key: "sales_from_conversation",
    name: "Sale from Positive Reply",
    steps: ["Positive reply", "Paid client"],
    // The sale closes INSIDE the conversation — no meeting is ever booked — so the reply is the only
    // thing that funds it and a click must not dilute the price.
    meetingChannel: "reply",
  },
  sales_meetings_from_ads: {
    key: "sales_meetings_from_ads",
    name: "Sales Meeting from Ads",
    steps: ["Meeting booked", "Meeting attended", "Paid client"],
    // The ad DELIVERS the booked meeting; the click that produced it is not a step anybody buys, and
    // neither a counted click nor a counted reply observes it. So nothing here may be priced off the
    // two signals this fleet counts.
    meetingChannel: "none",
  },
  lead_forms_from_ads: {
    key: "lead_forms_from_ads",
    name: "Lead Form from Ads",
    steps: ["Form submitted", "Paid client"],
    // Same as the ad meeting funnel: the form is filled inside the ad unit, so the step is delivered
    // rather than observed.
    meetingChannel: "none",
  },
  sales_from_website: {
    key: "sales_from_website",
    name: "Website Purchase",
    steps: ["Website visit", "Paid client"],
    // The buyer lands and PAYS, with nothing in between. Click-driven by construction, like the two
    // other website funnels, so its own math names its channel.
    meetingChannel: null,
  },
};

const isSalesFunnelKey = (value: string): value is SalesFunnelKey =>
  (SALES_FUNNEL_KEYS as readonly string[]).includes(value);

/**
 * Resolve any spelling a caller or the producer may send to its canonical key — every canonical one, the
 * four pre-retirement ones, and separator/case variance on either (`Reply Meeting`, `form-magnet`).
 * Returns `null` for a word that names no funnel; every caller FAILS LOUD on that rather than guessing
 * a funnel, because guessing one would price a brand on a funnel it never said it sells through.
 */
export function matchSalesFunnelKey(raw: string): SalesFunnelKey | null {
  const normalised = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (isSalesFunnelKey(normalised)) return normalised;
  return LEGACY_SALES_FUNNEL_KEYS[normalised] ?? null;
}

/** Stable order for tie-breaking a ranking, so the same evidence always produces the same list. */
export const salesFunnelIndex = (key: SalesFunnelKey): number => SALES_FUNNEL_KEYS.indexOf(key);

/**
 * The GOAL a funnel ECHOES, derived FROM the funnel key — never the reverse.
 *
 * A goal is the poorer word and it is retired as an INPUT: both meeting funnels echo `meetingBooked`,
 * so the echo is lossy by construction and can never be read back as a funnel's identity. It exists
 * only so the fields consumers still read (`arbitration.goal`, `rows[].workflow`, the projection's
 * `goal` / `objective` echoes, the conversion columns a funnel terminates in) keep resolving while the
 * fleet migrates to the funnel key.
 *
 * `website_purchases` echoes `signup`, NOT `websitePurchase`: its funnel is visit → signup → paid, and
 * the `websitePurchase` goal is the full self-serve-plus-meeting close funnel, whose rates are not this
 * funnel's. That is the same routing `funnelToProjectionInputs` applies.
 *
 * ⚠️ DO NOT add the inverse map. A goal→funnel table would be exactly the compatibility layer this
 * retirement exists to avoid, and it could not be written honestly anyway (one `meetingBooked` maps to
 * two funnels bought through two different channels).
 */
export const SALES_FUNNEL_GOAL_ECHO: Record<
  SalesFunnelKey,
  "meetingBooked" | "signup" | "formSubmission" | "positiveReply" | "websiteVisit"
> = {
  sales_meetings_from_conversation: "meetingBooked",
  sales_meetings_from_website: "meetingBooked",
  website_purchases: "signup",
  form_magnet: "formSubmission",
  // A sale closed straight out of a positive reply, and one closed straight off a website visit, are
  // exactly the two SINGLE-STEP goals this service already prices (`replyUsd / replyToPaidClientPct`
  // and `clickUsd / visitToPaidClientPct`), so they echo those rather than a new word.
  sales_from_conversation: "positiveReply",
  sales_from_website: "websiteVisit",
  // Lossy, like every other echo here: an ad-delivered meeting and a reply-bought one both echo
  // `meetingBooked`, and an ad lead form echoes the nearest form word the goal vocabulary has.
  sales_meetings_from_ads: "meetingBooked",
  lead_forms_from_ads: "formSubmission",
};
