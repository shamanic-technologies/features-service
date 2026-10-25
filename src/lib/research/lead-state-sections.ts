/**
 * ONE RESEARCH SECTION PER LEAD STATE (owner 2026-10-25, RESEARCH-STATE-SECTIONS-1025: « une section pour chacun de ces
 * outcomes sur les deux dimensions CRM Lifecycle et Website visits ? Avec dedans chaque une page avec les prices per
 * outcome over time »). Pure. Doctrine: agent-config skill `cost-accounting` (LEAD-STATES-1024), `lib/lead-states.ts`.
 *
 * Each lead state (reached ONCE per lead x brand) is an outcome section of the file, stating its FAMILY so the page
 * groups them (interest = "CRM lifecycle": Lead interested < Meeting booked < Meeting attended < Paid client; visit =
 * "Website visits": Lead visited). The two families are never summed. Every section holds the same two studies:
 *  - `<stem>-cost-every-path`: the ledger's production cost of one lead in the state today (`outcome-cost.ts`);
 *  - `<stem>-cost-over-time`: that same figure AS OF the end of every UTC day since the state's first occurrence (runs
 *    `outcome-costs?until=`, since inception), recorded today and recomputed for past days once per UTC day, stored in
 *    `fleet_index_points` under the section's series slug. Its last point IS the every-path figure.
 * A day whose ledger still had days being recomputed reads no figure (RESEARCH-LEDGER-RECOMPUTING-1024), never a figure
 * on part of the days. One table, one code path for every state: nothing below names a state.
 */
import { dayText, n, usd, aOrAn } from "./format.js";
import { headlineFor, type Verdict } from "./verdict.js";
import { notMeasuredStudy } from "./studies.js";
import { COVERAGE_BAR_PCT } from "./outcome-cost.js";
import { MEETING_COST_LEDGER_SLUG, type MethodDay } from "./meeting-cost-methods.js";
import { leadStateOf, LEAD_STATES, type LeadStateFamily, type LeadStateKey } from "../lead-states.js";
import { legMaturity } from "../maturity.js";
import type { FleetIndexPoint } from "../fleet-indexes.js";
import type { OutcomeUnitCost } from "../outcome-unit-costs.js";
import type { ResearchOutcomeEntry, ResearchOutcomeId, ResearchPipeEntry, ResearchStudy } from "./types.js";

/**
 * The lead TRACK a section is on, in the owner's words (RESEARCH-LEAD-TRACK-1025: « deux dimensions CRM Lifecycle et
 * Website visits »; a specific two-word name, never `family`): the page groups the sections under it, never sums them.
 */
export type ResearchLeadTrack = "crm_lifecycle" | "website_visits";
const LEAD_TRACK_OF: Readonly<Record<LeadStateFamily, ResearchLeadTrack>> = { interest: "crm_lifecycle", visit: "website_visits" };
/** The lead track in the page's words (the section group title). */
export const LEAD_TRACK_LABELS: Readonly<Record<ResearchLeadTrack, string>> = { crm_lifecycle: "CRM lifecycle", website_visits: "Website visits" };
/** DEPRECATED `family` value of each track: served beside `leadTrack` until the dashboard reads `leadTrack` (then removed). */
const LEGACY_FAMILY_OF: Readonly<Record<ResearchLeadTrack, LeadStateFamily>> = { crm_lifecycle: "interest", website_visits: "visit" };

export interface LeadStateSection {
  state: LeadStateKey;
  /** The section id. The two sections that existed before keep theirs (`positive-reply`, `meeting`): dashboard links survive. */
  outcomeId: ResearchOutcomeId;
  /** Study id stem: `<stem>-cost-every-path`, `<stem>-cost-over-time` (the every-path ids are unchanged). */
  idStem: string;
  /** The state in words (the section title). */
  outcome: string;
  noun: string;
  nounPlural: string;
  /** The leg whose maturity bar the state's figures read Learning under (`lib/maturity.ts`). */
  maturityLeg: string;
  /** Where the price over time is stored (`fleet_index_points`; booked meetings keep the meeting-cost ledger series). */
  seriesSlug: string;
  description: string;
}

/** Every lead state's section, in ladder order per lead track (CRM lifecycle, then Website visits). */
export const LEAD_STATE_SECTIONS: readonly LeadStateSection[] = [
  {
    state: "lead_interested",
    outcomeId: "positive-reply",
    idStem: "positive-reply",
    outcome: "Lead interested",
    noun: "interested lead",
    nounPlural: "interested leads",
    maturityLeg: "start_to_conversation",
    seriesSlug: "research:lead-state-cost:lead_interested",
    description: "A lead shows interest once: a first positive reply, a form, a signup, a booking call, or a meeting booked with no reply before it. Three positive replies from one lead are one interested lead.",
  },
  {
    state: "meeting_booked",
    outcomeId: "meeting",
    idStem: "meeting",
    outcome: "Meeting booked",
    noun: "booked meeting",
    nounPlural: "booked meetings",
    maturityLeg: "start_to_meeting_booked",
    seriesSlug: MEETING_COST_LEDGER_SLUG,
    description: "A lead books a first meeting, once per lead. The lead is interested too from that day on.",
  },
  {
    state: "meeting_attended",
    outcomeId: "meeting-attended",
    idStem: "meeting-attended",
    outcome: "Meeting attended",
    noun: "attended meeting",
    nounPlural: "attended meetings",
    maturityLeg: "start_to_meeting_attended",
    seriesSlug: "research:lead-state-cost:meeting_attended",
    description: "A lead shows up to a first meeting, once per lead.",
  },
  {
    state: "paid_client",
    outcomeId: "paid-client",
    idStem: "paid-client",
    outcome: "Paid client",
    noun: "paid client",
    nounPlural: "paid clients",
    maturityLeg: "start_to_paid_client",
    seriesSlug: "research:lead-state-cost:paid_client",
    description: "A lead pays the client for the first time, once per lead.",
  },
  {
    state: "lead_visited",
    outcomeId: "lead-visited",
    idStem: "lead-visited",
    outcome: "Lead visited",
    noun: "visiting lead",
    nounPlural: "visiting leads",
    maturityLeg: "start_to_website_visit",
    seriesSlug: "research:lead-state-cost:lead_visited",
    description: "A lead visits the website at least once (a click judged human). Twelve clicks from one lead are one visiting lead.",
  },
];

const leadTrackOf = (state: LeadStateKey): ResearchLeadTrack => LEAD_TRACK_OF[LEAD_STATES.find((s) => s.key === state)!.family];
export const outcomesRequiredOf = (s: LeadStateSection): number => legMaturity(s.maturityLeg).outcomesRequired;

/** The step each studied pipe lands on (its leg's `to` step). */
const STUDIED_PIPE_TO_STEP: Readonly<Record<string, string>> = {
  "cold-email-positive-reply": "conversation",
  "cold-email-website-visit": "website_visit",
  "meeting-booking": "meeting_booked",
};

/**
 * PURE. The pipes of the file whose leg's `to` step puts a lead in `state` (`leadStateOf`), in the file's order: an
 * outcome section is never one pipe's (OUTCOME-SECTION-PIPES-1023).
 */
export function pipesReachingState(
  state: LeadStateKey,
  studied: readonly ResearchPipeEntry[],
  otherPipes: ReadonlyArray<{ entry: ResearchPipeEntry; toStep: string }>,
): string[] {
  return [
    ...studied.filter((p) => STUDIED_PIPE_TO_STEP[p.id] !== undefined && leadStateOf(STUDIED_PIPE_TO_STEP[p.id]!) === state).map((p) => p.id),
    ...otherPipes.filter((p) => leadStateOf(p.toStep) === state).map((p) => p.entry.id),
  ];
}

/** PURE. A section's entry in the file's `outcomes`. */
export function leadStateOutcomeEntry(
  s: LeadStateSection,
  studied: readonly ResearchPipeEntry[],
  otherPipes: ReadonlyArray<{ entry: ResearchPipeEntry; toStep: string }>,
): ResearchOutcomeEntry {
  const leadTrack = leadTrackOf(s.state);
  return {
    id: s.outcomeId,
    outcome: s.outcome,
    step: s.state,
    leadTrack,
    leadTrackLabel: LEAD_TRACK_LABELS[leadTrack],
    family: LEGACY_FAMILY_OF[leadTrack],
    familyLabel: LEAD_TRACK_LABELS[leadTrack],
    pipes: pipesReachingState(s.state, studied, otherPipes),
    description: s.description,
    population: "Every client and every path since the ledger's first day, each lead counted once in the state.",
  };
}

/** The ledger facts a day's point reads beside the state's unit cost. */
export interface LedgerDayFacts {
  coveragePct: number | null;
  daysMissing: number;
  /** Abnormal loss fleet-wide (waste), USD: in no figure, stated beside it. */
  abnormalUsd: number;
}

/**
 * PURE. A day's point of a state's price over time. Value null (never a $0) when the ledger still had days being
 * recomputed (`ledger_being_recomputed`) or nothing priced the state yet (`nothing_priced_yet`); a floor (`inputs.floor`)
 * below `COVERAGE_BAR_PCT` of the outcome spend declared; Learning (`noise`) below the state's maturity bar.
 */
export function leadStatePoint(s: LeadStateSection, unit: OutcomeUnitCost | null, f: LedgerDayFacts): FleetIndexPoint {
  const common = { indexSlug: s.seriesSlug, contacted: null, workflowDynastySlug: null, workflowDynastyName: null };
  const facts = { state: s.state, coveragePct: f.coveragePct, daysMissing: f.daysMissing, abnormalUsd: f.abnormalUsd };
  const priced = f.daysMissing === 0 && unit && !unit.unpricedReason && unit.unitCostUsd !== null && unit.unitCostUsd > 0 && unit.produced > 0;
  if (!priced) {
    return {
      ...common,
      value: null,
      status: "noise",
      outcomes: Math.round(unit?.produced ?? 0),
      unavailableReason: f.daysMissing > 0 ? "ledger_being_recomputed" : "nothing_priced_yet",
      inputs: facts,
    };
  }
  const floor = f.coveragePct === null || f.coveragePct < COVERAGE_BAR_PCT;
  return {
    ...common,
    value: unit!.unitCostUsd,
    status: floor || unit!.produced < outcomesRequiredOf(s) ? "noise" : "signal",
    outcomes: Math.round(unit!.produced),
    unavailableReason: null,
    inputs: { ...facts, floor: floor ? "yes" : "no", unpricedInputs: unit!.unpricedInputs.length },
  };
}

/** PURE. A point as the day row a chart reads. */
export const methodDayOf = (day: string, p: FleetIndexPoint): MethodDay => ({
  day,
  value: p.value,
  status: p.status,
  outcomes: p.outcomes,
  unavailableReason: p.unavailableReason,
  inputs: p.inputs,
});

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pctText = (cov: number | null) => (cov === null ? "an unknown share" : `${cov < 10 ? cov.toFixed(1) : Math.round(cov)}%`);

/**
 * PURE. "What did a <state> cost on each day, every path?": one point per UTC day the state had a price, read on the
 * ledger as of the end of that day. `rows` = the stored days with today's (the every-path figure's own point) last;
 * null = the series could not be read this build.
 */
export function leadStateCostOverTimeStudy(s: LeadStateSection, rows: readonly MethodDay[] | null, costBasis: "user" | "actual"): ResearchStudy {
  const base = {
    id: `${s.idStem}-cost-over-time`,
    pipe: null,
    outcome: s.outcomeId,
    topic: "cost" as const,
    goal: "roi" as const,
    question: `What did ${aOrAn(s.noun)} cost on each day, every path?`,
  };
  if (costBasis === "actual") {
    return notMeasuredStudy({ ...base, headline: "Not measured on vendor cost yet.", reason: "The price over time is recorded on what clients were charged only. Switch to the billed basis to read it." });
  }
  if (!rows) return notMeasuredStudy({ ...base, headline: "Not readable right now.", reason: "The recorded days could not be read this time. The study comes back on the next build." });
  const required = outcomesRequiredOf(s);
  const floorOf = (r: MethodDay) => r.inputs.floor === "yes";
  const points = rows
    .filter((r) => r.value !== null && Number.isFinite(r.value))
    .map((r) => {
      const waste = num(r.inputs.abnormalUsd) ?? 0;
      return {
        label: dayText(r.day),
        value: Number(r.value!.toFixed(2)),
        display: `${floorOf(r) ? "≥ " : ""}${usd(r.value!)}`,
        note: `${n(r.outcomes)} ${r.outcomes === 1 ? s.noun : s.nounPlural} · ${pctText(num(r.inputs.coveragePct))} of the outcome spend declared${waste > 0 ? ` · waste apart ${usd(waste)}` : ""}${floorOf(r) ? " · a floor" : ""}${r.basis === "recomputed" ? " · recomputed as of that day" : ""}`,
        thin: floorOf(r) || r.outcomes < required,
      };
    });
  const recomputing = rows.filter((r) => r.value === null && r.unavailableReason === "ledger_being_recomputed");
  const last = rows.length ? rows[rows.length - 1]! : null;
  const lastDeclared = last ? num(last.inputs.coveragePct) : null;
  const todayLine =
    last?.value != null
      ? `${floorOf(last) ? "At least " : ""}${usd(last.value)} per ${s.noun} on ${dayText(last.day)}, every path.`
      : last?.unavailableReason === "ledger_being_recomputed"
        ? "Being recomputed."
        : `No ${s.noun} priced on the ledger yet.`;
  const verdict: Verdict =
    last?.value == null
      ? { kind: "noise", reason: last?.unavailableReason === "ledger_being_recomputed" ? "runs-service is recomputing ledger days: no figure until every day is in." : `No ${s.noun} priced yet.` }
      : floorOf(last)
        ? { kind: "noise", reason: `The ledger holds ${pctText(lastDeclared)} of the outcome spend: a floor, not a price.` }
        : last.outcomes < required
          ? { kind: "noise", reason: `Learning: ${n(last.outcomes)} of the ${n(required)} ${s.nounPlural} a figure needs.` }
          : { kind: "signal", reason: `A measurement on ${n(last.outcomes)} ${s.nounPlural}: one price per day, no rival to beat.` };
  const conclusion = [
    todayLine,
    ...(points.length ? [`Priced on ${n(points.length)} ${points.length === 1 ? "day" : "days"} from ${points[0]!.label}.`] : []),
    ...(recomputing.length
      ? [`${n(recomputing.length)} ${recomputing.length === 1 ? "day reads" : "days read"} no figure: the ledger was still recomputing days then, and a figure on part of the days is neither a price nor a floor.`]
      : []),
    `Each day reads runs-service's ledger as of the end of that day (since inception up to it), every client and every path, each lead counted once in the state, rolled up with today's rules; waste (work on a lead already in its state, the same work bought twice) is in no figure.`,
  ];
  if (!points.length) {
    return { ...notMeasuredStudy({ ...base, headline: todayLine, reason: verdict.reason }), conclusion };
  }
  return {
    ...base,
    status: "measured",
    headline: headlineFor(todayLine, verdict.kind),
    winner: null,
    crowned: false,
    verdict: { kind: verdict.kind, reason: verdict.reason },
    result:
      last?.value != null
        ? { display: `${floorOf(last) ? "≥ " : ""}${usd(last.value)}`, unit: `per ${s.noun}, every path, production cost`, sample: `${n(last.outcomes)} ${last.outcomes === 1 ? s.noun : s.nounPlural} · ${pctText(lastDeclared)} of the outcome spend declared` }
        : null,
    charts: [
      {
        kind: "months",
        title: `Price per ${s.noun}, every path, day by day from ${points[0]!.label}`,
        lowerIsBetter: true,
        points,
        note: `The every-path production cost of one ${s.noun} as of the end of each day: past days recomputed once a day, today live. A floor (≥) while under ${COVERAGE_BAR_PCT}% of the outcome spend is declared; Learning below ${n(required)} ${s.nounPlural}; no point on a day the ledger was still recomputing.`,
      },
    ],
    conclusion,
  };
}
