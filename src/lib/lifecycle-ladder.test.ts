import { describe, expect, it } from "vitest";
import { CHANNEL_STEP_KEYS } from "./acquisition-channels.js";
import { CODED_STEP_LIFECYCLE_RUNGS, LIFECYCLE_RUNGS, isStepLifecycleRung, lifecycleRankOf } from "./lifecycle-ladder.js";

describe("lifecycle ladder (owner 2026-10-17)", () => {
  it("is the owner's ladder, lowest rung first", () => {
    expect(LIFECYCLE_RUNGS.map((r) => r.label)).toEqual(["Lead found", "Contacted", "Engaged", "Signed up", "Meeting booked", "Meeting attended", "Paid client"]);
    expect(LIFECYCLE_RUNGS.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("every coded step states a rung (or none)", () => {
    for (const key of CHANNEL_STEP_KEYS) expect(isStepLifecycleRung(CODED_STEP_LIFECYCLE_RUNGS[key])).toBe(true);
  });

  it("engaged groups the interest signals; signup and form share a rung", () => {
    expect(CODED_STEP_LIFECYCLE_RUNGS.conversation).toBe("engaged");
    expect(CODED_STEP_LIFECYCLE_RUNGS.website_visit).toBe("engaged");
    expect(CODED_STEP_LIFECYCLE_RUNGS.signup).toBe(CODED_STEP_LIFECYCLE_RUNGS.form_submitted);
    expect(lifecycleRankOf(CODED_STEP_LIFECYCLE_RUNGS.lead_found)).toBeLessThan(lifecycleRankOf("contacted")!);
    expect(lifecycleRankOf(CODED_STEP_LIFECYCLE_RUNGS.signup)!).toBeLessThan(lifecycleRankOf(CODED_STEP_LIFECYCLE_RUNGS.meeting_booked)!);
    expect(lifecycleRankOf(CODED_STEP_LIFECYCLE_RUNGS.meeting_attended)!).toBeLessThan(lifecycleRankOf(CODED_STEP_LIFECYCLE_RUNGS.paid_client)!);
    expect(lifecycleRankOf("none")).toBeNull();
    expect(lifecycleRankOf(null)).toBeNull();
  });
});
