/**
 * "What does a positive reply cost each client, every path?" (owner 2026-10-23, COST-ACCOUNTING-1023-P4). Pure.
 *
 * P4 serves every ledger figure BESIDE the one a reader uses today and compares them client by client before any reader
 * switches. This study is that comparison for the positive reply: per client (org), the ledger's production cost
 * (`rollUpByOrg`: its own pipes, inputs bought from other clients at the fleet unit cost) next to today's figure (the
 * client's spend on the reply pipes ÷ its positive replies, the person cell's). The two answer different questions on
 * different bases (the ledger counts every stage before the reply, today's figure the reply pipe's spend only), so the
 * gap is stated, never closed by hand. A client whose own coverage is under the bar reads its ledger figure as a floor.
 */
import { n, usd } from "./format.js";
import { COVERAGE_BAR_PCT } from "./outcome-cost.js";
import { notMeasuredStudy } from "./studies.js";
import type { ResearchPoint, ResearchStudy } from "./types.js";
import type { OutcomeUnitCost } from "../outcome-unit-costs.js";

export const COST_BY_CLIENT_STUDY_ID = "positive-reply-cost-by-client";

export interface ClientCostRow {
  orgId: string;
  label: string;
  /** The org's ledger roll-up of the positive reply (null = nothing declared for it). */
  ledger: OutcomeUnitCost | null;
  /** Share of the org's spend its declarations carry, 0..100; null = it spent nothing on the ledger's days. */
  coveragePct: number | null;
  /** Today's figure: spend on the reply pipes and positive replies of the client. */
  todaySpendUsd: number;
  todayReplies: number;
}

const covText = (c: number | null) => (c === null ? "no spend on record" : `${c < 10 ? c.toFixed(1) : Math.round(c)}% of its spend declared`);

/** PURE. The study. `rows` = null when the ledger could not be read this build. */
export function outcomeCostByClientStudy(rows: readonly ClientCostRow[] | null, daysMissing: number): ResearchStudy {
  const base = {
    id: COST_BY_CLIENT_STUDY_ID,
    pipe: null,
    outcome: "positive-reply" as const,
    topic: "cost" as const,
    goal: "roi" as const,
    question: "What does a positive reply cost each client, every path, beside today's figure?",
  };
  if (!rows) return notMeasuredStudy({ ...base, headline: "Not readable right now.", reason: "runs-service's outcome ledger could not be read this time. The study comes back on the next build." });
  const priced = rows
    .filter((r) => r.ledger && r.ledger.unitCostUsd !== null && r.ledger.unitCostUsd > 0)
    .sort((a, b) => a.ledger!.unitCostUsd! - b.ledger!.unitCostUsd! || a.label.localeCompare(b.label));
  if (priced.length === 0) return notMeasuredStudy({ ...base, headline: "No client priced on the ledger yet.", reason: "No client has a positive reply carrying declared spend yet." });
  const points: ResearchPoint[] = priced.map((r) => {
    const floor = r.coveragePct === null || r.coveragePct < COVERAGE_BAR_PCT || daysMissing > 0;
    const ledger = r.ledger!.unitCostUsd!;
    const today = r.todayReplies > 0 && r.todaySpendUsd > 0 ? r.todaySpendUsd / r.todayReplies : null;
    return {
      key: r.orgId,
      label: r.label,
      value: Number(ledger.toFixed(2)),
      display: `${floor ? "≥ " : ""}${usd(ledger)}`,
      note: `Ledger: ${n(r.ledger!.produced)} ${r.ledger!.produced === 1 ? "positive reply" : "positive replies"}, ${covText(r.coveragePct)} · today's figure: ${today === null ? "no positive reply on the reply pipes" : `${usd(today)} (${usd(r.todaySpendUsd)} on the reply pipes ÷ ${n(r.todayReplies)} ${r.todayReplies === 1 ? "positive reply" : "positive replies"})`}`,
      thin: floor,
    };
  });
  const floors = points.filter((p) => p.thin).length;
  return {
    ...base,
    status: "measured",
    headline: `${n(priced.length)} ${priced.length === 1 ? "client" : "clients"} priced on the ledger, beside today's figure. ${floors > 0 ? `${n(floors)} still a floor (spend not all declared yet).` : "Every one on its full spend."} Noise so far.`,
    winner: null,
    crowned: false,
    verdict: { kind: "noise", reason: "A comparison of two bases, not a verdict: no reader switches to the ledger until every client's figure is on its full spend and the gap with today's figure is explained." },
    result: null,
    charts: [
      {
        kind: "bars",
        title: "Cost per positive reply per client, on the ledger (USD, lower is better)",
        lowerIsBetter: true,
        points,
        note: "The bar is the ledger's production cost of one positive reply for that client: every stage its pipes ran, the sends nobody answered included, and what it bought from earlier pipes at their unit cost. The note gives today's figure (its reply pipes' spend ÷ its positive replies): it leaves out sourcing and checks, so it reads lower when the ledger is complete.",
      },
    ],
    conclusion: [
      `The ledger and today's figure are served side by side for ${n(priced.length)} ${priced.length === 1 ? "client" : "clients"}; no reader switches until both agree on what they count.`,
      ...(daysMissing > 0 ? [`${n(daysMissing)} ledger days since inception are still being computed: every bar is a floor until they are.`] : []),
    ],
  };
}
