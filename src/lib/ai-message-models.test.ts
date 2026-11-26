import { describe, expect, it } from "vitest";
import { fleetOf, tallySends } from "./ai-message-models.js";

const catalogue = new Map([
  ["zai-glm-5.3-flash-tokens-input", ["glm-5.3-flash"]],
  ["anthropic-opus-5.5-tokens-output", ["claude-opus-5-5"]],
]);
const line = (costName: string, at: string, status = "actual") => ({ costName, status, createdAt: at });

describe("tallySends (MODEL-TAG-EVERY-AI-MESSAGE-1126)", () => {
  it("counts each send once (a send that consumed no writing is not an AI message), names the model billed last in its writing run, and names why when it cannot", () => {
    const rows = tallySends({
      sends: [
        { runId: "s1", orgId: "o1" },
        { runId: "s2", orgId: "o1" },
        { runId: "s3", orgId: "o2" },
        { runId: "s4", orgId: "o2" },
        { runId: "s5", orgId: null },
      ],
      writersOfSendRun: new Map([
        ["s1", ["w1"]],
        ["s2", ["w2"]],
        ["s3", ["w3", "w4"]],
        ["s5", ["w5"]],
      ]),
      linesOfWriter: new Map([
        ["w1", [line("zai-glm-5.3-flash-tokens-input", "2026-11-24T02:38:33Z"), line("anthropic-opus-5.5-tokens-output", "2026-11-24T02:38:20Z", "cancelled")]],
        ["w2", [line("treg-micro-usd", "2026-11-24T02:38:33Z")]],
        ["w5", null],
      ]),
      catalogue,
    });
    expect(rows).toEqual([
      { orgId: "", sentNotWrittenByOurRuns: 0, messages: 1, withModel: 0, withoutModel: 1, withoutByReason: { writing_run_unreadable: 1 }, byModel: {} },
      { orgId: "o1", sentNotWrittenByOurRuns: 0, messages: 2, withModel: 1, withoutModel: 1, withoutByReason: { no_llm_billed: 1 }, byModel: { "glm-5.3-flash": 1 } },
      { orgId: "o2", sentNotWrittenByOurRuns: 1, messages: 1, withModel: 0, withoutModel: 1, withoutByReason: { several_writings_in_ledger: 1 }, byModel: {} },
    ]);
    expect(fleetOf(rows)).toEqual({
      sentNotWrittenByOurRuns: 1,
      messages: 4,
      withModel: 1,
      withoutModel: 3,
      withoutByReason: { writing_run_unreadable: 1, no_llm_billed: 1, several_writings_in_ledger: 1 },
      byModel: { "glm-5.3-flash": 1 },
    });
  });

  it("a catalogue that cannot be read names that reason, never a model", () => {
    const [row] = tallySends({ sends: [{ runId: "s1", orgId: "o" }], writersOfSendRun: new Map([["s1", ["w1"]]]), linesOfWriter: new Map([["w1", []]]), catalogue: null });
    expect(row.withoutByReason).toEqual({ llm_cost_names_unreadable: 1 });
  });
});
