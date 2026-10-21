/**
 * THE RESEARCH FILE, assembled from each pipe's buckets (LIVE-RESEARCH-1018). Pure: `routes/research.ts` reads the
 * evidence, this writes every study the page shows today, and names in `unavailable` each study id this service does
 * not answer yet with the reason (the page states it; a producer is building the read).
 */
import { bucketOf, groupCells, type SlugCell } from "./buckets.js";
import { cutoffText } from "./studies.js";
import { costOverTimeStudy, dimensionStudies, notMeasuredStudy, sumFigures, type PipeTerms, type ResearchBucket } from "./studies.js";
import { meetingBeforeAfterStudy, meetingBookingComparisonStudies, meetingBookingCostStudy, meetingCostStudy, type ReportingBrand } from "./meetings.js";
import type { ResearchFile, ResearchStudy, ResearchUnavailable } from "./types.js";
import { MONTHS as MONTH_LABELS } from "./format.js";
import type { MeetingBookingBeforeAfter } from "../meeting-booking-before-after.js";
import type { LegWorkflowRankingRow } from "../leg-workflow-ranking.js";
import { followupStudies, opensStudies, timingStudy, type LegSpendSplit, type OpensArm, type SendGroup } from "./sends.js";
import { JUDGMENT_OUTCOME, jevStudies, type JevInput } from "./jev.js";
import { bestWorkflowByMonth, clientMedianByMonth, overTimeStudies, type BestPoint, type MedianPoint } from "./pipe-series.js";
import { dayText, monthLabel } from "./format.js";
import { TIME_TO_REPLY_MIN_SAMPLE } from "../campaign-next-steps.js";
import { POSITIVE_REPLY_OUTCOME, replyDelayStudy, type ReplyDelayRead } from "./reply-delay.js";

export const POSITIVE_REPLY_PIPE = "cold-email-positive-reply" as const;
export const WEBSITE_VISIT_PIPE = "cold-email-website-visit" as const;
export const MEETING_BOOKING_PIPE = "meeting-booking" as const;

/** One cold email pipe's evidence, read on one cost basis. */
export interface ColdEmailPipeInput {
  /** The leg as computed on (`start_to_conversation`...) — the maturity rule's key. */
  legKey: string;
  durationDays: number;
  outcomesRequired: number;
  /** `YYYY-MM-DD`, null when the leg waits for nothing. */
  cutoffDay: string | null;
  cells: SlugCell[];
  /** Version slug → its dynasty. */
  dynastyOf: ReadonlyMap<string, string>;
  /** Dynasty → the name the page shows. */
  labelOf: (dynasty: string) => string;
  /**
   * The leg workflow ranking's rows (billed basis): a workflow's bar IS its ranking row, so the Workflows page and the
   * study can never state two figures. Null on the actual-cost basis (the ranking is billed): bars come from the cells.
   */
  rankingRows: readonly LegWorkflowRankingRow[] | null;
}

export interface MeetingPipeInput {
  outcomesRequired: number;
  /** The leg workflow ranking's rows of the meeting booking pipe (its own measure: people acted on → booked). */
  rankingRows: readonly LegWorkflowRankingRow[] | null;
  unattributableCampaigns: number;
  /** The two articles over time (best workflow, client median), day by day; null = unreadable (the studies stay out). */
  series: { best: BestPoint[]; median: MedianPoint[] } | null;
}

export interface ResearchInput {
  costBasis: "user" | "actual";
  now: Date;
  unpricedBilledUsd: number;
  reply: ColdEmailPipeInput;
  visit: ColdEmailPipeInput;
  meeting: MeetingPipeInput;
  beforeAfter: MeetingBookingBeforeAfter;
  meetingOutcomesRequired: number;
  /**
   * The studies read on each email sent (our copy of instantly-service's outreach facts); null while the copy is empty
   * (first deploy) or unreadable: their ids stay in `unavailable`.
   */
  sends: {
    reply: { groups: SendGroup[]; spend: LegSpendSplit };
    visit: { groups: SendGroup[]; spend: LegSpendSplit };
    opens: { on: OpensArm; off: OpensArm; unplaced: number } | null;
  } | null;
  /** The brands reporting their meetings (null = unreadable); undefined = not asked (the study stays waiting). */
  reportingBrands?: ReportingBrand[] | null;
  /** Leg `start_to_meeting_booked`'s outcome count (the Meeting booked outcome section's maturity bar). */
  meetingOutcomeRequired?: number;
  /** The studies of what wrote the emails (LLM, template, naming, first-email shape), written by `lib/research/generations.ts`. */
  generationStudies: ResearchStudy[];
  /** The page-wide counts (`routes/research-sends.ts` `readVolume` + the person cell's undated people); null = unreadable. */
  volume: { emails: number; orgs: number; workflows: number; linkedEmails: number; byMonth: Array<{ month: string; emails: number }>; excludedEmails: number; noRunStart: number } | null;
  /** The typed judgment section's inputs (each part null when its producer could not be read). */
  jev: Omit<JevInput, "costBasis" | "readOn">;
  /**
   * "How long before a first positive reply?" (TTFPR-RESEARCH-STUDY-1021): lead-service's fleet figure over every
   * reply-pipe campaign; null = unreadable this build (the study says so); undefined = not asked (no study).
   */
  replyDelay?: ReplyDelayRead | null;
}

const partialMonthOf = (cutoffDay: string | null): string | null => (cutoffDay && cutoffDay.slice(8, 10) !== "01" ? cutoffDay.slice(0, 7) : null);

export function ruleNote(reply: ColdEmailPipeInput, visit: ColdEmailPipeInput): string {
  const same = reply.durationDays === visit.durationDays && reply.cutoffDay === visit.cutoffDay;
  const when = same && reply.cutoffDay
    ? `at least ${reply.durationDays} days before the read (before ${cutoffText(reply.cutoffDay)})`
    : `at least ${reply.durationDays} days (positive replies) or ${visit.durationDays} days (website visits) before the read`;
  return (
    `A bar is read on the people we started writing to ${when}, with every positive reply and website visit they sent since, once those people bring ` +
    `${reply.outcomesRequired} positive ${reply.outcomesRequired === 1 ? "reply" : "replies"} (${visit.outcomesRequired} website ${visit.outcomesRequired === 1 ? "visit" : "visits"}); ` +
    `below that it reads everything to date and is marked Learning, the rule the Workflows page applies. A rate is per person emailed. ` +
    `A website visit is a click our link-scanner check judged human, which only the emails we send ourselves can carry: website-visit figures count the people emailed through our own sender only.`
  );
}

export function termsOf(pipe: typeof POSITIVE_REPLY_PIPE | typeof WEBSITE_VISIT_PIPE, input: ColdEmailPipeInput, note: string): PipeTerms {
  const reply = pipe === POSITIVE_REPLY_PIPE;
  return {
    pipe,
    noun: reply ? "positive reply" : "website visit",
    nounPlural: reply ? "positive replies" : "website visits",
    exposureNoun: reply ? "people emailed" : "people emailed through our sender",
    exposureNounOne: reply ? "person emailed" : "person emailed through our sender",
    outcomesRequired: input.outcomesRequired,
    partialMonth: partialMonthOf(input.cutoffDay),
    note,
  };
}

/** PURE. A pipe's workflow bars: its ranking rows (billed) or its cells pooled per dynasty (actual). */
export function workflowBuckets(input: ColdEmailPipeInput): ResearchBucket[] {
  const { groups } = groupCells(input.cells, (slug) => input.dynastyOf.get(slug) ?? slug);
  if (input.rankingRows) {
    return input.rankingRows
      .filter((r) => r.spentUsd > 0 || r.contacted > 0)
      .map((r) =>
        bucketOf({
          key: r.workflowDynastySlug,
          label: input.labelOf(r.workflowDynastySlug),
          legKey: input.legKey,
          cells: groups.get(r.workflowDynastySlug) ?? [],
          override: {
            basis: r.basis,
            figures: { spentUsd: r.spentUsd, contacted: r.contacted, outcomes: r.outcomes },
            learning: r.isMature !== true,
          },
        }),
      );
  }
  return [...groups].map(([dynasty, cells]) => bucketOf({ key: dynasty, label: input.labelOf(dynasty), legKey: input.legKey, cells }));
}

/** The meeting pipe's workflow bars (no month, no strata: its evidence is not dated per client yet). */
function meetingWorkflowBuckets(rows: readonly LegWorkflowRankingRow[], labelOf: (d: string) => string): ResearchBucket[] {
  return rows
    .filter((r) => r.spentUsd > 0 || r.contacted > 0)
    .map((r) => ({
      key: r.workflowDynastySlug,
      label: labelOf(r.workflowDynastySlug),
      basis: r.basis,
      figures: { spentUsd: r.spentUsd, contacted: r.contacted, outcomes: r.outcomes },
      learning: r.isMature !== true,
      months: null,
      strata: null,
    }));
}

/** Every study id the page shows that this service does not answer yet, with what it waits for. */
export const UNAVAILABLE: readonly ResearchUnavailable[] = (() => {
  const gen = "Waits for features-service's copy of content-generation-service's sequence feed (which model and template wrote each sequence) and the next build of the fleet person cell.";
  const shape = "Waits for features-service's copy of content-generation-service's sequence feed (how each first email reads) and the next build of the fleet person cell.";
  const sends = "Waits for features-service's copy of instantly-service's outreach facts (every send with its step) to fill.";
  const tz = "Waits for features-service's copy of instantly-service's outreach facts (each send's prospect-local time) to fill.";
  const pixel = "Waits for features-service's copy of instantly-service's outreach facts (each thread's open-pixel arm) to fill.";
  const jevRuns = "runs-service's judgment volume could not be read.";
  const jevScreen = "lead-service's or human-service's screen decisions could not be read.";
  const out: ResearchUnavailable[] = [];
  for (const p of [POSITIVE_REPLY_PIPE, WEBSITE_VISIT_PIPE]) {
    out.push({ id: `${p}-llm-roi`, reason: gen }, { id: `${p}-llm-rate`, reason: gen });
    out.push({ id: `${p}-template-roi`, reason: gen }, { id: `${p}-template-rate`, reason: gen });
    out.push({ id: `${p}-followups-roi`, reason: sends }, { id: `${p}-followups-rate`, reason: sends });
    out.push({ id: `${p}-layout-roi`, reason: shape }, { id: `${p}-opening-roi`, reason: shape }, { id: `${p}-dash-roi`, reason: shape });
    out.push({ id: `${p}-hour-rate`, reason: tz });
  }
  out.push({ id: `${POSITIVE_REPLY_PIPE}-weekday-rate`, reason: tz });
  out.push({ id: `${POSITIVE_REPLY_PIPE}-naming-rate`, reason: gen }, { id: `${POSITIVE_REPLY_PIPE}-naming-roi`, reason: gen });
  out.push({ id: `${POSITIVE_REPLY_PIPE}-opens-roi`, reason: pixel }, { id: `${POSITIVE_REPLY_PIPE}-opens-rate`, reason: pixel });
  out.push({ id: "meeting-cost", reason: "Waits for features-service to read which brands report their booked meetings and their spend on both legs, next ship of this work." });
  out.push({ id: "jev-volume", reason: jevRuns }, { id: "jev-screen-price", reason: jevRuns });
  out.push({ id: "jev-screen-decline", reason: jevScreen });
  out.push({ id: "jev-machine-replies", reason: sends });
  return out;
})();

/** PURE. The whole file. */
export function assembleResearch(input: ResearchInput): ResearchFile {
  const note = ruleNote(input.reply, input.visit);
  const studies: ResearchStudy[] = [];
  for (const [pipe, p] of [
    [POSITIVE_REPLY_PIPE, input.reply],
    [WEBSITE_VISIT_PIPE, input.visit],
  ] as const) {
    const t = termsOf(pipe, p, note);
    const all = bucketOf({ key: "all", label: "All our emails", legKey: p.legKey, cells: p.cells });
    studies.push(
      costOverTimeStudy(t, all.months, sumFigures([all.figures]), pipe === WEBSITE_VISIT_PIPE ? " whose clicks are screened for bots" : ""),
    );
    const wfBuckets = workflowBuckets(p);
    studies.push(...dimensionStudies(t, wfBuckets, { topic: "workflow", dimNoun: "workflow", keyed: true }));
    // The two articles over time (MB-INDEX-PIPES-1018): read on the ranking (billed), the index's own figures.
    if (p.rankingRows) {
      const runnable = new Set(p.rankingRows.filter((r) => r.selectable).map((r) => r.workflowDynastySlug));
      studies.push(
        ...overTimeStudies(t, bestWorkflowByMonth(wfBuckets, runnable, p.outcomesRequired), clientMedianByMonth(all.strata ?? {}), monthLabel, "by month", t.note),
      );
    }
    if (pipe === WEBSITE_VISIT_PIPE) {
      const reason =
        "The open pixel only ran on emails sent through the provider, whose clicks cannot be told apart from link scanners. A website visit is a human click, so this cannot be measured.";
      studies.push(
        notMeasuredStudy({ id: `${pipe}-opens-roi`, pipe, topic: "opens", goal: "roi", question: "Should we track opens for the cheapest website visit?", headline: "Cannot be measured on human visits.", reason }),
        notMeasuredStudy({ id: `${pipe}-opens-rate`, pipe, topic: "opens", goal: "rate", question: "Should we track opens for the most website visits?", headline: "Cannot be measured on human visits.", reason }),
      );
    }
  }
  // the meeting booking pipe
  {
    const vendorReason = "The meeting figures are on what clients were charged only. Switch to the billed basis to read them.";
    const rows = input.meeting.rankingRows;
    const t: PipeTerms = {
      pipe: MEETING_BOOKING_PIPE,
      noun: "meeting booked",
      nounPlural: "meetings booked",
      exposureNoun: "people acted on",
      exposureNounOne: "person acted on",
      outcomesRequired: input.meeting.outcomesRequired,
      partialMonth: null,
      note: `A meeting counts for a workflow when a person its campaigns acted on booked it. A figure needs ${input.meeting.outcomesRequired} meetings behind it; below that it reads Learning.`,
    };
    if (input.costBasis === "actual" || !rows) {
      for (const [goal, question] of [
        ["roi", "Which workflow books a meeting for the least?"],
        ["rate", "Which workflow books the most meetings from a positive reply?"],
      ] as const) {
        studies.push(notMeasuredStudy({ id: `meeting-booking-workflow-${goal}`, pipe: MEETING_BOOKING_PIPE, topic: "workflow", goal, question, headline: "Not measured on vendor cost yet.", reason: vendorReason }));
      }
      studies.push(notMeasuredStudy({ id: "meeting-booking-cost", pipe: MEETING_BOOKING_PIPE, topic: "cost", goal: "roi", question: "What does a booked meeting cost on average?", headline: "Not measured on vendor cost yet.", reason: vendorReason }));
      studies.push(...meetingBookingComparisonStudies(0).map((s) => s));
    } else {
      const buckets = meetingWorkflowBuckets(rows, (d) => rows.find((r) => r.workflowDynastySlug === d)?.workflowDynastyName ?? d);
      const acted = buckets.filter((b) => b.figures.contacted > 0).length;
      const ds = dimensionStudies(t, buckets, { topic: "workflow", dimNoun: "workflow", keyed: true });
      // ids the page shows: `meeting-booking-workflow-{roi,rate}`
      studies.push(
        ...ds.map((s) => ({
          ...s,
          id: s.id.replace(`${MEETING_BOOKING_PIPE}-workflow-`, "meeting-booking-workflow-"),
          question: s.goal === "roi" ? "Which workflow books a meeting for the least?" : "Which workflow books the most meetings from a positive reply?",
        })),
      );
      studies.push(meetingBookingCostStudy(sumFigures(buckets.map((b) => b.figures)), input.meeting.outcomesRequired, { workflows: acted, unattributableCampaigns: input.meeting.unattributableCampaigns }));
      if (input.meeting.series) {
        studies.push(
          ...overTimeStudies(
            t,
            input.meeting.series.best,
            input.meeting.series.median,
            dayText,
            "day by day",
            `${t.note} Recorded day by day from Oct 18, 2026; on the clients who report their booked meetings to us. While no workflow has ${input.meeting.outcomesRequired} meetings, the best one available stands in, marked Learning; while no workflow alone can claim a meeting (a campaign run by several), the pipe as a whole does.`,
          ),
        );
      }
      studies.push(...meetingBookingComparisonStudies(acted));
    }
  }
  studies.push(meetingBeforeAfterStudy(input.beforeAfter, input.meetingOutcomesRequired));
  if (input.reportingBrands !== undefined) {
    studies.push(
      input.costBasis === "actual"
        ? notMeasuredStudy({ id: "meeting-cost", pipe: null, outcome: "meeting", topic: "cost", goal: "roi", question: "What does a booked meeting cost, from the first cold email?", headline: "Not measured on vendor cost yet.", reason: "The meeting figures are on what clients were charged only. Switch to the billed basis to read them." })
        : meetingCostStudy(input.reportingBrands, input.meetingOutcomeRequired ?? input.meetingOutcomesRequired, input.now.toISOString().slice(0, 10)),
    );
  }

  // the studies read on each email sent
  if (input.sends) {
    for (const [pipe, p, part] of [
      [POSITIVE_REPLY_PIPE, input.reply, input.sends.reply],
      [WEBSITE_VISIT_PIPE, input.visit, input.sends.visit],
    ] as const) {
      if (!part.groups.length) continue;
      const sp = { terms: termsOf(pipe, p, note), visit: pipe === WEBSITE_VISIT_PIPE, groups: part.groups, spend: part.spend };
      studies.push(...followupStudies(sp));
      if (pipe === POSITIVE_REPLY_PIPE) {
        const wd = timingStudy(sp, "weekday");
        if (wd) studies.push(wd);
      }
      const hr = timingStudy(sp, "hour");
      if (hr) studies.push(hr);
    }
    if (input.sends.opens && input.reply.cutoffDay) studies.push(...opensStudies(termsOf(POSITIVE_REPLY_PIPE, input.reply, note), input.sends.opens, input.reply.cutoffDay));
  }
  studies.push(...input.generationStudies);
  if (input.replyDelay !== undefined) studies.push(replyDelayStudy(input.replyDelay, TIME_TO_REPLY_MIN_SAMPLE));
  studies.push(...jevStudies({ ...input.jev, costBasis: input.costBasis, readOn: input.now.toISOString().slice(0, 10) }));

  const iso = input.now.toISOString();
  const cutoffs = [input.reply.cutoffDay, input.visit.cutoffDay].filter((c): c is string => c !== null).sort();
  const firstMonth = [...input.reply.cells, ...input.visit.cells]
    .flatMap((c) => Object.keys(c.flash.months))
    .sort()[0];
  return {
    generatedAt: iso,
    computedAt: iso,
    allOrgs: true,
    costBasis: input.costBasis,
    unpricedBilledUsd: input.costBasis === "actual" ? input.unpricedBilledUsd : 0,
    window: { from: firstMonth ?? iso.slice(0, 7), to: iso.slice(0, 7) },
    readOn: iso.slice(0, 10),
    // Absent, never a 0, when the counts could not be read this build.
    ...(input.volume
      ? {
          volume: {
            emails: input.volume.emails,
            orgs: input.volume.orgs,
            workflows: input.volume.workflows,
            linkedEmails: input.volume.linkedEmails,
            byMonth: input.volume.byMonth.map((m) => ({ label: MONTH_LABELS[Number(m.month.slice(5, 7)) - 1] ?? m.month, emails: m.emails })),
          },
        }
      : {}),
    maturation: {
      rule: "run_start",
      days: Math.max(input.reply.durationDays, input.visit.durationDays),
      cutoff: cutoffs[0] ?? iso.slice(0, 10),
      windowEnd: iso.slice(0, 10),
      legs: {
        reply: { durationDays: input.reply.durationDays, outcomesRequired: input.reply.outcomesRequired, cutoff: input.reply.cutoffDay ?? iso.slice(0, 10) },
        visit: { durationDays: input.visit.durationDays, outcomesRequired: input.visit.outcomesRequired, cutoff: input.visit.cutoffDay ?? iso.slice(0, 10) },
      },
      ...(input.volume ? { excludedEmails: input.volume.excludedEmails, noRunStart: input.volume.noRunStart } : {}),
      note,
    },
    pipes: [
      { id: POSITIVE_REPLY_PIPE, channel: "sales-cold-email-outreach", leg: "lead_found_to_conversation", outcome: "Positive reply", description: "Cold email that gets a prospect to answer with interest." },
      { id: WEBSITE_VISIT_PIPE, channel: "sales-cold-email-outreach", leg: "lead_found_to_website_visit", outcome: "Website visit", description: "Cold email that brings a prospect to the website." },
      { id: MEETING_BOOKING_PIPE, channel: "ai-meeting-booking", leg: "conversation_to_meeting_booked", outcome: "Meeting booked", description: "Turns a positive reply into a booked meeting." },
    ],
    outcomes: [
      ...(input.replyDelay !== undefined ? [POSITIVE_REPLY_OUTCOME] : []),
      JUDGMENT_OUTCOME,
      {
        id: "meeting",
        outcome: "Meeting booked",
        description: "One outcome across every leg, from the first cold email to the meeting.",
        population: "The brands whose AI Meeting Booking went live, each split at its own go-live.",
      },
    ],
    studies,
    // A study served is never listed as waiting; a timing study a leg cannot rank yet (every hour Learning) stays listed.
    unavailable: UNAVAILABLE.filter((u) => !studies.some((st) => st.id === u.id)).map((u) =>
      ["cold-email-positive-reply-weekday-rate", "cold-email-positive-reply-hour-rate", "cold-email-website-visit-hour-rate"].includes(u.id) && input.sends
        ? { id: u.id, reason: "Too few outcomes on emails whose prospect's timezone is known to rank a day or an hour yet (every bucket is still Learning)." }
        : u,
    ),
  };
}
