import { describe, expect, it } from "vitest";
import {
  buildOutcomeCostSeries,
  contactedOutcomeDays,
  leadStepAccounting,
  expectedStepCosts,
  monthsBetween,
  stepValues,
  OUTCOME_COST_STEPS,
  type OutcomeCostStep,
  type StepExpectedCost,
  type StepValue,
} from "./outcome-cost-series.js";
import type { EnginePerson } from "./revenue-engine.js";
import type { SalesPath } from "./offer-sales-paths.js";

const person = (over: Partial<EnginePerson> & { leadId: string }): EnginePerson =>
  ({
    firstName: null,
    lastName: null,
    photoUrl: null,
    orgId: null,
    orgName: null,
    orgLogoUrl: null,
    orgDomain: null,
    title: null,
    seniority: null,
    orgIndustry: null,
    orgEmployeeCount: null,
    orgCity: null,
    orgCountry: null,
    campaignId: "c1",
    signals: {},
    signalDates: {},
    ...over,
  }) as EnginePerson;

const noExpected: StepExpectedCost = { costPerOutcomeUsd: null, basis: null, combinationKey: null, unavailableReason: "step_not_on_expected_path" };
const noValue: StepValue = { valuePerOutcomeUsd: null, unavailableReason: "step_not_on_expected_path" };

describe("contactedOutcomeDays (OUTCOME-COST-SERIES-1027, owner choice A)", () => {
  it("counts only people WE contacted, once per step, never another factory's win nor one before the offer started", () => {
    const persons = [
      // Contacted, replied, booked: counts on both steps.
      person({ leadId: "a", servedAt: "2026-07-01T00:00:00Z", signals: { contacted: true, positiveReply: true, meeting: true }, signalDates: { positiveReply: "2026-07-05T10:00:00Z", meeting: "2026-08-02T10:00:00Z" } }),
      // The same lead twice (two memberships): counted once.
      person({ leadId: "a", servedAt: "2026-07-01T00:00:00Z", signals: { contacted: true, positiveReply: true }, signalDates: { positiveReply: "2026-07-05T10:00:00Z" } }),
      // Signed up in the client's own tools, never emailed by us: Lead found only.
      person({ leadId: "b", servedAt: "2026-07-02T00:00:00Z", signals: { signup: true }, signalDates: { signup: "2026-07-10T00:00:00Z" } }),
      // Contacted, but the signup is tagged as not ours.
      person({ leadId: "c", servedAt: "2026-07-02T00:00:00Z", signals: { contacted: true, signup: true }, signalDates: { signup: "2026-07-11T00:00:00Z" }, unpricedSignals: ["signup"] }),
      // Contacted, a sale dated before the offer's first spend day: not the offer's.
      person({ leadId: "d", servedAt: "2026-07-02T00:00:00Z", signals: { contacted: true, closeWin: true }, signalDates: { closeWin: "2026-05-01T00:00:00Z" } }),
      // Not served by the offer's campaigns, but a follow-up pipe of the offer acted on them: contacted, undated meeting.
      person({ leadId: "e", campaignId: "other", signals: { meeting: true }, signalDates: {} }),
    ];
    const out = contactedOutcomeDays(persons, new Set(["a", "b", "c", "d"]), new Set(["e"]), "2026-06-15");
    expect(out.get("conversation")).toEqual(["2026-07-05"]);
    expect(out.get("meeting_booked")).toEqual(["2026-08-02", null]);
    expect(out.get("signup")).toEqual([]);
    expect(out.get("paid_client")).toEqual([]);
    expect(out.get("lead_found")).toEqual(["2026-07-01", "2026-07-02", "2026-07-02", "2026-07-02"]);
    expect([...out.keys()]).toEqual([...OUTCOME_COST_STEPS]);
  });
});

describe("buildOutcomeCostSeries", () => {
  const spend = new Map([
    ["2026-07-03", 100.004],
    ["2026-07-20", 50.01],
    ["2026-09-01", 30],
  ]);
  const days = new Map<OutcomeCostStep, (string | null)[]>([
    ["conversation", ["2026-07-05", "2026-09-10", null]],
    ["meeting_booked", []],
  ]);
  const series = buildOutcomeCostSeries({
    spendByDay: spend,
    outcomeDays: days,
    learningBarOf: (s) => (s === "conversation" ? 1 : 10),
    expectedOf: (s) => (s === "meeting_booked" ? { costPerOutcomeUsd: 420, basis: "default", combinationKey: "k", unavailableReason: null } : noExpected),
    valueOf: (s) => (s === "meeting_booked" || s === "conversation" ? { valuePerOutcomeUsd: 840, unavailableReason: null } : noValue),
    today: "2026-10-27",
  });
  const reply = series.find((s) => s.stepKey === "conversation")!;
  const meeting = series.find((s) => s.stepKey === "meeting_booked")!;

  it("serves every step on one month axis, first spend month to the current month, no gap", () => {
    expect(series.map((s) => s.stepKey)).toEqual([...OUTCOME_COST_STEPS]);
    expect(reply.months.map((m) => m.month)).toEqual(["2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(meeting.months.map((m) => m.month)).toEqual(reply.months.map((m) => m.month));
  });

  it("per month and cumulative $/outcome; the undated outcome lands on the last month", () => {
    expect(reply.months.map((m) => [m.spendUsd, m.outcomes, m.costPerOutcomeUsd])).toEqual([
      [150.01, 1, 150.01],
      [0, 0, null],
      [30, 1, 30],
      [0, 1, 0],
    ]);
    expect(reply.months.map((m) => m.cumulativeCostPerOutcomeUsd)).toEqual([150.01, 150.01, 90.01, 60]);
  });

  it("the last cumulative IS the since-inception headline, to the cent", () => {
    const last = reply.months.at(-1)!;
    expect(reply.sinceInception).toEqual({ spendUsd: last.cumulativeSpendUsd, outcomes: 3, undatedOutcomes: 1, costPerOutcomeUsd: last.cumulativeCostPerOutcomeUsd, learning: false });
    expect(reply.sinceInception.spendUsd).toBe(180.01);
  });

  it("zero outcomes: no spend floor, learning, the expected value", () => {
    expect(meeting.sinceInception).toMatchObject({ spendUsd: 180.01, outcomes: 0, costPerOutcomeUsd: null, learning: true });
    expect(meeting.months.every((m) => m.costPerOutcomeUsd === null && m.cumulativeCostPerOutcomeUsd === null && m.learning)).toBe(true);
    expect(meeting.expected.costPerOutcomeUsd).toBe(420);
  });

  it("an offer with nothing yet serves empty months, never a guessed point", () => {
    const empty = buildOutcomeCostSeries({ spendByDay: new Map(), outcomeDays: new Map(), learningBarOf: () => 10, expectedOf: () => noExpected, valueOf: () => noValue, today: "2026-10-27" });
    expect(empty.every((s) => s.months.length === 0 && s.sinceInception.costPerOutcomeUsd === null && s.sinceInception.spendUsd === 0)).toBe(true);
  });

  it("serves the step's value beside its cost, never a return (ROI-CONSISTENCY-1103)", () => {
    expect(reply.value).toEqual({ valuePerOutcomeUsd: 840, unavailableReason: null });
    expect(series.every((s) => !("roi" in s))).toBe(true);
    expect(meeting.expected.costPerOutcomeUsd).toBe(420);
  });

  it("monthsBetween crosses years", () => {
    expect(monthsBetween("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
});

describe("stepValues (OUTCOME-ACCOUNTING-1107): one outcome's NET value, V(s) = max(0, y x V(next) - c)", () => {
  const leg = (fromStep: string | null, toStep: string, conversionRatePct: number | null, costPerOutcomeUsd: number | null, workedBy: "platform" | "human" = "platform") =>
    ({ legKey: `${fromStep ?? "start"}_to_${toStep}`, fromStep: fromStep ? { key: fromStep } : null, toStep: { key: toStep }, workedBy, conversionRatePct, costPerOutcomeUsd, rateSource: "default", costSource: "default" }) as unknown as SalesPath["legs"][number];
  // Positive reply (entry, $10 each) -> Meeting booked (40%, $20 each, AI booking) -> Paid client (25%, the client's team: $0).
  // V(paid) = 3000; V(meeting) = 0.25 x (3000 - 0) = 750; V(reply) = 0.40 x (750 - 20) = 292. The gross read 3000 x 0.4 x 0.25 = 300.
  const path = { combinationKey: "p", lifetimeRevenueUsd: 3000, legs: [leg("lead_found", "conversation", null, 10), leg("conversation", "meeting_booked", 40, 20), leg("meeting_booked", "paid_client", 25, null, "human")] } as unknown as SalesPath;

  it("values every step on the path net of what the later milestones cost, the paying client at the whole lifetime revenue", () => {
    const m = stepValues(path, null);
    expect(m.get("conversation")!.valuePerOutcomeUsd).toBe(292);
    expect(m.get("meeting_booked")!.valuePerOutcomeUsd).toBe(750);
    expect(m.get("paid_client")!.valuePerOutcomeUsd).toBe(3000);
    expect(m.get("signup")).toEqual({ valuePerOutcomeUsd: null, unavailableReason: "step_not_on_expected_path" });
  });

  it("no lifetime revenue, an unrated leg or no path each name their reason", () => {
    expect(stepValues({ ...path, lifetimeRevenueUsd: null } as SalesPath, null).get("conversation")!.unavailableReason).toBe("no_lifetime_revenue");
    expect(stepValues({ ...path, legs: [path.legs[0], leg("conversation", "meeting_booked", null, 20), path.legs[2]] } as SalesPath, null).get("conversation")!.unavailableReason).toBe("leg_rate_unavailable");
    expect(stepValues(null, "expected_model_computing").get("paid_client")!.unavailableReason).toBe("expected_model_computing");
  });
});

describe("expectedStepCosts: a step's expected cost carries the lower steps it needed", () => {
  const leg = (toStep: string, workedBy: "platform" | "human", costPerPayingClientUsd: number | null, outcomesNeededPerPayingClient: number | null) =>
    ({ legKey: `x_to_${toStep}`, toStep: { key: toStep }, workedBy, costPerPayingClientUsd, outcomesNeededPerPayingClient }) as unknown as SalesPath["legs"][number];
  const path = {
    combinationKey: "p",
    legs: [leg("conversation", "platform", 1000, 20), leg("meeting_booked", "platform", 200, 10), leg("meeting_attended", "human", null, 8), leg("paid_client", "human", null, 1)],
  } as unknown as SalesPath;

  it("cumulative platform cost per paying client ÷ the step's outcomes needed", () => {
    const m = expectedStepCosts(path, "default", null);
    expect(m.get("conversation")!.costPerOutcomeUsd).toBe(50);
    expect(m.get("meeting_booked")!.costPerOutcomeUsd).toBe(120);
    expect(m.get("meeting_attended")!.costPerOutcomeUsd).toBe(150);
    expect(m.get("paid_client")!.costPerOutcomeUsd).toBe(1200);
    expect(m.get("website_visit")).toMatchObject({ costPerOutcomeUsd: null, unavailableReason: "step_not_on_expected_path" });
  });

  it("an unpriced platform leg up to the step leaves it null; no path names the reason", () => {
    const broken = { ...path, legs: [leg("conversation", "platform", null, 20), ...path.legs.slice(1)] } as SalesPath;
    expect(expectedStepCosts(broken, "default", null).get("meeting_booked")!.unavailableReason).toBe("leg_cost_unavailable");
    expect(expectedStepCosts(null, null, "expected_model_computing").get("conversation")!.unavailableReason).toBe("expected_model_computing");
  });
});

describe("leadStepAccounting (OUTCOME-ACCOUNTING-1107): a lead outcome's report on the offer's expected path", () => {
  const legs = [
    { fromStep: "lead_found", toStep: "conversation", ratePct: null, rateBasis: null, costPerUnitUsd: 10, costBasis: "workflow", legKey: "lead_found_to_conversation" },
    { fromStep: "conversation", toStep: "meeting_booked", ratePct: 40, rateBasis: "measured", costPerUnitUsd: 20, costBasis: "workflow", legKey: "conversation_to_meeting_booked" },
    { fromStep: "meeting_booked", toStep: "paid_client", ratePct: 25, rateBasis: "default", costPerUnitUsd: 0, costBasis: "customer_team", legKey: "meeting_booked_to_paid_client" },
  ];
  const at = (entries: Array<[string, string | null]>) => new Map(entries.map(([id, c]) => [id, { day: null, campaignId: c }]));
  // 10 repliers (8 credited to the booking pipe's input campaign), 4 of them booked by the booking unit, 1 paid.
  const outcomes = new Map<OutcomeCostStep, Map<string, { day: string | null; campaignId: string | null }>>(OUTCOME_COST_STEPS.map((s) => [s, new Map()]));
  outcomes.set("conversation", at(Array.from({ length: 10 }, (_, i) => [`l${i}`, "cold"])));
  outcomes.set("meeting_booked", at([["l0", "book"], ["l1", "book"], ["l2", "book"], ["l3", "book"]]));
  outcomes.set("paid_client", at([["l0", "book"]]));
  const base = {
    outcomes,
    windowDaysOf: () => 0,
    lifetimeRevenueUsd: 3000,
    lifetimeRevenueSource: "offer_stated",
    expectedBasis: "default",
    today: "2026-11-07",
    targets: [],
    targetSpendUsd: null,
  };

  it("meeting booked: actual = the booking unit's spend ÷ what it booked, expected = its leg, variance split on the yield into it", async () => {
    const { expectedRouteFigures } = await import("./outcome-accounting.js");
    const r = leadStepAccounting({
      ...base,
      step: "meeting_booked",
      figures: expectedRouteFigures(legs, "meeting_booked", 3000),
      intoLeg: { fromStep: "conversation", ratePct: 40, legKey: "conversation_to_meeting_booked" },
      landingUnitIds: new Set(["book"]),
      landingSpendUsd: 100,
      actualCostFromStartUsd: 250,
    });
    expect(r.costPerUnit).toMatchObject({ actualUsd: 25, actualUnits: 4, expectedUsd: 20 });
    // Measured yield into the step 4/10 = 40% = standard: the whole $5 is mix (more spend per attempt).
    expect(r.costPerUnit.variance).toMatchObject({ usd: 5, yieldUsd: 0, mixUsd: 5 });
    // Cost from Start: (10 / 0.4) + 20 = $45 expected; $250 actual (the offer's whole spend ÷ its meetings).
    expect(r.costFromStart).toMatchObject({ expectedUsd: 45, actualUsd: 250, rolledYieldPct: 40, rolledYieldFromStep: "conversation" });
    // Next milestone Paid client: 1 of 4 measured, pooled with the 25% prior.
    expect(r.yieldToNext).toMatchObject({ nextStep: "paid_client", measuredPct: 25, expectedPct: 25 });
    expect(r.value.expectedNetPerUnitUsd).toBe(750);
    expect(r.returns).toMatchObject({ isCampaignTarget: false, unavailableReason: "outcome_is_no_campaign_target" });
  });

  it("paid client as a campaign Target: measured = its Units x LTR ÷ its spend, expected = LTR ÷ cost from Start", async () => {
    const { expectedRouteFigures } = await import("./outcome-accounting.js");
    const r = leadStepAccounting({
      ...base,
      step: "paid_client",
      figures: expectedRouteFigures(legs, "paid_client", 3000),
      intoLeg: { fromStep: "meeting_booked", ratePct: 25, legKey: null },
      landingUnitIds: new Set(),
      landingSpendUsd: 0,
      actualCostFromStartUsd: 1000,
      targets: [{ campaignId: "fc", unitCampaignIds: ["cold", "book"] }],
      targetSpendUsd: 1000,
    });
    expect(r.costPerUnit.actualUnavailableReason).toBe("not_made_by_our_campaigns");
    expect(r.returns).toMatchObject({ isCampaignTarget: true, measured: { targetUnits: 1, roiMultiple: 3 }, expected: { costFromStartUsd: 180, roiMultiple: 16.67 } });
  });
});
