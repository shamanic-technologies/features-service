import { describe, expect, it } from "vitest";
import { campaignPlanTree, scriptNeedsOf, type PlanTreeNode } from "./campaign-plan-tree.js";
import { seededRng } from "./campaign-engine-scripts.js";
import { outcomeValues, scriptRatings, type ReachGroup } from "./script-value-rating.js";
import { writerSubjectKey, type Strategy, type Tactic } from "./plays.js";
import type { RunnableScript } from "./script-catalogue-client.js";

/**
 * PLAN-RECURSIVE-PER-ENGINE-1124: a campaign's Plan read from its Target down, Engine by Engine, through the real
 * strategy rule (`scriptsKeptByStrategy`) and the real Rating draw (`pickScript`). Fixture shaped on prod, 2026-11-24.
 */
const script = (outcome: string, dynasty: string, materials: string[], tactics: Record<string, unknown> = {}): RunnableScript => ({
  id: `${outcome}-${dynasty}`,
  outcome,
  dynasty,
  version: 1,
  name: `Name of ${dynasty}`,
  description: `Does ${dynasty}`,
  code: "",
  tactics,
  materials,
});
const runnable: RunnableScript[] = [
  script("signup", "dy_signup_path", ["message_sent"]),
  script("signup", "dy_signup_threads_post", ["threads_post_published"]),
  script("threads_post_published", "dy_threads_a", ["llm_completion"]),
  script("threads_post_published", "dy_threads_b", ["llm_completion"]),
  script("threads_post_published", "dy_threads_c", [], { asks: ["llm_completion"] }),
  script("llm_completion", "dy_llm_one", []),
  script("llm_completion", "dy_llm_two", []),
  script("message_sent", "dy_sender", ["message_written"]),
  // A follow-up writer reads the message sent before it: an Engine already on the path, never walked twice.
  script("message_written", "dy_writer", ["llm_completion", "message_sent", "brand_profile"]),
  // Runnable Engines no picked script needs: never in the tree.
  script("lead_found", "dy_finder", []),
  script("email_sent", "dy_email_sender", ["lead_found"]),
];
const OPT_IN = "works-through-a-threads-post";
const tactic: Tactic = { id: OPT_IN, name: "Works through a Threads post", description: "The script works through a Threads post", createdBy: "t", createdAt: "2026-11-21", clientLine: "Works through a Threads post", appliesTo: "script", optIn: true };
const throughThreads: Strategy = { id: "through-threads-posts", name: "Through Threads posts", description: "Signups come from Threads posts", requiresTacticIds: [OPT_IN], excludesTacticIds: [], createdBy: "t", createdAt: "2026-11-21" };
const catalogue = {
  tactics: new Map([[OPT_IN, tactic]]),
  strategies: new Map([[throughThreads.id, throughThreads]]),
  // Every script is judged; only the Threads signup script follows the opt-in tactic.
  tacticsByWriter: new Map(runnable.map((s) => [writerSubjectKey("script", `${s.outcome}/${s.dynasty}`), new Map([[OPT_IN, s.dynasty === "dy_signup_threads_post"]])])),
};
const g = (scriptDynasty: string, runs: number, reached: string[], spentUsd: number): ReachGroup => ({ scriptDynasty, day: "2026-11-23", producedOutcomes: [scriptDynasty.slice(0, scriptDynasty.indexOf("/"))], reachedOutcomes: reached, runs, spentUsd });
const values = outcomeValues({ steps: [], anchor: { outcome: "paid_client", valueUsd: 2100 }, declared: new Map([["signup", 40]]) });
const fleetRatings = scriptRatings({
  groups: [g("threads_post_published/dy_threads_a", 50, ["signup"], 1), g("threads_post_published/dy_threads_b", 50, [], 1), g("llm_completion/dy_llm_one", 100, [], 0.1), g("llm_completion/dy_llm_two", 100, [], 0.4)],
  values,
});
const labelOf = (o: string) => o.replace(/_/g, " ");
const tree = (stored: Array<{ outcome: string; strategyId: string | null }>, target: string | null = "signup", scripts = runnable) =>
  campaignPlanTree({
    target,
    stored: stored.map((s) => ({ ...s, campaignId: "c1" })),
    runnable: scripts,
    catalogue,
    fleetRatings,
    values,
    labelOf,
    rngOf: (key) => seededRng(`c1|build|${key}`),
  });
const outcomesOf = (nodes: PlanTreeNode[]) => nodes.map((n) => n.outcome);
const node = (nodes: PlanTreeNode[], id: string) => nodes.find((n) => n.id === id)!;

describe("scriptNeedsOf", () => {
  it("is what the code must be handed and what it asks another Engine for, each once", () => {
    expect(scriptNeedsOf({ materials: ["a", "b"], tactics: { asks: ["b", "c"] } })).toEqual(["a", "b", "c"]);
    expect(scriptNeedsOf({ tactics: {} })).toEqual([]);
    expect(scriptNeedsOf({ materials: [], tactics: { asks: "not a list" } })).toEqual([]);
  });
});

describe("campaignPlanTree", () => {
  it("a node carries the most Units the brief allows on its Engine (stored answer), null where none is stated (BRIEF-DAILY-CAP-1125)", () => {
    const input = { target: "signup", stored: [{ outcome: "signup", strategyId: "through-threads-posts", campaignId: "c1" }], runnable, catalogue, fleetRatings, values, labelOf, rngOf: (key: string) => seededRng(`c1|build|${key}`) };
    const capped = campaignPlanTree({ ...input, mostUnits: [{ outcome: "threads_post_published", units: 1, per: "day" }, { outcome: "llm_completion", units: null, per: null }] });
    expect(capped.nodes.map((n) => [n.outcome, n.mostUnits])).toEqual([
      ["signup", null],
      ["threads_post_published", { units: 1, per: "day", days: 1 }],
      ["llm_completion", null],
    ]);
    // No stored answer: every node null, the tree otherwise the same.
    const plain = campaignPlanTree(input);
    expect(plain.nodes.map((n) => n.mostUnits)).toEqual([null, null, null]);
    expect(capped.nodes.map(({ mostUnits: _m, ...n }) => n)).toEqual(plain.nodes.map(({ mostUnits: _m, ...n }) => n));
  });

  it("worked example: a strategy asking for Threads posts walks signup -> threads post -> llm completion, and nothing else", () => {
    const { nodes, unavailableReason } = tree([{ outcome: "signup", strategyId: "through-threads-posts" }]);
    expect(unavailableReason).toBeNull();
    expect(outcomesOf(nodes)).toEqual(["signup", "threads_post_published", "llm_completion"]);
    expect(outcomesOf(nodes)).not.toContain("lead_found");
    expect(outcomesOf(nodes)).not.toContain("email_sent");

    const root = nodes[0]!;
    expect([root.id, root.parentId, root.depth, root.isTarget, root.neededByScript]).toEqual(["signup", null, 0, true, null]);
    expect(root.strategyState).toBe("kept");
    expect(root.strategy?.id).toBe("through-threads-posts");
    expect(root.rules).toEqual([{ kind: "requires", tacticId: OPT_IN, name: "Works through a Threads post", clientLine: "Works through a Threads post" }]);
    expect(root.picked).toBe("signup/dy_signup_threads_post");
    expect(root.scripts.map((s) => [s.script, s.shareOfDrawsPct, s.picked, s.needs])).toEqual([["signup/dy_signup_threads_post", 100, true, ["threads_post_published"]]]);
    expect(root.ruledOut.map((s) => s.script)).toEqual(["signup/dy_signup_path"]);
    expect(root.ruledOut[0]!.reason).toMatch(/requires the tactic "Works through a Threads post"/);
    expect(root.endReason).toBeNull();
    expect(root.needs).toEqual([{ outcome: "threads_post_published", nodeId: "signup>threads_post_published" }]);

    const threads = node(nodes, "signup>threads_post_published");
    expect([threads.parentId, threads.depth, threads.isTarget, threads.neededByScript]).toEqual(["signup", 1, false, "signup/dy_signup_threads_post"]);
    expect(threads.strategyState).toBe("not_judged_yet");
    expect(threads.scripts).toHaveLength(3);
    expect(threads.scripts.reduce((n, s) => n + s.shareOfDrawsPct, 0)).toBeCloseTo(100, 0);
    expect(threads.scripts.filter((s) => s.picked).map((s) => s.script)).toEqual([threads.picked]);
    expect(threads.scripts[0]!.shareOfDrawsPct).toBe(Math.max(...threads.scripts.map((s) => s.shareOfDrawsPct)));
    // Whichever the Rating picks (one reads it handed, one asks for it): the next Engine is LLM completion.
    expect(threads.needs).toEqual([{ outcome: "llm_completion", nodeId: "signup>threads_post_published>llm_completion" }]);

    const llm = node(nodes, "signup>threads_post_published>llm_completion");
    expect(llm.scripts.map((s) => s.needs)).toEqual([[], []]);
    expect(llm.picked).not.toBeNull();
    expect([llm.endReason, llm.needs]).toEqual(["script_needs_nothing", []]);
  });

  it("no strategy on signup: the opt-in script is ruled out and the tree goes through message sent", () => {
    const { nodes } = tree([]);
    const root = nodes[0]!;
    expect(root.strategyState).toBe("not_judged_yet");
    expect(root.picked).toBe("signup/dy_signup_path");
    expect(root.ruledOut.map((s) => s.script)).toEqual(["signup/dy_signup_threads_post"]);
    expect(root.ruledOut[0]!.reason).toMatch(/whose brief asks for "Works through a Threads post"/);
    expect(outcomesOf(nodes)).toEqual(["signup", "message_sent", "message_written", "llm_completion", "message_sent", "brand_profile"]);
    expect(outcomesOf(nodes)).not.toContain("threads_post_published");
    expect(outcomesOf(nodes)).not.toContain("lead_found");
    expect(outcomesOf(nodes)).not.toContain("email_sent");
  });

  it("a stored no-condition verdict reads no_condition, and still never runs an opt-in script", () => {
    const root = tree([{ outcome: "signup", strategyId: null }]).nodes[0]!;
    expect([root.strategyState, root.strategy, root.picked]).toEqual(["no_condition", null, "signup/dy_signup_path"]);
  });

  it("an Engine already on the path is named and never expanded again; an Engine no script makes says so", () => {
    const { nodes } = tree([]);
    const again = node(nodes, "signup>message_sent>message_written>message_sent");
    expect([again.endReason, again.picked, again.scripts, again.ruledOut, again.needs]).toEqual(["engine_already_on_path", null, [], [], []]);
    const none = node(nodes, "signup>message_sent>message_written>brand_profile");
    expect([none.endReason, none.picked, none.scripts, none.needs, none.drawRule]).toEqual(["no_runnable_script", null, [], [], "no_script"]);
  });

  it("a strategy keeping none of an Engine's scripts ends the branch with its reason, never a guess", () => {
    const onlyPath = runnable.filter((s) => s.dynasty !== "dy_signup_threads_post");
    const { nodes } = tree([{ outcome: "signup", strategyId: "through-threads-posts" }], "signup", onlyPath);
    expect(nodes).toHaveLength(1);
    expect([nodes[0]!.endReason, nodes[0]!.picked, nodes[0]!.scripts]).toEqual(["strategy_keeps_no_script", null, []]);
    expect(nodes[0]!.ruledOut.map((s) => s.script)).toEqual(["signup/dy_signup_path"]);
  });

  it("no Target = no tree, with the reason", () => {
    expect(tree([], null)).toEqual({ nodes: [], unavailableReason: "campaign_states_no_target" });
  });

  it("reads the same on every read of one build (seeded draws), and never serves the Rating's score", () => {
    const a = tree([{ outcome: "signup", strategyId: "through-threads-posts" }]);
    const b = tree([{ outcome: "signup", strategyId: "through-threads-posts" }]);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toMatch(/valuePerDollar|creditUsd|valueUsd|score|costPerRun|spentUsd/);
  });

  it("a stored strategy the catalogue lost fails loud", () => {
    expect(() => tree([{ outcome: "signup", strategyId: "gone" }])).toThrow(/which the catalogue does not hold/);
  });
});
