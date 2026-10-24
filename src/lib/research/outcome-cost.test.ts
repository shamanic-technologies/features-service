import { describe, expect, it } from "vitest";
import { outcomeCostStudy } from "./outcome-cost.js";
import { rollUpOutcomeUnitCosts, type ConsumedRow, type ProducedRow } from "../outcome-unit-costs.js";

const labels: Record<string, string> = { lead_found: "Lead", email_checked: "Email checked", message_sent: "Message sent", conversation: "Positive reply", message_written: "Message written" };
const outputOf = (c: string) => ({ c1: "conversation" })[c] ?? null;
const pipeOutputs = new Set(["conversation", "website_visit", "meeting_booked"]);
const roll = (p: ProducedRow[], c: ConsumedRow[] = []) => rollUpOutcomeUnitCosts(p, c, outputOf, pipeOutputs);
// a reply pipe: 1,000 emails checked $30, 2,000 sends $10 (most never answered), 40 replies judged off any campaign $2
const unit = roll([
  { outcomeKey: "email_checked", campaignId: "c1", produced: 1000, ownCostUsd: 30 },
  { outcomeKey: "message_sent", campaignId: "c1", produced: 2000, ownCostUsd: 10 },
  { outcomeKey: "conversation", campaignId: null, produced: 40, ownCostUsd: 2 },
]).units.get("conversation")!;
const base = { outcome: "positive-reply" as const, noun: "positive reply", nounPlural: "positive replies", outcomesRequired: 10, labelOf: (k: string) => labels[k] ?? k };

describe("cost per outcome, every path (COST-ACCOUNTING-1023-P2)", () => {
  it("prices the outcome on its section, never a pipe's, every send of its pipes included, split by stage", () => {
    const st = outcomeCostStudy({ ...base, unit, coveragePct: 98 });
    expect(st).toMatchObject({ id: "positive-reply-cost-every-path", pipe: null, outcome: "positive-reply", topic: "cost", status: "measured" });
    // ($30 + $10 + $2) / 40
    expect(st.result?.display).toBe("$1.05");
    expect(st.verdict.kind).toBe("signal");
    const pts = st.charts[0]!.points;
    expect(pts.map((p) => p.label)).toEqual(["Email checked", "Message sent", "Positive reply"]);
    expect(pts.reduce((a, p) => a + p.value, 0)).toBeCloseTo(1.05, 3);
    expect(pts[1]!.note).toMatch(/^50\.00 message sent per positive reply|^50 message sent per positive reply/);
  });

  it("under the coverage bar, or with ledger days still computing, the figure is a floor, said so", () => {
    const low = outcomeCostStudy({ ...base, unit, coveragePct: 12 });
    expect(low.result?.display).toBe("≥ $1.05");
    expect(low.headline).toMatch(/^At least \$1\.05/);
    expect(low.verdict.reason).toMatch(/12% of the outcome spend/);
    const computing = outcomeCostStudy({ ...base, unit, coveragePct: 99, daysMissing: 251 });
    expect(computing.verdict).toMatchObject({ kind: "noise" });
    expect(computing.verdict.reason).toMatch(/251 days since inception are still being computed/);
  });

  it("COST-SUPPORT-1024-FEATURES: support spend stated apart in one line, per function in dollars", () => {
    const st = outcomeCostStudy({ ...base, unit, coveragePct: 96, support: { byFunction: [{ fn: "payment_fees", usd: 412.5 }, { fn: "retired_product", usd: 88 }, { fn: "new_kind", usd: 3 }], daysMissing: 0 } });
    expect(st.result?.display).toBe("$1.05");
    expect(st.conclusion).toContain("Apart, in no figure: payment fees $413 · retired products $88 · new kind $3.00.");
    const none = outcomeCostStudy({ ...base, unit, coveragePct: 50, support: { byFunction: [], daysMissing: 265 } });
    expect(none.conclusion).toContain("Apart, in no figure: no support spend marked yet (265 days not split yet).");
  });

  it("states the by-products and the spend no pipe owns", () => {
    const u = rollUpOutcomeUnitCosts(
      [
        { outcomeKey: "message_sent", campaignId: "c1", produced: 100, ownCostUsd: 1 },
        { outcomeKey: "conversation", campaignId: "c1", produced: 2, ownCostUsd: 0 },
        { outcomeKey: "conversation", campaignId: "v1", produced: 1, ownCostUsd: 0 },
      ],
      [],
      (c) => ({ c1: "conversation", v1: "website_visit" })[c] ?? null,
      pipeOutputs,
    ).units.get("conversation")!;
    const st = outcomeCostStudy({ ...base, unit: u, coveragePct: 99, unattributedCostUsd: 3 });
    expect(st.conclusion.join(" ")).toMatch(/1 more positive reply came from pipes aimed at another outcome/);
    expect(st.conclusion.join(" ")).toMatch(/\$3\.00 of declared spend belongs to no pipe's outcome/);
  });

  it("names an input no run declared yet", () => {
    const u = rollUpOutcomeUnitCosts(
      [{ outcomeKey: "meeting_booked", campaignId: "m1", produced: 2, ownCostUsd: 1 }],
      [{ consumerKey: "meeting_booked", consumedKey: "conversation", campaignId: "m1", count: 2 }],
      (c) => (c === "m1" ? "meeting_booked" : null),
      pipeOutputs,
    ).units.get("meeting_booked")!;
    expect(outcomeCostStudy({ ...base, unit: u, coveragePct: 99 }).conclusion.join(" ")).toMatch(/Positive reply is consumed but declared by no run yet/);
  });

  it("unreadable or empty ledger = not measured, with the reason", () => {
    expect(outcomeCostStudy({ ...base, unit: null, coveragePct: null })).toMatchObject({ status: "not_enough_data", headline: "Not readable right now." });
    const none = roll([{ outcomeKey: "conversation", campaignId: null, produced: 0, ownCostUsd: 0 }]).units.get("conversation")!;
    expect(outcomeCostStudy({ ...base, unit: none, coveragePct: 0 }).headline).toBe("No positive reply declared to the ledger yet.");
  });

  it("a declared outcome with no spend carried yet never reads $0", () => {
    const u = roll([{ outcomeKey: "conversation", campaignId: null, produced: 5, ownCostUsd: 0 }]).units.get("conversation")!;
    expect(outcomeCostStudy({ ...base, unit: u, coveragePct: 0 })).toMatchObject({ status: "not_enough_data", headline: "No cost carried yet." });
  });

  it("a diverging loop says why, never a 'nothing declared'", () => {
    const loop = rollUpOutcomeUnitCosts(
      [
        { outcomeKey: "meeting_attended", campaignId: null, produced: 3, ownCostUsd: 1 },
        { outcomeKey: "meeting_booked", campaignId: null, produced: 3, ownCostUsd: 1 },
      ],
      [
        { consumerKey: "meeting_attended", consumedKey: "meeting_booked", campaignId: null, count: 3 },
        { consumerKey: "meeting_booked", consumedKey: "meeting_attended", campaignId: null, count: 3 },
      ],
      () => null,
      new Set(["meeting_attended", "meeting_booked"]),
    ).units.get("meeting_attended")!;
    expect(outcomeCostStudy({ ...base, unit: loop, coveragePct: 99 })).toMatchObject({ status: "not_enough_data", headline: "Not priceable yet." });
  });
});
