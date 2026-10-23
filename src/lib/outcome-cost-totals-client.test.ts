import { describe, expect, it } from "vitest";
import { parseOutcomeLedgerTotals } from "./outcome-cost-totals-client.js";

const cost = (g: string, v: string) => ({ grossCents: g, netCents: g, vendorCents: v, unpricedGrossCents: "0" });

describe("runs-service outcome ledger totals (COST-ACCOUNTING-1023-P2)", () => {
  const body = {
    complete: false,
    daysMissing: ["2026-10-22"],
    produced: [
      { dimensions: { outcomeKey: "message_sent" }, occurrences: 2000, quantity: "2000", cost: cost("4000", "1500") },
      { dimensions: { outcomeKey: "conversation" }, occurrences: 4, quantity: "4", cost: cost("40", "10") },
    ],
    consumed: [
      { dimensions: { consumingOutcomeKey: "conversation", consumedOutcomeKey: "message_sent" }, consumptions: "4.0000000000" },
      { dimensions: { consumingOutcomeKey: null, consumedOutcomeKey: "lead_found" }, consumptions: "7" },
    ],
    scope: [{ dimensions: {}, spend: cost("8080", "3020"), producedCost: cost("4040", "1510") }],
  };

  it("reads produced cost and consumptions on the billed basis, coverage over the scope's spend", () => {
    const r = parseOutcomeLedgerTotals(body, "gross");
    expect(r.totals).toEqual([
      { outcomeKey: "message_sent", produced: 2000, ownCostUsd: 40 },
      { outcomeKey: "conversation", produced: 4, ownCostUsd: 0.4 },
    ]);
    // a consumption by a run that declared no outcome prices nothing
    expect(r.consumptions).toEqual([{ consumerKey: "conversation", consumedKey: "message_sent", count: 4 }]);
    expect(r.coveragePct).toBeCloseTo(50, 10);
    expect(r.daysMissing).toEqual(["2026-10-22"]);
  });

  it("reads the vendor basis on the staff file", () => {
    expect(parseOutcomeLedgerTotals(body, "vendor").totals[0]!.ownCostUsd).toBe(15);
  });

  it("nothing spent = coverage null, never 0; a group without its key fails loud", () => {
    expect(parseOutcomeLedgerTotals({ produced: [], consumed: [], scope: [{ spend: cost("0", "0"), producedCost: cost("0", "0") }] }, "gross").coveragePct).toBeNull();
    expect(() => parseOutcomeLedgerTotals({ produced: [{ dimensions: {}, occurrences: 1, cost: cost("1", "1") }] }, "gross")).toThrow(/outcomeKey/);
  });
});
