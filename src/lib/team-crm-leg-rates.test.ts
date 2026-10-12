import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { teamCrmRateOf } from "./team-crm-leg-rates.js";

const end = (daily: Record<string, number>, undated = 0) => ({ daily: new Map(Object.entries(daily)), undated });

describe("a team leg's historical rate from the brand's tools", () => {
  it("divides the people who reached TO (cohort when served) by those who reached FROM, undated included", () => {
    const r = teamCrmRateOf({ available: true, from: end({ "2026-01-01": 300 }, 13), to: end({ "2026-02-01": 20 }), toByFromDay: end({ "2026-01-01": 12 }, 1), fromSources: ["gohighlevel"], toSources: ["gohighlevel"] });
    expect(r).toEqual({ ratePct: (100 * 13) / 313, fromPeople: 313, toPeople: 13 });
  });

  it("reads the own-day count when the cohort is not served", () => {
    expect(teamCrmRateOf({ available: true, from: end({ d: 40 }), to: end({ d: 4 }), toByFromDay: null, fromSources: [], toSources: [] })?.ratePct).toBe(10);
  });

  it("states no rate below the measured bar or when crm-service cannot answer", () => {
    expect(teamCrmRateOf({ available: true, from: end({ d: 9 }), to: end({ d: 9 }), toByFromDay: null, fromSources: [], toSources: [] })).toBeNull();
    expect(teamCrmRateOf({ available: false, reason: "step_not_in_crm_vocabulary" })).toBeNull();
  });
});
