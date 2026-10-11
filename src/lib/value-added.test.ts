/** ONE formula for every campaign's return (owner 2026-10-11): value now − value where it took the people over. */
import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
// A stand-in for the engine's value of a person: a booked meeting is worth $400, a positive reply $150, else $0.
vi.mock("./revenue-engine.js", async (orig) => ({
  ...(await orig<typeof import("./revenue-engine.js")>()),
  expectedValueOfPerson: (p: { signals: Record<string, boolean> }) => (p.signals.meeting ? 400 : p.signals.positiveReply ? 150 : 0),
}));

const { takeoverStepOf, personAtStep, valueAdded, reachedCount } = await import("./value-added.js");
const { valueAddedTo } = await import("./agent-catalogue.js");
import type { EnginePerson } from "./revenue-engine.js";

const person = (leadId: string, signals: Record<string, boolean>): EnginePerson => ({ leadId, signals: { contacted: true, ...signals }, signalDates: {} }) as unknown as EnginePerson;

describe("takeoverStepOf", () => {
  it("a campaign whose own unit produces the first step took its people from nothing (Bliss: sourcing inside it)", () => {
    expect(takeoverStepOf("lead_found", [{ fromStep: null, toStep: "lead_found" }, { fromStep: "lead_found", toStep: "conversation" }])).toBeNull();
  });
  it("a campaign answering a step it does not produce took its people over there (Motivate: Positive reply)", () => {
    expect(takeoverStepOf("conversation", [{ fromStep: "conversation", toStep: "meeting_booked" }])).toBe("conversation");
  });
  it("a path from nothing has no takeover step", () => {
    expect(takeoverStepOf(null, [])).toBeNull();
  });
});

describe("valueAdded: the owner's worked example", () => {
  it("2 meetings booked off positive replies = 2 x ($400 - $150) = $500; a replier not booked adds $0", () => {
    const people = [
      person("a", { positiveReply: true, meeting: true }),
      person("b", { positiveReply: true, meeting: true }),
      person("c", { positiveReply: true }),
      person("a", { positiveReply: true, meeting: true }), // the same lead twice counts once
    ];
    const v = valueAdded(people, "conversation", [], 1000);
    expect(v).toEqual({ people: 3, valueNowUsd: 950, valueAtTakeoverUsd: 450, valueAddedUsd: 500 });
    // $500 on $10 spent: 50x.
    expect(v.valueAddedUsd / 10).toBe(50);
    // From nothing nothing is subtracted: the figure is the engine's own pipeline.
    expect(valueAdded(people, null, [], 1000).valueAddedUsd).toBe(950);
  });

  it("a person at a step keeps their stated value and holds only that step's signal", () => {
    const p = { ...person("a", { positiveReply: true, meeting: true }), valueUsd: 5000, deadSignals: ["closeWin"] } as EnginePerson;
    const at = personAtStep(p, "conversation")!;
    expect(at.signals).toEqual({ contacted: true, positiveReply: true });
    expect(at.valueUsd).toBe(5000);
    expect(at.deadSignals).toBeUndefined();
    // Lead found carries no engine signal: priced at $0 (the engine values a lead nobody engaged at $0).
    expect(personAtStep(p, "lead_found")).toBeNull();
  });

  it("counts the takeover pipe's outcomes off the signal, or off the act when the step has none (Booking call)", () => {
    const people = [person("a", { meeting: true }), person("b", {})];
    expect(reachedCount(people, "meeting_booked", false)).toBe(1);
    expect(reachedCount(people, "booking_call", true)).toBe(2);
  });
});

describe("the catalogue prices a pipe on the same rule (valueAddedTo)", () => {
  const values: Record<string, number> = { conversation: 150, meeting_booked: 450, lead_found: 20 };
  const valueOf = (s: string) => values[s] ?? null;
  it("a pipe from a valued step adds its outcome's value minus that step's", () => {
    expect(valueAddedTo(valueOf, "conversation", "meeting_booked")).toBe(300);
  });
  it("a pipe from nothing or from Lead found (no engine value) subtracts nothing", () => {
    expect(valueAddedTo(valueOf, null, "conversation")).toBe(150);
    expect(valueAddedTo(valueOf, "lead_found", "conversation")).toBe(150);
  });
});

describe("learningUntilMature", async () => {
  vi.doMock("./leads-client.js", () => ({}));
  const { learningUntilMature } = await import("./value-added-io.js");
  const block = { committedCostUsd: 0.07, actualCostUsd: 0.07, roiMultiple: 0, costOfAcquisitionPct: null, costPerAcquisitionUsd: null, maturityDays: 0, unmeasuredReason: null, ratioBasis: { committedCostUsd: 0.07, totalPipelineUsd: 0 }, realizedReturn: null } as never;
  it("below its leg's bar a campaign reads Learning (null ROI, maturing), like a young proactive one", () => {
    expect(learningUntilMature(block, false)).toMatchObject({ roiMultiple: null, unmeasuredReason: "maturing", committedCostUsd: 0.07 });
  });
  it("a mature leg, or nothing spent, keeps the figure", () => {
    expect(learningUntilMature(block, true)).toBe(block);
    expect(learningUntilMature({ ...(block as object), committedCostUsd: 0 } as never, false)).toMatchObject({ unmeasuredReason: null });
  });
});
