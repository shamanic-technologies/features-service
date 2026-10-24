import { describe, expect, it, vi } from "vitest";
vi.mock("../../db/index.js", () => ({ db: {}, sql: {} }));
import type { SlugCell } from "./buckets.js";
import { candidatePartsOf, deprecatedPartsOf, inFlashOrder, pipePerformance, servedNowOf, type PipePerformanceInput } from "./performance.js";
import { templateDynastyIndex } from "./template-dynasties.js";
import { llmDynastyIndex } from "../llm-dynasties.js";
import type { FleetPersonBucket } from "../fleet-positive-repliers.js";
import type { ResearchBucket } from "./studies.js";

// RESEARCH-PERFORMANCE-1023: one row per (workflow, template version, LLM) that sent the pipe's emails; rows partition the
// pipe, the last point of each series is its card.

const half = (months: Record<string, [number, number, number]>) => {
  const figures = { spentUsd: 0, contacted: 0, outcomes: 0 };
  const m: Record<string, { spentUsd: number; contacted: number; outcomes: number }> = {};
  for (const [k, [s, c, o]] of Object.entries(months)) {
    m[k] = { spentUsd: s, contacted: c, outcomes: o };
    figures.spentUsd += s;
    figures.contacted += c;
    figures.outcomes += o;
  }
  return { figures, months: m, strata: {} };
};
const pb = (slug: string, day: string, model: string | null, promptType: string | null, contacted: number, replies: number): FleetPersonBucket => ({
  orgId: "o1",
  brandId: "b1",
  campaignId: "c1",
  country: null,
  workflowSlug: slug,
  servedDay: day,
  contacted,
  clicked: 0,
  positiveReplies: replies,
  screenedContacted: 0,
  humanClicked: 0,
  generation: model ? { model, promptType, layout: null, opening: null, dash: null } : null,
});

const cells: SlugCell[] = [
  // azalea v1: $300 on 300 people, 6 replies (Aug + Sep)
  { slug: "azalea-v1", flash: half({ "2026-08": [100, 100, 2], "2026-09": [200, 200, 4] }), mature: half({ "2026-08": [100, 100, 2], "2026-09": [200, 200, 4] }) },
  // azalea v2: $100 on 100 people, 0 replies
  { slug: "azalea-v2", flash: half({ "2026-09": [100, 100, 0] }), mature: half({ "2026-09": [100, 100, 0] }) },
  // keel v1: $50, nobody in the person cell (kept whole on a not-on-record row)
  { slug: "keel-v1", flash: half({ "2026-10": [50, 0, 0] }), mature: null },
];
const persons: FleetPersonBucket[] = [
  pb("azalea-v1", "2026-08-10", "gemini-3.7-flash", "cold-email-v35", 100, 2),
  pb("azalea-v1", "2026-09-10", "claude-opus-5-5", "cold-email-v36", 100, 4),
  // not on record: the version's definition writes with v35 + Gemini 3.7 Flash
  pb("azalea-v1", "2026-09-12", null, null, 100, 0),
  pb("azalea-v2", "2026-09-20", "gemini-3.8-flash", "cold-email-v36", 100, 0),
];

const tpl = templateDynastyIndex([
  { slug: "aurora", name: "Aurora", description: "", signature: null, identity: "", head: "cold-email-v35", versions: ["cold-email-v35"], status: "active", statusSource: "content_generation", versionStatuses: {} },
  { slug: "borealis", name: "Borealis", description: "", signature: null, identity: "", head: "cold-email-v36", versions: ["cold-email-v36"], status: "active", statusSource: "content_generation", versionStatuses: {} },
]);
const llm = llmDynastyIndex([
  { slug: "gemini-flash", name: "Gemini Flash", provider: "google", capabilityTier: "cheap", headModelId: "gemini-3.8-flash", servedToday: true, models: [{ modelId: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", servedToday: true }, { modelId: "gemini-3.7-flash", displayName: "Gemini 3.7 Flash", servedToday: false }], legacyAliases: [] },
  { slug: "claude-opus", name: "Claude Opus", provider: "anthropic", capabilityTier: "frontier", headModelId: "claude-opus-5-5", servedToday: true, models: [{ modelId: "claude-opus-5-5", displayName: "Claude Opus 5.5", servedToday: true }], legacyAliases: [] },
]);

const bar = (key: string, basis: "mature" | "flash", spentUsd: number, contacted: number, outcomes: number): ResearchBucket => ({ key, label: key, basis, figures: { spentUsd, contacted, outcomes }, learning: basis === "flash", months: null, strata: null });
// The Workflows tab: azalea read on its flash evidence, keel on its $50
const BARS = [bar("azalea", "flash", 400, 400, 6), bar("keel", "flash", 50, 0, 0)];

const input = (over: Partial<PipePerformanceInput> = {}): PipePerformanceInput => ({
  pipe: "cold-email-positive-reply",
  noun: "positive reply",
  nounPlural: "positive replies",
  legKey: "start_to_conversation",
  cells,
  persons,
  split: { screened: false, signal: "positiveReply", cutoffDay: "2026-10-02" },
  bars: BARS,
  dynastyOf: (s) => s.replace(/-v\d+$/, ""),
  workflowLabelOf: (d) => d[0]!.toUpperCase() + d.slice(1),
  workflowNameOf: (d) => `Sales Cold Email Outreach ${d}`,
  writerOfVersion: (slug) => (slug === "azalea-v1" ? { template: "cold-email-v35", model: "gemini-3.7-flash" } : null),
  templateDynasties: tpl,
  llmDynasties: llm,
  llmKeyOf: (id) => llm.dynastyOfName(id)?.slug ?? id,
  llmLabelOf: (k) => llm.bySlug(k)?.name ?? k,
  // azalea: $1,200 pipeline on $400 billed (3x); keel: $0 on $50
  workflowReturns: { roiOf: new Map([["azalea", 3], ["keel", 0]]), moneyGoesHere: "azalea", pipelineOf: new Map([["azalea", 1200], ["keel", 0]]), billedOf: new Map([["azalea", 400], ["keel", 50]]) },
  unpricedBilledUsd: 0,
  now: new Date("2026-10-23T12:00:00Z"),
  ...over,
});

describe("pipePerformance (RESEARCH-PERFORMANCE-1023)", () => {
  const out = pipePerformance(input());
  const sum = (f: (r: (typeof out.rows)[number]) => number, rows = out.rows) => rows.reduce((a, r) => a + f(r), 0);
  const row = (key: string) => out.rows.find((r) => r.key === key)!;

  it("one row per workflow x template DYNASTY x LLM dynasty; rows partition the pipe", () => {
    expect(out.rows.map((r) => r.key).sort()).toEqual(["azalea|aurora|gemini-flash", "azalea|borealis|claude-opus", "azalea|borealis|gemini-flash", "keel|-|-"]);
    expect(sum((r) => r.spentUsd.value)).toBeCloseTo(450, 9);
    expect(sum((r) => r.outcomes.value)).toBeCloseTo(6, 9);
    expect(out.totals!.spentUsd.value).toBeCloseTo(sum((r) => r.spentUsd.value), 9);
    expect(out.totals!.outcomes.value).toBeCloseTo(sum((r) => r.outcomes.value), 9);
  });

  it("ONE figure per pipe: each workflow's rows add up to its Workflows-tab bar, mature bars included", () => {
    const mature = pipePerformance(input({ bars: [bar("azalea", "mature", 300, 380, 5), bar("keel", "flash", 50, 0, 0)] }));
    const az = mature.rows.filter((r) => r.workflow.key === "azalea");
    expect(sum((r) => r.spentUsd.value, az)).toBeCloseTo(300, 9);
    expect(sum((r) => r.contacted.value, az)).toBeCloseTo(380, 9);
    expect(sum((r) => r.outcomes.value, az)).toBeCloseTo(5, 9);
    expect(mature.totals!.spentUsd.value).toBeCloseTo(350, 9);
    expect(mature.series!.points.at(-1)!.spentUsd).toBe(mature.totals!.spentUsd.value);
    // a workflow the Workflows tab does not list is not counted either
    const only = pipePerformance(input({ bars: [bar("azalea", "flash", 400, 400, 6)] }));
    expect(only.rows.some((r) => r.workflow.key === "keel")).toBe(false);
  });

  it("names each part the way the catalogue does: template = the dynasty page", () => {
    const opus = row("azalea|borealis|claude-opus");
    expect(opus.workflow).toEqual({ key: "azalea", label: "Azalea", name: "Sales Cold Email Outreach azalea" });
    expect(opus.template).toEqual({ key: "borealis", label: "Borealis", dynasty: { key: "borealis", label: "Borealis" }, standaloneReason: null });
    expect(opus.llm).toEqual({ key: "claude-opus", label: "Claude Opus", provider: "anthropic" });
    expect(opus.writerSource).toBe("sequences");
  });

  it("a person not on record takes the writer of the version that served them; not_on_record only when that fails too", () => {
    // the null-generation person (100 people, v1) joins aurora + gemini through the version's definition
    expect(row("azalea|aurora|gemini-flash").contacted.value).toBeCloseTo(200, 9);
    const none = row("keel|-|-");
    expect(none.template).toBeNull();
    expect(none.writerSource).toBeNull();
    expect(none.writerUnavailableReason).toBe("not_on_record");
    const dagOnly = pipePerformance(input({ persons: persons.filter((p) => p.generation === null || p.workflowSlug === "azalea-v2") }));
    expect(dagOnly.rows.find((r) => r.key === "azalea|aurora|gemini-flash")!.writerSource).toBe("workflow_definition");
  });

  it("ROI: own outcomes' pipeline over own billed", () => {
    // 4 of azalea's 6 outcomes = $800 pipeline; $100 of azalea's $400 = $100 billed: 8x
    expect(row("azalea|borealis|claude-opus").roi).toMatchObject({ value: 8, basis: "measured", source: "own" });
    expect(row("azalea|borealis|claude-opus").costPerOutcomeUsd).toMatchObject({ value: 25, basis: "measured" });
  });

  it("rows stand on the figure the table shows: cost per outcome ascending, else $ spent (PERF-COST-ORDER-1024)", () => {
    expect(out.rowOrder).toBe("cost_per_outcome");
    expect(out.orderView).toBe("flash");
    expect(out.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    // opus $25 per reply; keel spent $50 with no reply; aurora x gemini $200 / 2 replies = $100; borealis x gemini spent
    // $100 with no reply: the same $100, the tie on the key
    expect(out.rows.map((r) => [r.key, r.sortCostUsd])).toEqual([
      ["azalea|borealis|claude-opus", 25],
      ["keel|-|-", 50],
      ["azalea|aurora|gemini-flash", 100],
      ["azalea|borealis|gemini-flash", 100],
    ]);
    for (const r of out.rows) expect(r.sortCostUsd).toBeCloseTo(r.costPerOutcomeUsd.value ?? r.spentUsd.value, 9);
  });

  it("a combination that spent nothing is untested and stands on $0, first among the active rows (the dashboard hides them by default)", () => {
    const all = pipePerformance(input({ candidates: { workflows: ["azalea", "keel"], templates: ["aurora", "borealis"], llms: ["gemini-flash", "claude-opus"] } }));
    const untested = all.rows.filter((r) => r.untested);
    expect(untested.length).toBeGreaterThan(0);
    expect(untested.every((r) => r.spentUsd.value === 0 && r.sortCostUsd === 0)).toBe(true);
    expect(all.rows.slice(0, untested.length).every((r) => r.untested)).toBe(true);
    expect(all.rows.filter((r) => !r.untested).map((r) => r.key)).toEqual(out.rows.map((r) => r.key));
    expect(out.rows.some((r) => r.untested)).toBe(false);
  });

  it("a combination with ANY deprecated part is deprecated and stands after every active one", () => {
    const dep = pipePerformance(input({ deprecated: { workflows: new Set(), templates: new Set(), llms: new Set(["claude-opus"]) } }));
    const opus = dep.rows.find((r) => r.key === "azalea|borealis|claude-opus")!;
    expect(opus.status).toBe("deprecated");
    expect(opus.deprecatedParts).toEqual(["llm"]);
    expect(dep.rows.at(-1)!.key).toBe("azalea|borealis|claude-opus");
    expect(dep.rows.filter((r) => r.status === "active")).toHaveLength(3);
    const wf = pipePerformance(input({ deprecated: { workflows: new Set(["azalea"]), templates: new Set(["borealis"]), llms: new Set() } }));
    expect(wf.rows.find((r) => r.key === "azalea|borealis|gemini-flash")!.deprecatedParts).toEqual(["workflow", "template"]);
    expect(wf.rows[0]!.key).toBe("keel|-|-");
    expect(out.rows.every((r) => r.status === "active" && r.deprecatedParts.length === 0)).toBe(true);
  });

  it("every technically valid combination is listed and ranked, a never-written one on its parts (RESEARCH-ALL-COMBOS-1023)", () => {
    const all = pipePerformance(input({ candidates: { workflows: ["azalea", "keel"], templates: ["aurora", "borealis"], llms: ["gemini-flash", "claude-opus"] } }));
    // 2 x 2 x 2 candidates + keel's not-on-record row
    expect(all.rows).toHaveLength(9);
    const fresh = all.rows.find((r) => r.key === "azalea|aurora|claude-opus")!;
    expect(fresh.written).toBe(false);
    expect(fresh.writerSource).toBeNull();
    expect(fresh.spentUsd.value).toBe(0);
    expect(fresh.untested).toBe(true);
    expect(fresh.costPerOutcomeUsd).toMatchObject({ value: null, basis: null, unavailableReason: "no_outcome_yet" });
    expect(fresh.roi).toMatchObject({ value: null, unavailableReason: "no_outcome_yet" });
    expect(fresh.conversionRatePct).toMatchObject({ value: null, unavailableReason: "nobody_emailed_yet" });
    expect(all.rows.find((r) => r.key === "azalea|borealis|claude-opus")!.written).toBe(true);
    // the totals and the series never move
    expect(all.totals).toEqual(out.totals);
    expect(all.series).toEqual(out.series);
  });

  it("candidatePartsOf: runnable workflows, live template dynasties, LLMs served under an alias; never a deprecated part", () => {
    const parts = candidatePartsOf(
      {
        workflows: [{ key: "keel", runnable: true }, { key: "old", runnable: false }],
        templates: [
          { key: "aurora", status: "active", dynasty: { head: "v35" } },
          { key: "borealis", status: "deprecated", dynasty: { head: "v36" } },
          { key: "loose-v1", status: null, dynasty: null },
        ],
        models: [
          { key: "glm", aliases: ["glm-pro"], dynasty: { servedToday: true } },
          { key: "deepseek-pro", aliases: [], dynasty: { servedToday: false } },
          { key: "opus", aliases: ["opus"], dynasty: { servedToday: true } },
        ],
      },
      { workflows: new Set(), templates: new Set(), llms: new Set(["opus"]) },
    );
    expect(parts).toEqual({ workflows: ["keel"], templates: ["aurora"], llms: ["glm"] });
  });

  it("deprecatedPartsOf: not runnable, deprecated dynasty, an LLM served under no alias or only deprecated ones", () => {
    const parts = deprecatedPartsOf(
      {
        workflows: [{ key: "keel", runnable: true }, { key: "old", runnable: false }],
        templates: [{ key: "aurora", status: "active" }, { key: "borealis", status: "deprecated" }, { key: "x", status: null }],
        models: [
          { key: "deepseek-pro", aliases: [], aliasesUnavailableReason: "no_alias_serves_it" },
          { key: "unknown", aliases: [], aliasesUnavailableReason: "model_ids_unreadable" },
          { key: "haiku", aliases: ["haiku"], aliasesUnavailableReason: null },
          { key: "opus", aliases: ["opus", "opus-old"], aliasesUnavailableReason: null },
        ],
      },
      new Map([["haiku", "deprecated"], ["opus", "active"], ["opus-old", "deprecated"]]),
    );
    expect([...parts.workflows]).toEqual(["old"]);
    expect([...parts.templates]).toEqual(["borealis"]);
    expect([...parts.llms]).toEqual(["deepseek-pro", "haiku"]);
    // alias statuses unreadable: only the no-alias LLM is deprecated
    expect([...deprecatedPartsOf({ workflows: [], templates: [], models: [{ key: "haiku", aliases: ["haiku"], aliasesUnavailableReason: null }, { key: "deepseek-pro", aliases: [], aliasesUnavailableReason: "no_alias_serves_it" }] }, null).llms]).toEqual(["deepseek-pro"]);
  });

  it("a row with no outcome reads its OWN measured figures only: 0% conversion measured, no cost or return estimated", () => {
    const r = row("azalea|borealis|gemini-flash");
    expect(r.outcomes.value).toBe(0);
    expect(r.conversionRatePct).toMatchObject({ value: 0, basis: "measured", source: "own" });
    expect(r.roi).toMatchObject({ value: null, basis: null, unavailableReason: "no_outcome_yet" });
    expect(r.costPerOutcomeUsd).toMatchObject({ value: null, basis: null, unavailableReason: "no_outcome_yet" });
    expect("estimate" in r).toBe(false);
    // a spend-only row (nobody emailed) states it, never borrows a rate
    expect(row("keel|-|-").conversionRatePct).toMatchObject({ value: null, unavailableReason: "nobody_emailed_yet" });
  });

  it("the series is monthly, cumulative, and its last point IS the card", () => {
    const pts = out.series!.points;
    expect(pts.map((p) => p.month)).toEqual(["2026-08", "2026-09", "2026-10"]);
    const last = pts[pts.length - 1]!;
    expect(last.spentUsd).toBe(out.totals!.spentUsd.value);
    expect(last.outcomes).toBe(out.totals!.outcomes.value);
    expect(last.roi).toBe(out.totals!.roi.value);
    expect(last.costPerOutcomeUsd).toBe(out.totals!.costPerOutcomeUsd.value);
    expect(last.conversionRatePct).toBe(out.totals!.conversionRatePct.value);
  });

  it("a pipe with no writer on record serves no combination, with its reason", () => {
    const none = pipePerformance(input({ persons: persons.map((p) => ({ ...p, generation: null })) }));
    expect(none.rows).toEqual([]);
    expect(none.unavailableReason).toBe("no_writer_recorded_on_pipe");
  });
});

// PERF-ORDER-FLASH-1023, kept by PERF-COST-ORDER-1024 (owner 2026-10-24 « c'est à moi de m'habituer que ça sort sur la vue
// flash »): the view moves the figures, never the rows.
describe("inFlashOrder", () => {
  const perf = (rows: Array<[string, number, number]>) =>
    ({ pipe: "p", orderView: "flash", rows: rows.map(([key, rank, spent]) => ({ key, rank, sortCostUsd: spent, untested: spent === 0, spentUsd: { value: spent } })) }) as never as Parameters<typeof inFlashOrder>[0];
  // mature view: "young" read $0 (nothing old enough) and stands first
  const mature = perf([["young", 1, 0], ["old", 2, 900], ["gone", 3, 10]]);
  // flash view: "young" spent $150 for nothing, the proven one leads
  const flash = perf([["old", 1, 100], ["young", 2, 150], ["gone", 3, 10]]);
  it("rows stand in the flash tab's order, with its rank, sort figure and untested flag, on the view's own figures", () => {
    const out = inFlashOrder(mature, flash);
    expect(out.rows.map((r) => [r.key, r.rank, r.sortCostUsd, r.untested])).toEqual([["old", 1, 100, false], ["young", 2, 150, false], ["gone", 3, 10, false]]);
    expect(out.rows.map((r) => r.spentUsd.value)).toEqual([900, 0, 10]);
    expect(out.orderView).toBe("flash");
  });
  it("a row the flash tab lacks keeps its place, after the others", () => {
    const out = inFlashOrder(perf([["extra", 1, 0], ["old", 2, 900]]), flash);
    expect(out.rows.map((r) => [r.key, r.rank])).toEqual([["old", 1], ["extra", 2]]);
  });
});

// PERF-COST-ORDER-1024: the combination the pipe runs today, beside the rows.
describe("servedNowOf", () => {
  const out = pipePerformance(input());
  const part = (key: string, label = key) => ({ key, label });
  it("finds the row of the served workflow x template x LLM", () => {
    const s = servedNowOf(out, { workflow: part("azalea"), template: part("borealis"), llm: part("claude-opus"), unavailableReason: null });
    expect(s.row?.key).toBe("azalea|borealis|claude-opus");
    expect(s.unavailableReason).toBeNull();
  });
  it("names why when the combination is not listed or a part is missing", () => {
    expect(servedNowOf(out, { workflow: part("keel"), template: part("aurora"), llm: part("claude-opus"), unavailableReason: null })).toMatchObject({ row: null, unavailableReason: "combination_not_listed" });
    expect(servedNowOf(out, { workflow: null, template: part("aurora"), llm: part("claude-opus"), unavailableReason: null }).unavailableReason).toBe("no_runnable_workflow");
    expect(servedNowOf(out, { workflow: part("keel"), template: null, llm: part("claude-opus"), unavailableReason: null }).unavailableReason).toBe("no_template_picked");
    expect(servedNowOf(out, { workflow: null, template: null, llm: null, unavailableReason: "writer_ranking_not_computed_yet" }).unavailableReason).toBe("writer_ranking_not_computed_yet");
  });
});
