import { describe, expect, it } from "vitest";
import { outcomeCostStudy } from "./outcome-cost.js";
import { rollUpOutcomeUnitCosts } from "../outcome-unit-costs.js";

const labels: Record<string, string> = { lead_found: "Lead found", email_checked: "Email checked", message_sent: "Message sent", conversation: "Positive reply", message_written: "Message written" };
const unit = rollUpOutcomeUnitCosts(
  [
    { outcomeKey: "lead_found", produced: 1000, ownCostUsd: 300 },
    { outcomeKey: "message_sent", produced: 2000, ownCostUsd: 40 },
    { outcomeKey: "conversation", produced: 40, ownCostUsd: 4 },
  ],
  [
    { consumerKey: "message_sent", consumedKey: "lead_found", count: 2000 },
    { consumerKey: "conversation", consumedKey: "message_sent", count: 40 },
  ],
).get("conversation")!;
const base = { outcome: "positive-reply" as const, noun: "positive reply", nounPlural: "positive replies", outcomesRequired: 10, labelOf: (k: string) => labels[k] ?? k };

describe("cost per outcome, every path (COST-ACCOUNTING-1023-P2)", () => {
  it("prices the outcome on its section, never a pipe's, and splits it by stage", () => {
    const st = outcomeCostStudy({ ...base, unit, coveragePct: 98 });
    expect(st).toMatchObject({ id: "positive-reply-cost-every-path", pipe: null, outcome: "positive-reply", topic: "cost", status: "measured" });
    expect(st.result?.display).toBe("$0.42");
    expect(st.verdict.kind).toBe("signal");
    const pts = st.charts[0]!.points;
    expect(pts.map((p) => p.label)).toEqual(["Lead found", "Positive reply", "Message sent"]);
    expect(pts.reduce((a, p) => a + p.value, 0)).toBeCloseTo(0.42, 3);
  });

  it("under the coverage bar the figure is a floor, said so, never a verdict", () => {
    const st = outcomeCostStudy({ ...base, unit, coveragePct: 12 });
    expect(st.result?.display).toBe("≥ $0.42");
    expect(st.headline).toMatch(/^At least \$0\.42/);
    expect(st.verdict.kind).toBe("noise");
    expect(st.verdict.reason).toMatch(/12% of the spend/);
  });

  it("names an input no run declared yet", () => {
    const u = rollUpOutcomeUnitCosts([{ outcomeKey: "conversation", produced: 20, ownCostUsd: 2 }], [{ consumerKey: "conversation", consumedKey: "message_written", count: 20 }]).get("conversation")!;
    expect(outcomeCostStudy({ ...base, unit: u, coveragePct: 99 }).conclusion.join(" ")).toMatch(/Message written is consumed but declared by no run yet/);
  });

  it("unreadable or empty ledger = not measured, with the reason", () => {
    expect(outcomeCostStudy({ ...base, unit: null, coveragePct: null })).toMatchObject({ status: "not_enough_data", headline: "Not readable right now." });
    const none = rollUpOutcomeUnitCosts([{ outcomeKey: "conversation", produced: 0, ownCostUsd: 0 }], []).get("conversation")!;
    expect(outcomeCostStudy({ ...base, unit: none, coveragePct: 0 }).headline).toBe("No positive reply declared to the ledger yet.");
  });
});

describe("a ledger loop never blanks the page (COST-ACCOUNTING-1023-P3 hotfix)", () => {
  it("a diverging self-consumption says why, never a 'nothing declared'", () => {
    const loop = rollUpOutcomeUnitCosts([{ outcomeKey: "meeting_attended", produced: 3, ownCostUsd: 1 }], [{ consumerKey: "meeting_attended", consumedKey: "meeting_attended", count: 3 }]).get("meeting_attended")!;
    const st = outcomeCostStudy({ ...base, unit: loop, coveragePct: 99 });
    expect(st).toMatchObject({ status: "not_enough_data", headline: "Not priceable yet." });
  });
});
