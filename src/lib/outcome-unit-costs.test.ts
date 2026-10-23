import { describe, expect, it } from "vitest";
import { rollUpOutcomeUnitCosts } from "./outcome-unit-costs.js";

describe("outcome unit costs, every path (COST-ACCOUNTING-1023-P2)", () => {
  // 1,000 leads found for $300; 900 emails checked for $45 (each consumed one lead);
  // 2,000 messages sent for $40 (each consumed one checked email, 2.22 sends per email on follow-ups);
  // 4 positive replies, judging cost $0.40 (each consumed one message sent).
  const totals = [
    { outcomeKey: "lead_found", produced: 1000, ownCostUsd: 300 },
    { outcomeKey: "email_checked", produced: 900, ownCostUsd: 45 },
    { outcomeKey: "message_sent", produced: 2000, ownCostUsd: 40 },
    { outcomeKey: "conversation", produced: 4, ownCostUsd: 0.4 },
  ];
  const consumptions = [
    { consumerKey: "email_checked", consumedKey: "lead_found", count: 900 },
    { consumerKey: "message_sent", consumedKey: "email_checked", count: 2000 },
    { consumerKey: "conversation", consumedKey: "message_sent", count: 4 },
  ];
  const out = rollUpOutcomeUnitCosts(totals, consumptions);

  it("a unit cost is its own cost plus every input it consumed, at the input's unit cost", () => {
    // lead $0.30; checked = $0.05 + 1 lead = $0.35; sent = $0.02 + 1 checked = $0.37; reply = $0.10 + 1 sent = $0.47
    expect(out.get("lead_found")!.unitCostUsd).toBeCloseTo(0.3, 10);
    expect(out.get("email_checked")!.unitCostUsd).toBeCloseTo(0.35, 10);
    expect(out.get("message_sent")!.unitCostUsd).toBeCloseTo(0.37, 10);
    expect(out.get("conversation")!.unitCostUsd).toBeCloseTo(0.47, 10);
    expect(out.get("conversation")!.ownUnitCostUsd).toBeCloseTo(0.1, 10);
  });

  it("the stages add up to the unit cost, largest first", () => {
    const s = out.get("conversation")!.stages;
    expect(s.map((x) => x.outcomeKey)).toEqual(["lead_found", "conversation", "email_checked", "message_sent"]);
    expect(s.reduce((a, x) => a + x.costPerUnitUsd, 0)).toBeCloseTo(out.get("conversation")!.unitCostUsd!, 10);
  });

  it("a reused input is charged its unit cost again (standard cost on reuse)", () => {
    // 1,800 checks consumed 900 leads, each lead used twice: every check still carries a whole lead.
    const r = rollUpOutcomeUnitCosts(
      [
        { outcomeKey: "lead_found", produced: 900, ownCostUsd: 270 },
        { outcomeKey: "email_checked", produced: 1800, ownCostUsd: 90 },
      ],
      [{ consumerKey: "email_checked", consumedKey: "lead_found", count: 1800 }],
    );
    expect(r.get("email_checked")!.unitCostUsd).toBeCloseTo(0.35, 10);
  });

  it("an input nobody produced in the scope is named, never priced at 0 silently", () => {
    const r = rollUpOutcomeUnitCosts([{ outcomeKey: "message_sent", produced: 10, ownCostUsd: 1 }], [{ consumerKey: "message_sent", consumedKey: "message_written", count: 10 }]);
    expect(r.get("message_sent")).toMatchObject({ unpricedInputs: ["message_written"] });
    expect(r.get("message_sent")!.unitCostUsd).toBeCloseTo(0.1, 10);
  });

  it("nothing produced = no unit cost (null), never 0", () => {
    const r = rollUpOutcomeUnitCosts([{ outcomeKey: "conversation", produced: 0, ownCostUsd: 0 }], []);
    expect(r.get("conversation")).toMatchObject({ unitCostUsd: null, ownUnitCostUsd: null });
  });

  it("a consumption cycle fails loud", () => {
    expect(() =>
      rollUpOutcomeUnitCosts(
        [
          { outcomeKey: "a", produced: 1, ownCostUsd: 1 },
          { outcomeKey: "b", produced: 1, ownCostUsd: 1 },
        ],
        [
          { consumerKey: "a", consumedKey: "b", count: 1 },
          { consumerKey: "b", consumedKey: "a", count: 1 },
        ],
      ),
    ).toThrow(/cycle/);
  });
});
