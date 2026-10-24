/**
 * WHAT ONE WRITING RUN OF A MODEL COSTS ON A PIPE (MODEL-RUN-COST-1024, owner via the staff Research > Models page). Pure.
 *
 * A run = one generation a model wrote on the pipe's campaigns (every client, every workflow and template of the pipe
 * pooled), its cost = the LLM cost of the completion that wrote it (`lib/generation-completion-costs.ts`: billed gross,
 * committed, the model bars' spend basis), split input tokens (cache folded in) vs output tokens. Figures:
 *  - `averageUsd` = Σ cost ÷ runs priced; `averageInputUsd` + `averageOutputUsd` = `averageUsd`;
 *  - `history` = one point per UTC day a priced run was written, the CUMULATIVE average to that day, so its last point
 *    IS `averageUsd`;
 *  - runs whose cost is unknown (no completion stated, run not found, not read yet) are counted apart
 *    (`runsWithoutCost`), never as $0.
 * No run priced = every average null + `unavailableReason` (`no_run_on_pipe` when the model wrote nothing here).
 */

export interface GenerationCostInput {
  createdAt: string;
  /** The concrete model id that wrote it. */
  model: string;
  /** Null = cost not known (no completion run stated, run not found, not read yet). */
  inputCents: number | null;
  outputCents: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
}

export type RunCostUnavailableReason = "no_run_on_pipe" | "no_run_cost_known" | "not_on_vendor_basis" | "run_costs_unreadable";

export interface CatalogRunCost {
  /** Runs on the pipe whose cost is known (the average's denominator). */
  runs: number;
  /** Runs on the pipe whose cost is not known; in no figure. */
  runsWithoutCost: number;
  averageUsd: number | null;
  averageDisplay: string | null;
  averageInputUsd: number | null;
  averageOutputUsd: number | null;
  totalUsd: number;
  totalInputUsd: number;
  totalOutputUsd: number;
  /** Over the priced runs that recorded their tokens. */
  averageInputTokens: number | null;
  averageOutputTokens: number | null;
  /** Cumulative average per UTC day a priced run was written, oldest first; last point = `averageUsd`. */
  history: Array<{ day: string; runs: number; averageUsd: number }>;
  basis: "billed_gross_committed";
  cache: "folded_into_input";
  unavailableReason: RunCostUnavailableReason | null;
}

const money = (usd: number) => (usd >= 0.1 ? `$${usd.toFixed(2)}` : usd >= 0.001 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(6)}`);

/** PURE. The run-cost figures of one model page (or one version) over its runs on one pipe. */
export function runCostOf(runs: readonly GenerationCostInput[]): CatalogRunCost {
  const priced = runs.filter((r) => r.inputCents !== null && r.outputCents !== null).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  let input = 0;
  let output = 0;
  let tIn = 0;
  let tOut = 0;
  let tokRuns = 0;
  const history: CatalogRunCost["history"] = [];
  priced.forEach((r, i) => {
    input += r.inputCents!;
    output += r.outputCents!;
    if (r.tokensInput !== null && r.tokensOutput !== null) {
      tIn += r.tokensInput;
      tOut += r.tokensOutput;
      tokRuns++;
    }
    const day = r.createdAt.slice(0, 10);
    const point = { day, runs: i + 1, averageUsd: (input + output) / 100 / (i + 1) };
    if (history.length && history[history.length - 1].day === day) history[history.length - 1] = point;
    else history.push(point);
  });
  const n = priced.length;
  const avg = n ? (input + output) / 100 / n : null;
  return {
    runs: n,
    runsWithoutCost: runs.length - n,
    averageUsd: avg,
    averageDisplay: avg === null ? null : money(avg),
    averageInputUsd: n ? input / 100 / n : null,
    averageOutputUsd: n ? output / 100 / n : null,
    totalUsd: (input + output) / 100,
    totalInputUsd: input / 100,
    totalOutputUsd: output / 100,
    averageInputTokens: tokRuns ? tIn / tokRuns : null,
    averageOutputTokens: tokRuns ? tOut / tokRuns : null,
    history,
    basis: "billed_gross_committed",
    cache: "folded_into_input",
    unavailableReason: n ? null : runs.length ? "no_run_cost_known" : "no_run_on_pipe",
  };
}

/** PURE. A page whose run costs cannot be served at all (vendor basis, or the copy unreadable). */
export function unavailableRunCost(reason: RunCostUnavailableReason): CatalogRunCost {
  return { ...runCostOf([]), unavailableReason: reason };
}

/** PURE. A run's tokens as the last-runs list prints them ("1,234 in / 210 out"); null when not recorded. */
export function tokensText(tokensInput: number | null, tokensOutput: number | null): string | null {
  if (tokensInput === null || tokensOutput === null) return null;
  return `${tokensInput.toLocaleString("en-US")} in / ${tokensOutput.toLocaleString("en-US")} out`;
}
