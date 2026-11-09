import { describe, expect, it } from "vitest";
import { STEP_COST_CHAIN, consumingStepOf, stepOfLedgerKey, stepSpendAttribution, stepTracedCostOf, type StepTracedCost } from "./step-cost-attribution.js";
import { buildOutcomeCostSeries, OUTCOME_COST_STEPS, type OutcomeCostStep, type StepExpectedCost, type StepValue } from "./outcome-cost-series.js";

const noExpected: StepExpectedCost = { costPerOutcomeUsd: null, basis: null, combinationKey: null, unavailableReason: "step_not_on_expected_path" };
const noValue: StepValue = { valuePerOutcomeUsd: null, unavailableReason: "step_not_on_expected_path" };

describe("OUTCOME-COST-CUMUL-1109 step of a ledger key", () => {
  it("a step's own key, the key it counts, else the first step reaching the same lead state", () => {
    expect(stepOfLedgerKey("lead_found")).toBe("lead_found");
    expect(stepOfLedgerKey("lead_visited")).toBe("website_visit");
    expect(stepOfLedgerKey("conversation")).toBe("conversation");
    expect(stepOfLedgerKey("lead_interested")).toBe("conversation");
    expect(stepOfLedgerKey("signup")).toBe("signup");
    expect(stepOfLedgerKey("purchase")).toBe("paid_client");
    expect(stepOfLedgerKey("message_written")).toBeNull();
    expect(stepOfLedgerKey("threads_post_published")).toBeNull();
  });

  it("the chain runs Lead found first, Paid client last (the served order reversed)", () => {
    expect(STEP_COST_CHAIN[0]).toBe("lead_found");
    expect(STEP_COST_CHAIN.at(-1)).toBe("paid_client");
    expect([...STEP_COST_CHAIN].reverse()).toEqual([...OUTCOME_COST_STEPS]);
  });
});

// The prod consumption graph of the Distribute.you brand (runs-service, 2026-11-09), trimmed.
const edges = [
  ["email_checked", "email_found"],
  ["lead_found", "email_checked"],
  ["lead_found", "lead_identified"],
  ["lead_interested", "email_found"],
  ["lead_interested", "message_written"],
  ["lead_visited", "message_written"],
  ["message_sent", "message_written"],
  ["message_written", "lead_found"],
  ["conversation", "message_sent"],
  ["newsletter_email_sent", "message_sent"],
  ["post_viewed", "x_post_published"],
].map(([consumerKey, consumedKey]) => ({ consumerKey: consumerKey!, consumedKey: consumedKey!, count: 1 }));

describe("OUTCOME-COST-CUMUL-1109 an input is costed at the earliest step consuming it", () => {
  it("found and checked emails make a Lead found; a written message is first consumed toward a Website visit", () => {
    expect(consumingStepOf("email_found", edges)).toBe("lead_found");
    expect(consumingStepOf("email_checked", edges)).toBe("lead_found");
    expect(consumingStepOf("lead_identified", edges)).toBe("lead_found");
    expect(consumingStepOf("message_written", edges)).toBe("website_visit");
    expect(consumingStepOf("message_sent", edges)).toBe("conversation");
    expect(consumingStepOf("x_post_published", edges)).toBeNull();
    expect(consumingStepOf("email_found", edges.map((e) => ({ ...e, count: 0 })))).toBeNull();
  });

  it("own key's step first, then the consuming step, then the campaign's leg output, else off any step", () => {
    const t = stepTracedCostOf(
      [
        { outcomeKey: "email_found", campaignId: "cold", ownCostUsd: 30 },
        { outcomeKey: "lead_found", campaignId: "cold", ownCostUsd: 10 },
        { outcomeKey: "message_written", campaignId: "cold", ownCostUsd: 50 },
        { outcomeKey: "lead_interested", campaignId: "cold", ownCostUsd: 5 },
        { outcomeKey: "company_researched", campaignId: "cold", ownCostUsd: 3 },
        { outcomeKey: "meeting_booked", campaignId: null, ownCostUsd: 2 },
        { outcomeKey: "x_post_published", campaignId: "post", ownCostUsd: 4 },
      ],
      edges,
      (id) => ({ cold: "lead_interested" })[id] ?? null,
    );
    expect(Object.fromEntries([...t.tracedCostUsd].filter(([, v]) => v !== 0))).toEqual({ lead_found: 40, website_visit: 50, conversation: 8, meeting_booked: 2 });
    expect(t.offStepCostUsd).toBe(4);
  });
});

describe("OUTCOME-COST-CUMUL-1109 absorption shares", () => {
  const traced = (m: Record<string, number>, off = 0): StepTracedCost => ({ tracedCostUsd: new Map(Object.entries(m)) as StepTracedCost["tracedCostUsd"], offStepCostUsd: off });
  const byOutput = traced({ lead_found: 40, website_visit: 20, conversation: 30, meeting_booked: 10 }, 7);

  it("cumulative shares grow down the chain, the last step carries the whole spend", () => {
    const a = stepSpendAttribution(byOutput);
    expect(a.unavailableReason).toBeNull();
    expect(a.totalTracedCostUsd).toBe(100);
    expect(a.offStepCostUsd).toBe(7);
    const shares = STEP_COST_CHAIN.map((s) => a.cumulativeShare.get(s)!);
    [0.4, 0.6, 0.9, 0.9, 0.9, 1, 1, 1].forEach((v, i) => expect(shares[i]).toBeCloseTo(v, 12));
    for (let i = 1; i < shares.length; i++) expect(shares[i]!).toBeGreaterThanOrEqual(shares[i - 1]!);
  });

  it("nothing traced (or the ledger unreadable): the whole spend enters at the first step, every step carries it", () => {
    for (const [input, reason] of [
      [null, "ledger_unreadable"],
      [traced({}, 3), "no_cost_traced_to_a_step"],
    ] as const) {
      const a = stepSpendAttribution(input);
      expect(a.unavailableReason).toBe(reason);
      expect(STEP_COST_CHAIN.map((s) => a.cumulativeShare.get(s))).toEqual(STEP_COST_CHAIN.map(() => 1));
    }
  });

  it("a negative traced step (a refund) takes no negative share", () => {
    const a = stepSpendAttribution(traced({ lead_found: 10, website_visit: -5 }));
    expect(a.cumulativeShare.get("lead_found")).toBe(1);
    expect(a.cumulativeShare.get("website_visit")).toBe(1);
  });
});

describe("OUTCOME-COST-CUMUL-1109 the series on the shares (the owner's AC)", () => {
  const a = stepSpendAttribution({
    tracedCostUsd: new Map<OutcomeCostStep, number>([
      ["lead_found", 37.13],
      ["website_visit", 21.7],
      ["conversation", 30.01],
      ["meeting_booked", 11.16],
    ]),
    offStepCostUsd: 0,
  });
  const spendByDay = new Map([
    ["2026-09-03", 1234.567],
    ["2026-10-11", 2000.003],
    ["2026-11-02", 1193.43],
  ]);
  const ours: Partial<Record<OutcomeCostStep, string[]>> = {
    lead_found: Array(9829).fill("2026-10-01"),
    website_visit: Array(205).fill("2026-10-11"),
    conversation: Array(43).fill("2026-11-02"),
    meeting_booked: ["2026-11-02"],
  };
  const steps = buildOutcomeCostSeries({
    spendByDay,
    outcomeDays: new Map(Object.entries(ours) as [OutcomeCostStep, string[]][]),
    learningBarOf: () => 10,
    expectedOf: () => noExpected,
    valueOf: () => noValue,
    attribution: { cumulativeShareOf: (s) => a.cumulativeShare.get(s)!, tracedCostUsdOf: (s) => a.tracedCostUsd.get(s)! },
    today: "2026-11-09",
  });
  const byKey = new Map(steps.map((s) => [s.stepKey, s] as const));
  const total = Math.round([...spendByDay.values()].reduce((x, v) => x + v, 0) * 100) / 100;

  it("$ Spent is non-decreasing down the chain; Lead found carries less than the whole spend; Paid client carries all of it", () => {
    const spent = STEP_COST_CHAIN.map((s) => byKey.get(s)!.sinceInception.spendUsd);
    for (let i = 1; i < spent.length; i++) expect(spent[i]!).toBeGreaterThanOrEqual(spent[i - 1]!);
    expect(spent[0]!).toBeLessThan(total);
    expect(spent.at(-1)).toBe(total);
  });

  it("Σ own spend per step = the scope's spend to the cent; each step = the one above + its own", () => {
    const ownCents = steps.reduce((x, s) => x + Math.round(s.spendAttribution.ownSpendUsd * 100), 0);
    expect(ownCents).toBe(Math.round(total * 100));
    for (const s of steps) {
      const above = s.spendAttribution.aboveStepKey ? byKey.get(s.spendAttribution.aboveStepKey)!.sinceInception.spendUsd : 0;
      expect(Math.round((above + s.spendAttribution.ownSpendUsd) * 100)).toBe(Math.round(s.sinceInception.spendUsd * 100));
    }
  });

  it("$ / outcome = $ Spent ÷ our outcomes on every row with outcomes; the months add up to the headline", () => {
    for (const s of steps) {
      if (s.sinceInception.outcomes > 0) expect(s.sinceInception.costPerOutcomeUsd).toBe(Math.round((s.sinceInception.spendUsd / s.sinceInception.outcomes) * 100) / 100);
      else expect(s.sinceInception.costPerOutcomeUsd).toBeNull();
      const monthCents = s.months.reduce((x, m) => x + Math.round(m.spendUsd * 100), 0);
      expect(monthCents).toBe(Math.round(s.sinceInception.spendUsd * 100));
      expect(s.months.at(-1)!.cumulativeSpendUsd).toBe(s.sinceInception.spendUsd);
    }
  });

  it("no attribution passed = the whole spend on every step (the first step owns it)", () => {
    const flat = buildOutcomeCostSeries({ spendByDay, outcomeDays: new Map(), learningBarOf: () => 10, expectedOf: () => noExpected, valueOf: () => noValue, today: "2026-11-09" });
    for (const s of flat) expect(s.sinceInception.spendUsd).toBe(total);
    expect(flat.find((s) => s.stepKey === "lead_found")!.spendAttribution.ownSpendUsd).toBe(total);
    expect(flat.find((s) => s.stepKey === "paid_client")!.spendAttribution.ownSpendUsd).toBe(0);
  });
});
