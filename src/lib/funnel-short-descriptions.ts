/**
 * ONE SHORT CUSTOMER SENTENCE PER SALES FUNNEL (owner 2026-10-14: the Campaigns page shows, under each campaign's
 * name, « une courte phrase unique de description » in place of the funnel's path).
 *
 * Supersedes the long one-sentence description of 2026-10-11 (withdrawn the same day for its length; its column
 * `sales_path_combination_names.description` stays unread). This one is COMPOSED, never stored: it is a pure
 * function of the funnel's legs, so a wording fix reaches every row at once.
 *
 * What it says: what WE do in that funnel, in the funnel's order, to whom (a play's lead strategy names who it reaches
 * and when it writes again, `lib/strategy-words.ts`, so two funnels of one brand never share a sentence). The client's own team legs are left out. A
 * sourcing leg is not a phrase of its own: it names WHO the next leg reaches ("buyers showing intent"), so a cold
 * email funnel reads "We email new buyers until they reply with interest." A reactive funnel names who it answers.
 * When the first thing we do is done by our AI (a conversion channel run by software: AI meeting booking, AI
 * follow-up email), the sentence opens on it: "Our AI books meetings with buyers who reply with interest."
 *
 * Only the FIRST phrase names people; every later phrase is self-contained ("book meetings with those who reply",
 * "make sure buyers show up", "close the deals"), so no sentence leans on a pronoun with no noun before it.
 *
 * NEVER a channel's display name pasted in (owner 2026-10-14: "We run Social post to bring you buyers"): a channel
 * this file does not name reads by what its slug and kind say in plain words ("email", "run ads", "post on social
 * media"), else a plain phrase for its kind. Platform words that ARE English (LinkedIn, Google Ads) are fine.
 *
 * Length: at most MAX_WORDS words; the first candidate that fits wins (all full, first full + rest short, all
 * short, first + last, first alone).
 *
 * Copy rules (humanizer): English, plain words, no dash, no internal word (funnel, pipe, leg, workflow, channel,
 * agency), never opens, never effort/cost/risk. Guard: `lib/funnel-short-descriptions.test.ts`, over the seed
 * catalogue AND the captured prod catalogue (`lib/__fixtures__/prod-funnel-catalogue.json`, DB declarations included).
 */
import type { PublicChannel } from "./channel-catalogue.js";
import { canonicalTriggerId, triggerForStep } from "./channel-triggers.js";
import { conditionAudience, triggerCondition } from "./trigger-conditions.js";
import { strategySentenceWho } from "./strategy-words.js";

export const MAX_WORDS = 12;

/** Marks where the named people end inside a sentence being composed (never served). */
const WHO_END = "\u0001";

export type SummaryChannel = Pick<PublicChannel, "slug" | "name" | "channelType" | "performedBy" | "operatedBy">;

export interface SummaryLeg {
  fromStep: string | null;
  toStep: string;
  /** The leg's one channel (null when the leg has none). */
  channel: SummaryChannel | null;
  /** The leg's channel is ours (`operatedBy: "platform"`). */
  runByUs: boolean;
  /** The lead strategy of the leg's play when it is not the pipe's default (`lib/strategy-words.ts`); absent = none. */
  strategy?: string | null;
}

export interface SummaryInput {
  legs: readonly SummaryLeg[];
  /** The trigger answered by a REACTIVE funnel's first leg; null on a proactive one. */
  triggerId: string | null;
  reactive: boolean;
}

/** Who a sourcing channel finds: the object of the leg that reaches them. */
const SOURCED: Readonly<Record<string, string>> = {
  "sourcing-apollo-cold-filters": "buyers matching your filters",
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
  "ai-follow-up-email": (o) => `email ${o}`,
};

/** Outreach to the press: it reaches journalists, not the buyers a sourcing leg found. */
const PRESS_OUTREACH: Readonly<Record<string, string>> = {
  "pr-cold-email-outreach": "pitch your story to journalists",
  "pr-expert-quote-outreach": "get your expert quotes into the press",
};

/** What we run for a channel that reaches buyers on its own (paid, earned, press). */
const BROADCAST: Readonly<Record<string, string>> = {
  "google-ads": "run Google Ads",
  "meta-ads": "run Meta ads",
  "linkedin-ads": "run LinkedIn ads",
  "tiktok-ads": "run TikTok ads",
  "youtube-ads": "run YouTube ads",
  "x-ads": "run ads on X",
  "reddit-ads": "run Reddit ads",
  "bing-ads": "run Bing ads",
  "quora-ads": "run Quora ads",
  "newsletter-sponsorships": "sponsor newsletters",
  "podcast-sponsorships": "sponsor podcasts",
  "creator-sponsorships": "sponsor creators",
  "paid-directory-listings": "list you on software directories",
  "seo-content": "write SEO articles",
  "press-placements": "place you in the press",
  "podcast-guesting": "get you invited on podcasts",
  "affiliate-programme": "run your affiliate programme",
  "organic-linkedin-publishing": "post on LinkedIn",
  "organic-x-publishing": "post on X",
  "organic-reddit-publishing": "post on Reddit",
  "organic-youtube-publishing": "publish YouTube videos",
};

/** Platform words a fallback may name (each reads as English). */
const PLATFORMS: ReadonlyArray<[RegExp, string]> = [
  [/linkedin/, "LinkedIn"],
  [/whatsapp/, "WhatsApp"],
  [/instagram/, "Instagram"],
  [/reddit/, "Reddit"],
  [/youtube/, "YouTube"],
  [/tiktok/, "TikTok"],
  [/facebook|meta/, "Facebook"],
  [/google/, "Google"],
  [/(^|[^a-z])x([^a-z]|$)|twitter/, "X"],
];

/** A channel this file does not name, outbound: its medium in plain words, never its display name. */
function fallbackOutreach(c: SummaryChannel): (o: string) => string {
  const s = `${c.slug} ${c.name}`.toLowerCase();
  if (/e-?mail/.test(s)) return (o) => `email ${o}`;
  if (/sms|text/.test(s)) return (o) => `text ${o}`;
  if (/call|phone|voice/.test(s)) return (o) => `call ${o}`;
  const p = PLATFORMS.find(([re]) => re.test(s));
  if (p) return (o) => `message ${o} on ${p[1]}`;
  return (o) => `reach out to ${o}`;
}

/** A channel this file does not name, broadcast (paid, earned, press): what we do in plain words. */
function fallbackBroadcast(c: SummaryChannel): string {
  const s = `${c.slug} ${c.name}`.toLowerCase();
  const p = PLATFORMS.find(([re]) => re.test(s));
  if (/\bads?\b|advert/.test(s)) return p ? `run ${p[1]} ads` : "run ads";
  if (/podcast/.test(s)) return "get you on podcasts";
  if (/newsletter/.test(s)) return "sponsor newsletters";
  if (/video/.test(s)) return p ? `publish ${p[1]} videos` : "publish videos";
  if (/post|social|publish/.test(s)) return p ? `post on ${p[1]}` : "post on social media";
  if (/seo|blog|article|content/.test(s)) return "write articles";
  if (/press|pr\b|journalist/.test(s)) return "get you in the press";
  if (c.channelType === "paid") return "run ads";
  return "get you seen online";
}

/** Who a funnel taking people over at a step answers. */
const AUDIENCE: Readonly<Record<string, string>> = {
  lead_found: "new buyers",
  conversation: "buyers who reply with interest",
  website_visit: "your site visitors",
  booking_call: "buyers on a booking call",
  meeting_booked: "buyers who booked a meeting",
  meeting_attended: "buyers after their meeting",
  signup: "new signups",
  form_submitted: "people who fill in your form",
  purchase: "online buyers",
};
const DEFAULT_AUDIENCE = "your leads";

/** Who a reactive funnel answers when its trigger is not its step's own (a report, a push). A CONDITION instance ("X
 *  reached, still not Y after N") is never listed here: its audience is composed from its parameters
 *  (`conditionAudience`, `lib/trigger-conditions.ts`), so a new instance reads right with no code. */
const TRIGGER_AUDIENCE: Readonly<Record<string, string>> = {
  follow_up_due: "leads due a follow-up",
  email_pushed_via_api: "the leads you send us",
  lead_event: "leads the moment they act",
  github_issue_in_prod: "leads waiting on a feature you ship",
};

/** A phrase of one of our legs. `first(o)`: it opens the sentence and names who (`o`); `later`: object-free. */
interface Phrase {
  first: { full: (o: string) => string; short: (o: string) => string };
  later: { full: string; short: string };
  /** Done by our AI (a conversion channel run by software): an opening phrase makes "Our AI" the subject. */
  ai: boolean;
}

const until = (to: string): string | null =>
  ({ conversation: "until they reply with interest", paid_client: "until they buy", signup: "until they sign up", form_submitted: "until they fill in your form", meeting_booked: "until they book a meeting", website_visit: "until they visit your site" })[to] ?? null;

/** Who a later phrase works on, without a pronoun. */
const LATER_WHO: Readonly<Record<string, string>> = {
  conversation: "those who reply",
  website_visit: "your site visitors",
  form_submitted: "those who fill in your form",
  signup: "new signups",
  booking_call: "those on a call",
  meeting_booked: "booked buyers",
};

/** What a site visit should become, by the step after it (owner 2026-10-16: say what the funnel brings, not only "your site"). */
const VISIT_TO: Readonly<Record<string, string>> = {
  signup: "until they visit your site and sign up",
  purchase: "until they visit your site and buy",
  meeting_booked: "until they visit your site and book a meeting",
  form_submitted: "until they visit your site and fill in your form",
  paid_client: "until they visit your site and buy",
};

function outreachPhrase(reach: (o: string) => string, leg: SummaryLeg, ai: boolean, isCall: boolean, next: string | null): Phrase {
  const entry = leg.fromStep === null || leg.fromStep === "lead_found";
  const visit = leg.toStep === "website_visit" && entry ? (VISIT_TO[next ?? ""] ?? "to bring them to your site") : null;
  const result = isCall && leg.toStep === "conversation" ? "until they show interest" : (visit ?? until(leg.toStep));
  const later = reach(LATER_WHO[leg.fromStep ?? ""] ?? (entry ? "new buyers" : "your leads"));
  return {
    first: { full: (o) => (result ? `${reach(o)} ${result}` : reach(o)), short: (o) => reach(o) },
    later: { full: result ? `${later} ${result}` : later, short: later },
    ai,
  };
}

function broadcastPhrase(run: string, to: string): Phrase {
  const result =
    ({
      website_visit: "to bring buyers to your site",
      form_submitted: "to get buyers to fill in your form",
      meeting_booked: "to get buyers to book meetings",
      conversation: "to start conversations with buyers",
      signup: "to get buyers to sign up",
    } as Record<string, string>)[to] ?? null;
  const full = result ? `${run} ${result}` : run;
  return { first: { full: () => full, short: () => run }, later: { full, short: run }, ai: false };
}

/** PURE: what a step-to-step leg of ours does, by the step it leads to. */
function conversionPhrase(leg: SummaryLeg, ai: boolean): Phrase {
  const from = leg.fromStep ?? "";
  switch (leg.toStep) {
    case "meeting_booked": {
      const later = LATER_WHO[from] ? `book meetings with ${LATER_WHO[from]}` : "book meetings";
      return { first: { full: (o) => `book meetings with ${o}`, short: (o) => `book meetings with ${o}` }, later: { full: later, short: "book meetings" }, ai };
    }
    case "booking_call":
      return { first: { full: (o) => `call ${o} right away`, short: (o) => `call ${o}` }, later: { full: "call back those who reply right away", short: "call back those who reply" }, ai };
    case "meeting_attended":
      return { first: { full: (o) => `make sure ${o} show up`, short: (o) => `make sure ${o} show up` }, later: { full: "make sure buyers show up", short: "make sure buyers show up" }, ai };
    case "paid_client":
      if (from === "meeting_attended") return { first: { full: (o) => `close the deal with ${o}`, short: (o) => `close the deal with ${o}` }, later: { full: "close the deals", short: "close the deals" }, ai };
      if (from === "signup") return { first: { full: (o) => `turn ${o} into paying clients`, short: (o) => `turn ${o} into clients` }, later: { full: "turn signups into paying clients", short: "turn signups into clients" }, ai };
      if (from === "form_submitted") return { first: { full: (o) => `turn ${o} into paying clients`, short: (o) => `turn ${o} into clients` }, later: { full: "turn form leads into paying clients", short: "turn form leads into clients" }, ai };
      return { first: { full: (o) => `turn ${o} into paying clients`, short: (o) => `turn ${o} into clients` }, later: { full: "turn leads into paying clients", short: "turn leads into clients" }, ai };
    case "signup":
      return { first: { full: (o) => `get ${o} to sign up`, short: (o) => `get ${o} to sign up` }, later: { full: "get them to sign up", short: "get signups" }, ai };
    case "form_submitted":
      return { first: { full: (o) => `get ${o} to fill in your form`, short: (o) => `get ${o} to fill in your form` }, later: { full: "get people to fill in your form", short: "get form leads" }, ai };
    case "purchase":
      return { first: { full: (o) => `get ${o} to buy online`, short: (o) => `get ${o} to buy` }, later: { full: "get people to buy online", short: "get online sales" }, ai };
    case "website_visit":
      return { first: { full: (o) => `bring ${o} to your site`, short: (o) => `bring ${o} to your site` }, later: { full: "bring buyers to your site", short: "bring buyers to your site" }, ai };
    case "conversation":
      return { first: { full: (o) => `start conversations with ${o}`, short: (o) => `start conversations with ${o}` }, later: { full: "start conversations with buyers", short: "start conversations" }, ai };
    default:
      return { first: { full: (o) => `follow up with ${o}`, short: (o) => `follow up with ${o}` }, later: { full: "follow up with your leads", short: "follow up with leads" }, ai };
  }
}

/** PURE: the phrase of one leg of ours (never a sourcing leg). */
function phraseOf(leg: SummaryLeg, next: string | null = null): Phrase {
  const c = leg.channel!;
  const ai = c.performedBy === "software" && c.channelType === "conversion";
  if (c.slug === "ai-follow-up-email" && leg.fromStep !== null && leg.fromStep !== "lead_found") {
    // Our AI's follow-up emails: "Our AI emails new signups until they buy." / "... and follow up until they buy".
    const result = until(leg.toStep);
    return {
      first: { full: (o) => `email ${o}${result ? ` ${result}` : ""}`, short: (o) => `email ${o}` },
      later: { full: result ? `follow up until ${result.slice("until ".length)}` : "follow up by email", short: result ? `follow up until ${result.slice("until ".length)}` : "follow up by email" },
      ai,
    };
  }
  const reach = OUTREACH[c.slug] ?? (c.channelType === "outbound" ? fallbackOutreach(c) : null);
  if (reach) return outreachPhrase(reach, leg, ai, c.slug === "cold-call-outreach", next);
  const entry = leg.fromStep === null || leg.fromStep === "lead_found";
  if (entry && c.channelType !== "conversion") return broadcastPhrase(PRESS_OUTREACH[c.slug] ?? BROADCAST[c.slug] ?? fallbackBroadcast(c), leg.toStep);
  return conversionPhrase(leg, ai);
}

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;
const list = (parts: readonly string[]): string => (parts.length <= 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

/** "book meetings" -> "books meetings": the third person of the phrase's first verb. */
function thirdPerson(phrase: string): string {
  const [verb, ...rest] = phrase.split(" ");
  if (verb === "get" || verb === "make") return [`${verb}s`, ...rest].join(" ");
  const third = /(s|sh|ch|x|z)$/.test(verb) ? `${verb}es` : `${verb}s`;
  return [third, ...rest].join(" ");
}

function sentence(ai: boolean, first: string, later: readonly string[]): string {
  if (!ai) return `We ${list([first, ...later])}.`;
  return later.length === 0 ? `Our AI ${thirdPerson(first)}.` : `Our AI ${thirdPerson(first)}, and we ${list(later)}.`;
}

export type ShortDescriptionUnavailableReason = "no_step_run_by_us";

/**
 * PURE: the short sentence of a funnel, or null + reason when no leg of it is ours (the client's own team works
 * every step: there is nothing of ours to describe).
 */
export function funnelShortDescription(input: SummaryInput): { shortDescription: string | null; reason: ShortDescriptionUnavailableReason | null } {
  const phrases: Phrase[] = [];
  let who: string | null = null;
  let sourced: string | null = null;
  let lastSlug: string | null = null;
  for (const [i, leg] of input.legs.entries()) {
    if (!leg.runByUs || !leg.channel) continue;
    const next = input.legs[i + 1]?.toStep ?? null;
    if (leg.channel.channelType === "sourcing" || leg.toStep === "lead_found") {
      sourced = strategySentenceWho(leg.strategy ?? null, SOURCED[leg.channel.slug] ?? DEFAULT_SOURCED);
      continue;
    }
    // A lead strategy says who the funnel reaches and when it writes again: two funnels a brand runs never read alike
    // (owner 2026-10-27, FUNNEL-NAMES-NO-NUMBERS-1027).
    if (phrases.length === 0) who = strategySentenceWho(leg.strategy ?? null, sourced ?? whoIsAnswered(input, leg));
    // Two legs in a row on one channel are one thing we do, read up to the further step ("follow up until they buy").
    if (lastSlug === leg.channel.slug) phrases[phrases.length - 1] = phraseOf(leg, next);
    else phrases.push(phraseOf(leg, next));
    lastSlug = leg.channel.slug;
  }
  if (phrases.length === 0) {
    // A funnel whose only leg of ours finds people: we find them.
    if (sourced) return { shortDescription: sourced === SOURCED["sourcing-crm-contacts"] ? "We pick the right contacts from your CRM." : `We find ${sourced} for you.`, reason: null };
    return { shortDescription: null, reason: "no_step_run_by_us" };
  }
  // A who carrying its own comma ("new buyers, unconfirmed addresses included") closes it before what follows.
  const whoText = who ?? DEFAULT_SOURCED;
  const o = `${whoText}${WHO_END}`;
  const [p0, ...rest] = phrases;
  const last = rest[rest.length - 1];
  const candidates: Array<[string, string[]]> = [
    [p0.first.full(o), rest.map((p) => p.later.full)],
    [p0.first.full(o), rest.map((p) => p.later.short)],
    [p0.first.short(o), rest.map((p) => p.later.short)],
    [p0.first.full(o), last ? [last.later.short] : []],
    [p0.first.short(o), last ? [last.later.short] : []],
    [p0.first.short(o), []],
  ];
  const sentences = candidates.map(([f, l]) => {
    const raw = sentence(p0.ai, f, l);
    return (whoText.includes(",") ? raw.replace(new RegExp(`${WHO_END}(?= )`, "g"), ",") : raw).split(WHO_END).join("");
  });
  return { shortDescription: sentences.find((s) => words(s) <= MAX_WORDS) ?? sentences[sentences.length - 1], reason: null };
}

/** Who the first leg of ours works on when no sourcing leg named them: a reactive funnel's audience, else the step's. */
function whoIsAnswered(input: SummaryInput, leg: SummaryLeg): string {
  const firstLeg = input.legs[0];
  if (input.reactive && firstLeg === leg && input.triggerId !== null) {
    const triggerId = canonicalTriggerId(input.triggerId);
    const condition = triggerCondition(triggerId);
    const conditional = condition ? conditionAudience(condition) : null;
    if (conditional) return conditional;
    if (TRIGGER_AUDIENCE[triggerId]) return TRIGGER_AUDIENCE[triggerId];
    // A trigger other than its step's own ("GitHub Issue In Prod") answers no step's audience.
    const own = leg.fromStep === null ? null : (triggerForStep(leg.fromStep as Parameters<typeof triggerForStep>[0])?.id ?? null);
    if (input.triggerId !== own) return DEFAULT_AUDIENCE;
  }
  return leg.fromStep === null ? DEFAULT_SOURCED : (AUDIENCE[leg.fromStep] ?? DEFAULT_AUDIENCE);
}
