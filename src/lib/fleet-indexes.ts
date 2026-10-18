/**
 * THE PUBLIC FLEET INDEXES (owner 2026-10-18): one number per index, recorded every day, so a reader can see
 * where the market price of an outcome stands today and how it moved. "SCEO" (Sales Cold Email Outreach) is an internal prefix only: public names read "Distribute.you <metric> Index" (owner 2026-10-18).
 *
 * Every index is read off figures this service already serves, never a second computation:
 * - the cost / rate of a pipe's outcome = the BEST MATURE workflow of the pipe that can still run
 *   (`/public/stats/leg-workflow-ranking`, the row `moneyGoesHere`): what a client buys today. A workflow
 *   that no longer runs is out, so the curve never freezes on a retired one;
 * - a later step is CHAINED: Meeting booked = Positive reply ÷ the fleet's measured Positive reply -> Meeting
 *   booked rate (lead-service meeting attribution, `lib/meeting-booking-before-after.ts`, positive facts only).
 *
 * Each value carries a `status` saying how far to trust it, from the outcomes behind it (the weakest link of a
 * chain): `noise` under `SIGNAL_MIN_OUTCOMES` (the maturity bar, `lib/maturity.ts`) or with no mature workflow,
 * `signal` under `ROBUST_MIN_OUTCOMES` (the usual n ≥ 30 rule of thumb for a stable sample mean), else `robust`.
 *
 * PURE: the recorder (`fleet-index-recorder.ts`) reads the inputs, this turns them into points.
 */
import type { LegWorkflowRankingRow } from "./leg-workflow-ranking.js";

export type FleetIndexStatus = "robust" | "signal" | "noise";
export type FleetIndexUnit = "usd" | "percent";

export const SIGNAL_MIN_OUTCOMES = 10;
export const ROBUST_MIN_OUTCOMES = 30;

export const SCEO_FEATURE_SLUG = "sales-cold-email-outreach";
export const SCEO_WEBSITE_VISIT_LEG = "lead_found_to_website_visit";
export const SCEO_POSITIVE_REPLY_LEG = "lead_found_to_conversation";

export type FleetIndexOutcome = "website_visit" | "positive_reply" | "meeting_booked";

export interface FleetIndexDefinition {
  slug: string;
  name: string;
  /** The channel the index measures, as served (`/public/channels`). */
  channelSlug: string;
  channelName: string;
  outcome: FleetIndexOutcome;
  metric: "cost_per_outcome" | "conversion_rate";
  unit: FleetIndexUnit;
  /** What one unit of the value is, in words ("per website visit", "of people emailed"). */
  valuePer: string;
  /** How the value is computed, one plain sentence. */
  method: string;
}

const CHANNEL = { channelSlug: SCEO_FEATURE_SLUG, channelName: "Sales Cold Email Outreach" } as const;

export const FLEET_INDEXES: readonly FleetIndexDefinition[] = [
  {
    slug: "sceo-cost-per-click",
    name: "Distribute.you Cost Per Click Index",
    ...CHANNEL,
    outcome: "website_visit",
    metric: "cost_per_outcome",
    unit: "usd",
    valuePer: "per website visit",
    method: "What our best proven cold email workflow spends to bring one person to a client's website, counting only clicks judged human.",
  },
  {
    slug: "sceo-click-rate",
    name: "Distribute.you Click Rate Index",
    ...CHANNEL,
    outcome: "website_visit",
    metric: "conversion_rate",
    unit: "percent",
    valuePer: "of people emailed",
    method: "Share of the people emailed by our best proven cold email workflow who visit the client's website.",
  },
  {
    slug: "sceo-cost-per-interest",
    name: "Distribute.you Cost Per Interest Index",
    ...CHANNEL,
    outcome: "positive_reply",
    metric: "cost_per_outcome",
    unit: "usd",
    valuePer: "per positive reply",
    method: "What our best proven cold email workflow spends to get one positive reply.",
  },
  {
    slug: "sceo-interest-rate",
    name: "Distribute.you Interest Rate Index",
    ...CHANNEL,
    outcome: "positive_reply",
    metric: "conversion_rate",
    unit: "percent",
    valuePer: "of people emailed",
    method: "Share of the people emailed by our best proven cold email workflow who reply with interest.",
  },
  {
    slug: "sceo-cost-per-meeting",
    name: "Distribute.you Cost Per Meeting Index",
    ...CHANNEL,
    outcome: "meeting_booked",
    metric: "cost_per_outcome",
    unit: "usd",
    valuePer: "per meeting booked",
    method: "The Cost Per Interest Index divided by the share of positive replies that book a meeting, measured on our clients.",
  },
  {
    slug: "sceo-meeting-rate",
    name: "Distribute.you Meeting Rate Index",
    ...CHANNEL,
    outcome: "meeting_booked",
    metric: "conversion_rate",
    unit: "percent",
    valuePer: "of people emailed",
    method: "The Interest Rate Index times the share of positive replies that book a meeting, measured on our clients.",
  },
];

export function fleetIndexBySlug(slug: string): FleetIndexDefinition | undefined {
  return FLEET_INDEXES.find((d) => d.slug === slug);
}

/** One recorded value of one index. */
export interface FleetIndexPoint {
  indexSlug: string;
  /** null = could not be stated today, `unavailableReason` says why. Never a 0 for unknown. */
  value: number | null;
  status: FleetIndexStatus;
  /** Outcomes behind the value (the weakest link of a chain). */
  outcomes: number;
  /** People emailed behind the value; null when the value is chained on a population we do not count. */
  contacted: number | null;
  workflowDynastySlug: string | null;
  workflowDynastyName: string | null;
  unavailableReason: string | null;
  /** The figures the value was built from, for a reader who asks. */
  inputs: Record<string, number | string | null>;
}

export function indexStatus(outcomes: number, mature: boolean): FleetIndexStatus {
  if (!mature || outcomes < SIGNAL_MIN_OUTCOMES) return "noise";
  return outcomes < ROBUST_MIN_OUTCOMES ? "signal" : "robust";
}

const STATUS_ORDER: Record<FleetIndexStatus, number> = { noise: 0, signal: 1, robust: 2 };
export function weakestStatus(a: FleetIndexStatus, b: FleetIndexStatus): FleetIndexStatus {
  return STATUS_ORDER[a] <= STATUS_ORDER[b] ? a : b;
}

/** The fleet's measured Positive reply -> Meeting booked: people who replied with interest, and of them booked. */
export interface MeetingFromReplyFleet {
  positiveReplyPeople: number;
  bookedPeople: number;
  brandCount: number;
}

export interface FleetIndexInputs {
  /** null = the ranking could not be read: no point is recorded for its indexes. */
  websiteVisitRows: LegWorkflowRankingRow[] | null;
  positiveReplyRows: LegWorkflowRankingRow[] | null;
  /** null = unreadable: no point is recorded for the meeting indexes. */
  meetingFromReply: MeetingFromReplyFleet | null;
}

/** The row a client's money goes to today: best mature workflow that can still run. */
function bestMature(rows: LegWorkflowRankingRow[]): LegWorkflowRankingRow | null {
  return rows.find((r) => r.moneyGoesHere && r.selectable && r.basis === "mature") ?? null;
}

function legPoint(def: FleetIndexDefinition, rows: LegWorkflowRankingRow[]): FleetIndexPoint {
  const best = bestMature(rows);
  if (!best) {
    return {
      indexSlug: def.slug,
      value: null,
      status: "noise",
      outcomes: 0,
      contacted: null,
      workflowDynastySlug: null,
      workflowDynastyName: null,
      unavailableReason: "no_mature_workflow",
      inputs: {},
    };
  }
  const value = def.metric === "cost_per_outcome" ? best.costPerOutcomeUsd : best.conversionRatePct;
  return {
    indexSlug: def.slug,
    value,
    status: indexStatus(best.outcomes, true),
    outcomes: best.outcomes,
    contacted: best.contacted,
    workflowDynastySlug: best.workflowDynastySlug,
    workflowDynastyName: best.workflowDynastyName,
    unavailableReason: value == null ? "not_measured" : null,
    inputs: { spentUsd: best.spentUsd, outcomes: best.outcomes, contacted: best.contacted },
  };
}

function meetingPoint(def: FleetIndexDefinition, replyRows: LegWorkflowRankingRow[], fleet: MeetingFromReplyFleet): FleetIndexPoint {
  const reply = legPoint(def.metric === "cost_per_outcome" ? COST_PER_INTEREST : INTEREST_RATE, replyRows);
  const base = { indexSlug: def.slug, workflowDynastySlug: reply.workflowDynastySlug, workflowDynastyName: reply.workflowDynastyName, contacted: null };
  const rateFraction = fleet.positiveReplyPeople > 0 ? fleet.bookedPeople / fleet.positiveReplyPeople : null;
  const inputs = {
    replyIndexValue: reply.value,
    replyIndexOutcomes: reply.outcomes,
    positiveReplyPeople: fleet.positiveReplyPeople,
    meetingsBookedPeople: fleet.bookedPeople,
    positiveReplyToMeetingPct: rateFraction == null ? null : rateFraction * 100,
    brandCount: fleet.brandCount,
  };
  const outcomes = Math.min(reply.outcomes, fleet.bookedPeople);
  const status = weakestStatus(reply.status, indexStatus(fleet.bookedPeople, true));
  let value: number | null = null;
  let unavailableReason: string | null = reply.unavailableReason;
  if (reply.value != null) {
    if (rateFraction == null || rateFraction === 0) unavailableReason = "no_meeting_measured";
    else value = def.metric === "cost_per_outcome" ? reply.value / rateFraction : reply.value * rateFraction;
  }
  return { ...base, value, status: value == null ? "noise" : status, outcomes, unavailableReason: value == null ? unavailableReason : null, inputs };
}

const COST_PER_INTEREST = fleetIndexBySlug("sceo-cost-per-interest")!;
const INTEREST_RATE = fleetIndexBySlug("sceo-interest-rate")!;

/** PURE. Today's point of every index whose inputs were readable (an unreadable input records nothing). */
export function computeFleetIndexPoints(inputs: FleetIndexInputs): FleetIndexPoint[] {
  const points: FleetIndexPoint[] = [];
  for (const def of FLEET_INDEXES) {
    if (def.outcome === "website_visit" && inputs.websiteVisitRows) points.push(legPoint(def, inputs.websiteVisitRows));
    if (def.outcome === "positive_reply" && inputs.positiveReplyRows) points.push(legPoint(def, inputs.positiveReplyRows));
    if (def.outcome === "meeting_booked" && inputs.positiveReplyRows && inputs.meetingFromReply) {
      points.push(meetingPoint(def, inputs.positiveReplyRows, inputs.meetingFromReply));
    }
  }
  return points;
}
