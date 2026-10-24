/**
 * "Estimated: which workflow gets a positive reply cheapest, young cohorts included?" (owner 2026-10-23,
 * COST-ACCOUNTING-1023-P3). Pure. A study of the positive reply PIPE (its section, never an outcome section's).
 *
 * BESIDE the measured workflow study, never in its place: it reads the same people (the fleet person cell, every
 * version pooled on its dynasty) and the same lifetime billed spend (the leg ranking row), and corrects the two things
 * the maturity rule handles by waiting: young cohorts (censoring, the fleet's own reply-delay curve) and small samples
 * (empirical Bayes toward the pipe). `lib/outcome-estimates.ts` holds the maths. No order, budget or recommendation
 * reads it until the owner approves a replay against the mature figures.
 */
import { n, usd } from "./format.js";
import type { ResearchPoint, ResearchStudy } from "./types.js";
import { notMeasuredStudy } from "./studies.js";
import { effectiveExposure, estimateOutcomes, lagCurveOf, type CohortSlice } from "../outcome-estimates.js";

export const WORKFLOW_ESTIMATE_STUDY_ID = "cold-email-positive-reply-workflow-estimate";
export const TEMPLATE_ESTIMATE_STUDY_ID = "cold-email-positive-reply-template-estimate";
export const LLM_ESTIMATE_STUDY_ID = "cold-email-positive-reply-llm-estimate";

/**
 * What a study estimates (owner 2026-10-24, PERF-ESTIMATE-DISCUSS-1024: the pipe picks its workflow, its template and its
 * LLM separately, so each part gets its own estimate, side by side on the pipe's study list).
 */
export interface EstimateDimension {
  id: string;
  topic: "workflow" | "template" | "llm";
  /** "workflow", "template", "LLM". */
  noun: string;
  nounPlural: string;
}
export const WORKFLOW_DIMENSION: EstimateDimension = { id: WORKFLOW_ESTIMATE_STUDY_ID, topic: "workflow", noun: "workflow", nounPlural: "workflows" };
export const TEMPLATE_DIMENSION: EstimateDimension = { id: TEMPLATE_ESTIMATE_STUDY_ID, topic: "template", noun: "template", nounPlural: "templates" };
export const LLM_DIMENSION: EstimateDimension = { id: LLM_ESTIMATE_STUDY_ID, topic: "llm", noun: "LLM", nounPlural: "LLMs" };

export interface WorkflowEstimateGroup {
  key: string;
  label: string;
  slices: CohortSlice[];
  outcomes: number;
  /** Lifetime spend on the leg, the basis of the page. */
  spendUsd: number;
}

const pct = (v: number) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)}%`;
/** A cost range in words: an upper end 100x the estimate or more means the data cannot bound it yet. */
const rangeText = (e: { costPerOutcomeUsd: number | null; costLowUsd: number | null; costHighUsd: number | null }) =>
  e.costHighUsd === null || e.costHighUsd > 100 * e.costPerOutcomeUsd!
    ? `95% range from ${usd(e.costLowUsd!)}, no upper bound yet`
    : `95% range ${usd(e.costLowUsd!)} to ${usd(e.costHighUsd)}`;

export interface EstimateStudyInput {
  pipe: string;
  groups: readonly WorkflowEstimateGroup[];
  dayBins: ReadonlyArray<{ count: number }> | null;
  outcomesRequired: number;
  /** People of the pipe no group holds (no writer on record): stated, never spread. */
  peopleLeftOut?: number;
}

/** PURE. The workflow study. `dayBins` = lead-service's time-to-first-positive-reply day bins (null = unreadable). */
export function workflowEstimateStudy(input: EstimateStudyInput): ResearchStudy {
  return estimateStudy(WORKFLOW_DIMENSION, input);
}

/** PURE. The estimate study of one part of the pipe (workflow, template or LLM), the same maths for each. */
export function estimateStudy(dim: EstimateDimension, input: EstimateStudyInput): ResearchStudy {
  const W = dim.noun;
  const Ws = dim.nounPlural;
  const base = {
    id: dim.id,
    pipe: input.pipe,
    topic: dim.topic,
    goal: "roi" as const,
    question: `Estimated: which ${W} gets a positive reply cheapest, young cohorts included?`,
  };
  if (!input.dayBins) return notMeasuredStudy({ ...base, headline: "Not readable right now.", reason: "lead-service's reply-delay curve could not be read this time: without it, a young cohort cannot be corrected. The study comes back on the next build." });
  const F = lagCurveOf(input.dayBins);
  const groups = input.groups
    .map((g) => ({ ...g, contacted: g.slices.reduce((a, s) => a + s.contacted, 0), exposure: effectiveExposure(g.slices, F) }))
    .filter((g) => g.contacted > 0);
  if (groups.length === 0) return notMeasuredStudy({ ...base, headline: "No one emailed yet.", reason: `No ${W} of this pipe has emailed anybody yet.` });
  const { prior, estimates } = estimateOutcomes(groups.map((g) => ({ key: g.key, outcomes: g.outcomes, exposure: g.exposure, contacted: g.contacted, spendUsd: g.spendUsd })));
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const priced = estimates.filter((e) => e.costPerOutcomeUsd !== null).sort((a, b) => a.costPerOutcomeUsd! - b.costPerOutcomeUsd! || a.key.localeCompare(b.key));
  if (priced.length === 0) return notMeasuredStudy({ ...base, headline: "No spend on record yet.", reason: `No ${W} of this pipe carries billed spend yet.` });
  const points: ResearchPoint[] = priced.map((e) => {
    const g = byKey.get(e.key)!;
    return {
      key: e.key,
      label: g.label,
      value: Number(e.costPerOutcomeUsd!.toFixed(2)),
      display: usd(e.costPerOutcomeUsd!),
      note: `${rangeText(e)} · rate ${pct(e.ratePct)} (${pct(e.rateLowPct)} to ${pct(e.rateHighPct)}) · ${n(e.outcomes)} of ${n(e.contacted)} people, ${n(Math.round(e.contacted - e.exposure))} still too young to count in full`,
      thin: e.outcomes < input.outcomesRequired,
    };
  });
  // The headline names the cheapest part the data BOUNDS (at least one outcome): a part with none has an estimate, not a price.
  const bounded = priced.filter((e) => e.outcomes > 0);
  const [lead, runner] = bounded.length ? bounded : priced;
  // A lead whose whole range sits below the runner-up's whole range: a signal; overlapping ranges: noise. Never a conclusion: it is a model.
  const kind = runner && lead!.costHighUsd! < runner.costLowUsd! ? ("signal" as const) : ("noise" as const);
  const leadLabel = byKey.get(lead!.key)!.label;
  const reason =
    kind === "signal"
      ? `${leadLabel}'s whole 95% range (${usd(lead!.costLowUsd!)} to ${usd(lead!.costHighUsd!)}) sits below the next ${W}'s (${usd(runner!.costLowUsd!)} to ${usd(runner!.costHighUsd!)}). An estimate, so a signal at most.`
      : runner
        ? `${leadLabel}'s 95% range overlaps the next ${W}'s: the order is not settled.`
        : `One ${W} only: nothing to compare.`;
  const withoutOutcome = priced.length - bounded.length;
  const young = groups.reduce((a, g) => a + (g.contacted - g.exposure), 0);
  const people = groups.reduce((a, g) => a + g.contacted, 0);
  return {
    ...base,
    status: "measured",
    headline: `Estimated, young cohorts included: ${leadLabel} at ${usd(lead!.costPerOutcomeUsd!)} per positive reply (${rangeText(lead!)}). ${kind === "signal" ? "A signal to confirm, not yet a conclusion." : "Noise so far."}`,
    winner: null,
    crowned: false,
    verdict: { kind, reason },
    result: { display: usd(lead!.costPerOutcomeUsd!), unit: `per positive reply, estimated, best ${W}`, sample: `${n(groups.length)} ${Ws} · ${n(people)} people emailed` },
    charts: [
      {
        kind: "bars",
        title: "Estimated cost per positive reply, young cohorts included (USD, lower is better)",
        lowerIsBetter: true,
        points,
        note: `Each person counts for the share of positive replies the fleet sees by their age (a person emailed yesterday counts for about half). A ${W} with few people is drawn toward the pipe's rate. The bar is the estimate, the note its 95% range.`,
      },
    ],
    conclusion: [
      `An estimate beside the measured figures, never in their place: ${n(Math.round(young))} of the ${n(people)} people emailed are too young to have replied in full, and the maturity rule waits ${n(input.outcomesRequired)} ${input.outcomesRequired === 1 ? "positive reply" : "positive replies"} and 21 days before it prices a ${W}.`,
      ...(withoutOutcome > 0 ? [`${n(withoutOutcome)} ${withoutOutcome === 1 ? `${W} has` : `${Ws} have`} no positive reply yet: ${withoutOutcome === 1 ? "its" : "their"} estimate leans on the pipe's rate and has no upper bound, so the headline names the cheapest ${W} with at least one.`] : []),
      ...(input.peopleLeftOut ? [`${n(input.peopleLeftOut)} people emailed have no ${W} on record: left out, never spread.`] : []),
      `Prior drawn from every ${W} of the pipe: ${pct((100 * prior.alpha) / (prior.alpha + prior.beta))} positive reply rate, as strong as ${n(Math.round(prior.alpha + prior.beta))} people.`,
    ],
  };
}
