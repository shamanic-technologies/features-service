import { describe, it, expect, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { shouldWriteAnswer } from "./engine-answers-store.js";

describe("shouldWriteAnswer (NEXT-STEPS-TRUE-REASON-1111)", () => {
  it("writes a first answer and every change at once, an unchanged one at most once a minute", () => {
    expect(shouldWriteAnswer(undefined, "campaign_states_no_brief", 0)).toBe(true);
    expect(shouldWriteAnswer({ heldReason: "campaign_states_no_brief", at: 0 }, "campaign_states_no_brief", 30_000)).toBe(false);
    expect(shouldWriteAnswer({ heldReason: "campaign_states_no_brief", at: 0 }, null, 1_000)).toBe(true);
    expect(shouldWriteAnswer({ heldReason: null, at: 0 }, "no_runnable_script_kept", 1_000)).toBe(true);
    expect(shouldWriteAnswer({ heldReason: null, at: 0 }, null, 60_000)).toBe(true);
  });
});
