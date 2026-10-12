import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const { buildOurLeadsToTeam, ourLeadsToTeamFigures, reachedToAt } = await import("./team-on-our-leads.js");

const pipe = { fromStepLabel: "Positive reply", toStepLabel: "Meeting booked" };
const meta = { fromEvidence: "lead_snapshot" as const, producingChannels: ["cold-email"], ourChannelsOnLeg: ["ai-meeting-booking"], toSources: ["tracker"] };

describe("reachedToAt: TO counts on or after the day FROM was reached", () => {
  it("same day counts, an earlier day does not, an undated end counts", () => {
    expect(reachedToAt("2026-10-02T15:00:00Z", ["2026-10-02T09:00:00Z"])).toBe("2026-10-02");
    expect(reachedToAt("2026-10-02T15:00:00Z", ["2026-10-01T09:00:00Z"])).toBeUndefined();
    expect(reachedToAt("2026-10-02T15:00:00Z", [null])).toBeNull();
    expect(reachedToAt(null, ["2026-09-01T00:00:00Z"])).toBe("2026-09-01");
    expect(reachedToAt("2026-10-02T00:00:00Z", undefined)).toBeUndefined();
    // The earliest qualifying date wins.
    expect(reachedToAt("2026-10-02T00:00:00Z", ["2026-10-01T00:00:00Z", "2026-10-05T00:00:00Z", "2026-10-03T00:00:00Z"])).toBe("2026-10-03");
  });
});

describe("our leads left to the customer's team (owner 2026-10-12)", () => {
  // Doc Dinners' shape: 10 positive replies we brought, our AI acted on 8 and booked 2; 2 left to their team, 1 booked.
  const brought = Array.from({ length: 10 }, (_, i) => ({ leadId: `l${i}`, fromAt: `2026-10-0${(i % 3) + 1}T10:00:00Z` }));
  const acted = new Map(Array.from({ length: 8 }, (_, i) => [`l${i}`, `2026-10-0${(i % 3) + 1}T11:00:00Z`] as const));
  const toAtByLead = new Map<string, Array<string | null>>([
    ["l0", ["2026-10-02T00:00:00Z"]],
    ["l1", ["2026-10-04T00:00:00Z"]],
    ["l8", ["2026-10-05T00:00:00Z"]],
    // Booked before the reply: not a booking on the reply we brought.
    ["l9", ["2026-09-01T00:00:00Z"]],
  ]);

  it("counts the people we brought that our pipes did not act on, and our pipes' rate beside it", () => {
    const f = ourLeadsToTeamFigures({ brought, acted, actedInScope: new Set(acted.keys()), toAtByLead });
    expect(f).toMatchObject({ broughtToFrom: 10, actedOnByOurPipes: 8, ourPipesRate: { actedOn: 8, outcomes: 2, ratePct: 25 } });
    const block = buildOurLeadsToTeam(pipe, meta, [f], null, "2026-10-06");
    expect(block.available).toBe(true);
    expect(block.volumes.map((v) => [v.key, v.total])).toEqual([["leftToTeam", 2], ["outcomes", 1]]);
    expect(block.conversionRates[0]).toMatchObject({ key: "leftToTeam_to_outcomes", numerator: 1, denominator: 2, ratePct: 50 });
    expect(block.ourPipesRate).toEqual({ actedOn: 8, outcomes: 2, ratePct: 25, unavailableReason: null });
    // History is cumulative and its last point is the snapshot.
    expect(block.history.at(-1)).toMatchObject({ date: "2026-10-06", volumes: { leftToTeam: 2, outcomes: 1 }, conversionRates: { leftToTeam_to_outcomes: 50 } });
    expect(block.history.find((h) => h.date === "2026-10-04")!.volumes).toEqual({ leftToTeam: 2, outcomes: 0 });
  });

  it("a person on two orgs counts once, the earliest dated reply wins", () => {
    const f = ourLeadsToTeamFigures({
      brought: [{ leadId: "x", fromAt: null }, { leadId: "x", fromAt: "2026-10-03T00:00:00Z" }, { leadId: "x", fromAt: "2026-10-02T00:00:00Z" }],
      acted: new Map(),
      actedInScope: new Set(),
      toAtByLead: new Map(),
    });
    expect(f.broughtToFrom).toBe(1);
    expect([...f.left.daily]).toEqual([["2026-10-02", 1]]);
    expect(f.ourPipesRate).toMatchObject({ actedOn: 0, ratePct: null, unavailableReason: "no_input_yet" });
  });

  it("sums brands; an unmeasurable leg is null + a reason, never 0", () => {
    const a = ourLeadsToTeamFigures({ brought, acted, actedInScope: new Set(acted.keys()), toAtByLead });
    const b = ourLeadsToTeamFigures({ brought: [{ leadId: "z", fromAt: "2026-10-01T00:00:00Z" }], acted: new Map(), actedInScope: new Set(), toAtByLead: new Map([["z", [null]]]) });
    const both = buildOurLeadsToTeam(pipe, meta, [a, b], null, "2026-10-06");
    expect(both).toMatchObject({ brandsCounted: 2, broughtToFrom: 11, actedOnByOurPipes: 8 });
    expect(both.volumes.map((v) => [v.key, v.total, v.undated])).toEqual([["leftToTeam", 3, 0], ["outcomes", 2, 1]]);
    const none = buildOurLeadsToTeam(pipe, { ...meta, fromEvidence: null }, null, "from_step_not_produced_by_our_campaigns", "2026-10-06");
    expect(none).toMatchObject({ available: false, unavailableReason: "from_step_not_produced_by_our_campaigns", broughtToFrom: null, toEvidence: null });
    expect(none.volumes.map((v) => v.total)).toEqual([null, null]);
    expect(none.conversionRates[0]).toMatchObject({ ratePct: null, unavailableReason: "volume_not_measured" });
    expect(none.ourPipesRate).toMatchObject({ actedOn: null, ratePct: null, unavailableReason: "volume_not_measured" });
  });
});
