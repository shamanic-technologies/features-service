/**
 * THE PUBLIC FLEET INDEXES (owner 2026-10-18): one number per index, recorded every day, so a reader can see
 * where the market price of an outcome stands today and how it moved. "SCEO" (Sales Cold Email Outreach) is an internal prefix only: public names read "Distribute.you <metric> Index" (owner 2026-10-18).
 *
 * Every index is read off figures this service already serves, never a second computation:
 * - the cost / rate of a pipe's outcome = the BEST MATURE workflow of the pipe that can still run
 *   (`/public/stats/leg-workflow-ranking`, the row `moneyGoesHere`): what a client buys today. A workflow
 *   that no longer runs is out, so the curve never freezes on a retired one;
 * - every figure is a PIPE figure (owner 2026-10-18, MB-INDEX-PIPES-1018: « On ne compte pour l'index que des cost de
 *   pipe »), never a rate pooled over the fleet's people. The meeting index is the only CHAIN, the owner's formula:
 *   cost per meeting = (cost per positive reply of the best workflow on Lead found -> Positive reply)
 *                      ÷ (Positive reply -> Meeting booked rate of the best workflow on the AI Meeting Booking pipe)
 *                      + (that same workflow's cost per meeting booked: what turning a reply into a meeting costs).
 *   The meeting pipe is measured on the brands that REPORT meetings only (`lib/meeting-population.ts`). While no
 *   workflow there is mature, the best one AVAILABLE today stands in (owner: « Affiche l'index dès maintenant »):
 *   the cheapest runnable workflow with a meeting, else the pipe as a whole (every workflow pooled: a campaign run by
 *   several workflows cannot say which booked), always `noise` with the meetings it rests on.
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
    method: "What our best cold email workflow spends for one positive reply, divided by the share of positive replies our best AI meeting booking workflow turns into a meeting, plus what that workflow spends per meeting. Measured on the clients who report their booked meetings to us.",
  },
  {
    slug: "sceo-meeting-rate",
    name: "Distribute.you Meeting Rate Index",
    ...CHANNEL,
    outcome: "meeting_booked",
    metric: "conversion_rate",
    unit: "percent",
    valuePer: "of people emailed",
    method: "The Interest Rate Index times the share of positive replies our best AI meeting booking workflow turns into a meeting. Measured on the clients who report their booked meetings to us.",
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

/** The AI Meeting Booking pipe (Positive reply -> Meeting booked), on the brands that report meetings. */
export interface MeetingPipeEvidence {
  /** The pipe's leg workflow ranking rows. */
  rows: readonly LegWorkflowRankingRow[];
  /** The whole pipe, every workflow pooled (`MeetingLegFleet.pooled`). */
  pooled: { spentUsd: number; contacted: number; outcomes: number; spentByDynasty: Record<string, number> };
}

/** What the meeting pipe is read on today: the best workflow, or the pipe as a whole while no workflow owns a meeting. */
export interface MeetingPipePick {
  source: "mature_workflow" | "best_workflow_learning" | "pipe_all_workflows";
  workflowDynastySlug: string | null;
  workflowDynastyName: string | null;
  mature: boolean;
  spentUsd: number;
  /** Positive repliers its campaigns acted on. */
  contacted: number;
  /** Of them, booked a meeting. */
  outcomes: number;
  costPerMeetingUsd: number;
  /** Positive reply -> Meeting booked, % of the people acted on. */
  ratePct: number;
  /** `pipe_all_workflows` only: spend per workflow on the pipe. */
  spentByDynasty: Record<string, number> | null;
}

/**
 * PURE. The meeting pipe's best workflow (MB-INDEX-PIPES-1018): the best MATURE runnable one (`moneyGoesHere`), else the
 * cheapest runnable workflow with a meeting, else the whole pipe pooled. Null = no meeting on the pipe at all.
 */
export function bestMeetingPipePick(e: MeetingPipeEvidence): MeetingPipePick | null {
  const asPick = (r: LegWorkflowRankingRow, source: MeetingPipePick["source"]): MeetingPipePick => ({
    source,
    workflowDynastySlug: r.workflowDynastySlug,
    workflowDynastyName: r.workflowDynastyName,
    mature: source === "mature_workflow",
    spentUsd: r.spentUsd,
    contacted: r.contacted,
    outcomes: r.outcomes,
    costPerMeetingUsd: r.spentUsd / r.outcomes,
    ratePct: (r.outcomes / r.contacted) * 100,
    spentByDynasty: null,
  });
  const measured = (r: LegWorkflowRankingRow) => r.selectable && r.outcomes > 0 && r.contacted > 0;
  const mature = bestMature([...e.rows]);
  if (mature && measured(mature)) return asPick(mature, "mature_workflow");
  const learning = e.rows.filter(measured).sort((a, b) => a.spentUsd / a.outcomes - b.spentUsd / b.outcomes || b.outcomes - a.outcomes || (a.workflowDynastySlug < b.workflowDynastySlug ? -1 : 1))[0];
  if (learning) return asPick(learning, "best_workflow_learning");
  const p = e.pooled;
  if (p.outcomes <= 0 || p.contacted <= 0) return null;
  return {
    source: "pipe_all_workflows",
    workflowDynastySlug: null,
    workflowDynastyName: null,
    mature: false,
    spentUsd: p.spentUsd,
    contacted: p.contacted,
    outcomes: p.outcomes,
    costPerMeetingUsd: p.spentUsd / p.outcomes,
    ratePct: (p.outcomes / p.contacted) * 100,
    spentByDynasty: p.spentByDynasty,
  };
}

export interface FleetIndexInputs {
  /** null = the ranking could not be read: no point is recorded for its indexes. */
  websiteVisitRows: LegWorkflowRankingRow[] | null;
  positiveReplyRows: LegWorkflowRankingRow[] | null;
  /** null = unreadable: no point is recorded for the meeting indexes. */
  meetingPipe: MeetingPipeEvidence | null;
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

function meetingPoint(def: FleetIndexDefinition, replyRows: LegWorkflowRankingRow[], pipe: MeetingPipeEvidence): FleetIndexPoint {
  const cost = def.metric === "cost_per_outcome";
  const reply = legPoint(cost ? COST_PER_INTEREST : INTEREST_RATE, replyRows);
  const mb = bestMeetingPipePick(pipe);
  const inputs: Record<string, number | string | null> = {
    formula: cost ? "interest_cost / meeting_rate + meeting_pipe_cost_per_meeting" : "interest_rate * meeting_rate",
    interestWorkflowDynastySlug: reply.workflowDynastySlug,
    interestWorkflowDynastyName: reply.workflowDynastyName,
    interestIndexValue: reply.value,
    interestOutcomes: reply.outcomes,
    interestStatus: reply.status,
    meetingPipe: "ai-meeting-booking|conversation_to_meeting_booked",
    meetingPipeSource: mb?.source ?? null,
    meetingWorkflowDynastySlug: mb?.workflowDynastySlug ?? null,
    meetingWorkflowDynastyName: mb?.workflowDynastyName ?? null,
    meetingPipeSpentUsd: mb?.spentUsd ?? null,
    positiveRepliesActedOn: mb?.contacted ?? null,
    meetingsBooked: mb?.outcomes ?? null,
    interestToMeetingPct: mb?.ratePct ?? null,
    meetingPipeCostPerMeetingUsd: mb?.costPerMeetingUsd ?? null,
    meetingPipeSpentByDynasty: mb?.spentByDynasty ? JSON.stringify(mb.spentByDynasty) : null,
    population: "brands_reporting_meetings",
  };
  const base = { indexSlug: def.slug, workflowDynastySlug: reply.workflowDynastySlug, workflowDynastyName: reply.workflowDynastyName, contacted: null, inputs };
  if (reply.value == null || !mb) {
    return { ...base, value: null, status: "noise", outcomes: 0, unavailableReason: reply.value == null ? reply.unavailableReason : "no_meeting_on_pipe" };
  }
  const rate = mb.ratePct / 100;
  const value = cost ? reply.value / rate + mb.costPerMeetingUsd : reply.value * rate;
  return {
    ...base,
    value,
    status: weakestStatus(reply.status, indexStatus(mb.outcomes, mb.mature)),
    outcomes: Math.min(reply.outcomes, mb.outcomes),
    unavailableReason: null,
  };
}

const COST_PER_INTEREST = fleetIndexBySlug("sceo-cost-per-interest")!;
const INTEREST_RATE = fleetIndexBySlug("sceo-interest-rate")!;

/** PURE. Today's point of every index whose inputs were readable (an unreadable input records nothing). */
export function computeFleetIndexPoints(inputs: FleetIndexInputs): FleetIndexPoint[] {
  const points: FleetIndexPoint[] = [];
  for (const def of FLEET_INDEXES) {
    if (def.outcome === "website_visit" && inputs.websiteVisitRows) points.push(legPoint(def, inputs.websiteVisitRows));
    if (def.outcome === "positive_reply" && inputs.positiveReplyRows) points.push(legPoint(def, inputs.positiveReplyRows));
    if (def.outcome === "meeting_booked" && inputs.positiveReplyRows && inputs.meetingPipe) {
      points.push(meetingPoint(def, inputs.positiveReplyRows, inputs.meetingPipe));
    }
  }
  return points;
}
