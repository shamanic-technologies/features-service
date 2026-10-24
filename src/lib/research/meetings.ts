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
import { MONTHS as MONTH_NAMES, n, usd } from "./format.js";
import { compareVerdict, headlineFor, type Verdict } from "./verdict.js";
import { notMeasuredStudy, type BucketFigures } from "./studies.js";
import type { ResearchPoint, ResearchStudy } from "./types.js";
import type { MeetingBookingBeforeAfter, MeetingBookingWindow } from "../meeting-booking-before-after.js";
import { indexChart, ledgerChart, medianChart, medianToday, methodLines, outcomePricesChart, type MeetingCostMethods } from "./meeting-cost-methods.js";

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
  const leftOut = fleet.population.brandsLeftOut;
  const population =
    `${brandsText(fleet.brandCount)} with the AI live that ${fleet.brandCount === 1 ? "reports its" : "report their"} booked meetings to us, each split at its own go-live (the day the AI first answered one of its prospects). A person counts on the side of their first positive reply.` +
    (leftOut > 0 ? ` ${brandsText(leftOut)} with the AI live ${leftOut === 1 ? "reports" : "report"} no meetings and ${leftOut === 1 ? "is" : "are"} left out, since zero meetings there means we cannot see them.` : "");
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

/** One brand that reports its meetings: its meetings our outreach led to, by month, and its spend on both legs by month. */
export interface ReportingBrand {
  brandId: string;
  /** `YYYY-MM` → meetings booked after one of the person's positive replies to our outreach. */
  meetingsByMonth: Record<string, number>;
  /** `YYYY-MM` → what the brand was charged on cold email and meeting booking (incurred, list price). */
  spendByMonth: Record<string, number>;
}

/**
 * PURE. What a booked meeting costs from the first cold email, every leg (the Meeting booked OUTCOME section). Population
 * = the brands that REPORT their meetings (any live meeting row in lead-service: CRM import, tracker, a person's
 * statement): a brand reporting none reads zero meetings by construction, and pricing its spend against nobody's
 * meetings would invent a price (owner pick, 2026-10-03). A meeting counts for our outreach when the person had replied
 * positively to it before booking (lead-service's own attribution).
 */
export function meetingCostStudy(brands: readonly ReportingBrand[] | null, outcomesRequired: number, readOn: string, methods?: MeetingCostMethods): ResearchStudy {
  const base = {
    id: "meeting-cost",
    pipe: null,
    outcome: "meeting" as const,
    topic: "cost" as const,
    goal: "roi" as const,
    question: "What does a booked meeting cost, from the first cold email?",
  };
  if (!brands) return notMeasuredStudy({ ...base, headline: "Not readable right now.", reason: "lead-service's meeting attribution or the spend could not be read right now; the study comes back on the next refresh." });
  const months = [...new Set(brands.flatMap((b) => [...Object.keys(b.meetingsByMonth), ...Object.keys(b.spendByMonth)]))].sort();
  const byMonth = months.map((m) => ({
    m,
    spend: brands.reduce((a, b) => a + (b.spendByMonth[m] ?? 0), 0),
    got: brands.reduce((a, b) => a + (b.meetingsByMonth[m] ?? 0), 0),
  }));
  const spend = byMonth.reduce((a, r) => a + r.spend, 0);
  const got = byMonth.reduce((a, r) => a + r.got, 0);
  const withSpend = brands.filter((b) => Object.values(b.spendByMonth).some((v) => v > 0)).length;
  if (!got || spend <= 0) return notMeasuredStudy({ ...base, headline: "No booked meeting credited to our outreach yet.", reason: `No booked meeting credited to our outreach yet on the ${brandsText(brands.length)} that report their meetings.` });
  const partial = readOn.slice(8, 10) === "01" ? null : readOn.slice(0, 7);
  const mlabel = (ym: string) => MONTH_NAMES[Number(ym.slice(5, 7)) - 1] ?? ym;
  const note = (k: number, s: number, ym: string, toDate: boolean) => `${meetingsText(k)} · ${usd(s)} spent${toDate ? " to date" : ""}${ym === partial ? " · month in progress" : ""}`;
  let cs = 0;
  let ck = 0;
  const cumulative: ResearchPoint[] = [];
  for (const r of byMonth) {
    cs += r.spend;
    ck += r.got;
    if (!ck) continue;
    cumulative.push({ label: mlabel(r.m), value: Number((cs / ck).toFixed(2)), display: usd(cs / ck), note: note(ck, cs, r.m, true), thin: ck < outcomesRequired, ...(r.m === partial ? { partial: true } : {}) });
  }
  const price = spend / got;
  const learning = got < outcomesRequired;
  const verdict: Verdict = learning
    ? { kind: "noise", reason: `Learning: ${meetingsText(got)} of the ${n(outcomesRequired)} a figure needs.` }
    : withSpend < 2
      ? { kind: "signal", reason: `${meetingsText(got)}, all from ${brandsText(withSpend)}: a measurement of that brand, not yet of the fleet.` }
      : { kind: "conclusion", reason: `A measurement on ${meetingsText(got)} across ${brandsText(withSpend)}.` };
  return {
    ...base,
    status: "measured",
    headline: headlineFor(`${usd(price)} per meeting booked on average since inception, every leg from the first cold email to the meeting.`, verdict.kind),
    winner: null,
    crowned: verdict.kind === "conclusion",
    verdict: { kind: verdict.kind, reason: verdict.reason },
    result: { display: usd(price), unit: "per meeting booked, all legs, average since inception", sample: `${meetingsText(got)} · ${usd(spend)} spent · ${brandsText(withSpend)}` },
    charts: [
      {
        kind: "months",
        title: "Brands reporting meetings: cost per meeting booked by month",
        lowerIsBetter: true,
        points: byMonth
          .filter((r) => r.got > 0 && r.spend > 0)
          .map((r) => ({ label: mlabel(r.m), value: Number((r.spend / r.got).toFixed(2)), display: usd(r.spend / r.got), note: note(r.got, r.spend, r.m, false), thin: r.got < outcomesRequired, ...(r.m === partial ? { partial: true } : {}) })),
        cumulative: { title: "Brands reporting meetings: average since inception", points: cumulative },
        note: `Spend on cold email and meeting booking, against the meetings booked by people who had replied positively to our outreach first. A figure needs ${meetingsText(outcomesRequired)} behind it; below that it reads Learning.`,
      },
      // MEETING-COST-METHODS-1024: every other way we compute the figure, one row each (`meeting-cost-methods.ts`).
      ...(methods
        ? [
            medianChart(brands, months, partial, outcomesRequired),
            methods.outcomePrices ? outcomePricesChart(methods.outcomePrices) : null,
            methods.index ? indexChart(methods.index) : null,
            methods.ledger ? ledgerChart(methods.ledger) : null,
          ].filter((c): c is NonNullable<typeof c> => c !== null)
        : []),
    ],
    conclusion: [
      "The average divides everything those brands were charged, positive reply leg and meeting leg alike, by every meeting booked since; the monthly bars are context, not the answer.",
      `Measured on the ${brandsText(brands.length)} that report their booked meetings to us (CRM import or tracker). Brands that report no meetings are left out, since zero meetings there means we cannot see them.`,
      ...(methods ? [medianLine(brands), ...methodLines(methods)] : []),
    ],
  };
}

/** PURE. The median client's figure today, in one line (MEETING-COST-METHODS-1024). */
function medianLine(brands: readonly ReportingBrand[]): string {
  const m = medianToday(brands);
  if (!m) return "Measured, median client: no reporting brand has spent yet.";
  return m.medianUsd !== null
    ? `Measured, median client: ${usd(m.medianUsd)} per meeting booked today, across ${brandsText(m.clients)} that spent (${n(m.clientsWithoutOutcome)} with no meeting yet). The average is what the fleet pays; the median is what a typical client lives.`
    : `Measured, median client: the median brand has no meeting yet (${n(m.clientsWithoutOutcome)} of the ${brandsText(m.clients)} that spent have none).`;
}
