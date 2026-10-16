/**
 * A SALES FUNNEL'S NAME SAYS WHAT IT DOES (owner 2026-10-16, FUNNEL-NAMES-1016; supersedes the uplifting-word pool of
 * 2026-10-04/10: "Victory", "Epiphany" told a customer nothing). Owner's words: « renommer 100% des sales funnel /
 * campagnes existantes avec un nom détaillant court [...] idéalement 2 mots, parfois 3 ok si vraiment on ne peut pas
 * faire autrement ». Reference: Frontrunner's "Website Visitor Outreach", "Stalled Deal Recovery", "Reply Monitor".
 *
 * The name is COMPOSED from the funnel's combination key (`combinationKeyOf`, `lib/offer-sales-paths.ts`), a pure
 * function, so a new funnel is named by construction:
 *
 *   PROACTIVE (it starts by finding people or by reaching out):   <who> <what we do> <what it brings>
 *     "Cold Email Meetings", "Intent Email Replies", "CRM WhatsApp Replies", "Meta Ads Inquiries".
 *   REACTIVE (it answers people who already did something):       <who it answers> <what we do>
 *     "Reply Booking", "Signup Follow-up", "Form Callback".
 *
 * <what it brings> is the furthest step OUR legs (a leg carrying `@channel`) reach; a site visit is a means, so a
 * funnel bringing people to the site names what the visit should become (signups, orders, meetings).
 *
 * Names stay UNIQUE (one table for every family, UNIQUE on the name): each funnel tries its candidates in order
 * (`funnelNameCandidates`), the first one nobody holds wins; the plainest funnels are named first (`funnelNamingOrder`),
 * so the variant (a wider address check, our team closing) takes the longer candidate. Only once every candidate is
 * held does a number follow ("Cold Email Meetings 2"): never a word-pool word again.
 *
 * Copy rules (humanizer): English, plain words, no dash, no internal word (funnel, pipe, leg, workflow, channel,
 * agency, catch-all). Guard: `lib/funnel-names.test.ts`.
 */

import { triggerCondition } from "./trigger-conditions.js";

/** One leg of a combination key: `<from>_to_<to>` and, when a channel of ours works it, `@<slug>[~<strategy>]`. */
export interface KeyLeg {
  fromStep: string;
  toStep: string;
  channel: string | null;
  strategy: string | null;
}

export interface ParsedFunnelKey {
  /** A trigger-headed funnel (`trigger:<id>+...`): the trigger id. */
  headTrigger: string | null;
  legs: KeyLeg[];
}

/** PURE: the legs of a combination key. */
export function parseFunnelKey(key: string): ParsedFunnelKey {
  const parts = key.split("+");
  let headTrigger: string | null = null;
  if (parts[0]?.startsWith("trigger:")) headTrigger = parts.shift()!.slice("trigger:".length);
  const legs = parts.map((p): KeyLeg => {
    const [legKey, managed] = p.split("@") as [string, string | undefined];
    const i = legKey.indexOf("_to_");
    const fromStep = i < 0 ? legKey : legKey.slice(0, i);
    const toStep = i < 0 ? legKey : legKey.slice(i + "_to_".length);
    const [slug, strategy] = managed ? (managed.split("~") as [string, string | undefined]) : [null, undefined];
    // The client's own team is not something we do: its leg reads like a bare one.
    const channel = slug !== null && !slug.startsWith("your-team-") ? slug : null;
    return { fromStep, toStep, channel, strategy: channel !== null ? (strategy ?? null) : null };
  });
  return { headTrigger, legs };
}

/** Sourcing channels: they find people; they name WHO the next leg reaches. */
const SOURCING_WHO: Readonly<Record<string, string>> = {
  "lead-sourcing": "Cold",
  "sourcing-apollo-cold-filters": "Targeted",
  "sourcing-apollo-buying-signals": "Intent",
  "sourcing-linkedin-engagement-signals": "Engaged",
  "sourcing-crm-contacts": "CRM",
};

/** A lead strategy on a sourcing or outreach leg, in customer words (who it reaches). Null = same people. */
const STRATEGY_WHO: Readonly<Record<string, string | null>> = {
  "valid-only": null,
  "everyone-in-the-source": null,
  "leads-only": null,
  "valid-catch-all": "Wide",
  "valid-catch-all-unknown": "Wider",
  "contacted-pure-prospects": null,
  "warm-never-converted": "Warm",
  "customers-prospects": "Prospect",
  "all-crm-contacts": "CRM",
  "reachable-by-email": "CRM",
  "reachable-by-phone": "CRM",
  "replies-with-documents": "Document",
};

/** What we do, proactive (one or two words, read after <who>). */
const ACTION: Readonly<Record<string, string>> = {
  "sales-cold-email-outreach": "Email",
  "sales-crm-email-outreach": "Email",
  "feedback-request-cold-email-outreach": "Feedback",
  "pr-cold-email-outreach": "Press Pitch",
  "pr-expert-quote-outreach": "Expert Quotes",
  "cold-call-outreach": "Call",
  "cold-sms-outreach": "SMS",
  "cold-whatsapp-outreach": "WhatsApp",
  "cold-linkedin-outreach": "LinkedIn",
  "cold-x-outreach": "X",
  "cold-instagram-outreach": "Instagram",
  "cold-reddit-outreach": "Reddit",
  "email-sending": "API Email",
  "ai-follow-up-email": "Follow-up",
  "ai-meeting-booking": "Booking",
  "agency-meeting-booking": "Booking",
  "ai-instant-call": "Callback",
  "agency-meeting-attendance": "Show-up",
  "agency-closing-calls": "Closing",
  "agency-signup-conversion": "Onboarding",
  "google-ads": "Google Ads",
  "meta-ads": "Meta Ads",
  "linkedin-ads": "LinkedIn Ads",
  "tiktok-ads": "TikTok Ads",
  "youtube-ads": "YouTube Ads",
  "x-ads": "X Ads",
  "reddit-ads": "Reddit Ads",
  "bing-ads": "Bing Ads",
  "quora-ads": "Quora Ads",
  "newsletter-sponsorships": "Newsletter Ads",
  "podcast-sponsorships": "Podcast Ads",
  "creator-sponsorships": "Creator Ads",
  "paid-directory-listings": "Directory",
  "seo-content": "SEO",
  "press-placements": "Press",
  "podcast-guesting": "Podcast",
  "affiliate-programme": "Affiliate",
  "organic-linkedin-publishing": "LinkedIn Post",
  "organic-x-publishing": "X Post",
  "organic-reddit-publishing": "Reddit Post",
  "organic-youtube-publishing": "YouTube",
  "social-post": "Social",
};

/** Outreach to a person (a cold message): <who> reads before it ("Cold Email"). Broadcast reaches people on its own. */
const PERSON_OUTREACH = new Set([
  "sales-cold-email-outreach", "sales-crm-email-outreach", "feedback-request-cold-email-outreach", "cold-call-outreach",
  "cold-sms-outreach", "cold-whatsapp-outreach", "cold-linkedin-outreach", "cold-x-outreach", "cold-instagram-outreach",
  "cold-reddit-outreach",
]);

/** What a step brings, as a plural noun. */
const RESULT: Readonly<Record<string, string>> = {
  lead_found: "Leads",
  conversation: "Replies",
  website_visit: "Traffic",
  booking_call: "Calls",
  meeting_booked: "Meetings",
  meeting_attended: "Meetings",
  signup: "Signups",
  form_submitted: "Inquiries",
  purchase: "Orders",
  paid_client: "Deals",
  email_sent: "Sends",
  industry_update_video: "Videos",
};

/** Who a reactive funnel answers, by the step it takes people over at (one word). */
const ANSWERS: Readonly<Record<string, string>> = {
  start: "Inbound",
  lead_found: "New Lead",
  conversation: "Reply",
  website_visit: "Visitor",
  booking_call: "Call",
  meeting_booked: "Meeting",
  meeting_attended: "Post-meeting",
  signup: "Signup",
  form_submitted: "Form",
  purchase: "Buyer",
};

/** Who a reactive funnel answers when its first pipe runs on a trigger that is not its step's own (one word). A
 *  CONDITION instance ("X reached, still not Y after N") is never listed here: it answers the people of its `afterStep`
 *  (`answersOfTrigger`, `lib/trigger-conditions.ts`), so a new instance is named with no code. */
const TRIGGER_ANSWERS: Readonly<Record<string, string>> = {
  github_issue_in_prod: "Release",
  email_pushed_via_api: "API",
};

/** Who a funnel's first trigger answers (one word), undefined when the trigger says nothing more than its step. */
function answersOfTrigger(triggerId: string): string | undefined {
  const condition = triggerCondition(triggerId);
  return condition ? ANSWERS[condition.afterStep] : TRIGGER_ANSWERS[triggerId];
}

/** The trigger a pipe answers (`<channel slug>|<leg key>` -> trigger id), null when proactive or unknown. */
export type PipeTriggerOf = (channelSlug: string, legKey: string) => string | null;

/** Steps that are a means, never what a funnel brings while a further step follows. */
const MEANS = new Set(["lead_found", "website_visit", "email_sent"]);

const isSourcing = (slug: string): boolean => slug in SOURCING_WHO || slug.startsWith("sourcing-");

/** "agency-closing-calls" -> "Closing Calls": a channel this file does not name, never a raw slug word like "agency". */
function fallbackAction(slug: string): string {
  const words = slug
    .split("-")
    .filter((w) => !["agency", "outreach", "organic", "your", "team", "ai", "cold", "sales"].includes(w))
    .slice(0, 2)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
  return words.length > 0 ? words.join(" ") : "Outreach";
}

const actionOf = (slug: string): string => ACTION[slug] ?? fallbackAction(slug);
const resultOf = (step: string): string => RESULT[step] ?? step.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
const wordCount = (s: string): number => s.split(" ").filter(Boolean).length;

/** PURE: the step a funnel brings: the furthest one our legs reach (a sourcing-only funnel: Lead found). */
function broughtStep(legs: readonly KeyLeg[]): string {
  let last = -1;
  legs.forEach((l, i) => {
    if (l.channel !== null && !isSourcing(l.channel)) last = i;
  });
  return last < 0 ? "lead_found" : legs[last].toStep;
}

/**
 * PURE: the step a funnel is for: the last one before Paid client, past a site visit or a found lead (a means); Paid
 * client when the funnel closes straight from a means or from Start.
 */
function motionStep(legs: readonly KeyLeg[]): string {
  const last = legs[legs.length - 1];
  if (!last) return "paid_client";
  if (last.toStep !== "paid_client") return last.toStep;
  return MEANS.has(last.fromStep) || last.fromStep === "start" ? "paid_client" : last.fromStep;
}

/**
 * PURE: the names a funnel may take, best first, each 2 or 3 words. The first one nobody holds is given
 * (`nextFunnelName`). Never empty.
 */
export function funnelNameCandidates(key: string, triggerOf: PipeTriggerOf = () => null): string[] {
  const { headTrigger, legs } = parseFunnelKey(key);
  const ours = legs.filter((l) => l.channel !== null);
  const sourcing = ours.find((l) => isSourcing(l.channel!)) ?? null;
  const acting = ours.filter((l) => !isSourcing(l.channel!));
  const first = acting[0] ?? null;
  const result = resultOf(broughtStep(legs));
  const motion = motionStep(legs);
  const out: string[] = [];
  const add = (...parts: Array<string | null>) => {
    const name = parts.filter((p): p is string => !!p).join(" ");
    if (wordCount(name) >= 2 && wordCount(name) <= 3 && !out.includes(name)) out.push(name);
  };

  // Who: a strategy names the people best ("Warm"), else the sourcing origin, else "Cold" when a funnel finds people.
  const strategyWho = [sourcing, first].map((l) => (l?.strategy ? (STRATEGY_WHO[l.strategy] ?? null) : null)).find((w) => w) ?? null;
  const sourceWho = sourcing ? (SOURCING_WHO[sourcing.channel!] ?? "New") : null;
  const reactiveHead = headTrigger !== null ? (headTrigger === "lead_found" ? "lead_found" : headTrigger) : null;
  const startsAt = legs[0]?.fromStep ?? "start";
  // A legacy id out of Lead found (before the sourcing leg was named) is a Lead Sourcing funnel: proactive.
  const proactive = reactiveHead === null && (startsAt === "start" || (startsAt === "lead_found" && legs[0]?.channel !== null && PERSON_OUTREACH.has(legs[0].channel!)));

  if (!first) {
    // Only a sourcing leg of ours: we find people.
    const who = strategyWho ?? sourceWho ?? "New";
    add(who, "Leads");
    add(who, "Lead", "Finder");
    if (result !== "Leads") add(who, "Lead", result);
    return out.length > 0 ? out : ["Lead Finder"];
  }

  const action = actionOf(first.channel!);
  const second = acting.find((l) => l.channel !== first.channel) ?? null;
  if (proactive) {
    const who = strategyWho ?? (PERSON_OUTREACH.has(first.channel!) || sourcing ? (sourceWho ?? "Cold") : null);
    const whos = [who, ...(strategyWho && sourceWho && strategyWho !== sourceWho ? [sourceWho] : [])];
    // What it brings: our furthest step, unless that is a means (a site visit): then what the visit should become.
    const brought = broughtStep(legs);
    const results = [...new Set(MEANS.has(brought) ? [motion, brought] : [brought, motion])].map(resultOf);
    for (const w of whos) for (const r of results) add(w, action, r);
    // A second thing we do names the variant ("Cold Email Booking": we also book the meetings).
    if (second) for (const w of whos) add(w, action, actionOf(second.channel!));
    for (const r of results) add(action, r);
    if (second) for (const r of results) add(action, actionOf(second.channel!), r);
  } else {
    const firstTrigger = legs[0]?.channel ? triggerOf(legs[0].channel, `${legs[0].fromStep}_to_${legs[0].toStep}`) : null;
    // A funnel HEADED by a condition instance answers the people of its condition (`trigger:<instance>+...`).
    const headCondition = headTrigger !== null ? triggerCondition(headTrigger) : null;
    const answers = (headCondition ? ANSWERS[headCondition.afterStep] : undefined)
      ?? (firstTrigger ? answersOfTrigger(firstTrigger) : undefined) ?? ANSWERS[reactiveHead ?? startsAt] ?? "Lead";
    add(strategyWho, answers, action);
    add(answers, action);
    add(answers, action, result);
    if (second) add(answers, action, actionOf(second.channel!));
    add(answers, result);
  }
  return out.length > 0 ? out : [`${action} ${result}`];
}

/** PURE: true when `name` is one this composer gives `key` (a candidate, or a candidate + " <n>"). */
export function isComposedNameOf(key: string, name: string, triggerOf?: PipeTriggerOf): boolean {
  const base = name.replace(/ \d+$/, "");
  return funnelNameCandidates(key, triggerOf).includes(base);
}

/** PURE: the first candidate of `key` that `taken` does not hold, else the first candidate numbered 2, 3, ... */
export function nextFunnelName(key: string, taken: ReadonlySet<string>, triggerOf?: PipeTriggerOf): string {
  const candidates = funnelNameCandidates(key, triggerOf);
  const free = candidates.find((c) => !taken.has(c));
  if (free) return free;
  for (let n = 2; ; n += 1) {
    const numbered = `${candidates[0]} ${n}`;
    if (!taken.has(numbered)) return numbered;
  }
}

/**
 * PURE: the order funnels are named in: the plainest first (no lead strategy, fewest legs we run, fewest legs), then
 * `rank` (the caller's order: assignment date, or the read's rank). The plain funnel takes the plain name.
 */
export function funnelNamingOrder<T extends { key: string; rank: number }>(rows: readonly T[]): T[] {
  const weight = (key: string): [number, number, number] => {
    const { headTrigger, legs } = parseFunnelKey(key);
    // A legacy id (out of Lead found, from before the sourcing leg was named) yields to the funnel it stands for.
    const legacy = legs[0]?.fromStep === "lead_found" ? 1 : 0;
    const strategies = legs.filter((l) => l.strategy !== null).length + (headTrigger ? 1 : 0) + legacy;
    return [strategies, legs.filter((l) => l.channel !== null).length, legs.length];
  };
  return [...rows].sort((a, b) => {
    const wa = weight(a.key);
    const wb = weight(b.key);
    for (let i = 0; i < wa.length; i += 1) if (wa[i] !== wb[i]) return wa[i] - wb[i];
    return a.rank - b.rank;
  });
}
