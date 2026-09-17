/**
 * AN ACQUISITION CHANNEL IS A FEATURE SLUG, AND IT STATES ITS COMMERCIAL TERMS + WHICH STEP OF A FUNNEL
 * IT MOVES A LEAD FROM AND TO.
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
 *  2. **WHICH STEP IT MOVES A LEAD FROM, AND WHICH STEP IT MOVES IT TO** — its `stepTransitions`. A
 *     sales funnel is a funnel of steps, so a channel is sellable through a funnel when it can perform
 *     one of that funnel's LEGS.
 *
 * ── A FUNNEL IS SOLD LEG BY LEG, AND "FROM NOTHING" IS THE SPECIAL CASE ────────────────────────────
 *
 * Every channel that shipped before this one stated only what it could PRODUCE — a conversation, a
 * website visit — which is to say it moved a lead from NOTHING to the step a funnel starts from. That
 * reads as the whole model only because it was the only kind of channel in the catalogue. It is not:
 * a four-step funnel has three more legs after its entry, every one of them a thing somebody does, and
 * each is sellable on its own terms with its own daily budget and its own stats.
 *
 * So a transition is `{ from, to }` and `from: null` means "from nothing" — the lead did not exist on
 * this funnel until this channel produced it. That is the SPECIAL CASE, written as the special case,
 * rather than the shape everything else has to be bent into.
 *
 * ── THE JOIN IS STILL DERIVED, IT JUST WORKS ON EVERY LEG NOW ─────────────────────────────────────
 *
 * Which (funnel, channel) pairs are sellable still falls out of two facts joined — it is never a second
 * list somebody maintains. What changed is the join's grain: it used to compare a channel's produced
 * steps against each funnel's ENTRY step, and it now compares a channel's transitions against each
 * funnel's LEGS, of which the entry is simply the first. Every channel published before this reads the
 * identical list of funnels, because a leg `{ from: null, to: <the funnel's first step> }` matches
 * exactly the funnels whose entry step it produced.
 *
 * ── WHO OPERATES IT, AND WHY A ZERO DAILY COST IS NOT A HOLE ──────────────────────────────────────
 *
 * A leg can be performed by our SOFTWARE (the AI answers the prospect in minutes), by US BY HAND (a
 * specialist we put on it), or by the CUSTOMER (their own founder, their own team). The channel's NAME
 * is what says which — a buyer picks between them, so it cannot be a field they have to look up.
 *
 * A ZERO DAILY OPERATING COST DOES NOT MEAN THE CUSTOMER RUNS IT, and reading it that way is the one
 * mistake this paragraph exists to prevent. It means only that no standing DAY of work is charged for
 * this channel. That is true of every customer-run channel (we put nobody on it), and it is equally
 * true of a channel we run where the owner has priced the day at zero. What a run actually costs is
 * metered elsewhere: an automated leg declares its API spend per run against runs-service, and what a
 * customer-run leg costs THEM is stated per lead against lead-service. `operatedBy` is what says who is
 * on it; the zero says only what the day-rate is, and inventing a flat daily figure to make the
 * catalogue look uniform would be fabricating a price nobody set.
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

// ── The steps a channel can move a lead between ─────────────────────────────────────────────────────

/**
 * Every step a channel can move a lead FROM or TO. EVERY one of them is a step of a deployed funnel —
 * the vocabulary is the union of every step in brand-service's catalogue, not the subset that happens
 * to come first, because a channel performing an internal leg has to name the step it moves a lead OUT
 * of and those are steps a funnel reaches rather than starts from.
 *
 * ── THE `in_ad_` PREFIX IS GONE, BECAUSE THE FUNNELS IT GUARDED AGAINST NOW EXIST ────────────────
 *
 * Two keys used to be spelled `in_ad_form_submission` and `in_ad_booked_meeting`. The prefix existed
 * for one reason: no funnel in the catalogue started on what an ad delivers, so naming those steps
 * after the funnel steps they resemble ("Form filled", "Meeting booked") would have read as a claim
 * they could START `form_magnet` or a meeting funnel, which they cannot.
 *
 * brand-service has since decided the opposite way round, and it owns this vocabulary: an ad CLICK is
 * not a rung anybody buys, so the step the channel DELIVERS *is* the funnel's first step.
 * `sales_meetings_from_ads` starts on `Meeting booked` — the same step, with nothing before it — and
 * `lead_forms_from_ads` starts on its own form step, distinct from a form filled on the brand's own
 * site. So the two keys are now `meeting_booked` (the step already in this list) and
 * `lead_form_submitted`.
 *
 * THAT IS WHAT MAKES THE JOIN WORK, and it is the whole point. A consumer answers "which funnels does
 * this producible step lead into" by matching a channel's produced step against a funnel's FIRST step.
 * While the two were spelled differently the match found nothing and the consumer needed a translation
 * table of its own — a local copy that goes stale the day brand-service moves. Now the tokens are equal
 * and the join is a lookup in the payload.
 *
 * It creates NO false pairing: an ad channel states `{ from: null, to: "meeting_booked" }`, which is
 * the ENTRY leg of `sales_meetings_from_ads` and is not any leg of the two other meeting funnels (whose
 * meeting is reached FROM a conversation or a website visit, never from nothing).
 */
export const CHANNEL_STEP_KEYS = [
  "conversation",
  "website_visit",
  "meeting_booked",
  "meeting_attended",
  "signup",
  "form_filled",
  "lead_form_submitted",
  "paid_client",
] as const;

export type ChannelStepKey = (typeof CHANNEL_STEP_KEYS)[number];

export interface ChannelStepDef {
  key: ChannelStepKey;
  /** Buyer-facing label. */
  label: string;
  /** What the step actually is, in the buyer's terms. */
  description: string;
}

export const CHANNEL_STEPS: Record<ChannelStepKey, ChannelStepDef> = {
  conversation: {
    key: "conversation",
    // "Positive reply" — brand-service's OWN wording for this rung, and the word every funnel that
    // starts on it already publishes. Two things ride on it, and the first is not cosmetic:
    // FUNNEL_STEP_LABEL_TO_KEY below maps that exact string onto this key, so while the two spellings
    // differed a consumer joining a channel's produced step to a funnel's first rung BY LABEL found
    // nothing and had to keep a translation table of its own.
    //
    // The second is that this string is CUSTOMER COPY: the onboarding's first screen renders one card
    // per producible step, titled with this label and explained with this description, to a visitor who
    // has not signed up. It shipped as "Conversation", which the owner has banned from every
    // customer-facing surface in the fleet — the two entry outcomes a buyer can produce are a POSITIVE
    // REPLY and a WEBSITE VISIT, and "sales interest" is the CATEGORY both belong to rather than the
    // name of either. So this is not "Sales interest" either: it is the specific thing that happened.
    //
    // The KEY stays `conversation`. Consumers, stored rows and every `start_to_conversation` leg
    // reference it; only what a person READS moved.
    label: "Positive reply",
    description: "A buyer answers with interest, on whatever medium the channel runs on.",
  },
  website_visit: {
    key: "website_visit",
    label: "Website visit",
    description: "A buyer lands on the brand's own website.",
  },
  meeting_booked: {
    key: "meeting_booked",
    label: "Meeting booked",
    description: "A buyer takes a slot in the calendar. Nobody has met yet.",
  },
  meeting_attended: {
    key: "meeting_attended",
    label: "Meeting attended",
    description: "The booked meeting is actually held, with the buyer in the room.",
  },
  signup: {
    key: "signup",
    label: "Signup",
    description: "A buyer creates an account on the brand's own product, without paying yet.",
  },
  form_filled: {
    key: "form_filled",
    label: "Form filled",
    description: "A buyer fills a form on the brand's own site and hands over their details.",
  },
  lead_form_submitted: {
    key: "lead_form_submitted",
    // "Form submitted", and deliberately NOT "Form filled": this form is hosted by the advertising
    // platform (Meta Lead Ads, LinkedIn Lead Gen Forms, TikTok lead forms) and the buyer never reaches
    // the brand's site, so it is a step of its own rather than the same one under a second name. The
    // DESCRIPTION is what keeps the two apart for a reader, which is why it names the host explicitly.
    //
    // brand-service spells this rung "Lead form submitted"; the owner read that on the onboarding's
    // first screen — a pre-signup card titled with this label — and asked for the shorter wording. The
    // KEY is untouched (`lead_form_submitted`), and the funnel's own `steps[0]` moved with the label so
    // the label→key join below stays a lookup. This funnel has no brand declaration in production and
    // no leg rate is keyed on its steps (`RATE_FOR_STEP_PAIR` names neither of them), so nothing is
    // matched against brand-service's wording at run time.
    label: "Form submitted",
    description: "A buyer fills a form hosted by the ad platform, without ever reaching the brand's site.",
  },
  paid_client: {
    key: "paid_client",
    label: "Paid client",
    description: "A buyer pays. This is the SALE every funnel terminates in.",
  },
};

const isChannelStepKey = (value: string): value is ChannelStepKey =>
  (CHANNEL_STEP_KEYS as readonly string[]).includes(value);

export function matchChannelStepKey(raw: string): ChannelStepKey | null {
  const normalised = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return isChannelStepKey(normalised) ? normalised : null;
}

// ── A transition: the leg a channel performs ────────────────────────────────────────────────────────

/**
 * One leg a channel can perform: it takes a lead sitting at `from` and moves it to `to`.
 *
 * `from: null` is "from nothing" — the lead was not on the funnel at all until this channel produced its
 * first step. Every channel published before this file gained transitions states only legs of that
 * shape, which is why they all still read the same list of sellable funnels.
 */
export interface ChannelStepTransition {
  from: ChannelStepKey | null;
  to: ChannelStepKey;
}

/** Sugar for the special case, so a catalogue entry that produces an entry step reads as one line. */
export const producesFromNothing = (...steps: readonly ChannelStepKey[]): readonly ChannelStepTransition[] =>
  steps.map((to) => ({ from: null, to }));

/**
 * The steps a channel produces FROM NOTHING — derived from its transitions, never stated beside them.
 * This is what the catalogue published as `producibleSteps` before a channel could state an internal
 * leg, and it keeps that name on the wire because it keeps that exact meaning.
 */
export function producibleStepsOf(transitions: readonly ChannelStepTransition[]): ChannelStepKey[] {
  return transitions.filter((t) => t.from === null).map((t) => t.to);
}

// ── The funnels, expressed as legs ───────────────────────────────────────────────────────────────────

/**
 * brand-service's own wording for each step, resolved to our key. A funnel is a list of LABELS
 * (`SALES_FUNNELS[key].steps`, mirrored from the producer), so this is what lets a funnel be read as a
 * list of legs. Guarded in `acquisition-channels.test.ts`: every label of every deployed funnel must
 * resolve here, so a funnel whose wording changes fails loudly rather than silently losing a leg.
 */
export const FUNNEL_STEP_LABEL_TO_KEY: Record<string, ChannelStepKey> = {
  "Positive reply": "conversation",
  "Website visit": "website_visit",
  "Meeting booked": "meeting_booked",
  "Meeting attended": "meeting_attended",
  Signup: "signup",
  "Form filled": "form_filled",
  "Form submitted": "lead_form_submitted",
  "Paid client": "paid_client",
};

/** Thrown when a deployed funnel contains a step this module cannot name. FAIL LOUD: a silently-dropped
 *  leg would quietly stop a channel being sellable through a funnel it can genuinely serve. */
export class UnknownFunnelStepLabelError extends Error {
  constructor(funnelKey: SalesFunnelKey, label: string) {
    super(`Sales funnel "${funnelKey}" contains a step this catalogue cannot name: ${JSON.stringify(label)}`);
    this.name = "UnknownFunnelStepLabelError";
  }
}

/** One funnel, read as the ordered list of steps it is made of. */
export function funnelStepKeys(key: SalesFunnelKey): ChannelStepKey[] {
  return SALES_FUNNELS[key].steps.map((label) => {
    const step = FUNNEL_STEP_LABEL_TO_KEY[label];
    if (!step) throw new UnknownFunnelStepLabelError(key, label);
    return step;
  });
}

/**
 * Every leg of one funnel: the entry leg (from nothing to the funnel's first step), then one leg per
 * consecutive pair. A channel is sellable through this funnel when it can perform ANY of them.
 */
export function funnelLegs(key: SalesFunnelKey): ChannelStepTransition[] {
  const steps = funnelStepKeys(key);
  const legs: ChannelStepTransition[] = [{ from: null, to: steps[0] }];
  for (let i = 0; i < steps.length - 1; i += 1) legs.push({ from: steps[i], to: steps[i + 1] });
  return legs;
}

/** The step that STARTS each declared sales funnel — the `to` of its entry leg, derived from the funnel
 *  itself so the mirror cannot drift from the funnel it claims to describe. */
export const SALES_FUNNEL_ENTRY_STEP: Record<SalesFunnelKey, ChannelStepKey> = Object.fromEntries(
  SALES_FUNNEL_KEYS.map((key) => [key, funnelStepKeys(key)[0]]),
) as Record<SalesFunnelKey, ChannelStepKey>;

const legKey = (t: ChannelStepTransition): string => `${t.from ?? ""}>${t.to}`;

/**
 * The sales funnels a channel performing `transitions` may be SOLD THROUGH — every declared funnel that
 * contains at least one of them as a leg, in the catalogue's canonical order so the same channel always
 * reads the same list. An empty result is a real statement ("performs no leg of any declared funnel"),
 * not a gap: it happens exactly when nothing the channel does is a step any deployed funnel takes.
 */
export function sellableFunnelsFor(transitions: readonly ChannelStepTransition[]): SalesFunnelKey[] {
  const performed = new Set(transitions.map(legKey));
  return SALES_FUNNEL_KEYS.filter((key) => funnelLegs(key).some((leg) => performed.has(legKey(leg))));
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
   * channel costs the platform nothing to keep open — which is ALWAYS the case for a customer-operated
   * channel, and `operatedBy` is what tells the two apart.
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

/** How a channel does its work. Descriptive grouping for the catalogue; nothing prices off it. */
export const CHANNEL_FAMILIES = ["outbound_one_to_one", "paid_reach", "earned", "conversion"] as const;
export type ChannelFamily = (typeof CHANNEL_FAMILIES)[number];

/**
 * WHO puts the hours in. `platform` is us — either our software or a specialist of ours, and the
 * channel's NAME says which. `customer` is them — their founder takes the call, their team confirms the
 * meeting — so the platform puts nobody on it and the daily operating cost is 0, stated rather than
 * left blank. What the leg costs THEM is declared per lead against lead-service; this catalogue does not
 * guess at it.
 *
 * The converse does NOT hold: a 0 daily operating cost does not imply `customer`. A platform-run channel
 * can legitimately carry no standing day-rate (an automated leg whose real cost is metered per run, or a
 * hand-run leg the owner prices at zero), so read `operatedBy` for who is on it and never the price.
 */
export const CHANNEL_OPERATORS = ["platform", "customer"] as const;
export type ChannelOperator = (typeof CHANNEL_OPERATORS)[number];

/** The whole acquisition-channel statement carried by a feature. `null` on a feature says, out loud,
 *  that the feature is not an acquisition channel (hiring, investor and accelerator outreach, the
 *  internal discovery and page-generation tools) — never that nobody got round to filling it in. */
export interface AcquisitionChannel {
  family: ChannelFamily;
  operatedBy: ChannelOperator;
  stepTransitions: readonly ChannelStepTransition[];
  terms: ChannelCommercialTerms;
}

/**
 * The funnel a funnel prices through, expressed as its steps with the MILESTONE named. Used by the public
 * per-pair economics read so a consumer never has to know the catalogue to render a row.
 */
export function funnelSteps(key: SalesFunnelKey): readonly string[] {
  return SALES_FUNNELS[key].steps;
}
