/**
 * ONE SHORT CUSTOMER SENTENCE PER SALES FUNNEL (owner 2026-10-14: the Campaigns page shows, under each campaign's
 * name, « une courte phrase unique de description » in place of the funnel's path).
 *
 * Supersedes the long one-sentence description of 2026-10-11 (withdrawn the same day for its length; its column
 * `sales_path_combination_names.description` stays unread). This one is COMPOSED, never stored: it is a pure
 * function of the funnel's legs, so a wording fix reaches every row at once.
 *
 * What it says: what WE do in that funnel, leg by leg, in the funnel's order. The client's own team legs are left
 * out. A sourcing leg is not a phrase of its own: it names WHO the next leg reaches ("buyers showing intent"), so
 * a cold email funnel reads "We email new buyers until they reply with interest." A reactive funnel names who it
 * answers ("We book meetings with buyers who reply with interest.").
 *
 * Length: at most MAX_WORDS words. Each leg has a FULL and a SHORT phrase; the first candidate that fits wins: all
 * full, first full + rest short, all short, first + last short, first short alone.
 *
 * Copy rules (humanizer): English, plain words, no dash, no internal word (funnel, pipe, leg, workflow, channel,
 * agency), never opens, never effort/cost/risk. A channel this file does not name reads by its kind (`run <name>`,
 * `reach <them> through <medium>`), never a throw. Guard: `lib/funnel-short-descriptions.test.ts` (whole catalogue).
 */
import type { PublicChannel } from "./channel-catalogue.js";
import { triggerForStep } from "./channel-triggers.js";

export const MAX_WORDS = 12;

export type SummaryChannel = Pick<PublicChannel, "slug" | "name" | "channelType" | "performedBy" | "operatedBy">;

export interface SummaryLeg {
  fromStep: string | null;
  toStep: string;
  /** The leg's one channel (null when the leg has none). */
  channel: SummaryChannel | null;
  /** The leg's channel is ours (`operatedBy: "platform"`). */
  runByUs: boolean;
}

export interface SummaryInput {
  legs: readonly SummaryLeg[];
  /** The trigger answered by a REACTIVE funnel's first leg; null on a proactive one. */
  triggerId: string | null;
  reactive: boolean;
}

/** Who a sourcing channel finds: the object of the leg that reaches them. */
const SOURCED: Readonly<Record<string, string>> = {
  "sourcing-apollo-buying-signals": "buyers showing intent",
  "sourcing-linkedin-engagement-signals": "LinkedIn-active buyers",
  "sourcing-crm-contacts": "your CRM contacts",
};
const DEFAULT_SOURCED = "new buyers";

/** How an outbound channel reaches a person (`o` = who). */
const OUTREACH: Readonly<Record<string, (o: string) => string>> = {
  "sales-cold-email-outreach": (o) => `email ${o}`,
  "feedback-request-cold-email-outreach": (o) => `ask ${o} for feedback by email`,
  "cold-call-outreach": (o) => `call ${o}`,
  "cold-sms-outreach": (o) => `text ${o}`,
  "cold-whatsapp-outreach": (o) => `message ${o} on WhatsApp`,
  "cold-linkedin-outreach": (o) => `message ${o} on LinkedIn`,
  "cold-x-outreach": (o) => `message ${o} on X`,
  "cold-instagram-outreach": (o) => `message ${o} on Instagram`,
  "cold-reddit-outreach": (o) => `message ${o} on Reddit`,
};

/** Outreach to the press: it reaches journalists, not the buyers a sourcing leg found. */
const PRESS_OUTREACH: Readonly<Record<string, string>> = {
  "pr-cold-email-outreach": "pitch your story to journalists",
  "pr-expert-quote-outreach": "get your expert quotes into the press",
};

/** What we run for a channel that reaches buyers on its own (paid, earned, press). */
const BROADCAST: Readonly<Record<string, string>> = {
  "newsletter-sponsorships": "sponsor newsletters",
  "podcast-sponsorships": "sponsor podcasts",
  "creator-sponsorships": "sponsor creators",
  "paid-directory-listings": "list you on software directories",
  "seo-content": "write SEO articles",
  "press-placements": "place you in the press",
  "podcast-guesting": "book you on podcasts",
  "affiliate-programme": "run your affiliate programme",
  "organic-linkedin-publishing": "post on LinkedIn",
  "organic-x-publishing": "post on X",
  "organic-reddit-publishing": "post on Reddit",
  "organic-youtube-publishing": "publish YouTube videos",
};

/** Who a funnel taking people over at a step answers. */
const AUDIENCE: Readonly<Record<string, string>> = {
  lead_found: "new buyers",
  conversation: "buyers who reply with interest",
  website_visit: "your site visitors",
  booking_call: "buyers after their booking call",
  meeting_booked: "buyers who booked a meeting",
  meeting_attended: "buyers after their meeting",
  signup: "new signups",
  form_submitted: "people who fill in your form",
  purchase: "online buyers",
};

/** Proper words a medium keeps capitalised; every other word is lower-cased ("Cold Email" -> "cold email"). */
const PROPER = new Set(["LinkedIn", "SMS", "WhatsApp", "X", "Instagram", "Reddit", "Google", "Meta", "TikTok", "YouTube", "Bing", "Quora", "SEO", "PR", "AI", "CRM", "Apollo"]);
const BANNED_NAME_WORDS = new Set(["agency", "funnel", "pipe", "leg", "workflow", "channel"]);

/** PURE: a channel's name as a medium inside a sentence ("Cold Telegram Outreach" -> "cold Telegram"). */
export function mediumOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .filter((w, i, all) => !(i === 0 && w === "Sales") && !(i === all.length - 1 && w === "Outreach"))
    .filter((w) => !BANNED_NAME_WORDS.has(w.toLowerCase()))
    .map((w) => (PROPER.has(w) ? w : w.toLowerCase()))
    .join(" ");
}

/** A phrase of one of our legs: `o` = who it works on, `undefined` when an earlier phrase already named them. */
interface Phrase {
  full: (o: string) => string;
  short: (o: string | undefined) => string;
}

const audienceOf = (step: string | null): string => (step === null ? DEFAULT_SOURCED : (AUDIENCE[step] ?? "your buyers"));

/** PURE: what a step-to-step leg of ours does, by the step it leads to. */
function conversionPhrase(leg: SummaryLeg): Phrase {
  const ai = leg.channel?.performedBy === "software";
  const slug = leg.channel?.slug ?? "";
  if (slug === "ai-follow-up-email") {
    return { full: (o) => `follow up with ${o} by email until they buy`, short: (o) => (o ? `follow up with ${o} by email` : "follow up by email") };
  }
  switch (leg.toStep) {
    case "meeting_booked":
      return {
        full: (o) => `book meetings with ${o}${ai ? " using AI" : ""}`,
        short: (o) => (o ? `book meetings with ${o}` : "book meetings"),
      };
    case "booking_call":
      return {
        full: (o) => `${o === "them" ? "call them back the moment they reply" : `call ${o} right away`}${ai ? " using AI" : ""}`,
        short: (o) => (o ? `call ${o} right away` : "call back those who reply"),
      };
    case "meeting_attended":
      return { full: (o) => `make sure ${o} show up`, short: (o) => `make sure ${o ?? "they"} show up` };
    case "paid_client":
      if (leg.fromStep === "meeting_attended") return { full: (o) => `close the deal with ${o}`, short: (o) => (o ? `close the deal with ${o}` : "close deals") };
      return { full: (o) => `turn ${o} into paying clients`, short: (o) => `turn ${o ?? "them"} into clients` };
    case "signup":
      return { full: (o) => `get ${o} to sign up`, short: (o) => `get ${o ?? "them"} to sign up` };
    case "form_submitted":
      return { full: (o) => `get ${o} to fill in your form`, short: (o) => `get ${o ?? "them"} to fill in your form` };
    case "purchase":
      return { full: (o) => `get ${o} to buy online`, short: (o) => `get ${o ?? "them"} to buy` };
    case "website_visit":
      return { full: (o) => `bring ${o} to your site`, short: (o) => `bring ${o ?? "them"} to your site` };
    case "conversation":
      return { full: (o) => `start conversations with ${o}`, short: (o) => `start conversations with ${o ?? "them"}` };
    default:
      return { full: (o) => `move ${o} forward`, short: (o) => `move ${o ?? "them"} forward` };
  }
}

/** What an entry leg's result reads as, after the channel's own phrase. */
function entryResult(toStep: string, outbound: boolean): string {
  switch (toStep) {
    case "conversation":
      return outbound ? "until they reply with interest" : "to start conversations with buyers";
    case "website_visit":
      return outbound ? "to bring them to your site" : "to bring buyers to your site";
    case "form_submitted":
      return outbound ? "to get them to fill in your form" : "to get buyers to fill in your form";
    case "meeting_booked":
      return outbound ? "to get them to book meetings" : "to get buyers to book meetings";
    case "signup":
      return outbound ? "to get them to sign up" : "to get buyers to sign up";
    default:
      return outbound ? "to move them forward" : "to bring you buyers";
  }
}

/** PURE: a leg of ours that reaches people (outbound) or puts you in front of them (paid, earned, press). */
function entryPhrase(leg: SummaryLeg): Phrase | null {
  const c = leg.channel;
  if (!c) return null;
  const outreach = OUTREACH[c.slug] ?? (c.channelType === "outbound" ? (o: string) => `reach ${o} through ${mediumOf(c.name)}` : null);
  if (outreach) {
    // A call does not get a written reply.
    const result = c.slug === "cold-call-outreach" && leg.toStep === "conversation" ? "until they show interest" : entryResult(leg.toStep, true);
    return { full: (o) => `${outreach(o)} ${result}`, short: (o) => outreach(o ?? "them") };
  }
  if (c.channelType === "sourcing" || c.channelType === "conversion") return null;
  const run = PRESS_OUTREACH[c.slug] ?? BROADCAST[c.slug] ?? `run ${c.name.split(/\s+/).filter((w) => !BANNED_NAME_WORDS.has(w.toLowerCase())).join(" ")}`;
  return { full: () => `${run} ${entryResult(leg.toStep, false)}`, short: () => run };
}

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/** "a", "a and b", "a, b and c". */
function sentence(parts: readonly string[]): string {
  const body = parts.length <= 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `We ${body}.`;
}

export type ShortDescriptionUnavailableReason = "no_step_run_by_us";

/**
 * PURE: the short sentence of a funnel, or null + reason when no leg of it is ours (the client's own team works
 * every step: there is nothing of ours to describe).
 */
export function funnelShortDescription(input: SummaryInput): { shortDescription: string | null; reason: ShortDescriptionUnavailableReason | null } {
  const phrases: Phrase[] = [];
  let firstObject: string | null = null;
  let sourced: string | null = null;
  for (const leg of input.legs) {
    if (!leg.runByUs || !leg.channel) continue;
    if (leg.channel.channelType === "sourcing" || leg.toStep === "lead_found") {
      sourced = SOURCED[leg.channel.slug] ?? DEFAULT_SOURCED;
      continue;
    }
    const p = leg.fromStep === null || leg.fromStep === "lead_found" ? (entryPhrase(leg) ?? conversionPhrase(leg)) : conversionPhrase(leg);
    if (phrases.length === 0) firstObject = sourced ?? whoIsAnswered(input, leg);
    phrases.push(p);
  }
  if (phrases.length === 0) {
    // A funnel whose only leg of ours finds people: we find them.
    if (sourced) return { shortDescription: `We find ${sourced} for you.`, reason: null };
    return { shortDescription: null, reason: "no_step_run_by_us" };
  }
  const o = firstObject ?? DEFAULT_SOURCED;
  const [first, ...rest] = phrases;
  const candidates = [
    [first.full(o), ...rest.map((p) => p.full("them"))],
    [first.full(o), ...rest.map((p) => p.short(undefined))],
    [first.short(o), ...rest.map((p) => p.short(undefined))],
    rest.length > 0 ? [first.short(o), rest[rest.length - 1].short(undefined)] : [first.short(o)],
    [first.short(o)],
  ].map(sentence);
  return { shortDescription: candidates.find((s) => words(s) <= MAX_WORDS) ?? candidates[candidates.length - 1], reason: null };
}

/** Who the first leg of ours works on when no sourcing leg named them: a reactive funnel's audience, else the step. */
function whoIsAnswered(input: SummaryInput, leg: SummaryLeg): string {
  const firstLeg = input.legs[0];
  if (input.reactive && firstLeg === leg) {
    // A trigger other than its step's own ("Follow-up Due", "GitHub Issue In Prod") answers no step's audience.
    const own = firstLeg.fromStep === null ? null : triggerForStep(firstLeg.fromStep as Parameters<typeof triggerForStep>[0])?.id ?? null;
    if (input.triggerId !== null && input.triggerId !== own) return "your leads";
  }
  return audienceOf(leg.fromStep);
}
