import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHANNEL_STEP_KEYS } from "./acquisition-channels.js";
import { NEW_LEAD_STATE_STEPS } from "./lead-states.js";
import { LIFECYCLE_RUNGS, isStepLifecycleRung, lifecycleRankOf } from "./lifecycle-ladder.js";
import { seededOutcomeRungs } from "./outcome-rungs-seed.js";

const seeded = seededOutcomeRungs(readFileSync(new URL("../../drizzle/0061_outcome_lifecycle_rungs.sql", import.meta.url), "utf8"));
const rungOf = (k: string) => seeded.get(k) as Parameters<typeof lifecycleRankOf>[0];

describe("lifecycle ladder (owner 2026-10-17)", () => {
  it("is the owner's ladder, lowest rung first", () => {
    expect(LIFECYCLE_RUNGS.map((r) => r.label)).toEqual(["Lead found", "Contacted", "Engaged", "Signed up", "Meeting booked", "Meeting attended", "Paid client"]);
    expect(LIFECYCLE_RUNGS.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("OUTCOME-RUNG-AND-TARGET-1106: every coded step and lead state has its row in the outcome rung catalogue (migration 0061)", () => {
    for (const key of [...CHANNEL_STEP_KEYS, ...NEW_LEAD_STATE_STEPS.map((s) => s.key)]) expect(isStepLifecycleRung(seeded.get(key)), key).toBe(true);
  });

  it("engaged groups the interest signals; signup and form share a rung", () => {
    expect(rungOf("conversation")).toBe("engaged");
    expect(rungOf("website_visit")).toBe("engaged");
    expect(rungOf("signup")).toBe(rungOf("form_submitted"));
    expect(lifecycleRankOf(rungOf("lead_found"))).toBeLessThan(lifecycleRankOf("contacted")!);
    expect(lifecycleRankOf(rungOf("signup"))!).toBeLessThan(lifecycleRankOf(rungOf("meeting_booked"))!);
    expect(lifecycleRankOf(rungOf("meeting_attended"))!).toBeLessThan(lifecycleRankOf(rungOf("paid_client"))!);
    expect(lifecycleRankOf("none")).toBeNull();
    expect(lifecycleRankOf(null)).toBeNull();
  });

  it("no rung map is left in code: the ladder module exports the ladder only", async () => {
    const mod = (await import("./lifecycle-ladder.js")) as Record<string, unknown>;
    expect(Object.keys(mod).filter((k) => /CODED|coded/.test(k))).toEqual([]);
  });
});
