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
 * Every step a channel can move a lead FROM or TO. Seven of them are steps of a deployed funnel, and the
 * remaining two are produced INSIDE AN AD UNIT and start no funnel we sell yet.
 *
 * This list used to hold four keys, because a channel could only ever say what it PRODUCED and only
 * four steps can start a funnel. A channel that performs an internal leg needs to name the step it moves
 * a lead OUT OF as well, and those are steps a funnel reaches rather than starts from — so the
 * vocabulary is the union of every step in the catalogue, not the subset that happens to come first.
 *
 * ── WHY THE `in_ad_` PREFIX, AND WHY NEITHER SHORTER NAME WORKS ───────────────────────────────────
 *
 * The prefix is LOAD-BEARING and must not be dropped. "Form filled" and "Meeting booked" ALREADY exist
 * in the deployed funnel catalogue as INTERMEDIATE steps (`form_magnet` step 2, both meeting funnels'
 * milestone), reached through a click or a reply onto the brand's own site — and they are now in this
 * very list under `form_filled` and `meeting_booked`. What an ad produces is an ENTRY step reached
 * without ever getting there. Naming ours `form_submission` / `booked_meeting` would collide with those
 * two outright, which is the clearest possible statement of why the prefix exists.
 *
 * `platform_` was the first spelling and is WRONG here: `platform` is this fleet's word for OUR OWN
 * platform (platform runs, `/internal/platform-complete`, platform prices, `PLATFORM_SCOPE_ORG_ID`), so
 * it reads as "a form filled on distribute.you". `ad_` alone is no better — `ad_form_submission` reads
 * as "a form submission ATTRIBUTED to an ad", i.e. one filled on the brand's site after the click,
 * which is the very reading the prefix exists to block. `in_ad_` says the literal thing: it happened
 * inside the ad unit. Do not shorten it back.
 */
export const CHANNEL_STEP_KEYS = [
  "conversation",
  "website_visit",
  "meeting_booked",
  "meeting_attended",
  "signup",
  "form_filled",
  "paid_client",
  "in_ad_form_submission",
  "in_ad_booked_meeting",
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
    // "Conversation", NOT "Sales interest". Sales interest is the CATEGORY every entry signal belongs
    // to — a positive reply, a website visit, a form filled in an ad are all a buyer showing interest —
    // so putting it on ONE of them names the category as if it were the member, and leaves the siblings
    // unreadable beside it. This step is the specific thing that happened: the buyer answered.
    label: "Conversation",
    description: "A buyer answers and a conversation opens, on whatever medium the channel runs on.",
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
  paid_client: {
    key: "paid_client",
    label: "Paid client",
    description: "A buyer pays. This is the SALE every funnel terminates in.",
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
