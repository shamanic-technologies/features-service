import { describe, expect, it } from "vitest";
import { outcomeValues, scriptRatings, pickScript, strongestOf, creditOf, MIN_CONSUMED_UNITS, type ReachGroup, type StepRate } from "./script-value-rating.js";

/**
 * SCRIPT-VALUE-RATING-1113 (owner 2026-11-13): a script run is credited the value of the strongest outcome its chain
 * reached; values flow down from the offer's lifetime revenue through the measured one-step rates.
 * Worked example = the owner's: two writers at the same Engine, 500 runs each, 4 against 12 interested leads.
 */
const step = (fromOutcome: string, toOutcome: string, consumedUnits: number, ledUnits: number): StepRate => ({ fromOutcome, toOutcome, consumedUnits, ledUnits });
const STEPS = [
  step("message_written", "email_sent", 1000, 990),
  step("email_sent", "lead_interested", 1000, 15),
  step("lead_interested", "meeting_booked", 100, 30),
  step("meeting_booked", "paid_client", 50, 10),
];
const LTR = 2100;

describe("outcomeValues", () => {
  it("flows down from the lifetime revenue, one measured step at a time", () => {
    const v = outcomeValues({ steps: STEPS, anchor: { outcome: "paid_client", valueUsd: LTR }, declared: new Map() });
    expect(v.get("paid_client")).toMatchObject({ valueUsd: 2100, source: "anchor", via: null });
    expect(v.get("meeting_booked")).toMatchObject({ valueUsd: 420, source: "measured", via: { toOutcome: "paid_client", share: 0.2 } });
    expect(v.get("lead_interested")!.valueUsd).toBeCloseTo(126, 6);
    expect(v.get("email_sent")!.valueUsd).toBeCloseTo(1.89, 6);
    expect(v.get("message_written")!.valueUsd).toBeCloseTo(1.8711, 6);
  });

  it("takes the best next outcome, not the first", () => {
    const v = outcomeValues({ steps: [...STEPS, step("lead_interested", "paid_client", 100, 10)], anchor: { outcome: "paid_client", valueUsd: LTR }, declared: new Map() });
    expect(v.get("lead_interested")).toMatchObject({ valueUsd: 210, via: { toOutcome: "paid_client", share: 0.1 } });
  });

  it("a step the ledger cannot measure takes the declared value; what is above it flows from that", () => {
    const steps = STEPS.filter((s) => s.toOutcome !== "paid_client");
    const v = outcomeValues({ steps, anchor: { outcome: "paid_client", valueUsd: LTR }, declared: new Map([["meeting_booked", 300]]) });
    expect(v.get("meeting_booked")).toMatchObject({ valueUsd: 300, source: "declared", via: null });
    expect(v.get("lead_interested")).toMatchObject({ valueUsd: 90, source: "measured" });
  });

  it("a step measured on too few Units is not a rate", () => {
    const thin = [step("meeting_booked", "paid_client", MIN_CONSUMED_UNITS - 1, MIN_CONSUMED_UNITS - 1)];
    const v = outcomeValues({ steps: thin, anchor: { outcome: "paid_client", valueUsd: LTR }, declared: new Map([["meeting_booked", 300]]) });
    expect(v.get("meeting_booked")).toMatchObject({ valueUsd: 300, source: "declared" });
  });

  it("an outcome nothing links to a valued one is worth nothing, never guessed", () => {
    const v = outcomeValues({ steps: [step("post_drafted", "post_published", 100, 90)], anchor: { outcome: "paid_client", valueUsd: LTR }, declared: new Map() });
    expect(v.get("post_drafted")).toBeUndefined();
  });

  it("a loop between two outcomes settles, and no lifetime revenue values nothing", () => {
    const loop = [...STEPS, step("lead_interested", "email_sent", 100, 100), step("email_sent", "email_sent", 100, 100)];
    const v = outcomeValues({ steps: loop, anchor: { outcome: "paid_client", valueUsd: LTR }, declared: new Map() });
    expect(v.get("lead_interested")!.valueUsd).toBeCloseTo(126, 6);
    expect(outcomeValues({ steps: STEPS, anchor: { outcome: "paid_client", valueUsd: null }, declared: new Map() }).size).toBe(0);
  });
});

const VALUES = outcomeValues({ steps: STEPS, anchor: { outcome: "paid_client", valueUsd: LTR }, declared: new Map() });
const g = (scriptDynasty: string, runs: number, reached: string[], spentUsd: number | null, produced = ["message_written"]): ReachGroup => ({ scriptDynasty, day: "2026-11-10", producedOutcomes: produced, reachedOutcomes: reached, runs, spentUsd });
const GROUPS = [
  g("message_written/flash_lite", 496, ["email_sent"], 0.992),
  g("message_written/flash_lite", 4, ["email_sent", "lead_interested"], 0.008),
  g("message_written/haiku", 488, ["email_sent"], 1.952),
  g("message_written/haiku", 12, ["email_sent", "lead_interested"], 0.048),
];

describe("scriptRatings", () => {
  it("the strongest outcome of a run is the most valued one it made or reached", () => {
    expect(strongestOf(g("x/y", 1, ["email_sent", "lead_interested"], 0), VALUES)).toEqual({ outcome: "lead_interested", valueUsd: VALUES.get("lead_interested")!.valueUsd });
    expect(strongestOf(g("x/y", 1, [], 0, []), VALUES)).toEqual({ outcome: null, valueUsd: 0 });
  });

  it("a run is credited what it reached beyond its own Unit; led nowhere further = nothing", () => {
    expect(creditOf(g("x/y", 1, ["email_sent", "lead_interested"], 0), VALUES).creditUsd).toBeCloseTo(126 - 1.8711, 6);
    expect(creditOf(g("x/y", 1, [], 0), VALUES)).toEqual({ outcome: null, creditUsd: 0 });
    expect(creditOf(g("x/y", 1, ["email_sent"], 0, []), VALUES)).toMatchObject({ outcome: "email_sent" });
  });

  it("the owner's example: same Engine, 4 against 12 interested leads, twice the price: the dearer writer wins", () => {
    const rows = scriptRatings({ groups: GROUPS, values: VALUES });
    const cheap = rows.find((r) => r.scriptDynasty === "message_written/flash_lite")!;
    const dear = rows.find((r) => r.scriptDynasty === "message_written/haiku")!;
    expect(cheap).toMatchObject({ outcome: "message_written", runs: 500, spentUsd: 1, costPerRunUsd: 0.002 });
    expect(cheap.reached.map((r) => [r.outcome, r.runs])).toEqual([["lead_interested", 4], ["email_sent", 496]]);
    const own = 1.8711;
    expect(cheap.valuePerRunUsd).toBeCloseTo((4 * (126 - own) + 496 * (1.89 - own)) / 500, 6);
    expect(dear.valuePerRunUsd).toBeCloseTo((12 * (126 - own) + 488 * (1.89 - own)) / 500, 6);
    expect(Math.round(cheap.valuePerDollar!)).toBe(506);
    expect(Math.round(dear.valuePerDollar!)).toBe(749);
    expect(dear.valuePerDollar!).toBeGreaterThan(cheap.valuePerDollar!);
    expect(rows[0]!.scriptDynasty).toBe("message_written/haiku");
  });

  it("a script whose spend is not served has no value per dollar, with the reason", () => {
    const [row] = scriptRatings({ groups: [g("message_written/haiku", 10, ["email_sent"], null)], values: VALUES });
    expect(row).toMatchObject({ spentUsd: null, costPerRunUsd: null, valuePerDollar: null, valuePerDollarUnavailableReason: "spend_not_served" });
  });

  it("a script that ran for free is not infinitely good: no figure", () => {
    const [row] = scriptRatings({ groups: [g("message_written/haiku", 10, ["email_sent"], 0)], values: VALUES });
    expect(row).toMatchObject({ valuePerDollar: null, valuePerDollarUnavailableReason: "no_spend" });
  });
});

describe("pickScript", () => {
  const rng = () => {
    let s = 42;
    return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  };
  const candidates = ["message_written/flash_lite", "message_written/haiku", "message_written/new_one"];

  it("draws the better value per dollar most of the time, and still tries the others", () => {
    const rows = scriptRatings({ groups: GROUPS, values: VALUES });
    const r = rng();
    const tally = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const p = pickScript({ outcome: "message_written", candidates, ratings: rows, values: VALUES, rng: r });
      tally.set(p.scriptDynasty!, (tally.get(p.scriptDynasty!) ?? 0) + 1);
    }
    expect(tally.get("message_written/haiku")!).toBeGreaterThan(tally.get("message_written/flash_lite")!);
    expect(tally.get("message_written/new_one") ?? 0).toBeGreaterThan(0);
  });

  it("with no value anywhere the cheapest per run goes first (today's behaviour), then the slug", () => {
    const rows = scriptRatings({ groups: GROUPS, values: new Map() });
    const p = pickScript({ outcome: "message_written", candidates: candidates.slice(0, 2), ratings: rows, values: new Map(), rng: rng() });
    expect(p).toMatchObject({ scriptDynasty: "message_written/flash_lite", basis: "cost_only" });
  });

  it("no candidate = no pick, with the reason", () => {
    expect(pickScript({ outcome: "message_written", candidates: [], ratings: [], values: VALUES, rng: rng() })).toMatchObject({ scriptDynasty: null, basis: "no_candidate" });
  });
});
