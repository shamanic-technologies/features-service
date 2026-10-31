import { describe, expect, it } from "vitest";
import {
  buildOutcomeCostSeries,
  contactedOutcomeDays,
  expectedStepCosts,
  monthsBetween,
  roiOf,
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
    const out = contactedOutcomeDays(persons, new Set(["c1"]), new Set(["e"]), "2026-06-15");
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

  it("ROI = value ÷ cost: measured over the since-inception cost, expected over the expected cost, never a guess", () => {
    // conversation: $840 worth ÷ $60 measured; no expected cost.
    expect(reply.value).toEqual({ valuePerOutcomeUsd: 840, unavailableReason: null });
    expect(reply.roi).toEqual({ measured: 14, expected: null });
    // meeting_booked: nothing measured yet, $840 ÷ $420 expected.
    expect(meeting.roi).toEqual({ measured: null, expected: 2 });
    // A step nobody values carries no ROI.
    expect(series.find((s) => s.stepKey === "signup")!.roi).toEqual({ measured: null, expected: null });
  });

  it("monthsBetween crosses years", () => {
    expect(monthsBetween("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
});

describe("stepValues: one outcome is worth the lifetime revenue ÷ the outcomes one paying client needs", () => {
  const leg = (toStep: string, outcomesNeededPerPayingClient: number | null) =>
    ({ legKey: `x_to_${toStep}`, toStep: { key: toStep }, workedBy: "platform", outcomesNeededPerPayingClient }) as unknown as SalesPath["legs"][number];
  const path = { combinationKey: "p", lifetimeRevenueUsd: 3000, legs: [leg("conversation", 20), leg("meeting_booked", 8), leg("paid_client", 1)] } as unknown as SalesPath;

  it("values every step on the path, the paying client at the whole lifetime revenue", () => {
    const m = stepValues(path, null);
    expect(m.get("conversation")!.valuePerOutcomeUsd).toBe(150);
    expect(m.get("meeting_booked")!.valuePerOutcomeUsd).toBe(375);
    expect(m.get("paid_client")!.valuePerOutcomeUsd).toBe(3000);
    expect(m.get("signup")).toEqual({ valuePerOutcomeUsd: null, unavailableReason: "step_not_on_expected_path" });
  });

  it("no lifetime revenue, a 0% leg or no path each name their reason", () => {
    expect(stepValues({ ...path, lifetimeRevenueUsd: null } as SalesPath, null).get("conversation")!.unavailableReason).toBe("no_lifetime_revenue");
    expect(stepValues({ ...path, legs: [leg("conversation", null)] } as SalesPath, null).get("conversation")!.unavailableReason).toBe("zero_conversion_rate");
    expect(stepValues(null, "expected_model_computing").get("paid_client")!.unavailableReason).toBe("expected_model_computing");
  });

  it("roiOf never divides by a missing or zero cost", () => {
    expect(roiOf(100, 40)).toBe(2.5);
    expect(roiOf(100, 0)).toBeNull();
    expect(roiOf(null, 40)).toBeNull();
    expect(roiOf(100, null)).toBeNull();
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
