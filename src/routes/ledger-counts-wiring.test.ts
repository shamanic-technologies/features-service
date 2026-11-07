/**
 * LEDGER-ONLY-1107-P2: every route serving counts / $ per outcome / conversions answers them through a ledger overlay
 * (`lib/ledger-counts.ts` & co.). Route suites mock the overlays to identity (they assert the engine's in-process
 * figures), so this guard pins the WIRING: a route that stops calling its overlay serves non-ledger figures again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

const WIRING: Array<[string, string[]]> = [
  ["routes/revenue.ts", ["withLedgerCounts(", "readLedgerScope(", "fetchWorkflowUnits("]],
  ["routes/brand-economics.ts", ["withLedgerCounts(", "maturity: null"]],
  ["routes/offer-economics.ts", ["withLedgerCounts("]],
  ["routes/stats.ts", ["withLedgerRawStats(rawStats", "withLedgerRawStats(rawStats, STATS_COUNT_KEYS, groupLedger"]],
  ["routes/spend-charts.ts", ["fetchCampaignSetOutcomeLedger(", "rebaseSpendChartOnLedger("]],
  ["routes/sales-funnel-campaign-activity.ts", ["withLedgerActivity("]],
  ["routes/outcome-cost-series.ts", ["withLedgerStepSeries(", "ledgerUnitDays("]],
  ["routes/offer-outcomes.ts", ["withLedgerOfferOutcomes("]],
  ["routes/pipeline-activity.ts", ["withLedgerDayChart("]],
  ["lib/audience-stats-compute.ts", ["withLedgerAudienceStats("]],
  ["routes/deals-value.ts", ["withLedgerDealsColumns("]],
  ["routes/offer-lead-values.ts", ["ledgerUnitsOfRung(", "ledger:paid_client:"]],
];

describe("LEDGER-ONLY-1107-P2 wiring: every count-serving route goes through its ledger overlay", () => {
  for (const [file, needles] of WIRING) {
    it(file, () => {
      const text = src(file);
      for (const n of needles) expect(text, `${file} lost ${n}`).toContain(n);
    });
  }
  it("the Deals board no longer reads the CRM's won predicate", () => {
    expect(src("lib/deals-lifecycle.ts")).not.toContain("isClosedWonOurs(p)");
  });
});
