/**
 * WHAT COMES NEXT IN ONE SALES FUNNEL CAMPAIGN (owner 2026-10-18, CAMPAIGN-NEXT-STEPS-1018): the figures our
 * assistant (Sophie, the Copilot on web and WhatsApp) needs to say "N leads are queued and go out from tomorrow in
 * their business hours; expect a positive reply about X days after the first email", never inventing one.
 *
 * Every fact is its owner's, read never re-derived:
 *   - the EMAIL SEND QUEUE (leads awaiting their first email, follow-ups queued, queued emails, when the window next
 *     opens in each lead's own local business hours): instantly-service `GET /orgs/send-queue` over the campaign's
 *     unit campaigns (the sender holds sequences only for the units that email, so no channel list is kept here);
 *   - the TIME FROM THE FIRST EMAIL TO THE FIRST POSITIVE REPLY: instantly-service's dated events
 *     (`POST /public/stats/engagement-latency/grouped`, groups by campaign ids), since inception, measured on
 *       1. this campaign's own reply pipes (units whose leg ends on a positive reply), once it holds
 *          `TIME_TO_REPLY_MIN_SAMPLE` measured replies; else
 *       2. the SAME pipes across the fleet (every org's campaigns of the same channel x leg, campaign-service's own
 *          stated `legKey`), once THAT holds the bar; else
 *       3. `learning`: no figure, never a default or another channel's delay.
 * This module is PURE; the IO lives in `campaign-next-steps-io.ts`.
 */
import { funnelLeg, matchFunnelLegKey } from "./funnel-legs.js";

/**
 * A median time-to-reply needs at least this many measured replies. A SAMPLE-SIZE bar on a duration, the same 10 as
 * the between-step rate bar (`MIN_MEASURED_FROM_REACHED`) and the default leg maturity count: deliberately not the
 * conversation leg's 1-reply maturity count (one reply is no "typical" delay).
 */
export const TIME_TO_REPLY_MIN_SAMPLE = 10;

/** The step a positive reply IS in the catalogue (`Positive reply`). */
const POSITIVE_REPLY_STEP = "conversation";

const MS_PER_DAY = 86_400_000;

export interface LatencyMetric {
  averageMs: number | null;
  medianMs: number | null;
  sampleSize: number;
}

export interface TimeToReplyFigure {
  medianDays: number | null;
  averageDays: number | null;
  medianMs: number | null;
  averageMs: number | null;
  /** Leads with a measured first positive reply after their first email. */
  sampleSize: number;
}

export type TimeToReplyBasis = "campaign" | "pipe_fleet";
export type TimeToReplyUnavailableReason = "learning" | "no_positive_reply_pipe" | "reply_latency_unreadable";

export interface TimeToFirstPositiveReply {
  /** The figure to state: this campaign's own once measured, else its pipes' fleet, else null. */
  medianDays: number | null;
  averageDays: number | null;
  sampleSize: number | null;
  /** Which population the stated figure is measured on; null = nothing measurable yet. */
  basis: TimeToReplyBasis | null;
  /** True while no population reaches the bar (say "too early to tell", never a number). */
  learning: boolean;
  /** Measured replies a population needs before its figure is stated. */
  minSample: number;
  /** This campaign's own reply pipes, since inception (null when not read). */
  campaign: TimeToReplyFigure | null;
  /** The same channel x leg pipes across every org, since inception (null when not read). */
  pipeFleet: TimeToReplyFigure | null;
  /** Why `medianDays` is null; null when a figure is served. */
  unavailableReason: TimeToReplyUnavailableReason | null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function figureOf(m: LatencyMetric): TimeToReplyFigure {
  return {
    medianDays: m.medianMs === null ? null : round1(m.medianMs / MS_PER_DAY),
    averageDays: m.averageMs === null ? null : round1(m.averageMs / MS_PER_DAY),
    medianMs: m.medianMs,
    averageMs: m.averageMs,
    sampleSize: m.sampleSize,
  };
}

/** The canonical leg a unit performs (its stated key, the funnel table's spelling when it has one). */
export function canonicalLegKey(legKey: string): string {
  return matchFunnelLegKey(legKey) ?? legKey;
}

/** PURE: does this unit's leg end on a positive reply (its sends are timed to a reply)? */
export function isReplyPipe(legKey: string): boolean {
  return funnelLeg(canonicalLegKey(legKey))?.toStep.key === POSITIVE_REPLY_STEP;
}

/** PURE: the stated time to first positive reply, by the basis order campaign > pipe fleet > learning. */
export function chooseTimeToReply(input: {
  hasReplyPipe: boolean;
  campaign: LatencyMetric | null;
  pipeFleet: LatencyMetric | null;
  unreadable?: boolean;
  minSample?: number;
}): TimeToFirstPositiveReply {
  const minSample = input.minSample ?? TIME_TO_REPLY_MIN_SAMPLE;
  const campaign = input.campaign ? figureOf(input.campaign) : null;
  const pipeFleet = input.pipeFleet ? figureOf(input.pipeFleet) : null;
  const none = (reason: TimeToReplyUnavailableReason): TimeToFirstPositiveReply => ({
    medianDays: null,
    averageDays: null,
    sampleSize: null,
    basis: null,
    learning: reason === "learning",
    minSample,
    campaign,
    pipeFleet,
    unavailableReason: reason,
  });
  if (!input.hasReplyPipe) return none("no_positive_reply_pipe");
  if (input.unreadable) return none("reply_latency_unreadable");
  const measured = (f: TimeToReplyFigure | null): f is TimeToReplyFigure => f !== null && f.sampleSize >= minSample && f.medianDays !== null;
  const pick: [TimeToReplyBasis, TimeToReplyFigure] | null = measured(campaign) ? ["campaign", campaign] : measured(pipeFleet) ? ["pipe_fleet", pipeFleet] : null;
  if (!pick) return none("learning");
  const [basis, f] = pick;
  return { medianDays: f.medianDays, averageDays: f.averageDays, sampleSize: f.sampleSize, basis, learning: false, minSample, campaign, pipeFleet, unavailableReason: null };
}

/** The send queue as instantly-service serves it (`GET /orgs/send-queue`). */
export interface EmailSendQueue {
  asOf: string;
  leadsAwaitingFirstEmail: number;
  leadsWithFollowUpQueued: number;
  queuedEmails: number;
  firstEmailsFrom: string | null;
  sendWindow: { weekdays: string[]; startHour: number; endHour: number; timezoneRule: string };
  timezones: { timezone: string; timezoneIsDefault: boolean; leadsAwaitingFirstEmail: number; windowOpensAt: string }[];
}

/** PURE: parse instantly-service's queue body, throwing on a shape it does not recognise (never a silent 0). */
export function parseEmailSendQueue(raw: unknown): EmailSendQueue {
  const o = raw as Record<string, unknown> | null;
  const int = (k: string): number => {
    const v = o?.[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`send-queue: ${k} is not a count`);
    return v;
  };
  if (!o || typeof o !== "object") throw new Error("send-queue: body is not an object");
  const w = o.sendWindow as Record<string, unknown> | undefined;
  if (!w || !Array.isArray(w.weekdays) || typeof w.startHour !== "number" || typeof w.endHour !== "number") throw new Error("send-queue: sendWindow missing");
  if (!Array.isArray(o.timezones)) throw new Error("send-queue: timezones missing");
  const first = o.firstEmailsFrom;
  if (first !== null && typeof first !== "string") throw new Error("send-queue: firstEmailsFrom is neither a date nor null");
  return {
    asOf: String(o.asOf),
    leadsAwaitingFirstEmail: int("leadsAwaitingFirstEmail"),
    leadsWithFollowUpQueued: int("leadsWithFollowUpQueued"),
    queuedEmails: int("queuedEmails"),
    firstEmailsFrom: first as string | null,
    sendWindow: { weekdays: w.weekdays.map(String), startHour: w.startHour, endHour: w.endHour, timezoneRule: String(w.timezoneRule) },
    timezones: (o.timezones as Record<string, unknown>[]).map((t) => ({
      timezone: String(t.timezone),
      timezoneIsDefault: t.timezoneIsDefault === true,
      leadsAwaitingFirstEmail: Number(t.leadsAwaitingFirstEmail),
      windowOpensAt: String(t.windowOpensAt),
    })),
  };
}

/**
 * What the campaign's writers SCHEDULED, on every channel, as lead-service serves it (`GET /orgs/followup-dates/scheduled`,
 * NEXT-STEPS-ALL-CHANNELS-1019): a follow-up writer (email reply in the person's last thread, WhatsApp...) states each
 * person's next follow-up date there instead of queueing a message in a sender, so the send queue alone reads "0 queued"
 * beside 47 people scheduled for Monday.
 */
export interface ScheduledFollowups {
  asOf: string;
  leads: number;
  due: number;
  upcoming: number;
  nextAt: string | null;
  oldestDueAt: string | null;
  byDay: { date: string; leads: number; firstAt: string }[];
  laterThanHorizon: number;
}

/** PURE: parse lead-service's schedule, throwing on a shape it does not recognise (never a silent 0). */
export function parseScheduledFollowups(raw: unknown): ScheduledFollowups {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("scheduled-followups: body is not an object");
  const int = (k: string): number => {
    const v = o[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`scheduled-followups: ${k} is not a count`);
    return v;
  };
  const isoOrNull = (k: string): string | null => {
    const v = o[k];
    if (v !== null && typeof v !== "string") throw new Error(`scheduled-followups: ${k} is neither a date nor null`);
    return v as string | null;
  };
  if (typeof o.asOf !== "string") throw new Error("scheduled-followups: asOf missing");
  if (!Array.isArray(o.byDay)) throw new Error("scheduled-followups: byDay missing");
  return {
    asOf: o.asOf,
    leads: int("leads"),
    due: int("due"),
    upcoming: int("upcoming"),
    nextAt: isoOrNull("nextAt"),
    oldestDueAt: isoOrNull("oldestDueAt"),
    byDay: (o.byDay as Record<string, unknown>[]).map((d) => ({ date: String(d.date), leads: Number(d.leads), firstAt: String(d.firstAt) })),
    laterThanHorizon: int("laterThanHorizon"),
  };
}

export type NextSendsUnavailableReason = "follow_up_schedule_unreadable" | "sender_unreadable";

/** What waits to go out and when, every channel together: the one figure our assistant states as "queued". */
export interface NextSends {
  /** Leads with something of ours waiting to go out: follow-ups scheduled on any channel + the email sender's queue. */
  leadsQueued: number | null;
  /** Of them, follow-ups whose time already came: they go out on the follow-up pipe's next pass. */
  dueNow: number | null;
  /** The earliest planned send still ahead (ISO), any channel, in each lead's own working hours; null = none ahead. */
  nextSendAt: string | null;
  /** Why `leadsQueued` is null (a part could not be read: never a partial sum); null when served. */
  unavailableReason: NextSendsUnavailableReason | null;
}

/**
 * PURE: compose the two owners' facts. The email sender's queue counts leads awaiting a first email + leads with a
 * follow-up queued there; lead-service's schedule counts the people a writer scheduled (a follow-up writer does not
 * queue in the sender). `nextSendAt` = the earliest of the schedule's `nextAt` and the sender's `firstEmailsFrom` when
 * the sender holds something. Either part unreadable = null with its reason, never a figure missing a channel.
 */
export function composeNextSends(input: {
  scheduled: ScheduledFollowups | null;
  scheduledAsked: boolean;
  queue: EmailSendQueue | null;
  queueAsked: boolean;
}): NextSends {
  if (input.scheduledAsked && input.scheduled === null) return { leadsQueued: null, dueNow: null, nextSendAt: null, unavailableReason: "follow_up_schedule_unreadable" };
  if (input.queueAsked && input.queue === null) return { leadsQueued: null, dueNow: null, nextSendAt: null, unavailableReason: "sender_unreadable" };
  const s = input.scheduled;
  const q = input.queue;
  const queued = q ? q.leadsAwaitingFirstEmail + q.leadsWithFollowUpQueued : 0;
  const times = [s?.nextAt ?? null, q && q.queuedEmails > 0 ? q.firstEmailsFrom : null].filter((t): t is string => t !== null);
  const nextSendAt = times.length === 0 ? null : times.reduce((a, b) => (new Date(a).getTime() <= new Date(b).getTime() ? a : b));
  return { leadsQueued: (s?.leads ?? 0) + queued, dueNow: s?.due ?? 0, nextSendAt, unavailableReason: null };
}
