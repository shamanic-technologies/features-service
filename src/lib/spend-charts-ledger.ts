/**
 * LEDGER-ONLY-1107 (owner 2026-11-07, « TOUS LES CHIFFRES DOIVENT ETRE ISSUS DE LA COMPTA INDUSTRIELLE!!! »): a spend chart's
 * OUTCOME and CONVERSION figures re-based on the general ledger. PURE.
 *
 *  - Outcomes = the scope's ledger Units of the chart's outcome step, per day (the SAME count Today's Target row prints).
 *  - $ / outcome, both figures the doctrine asks for: ACTUAL = the scope's spend to date ÷ those Units (per day and
 *    totals, `costPerOutcomeUsd`) and STANDARD = the ledger's every-path unit cost (`totals.standardCostPerOutcomeUsd`,
 *    the $ each Today's Target row prints), never spend ÷ another source's count.
 *  - % conversion = ledger Units of the outcome ÷ ledger Units of the leg's FROM step, cumulative (the yield). The entry
 *    COHORT conversion (per person, by entry day) is not a ledger figure: null.
 *  - Spend stays the runs ledger's spend (`spendUsd`, `byAction`): unchanged.
 * An outcome the ledger lacks = every outcome figure null + `outcomeUnavailableReason` = the ledger's reason + `producerGap`.
 */
import type { SpendChart } from "./spend-charts-io.js";
import type { SpendChartPoint } from "./spend-charts.js";
import type { LedgerProducerGap, ScopeOutcomeLedgerRow } from "./scope-outcome-ledger.js";

type Nullable<T, K extends keyof T> = Omit<T, K> & { [P in K]: T[P] | null };

export type LedgerSpendChartPoint = Nullable<
  SpendChartPoint,
  "cumulativeOutcomes" | "entered" | "cohortOutcomes" | "cumulativeEntered" | "cumulativeConverted" | "matureOutcomes" | "learning"
>;

export type LedgerSpendChart = Omit<SpendChart, "daily" | "totals"> & {
  daily: LedgerSpendChartPoint[];
  totals: Nullable<SpendChart["totals"], "outcomes" | "entered" | "converted"> & { standardCostPerOutcomeUsd: number | null };
  ledger: { scope: "brand" | "campaign" | "pipe"; outcomeKeys: string[]; entryKeys: string[]; producerGap: LedgerProducerGap | null; ledgerDaysMissing: string[] };
};

const cumulativeAt = (row: ScopeOutcomeLedgerRow | null, day: string): number | null => {
  if (row === null || row.units === null) return null;
  let v = 0;
  for (const p of row.past) {
    if (p.date > day) break;
    v = p.cumulativeUnits;
  }
  return v;
};
const unitsOn = (row: ScopeOutcomeLedgerRow | null, day: string): number | null =>
  row === null || row.units === null ? null : (row.past.find((p) => p.date === day)?.units ?? 0);

/** PURE. `outcome` / `entry` = the scope's ledger rows of the chart's outcome step and of its leg's FROM step (null = no step). */
export function rebaseSpendChartOnLedger(
  chart: SpendChart,
  outcome: ScopeOutcomeLedgerRow | "ledger_unreadable" | null,
  entry: ScopeOutcomeLedgerRow | null,
  outcomesRequired: number,
  scope: "brand" | "campaign" | "pipe" = "brand",
): LedgerSpendChart {
  const o = outcome === "ledger_unreadable" ? null : outcome;
  const reason = outcome === "ledger_unreadable" ? "ledger_unreadable" : o === null ? chart.outcomeUnavailableReason ?? "no_leg" : o.unitsUnavailableReason;
  const e = entry !== null && entry.units !== null ? entry : null;
  const conversionReason = chart.conversionUnavailableReason ?? (entry === null ? "no_entry_population" : entry.units === null ? entry.unitsUnavailableReason : null);
  const daily: LedgerSpendChartPoint[] = chart.daily.map((p) => {
    const cumulativeOutcomes = cumulativeAt(o, p.date);
    const cumulativeEntered = conversionReason === null ? cumulativeAt(e, p.date) : null;
    const converted = conversionReason === null ? cumulativeOutcomes : null;
    return {
      ...p,
      cumulativeOutcomes,
      costPerOutcomeUsd: cumulativeOutcomes !== null && cumulativeOutcomes > 0 && p.cumulativeSpendUsd > 0 ? p.cumulativeSpendUsd / cumulativeOutcomes : null,
      entered: conversionReason === null ? unitsOn(e, p.date) : null,
      cohortOutcomes: null,
      cohortConversionPct: null,
      cumulativeEntered,
      cumulativeConverted: converted,
      conversionRatePct: cumulativeEntered !== null && cumulativeEntered > 0 && converted !== null ? (converted / cumulativeEntered) * 100 : null,
      matureConversionRatePct: null,
      matureOutcomes: null,
      learning: cumulativeOutcomes === null ? null : cumulativeOutcomes < outcomesRequired,
    };
  });
  const units = o?.units ?? null;
  const entered = conversionReason === null ? e?.units ?? null : null;
  return {
    ...chart,
    outcomeUnavailableReason: units === null ? reason : null,
    conversionUnavailableReason: units === null ? reason : conversionReason,
    daily,
    totals: {
      spendUsd: chart.totals.spendUsd,
      outcomes: units,
      costPerOutcomeUsd: units !== null && units > 0 && chart.totals.spendUsd > 0 ? chart.totals.spendUsd / units : null,
      standardCostPerOutcomeUsd: o?.costPerUnitUsd ?? null,
      entered,
      converted: entered === null ? null : units,
      conversionRatePct: entered !== null && entered > 0 && units !== null ? (units / entered) * 100 : null,
      learning: units === null ? null : units < outcomesRequired,
    },
    ledger: {
      scope,
      outcomeKeys: o?.outcomeKeys ?? [],
      entryKeys: entry?.outcomeKeys ?? [],
      producerGap: o?.producerGap ?? null,
      ledgerDaysMissing: o?.ledgerDaysMissing ?? [],
    },
  };
}
