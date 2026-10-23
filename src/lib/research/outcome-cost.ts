/**
 * "What does a <outcome> cost, every path?" (owner 2026-10-23, COST-ACCOUNTING-1023-P2). Pure.
 *
 * One study per OUTCOME section (never a pipe's): every client, every channel, every starting point, read on the
 * runs-service ledger (each run states the outcomes it produced and consumed) and rolled up the graph those
 * declarations draw (`lib/outcome-unit-costs.ts`). The figure is a unit production cost: one occurrence's own cost
 * plus every input it consumed, each at its own unit cost (a reused lead carries the price paid to find it).
 *
 * The ledger only prices the spend whose run declared an outcome: while the declared share (coverage) is under
 * `COVERAGE_BAR_PCT`, the figure is a FLOOR and says so, never a verdict.
 */
import { n, usd } from "./format.js";
import { headlineFor, type Verdict } from "./verdict.js";
import { notMeasuredStudy } from "./studies.js";
import type { ResearchOutcomeId, ResearchStudy } from "./types.js";
import type { OutcomeUnitCost } from "../outcome-unit-costs.js";

/** Below this share of the scope's spend declared to the ledger, a unit cost is a floor, not a price. */
export const COVERAGE_BAR_PCT = 95;

export interface OutcomeCostInput {
  outcome: ResearchOutcomeId;
  /** The outcome in words, singular and plural ("positive reply", "positive replies"). */
  noun: string;
  nounPlural: string;
  /** The roll-up of the outcome's catalogue step; null = the ledger could not be read this build. */
  unit: OutcomeUnitCost | null;
  /** Share of the spend in scope whose run declared an outcome, 0..100; null = not served. */
  coveragePct: number | null;
  /** The maturity bar of the outcome (`lib/maturity.ts`): fewer occurrences read Learning. */
  outcomesRequired: number;
  /** A catalogue step key in words ("Email checked"). */
  labelOf: (stepKey: string) => string;
}

export const outcomeCostStudyId = (outcome: ResearchOutcomeId) => `${outcome}-cost-every-path`;

/** PURE. The study. */
export function outcomeCostStudy(input: OutcomeCostInput): ResearchStudy {
  const base = {
    id: outcomeCostStudyId(input.outcome),
    pipe: null,
    outcome: input.outcome,
    topic: "cost" as const,
    goal: "roi" as const,
    question: `What does a ${input.noun} cost, every path?`,
  };
  const u = input.unit;
  if (!u) return notMeasuredStudy({ ...base, headline: "Not readable right now.", reason: "runs-service's outcome ledger could not be read this time. The study comes back on the next build." });
  if (u.unpricedReason === "consumption_cycle_diverges") {
    return notMeasuredStudy({ ...base, headline: "Not priceable yet.", reason: `Each ${input.noun} declared consumes one ${input.noun} or more of the same kind, so the ledger's declarations draw a loop with no finite cost. The declaring service has to state what each one really consumed.` });
  }
  if (u.produced === 0 || u.unitCostUsd === null) {
    return notMeasuredStudy({ ...base, headline: `No ${input.noun} declared to the ledger yet.`, reason: `No run has declared a ${input.noun} to runs-service's ledger yet, so nothing prices one. Every service that spends is being wired to declare what it produces.` });
  }
  const cov = input.coveragePct;
  const floor = cov === null || cov < COVERAGE_BAR_PCT;
  const covText = cov === null ? "an unknown share" : `${cov < 10 ? cov.toFixed(1) : Math.round(cov)}%`;
  const learning = u.produced < input.outcomesRequired;
  const verdict: Verdict = floor
    ? { kind: "noise", reason: `The ledger holds ${covText} of the spend so far: the rest is not declared yet, so this is a floor, not a price.` }
    : learning
      ? { kind: "noise", reason: `Learning: ${n(u.produced)} of the ${n(input.outcomesRequired)} ${input.nounPlural} a figure needs.` }
      : { kind: "signal", reason: `A measurement on ${n(u.produced)} ${input.nounPlural}: one price, no rival to beat.` };
  const price = u.unitCostUsd;
  const sample = `${n(u.produced)} ${u.produced === 1 ? input.noun : input.nounPlural} · every client, every path · ${covText} of the spend declared`;
  const unpriced = u.unpricedInputs.length
    ? [`${u.unpricedInputs.map(input.labelOf).join(", ")} ${u.unpricedInputs.length === 1 ? "is" : "are"} consumed but declared by no run yet: ${u.unpricedInputs.length === 1 ? "its" : "their"} cost is missing from the figure.`]
    : [];
  return {
    ...base,
    status: "measured",
    headline: headlineFor(`${floor ? "At least " : ""}${usd(price)} per ${input.noun}, every path, from the first lead found to the ${input.noun}.`, verdict.kind),
    winner: null,
    crowned: false,
    verdict: { kind: verdict.kind, reason: verdict.reason },
    result: { display: `${floor ? "≥ " : ""}${usd(price)}`, unit: `per ${input.noun}, every path, production cost`, sample },
    charts: [
      {
        kind: "bars",
        title: `Where one ${input.noun} costs (USD per ${input.noun}, lower is better)`,
        lowerIsBetter: true,
        points: u.stages.map((s) => ({
          key: s.outcomeKey,
          label: input.labelOf(s.outcomeKey),
          value: Number(s.costPerUnitUsd.toFixed(4)),
          display: usd(s.costPerUnitUsd),
          note: `${s.requirementPerUnit < 10 ? s.requirementPerUnit.toFixed(2) : n(Math.round(s.requirementPerUnit))} ${input.labelOf(s.outcomeKey).toLowerCase()} per ${input.noun}`,
          thin: floor || learning,
        })),
        note: `Each stage's own production cost, times how many of it one ${input.noun} needs, along every path. The stages add up to the figure.`,
      },
    ],
    conclusion: [
      `One ${input.noun} costs ${usd(price)} to produce, its own stage ${usd(u.ownUnitCostUsd ?? 0)} and every stage before it at its own unit cost: a lead reused by a second campaign carries the price paid to find it.`,
      `Read on what each run declared it produced and consumed, on every client and every channel: ${covText} of the spend is declared so far.`,
      ...unpriced,
    ],
  };
}
