import { describe, expect, it } from "vitest";
import { outcomeCostByClientStudy } from "./outcome-cost-by-client.js";
import { rollUpByOrg } from "../outcome-unit-costs.js";

const by = rollUpByOrg(
  [
    { outcomeKey: "message_sent", campaignId: "c1", orgId: "o1", produced: 1000, ownCostUsd: 100 },
    { outcomeKey: "conversation", campaignId: null, orgId: "o1", produced: 10, ownCostUsd: 0 },
    { outcomeKey: "message_sent", campaignId: "c2", orgId: "o2", produced: 1000, ownCostUsd: 20 },
    { outcomeKey: "conversation", campaignId: null, orgId: "o2", produced: 10, ownCostUsd: 0 },
  ],
  [],
  (c) => (c === "c1" || c === "c2" ? "conversation" : null),
  new Set(["conversation"]),
);
const row = (orgId: string, label: string, coveragePct: number, todaySpendUsd: number, todayReplies: number) => ({ orgId, label, ledger: by.get(orgId)!.units.get("conversation")!, coveragePct, todaySpendUsd, todayReplies });

describe("ledger beside today's figure, per client (COST-ACCOUNTING-1023-P4)", () => {
  it("one bar per client on the ledger, cheapest first, today's figure in the note, a floor said so", () => {
    const st = outcomeCostByClientStudy([row("o1", "Acme", 99, 80, 10), row("o2", "Beta", 40, 15, 10)], 0);
    expect(st).toMatchObject({ id: "positive-reply-cost-by-client", outcome: "positive-reply", pipe: null, topic: "cost", status: "measured", crowned: false });
    const [b, a] = st.charts[0]!.points;
    expect(b).toMatchObject({ label: "Beta", display: "≥ $2.00", thin: true });
    expect(b!.note).toMatch(/today's figure: \$1\.50 \(\$15 on the reply pipes ÷ 10 positive replies\)/);
    expect(a).toMatchObject({ label: "Acme", display: "$10", thin: false });
    expect(st.verdict.kind).toBe("noise");
  });

  it("RESEARCH-LEDGER-RECOMPUTING-1024: ledger days still being recomputed price nothing; nothing priced or unreadable = not measured", () => {
    const st = outcomeCostByClientStudy([row("o1", "Acme", 99, 80, 10)], 12);
    expect(st).toMatchObject({ status: "not_enough_data", headline: "Being recomputed." });
    expect(st.charts.length).toBe(0);
    expect(outcomeCostByClientStudy([], 0).headline).toBe("No client priced on the ledger yet.");
    expect(outcomeCostByClientStudy(null, 0).headline).toBe("Not readable right now.");
  });
});

describe("ledger beside today's figure, as a paired series", () => {
  it("today's figure rides compare[] on the client's key", () => {
    const st = outcomeCostByClientStudy([row("o1", "Acme", 99, 80, 10), row("o2", "Beta", 40, 0, 0)], 0);
    expect(st.charts[0]!.compare!.points.map((p) => [p.key, p.display])).toEqual([["o1", "$8.00"]]);
  });
});
