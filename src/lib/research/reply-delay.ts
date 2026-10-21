/**
 * "How long before a first positive reply?" (TTFPR-RESEARCH-STUDY-1021, owner 2026-10-21: a distribution curve,
 * median, average, percentiles). Pure: `routes/research.ts` reads the figure, this writes the study.
 *
 * ONE definition of the delay, lead-service's (REPLY-LATENCY-ALL-CHANNELS-1019, the one the campaign page's
 * "expect a positive reply about N days after the first message" reads): from the FIRST message we sent a person, any
 * channel, to that person's FIRST positive reply after it, since inception. lead-service also serves the shape of the
 * same sample (TTFPR-DISTRIBUTION-1021): p10..p90 and the people per delay bucket with the running count. Nothing is
 * recomputed here (never from our outreach copy, which is email only): this module only checks the figure holds
 * together, words it, and reads its shape into plain sentences.
 */
import { n } from "./format.js";
import { notMeasuredStudy } from "./studies.js";
import { headlineFor } from "./verdict.js";
import type { ResearchChart, ResearchOutcomeEntry, ResearchPoint, ResearchStudy } from "./types.js";

export const REPLY_DELAY_STUDY_ID = "positive-reply-delay";
export const POSITIVE_REPLY_OUTCOME_ID = "positive-reply" as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** One delay bucket as lead-service serves it: [fromMs, toMs), the last one open-ended. */
export interface ReplyDelayBucket {
  key: string;
  label: string;
  fromMs: number;
  toMs: number | null;
  count: number;
  cumulativeCount: number;
}

/** lead-service's fleet figure over every reply-pipe campaign (`timeToFirstPositiveReply`, its own names). */
export interface ReplyDelayDistribution {
  sampleSize: number;
  medianMs: number | null;
  averageMs: number | null;
  percentilesMs: { p10: number | null; p25: number | null; p50: number | null; p75: number | null; p90: number | null };
  distribution: ReplyDelayBucket[];
}

export interface ReplyDelayRead {
  metric: ReplyDelayDistribution;
  /** The campaigns behind it: every org's campaigns whose leg ends on a positive reply. */
  campaigns: number;
}

/** A delay in human units: minutes under an hour, hours under a day, then days. */
export function delayText(ms: number): string {
  if (ms < HOUR) {
    const m = Math.max(1, Math.round(ms / MINUTE));
    return `${m} ${m === 1 ? "minute" : "minutes"}`;
  }
  const unit = ms < DAY ? HOUR : DAY;
  const word = ms < DAY ? "hour" : "day";
  const v = ms / unit;
  const shown = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
  return `${shown} ${shown === 1 ? word : `${word}s`}`;
}

/** A share of the sample, in words: whole percents, one decimal under 10%. */
const shareText = (count: number, total: number): string => {
  const pct = (100 * count) / total;
  return `${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%`;
};
const sharePct = (count: number, total: number): number => Math.round((10_000 * count) / total) / 100;
const repliesText = (v: number): string => `${n(v)} ${v === 1 ? "positive reply" : "positive replies"}`;

/**
 * PURE. Checks lead-service's figure holds together before anything is written on it: buckets sum to the sample with
 * a running count that adds up, percentiles ordered, p50 = the median. A figure that does not is UNREADABLE (throws),
 * never patched here.
 */
export function assertReplyDelayCoherent(m: ReplyDelayDistribution): void {
  if (m.sampleSize === 0) return;
  let running = 0;
  for (const b of m.distribution) {
    running += b.count;
    if (b.cumulativeCount !== running) throw new Error(`reply-delay: bucket ${b.key} running count ${b.cumulativeCount} != ${running}`);
  }
  if (running !== m.sampleSize) throw new Error(`reply-delay: buckets sum to ${running}, sample is ${m.sampleSize}`);
  const p = m.percentilesMs;
  const ordered = [p.p10, p.p25, p.p50, p.p75, p.p90];
  if (ordered.some((v) => v === null) || m.medianMs === null || m.averageMs === null) throw new Error("reply-delay: a percentile, the median or the average is null on a non-empty sample");
  for (let i = 1; i < ordered.length; i++) if (ordered[i]! < ordered[i - 1]!) throw new Error("reply-delay: percentiles are not ordered");
  if (p.p50 !== m.medianMs) throw new Error(`reply-delay: p50 ${p.p50} != median ${m.medianMs}`);
}

/** The outcome section the study sits in: every pipe whose leg ends on a positive reply. */
export const POSITIVE_REPLY_OUTCOME: ResearchOutcomeEntry = {
  id: POSITIVE_REPLY_OUTCOME_ID,
  outcome: "Positive reply",
  step: "conversation",
  pipes: ["cold-email-positive-reply"],
  description: "A prospect answers one of our messages with interest, on any pipe whose leg ends on a positive reply.",
  population: "Every client's campaigns on a pipe ending on a positive reply, since the first message we sent.",
};

const QUESTION = "How long before a first positive reply?";
const base = {
  id: REPLY_DELAY_STUDY_ID,
  pipe: null,
  outcome: POSITIVE_REPLY_OUTCOME_ID,
  // `conversion` until the dashboard reads `delay` (its TOPIC_LOOK has no fallback: an unknown topic crashes the page).
  topic: "conversion" as const,
  goal: "rate" as const,
  question: QUESTION,
};

/**
 * PURE. The study. `read` null = lead-service could not be read this build; an empty sample = no positive reply after
 * a first message on record; under `minSample` (the campaign page's own bar, `TIME_TO_REPLY_MIN_SAMPLE`) the figures
 * are served marked Learning with status `not_enough_data`, never a verdict.
 */
export function replyDelayStudy(read: ReplyDelayRead | null, minSample: number): ResearchStudy {
  if (!read) {
    return notMeasuredStudy({
      ...base,
      headline: "Not readable right now.",
      reason: "lead-service's time from a first message to a first positive reply could not be read this time. The study comes back on the next build.",
    });
  }
  const m = read.metric;
  if (m.sampleSize === 0) {
    return notMeasuredStudy({
      ...base,
      headline: "No positive reply yet.",
      reason: `No positive reply after a first message is on record yet, over ${n(read.campaigns)} ${read.campaigns === 1 ? "campaign" : "campaigns"} ending on a positive reply.`,
    });
  }
  const N = m.sampleSize;
  const p = m.percentilesMs as { p10: number; p25: number; p50: number; p75: number; p90: number };
  const median = m.medianMs as number;
  const average = m.averageMs as number;
  const learning = N < minSample;

  const sample = `${repliesText(N)} · ${n(read.campaigns)} ${read.campaigns === 1 ? "campaign" : "campaigns"} · every client, since the first message`;
  const histogram: ResearchPoint[] = m.distribution.map((b) => ({
    key: b.key,
    label: b.label,
    value: sharePct(b.count, N),
    display: `${shareText(b.count, N)} (${n(b.count)})`,
    note: `${n(b.count)} of ${repliesText(N)}`,
    thin: learning,
  }));
  const curve: ResearchPoint[] = m.distribution.map((b) => ({
    key: b.key,
    label: b.toMs === null ? "Any time" : `Within ${delayText(b.toMs)}`,
    value: sharePct(b.cumulativeCount, N),
    display: shareText(b.cumulativeCount, N),
    note: `${n(b.cumulativeCount)} of ${repliesText(N)}`,
    thin: learning,
  }));
  const charts: ResearchChart[] = [
    {
      kind: "bars",
      title: "First positive replies by delay after the first message (% of replies)",
      lowerIsBetter: false,
      points: histogram,
      curve: { title: "Share of first positive replies arrived by then (%)", points: curve },
      note: "The delay runs from the first message we sent a person, on any channel, to their first positive reply after it. People who never replied positively are not counted.",
    },
  ];

  const stats = [
    { key: "p10", label: "1 in 10 replied within", ms: p.p10 },
    { key: "p25", label: "1 in 4 replied within", ms: p.p25 },
    { key: "median", label: "Half replied within", ms: median },
    { key: "p75", label: "3 in 4 replied within", ms: p.p75 },
    { key: "p90", label: "9 in 10 replied within", ms: p.p90 },
    { key: "average", label: "Average delay", ms: average },
  ].map((s) => ({ ...s, display: delayText(s.ms) }));

  // The shape, read off the served numbers only.
  const conclusion: string[] = [];
  const firstDay = m.distribution.filter((b) => b.toMs !== null && b.toMs <= DAY).at(-1);
  if (firstDay) {
    conclusion.push(`${shareText(firstDay.cumulativeCount, N)} of first positive replies arrive within the first day after the first message (${n(firstDay.cumulativeCount)} of ${n(N)}).`);
  }
  conclusion.push(`Half arrive within ${delayText(median)}, 3 in 4 within ${delayText(p.p75)}, and 1 in 10 takes longer than ${delayText(p.p90)}.`);
  const later = m.distribution.filter((b) => b.fromMs >= DAY && b.count > 0);
  const wave = later.reduce<ReplyDelayBucket | null>((best, b) => (best === null || b.count > best.count ? b : best), null);
  if (wave) conclusion.push(`After the first day, the largest group arrives ${wave.label.toLowerCase()} after the first message: ${n(wave.count)} replies, ${shareText(wave.count, N)} of all.`);
  conclusion.push(
    average > median
      ? `The average (${delayText(average)}) sits above the median (${delayText(median)}): a tail of late replies pulls it up, so the median is the typical wait.`
      : `The average (${delayText(average)}) is close to the median (${delayText(median)}): few late replies.`,
  );

  return {
    ...base,
    status: learning ? "not_enough_data" : "measured",
    headline: learning
      ? `Learning: ${repliesText(N)} so far, the figure needs ${n(minSample)}.`
      : headlineFor(`Half of first positive replies arrive within ${delayText(median)} of the first message.`, "signal"),
    winner: null,
    crowned: false,
    verdict: learning
      ? { kind: "noise", reason: `Learning: ${repliesText(N)} of the ${n(minSample)} a typical delay needs.` }
      : { kind: "signal", reason: `A measurement on ${repliesText(N)}, not a comparison: nothing to beat.` },
    result: { display: delayText(median), unit: "median time to a first positive reply", sample },
    charts,
    delay: { sampleSize: N, stats },
    conclusion,
  };
}
