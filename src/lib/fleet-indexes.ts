/**
 * THE PUBLIC FLEET INDEXES (owner 2026-10-18): one number per index, recorded every day, so a reader can see
 * where the market price of an outcome stands today and how it moved. "SCEO" (Sales Cold Email Outreach) is an internal prefix only: public names read "Cold Email <metric> Index", slugs `cold-email-*` (owner 2026-10-19, INDEX-SLUGS-SEO-1019: SEO names, no "Distribute.you").
 *
 * Every index is read off figures this service already serves, never a second computation:
 * - the cost / rate of a cold email outcome = the BEST script of the `email_sent` Engine that can still run
 *   (PUBLIC-INDEXES-NULL-1117, `lib/script-index-rows.ts`: each script measured on the general ledger's daily book, the
 *   Research Engine measure's rule; the best MATURE one, else the best AVAILABLE one once it reaches the noise bar, `noise`; below it null `not_measured`, INDEX-VISITS-1117):
 *   Since INDEX-HISTORY-1117 (owner 2026-11-17) the candidates are every era's: the Engine's scripts AND the pipe's
 *   workflows on their whole history (`indexRowsWithHistory`), the cheapest PROVEN one (mature, >= the noise bar) wins,
 *   runnable or not. Before 2026-11-09 the days read the per-pipe leg workflow ranking (`moneyGoesHere`), the rule their
 *   recomputed history keeps;
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
 * One index is a CLIENT figure, not a pipe figure (owner 2026-10-19): the median client's cost per engaged lead (the
 * landing hero's figure: per brand total spend (`/public/stats/ranked?groupBy=brand`) ÷ (persons who replied positively +
 * persons whose click was judged HUMAN, the fleet person cell: owner 2026-10-19, a scanner's click is not a visit), brands
 * with both; ≥ 2 brands). Only a send through our own transport can have its click judged, so a brand's human clicks are
 * read over its whole reach at the rate measured on those sends (× contacted ÷ screened contacted): the byte-same
 * screenable-share correction the Cost Per Click Index applies to spend (`lib/screened-visits.ts`). Without it, lifetime
 * spend over clicks judgeable only since recently read $105.61 against $10.48 (2026-10-19). Its status counts the CLIENTS
 * behind the median (`outcomes` = clients), the same bars. The client ROI index (`cold-email-roi`) is deleted
 * (ROI-CONSISTENCY-1103): no longer recorded nor served, its stored rows kept.
 *
 * Each value carries a `status` saying how far to trust it, from the outcomes behind it (the weakest link of a
 * chain): `noise` under `SIGNAL_MIN_OUTCOMES` (the maturity bar, `lib/maturity.ts`) or with no mature workflow,
 * `signal` under `ROBUST_MIN_OUTCOMES` (the usual n ≥ 30 rule of thumb for a stable sample mean), else `robust`.
 *
 * PURE: the recorder (`fleet-index-recorder.ts`) reads the inputs, this turns them into points.
 */
import type { LegWorkflowRankingRow } from "./leg-workflow-ranking.js";
import type { IndexRow, PooledPipe } from "./fleet-index-vendor.js";
import { VENDOR_COST_UNKNOWN } from "./public-vendor-cost.js";

export type FleetIndexStatus = "robust" | "signal" | "noise";
export type FleetIndexUnit = "usd" | "percent";

export const SIGNAL_MIN_OUTCOMES = 10;
export const ROBUST_MIN_OUTCOMES = 30;

export const SCEO_FEATURE_SLUG = "sales-cold-email-outreach";
export const SCEO_WEBSITE_VISIT_LEG = "lead_found_to_website_visit";
export const SCEO_POSITIVE_REPLY_LEG = "lead_found_to_conversation";

export type FleetIndexOutcome = "website_visit" | "positive_reply" | "meeting_booked" | "engaged_lead";

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
    slug: "cold-email-cost-per-click",
    name: "Cold Email Cost Per Click Index",
    ...CHANNEL,
    outcome: "website_visit",
    metric: "cost_per_outcome",
    unit: "usd",
    valuePer: "per website visit",
    method: "Our real vendor cost, with no markup, for our best proven cold email workflow to bring one person to a client's website. Only clicks judged human count.",
  },
  {
    slug: "cold-email-click-rate",
    name: "Cold Email Click Rate Index",
    ...CHANNEL,
    outcome: "website_visit",
    metric: "conversion_rate",
    unit: "percent",
    valuePer: "of people emailed",
    method: "Share of the people emailed by our best proven cold email workflow who visit the client's website.",
  },
  {
    slug: "cold-email-cost-per-positive-reply",
    name: "Cold Email Cost Per Positive Reply Index",
    ...CHANNEL,
    outcome: "positive_reply",
    metric: "cost_per_outcome",
    unit: "usd",
    valuePer: "per positive reply",
    method: "Our real vendor cost, with no markup, for our best proven cold email workflow to get one positive reply.",
  },
  {
    slug: "cold-email-positive-reply-rate",
    name: "Cold Email Positive Reply Rate Index",
    ...CHANNEL,
    outcome: "positive_reply",
    metric: "conversion_rate",
    unit: "percent",
    valuePer: "of people emailed",
    method: "Share of the people emailed by our best proven cold email workflow who reply positively.",
  },
  {
    slug: "cold-email-cost-per-meeting",
    name: "Cold Email Cost Per Meeting Index",
    ...CHANNEL,
    outcome: "meeting_booked",
    metric: "cost_per_outcome",
    unit: "usd",
    valuePer: "per meeting booked",
    method: "Our real vendor cost, with no markup, to book one meeting, from finding the lead to the meeting itself: every client, every path, the leads that never replied included.",
  },
  {
    slug: "cold-email-meeting-rate",
    name: "Cold Email Meeting Rate Index",
    ...CHANNEL,
    outcome: "meeting_booked",
    metric: "conversion_rate",
    unit: "percent",
    valuePer: "of people emailed",
    method: "The Cold Email Positive Reply Rate Index times the share of positive replies our best AI meeting booking workflow turns into a meeting. Measured on the clients who report their booked meetings to us.",
  },
  {
    slug: "cold-email-cost-per-engaged-lead",
    name: "Cold Email Cost Per Engaged Lead Index",
    ...CHANNEL,
    outcome: "engaged_lead",
    metric: "cost_per_outcome",
    unit: "usd",
    valuePer: "per engaged lead, median of our clients",
    method: "Each client's cold email cost, at real vendor cost with no markup, divided by its engaged leads (people who replied positively, or visited its website from our email, link scanners left out), then the median across our clients.",
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
  /** The pipe's leg workflow ranking rows (on the vendor basis, `lib/fleet-index-vendor.ts`). */
  rows: readonly IndexRow[];
  /** The whole pipe, every workflow pooled (`MeetingLegFleet.pooled`). */
  pooled: PooledPipe;
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
  /** The pick's spend lacks a vendor cost past the tolerance: its money prices nothing (PUBLIC-VENDOR-COST-1031). */
  vendorCostUnknown?: boolean;
}

/**
 * PURE. The meeting pipe's best workflow (MB-INDEX-PIPES-1018): the best MATURE runnable one (`moneyGoesHere`), else the
 * cheapest runnable workflow with a meeting, else the whole pipe pooled. Null = no meeting on the pipe at all.
 */
export function bestMeetingPipePick(e: MeetingPipeEvidence): MeetingPipePick | null {
  const asPick = (r: IndexRow, source: MeetingPipePick["source"]): MeetingPipePick => ({
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
    ...(r.vendorCostUnknown !== undefined ? { vendorCostUnknown: r.vendorCostUnknown } : {}),
  });
  const measured = (r: IndexRow) => r.selectable && r.outcomes > 0 && r.contacted > 0;
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
    ...(p.vendorCostUnknown !== undefined ? { vendorCostUnknown: p.vendorCostUnknown } : {}),
  };
}

export interface FleetIndexInputs {
  /** null = the ranking could not be read: no point is recorded for its indexes. */
  websiteVisitRows: IndexRow[] | null;
  positiveReplyRows: IndexRow[] | null;
  /** null = unreadable: no point is recorded for the meeting rate index. */
  meetingPipe: MeetingPipeEvidence | null;
  /**
   * The ledger's production cost of one booked meeting (MEETING-COST-METHODS-1024, owner 2026-10-24 « go ledger
   * accounting direct »): the Cost Per Meeting Index. null / absent = unreadable or not read: nothing recorded for it.
   */
  meetingLedger?: LedgerMeetingCost | null;
  /** The outcome prices' expected meeting price (`/public/stats/outcome-prices`), served while the ledger is not a price. */
  meetingExpected?: ExpectedMeetingPrice | null;
  /** One entry per client brand (`/public/stats/ranked?groupBy=brand`); null = unreadable, nothing recorded. */
  brandEngagement?: BrandEngagement[] | null;
  /**
   * The best AVAILABLE runnable row stands in while none is mature (`indexPipePick`, PUBLIC-INDEXES-NULL-1117): the live
   * recorder and the scripts' era history set it. Absent / false = the workflow era's rule (mature or null
   * `no_mature_workflow`), kept by its history run so a past day recomputed again never moves.
   */
  bestAvailableStandsIn?: boolean;
}

/** A client brand's lifetime cold email spend and engaged persons. */
export interface BrandEngagement {
  /** Persons the brand's cold email reached. */
  contacted: number;
  positiveReplies: number;
  /** Of `contacted`, persons emailed through our own transport: the only sends whose click can be judged. */
  screenedContacted: number;
  /** Persons whose click was judged human (never a provider-reported click: mostly link scanners). */
  humanClicks: number;
  spendCents: number;
  /** The brand's spend lacks a vendor cost past the tolerance (PUBLIC-VENDOR-COST-1031): the median prices nothing. */
  vendorCostUnknown?: boolean;
}

/** PURE. A brand's visits over its whole reach: human clicks at the rate measured on its judgeable sends; none judgeable = 0. */
export function brandVisits(b: BrandEngagement): number {
  return b.screenedContacted > 0 ? (b.humanClicks * b.contacted) / b.screenedContacted : 0;
}

/** A median over a single brand is that brand's own price, not a fleet figure (the landing's bar). */
export const MIN_ENGAGED_LEAD_CLIENTS = 2;

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function clientPoint(def: FleetIndexDefinition, value: number | null, clients: number, reason: string | null, inputs: FleetIndexPoint["inputs"]): FleetIndexPoint {
  return {
    indexSlug: def.slug,
    value,
    status: value == null ? "noise" : indexStatus(clients, true),
    outcomes: clients,
    contacted: null,
    workflowDynastySlug: null,
    workflowDynastyName: null,
    unavailableReason: value == null ? reason : null,
    inputs,
  };
}

/** PURE. The median client's cost per engaged lead (positive replies + human clicks). */
export function engagedLeadPoint(brands: readonly BrandEngagement[]): FleetIndexPoint {
  const def = COST_PER_ENGAGED_LEAD;
  // A client whose vendor cost is not known is left out of the median and COUNTED in the inputs (never silently).
  const unknown = brands.filter((b) => b.vendorCostUnknown && b.positiveReplies + brandVisits(b) > 0).length;
  const priced = brands
    .filter((b) => !b.vendorCostUnknown)
    .map((b) => ({ engaged: b.positiveReplies + brandVisits(b), spendCents: b.spendCents }))
    .filter((b) => b.engaged > 0 && b.spendCents > 0);
  const engagedLeads = Math.round(priced.reduce((t, b) => t + b.engaged, 0));
  const inputs = { population: "clients_with_engaged_lead_and_spend", clicks: "judged_human_over_reach", clients: priced.length, engagedLeads, minClients: MIN_ENGAGED_LEAD_CLIENTS, ...(unknown > 0 ? { clientsVendorCostUnknown: unknown } : {}) };
  if (priced.length < MIN_ENGAGED_LEAD_CLIENTS) return clientPoint(def, null, priced.length, "not_enough_clients", inputs);
  const value = median(priced.map((b) => b.spendCents / 100 / b.engaged).sort((a, b) => a - b));
  return clientPoint(def, value, priced.length, null, inputs);
}

/** The row a client's money goes to today: best mature workflow that can still run. */
function bestMature(rows: IndexRow[]): IndexRow | null {
  return rows.find((r) => r.moneyGoesHere && r.selectable && r.basis === "mature") ?? null;
}

/**
 * PURE. What a pipe's index is read on today (INDEX-HISTORY-1117, was PUBLIC-INDEXES-NULL-1117): the best PROVEN row of any
 * era (`moneyGoesHere` on the rows `indexRowsWithHistory` merged: mature, >= the noise bar, runnable or not), else the BEST
 * AVAILABLE one: the runnable row with a measured outcome the ranking puts first (its `rank`, the ONE leg
 * order, read on the billed evidence, so the billed and the vendor series pick the same script). Since MIGRATE-1105 every
 * campaign runs Engine SCRIPTS and every workflow is retired (prod 2026-11-09: Ballad, the money workflow of the reply
 * index, stopped running); a script is younger than the 21-day maturity cut, so no row was mature and six indexes read
 * null for eight days. The best available stands in, always `noise`, but ONLY once its own outcomes reach the noise bar
 * (`SIGNAL_MIN_OUTCOMES`, the maturity bar of `lib/maturity.ts`; owner 2026-11-17, INDEX-VISITS-1117: « a public index
 * must not print a value built on 1 outcome as if it were a price »: $280 per website visit and 0.014% off ONE visit on
 * 7,288 emails, beside 1.6% on 18 visits the day before). Below it the point is null `not_measured`, its outcomes kept.
 * Null = no runnable row cleared the bar. (The meeting pipe's own stand-in, `bestMeetingPipePick`, keeps its owner rule.)
 */
export function indexPipePick(rows: readonly IndexRow[], bestAvailableStandsIn = true): { row: IndexRow; mature: boolean } | null {
  if (!bestAvailableStandsIn) {
    const mature = bestMature([...rows]);
    return mature ? { row: mature, mature: true } : null;
  }
  // INDEX-HISTORY-1117: the best PROVEN row of any era (a workflow or script that no longer runs keeps its results), from
  // the noise bar; `indexRowsWithHistory` puts it first and marks it `moneyGoesHere`.
  const proven = rows.find((r) => r.moneyGoesHere && isProvenIndexRow(r));
  if (proven) return { row: proven, mature: true };
  const learning = bestAvailableLearning(rows);
  return learning && learning.outcomes >= SIGNAL_MIN_OUTCOMES ? { row: learning, mature: false } : null;
}

/**
 * PURE. A row whose figure is a price on a public index (INDEX-HISTORY-1117): mature on its leg AND at least the noise bar
 * of outcomes (`SIGNAL_MIN_OUTCOMES`; owner 2026-11-17: never a value built on 1 outcome), runnable or not.
 */
export function isProvenIndexRow(r: Pick<IndexRow, "basis" | "outcomes">): boolean {
  return r.basis === "mature" && r.outcomes >= SIGNAL_MIN_OUTCOMES;
}

/** The runnable row with a measured outcome the ONE leg order puts first (billed rank, so both bases pick the same). */
function bestAvailableLearning(rows: readonly IndexRow[]): IndexRow | undefined {
  return rows
    .filter((r) => r.selectable && r.outcomes > 0 && r.contacted > 0)
    .sort((a, b) => a.rank - b.rank || (a.workflowDynastySlug < b.workflowDynastySlug ? -1 : 1))[0];
}

/**
 * PURE. A cold email index while no script or workflow is PROVEN on the leg (INDEX-HISTORY-1117, owner go 2026-11-17: « 2.
 * ok », the landing prints it with its "Expected" tag): an EXPECTED figure built from what we measured, `valueKind:
 * "expected"`, always `noise`, every input on the point.
 *   rate  = the leg's measured conversion over every script and workflow it ever ran (Σ outcomes ÷ Σ people reached), a
 *           RATE hypothesis, never a cost pooled across dynasties;
 *   cost  = the subject dynasty's OWN measured cost per person reached ÷ that rate. Subject = the best available runnable
 *           script (`bestAvailableLearning`), else the runnable script that reached the most people.
 * Null (the caller's true reason) when the leg never measured an outcome or nothing runnable reached anybody.
 */
export function expectedLegPoint(def: FleetIndexDefinition, rows: readonly IndexRow[]): FleetIndexPoint | null {
  const outcomes = rows.reduce((t, r) => t + r.outcomes, 0);
  const reached = rows.reduce((t, r) => t + r.contacted, 0);
  if (outcomes <= 0 || reached <= 0) return null;
  const subject = bestAvailableLearning(rows) ?? [...rows].filter((r) => r.selectable && r.contacted > 0).sort((a, b) => b.contacted - a.contacted || (a.workflowDynastySlug < b.workflowDynastySlug ? -1 : 1))[0];
  if (!subject) return null;
  const ratePct = (100 * outcomes) / reached;
  const costPerReachedUsd = subject.spentUsd / subject.contacted;
  const cost = def.metric === "cost_per_outcome";
  const unknown = cost && subject.vendorCostUnknown === true;
  const value = cost ? (unknown || costPerReachedUsd <= 0 ? null : costPerReachedUsd / (ratePct / 100)) : ratePct;
  return {
    indexSlug: def.slug,
    value,
    status: "noise",
    outcomes: subject.outcomes,
    contacted: subject.contacted,
    workflowDynastySlug: subject.workflowDynastySlug,
    workflowDynastyName: subject.workflowDynastyName,
    unavailableReason: value === null ? (unknown ? VENDOR_COST_UNKNOWN : "not_measured") : null,
    inputs: {
      valueKind: "expected",
      method: "expected_measured_rates",
      formula: cost ? "subject_cost_per_person_reached / leg_measured_rate" : "leg_measured_rate",
      pick: "expected_below_noise_bar",
      outcomesRequired: SIGNAL_MIN_OUTCOMES,
      legOutcomes: outcomes,
      legReached: reached,
      legRatePct: ratePct,
      subjectSpentUsd: subject.spentUsd,
      subjectReached: subject.contacted,
      subjectOutcomes: subject.outcomes,
      subjectCostPerReachedUsd: costPerReachedUsd,
      ...(subject.unpricedSharePct !== undefined ? { unpricedSharePct: subject.unpricedSharePct } : {}),
    },
  };
}

function legPoint(def: FleetIndexDefinition, rows: IndexRow[], bestAvailableStandsIn: boolean): FleetIndexPoint {
  const pick = indexPipePick(rows, bestAvailableStandsIn);
  if (!pick && !bestAvailableStandsIn) {
    // The workflow era's rule, kept for its recomputed past days (a past day never moves): mature or nothing.
    return { indexSlug: def.slug, value: null, status: "noise", outcomes: 0, contacted: null, workflowDynastySlug: null, workflowDynastyName: null, unavailableReason: "no_mature_workflow", inputs: {} };
  }
  if (!pick) {
    // INDEX-HISTORY-1117 (owner go 2026-11-17, « 2. ok »): nothing proven yet = the EXPECTED figure from our measured
    // rates, labelled expected, never a blank index while we hold data.
    const expected = expectedLegPoint(def, rows);
    if (expected) return expected;
    // A runnable row measured the outcome, under the noise bar: not a price yet, said with what it rests on.
    const below = bestAvailableLearning(rows);
    if (below) {
      return {
        indexSlug: def.slug,
        value: null,
        status: "noise",
        outcomes: below.outcomes,
        contacted: below.contacted,
        workflowDynastySlug: below.workflowDynastySlug,
        workflowDynastyName: below.workflowDynastyName,
        unavailableReason: "not_measured",
        inputs: { pick: "below_noise_bar", outcomesRequired: SIGNAL_MIN_OUTCOMES, outcomes: below.outcomes, contacted: below.contacted, spentUsd: below.spentUsd },
      };
    }
    return {
      indexSlug: def.slug,
      value: null,
      status: "noise",
      outcomes: 0,
      contacted: null,
      workflowDynastySlug: null,
      workflowDynastyName: null,
      // True reason: nothing that can run today has measured the outcome yet (a retired script or workflow never stands in).
      unavailableReason: rows.length === 0 ? "no_script_ran_yet" : rows.some((r) => r.selectable) ? "not_measured" : "nothing_runnable_on_pipe",
      inputs: {},
    };
  }
  const best = pick.row;
  const value = def.metric === "cost_per_outcome" ? best.costPerOutcomeUsd : best.conversionRatePct;
  return {
    indexSlug: def.slug,
    value,
    status: indexStatus(best.outcomes, pick.mature),
    outcomes: best.outcomes,
    contacted: best.contacted,
    workflowDynastySlug: best.workflowDynastySlug,
    workflowDynastyName: best.workflowDynastyName,
    unavailableReason: value == null ? (best.vendorCostUnknown ? VENDOR_COST_UNKNOWN : "not_measured") : null,
    inputs: {
      pick: pick.mature ? (bestAvailableStandsIn ? "best_proven" : "best_mature") : "best_available_learning",
      ...(bestAvailableStandsIn ? { runsToday: best.selectable ? "yes" : "no" } : {}),
      basis: best.basis,
      spentUsd: best.spentUsd,
      outcomes: best.outcomes,
      contacted: best.contacted,
      ...(best.unpricedSharePct !== undefined ? { unpricedSharePct: best.unpricedSharePct } : {}),
    },
  };
}

function meetingPoint(def: FleetIndexDefinition, replyRows: IndexRow[], pipe: MeetingPipeEvidence, bestAvailableStandsIn: boolean): FleetIndexPoint {
  const cost = def.metric === "cost_per_outcome";
  const reply = legPoint(cost ? COST_PER_INTEREST : INTEREST_RATE, replyRows, bestAvailableStandsIn);
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
  // The rate index reads no money; the cost index never prices a pick whose vendor cost is unknown.
  if (cost && mb.vendorCostUnknown) return { ...base, value: null, status: "noise", outcomes: 0, unavailableReason: VENDOR_COST_UNKNOWN };
  const rate = mb.ratePct / 100;
  const value = cost ? reply.value / rate + mb.costPerMeetingUsd : reply.value * rate;
  // An EXPECTED interest figure (nothing proven on the reply leg, INDEX-HISTORY-1117) makes the chain expected too.
  if (reply.inputs.valueKind === "expected") inputs.valueKind = "expected";
  return {
    ...base,
    value,
    status: weakestStatus(reply.status, indexStatus(mb.outcomes, mb.mature)),
    outcomes: Math.min(reply.outcomes, mb.outcomes),
    unavailableReason: null,
  };
}

/** The ledger's roll-up of the booked meeting (`outcomeCostStudy`'s figure): null unit = nothing priced yet. */
export interface LedgerMeetingCost {
  unitCostUsd: number | null;
  /** Booked meetings the ledger counts. */
  produced: number;
  /** Share of the outcome spend declared, 0..100; null = not served. */
  coveragePct: number | null;
  daysMissing: number;
  unpricedInputs: number;
}

/** Below this share of the outcome spend declared, the ledger's figure misses spend behind the meeting (`COVERAGE_BAR_PCT`, research). */
const LEDGER_COVERAGE_BAR_PCT = 95;

/**
 * PURE. The Cost Per Meeting Index point off the ledger. A public index serves a PRICE or nothing (MEETING-INDEX-ZERO-1025,
 * supersedes "a floor (noise) while coverage is short"): ledger days still being recomputed price nothing
 * (RESEARCH-LEDGER-RECOMPUTING-1024, the Research study reads "Being recomputed."), and a figure short of the coverage bar
 * misses spend behind the meeting (prod 2026-10-25: 265 days computing, 62% coverage, $0.013 per booked meeting on the
 * landing hero beside $794 on Research).
 */
export function ledgerMeetingIndexPoint(l: LedgerMeetingCost): FleetIndexPoint {
  const recomputing = l.daysMissing > 0;
  const coverageShort = l.coveragePct === null || l.coveragePct < LEDGER_COVERAGE_BAR_PCT;
  const priced = l.unitCostUsd !== null && l.unitCostUsd > 0 && l.produced > 0;
  const unavailableReason = recomputing
    ? "ledger_being_recomputed"
    : !priced
      ? "no_meeting_priced_on_ledger"
      : coverageShort
        ? "ledger_coverage_short"
        : null;
  return {
    indexSlug: COST_PER_MEETING.slug,
    value: unavailableReason === null ? l.unitCostUsd : null,
    status: unavailableReason === null ? indexStatus(Math.round(l.produced), true) : "noise",
    outcomes: Math.round(l.produced),
    contacted: null,
    workflowDynastySlug: null,
    workflowDynastyName: null,
    unavailableReason,
    inputs: {
      method: "ledger_every_path",
      ledgerUnitCostUsd: l.unitCostUsd,
      coveragePct: l.coveragePct,
      daysMissing: l.daysMissing,
      unpricedInputs: l.unpricedInputs,
      meetingsBooked: l.produced,
    },
  };
}

/** The outcome prices' meeting price: what a new client is quoted (Research "Expected, outcome prices"). */
export interface ExpectedMeetingPrice {
  priceUsd: number | null;
  maturity: string | null;
  /** Outcomes behind the weakest leg of the price. */
  outcomes: number;
  unmeasuredReason: string | null;
}

/**
 * PURE. The Cost Per Meeting Index point: the ledger's price when it is one, else the EXPECTED price, labelled
 * `inputs.valueKind: "expected"` (owner 2026-10-25, MEETING-INDEX-EXPECTED-1025: « A, prends B en attendant »: the
 * ledger stays the method, the public figure is the outcome prices' meeting price until the ledger reconciles).
 * Never the ledger's partial figure. While the outcome prices price no meeting (their meeting leg wants ONE workflow with a
 * meeting; prod 2026-10-26 a second workflow's $0.31 on the same campaign made it mixed, `no_workflow_with_outcomes`, and
 * the landing lost the figure, LANDING-MEETING-PRICE-1027) the expected price is the pipes' chain, the same formula the
 * meeting rate index reads (`meetingPoint`: interest cost ÷ the meeting pipe's booking rate + its cost per meeting, the
 * pipe pooled while no workflow owns a meeting), `method: "expected_pipe_chain"`. Nothing expected either = the ledger's
 * null and its reason.
 */
export function meetingCostIndexPoint(
  ledger: LedgerMeetingCost | null,
  expected: ExpectedMeetingPrice | null,
  chain: FleetIndexPoint | null = null,
): FleetIndexPoint | null {
  const lp = ledger ? ledgerMeetingIndexPoint(ledger) : null;
  if (lp && lp.value !== null) return { ...lp, inputs: { ...lp.inputs, valueKind: "measured" } };
  const ledgerInputs = {
    ledgerUnavailableReason: lp?.unavailableReason ?? "ledger_unreadable",
    ...(lp ? { ledgerUnitCostUsd: lp.inputs.ledgerUnitCostUsd ?? null, coveragePct: lp.inputs.coveragePct ?? null, daysMissing: lp.inputs.daysMissing ?? null } : {}),
  };
  if (!expected || expected.priceUsd === null || !(expected.priceUsd > 0)) {
    if (!chain || chain.value === null || !(chain.value > 0)) {
      // On the vendor basis an expected price withheld for an unknown vendor cost says so (PUBLIC-VENDOR-COST-1031).
      const vendorUnknown = expected?.unmeasuredReason === VENDOR_COST_UNKNOWN || chain?.unavailableReason === VENDOR_COST_UNKNOWN;
      if (!vendorUnknown) return lp;
      return {
        indexSlug: COST_PER_MEETING.slug,
        value: null,
        status: "noise",
        outcomes: 0,
        contacted: null,
        workflowDynastySlug: chain?.workflowDynastySlug ?? null,
        workflowDynastyName: chain?.workflowDynastyName ?? null,
        unavailableReason: VENDOR_COST_UNKNOWN,
        inputs: { ...(chain?.inputs ?? {}), valueKind: "expected", ...ledgerInputs },
      };
    }
    return {
      ...chain,
      inputs: {
        ...chain.inputs,
        valueKind: "expected",
        method: "expected_pipe_chain",
        outcomePricesUnmeasuredReason: expected?.unmeasuredReason ?? (expected ? null : "outcome_prices_unreadable"),
        ...ledgerInputs,
      },
    };
  }
  return {
    indexSlug: COST_PER_MEETING.slug,
    value: expected.priceUsd,
    status: expected.maturity === "mature" ? indexStatus(Math.round(expected.outcomes), true) : "noise",
    outcomes: Math.round(expected.outcomes),
    contacted: null,
    workflowDynastySlug: null,
    workflowDynastyName: null,
    unavailableReason: null,
    inputs: {
      valueKind: "expected",
      method: "expected_outcome_prices",
      formula: "reply_cost / meeting_rate + meeting_leg_cost",
      maturity: expected.maturity,
      ...ledgerInputs,
    },
  };
}

const COST_PER_INTEREST = fleetIndexBySlug("cold-email-cost-per-positive-reply")!;
const COST_PER_MEETING = fleetIndexBySlug("cold-email-cost-per-meeting")!;
const INTEREST_RATE = fleetIndexBySlug("cold-email-positive-reply-rate")!;
const COST_PER_ENGAGED_LEAD = fleetIndexBySlug("cold-email-cost-per-engaged-lead")!;

/** PURE. Today's point of every index whose inputs were readable (an unreadable input records nothing). */
export function computeFleetIndexPoints(inputs: FleetIndexInputs): FleetIndexPoint[] {
  const points: FleetIndexPoint[] = [];
  const standsIn = inputs.bestAvailableStandsIn === true;
  for (const def of FLEET_INDEXES) {
    if (def.outcome === "website_visit" && inputs.websiteVisitRows) points.push(legPoint(def, inputs.websiteVisitRows, standsIn));
    if (def.outcome === "positive_reply" && inputs.positiveReplyRows) points.push(legPoint(def, inputs.positiveReplyRows, standsIn));
    // The Cost Per Meeting Index reads the ledger (MEETING-COST-METHODS-1024); the meeting rate stays the pipes' chain.
    if (def.slug === COST_PER_MEETING.slug) {
      const chain = inputs.positiveReplyRows && inputs.meetingPipe ? meetingPoint(def, inputs.positiveReplyRows, inputs.meetingPipe, standsIn) : null;
      const p = meetingCostIndexPoint(inputs.meetingLedger ?? null, inputs.meetingExpected ?? null, chain);
      if (p) points.push(p);
    } else if (def.outcome === "meeting_booked" && inputs.positiveReplyRows && inputs.meetingPipe) {
      points.push(meetingPoint(def, inputs.positiveReplyRows, inputs.meetingPipe, standsIn));
    }
    if (def.outcome === "engaged_lead" && inputs.brandEngagement) points.push(engagedLeadPoint(inputs.brandEngagement));
  }
  return points;
}
