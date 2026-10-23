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

/** PURE. The study. `dayBins` = lead-service's time-to-first-positive-reply day bins (null = unreadable). */
export function workflowEstimateStudy(input: { pipe: string; groups: readonly WorkflowEstimateGroup[]; dayBins: ReadonlyArray<{ count: number }> | null; outcomesRequired: number }): ResearchStudy {
  const base = {
    id: WORKFLOW_ESTIMATE_STUDY_ID,
    pipe: input.pipe,
    topic: "workflow" as const,
    goal: "roi" as const,
    question: "Estimated: which workflow gets a positive reply cheapest, young cohorts included?",
  };
  if (!input.dayBins) return notMeasuredStudy({ ...base, headline: "Not readable right now.", reason: "lead-service's reply-delay curve could not be read this time: without it, a young cohort cannot be corrected. The study comes back on the next build." });
  const F = lagCurveOf(input.dayBins);
  const groups = input.groups
    .map((g) => ({ ...g, contacted: g.slices.reduce((a, s) => a + s.contacted, 0), exposure: effectiveExposure(g.slices, F) }))
    .filter((g) => g.contacted > 0);
  if (groups.length === 0) return notMeasuredStudy({ ...base, headline: "No one emailed yet.", reason: "No workflow of this pipe has emailed anybody yet." });
  const { prior, estimates } = estimateOutcomes(groups.map((g) => ({ key: g.key, outcomes: g.outcomes, exposure: g.exposure, contacted: g.contacted, spendUsd: g.spendUsd })));
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const priced = estimates.filter((e) => e.costPerOutcomeUsd !== null).sort((a, b) => a.costPerOutcomeUsd! - b.costPerOutcomeUsd! || a.key.localeCompare(b.key));
  if (priced.length === 0) return notMeasuredStudy({ ...base, headline: "No spend on record yet.", reason: "No workflow of this pipe carries billed spend yet." });
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
  // The headline names the cheapest workflow the data BOUNDS (at least one outcome): a workflow with none has an estimate, not a price.
  const bounded = priced.filter((e) => e.outcomes > 0);
  const [lead, runner] = bounded.length ? bounded : priced;
  // A lead whose whole range sits below the runner-up's whole range: a signal; overlapping ranges: noise. Never a conclusion: it is a model.
  const kind = runner && lead!.costHighUsd! < runner.costLowUsd! ? ("signal" as const) : ("noise" as const);
  const leadLabel = byKey.get(lead!.key)!.label;
  const reason =
    kind === "signal"
      ? `${leadLabel}'s whole 95% range (${usd(lead!.costLowUsd!)} to ${usd(lead!.costHighUsd!)}) sits below the next workflow's (${usd(runner!.costLowUsd!)} to ${usd(runner!.costHighUsd!)}). An estimate, so a signal at most.`
      : runner
        ? `${leadLabel}'s 95% range overlaps the next workflow's: the order is not settled.`
        : "One workflow only: nothing to compare.";
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
    result: { display: usd(lead!.costPerOutcomeUsd!), unit: "per positive reply, estimated, best workflow", sample: `${n(groups.length)} workflows · ${n(people)} people emailed` },
    charts: [
      {
        kind: "bars",
        title: "Estimated cost per positive reply, young cohorts included (USD, lower is better)",
        lowerIsBetter: true,
        points,
        note: "Each person counts for the share of positive replies the fleet sees by their age (a person emailed yesterday counts for about half). A workflow with few people is drawn toward the pipe's rate. The bar is the estimate, the note its 95% range.",
      },
    ],
    conclusion: [
      `An estimate beside the measured figures, never in their place: ${n(Math.round(young))} of the ${n(people)} people emailed are too young to have replied in full, and the maturity rule waits ${n(input.outcomesRequired)} ${input.outcomesRequired === 1 ? "positive reply" : "positive replies"} and 21 days before it prices a workflow.`,
      ...(withoutOutcome > 0 ? [`${n(withoutOutcome)} ${withoutOutcome === 1 ? "workflow has" : "workflows have"} no positive reply yet: ${withoutOutcome === 1 ? "its" : "their"} estimate leans on the pipe's rate and has no upper bound, so the headline names the cheapest workflow with at least one.`] : []),
      `Prior drawn from every workflow of the pipe: ${pct((100 * prior.alpha) / (prior.alpha + prior.beta))} positive reply rate, as strong as ${n(Math.round(prior.alpha + prior.beta))} people.`,
    ],
  };
}
