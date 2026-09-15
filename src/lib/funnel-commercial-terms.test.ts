import { describe, expect, it } from "vitest";
import { FUNNEL_MINIMUM_COMMITMENT_DAYS, minimumCommitmentDaysFor } from "./funnel-commercial-terms.js";
import { SALES_FUNNEL_KEYS } from "./sales-funnels.js";

describe("per-funnel minimum commitment", () => {
  it("carries ONE entry per declared funnel — a missing key is a corrupt map, never a default", () => {
    expect(Object.keys(FUNNEL_MINIMUM_COMMITMENT_DAYS).sort()).toEqual([...SALES_FUNNEL_KEYS].sort());
  });

  it("every value is either null (no commitment) or a whole number of days > 0", () => {
    for (const key of SALES_FUNNEL_KEYS) {
      const value = FUNNEL_MINIMUM_COMMITMENT_DAYS[key];
      expect(value === null || (Number.isInteger(value) && value > 0), key).toBe(true);
    }
  });

  it("MOST funnels carry none — null is the default state, not a gap", () => {
    const committed = SALES_FUNNEL_KEYS.filter((k) => FUNNEL_MINIMUM_COMMITMENT_DAYS[k] !== null);
    expect(committed.length).toBeLessThan(SALES_FUNNEL_KEYS.length);
  });

  it("the example funnel carries a real commitment the dashboard can render", () => {
    expect(minimumCommitmentDaysFor("sales_meetings_from_conversation")).toBe(30);
    expect(minimumCommitmentDaysFor("sales_meetings_from_website")).toBeNull();
    expect(minimumCommitmentDaysFor("website_purchases")).toBeNull();
    expect(minimumCommitmentDaysFor("form_magnet")).toBeNull();
  });
});
