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
 *
 * THE SENDING WORKFLOW (owner 2026-10-16, EMAIL-SENDS-ATTRIBUTION-1016). The serve row's workflow is often
 * not the one that SENT: lead-service measured 2,201 of 4,023 retried-then-sent people emailed by another
 * workflow than the one on their row, and a person served later by a newer workflow lost their reply to
 * no workflow at all (drmorley@: replied 2026-09-21 to ballad-v4's email, row says miaplacidus). When the
 * timeline states the person's sends (`emailSends`, one per campaign x sending workflow), the person is
 * RE-ATTRIBUTED, for every partitioned count, to the send its outcome followed:
 *   - the person's LATEST positive reply (then click) that followed a send resolves to the latest send BEFORE
 *     it under its thread's campaign, or, naming no campaign (CRM date), under any campaign of the scope (one
 *     person, one workflow: jerryclark@ replied to ballad in July, then in Belel's own thread in October, and
 *     is Belel's: the conversation that is live now);
 *   - a person with no such outcome goes to its latest send (contacted);
 *   - only sends under the read's campaign scope are candidates (a campaign / offer grain never moves a
 *     person outside itself). With no candidate send, the serve-row rule above stands.
 * The person's `campaignId` / `workflowSlug` become the send's, and, when moved, `servedAt` its first send
 * (the mature cohort's clock for that workflow). One person, one attribution: partitions still add up to
 * the brand, whose totals never move.
 *
 * SCREENED VISITS (owner doctrine, SCOUT-VISIT-SCREEN-1018). A website visit is a click judged HUMAN. Only a
 * click on an email we sent through our own transport is screened (instantly-service keeps a hit only once
 * it judged it human); a click the provider reports carries no request data and is mostly link scanners.
 * Two more credited signals carry that: `screenedContacted` (the credited send went through our transport)
 * and `humanClicked` (a click it earned was recorded by our tracker). A website-visit figure counts
 * `humanClicked` over `screenedContacted`, never a provider click (`lib/screened-visits.ts`). Known only
 * where the timeline states the send: on the serve-row rule both are false.
 */

import type { CampaignFilter } from "./campaign-scope.js";
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

export type CreditedSignal = "contacted" | "clicked" | "positiveReply" | "screenedContacted" | "humanClicked";
export type ServingRowCredit = Record<CreditedSignal, boolean>;

interface DatedEvidence {
  campaignId: string | null;
  at: number | null;
  /** A click our own tracker recorded (judged human); false for a reply or a provider-reported click. */
  screened?: boolean;
}

interface Send {
  campaignId: string | null;
  workflowSlug: string | null;
  first: number | null;
  last: number | null;
  firstIso: string | null;
  /** Sent through our own transport: a click on it is screened (see SCREENED VISITS above). */
  screenable: boolean;
}

export interface PersonTimeline {
  /** campaign id → its FIRST act on the person (ms); null when the act states no date. */
  firstActBy: Map<string, number | null>;
  replies: DatedEvidence[];
  clicks: DatedEvidence[];
  /** The person's sends per (campaign, sending workflow); null when no journey of the person states them. */
  sends: Send[] | null;
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
    const t: PersonTimeline = out.get(j.leadId) ?? { firstActBy: new Map(), replies: [], clicks: [], sends: null };
    if (j.emailSends !== undefined) {
      t.sends = t.sends ?? [];
      for (const e of j.emailSends) {
        t.sends.push({
          campaignId: e.campaignId,
          workflowSlug: e.workflowSlug,
          first: ms(e.firstSentAt),
          last: ms(e.lastSentAt),
          firstIso: e.firstSentAt,
          screenable: e.screenable === true,
        });
      }
    }
    for (const a of j.acts) {
      if (!a.campaignId) continue;
      const at = ms(a.firstActedAt);
      const prev = t.firstActBy.get(a.campaignId);
      if (prev === undefined || (at !== null && (prev === null || at < prev))) t.firstActBy.set(a.campaignId, at);
    }
    for (const f of j.facts) {
      const evidence = { campaignId: f.campaignId, at: ms(f.occurredAt) };
      if (f.source === "reply" && POSITIVE_REPLY_LABELS.has(f.label)) t.replies.push(evidence);
      else if (f.source === "outreach" && CLICK_LABELS.has(f.label)) t.clicks.push({ ...evidence, screened: f.screened === true });
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
  // No send of the person is stated here, so none is known to be screenable: no screened figure.
  const own: ServingRowCredit = {
    contacted: Boolean(person.signals.contacted),
    clicked: Boolean(person.signals.clicked),
    positiveReply: Boolean(person.signals.positiveReply),
    screenedContacted: false,
    humanClicked: false,
  };
  // No act anywhere: nothing disputes the row's own attribution.
  if (!timeline || timeline.firstActBy.size === 0) return own;
  const campaignId = person.campaignId ?? null;
  if (!campaignId || !timeline.firstActBy.has(campaignId)) {
    return { contacted: false, clicked: false, positiveReply: false, screenedContacted: false, humanClicked: false };
  }
  const firstAct = timeline.firstActBy.get(campaignId) ?? null;
  // The CRM witness names no campaign: it counts when dated at or after this campaign's first act.
  const crmAt = ms(person.crmPositiveReplyAt ?? person.signalDates?.positiveReply ?? null);
  const replies = crmAt !== null ? [...timeline.replies, { campaignId: null, at: crmAt }] : timeline.replies;
  return {
    contacted: own.contacted,
    clicked: own.clicked && earnedBy(timeline.clicks, campaignId, firstAct),
    positiveReply: own.positiveReply && earnedBy(replies, campaignId, firstAct),
    screenedContacted: false,
    humanClicked: false,
  };
}

/** The latest send instant of `s` known to be at or before `t` (its first send when it straddles `t`). */
const sentBefore = (s: Send, t: number): number => (s.last !== null && s.last <= t ? s.last : (s.first as number));

function latest(sends: readonly Send[], key: (s: Send) => number): Send {
  let best = sends[0];
  for (const s of sends) if (key(s) >= key(best)) best = s;
  return best;
}

/** The send a reaction followed (see the module rule), or null when none of `sends` preceded it. */
function sendFollowed(e: DatedEvidence, sends: readonly Send[]): Send | null {
  const pool = e.campaignId !== null ? sends.filter((s) => s.campaignId === e.campaignId) : sends;
  if (pool.length === 0) return null;
  if (e.at === null) {
    // An undated reply IN a thread answered that thread's latest send; an undated one naming none: nothing.
    return e.campaignId !== null ? latest(pool, (s) => s.last ?? s.first ?? -Infinity) : null;
  }
  const at = e.at;
  const before = pool.filter((s) => s.first !== null && s.first <= at);
  if (before.length > 0) return latest(before, (s) => sentBefore(s, at));
  // A reply in a thread dated before every send of it (clock skew): the thread's opener.
  return e.campaignId !== null ? latest([...pool].reverse(), (s) => -(s.first ?? Infinity)) : null;
}

/** The send followed by the LATEST of `evidence` that follows one (dated latest first, undated last). */
function lastSendFollowed(evidence: readonly DatedEvidence[], sends: readonly Send[]): Send | null {
  const ordered = [...evidence].sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
  for (const e of ordered) {
    const send = sendFollowed(e, sends);
    if (send) return send;
  }
  return null;
}

/**
 * The date of the person's FIRST positive reply (the earliest dated reply evidence: the thread's, else the CRM's), for a
 * person who replied positively. Absent when they did not or no evidence is dated: a replay of the past (the estimate
 * replay, `lib/research/estimate-replay.ts`) never places an undated reply in time.
 */
function firstPositiveReplyOf(person: EnginePerson, replies: readonly DatedEvidence[]): { firstPositiveReplyAt?: string } {
  if (!person.signals.positiveReply) return {};
  const at = replies.reduce<number | null>((a, e) => (e.at !== null && (a === null || e.at < a) ? e.at : a), null);
  return at === null ? {} : { firstPositiveReplyAt: new Date(at).toISOString() };
}

/**
 * PURE. The person as every partitioned count reads it: re-attributed to the workflow that SENT the email its
 * outcome followed, with what that send earned (see the module rule). Never mutates `person`.
 */
export function creditPerson<T extends EnginePerson>(person: T, timeline: PersonTimeline | undefined, scope: ReadonlySet<string> | null): T {
  const sends = (timeline?.sends ?? []).filter((s) => !scope || (s.campaignId !== null && scope.has(s.campaignId)));
  const crmAt = ms(person.crmPositiveReplyAt ?? person.signalDates?.positiveReply ?? null);
  const replies = crmAt !== null ? [...(timeline?.replies ?? []), { campaignId: null, at: crmAt }] : (timeline?.replies ?? []);
  const replyDate = firstPositiveReplyOf(person, replies);
  if (!timeline || sends.length === 0) return { ...person, ...replyDate, servingRowCredit: servingRowCredit(person, timeline) };
  const own = person.signals;
  const replyTo = own.positiveReply ? lastSendFollowed(replies, sends) : null;
  const clickTo = own.clicked ? lastSendFollowed(timeline.clicks, sends) : null;
  const to = replyTo ?? clickTo ?? latest(sends, (s) => s.last ?? s.first ?? -Infinity);
  const clicksOnTo = Boolean(own.clicked) ? timeline.clicks.filter((c) => sendFollowed(c, sends) === to) : [];
  const credit: ServingRowCredit = {
    contacted: Boolean(own.contacted),
    clicked: clicksOnTo.length > 0,
    positiveReply: replyTo !== null,
    // SCREENED VISITS: the send the person is credited to went through our own transport, and (for the click)
    // one of the clicks it earned is one our tracker judged human.
    screenedContacted: Boolean(own.contacted) && to.screenable,
    humanClicked: to.screenable && clicksOnTo.some((c) => c.screened === true),
  };
  const moved = to.campaignId !== (person.campaignId ?? null) || to.workflowSlug !== (person.workflowSlug ?? null);
  return {
    ...person,
    ...replyDate,
    campaignId: to.campaignId,
    workflowSlug: to.workflowSlug,
    ...(moved && person.servedAt !== undefined && to.firstIso ? { servedAt: to.firstIso } : {}),
    servingRowCredit: credit,
  };
}

/**
 * PURE. Every person as its partitioned counts read it ({@link creditPerson}), restricted to the read's
 * campaign scope (undefined = the brand). Returns NEW person objects; the input rows are never mutated (a
 * lead walk may be shared by reads of other scopes).
 */
export function creditServingRows<T extends EnginePerson>(persons: readonly T[], journeys: readonly Journey[], campaignScope?: CampaignFilter): T[] {
  const timelines = indexTimelines(journeys);
  const scope = campaignScope === undefined ? null : new Set(typeof campaignScope === "string" ? [campaignScope] : campaignScope);
  return persons.map((p) => creditPerson(p, timelines.get(p.leadId), scope));
}

/**
 * PURE. The person and its timeline AS THEY STOOD at `endMs` (INDEX-HISTORY-BACKFILL-1019: a past day's index point is
 * computed on what had happened by the end of that day, never on what came later). Only evidence DATED at or before
 * `endMs` is kept: sends that had started (a send still going on after `endMs` is known only by its first instant),
 * replies, clicks and acts dated by then, the CRM witness dated by then. A signal no kept evidence dates is dropped (an
 * undated reply or click cannot be placed in time, so no past day counts it). The serve clock: a person whose recorded
 * serve (the LATEST one) is after `endMs` stands on their earliest send by then, else was not served yet (null).
 * Null = nothing of this person existed by `endMs`. Feed the result to {@link creditPerson}.
 */
export function asOfPerson<T extends EnginePerson>(
  person: T,
  timeline: PersonTimeline | undefined,
  endMs: number,
): { person: T; timeline: PersonTimeline | undefined } | null {
  const served = ms(person.servedAt ?? null);
  const t: PersonTimeline | undefined = timeline
    ? {
        firstActBy: new Map([...timeline.firstActBy].filter(([, at]) => at !== null && at <= endMs)),
        replies: timeline.replies.filter((e) => e.at !== null && e.at <= endMs),
        clicks: timeline.clicks.filter((e) => e.at !== null && e.at <= endMs),
        sends:
          timeline.sends === null
            ? null
            : timeline.sends
                .filter((s) => s.first !== null && s.first <= endMs)
                .map((s) => (s.last !== null && s.last <= endMs ? s : { ...s, last: s.first })),
      }
    : undefined;
  let servedAt = person.servedAt ?? null;
  // No serve recorded (an emailed person whose row states none), or a serve after `endMs`: the person stands on their
  // earliest send by then, the same clock a re-attributed person stands on.
  if (served === null || served > endMs) {
    const earliest = (t?.sends ?? []).reduce<Send | null>((a, s) => (a === null || (s.first as number) < (a.first as number) ? s : a), null);
    if (!earliest?.firstIso) return null;
    servedAt = earliest.firstIso;
  }
  const crmIso = person.crmPositiveReplyAt ?? person.signalDates?.positiveReply ?? null;
  const crmAt = ms(crmIso);
  const crmKept = crmAt !== null && crmAt <= endMs;
  const own = person.signals;
  const sent = t?.sends ? t.sends.length > 0 : true;
  const signals = {
    ...own,
    contacted: Boolean(own.contacted) && sent,
    clicked: Boolean(own.clicked) && (t?.clicks.length ?? 0) > 0,
    positiveReply: Boolean(own.positiveReply) && ((t?.replies.length ?? 0) > 0 || crmKept),
  };
  const signalDates = person.signalDates ? { ...person.signalDates, positiveReply: crmKept ? crmIso : null } : person.signalDates;
  return {
    person: {
      ...person,
      servedAt,
      signals,
      ...(signalDates ? { signalDates } : {}),
      crmPositiveReplyAt: crmKept ? (person.crmPositiveReplyAt ?? null) : null,
    },
    timeline: t,
  };
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
