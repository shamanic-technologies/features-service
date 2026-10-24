/**
 * "What does a <outcome> cost, every path?" (owner 2026-10-23, COST-ACCOUNTING-1023-P2). Pure.
 *
 * One study per OUTCOME section (never a pipe's): every client, every channel, every starting point, read on the
 * runs-service ledger (each run states the outcomes it produced and consumed) and rolled up the graph those
 * declarations draw (`lib/outcome-unit-costs.ts`). The figure is a unit production cost: one occurrence's own cost
 * plus every input it consumed, each at its own unit cost (a reused lead carries the price paid to find it).
 *
 * The ledger only prices the spend whose run declared an outcome: while the declared share (coverage) is under
 * `COVERAGE_BAR_PCT`, the figure is a FLOOR and says so, never a verdict. Coverage reads on OUTCOME spend only
 * (COST-SUPPORT-1024-FEATURES): support spend (payment fees, brand setup, Copilot, a retired product...) produces no
 * outcome by design, is stated apart per function in one line, and is in neither side of the share.
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
  /** Share of the OUTCOME spend (support apart) whose run declared an outcome, 0..100; null = not served. */
  coveragePct: number | null;
  /** Support spend stated apart, per support function (runs-service's key), USD; absent = not served. */
  support?: { byFunction: Array<{ fn: string; usd: number }>; daysMissing: number };
  /** Days since inception the ledger has not computed yet: the figure stands on the others. */
  daysMissing?: number;
  /** Fleet spend on no outcome's production (unknown leg, or no pipe's output: our newsletter), USD. */
  unattributedCostUsd?: number;
  /** The maturity bar of the outcome (`lib/maturity.ts`): fewer occurrences read Learning. */
  outcomesRequired: number;
  /** A catalogue step key in words ("Email checked"). */
  labelOf: (stepKey: string) => string;
}

/** runs-service's support functions in words; an unknown key prints as is. */
const SUPPORT_FUNCTION_LABELS: Record<string, string> = {
  payment_fees: "payment fees",
  brand_setup: "brand setup",
  copilot: "Copilot",
  platform_llm: "platform AI calls",
  staff_experiment: "staff tests",
  product_feature: "product features",
  retired_product: "retired products",
};

/** PURE. The one line naming the spend apart, per function in dollars. */
export function supportLine(support: NonNullable<OutcomeCostInput["support"]>): string {
  const parts = support.byFunction.map((f) => `${SUPPORT_FUNCTION_LABELS[f.fn] ?? f.fn.replace(/_/g, " ")} ${usd(f.usd)}`);
  const pending = support.daysMissing > 0 ? ` (${n(support.daysMissing)} ${support.daysMissing === 1 ? "day" : "days"} not split yet)` : "";
  return parts.length > 0
    ? `Apart, in no figure: ${parts.join(" · ")}${pending}.`
    : `Apart, in no figure: no support spend marked yet${pending}.`;
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
  // Occurrences declared but no spend carried yet (the ledger spreads a day's spend on its next pass): never a $0 price.
  if (u.unitCostUsd <= 0) {
    return notMeasuredStudy({ ...base, headline: "No cost carried yet.", reason: `${n(u.produced)} ${u.produced === 1 ? input.noun : input.nounPlural} declared to the ledger, but no spend is spread on ${u.produced === 1 ? "it" : "them"} yet: runs-service's ledger spreads each day's spend on its next pass.` });
  }
  const cov = input.coveragePct;
  const missing = input.daysMissing ?? 0;
  const floor = cov === null || cov < COVERAGE_BAR_PCT || missing > 0;
  const covText = cov === null ? "an unknown share" : `${cov < 10 ? cov.toFixed(1) : Math.round(cov)}%`;
  const learning = u.produced < input.outcomesRequired;
  const verdict: Verdict = floor
    ? { kind: "noise", reason: `The ledger holds ${covText} of the outcome spend so far${missing > 0 ? `, and ${n(missing)} ${missing === 1 ? "day" : "days"} since inception ${missing === 1 ? "is" : "are"} still being computed` : ""}: the rest is not declared yet, so this is a floor, not a price.` }
    : learning
      ? { kind: "noise", reason: `Learning: ${n(u.produced)} of the ${n(input.outcomesRequired)} ${input.nounPlural} a figure needs.` }
      : { kind: "signal", reason: `A measurement on ${n(u.produced)} ${input.nounPlural}: one price, no rival to beat.` };
  const price = u.unitCostUsd;
  const sample = `${n(u.produced)} ${u.produced === 1 ? input.noun : input.nounPlural} · every client, every path, since inception · ${covText} of the outcome spend declared${missing > 0 ? ` · ${n(missing)} days still computing` : ""}`;
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
        note: `Each stage's production cost per ${input.noun}: every occurrence the pipes ending on a ${input.noun} produced, the ones that led nowhere included (an unanswered send rides the replies), and what it bought from earlier pipes at their own unit cost. The stages add up to the figure.`,
      },
    ],
    conclusion: [
      `One ${input.noun} costs ${usd(price)} to produce: its own pipes ${usd(u.ownUnitCostUsd ?? 0)}, everything they produced included (what led nowhere rides what did), and what it bought from earlier pipes at their own unit cost.`,
      ...(u.byProducts > 0 ? [`${n(u.byProducts)} more ${u.byProducts === 1 ? input.noun : input.nounPlural} came from pipes aimed at another outcome: by-products at $0, left out of the figure.`] : []),
      ...((input.unattributedCostUsd ?? 0) > 0 ? [`${usd(input.unattributedCostUsd!)} of declared spend belongs to no pipe's outcome (our newsletter, a campaign with no stated leg): in no figure.`] : []),
      `Read on what each run declared it produced and consumed, on every client and every channel: ${covText} of the outcome spend is declared so far.`,
      ...(input.support ? [supportLine(input.support)] : []),
      ...unpriced,
    ],
  };
}
