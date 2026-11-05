import { describe, it, expect, vi, beforeEach } from "vitest";

// DIGEST-SALES-ATTRIB-1105: each lead row says WHOSE WIN each outcome was, as lead-service judged it.
const outcomes = vi.hoisted(() => ({ byStep: {} as Record<string, unknown[]> }));
vi.mock("./step-outcomes-client.js", () => ({
  fetchStepOutcomes: vi.fn(async (_brandId: string, step: string) => outcomes.byStep[step] ?? []),
  fetchStepDisqualifications: vi.fn(async () => ({ byStep: new Map(), coldByStep: new Map(), cold: null })),
}));

import { fetchObservedStepFacts } from "./observed-steps.js";
import { applySignalOverlays } from "./signal-overlays.js";
import { causeByOutcomeOf, computeRevenue, dedupPersonsByLead, type EnginePerson } from "./revenue-engine.js";

const row = (email: string, occurredAt: string, causedByOutreach: boolean | null, valueCents: number | null = null) => ({
  leadId: email,
  email,
  campaignId: null,
  occurredAt,
  valueCents,
  source: "manual",
  causedByOutreach,
});

const person = (leadId: string, extra: Partial<EnginePerson> = {}): EnginePerson =>
  ({
    leadId,
    email: `${leadId}@x.com`,
    signals: { contacted: true, delivered: true },
    signalDates: { delivered: "2026-07-13T00:00:00.000Z" },
    ...extra,
  }) as unknown as EnginePerson;

beforeEach(() => {
  outcomes.byStep = {};
});

describe("causeByOutcome on the lead row (DIGEST-SALES-ATTRIB-1105)", () => {
  it("carries lead-service's verdict per sale: ours, not ours, undecided", async () => {
    outcomes.byStep.sale = [
      row("dan@x.com", "2026-11-03T19:10:00.000Z", true, 500000),
      row("thomas@x.com", "2026-11-03T19:20:00.000Z", false, 500000),
      row("keith@x.com", "2026-11-03T19:30:00.000Z", null, 500000),
    ];
    outcomes.byStep.meeting_booked = [row("thomas@x.com", "2025-03-19T00:00:00.000Z", false)];
    const observed = await fetchObservedStepFacts("brand-1");
    const persons = [person("dan"), person("thomas"), person("keith"), person("nobody")];
    applySignalOverlays(persons, null, observed.byEmail);

    expect(causeByOutcomeOf(persons[0])).toEqual({ purchased: "outreach" });
    expect(causeByOutcomeOf(persons[1])).toEqual({ meetingBooked: "other", purchased: "other" });
    expect(causeByOutcomeOf(persons[2])).toEqual({ purchased: "unstated" });
    expect(causeByOutcomeOf(persons[3])).toBeUndefined();
  });

  it("is served on computeRevenue's lead rows, independent of what is priced", async () => {
    outcomes.byStep.sale = [row("thomas@x.com", "2026-11-03T19:20:00.000Z", false, 500000)];
    const observed = await fetchObservedStepFacts("brand-1");
    const persons = [person("thomas")];
    applySignalOverlays(persons, null, observed.byEmail);
    const result = computeRevenue([], persons, 1000, [{ tag: "contacted", signal: "contacted" }]);
    const lead = result.leads.find((l) => l.leadId === "thomas");
    expect(lead?.purchased).toBe(true);
    expect(lead?.causeByOutcome).toEqual({ purchased: "other" });
  });

  it("several statements on one outcome keep the strongest answer", async () => {
    outcomes.byStep.sale = [
      row("a@x.com", "2026-11-03T00:00:00.000Z", null),
      row("a@x.com", "2026-11-04T00:00:00.000Z", false),
      row("b@x.com", "2026-11-03T00:00:00.000Z", false),
      row("b@x.com", "2026-11-04T00:00:00.000Z", true),
    ];
    const observed = await fetchObservedStepFacts("brand-1");
    expect(observed.byEmail.get("a@x.com")?.causes?.closeWin).toBe("other");
    expect(observed.byEmail.get("b@x.com")?.causes?.closeWin).toBe("outreach");
  });

  it("a legacy qualification carries the delivery rule's answer; a statement about the same rung wins", async () => {
    const legacyOnly = person("l");
    const restated = person("r", { email: "r@x.com" } as Partial<EnginePerson>);
    outcomes.byStep.sale = [row("r@x.com", "2026-11-03T00:00:00.000Z", false)];
    const observed = await fetchObservedStepFacts("brand-1");
    const quals = new Map([
      ["l@x.com", { meetingBookedAt: "2026-08-10T18:46:00.000Z", closedAt: null }],
      ["r@x.com", { meetingBookedAt: null, closedAt: "2026-08-10T18:46:00.000Z" }],
    ]);
    applySignalOverlays([legacyOnly, restated], null, observed.byEmail, quals as never);
    expect(causeByOutcomeOf(legacyOnly)).toEqual({ meetingBooked: "outreach" });
    expect(causeByOutcomeOf(restated)).toEqual({ purchased: "other" });
  });

  it("a reached outcome no statement covers reads unstated (a tracker signup)", () => {
    const p = person("s");
    p.signals.signup = true;
    expect(causeByOutcomeOf(p)).toEqual({ signup: "unstated" });
  });

  it("dedup across campaign rows keeps the strongest answer and never mutates a row", () => {
    const a = person("d", { signals: { closeWin: true }, signalCauses: { closeWin: "other" } } as Partial<EnginePerson>);
    const b = person("d", { signals: { closeWin: true }, signalCauses: { closeWin: "outreach" } } as Partial<EnginePerson>);
    const [merged] = dedupPersonsByLead([a, b]);
    expect(causeByOutcomeOf(merged)).toEqual({ purchased: "outreach" });
    expect(a.signalCauses).toEqual({ closeWin: "other" });
  });
});
