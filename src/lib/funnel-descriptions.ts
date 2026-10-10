/**
 * ONE CUSTOMER-FACING SENTENCE PER SALES FUNNEL (owner 2026-10-11: the Campaigns page shows, under each
 * campaign name, "a description specific to the sales funnel that describes it uniquely in one sentence").
 *
 * Composed from the funnel's own legs, in order, so two funnels never share a sentence: every leg names who
 * works it (the channel's medium on the first leg, "our AI" / "our specialists" / "your team" / "you" on the
 * next ones) and what it gets the buyer to do (the leg's `to` step). Two funnel ids differ in at least one
 * leg's step or channel, so their sentences differ (guarded over the whole catalogue in the test).
 *
 * Copy rules (humanizer): plain words, what it does for the client, no "funnel / pipe / leg / workflow", no
 * em or en dash. Pure; the route persists the sentence once given (`sales_path_combination_names.description`),
 * so a later wording change never moves a sentence a customer has seen.
 */
import type { PublicChannel } from "./channel-catalogue.js";
import type { CatalogueFunnel } from "./agent-catalogue.js";

/** Proper words a medium keeps capitalised; every other word is lower-cased ("Cold Email" -> "cold email"). */
const PROPER = new Set(["LinkedIn", "SMS", "WhatsApp", "X", "Instagram", "Reddit", "Google", "Meta", "TikTok", "YouTube", "Bing", "Quora", "SEO", "PR", "AI", "CRM", "Apollo"]);

/** PURE: the channel's name as a medium inside a sentence ("Sales Cold Email Outreach" -> "cold email"). */
export function mediumOf(name: string): string {
  const words = name
    .split(/\s+/)
    .filter(Boolean)
    .filter((w, i, all) => !(i === 0 && w === "Sales") && !(i === all.length - 1 && w === "Outreach"));
  return words.map((w) => (PROPER.has(w) ? w : w.toLowerCase())).join(" ");
}

type Actor = { noun: string; plural: boolean };
const YOU: Actor = { noun: "you", plural: true };
const BUYER: Actor = { noun: "they", plural: true };

/** Steps the BUYER takes on their own (a bare leg into them is the buyer's act, not the client's). */
const BUYER_STEPS = new Set(["website_visit", "signup", "form_submitted", "purchase", "conversation"]);

function actorOf(channel: Pick<PublicChannel, "operatedBy" | "performedBy"> | null, toStep: string): Actor {
  if (!channel) return BUYER_STEPS.has(toStep) ? BUYER : YOU;
  if (channel.operatedBy === "customer") return { noun: "your team", plural: false };
  return channel.performedBy === "software" ? { noun: "our AI", plural: false } : { noun: "our specialists", plural: true };
}

const verb = (a: Actor, base: string, third: string): string => `${a.noun} ${a.plural ? base : third}`;

/** One later leg's clause: who does what, by the step it leads to. */
function legClause(a: Actor, from: string | null, to: string, stepLabel: (key: string) => string): string {
  switch (to) {
    case "meeting_booked":
      return from === "booking_call" ? verb(a, "turn the call into a booked meeting", "turns the call into a booked meeting") : verb(a, "book a meeting with them", "books a meeting with them");
    case "booking_call":
      return verb(a, "put them on a call with your rep right away", "puts them on a call with your rep right away");
    case "meeting_attended":
      return a === BUYER ? "they show up to the meeting" : verb(a, "make sure they show up", "makes sure they show up");
    case "paid_client":
      if (from === "meeting_attended") return verb(a, "close the deal", "closes the deal");
      if (from === "conversation") return verb(a, "close the sale", "closes the sale");
      return a === BUYER || a === YOU ? "they become paying clients" : verb(a, "turn them into paying clients", "turns them into paying clients");
    case "signup":
      return a === BUYER ? "they sign up" : verb(a, "get them to sign up", "gets them to sign up");
    case "form_submitted":
      return a === BUYER ? "they fill in your form" : verb(a, "get them to fill in your form", "gets them to fill in your form");
    case "purchase":
      return a === BUYER ? "they buy online" : verb(a, "get them to buy online", "gets them to buy online");
    case "website_visit":
      return a === BUYER ? "they visit your website" : verb(a, "bring them to your website", "brings them to your website");
    case "conversation":
      return a === BUYER ? "they reply with interest" : verb(a, "start a conversation with them", "starts a conversation with them");
    default:
      return a === BUYER ? `they reach ${stepLabel(to).toLowerCase()}` : verb(a, `take them to ${stepLabel(to).toLowerCase()}`, `takes them to ${stepLabel(to).toLowerCase()}`);
  }
}

/** What the first leg gets the buyer to do (its subject is the opener's "we"). */
function entryOutcome(to: string, stepLabel: (key: string) => string, them: "them" | "buyers"): string {
  switch (to) {
    case "conversation":
      return them === "them" ? "start conversations with those who reply with interest" : "start conversations with buyers who reply with interest";
    case "website_visit":
      return `bring ${them} to your website`;
    case "meeting_booked":
      return `get ${them} to book a meeting with you`;
    case "form_submitted":
      return `get ${them} to fill in your form`;
    case "lead_found":
      return "find the right buyers";
    default:
      return `get ${them} to ${stepLabel(to).toLowerCase()}`;
  }
}

/** How a proactive funnel opens, by the kind of channel working its first leg. */
function entryOpener(channel: PublicChannel): string {
  const medium = mediumOf(channel.name);
  switch (channel.channelType) {
    case "outbound":
      return `We reach buyers through ${medium} outreach`;
    case "paid":
      return `We run ${medium} for you`;
    default:
      return `We handle ${medium} for you`;
  }
}

/** A reactive funnel opens on the step that triggers it. */
const TRIGGER_OPENER: Readonly<Record<string, string>> = {
  conversation: "When a buyer replies with interest",
  website_visit: "When a buyer visits your website",
  booking_call: "After a booking call",
  meeting_booked: "When a buyer books a meeting",
  meeting_attended: "After a meeting",
  signup: "When someone signs up",
  form_submitted: "When someone fills in your form",
  purchase: "When someone buys online",
};

/** The customer label of the trigger that starts a reactive funnel (the Campaigns page shows it as a tag). */
const TRIGGER_LABEL: Readonly<Record<string, string>> = {
  conversation: "Positive replies",
  website_visit: "Website visits",
  booking_call: "Booking calls",
  meeting_booked: "Booked meetings",
  meeting_attended: "Held meetings",
  signup: "Signups",
  form_submitted: "Form submissions",
  purchase: "Online purchases",
};

/** PURE: the trigger label of a funnel whose first pipe is reactive; null on a proactive funnel. */
export function funnelTriggerLabel(f: Pick<CatalogueFunnel, "legs">, stepLabel: (key: string) => string): string | null {
  const first = f.legs[0]?.pipe;
  if (!first || first.mode !== "reactive" || first.fromStep === null) return null;
  return TRIGGER_LABEL[first.fromStep] ?? `${stepLabel(first.fromStep)}s`;
}

/** PURE: the one sentence describing a funnel to a customer. */
export function describeFunnel(f: CatalogueFunnel, channels: readonly PublicChannel[], stepLabel: (key: string) => string): string {
  const channelOf = (slug: string | undefined) => (slug ? (channels.find((c) => c.slug === slug) ?? null) : null);
  const clauses: string[] = [];
  const first = f.legs[0];
  const firstPipe = first?.pipe ?? null;
  const reactive = firstPipe?.mode === "reactive" && firstPipe.fromStep !== null && firstPipe.fromStep !== "lead_found";
  let rest = f.legs;
  let opener: string;
  if (reactive) {
    opener = TRIGGER_OPENER[firstPipe!.fromStep!] ?? `When a buyer reaches ${stepLabel(firstPipe!.fromStep!).toLowerCase()}`;
  } else {
    const channel = channelOf(firstPipe?.channelSlug);
    opener = channel ? entryOpener(channel) : "We find your buyers";
    // An outbound opener names the buyers ("We reach buyers..."); any other one does not.
    clauses.push(entryOutcome(firstPipe?.toStep ?? splitLeg(first.legKey)[1], stepLabel, channel?.channelType === "outbound" ? "them" : "buyers"));
    rest = f.legs.slice(1);
  }
  for (const l of rest) {
    const pipe = l.pipe;
    const channel = channelOf(pipe?.channelSlug);
    const [fromStep, toStep] = pipe ? [pipe.fromStep, pipe.toStep] : splitLeg(l.legKey);
    clauses.push(legClause(actorOf(channel, toStep), fromStep, toStep, stepLabel));
  }
  if (clauses.length === 0) return `${opener}.`;
  return reactive ? `${opener}, ${joinClauses(clauses)}.` : `${joinClauses([opener, ...clauses])}.`;
}

/** "a, b, and c" / "a and b" / "a". */
function joinClauses(c: string[]): string {
  if (c.length === 1) return c[0];
  if (c.length === 2) return `${c[0]} and ${c[1]}`;
  return `${c.slice(0, -1).join(", ")}, and ${c[c.length - 1]}`;
}

/** The two steps of a bare leg (`<from>_to_<to>`; this service mints the format). */
function splitLeg(legKey: string): [string | null, string] {
  const at = legKey.indexOf("_to_");
  const from = legKey.slice(0, at);
  return [from === "start" ? null : from, legKey.slice(at + 4)];
}
