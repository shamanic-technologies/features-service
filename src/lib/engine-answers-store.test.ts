import { describe, it, expect, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { nextStreak, shouldWriteAnswer, SAME_RUN_PASS_MS, type AnswerStreak } from "./engine-answers-store.js";

describe("shouldWriteAnswer (NEXT-STEPS-TRUE-REASON-1111)", () => {
  it("writes a first answer and every change at once, an unchanged one at most once a minute", () => {
    expect(shouldWriteAnswer(undefined, "campaign_states_no_brief", 0)).toBe(true);
    expect(shouldWriteAnswer({ heldReason: "campaign_states_no_brief", at: 0 }, "campaign_states_no_brief", 30_000)).toBe(false);
    expect(shouldWriteAnswer({ heldReason: "campaign_states_no_brief", at: 0 }, null, 1_000)).toBe(true);
    expect(shouldWriteAnswer({ heldReason: null, at: 0 }, "no_runnable_script_kept", 1_000)).toBe(true);
    expect(shouldWriteAnswer({ heldReason: null, at: 0 }, null, 60_000)).toBe(true);
  });
});

describe("nextStreak (DOC-DINNERS-SENDS-1119)", () => {
  const t = (iso: string) => new Date(iso);
  const run = (answers: Array<[string | null, string]>): AnswerStreak | null =>
    answers.reduce<AnswerStreak | null>((prev, [reason, at]) => nextStreak(prev, reason, t(at)), null);

  it("keeps the streak across the passes the SAME run states seconds before its refusal (prod: dispatch, strategy, gate)", () => {
    // Doc Dinners 2026-11-10..19: every 30 min, "ran" at dispatch, the strategy pass, then "Insufficient credits" 8 s later.
    const ticks: Array<[string | null, string]> = [["Insufficient credits", "2026-11-10T17:44:45Z"]];
    for (const at of ["2026-11-10T18:14:37Z", "2026-11-19T07:00:03Z"]) {
      ticks.push([null, at], [null, new Date(t(at).getTime() + 1_000).toISOString()], ["Insufficient credits", new Date(t(at).getTime() + 8_000).toISOString()]);
    }
    const s = run(ticks)!;
    expect(s.heldReason).toBe("Insufficient credits");
    expect(s.firstHeldAt?.toISOString()).toBe("2026-11-10T17:44:45.000Z");
  });

  it("starts a new streak once the Engine passed longer than a run's span, or for another reason", () => {
    const recovered = run([
      ["Insufficient credits", "2026-11-10T17:44:45Z"],
      [null, "2026-11-12T09:00:00Z"],
      ["Insufficient credits", new Date(t("2026-11-12T09:00:00Z").getTime() + SAME_RUN_PASS_MS).toISOString()],
    ])!;
    expect(recovered.firstHeldAt?.toISOString()).toBe("2026-11-12T09:02:00.000Z");
    const other = run([
      ["Insufficient credits", "2026-11-10T17:44:45Z"],
      ["no_runnable_script_kept", "2026-11-10T18:00:00Z"],
    ])!;
    expect(other.firstHeldAt?.toISOString()).toBe("2026-11-10T18:00:00.000Z");
  });

  it("a pass that keeps passing keeps its start, so a long run of passes is never mistaken for the same run", () => {
    const s = run([
      ["Insufficient credits", "2026-11-10T17:44:45Z"],
      [null, "2026-11-12T09:00:00Z"],
      [null, "2026-11-12T11:00:00Z"],
      ["Insufficient credits", "2026-11-12T11:00:05Z"],
    ])!;
    expect(s.firstHeldAt?.toISOString()).toBe("2026-11-12T11:00:05.000Z");
  });

  it("a refusal repeated while held keeps its start (unchanged behaviour)", () => {
    const s = run([
      ["campaign_states_no_brief", "2026-11-11T08:00:00Z"],
      ["campaign_states_no_brief", "2026-11-11T09:40:00Z"],
    ])!;
    expect(s.firstHeldAt?.toISOString()).toBe("2026-11-11T08:00:00.000Z");
  });
});
