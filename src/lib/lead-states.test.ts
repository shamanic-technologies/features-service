import { describe, expect, it } from "vitest";
import { CHANNEL_STEPS } from "./acquisition-channels.js";
import { leadStateFamilyOf, leadStateOf, leadStateRankOf, NEW_LEAD_STATE_STEPS } from "./lead-states.js";

describe("lead states (LEAD-STATES-1024)", () => {
  it("a yes is interest, a click is a visit, never the other", () => {
    expect(leadStateOf("conversation")).toBe("lead_interested");
    expect(leadStateOf("form_submitted")).toBe("lead_interested");
    expect(leadStateOf("website_visit")).toBe("lead_visited");
    expect(leadStateFamilyOf(leadStateOf("conversation"))).toBe("interest");
    expect(leadStateFamilyOf(leadStateOf("website_visit"))).toBe("visit");
  });

  it("the interest ladder ranks interested < booked < attended < paid; Lead found reaches no state", () => {
    expect(["conversation", "meeting_booked", "meeting_attended", "paid_client"].map((k) => leadStateRankOf(leadStateOf(k)))).toEqual([1, 2, 3, 4]);
    expect(leadStateOf("lead_found")).toBeNull();
    expect(leadStateOf("some_declared_step")).toBeNull();
  });

  it("the two new states are steps of their own and reach themselves; no coded step is shadowed", () => {
    expect(NEW_LEAD_STATE_STEPS.map((s) => s.key)).toEqual(["lead_interested", "lead_visited"]);
    for (const s of NEW_LEAD_STATE_STEPS) {
      expect(leadStateOf(s.key)).toBe(s.key);
      expect(Object.hasOwn(CHANNEL_STEPS, s.key)).toBe(false);
    }
  });
});
