/**
 * "On the ledger: which workflow gets a positive reply cheapest, every stage counted?" (owner 2026-10-23,
 * COST-ACCOUNTING-1023-P4). Pure. A study of the positive reply PIPE, BESIDE the measured workflow study and the
 * ranking (the figure the pipe picks by), never in their place: per workflow dynasty, the ledger's unit production cost
 * (`workflowUnitCosts`: its whole production on the reply pipes, the sends nobody answered included, ÷ the replies to
 * its sends, + the shared per-reply stages) next to the ranking row's cost per positive reply. No order, budget or
 * pick reads it until every workflow's figure stands on its full spend and the gap is explained.
 */
import { n, usd } from "./format.js";
import { notMeasuredStudy } from "./studies.js";
import type { ResearchPoint, ResearchStudy } from "./types.js";

export const WORKFLOW_LEDGER_STUDY_ID = "cold-email-positive-reply-workflow-ledger";

export interface WorkflowLedgerRow {
  key: string;
  label: string;
  /** Replies to this workflow's sends on the ledger. */
  outcomes: number;
  /** Its production on the reply pipes, USD. */
  ownCostUsd: number;
  unitCostUsd: number | null;
  /** The ranking row's cost per positive reply and the half it is read on (null = not ranked / no outcome). */
  todayCostUsd: number | null;
  todayBasis: "mature" | "flash" | null;
}

/** PURE. `floorReason` = why every figure is a floor (coverage under the bar, ledger days computing), null when none. */
export function workflowLedgerStudy(input: { pipe: string; rows: readonly WorkflowLedgerRow[] | null; floorReason: string | null }): ResearchStudy {
  const base = {
    id: WORKFLOW_LEDGER_STUDY_ID,
    pipe: input.pipe,
    topic: "workflow" as const,
    goal: "roi" as const,
    question: "On the ledger: which workflow gets a positive reply cheapest, every stage counted?",
  };
  if (!input.rows) return notMeasuredStudy({ ...base, headline: "Not readable right now.", reason: "runs-service's outcome ledger, by workflow, could not be read this time. The study comes back on the next build." });
  const priced = input.rows.filter((r) => r.unitCostUsd !== null && r.unitCostUsd > 0).sort((a, b) => a.unitCostUsd! - b.unitCostUsd! || a.label.localeCompare(b.label));
  if (priced.length === 0) return notMeasuredStudy({ ...base, headline: "No workflow priced on the ledger yet.", reason: "No positive reply on the ledger names the workflow whose send it answered yet." });
  const floor = input.floorReason !== null;
  const points: ResearchPoint[] = priced.map((r) => ({
    key: r.key,
    label: r.label,
    value: Number(r.unitCostUsd!.toFixed(2)),
    display: `${floor ? "≥ " : ""}${usd(r.unitCostUsd!)}`,
    note: `Ledger: ${usd(r.ownCostUsd)} produced ÷ ${n(r.outcomes)} ${r.outcomes === 1 ? "reply" : "replies"} to its sends · ranking: ${r.todayCostUsd === null ? "no price yet" : `${usd(r.todayCostUsd)} (${r.todayBasis})`}`,
    thin: floor || r.outcomes < 1,
  }));
  const lead = priced[0]!;
  return {
    ...base,
    status: "measured",
    headline: `On the ledger, ${lead.label} at ${floor ? "at least " : ""}${usd(lead.unitCostUsd!)} per positive reply, beside the ranking's ${lead.todayCostUsd === null ? "no price yet" : usd(lead.todayCostUsd)}. Noise so far.`,
    winner: null,
    crowned: false,
    verdict: { kind: "noise", reason: input.floorReason ?? "A second basis beside the ranking, not a verdict: nothing picks on it until the gap is explained." },
    result: null,
    charts: [
      {
        kind: "bars",
        title: "Cost per positive reply per workflow, on the ledger (USD, lower is better)",
        lowerIsBetter: true,
        points,
        note: "The bar is everything the workflow produced on the reply pipes (the sends nobody answered included) divided by the replies to its sends, plus each reply's share of what every reply carries (judging the reply). The note gives the ranking's figure, the one the pipe picks by.",
      },
    ],
    conclusion: [
      `${n(priced.length)} ${priced.length === 1 ? "workflow" : "workflows"} priced on the ledger beside the ranking; the pipe keeps picking on the ranking.`,
      ...(input.floorReason ? [input.floorReason] : []),
    ],
  };
}
