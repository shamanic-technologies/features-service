import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const { withEngineLlmUniverse } = await import("./leg-writer-ranking.js");

describe("withEngineLlmUniverse (LLM-RATING-PER-ENGINE-1112)", () => {
  it("never leaves an LLM outside the Engine's universe selectable on the legacy per-pipe read", () => {
    const cand = (slug: string) => ({ key: slug, label: slug, selectable: true, notSelectableReason: null, llmDynastySlug: slug }) as never;
    const p = { llms: { candidates: [cand("claude-fable"), cand("claude-opus"), cand("deepseek-flash")], unavailableReason: null } } as never;
    const out = withEngineLlmUniverse(p, new Set(["deepseek-flash", "claude-sonnet"])) as unknown as { llms: { candidates: Array<{ key: string; selectable: boolean; notSelectableReason: string | null }> } };
    expect(out.llms.candidates.map((c) => [c.key, c.selectable, c.notSelectableReason])).toEqual([
      ["claude-fable", false, "not_in_engine_universe"],
      ["claude-opus", false, "not_in_engine_universe"],
      ["deepseek-flash", true, null],
    ]);
  });
});
