import { describe, expect, it } from "vitest";
import { workflowLedgerStudy } from "./workflow-ledger.js";

const row = (key: string, unitCostUsd: number | null, todayCostUsd: number | null) => ({ key, label: key.toUpperCase(), outcomes: 5, ownCostUsd: 100, unitCostUsd, todayCostUsd, todayBasis: "mature" as const });

describe("RESEARCH-LEDGER-RECOMPUTING-1024", () => {
  it("ledger days still being recomputed price no workflow", () => {
    expect(workflowLedgerStudy({ pipe: "p", rows: [], floorReason: null, daysMissing: 3 }).headline).toBe("Being recomputed.");
  });
});

describe("workflow ledger study (COST-ACCOUNTING-1023-P4)", () => {
  it("sits on the pipe beside the ranking, cheapest first, never crowned", () => {
    const st = workflowLedgerStudy({ pipe: "cold-email-positive-reply", rows: [row("keel", 30, 25), row("ballad", 12, 141), row("idle", null, null)], floorReason: null });
    expect(st).toMatchObject({ id: "cold-email-positive-reply-workflow-ledger", pipe: "cold-email-positive-reply", topic: "workflow", crowned: false, winner: null });
    expect(st.charts[0]!.points.map((p) => p.key)).toEqual(["ballad", "keel"]);
    expect(st.charts[0]!.points[0]!.note).toMatch(/ranking: \$141 \(mature\)/);
    expect(st.headline).toMatch(/^On the ledger, BALLAD at \$12 per positive reply, beside the ranking's \$141/);
  });

  it("a floor is said on every bar; unreadable / nothing priced = not measured", () => {
    const st = workflowLedgerStudy({ pipe: "p", rows: [row("keel", 30, 25)], floorReason: "The ledger holds 33% of the spend: every figure is a floor." });
    expect(st.charts[0]!.points[0]!.display).toBe("≥ $30");
    expect(st.headline).toMatch(/^On the ledger, KEEL at least \$30 per positive reply/);
    expect(st.verdict.reason).toMatch(/33%/);
    expect(workflowLedgerStudy({ pipe: "p", rows: null, floorReason: null }).headline).toBe("Not readable right now.");
    expect(workflowLedgerStudy({ pipe: "p", rows: [row("x", null, 3)], floorReason: null }).headline).toBe("No workflow priced on the ledger yet.");
  });
});

describe("ledger beside the ranking, as a paired series (COST-ACCOUNTING-1023-P4)", () => {
  it("each bar's ranking figure rides compare[] on the same key; a bar the ranking does not price has no pair", () => {
    const st = workflowLedgerStudy({ pipe: "p", rows: [row("keel", 30, 25), row("legato", 40, null)], floorReason: null });
    expect(st.charts[0]!.compare!.points.map((p) => [p.key, p.display])).toEqual([["keel", "$25"]]);
  });
});
