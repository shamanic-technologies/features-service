import { describe, expect, it } from "vitest";
import { parseOutcomeLedgerTotals } from "./outcome-cost-totals-client.js";

const cost = (g: string, v: string) => ({ grossCents: g, netCents: g, vendorCents: v, unpricedGrossCents: "0" });

describe("runs-service outcome ledger totals (COST-ACCOUNTING-1023-P2)", () => {
  const body = {
    complete: false,
    daysMissing: ["2026-02-02", "2026-02-03"],
    produced: [
      { dimensions: { outcomeKey: "message_sent", campaignId: "c1" }, occurrences: 2000, quantity: "2000", cost: cost("4000", "1500") },
      { dimensions: { outcomeKey: "conversation", campaignId: null }, occurrences: 4, quantity: "4", cost: cost("40", "10") },
    ],
    consumed: [
      { dimensions: { consumingOutcomeKey: "conversation", consumedOutcomeKey: "message_sent", campaignId: null }, consumptions: "4.0000000000" },
      { dimensions: { consumingOutcomeKey: null, consumedOutcomeKey: "lead_found", campaignId: "c1" }, consumptions: "7" },
    ],
    // one scope row per campaign: coverage sums them
    scope: [
      { dimensions: { campaignId: "c1" }, spend: cost("8000", "3000"), producedCost: cost("4000", "1500") },
      { dimensions: { campaignId: null }, spend: cost("80", "20"), producedCost: cost("40", "10") },
    ],
  };

  it("reads per-campaign rows on the billed basis, coverage over every scope row, the days still missing", () => {
    const r = parseOutcomeLedgerTotals(body, "gross");
    expect(r.produced).toEqual([
      { outcomeKey: "message_sent", campaignId: "c1", orgId: null, produced: 2000, ownCostUsd: 40 },
      { outcomeKey: "conversation", campaignId: null, orgId: null, produced: 4, ownCostUsd: 0.4 },
    ]);
    expect(r.consumed).toEqual([{ consumerKey: "conversation", consumedKey: "message_sent", campaignId: null, orgId: null, count: 4 }]);
    expect(r.coveragePct).toBeCloseTo(50, 10);
    expect(r.daysMissing).toBe(2);
  });

  it("reads the vendor basis on the staff file", () => {
    expect(parseOutcomeLedgerTotals(body, "vendor").produced[0]!.ownCostUsd).toBe(15);
  });

  it("nothing spent = coverage null, never 0; a group without its key fails loud", () => {
    expect(parseOutcomeLedgerTotals({ produced: [], consumed: [], scope: [{ spend: cost("0", "0"), producedCost: cost("0", "0") }] }, "gross").coveragePct).toBeNull();
    expect(() => parseOutcomeLedgerTotals({ produced: [{ dimensions: {}, occurrences: 1, cost: cost("1", "1") }] }, "gross")).toThrow(/outcomeKey/);
  });
});

describe("outcome ledger by workflow (COST-ACCOUNTING-1023-P4)", () => {
  it("reads produced per campaign x workflow and consumptions per producing workflow; the larger missing-day count stands", async () => {
    const { parseOutcomeLedgerByWorkflow } = await import("./outcome-cost-totals-client.js");
    const r = parseOutcomeLedgerByWorkflow(
      { daysMissing: ["d1"], produced: [{ dimensions: { outcomeKey: "message_sent", campaignId: "c1", workflowSlug: "keel-v2" }, occurrences: 10, cost: { grossCents: "500", vendorCents: "100" } }] },
      { daysMissing: ["d1", "d2"], consumed: [{ dimensions: { consumingOutcomeKey: "conversation", consumedOutcomeKey: "message_sent", sourceWorkflowSlug: "keel-v2" }, consumptions: "2" }, { dimensions: { consumingOutcomeKey: null, consumedOutcomeKey: "lead_found", sourceWorkflowSlug: null }, consumptions: "9" }] },
      "gross",
    );
    expect(r.produced).toEqual([{ outcomeKey: "message_sent", campaignId: "c1", workflowSlug: "keel-v2", ownCostUsd: 5 }]);
    expect(r.sourced).toEqual([{ consumerKey: "conversation", consumedKey: "message_sent", sourceWorkflowSlug: "keel-v2", count: 2 }]);
    expect(r.daysMissing).toBe(2);
  });
});
