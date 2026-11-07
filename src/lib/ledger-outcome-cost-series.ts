/**
 * LEDGER-ONLY-1107-P2: one step of the offer's outcome cost series on the general ledger. PURE. The series itself (months,
 * since inception) is built on the brand's ledger Units by the route; this nulls what the ledger cannot state and re-bases
 * the accounting's MEASURED halves: cost per Unit actual = the landing units' spend ÷ the Units their runs produced, the
 * measured return = the target campaigns' Units × the value per Unit ÷ their spend. The per-person yield to the next step
 * (people at a step who reached the next) is not a ledger figure: null `not_a_ledger_outcome`.
 */
import { costVariance, type OutcomeAccounting } from "./outcome-accounting.js";
import { NOT_A_LEDGER_OUTCOME, type LedgerCount } from "./ledger-counts.js";
import type { OutcomeCostStepSeries } from "./outcome-cost-series.js";

type Nullable<T> = { [K in keyof T]: T[K] | null };
export type LedgerStepSeries = Omit<OutcomeCostStepSeries, "sinceInception" | "months"> & {
  sinceInception: Nullable<OutcomeCostStepSeries["sinceInception"]>;
  months: Array<Nullable<OutcomeCostStepSeries["months"][number]>>;
  outcomesUnavailableReason: string | null;
  producerGap: LedgerCount["producerGap"];
};

const r2 = (v: number) => Math.round(v * 100) / 100;
const per = (usd: number | null, n: number | null) => (usd === null || n === null || n <= 0 || usd <= 0 ? null : r2(usd / n));

export function withLedgerStepSeries(
  st: OutcomeCostStepSeries,
  brand: LedgerCount,
  landing: LedgerCount | null,
  landingSpendUsd: number | null,
  target: LedgerCount | null,
  targetSpendUsd: number | null,
): LedgerStepSeries {
  const lacks = brand.units === null;
  const sinceInception = lacks ? { ...st.sinceInception, outcomes: null, undatedOutcomes: null, costPerOutcomeUsd: null, learning: null } : st.sinceInception;
  const months = lacks ? st.months.map((m) => ({ ...m, outcomes: null, costPerOutcomeUsd: null, cumulativeOutcomes: null, cumulativeCostPerOutcomeUsd: null, learning: null })) : st.months;
  return {
    ...st,
    sinceInception,
    months,
    outcomesUnavailableReason: lacks ? brand.reason : null,
    producerGap: brand.producerGap,
    accounting: st.accounting ? ledgerAccounting(st.accounting, sinceInception.costPerOutcomeUsd, landing, landingSpendUsd, target, targetSpendUsd) : null,
  };
}

function ledgerAccounting(a: OutcomeAccounting, costFromStartUsd: number | null, landing: LedgerCount | null, landingSpendUsd: number | null, target: LedgerCount | null, targetSpendUsd: number | null): OutcomeAccounting {
  const units = landing?.units ?? null;
  const actualUsd = per(landingSpendUsd, units);
  const actualReason = landing === null ? "not_made_by_our_campaigns" : units === null ? landing.reason : landingSpendUsd === null ? "spend_unreadable" : units === 0 ? "no_unit_yet" : null;
  const valuePer = a.returns.expected.valuePerUnitUsd;
  const tUnits = target?.units ?? null;
  const measured = !a.returns.isCampaignTarget
    ? a.returns.measured
    : {
        roiMultiple: tUnits !== null && valuePer !== null && targetSpendUsd !== null && targetSpendUsd > 0 ? r2((tUnits * valuePer) / targetSpendUsd) : null,
        targetUnits: tUnits,
        valueUsd: tUnits !== null && valuePer !== null ? r2(tUnits * valuePer) : null,
        spentUsd: targetSpendUsd,
        learning: a.returns.measured.learning,
        unavailableReason: tUnits === null ? (target?.reason ?? "ledger_unreadable") : valuePer === null ? "value_unavailable" : targetSpendUsd === null || targetSpendUsd <= 0 ? "nothing_spent_yet" : null,
      };
  return {
    ...a,
    costPerUnit: {
      ...a.costPerUnit,
      actualUsd,
      actualUnits: units ?? 0,
      actualSpentUsd: landingSpendUsd ?? 0,
      actualUnavailableReason: actualReason,
      variance: costVariance(actualUsd, a.costPerUnit.expectedUsd, null, "yield_not_on_ledger"),
    },
    costFromStart: { ...a.costFromStart, actualUsd: costFromStartUsd, actualUnavailableReason: costFromStartUsd === null ? "no_unit_yet" : null },
    yieldToNext: { ...a.yieldToNext, measuredPct: null, measuredNextUnits: null, measuredTrials: null, measuredUnavailableReason: NOT_A_LEDGER_OUTCOME },
    returns: { ...a.returns, measured },
  };
}
