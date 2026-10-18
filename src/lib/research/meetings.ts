/**
 * THE MEETING STUDIES (LIVE-RESEARCH-1018). Pure.
 *
 *  - `meeting-ai-before-after` (Meeting booked section): does the AI answering positive replies book more meetings?
 *    Every count is lead-service's before/after read, the one `/public/channels` `meetingBookingBeforeAfter` serves
 *    (`lib/meeting-booking-before-after.ts`): go-live, who sits on which side and who booked are lead-service's. The
 *    headline and verdict are on the SAME-HORIZON block (both sides had the same time to book); all-time is context.
 *  - `meeting-booking-cost` (meeting booking pipe): what a meeting costs on the Positive reply -> Meeting booked leg
 *    alone, on the pipe's own figures (the leg workflow ranking's: the people its campaigns acted on and how many of them
 *    booked), every workflow pooled.
 *  - The meeting booking pipe's comparisons (LLM, template, follow-ups, workflow): a comparison needs two workflows
 *    that acted on somebody; until then each states it.
 */
import { n, usd } from "./format.js";
import { compareVerdict, headlineFor, type Verdict } from "./verdict.js";
import { notMeasuredStudy, type BucketFigures } from "./studies.js";
import type { ResearchPoint, ResearchStudy } from "./types.js";
import type { MeetingBookingBeforeAfter, MeetingBookingWindow } from "../meeting-booking-before-after.js";

const people = (k: number) => `${n(k)} ${k === 1 ? "person" : "people"}`;
const meetingsText = (k: number) => `${n(k)} ${k === 1 ? "meeting" : "meetings"}`;
const brandsText = (k: number) => `${n(k)} ${k === 1 ? "brand" : "brands"}`;
const pct0 = (ratePct: number) => `${ratePct.toFixed(0)}%`;

interface Side {
  label: string;
  people: number;
  booked: number;
  ratePct: number | null;
  by: MeetingBookingWindow["bookedBy"] | null;
}

/** PURE. The before/after study, or a not-measured study when lead-service could not be read. */
export function meetingBeforeAfterStudy(read: MeetingBookingBeforeAfter, outcomesRequired: number): ResearchStudy {
  const base = {
    id: "meeting-ai-before-after",
    pipe: null,
    outcome: "meeting" as const,
    topic: "launch" as const,
    goal: "rate" as const,
    question: "Does the AI answering positive replies book more meetings?",
  };
  const fleet = read.fleet;
  if (!fleet) {
    return notMeasuredStudy({ ...base, headline: "Not readable right now.", reason: "lead-service's before/after read is unavailable right now; the study comes back on the next refresh." });
  }
  const days = fleet.before.sameHorizon.days;
  const horizon = (label: string, w: MeetingBookingWindow): Side => ({ label, people: w.sameHorizon.positiveReplyPeople, booked: w.sameHorizon.bookedPeople, ratePct: w.sameHorizon.ratePct, by: null });
  const allTime = (label: string, w: MeetingBookingWindow): Side => ({ label, people: w.positiveReplyPeople, booked: w.bookedPeople, ratePct: w.ratePct, by: w.bookedBy });
  const B = "Before the AI went live";
  const A = "After the AI went live";
  const before = horizon(B, fleet.before);
  const after = horizon(A, fleet.after);
  const byText = (by: Side["by"]) =>
    by ? ` (AI ${n(by.aiMeetingBooking)} · your team ${n(by.yourTeamMeetingBooking)} · unknown ${n(by.unknown)}${by.other ? ` · other ${n(by.other)}` : ""})` : "";
  const point = (s: Side): ResearchPoint => ({
    label: s.label,
    value: s.ratePct === null ? 0 : Number(s.ratePct.toFixed(1)),
    display: s.ratePct === null ? "No one yet" : pct0(s.ratePct),
    note: `${meetingsText(s.booked)} booked of ${people(s.people)} with a positive reply${byText(s.by)}`,
    thin: s.booked < outcomesRequired,
  });
  // the leader first; a tie keeps Before first
  const ordered = (a: Side, b: Side): [Side, Side] => ((b.ratePct ?? -1) > (a.ratePct ?? -1) ? [b, a] : [a, b]);
  const [lead, runner] = ordered(before, after);
  const verdict: Verdict =
    !before.people || !after.people
      ? { kind: "noise", reason: `No positive reply on the ${!after.people ? "after" : "before"} side is ${days} days old yet: nothing to compare on the same horizon.` }
      : compareVerdict({
          a: { label: lead.label, outcomes: lead.booked, exposure: lead.people, spend: 0 },
          b: { label: runner.label, outcomes: runner.booked, exposure: runner.people, spend: 0 },
          goal: "rate",
          comparisons: 1,
          strata: null,
          noun: "meeting",
          nouns: "meetings",
          per: "per person with a positive reply",
        });
  const horizonLine = `${B}: ${before.ratePct === null ? "no one yet" : pct0(before.ratePct)} (${meetingsText(before.booked)} of ${people(before.people)}). ${A}: ${after.ratePct === null ? `no positive reply ${days} days old yet` : pct0(after.ratePct)}${after.people ? ` (${meetingsText(after.booked)} of ${people(after.people)})` : ""}.`;
  const headline =
    verdict.kind === "conclusion"
      ? `${lead.label === A ? "More" : "Fewer"} meetings booked within ${days} days of a positive reply since the AI went live: ${horizonLine}`
      : `Within ${days} days of a positive reply. ${horizonLine} ${verdict.kind === "signal" ? "A signal to confirm, not yet a conclusion." : "Noise so far."}`;
  const population = `${brandsText(fleet.brandCount)} with the AI live, each split at its own go-live (the day the AI first answered one of its prospects). A person counts on the side of their first positive reply.`;
  const learning = `A figure needs ${meetingsText(outcomesRequired)} behind it; below that it reads Learning.`;
  return {
    ...base,
    status: before.people + after.people > 0 ? "measured" : "not_enough_data",
    headline,
    winner: verdict.kind === "conclusion" ? lead.label : null,
    crowned: verdict.kind === "conclusion",
    verdict: { kind: verdict.kind, reason: verdict.reason },
    result:
      after.ratePct !== null
        ? { display: pct0(after.ratePct), unit: `booked a meeting within ${days} days of a positive reply, after the AI went live`, sample: `${meetingsText(after.booked)} of ${people(after.people)} · before: ${before.ratePct === null ? "no one yet" : pct0(before.ratePct)}` }
        : before.ratePct !== null
          ? { display: pct0(before.ratePct), unit: `booked a meeting within ${days} days of a positive reply, before the AI went live`, sample: `${meetingsText(before.booked)} of ${people(before.people)} · after: no positive reply ${days} days old yet` }
          : null,
    charts: [
      {
        kind: "bars",
        title: `Meetings booked within ${days} days of a positive reply (%, higher is better)`,
        lowerIsBetter: false,
        points: ordered(before, after).map(point),
        note: `Same horizon on both sides: a person counts once their positive reply is ${days} days old, and a meeting counts when booked within those ${days} days. ${learning} ${population}`,
      },
      {
        kind: "bars",
        title: "Every meeting booked since the positive reply (%, context only)",
        lowerIsBetter: false,
        points: ordered(allTime(B, fleet.before), allTime(A, fleet.after)).map(point),
        note: `Context, not the answer: people on the after side have had less time to book, so this read favours the before side. ${learning}`,
      },
    ],
    conclusion: [
      `We compare the share of people with a positive reply who booked a meeting, before and after the AI started answering them. The ${days}-day read gives both sides the same time to book; the all-time read is context.`,
      population,
    ],
  };
}

/** PURE. What a meeting costs on the meeting booking leg alone. */
export function meetingBookingCostStudy(total: BucketFigures, outcomesRequired: number, extra: { workflows: number; unattributableCampaigns: number }): ResearchStudy {
  const price = total.outcomes > 0 && total.spentUsd > 0 ? total.spentUsd / total.outcomes : null;
  const sample = `${meetingsText(total.outcomes)} · ${usd(total.spentUsd)} spent · ${people(total.contacted)} acted on`;
  const learning = total.outcomes < outcomesRequired;
  const base = {
    id: "meeting-booking-cost",
    pipe: "meeting-booking" as const,
    topic: "cost" as const,
    goal: "roi" as const,
    question: "What does a booked meeting cost on average?",
  };
  if (price === null) {
    const left = extra.unattributableCampaigns > 0
      ? ` ${n(extra.unattributableCampaigns)} ${extra.unattributableCampaigns === 1 ? "campaign ran" : "campaigns ran"} several workflows and cannot say which one booked a meeting: left out.`
      : "";
    return notMeasuredStudy({
      ...base,
      headline: "No meeting booked after this step acted yet.",
      reason: `No meeting booked yet by the ${people(total.contacted)} this step acted on (${usd(total.spentUsd)} spent).${left}`,
    });
  }
  const verdict: Verdict = learning
    ? { kind: "noise", reason: `Learning: ${meetingsText(total.outcomes)} of the ${n(outcomesRequired)} a figure needs.` }
    : { kind: "signal", reason: `${meetingsText(total.outcomes)} on this step, but one price is a measurement, not a comparison: no rival step to beat.` };
  return {
    ...base,
    status: "measured",
    headline: headlineFor(`${usd(price)} per meeting booked on this step alone, from a positive reply to the meeting.`, verdict.kind),
    winner: null,
    crowned: false,
    verdict: { kind: verdict.kind, reason: verdict.reason },
    result: { display: usd(price), unit: "per meeting booked, this step only", sample },
    charts: [
      {
        kind: "bars",
        title: "Cost per meeting booked, positive reply to meeting (USD, lower is better)",
        lowerIsBetter: true,
        points: [{ label: "Every campaign on this step", value: Number(price.toFixed(2)), display: usd(price), note: sample, thin: learning }],
        note: `A meeting counts here when a person this step acted on booked it. A figure needs ${meetingsText(outcomesRequired)} behind it; below that it reads Learning.`,
      },
    ],
    conclusion: [
      `Everything this step's campaigns spent (${usd(total.spentUsd)}), divided by the meetings booked by the people they acted on, over ${n(extra.workflows)} ${extra.workflows === 1 ? "workflow" : "workflows"}. The cold email that won the positive reply is not in this price.`,
      ...(extra.unattributableCampaigns > 0
        ? [`${n(extra.unattributableCampaigns)} ${extra.unattributableCampaigns === 1 ? "campaign ran" : "campaigns ran"} several workflows and cannot say which one booked a meeting: left out of every figure here.`]
        : []),
    ],
  };
}

/** PURE. The meeting booking pipe's comparisons, each stating why it waits while fewer than two workflows acted. */
export function meetingBookingComparisonStudies(workflowsActed: number): ResearchStudy[] {
  const reason =
    workflowsActed >= 2
      ? `The meeting booking pipe has ${n(workflowsActed)} workflows that acted on somebody, but its emails are not split by model, template or follow-up yet.`
      : `The meeting booking pipe has ${workflowsActed === 1 ? "one workflow" : "no workflow"} that acted on somebody. A comparison needs at least two.`;
  return (
    [
      ["meeting-booking-llm", "llm", "rate", "Which LLM books the most meetings from a positive reply?"],
      ["meeting-booking-template", "template", "rate", "Which template books the most meetings from a positive reply?"],
      ["meeting-booking-followups", "followups", "rate", "How many follow-ups after a positive reply book the most meetings?"],
    ] as const
  ).map(([id, topic, goal, question]) => notMeasuredStudy({ id, pipe: "meeting-booking", topic, goal, question, headline: "Not enough data yet.", reason }));
}
