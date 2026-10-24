/**
 * "Does the estimate predict?" (owner 2026-10-24, PERF-ESTIMATE-DISCUSS-1024). Pure. A study of the positive reply PIPE.
 *
 * The REPLAY: go back `REPLAY_LOOKBACK_DAYS` days, keep only what was known that day (the people emailed before it, the
 * positive replies DATED before it), and compute each workflow's, template's and LLM's rate two ways: the estimate
 * (`lib/outcome-estimates.ts`: young cohorts counted for their age, small samples drawn toward the pipe) and the plain
 * measured rate of that day (replies known ÷ people emailed). Then compare both to what those SAME people did since
 * (all their positive replies today: every one of them is now older than the reply delay curve's tail). The figure of
 * each side is its average miss, in positive replies per 1,000 people emailed, weighted by people. The estimate earns a
 * place in any order only if it misses less than the measured figure did. Nothing reads it.
 */
import { n } from "./format.js";
import type { ResearchPoint, ResearchStudy } from "./types.js";
import { notMeasuredStudy } from "./studies.js";
import { effectiveExposure, estimateOutcomes, lagCurveOf } from "../outcome-estimates.js";

export const ESTIMATE_REPLAY_STUDY_ID = "cold-email-positive-reply-estimate-replay";
/** How far back the replay stands: past the delay curve's 60-day tail, so today's figure of those people is complete. */
export const REPLAY_LOOKBACK_DAYS = 60;

/** One bucket of people of one part (a workflow, a template or an LLM): served the same day, same reply day. */
export interface ReplayBucket {
  key: string;
  label: string;
  /** `YYYY-MM-DD`. */
  servedDay: string;
  contacted: number;
  positiveReplies: number;
  /** `YYYY-MM-DD` of those replies; null = undated (never placed before the cutoff). */
  positiveReplyDay: string | null;
}

export interface ReplayDimension {
  /** "Workflows", "Templates", "LLMs". */
  label: string;
  buckets: readonly ReplayBucket[];
}

export interface ReplayGroup {
  key: string;
  label: string;
  contacted: number;
  /** Per 1,000 people emailed. */
  estimatePer1000: number;
  measuredThenPer1000: number;
  todayPer1000: number;
}

export interface ReplayDimensionResult {
  label: string;
  groups: ReplayGroup[];
  /** Average miss, per 1,000 people emailed, weighted by people. */
  estimateMissPer1000: number;
  measuredMissPer1000: number;
  repliesToday: number;
  undatedReplies: number;
}

const DAY_MS = 86_400_000;
const per1000 = (v: number) => `${v < 10 ? v.toFixed(2) : v.toFixed(1)} per 1,000`;

/** PURE. One part's replay: the groups as they stood at `cutoffDay`, and what their people did since. */
export function replayDimension(dim: ReplayDimension, cutoffDay: string, F: (ageDays: number) => number): ReplayDimensionResult {
  const cutoff = Date.parse(cutoffDay);
  const by = new Map<string, { key: string; label: string; contacted: number; known: number; today: number; slices: { contacted: number; ageDays: number }[] }>();
  let undated = 0;
  for (const b of dim.buckets) {
    if (!b.servedDay || b.servedDay >= cutoffDay) continue;
    const g = by.get(b.key) ?? { key: b.key, label: b.label, contacted: 0, known: 0, today: 0, slices: [] };
    g.contacted += b.contacted;
    g.today += b.positiveReplies;
    if (b.positiveReplyDay && b.positiveReplyDay < cutoffDay) g.known += b.positiveReplies;
    else if (b.positiveReplies > 0 && !b.positiveReplyDay) undated += b.positiveReplies;
    g.slices.push({ contacted: b.contacted, ageDays: (cutoff - Date.parse(b.servedDay)) / DAY_MS + 0.5 });
    by.set(b.key, g);
  }
  const groups = [...by.values()].filter((g) => g.contacted > 0);
  const { estimates } = estimateOutcomes(
    groups.map((g) => ({ key: g.key, outcomes: g.known, exposure: effectiveExposure(g.slices, F), contacted: g.contacted, spendUsd: 0 })),
  );
  const rateOf = new Map(estimates.map((e) => [e.key, e.ratePct * 10]));
  const rows: ReplayGroup[] = groups
    .map((g) => ({
      key: g.key,
      label: g.label,
      contacted: g.contacted,
      estimatePer1000: rateOf.get(g.key)!,
      measuredThenPer1000: (1000 * g.known) / g.contacted,
      todayPer1000: (1000 * g.today) / g.contacted,
    }))
    .sort((a, b) => b.contacted - a.contacted || a.key.localeCompare(b.key));
  const people = rows.reduce((a, r) => a + r.contacted, 0);
  const miss = (pick: (r: ReplayGroup) => number) => (people > 0 ? rows.reduce((a, r) => a + r.contacted * Math.abs(pick(r) - r.todayPer1000), 0) / people : 0);
  return {
    label: dim.label,
    groups: rows,
    estimateMissPer1000: miss((r) => r.estimatePer1000),
    measuredMissPer1000: miss((r) => r.measuredThenPer1000),
    repliesToday: groups.reduce((a, g) => a + g.today, 0),
    undatedReplies: undated,
  };
}

/** PURE. The study. `dayBins` = lead-service's time-to-first-positive-reply day bins (null = unreadable). */
export function estimateReplayStudy(input: {
  pipe: string;
  dims: readonly ReplayDimension[];
  dayBins: ReadonlyArray<{ count: number }> | null;
  outcomesRequired: number;
  now: Date;
}): ResearchStudy {
  const base = {
    id: ESTIMATE_REPLAY_STUDY_ID,
    pipe: input.pipe,
    topic: "workflow" as const,
    goal: "roi" as const,
    question: "Does the estimate predict? Its figure from two months ago beside what happened since",
  };
  if (!input.dayBins) return notMeasuredStudy({ ...base, headline: "Not readable right now.", reason: "lead-service's reply-delay curve could not be read this time: the replay cannot age the people of two months ago. The study comes back on the next build." });
  const cutoffDay = new Date(Date.parse(input.now.toISOString().slice(0, 10)) - REPLAY_LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
  const F = lagCurveOf(input.dayBins);
  const results = input.dims.map((d) => replayDimension(d, cutoffDay, F)).filter((r) => r.groups.length > 0);
  if (results.length === 0) return notMeasuredStudy({ ...base, headline: "Nobody emailed two months ago.", reason: `Nobody of this pipe was emailed before ${cutoffDay}: nothing to replay yet.` });
  const dated = input.dims.some((d) => d.buckets.some((b) => b.positiveReplies > 0 && b.positiveReplyDay));
  if (!dated) return notMeasuredStudy({ ...base, headline: "Reply dates not on record yet.", reason: "No positive reply of this pipe carries its date yet: the replay cannot tell what was known two months ago. It comes back once the fleet person cell is rebuilt with reply dates." });
  const lead = results[0]!;
  const better = results.filter((r) => r.estimateMissPer1000 < r.measuredMissPer1000).length;
  const kind = better === results.length && results.every((r) => r.repliesToday >= 10 * input.outcomesRequired) ? ("signal" as const) : ("noise" as const);
  const points: ResearchPoint[] = results.flatMap((r) => [
    { key: `${r.label}:estimate`, label: `${r.label}: estimate then`, value: Number(r.estimateMissPer1000.toFixed(3)), display: per1000(r.estimateMissPer1000), note: `${n(r.groups.length)} ${r.label.toLowerCase()}, ${n(r.repliesToday)} positive replies since`, thin: r.repliesToday < 10 },
    { key: `${r.label}:measured`, label: `${r.label}: measured then`, value: Number(r.measuredMissPer1000.toFixed(3)), display: per1000(r.measuredMissPer1000), note: `${n(r.groups.length)} ${r.label.toLowerCase()}, ${n(r.repliesToday)} positive replies since`, thin: r.repliesToday < 10 },
  ]);
  const verdictLine = (r: ReplayDimensionResult) =>
    r.estimateMissPer1000 < r.measuredMissPer1000
      ? `${r.label}: the estimate missed by ${per1000(r.estimateMissPer1000)}, the measured figure of that day by ${per1000(r.measuredMissPer1000)}. The estimate was closer.`
      : `${r.label}: the estimate missed by ${per1000(r.estimateMissPer1000)}, the measured figure of that day by ${per1000(r.measuredMissPer1000)}. The estimate was not closer.`;
  const detail = (r: ReplayDimensionResult) =>
    r.groups
      .slice(0, 3)
      .map((g) => `${g.label} (${n(g.contacted)} people): estimate ${per1000(g.estimatePer1000)}, measured then ${per1000(g.measuredThenPer1000)}, today ${per1000(g.todayPer1000)}`)
      .join(" · ");
  const undated = results.reduce((a, r) => Math.max(a, r.undatedReplies), 0);
  return {
    ...base,
    status: "measured",
    headline:
      better === results.length
        ? `Two months ago, the estimate was closer to what happened than the measured figure, for ${results.map((r) => r.label.toLowerCase()).join(", ")}. ${kind === "signal" ? "A signal, not yet a conclusion." : "Noise so far."}`
        : better === 0
          ? `Two months ago, the estimate was not closer to what happened than the measured figure. ${kind === "signal" ? "A signal." : "Noise so far."}`
          : `Two months ago, the estimate was closer for ${results.filter((r) => r.estimateMissPer1000 < r.measuredMissPer1000).map((r) => r.label.toLowerCase()).join(", ")} only. Noise so far.`,
    winner: null,
    crowned: false,
    verdict: {
      kind,
      reason:
        kind === "signal"
          ? `The estimate missed less on every part, each with at least ${n(10 * input.outcomesRequired)} positive replies since. One replay, so a signal at most.`
          : "One replay, and the estimate did not miss less on every part with enough positive replies since: not settled.",
    },
    result: { display: per1000(lead.estimateMissPer1000), unit: `average miss of the estimate, ${lead.label.toLowerCase()}`, sample: `${n(lead.groups.reduce((a, g) => a + g.contacted, 0))} people emailed before ${cutoffDay}` },
    charts: [
      {
        kind: "bars",
        title: `How far each figure of ${cutoffDay} landed from what those people did since (positive replies per 1,000 people emailed, lower is better)`,
        lowerIsBetter: true,
        points,
        note: "The people emailed before that day, and only the positive replies dated before it. Each figure is compared to all their positive replies today; the miss is averaged over people.",
      },
    ],
    conclusion: [
      ...results.map(verdictLine),
      ...results.map((r) => `${r.label}, largest: ${detail(r)}.`),
      ...(undated > 0 ? [`${n(undated)} positive replies of those people carry no date: counted in today's figure, never as known before ${cutoffDay}.`] : []),
    ],
  };
}
