/**
 * WHICH OF A PERSON'S SIGNALS THE ROW THEY ARE ATTRIBUTED TO ACTUALLY EARNED (owner 2026-10-15,
 * OUTCOME-BEFORE-WORKFLOW-1015).
 *
 * A brand-scoped lead read gives ONE row per person: lead-service's winning `leads_campaigns` row (the
 * latest one served), carrying the person's BRAND-WIDE delivery evidence (keyed by email, OR-merged over
 * every campaign that ever wrote to them). Every person-grain count per workflow / campaign put that
 * brand-wide evidence on the winning row's workflow. So a person who replied positively in May to an old
 * campaign, and was served (never emailed) by a workflow born in October, was a positive reply of the
 * October workflow: prod 2026-10-15, Miaplacidus ranked first on 5 positive replies, none of them to an
 * email it sent (all five rows never sent), and Belel on 4 of which one was its own.
 *
 * The rule, the same for every grain that partitions people by workflow or campaign:
 *   - CONTACTED counts for the row only when its campaign ACTED on the person (lead-service's timeline acts:
 *     our sends and bounces, our follow-ups).
 *   - A POSITIVE REPLY counts for the row only when its campaign acted on the person AND the reply came from
 *     that contact: a reply in that campaign's own thread, or a reply / CRM positive reply naming no
 *     campaign dated at or after the campaign's first act.
 *   - A CLICK, the same way (a click on that campaign's email, or an unattributed one after its first act).
 * A person the timeline holds NO act for at all keeps the row's own attribution: nothing disputes it (a
 * channel send recorded on the row itself, which the timeline does not carry).
 *
 * The person's own signals are untouched: the brand still counts them (they replied, to the brand). Only a
 * count PARTITIONED by workflow or campaign reads {@link creditedSignal}.
 */

import type { Journey } from "./lived-sales-paths.js";
import type { EnginePerson } from "./revenue-engine.js";

/**
 * The timeline reply words that ARE the Positive reply step: lead-service's own `conversation_ongoing` rung
 * (`timeline-labels.ts` `stepOf`), which is what the sender's `positive` classification places a reply on
 * (an `information_request` is a question, still positive). A person's verdict stays lead-service's (the
 * compact row's `positiveReply`); these only DATE it and name its thread.
 */
export const POSITIVE_REPLY_LABELS: ReadonlySet<string> = new Set([
  "interested",
  "question_answerable",
  "question_to_escalate",
  "question",
  "referral",
  "other_proposal",
  "hand_over",
]);
/** The timeline words of a click on our email. */
export const CLICK_LABELS: ReadonlySet<string> = new Set(["website_visit", "link_click"]);

export type CreditedSignal = "contacted" | "clicked" | "positiveReply";
export type ServingRowCredit = Record<CreditedSignal, boolean>;

interface DatedEvidence {
  campaignId: string | null;
  at: number | null;
}

interface PersonTimeline {
  /** campaign id → its FIRST act on the person (ms); null when the act states no date. */
  firstActBy: Map<string, number | null>;
  replies: DatedEvidence[];
  clicks: DatedEvidence[];
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** PURE. Index a brand's journeys per person (a person on several offers has several journeys). */
export function indexTimelines(journeys: readonly Journey[]): Map<string, PersonTimeline> {
  const out = new Map<string, PersonTimeline>();
  for (const j of journeys) {
    const t: PersonTimeline = out.get(j.leadId) ?? { firstActBy: new Map(), replies: [], clicks: [] };
    for (const a of j.acts) {
      if (!a.campaignId) continue;
      const at = ms(a.firstActedAt);
      const prev = t.firstActBy.get(a.campaignId);
      if (prev === undefined || (at !== null && (prev === null || at < prev))) t.firstActBy.set(a.campaignId, at);
    }
    for (const f of j.facts) {
      const evidence = { campaignId: f.campaignId, at: ms(f.occurredAt) };
      if (f.source === "reply" && POSITIVE_REPLY_LABELS.has(f.label)) t.replies.push(evidence);
      else if (f.source === "outreach" && CLICK_LABELS.has(f.label)) t.clicks.push(evidence);
    }
    out.set(j.leadId, t);
  }
  return out;
}

/** Evidence of a reaction to `campaignId`'s contact: in its own thread, or unattributed and not before it. */
function earnedBy(evidence: readonly DatedEvidence[], campaignId: string, firstAct: number | null): boolean {
  return evidence.some((e) => {
    if (e.campaignId !== null) return e.campaignId === campaignId;
    return e.at !== null && firstAct !== null && e.at >= firstAct;
  });
}

/** PURE. What the person's attributed row earned, given the person's timeline (see the module rule). */
export function servingRowCredit(person: EnginePerson, timeline: PersonTimeline | undefined): ServingRowCredit {
  const own: ServingRowCredit = {
    contacted: Boolean(person.signals.contacted),
    clicked: Boolean(person.signals.clicked),
    positiveReply: Boolean(person.signals.positiveReply),
  };
  // No act anywhere: nothing disputes the row's own attribution.
  if (!timeline || timeline.firstActBy.size === 0) return own;
  const campaignId = person.campaignId ?? null;
  if (!campaignId || !timeline.firstActBy.has(campaignId)) return { contacted: false, clicked: false, positiveReply: false };
  const firstAct = timeline.firstActBy.get(campaignId) ?? null;
  // The CRM witness names no campaign: it counts when dated at or after this campaign's first act.
  const crmAt = ms(person.crmPositiveReplyAt ?? person.signalDates?.positiveReply ?? null);
  const replies = crmAt !== null ? [...timeline.replies, { campaignId: null, at: crmAt }] : timeline.replies;
  return {
    contacted: own.contacted,
    clicked: own.clicked && earnedBy(timeline.clicks, campaignId, firstAct),
    positiveReply: own.positiveReply && earnedBy(replies, campaignId, firstAct),
  };
}

/** PURE. Stamp every person with what its attributed row earned, IN PLACE; returns the same array. */
export function creditServingRows<T extends EnginePerson>(persons: T[], journeys: readonly Journey[]): T[] {
  const timelines = indexTimelines(journeys);
  for (const p of persons) p.servingRowCredit = servingRowCredit(p, timelines.get(p.leadId));
  return persons;
}

/**
 * Whether `signal` counts for the person's attributed workflow / campaign. A person read through
 * `fetchScopePersons` always carries its credit; one built elsewhere (a fixture) counts on its own signals.
 */
export function creditedSignal(person: EnginePerson, signal: CreditedSignal): boolean {
  return person.servingRowCredit ? person.servingRowCredit[signal] : Boolean(person.signals[signal]);
}

/** Facts about our own sending and the reply's class: never a funnel step, so never a value to move. */
const DELIVERY_FACTS: ReadonlySet<string> = new Set([
  "contacted",
  "sent",
  "delivered",
  "open",
  "opened",
  "bounced",
  "unsubscribed",
  "replied",
  "negativeReply",
  "neutralReply",
]);

/**
 * PURE. The person as its attributed WORKFLOW may price it (the per-workflow pipeline, `workflow-revenue.ts`):
 * null when the row's campaign never acted on the person (it is in no workflow's group); otherwise its own
 * signals minus the reply / click that row did not earn, and minus every later step (a meeting, a sale) when
 * the row earned no engagement at all — a step reached through another campaign's conversation is not
 * this workflow's. Unchanged when nothing was stamped or the row earned everything it carries.
 */
export function asServingRowEarned<T extends EnginePerson>(person: T): T | null {
  const credit = person.servingRowCredit;
  if (!credit) return person;
  const own = person.signals;
  if (Boolean(own.positiveReply) === credit.positiveReply && Boolean(own.clicked) === credit.clicked && Boolean(own.contacted) === credit.contacted) {
    return person;
  }
  if (!credit.contacted && !credit.clicked && !credit.positiveReply) return null;
  const engaged = credit.clicked || credit.positiveReply;
  const signals: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(own)) {
    if (key === "positiveReply") signals[key] = credit.positiveReply;
    else if (key === "clicked") signals[key] = credit.clicked;
    else signals[key] = value && (engaged || DELIVERY_FACTS.has(key));
  }
  return { ...person, signals };
}
