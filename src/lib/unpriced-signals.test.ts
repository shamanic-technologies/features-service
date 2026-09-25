import { describe, it, expect } from "vitest";
import { dedupPersonsByLead, type EnginePerson } from "./revenue-engine.js";

const person = (over: Partial<EnginePerson>): EnginePerson => ({
  leadId: "l1",
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
  signals: {},
  ...over,
});

/**
 * A lead served under two campaigns is ONE person. A rung it reached stays unpriced only when NO row
 * priced it: one row saying the meeting was ours is enough, the same way one row reaching a rung is.
 */
describe("a rung that was not our win survives the per-lead merge correctly", () => {
  it("stays unpriced when every row that reached it left it unpriced", () => {
    const [merged] = dedupPersonsByLead([
      person({ signals: { meeting: true }, unpricedSignals: ["meeting"] }),
      person({ signals: { meeting: true }, unpricedSignals: ["meeting"] }),
    ]);
    expect(merged.signals.meeting).toBe(true);
    expect(merged.unpricedSignals).toEqual(["meeting"]);
  });

  it("is priced as soon as ONE row reached it as ours", () => {
    const [merged] = dedupPersonsByLead([
      person({ signals: { meeting: true }, unpricedSignals: ["meeting"] }),
      person({ signals: { meeting: true } }),
    ]);
    expect(merged.unpricedSignals).toBeUndefined();
  });

  it("does not let a row that never reached the rung price it", () => {
    const [merged] = dedupPersonsByLead([
      person({ signals: { clicked: true } }),
      person({ signals: { meeting: true }, unpricedSignals: ["meeting"] }),
    ]);
    expect(merged.signals.meeting).toBe(true);
    expect(merged.unpricedSignals).toEqual(["meeting"]);
  });
});
