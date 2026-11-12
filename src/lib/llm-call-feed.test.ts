import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const { copyRowOf, costNameIndex, unitsByOutcome, workflowOutcomeResolver, outcomeOfScriptSlug } = await import("./llm-call-feed.js");
const { evidenceFromAggregates } = await import("./engine-llm-rating-io.js");
const { llmEvidence } = await import("./engine-llm-rating.js");

const dynastyOf = costNameIndex({
  costNames: [
    { costName: "anthropic-fable-5.1-tokens-output", dynasty: "claude-fable" },
    { costName: "anthropic-fable-5.1-tokens-input", dynasty: "claude-fable" },
    { costName: "zai-glm-5.3-tokens-output", dynasty: "glm" },
    { costName: "zai-glm-5.3-flash-tokens-output", dynasty: "glm-flash" },
  ],
});
const wf = workflowOutcomeResolver(
  [
    { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", workflowDynastySlug: "sales-cold-email-outreach-ballad", state: "deprecated" },
    { featureSlug: "threads-post", legKey: "start_to_threads_post_published", workflowDynastySlug: "threads-post-maasym", state: "active" },
  ],
  (f) => (f === "threads-post" ? "threads_post_published" : "conversation"),
);

describe("copy filing", () => {
  it("looks cost names up exactly (a prefix never matches)", () => {
    expect(dynastyOf("zai-glm-5.3-flash-tokens-output")).toBe("glm-flash");
    expect(dynastyOf("zai-glm-5.3-tokens-output")).toBe("glm");
    expect(dynastyOf("typesafe-jev-decisions")).toBeNull();
  });

  it("files a script call under its script's Engine, a workflow-era call under its workflow's pipe outcome", () => {
    const base = { rootRunId: "root", decisionRunId: "dec", parentRunId: "dec", supportFunction: null, startedAt: "2026-11-08T10:00:00Z" };
    const script = copyRowOf(
      { ...base, runId: "c1", scriptSlug: "x_post_published/dy_x_post/v3", workflowSlug: null, costs: [{ costName: "anthropic-fable-5.1-tokens-input", status: "actual", totalCostInUsdCents: "0.5" }, { costName: "anthropic-fable-5.1-tokens-output", status: "actual", totalCostInUsdCents: "6.5" }] },
      dynastyOf,
      wf,
    )!;
    expect(script).toMatchObject({ outcome: "x_post_published", llmDynastySlug: "claude-fable", decisionRunId: "dec", spentUsd: "0.07" });
    const old = copyRowOf({ ...base, runId: "c2", scriptSlug: null, workflowSlug: "sales-cold-email-outreach-ballad-v3", costs: [{ costName: "zai-glm-5.3-tokens-output", status: "actual", totalCostInUsdCents: "1" }] }, dynastyOf, wf)!;
    expect(old.outcome).toBe("conversation");
    expect(copyRowOf({ ...base, runId: "c3", scriptSlug: null, workflowSlug: null, costs: [{ costName: "typesafe-jev-decisions", status: "actual", totalCostInUsdCents: "1" }] }, dynastyOf, wf)).toBeNull();
    // A released hold is no spend.
    const held = copyRowOf({ ...base, runId: "c4", scriptSlug: "x_post_published/dy_x_post/v3", workflowSlug: null, costs: [{ costName: "anthropic-fable-5.1-tokens-output", status: "cancelled", totalCostInUsdCents: "9" }] }, dynastyOf, wf)!;
    expect(held.spentUsd).toBe("0");
    expect(outcomeOfScriptSlug("conversation/dy_follow_up_due/v2")).toBe("conversation");
  });

  it("sums a decision's Units per outcome, own and downstream", () => {
    expect(unitsByOutcome([{ outcomeKey: "x_post_published", quantity: "1" }, { outcomeKey: "website_visit", quantity: "2" }, { outcomeKey: "website_visit", quantity: "1" }])).toEqual({ x_post_published: 1, website_visit: 3 });
  });
});

describe("evidenceFromAggregates", () => {
  it("is the evidence llmEvidence builds from the same calls (history seeding through the copy)", () => {
    const calls = [
      { callRunId: "a", rootRunId: "d1", day: "2026-11-07", outcome: "x_post_published", llmDynastySlug: "claude-fable", spentUsd: 0.07, support: false },
      { callRunId: "b", rootRunId: "d1", day: "2026-11-08", outcome: "x_post_published", llmDynastySlug: "claude-fable", spentUsd: 0.01, support: false },
      { callRunId: "c", rootRunId: "d2", day: "2026-11-08", outcome: "x_post_published", llmDynastySlug: "claude-fable", spentUsd: 0.07, support: false },
    ];
    const direct = llmEvidence(calls, (root) => (root === "d1" ? 1 : 0), []).get("x_post_published|claude-fable")!;
    const [agg] = evidenceFromAggregates(
      [
        { outcome: "x_post_published", llmDynastySlug: "claude-fable", place: null, day: "2026-11-07", decisions: 1, successes: 1, outcomes: 1 },
        { outcome: "x_post_published", llmDynastySlug: "claude-fable", place: null, day: "2026-11-08", decisions: 1, successes: 0, outcomes: 0 },
      ],
      [
        { outcome: "x_post_published", llmDynastySlug: "claude-fable", place: null, day: "2026-11-07", calls: 1, spentUsd: 0.07 },
        { outcome: "x_post_published", llmDynastySlug: "claude-fable", place: null, day: "2026-11-08", calls: 2, spentUsd: 0.08 },
      ],
    );
    expect(agg!.days.map((d) => ({ ...d, spentUsd: Math.round(d.spentUsd * 100) }))).toEqual(direct.days.map((d) => ({ ...d, spentUsd: Math.round(d.spentUsd * 100) })));
    expect([agg!.firstCallDay, agg!.lastCallDay]).toEqual([direct.firstCallDay, direct.lastCallDay]);
  });
});
