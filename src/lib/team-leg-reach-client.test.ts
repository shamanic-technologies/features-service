import { describe, expect, it } from "vitest";
import { crmLegStepOf, parseTeamLegReach } from "./team-leg-reach-client.js";

const STEPS = ["conversation", "website_visit", "signup", "form_submission", "meeting_booked", "meeting_attended", "sale"];

describe("team leg reach client (crm-service#102 deployed shape)", () => {
  it("maps our step keys onto crm-service's words; a step it has no word for is null (a named reason, never a 400)", () => {
    expect(crmLegStepOf("form_submitted", STEPS)).toBe("form_submission");
    expect(crmLegStepOf("paid_client", STEPS)).toBe("sale");
    expect(crmLegStepOf("conversation", STEPS)).toBe("conversation");
    expect(crmLegStepOf("booking_call", STEPS)).toBeNull();
  });

  it("parses both ends, dated + undated, with the sources that evidenced them", () => {
    const end = (byDay: Array<[string, number]>, undated: number, sources: Array<[string, number]>) => ({
      people: byDay.reduce((a, [, n]) => a + n, undated),
      undated,
      byDay: byDay.map(([day, people]) => ({ day, people })),
      sources: sources.map(([source, people]) => ({ source, people })),
    });
    const r = parseTeamLegReach({
      available: true,
      reachedFrom: end([["2026-09-01", 3], ["2026-09-02", 1]], 1, [["gohighlevel", 5]]),
      reachedTo: { ...end([["2026-09-03", 2]], 0, [["gohighlevel", 2], ["stripe", 0]]), toBeforeFrom: 1 },
    });
    expect(r).toEqual({
      available: true,
      from: { daily: new Map([["2026-09-01", 3], ["2026-09-02", 1]]), undated: 1 },
      to: { daily: new Map([["2026-09-03", 2]]), undated: 0 },
      fromSources: ["gohighlevel"],
      toSources: ["gohighlevel"],
      toByFromDay: null,
    });
    // crm-service#107: the same TO people filed on their FROM day (cohort).
    const c = parseTeamLegReach({
      available: true,
      reachedFrom: end([["2026-09-01", 3]], 0, [["gohighlevel", 3]]),
      reachedTo: { ...end([["2026-09-03", 2]], 0, [["gohighlevel", 2]]), toBeforeFrom: 0, byFromDay: [{ day: "2026-09-01", people: 2 }], undatedFrom: 0 },
    });
    expect(c.available && c.toByFromDay).toEqual({ daily: new Map([["2026-09-01", 2]]), undated: 0 });
    expect(() => parseTeamLegReach({ available: true, reachedFrom: end([], 0, []), reachedTo: { ...end([], 0, []), byFromDay: "x" } })).toThrow(/byFromDay/);
  });

  it("serves the producer's reason when it cannot answer; a malformed body fails loud", () => {
    expect(parseTeamLegReach({ available: false, reason: "from_step_not_recorded" })).toEqual({ available: false, reason: "from_step_not_recorded" });
    expect(() => parseTeamLegReach({ available: true })).toThrow(/malformed reachedFrom/);
    expect(() => parseTeamLegReach({})).toThrow(/no `available`/);
  });
});
