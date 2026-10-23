import { describe, expect, it, vi } from "vitest";
vi.mock("../../db/index.js", () => ({ db: {}, sql: {} }));
import type { SlugCell } from "./buckets.js";
import { candidatePartsOf, deprecatedPartsOf, fitPartEffects, inFlashOrder, pipePerformance, type PipePerformanceInput } from "./performance.js";
import { legWorkflowPlaces, orderLegWorkflows } from "../leg-workflow-order.js";
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

  it("rows stand in the pipe's PICK order, the ONE leg order on each combination's own figures (PERF-LEG-ORDER-1023)", () => {
    expect(out.rowOrder).toBe("leg_order");
    expect(out.orderView).toBe("flash");
    expect(out.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    // the order IS the shared leg order on each row's own figures (the one writer-pick and the workflow ranking use)
    const entries = out.rows.map((r) => ({
      slug: r.key,
      selectable: r.status === "active",
      mature: r.maturity.isMature && r.outcomes.value > 0 ? { tier: 0, costPerOutcomeUsd: r.spentUsd.value / r.outcomes.value } : null,
      fleet: { spentUsd: r.spentUsd.value, outcomes: r.outcomes.value },
    }));
    expect(out.rows.map((r) => r.key)).toEqual(orderLegWorkflows(entries));
    expect(out.rows.map((r) => r.place)).toEqual(out.rows.map((r) => legWorkflowPlaces(entries).get(r.key)));
    expect(out.rows[0]!.key).toBe("azalea|borealis|claude-opus");
    // the estimate is still served: (own spend + k x prior) / (own outcomes + k), k = 1 positive reply
    const opus = row("azalea|borealis|claude-opus");
    expect(opus.estimate.priorWeightOutcomes).toBe(1);
    expect(opus.estimate.costPerOutcomeUsd).toBeCloseTo((opus.estimate.ownSpentUsd + opus.estimate.priorCostPerOutcomeUsd!) / (opus.estimate.ownOutcomes + 1), 9);
  });

  it("never used ($0) combinations go FIRST, ties on their estimate; a learning row proven worse than the best mature one goes after it", () => {
    const all = pipePerformance(input({ candidates: { workflows: ["azalea", "keel"], templates: ["aurora", "borealis"], llms: ["gemini-flash", "claude-opus"] } }));
    const fresh = all.rows.filter((r) => !r.written);
    expect(all.rows.slice(0, fresh.length).every((r) => !r.written)).toBe(true);
    for (let i = 1; i < fresh.length; i++) expect(fresh[i]!.estimate.costPerOutcomeUsd!).toBeGreaterThanOrEqual(fresh[i - 1]!.estimate.costPerOutcomeUsd!);
    // a mature row sets the bar: learning rows that already spent more than its cost stand after it
    const mature = pipePerformance(input({
      candidates: { workflows: ["azalea"], templates: ["aurora"], llms: ["gemini-flash"] },
      cells: cells.map((c) => (c.slug === "azalea-v1" ? { ...c, mature: half({ "2026-08": [100, 100, 2], "2026-09": [200, 200, 4] }) } : c)),
    }));
    const opus = mature.rows.find((r) => r.key === "azalea|borealis|claude-opus")!;
    if (opus.maturity.isMature) {
      expect(opus.place).toBe("money");
      const worse = mature.rows.filter((r) => r.place === "proven_worse");
      for (const w of worse) expect(w.rank).toBeGreaterThan(opus.rank);
    }
  });

  it("a combination that spent with no outcome climbs above its prior; its expected cost IS that estimate, its return moves with it", () => {
    const r = row("azalea|borealis|gemini-flash");
    expect(r.estimate.ownOutcomes).toBe(0);
    expect(r.estimate.ownSpentUsd).toBeGreaterThan(0);
    expect(r.estimate.costPerOutcomeUsd).toBeCloseTo(r.estimate.ownSpentUsd + r.estimate.priorCostPerOutcomeUsd!, 9);
    expect(r.costPerOutcomeUsd.value).toBeCloseTo(r.estimate.costPerOutcomeUsd!, 9);
    // same value per outcome at a higher cost: return x (prior / estimate)
    const noSpend = pipePerformance(input({ cells: cells.map((c) => (c.slug === "azalea-v2" ? { ...c, flash: half({ "2026-09": [0, 100, 0] }), mature: half({ "2026-09": [0, 100, 0] }) } : c)) }));
    const free = noSpend.rows.find((x) => x.key === "azalea|borealis|gemini-flash")!;
    expect(free.estimate.costPerOutcomeUsd).toBeCloseTo(free.estimate.priorCostPerOutcomeUsd!, 9);
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
    expect(fresh.estimate.costPerOutcomeUsd).toBeCloseTo(fresh.estimate.priorCostPerOutcomeUsd!, 9);
    expect(fresh.estimate.priorSource).toBe("own_parts");
    expect(fresh.costPerOutcomeUsd).toMatchObject({ basis: "expected" });
    expect(all.rows.find((r) => r.key === "azalea|borealis|claude-opus")!.written).toBe(true);
    // never used: explored first, before every row that spent; the totals and the series never move
    expect(fresh.rank).toBeLessThan(all.rows.find((r) => r.key === "azalea|borealis|claude-opus")!.rank);
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

  it("a row with no outcome reads its OWN figures: measured 0% conversion, expected ROI and cost from its own parts", () => {
    const r = row("azalea|borealis|gemini-flash");
    expect(r.outcomes.value).toBe(0);
    expect(r.conversionRatePct).toMatchObject({ value: 0, basis: "measured", source: "own" });
    expect(r.roi).toMatchObject({ basis: "expected", source: "own_parts", parts: ["workflow"] });
    expect(r.costPerOutcomeUsd).toMatchObject({ basis: "expected", source: "own_parts" });
    // its prior = the pipe's model of part effects fitted on every OTHER row (PRIOR-PART-EFFECTS-1023)
    const others = out.rows.filter((x) => x.key !== r.key && (x.spentUsd.value > 0 || x.outcomes.value > 0));
    const keysOf = (x: (typeof out.rows)[number]) => [`w:${x.workflow.key}`, ...(x.template ? [`t:${x.template.key}`] : []), ...(x.llm ? [`l:${x.llm.key}`] : [])];
    const model = fitPartEffects(others.map((x) => ({ parts: keysOf(x), spentUsd: x.spentUsd.value, outcomes: x.outcomes.value })), 1)!;
    const rate = keysOf(r).reduce((acc, k) => acc * (model.effects.get(k) ?? 1), model.pipeRatePerUsd);
    expect(r.estimate.priorCostPerOutcomeUsd).toBeCloseTo(1 / rate, 6);
    expect(r.estimate.priorSource).toBe("own_parts");
    expect(r.estimate.priorParts).toEqual(["workflow", "template", "llm"]);
    // never the pipe pool copied on every row
    expect(r.roi.value).not.toBeCloseTo(out.totals!.roi.value!, 3);
    // a spend-only row (nobody emailed) still reads its parts
    expect(row("keel|-|-").conversionRatePct).toMatchObject({ basis: "expected" });
  });

  it("an expected ROI is read FROM the expected cost: value per outcome ÷ that cost billed, never averaged apart (PRIOR-PART-EFFECTS-1023)", () => {
    const all = pipePerformance(input({ candidates: { workflows: ["azalea", "keel"], templates: ["aurora", "borealis"], llms: ["gemini-flash", "claude-opus"] } }));
    // azalea: $1,200 pipeline over 6 outcomes = $200 per outcome, $400 billed on $400 spent = 1 per dollar
    for (const r of all.rows.filter((x) => x.workflow.key === "azalea" && x.roi.basis === "expected")) expect(r.roi.value! * r.costPerOutcomeUsd.value!).toBeCloseTo(200, 6);
    // keel's own terms are $0 per outcome: its rows read the pipe pooled ($1,200 / 6 per outcome, $450 billed / $450 spent)
    const keel = all.rows.find((x) => x.key === "keel|aurora|gemini-flash")!;
    expect(keel.roi).toMatchObject({ basis: "expected", source: "pipe_combinations" });
    expect(keel.roi.value! * keel.costPerOutcomeUsd.value!).toBeCloseTo(200, 6);
    // so a cheaper expected cost always reads a higher expected return on one workflow
    const az = all.rows.filter((x) => x.workflow.key === "azalea" && x.roi.basis === "expected").sort((a, b) => a.costPerOutcomeUsd.value! - b.costPerOutcomeUsd.value!);
    for (let i = 1; i < az.length; i++) expect(az[i]!.roi.value!).toBeLessThanOrEqual(az[i - 1]!.roi.value!);
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

// PRIOR-PART-EFFECTS-1023 (owner 2026-10-23): the prior is ONE model of the pipe, never the geometric mean of each part.
describe("fitPartEffects", () => {
  const cost = (m: NonNullable<ReturnType<typeof fitPartEffects>>, parts: string[]) => 1 / parts.reduce((r, k) => r * (m.effects.get(k) ?? 1), m.pipeRatePerUsd);

  it("effects MULTIPLY: three parts each twice as good make a combination ~8x cheaper, not 2x", () => {
    // every pair of a good and a plain part is tried on its own with plenty of evidence; the all-good triple never ran
    const rows: Array<{ parts: string[]; spentUsd: number; outcomes: number }> = [];
    for (const w of ["w:good", "w:plain"]) for (const t of ["t:good", "t:plain"]) for (const l of ["l:good", "l:plain"]) {
      if (w === "w:good" && t === "t:good" && l === "l:good") continue;
      const goods = [w, t, l].filter((k) => k.endsWith("good")).length;
      rows.push({ parts: [w, t, l], spentUsd: 8000, outcomes: 40 * 2 ** goods });
    }
    const m = fitPartEffects(rows, 1)!;
    const ratio = cost(m, ["w:plain", "t:plain", "l:plain"]) / cost(m, ["w:good", "t:good", "l:good"]);
    expect(ratio).toBeGreaterThan(7.5);
    expect(ratio).toBeLessThan(8.5);
  });

  it("one lucky outcome barely moves a part; thirty move it (each part pulled toward the pipe by k outcomes)", () => {
    // the pipe: $200 per outcome on 30 outcomes; a new LLM got 1 reply for $10
    const base = [{ parts: ["w:a", "l:old"], spentUsd: 6000, outcomes: 30 }];
    const lucky = fitPartEffects([...base, { parts: ["w:a", "l:new"], spentUsd: 10, outcomes: 1 }], 1)!;
    // the raw figure is $10; the model reads it about half the pipe's price, never $10
    expect(cost(lucky, ["w:a", "l:new"])).toBeGreaterThan(90);
    const proven = fitPartEffects([...base, { parts: ["w:a", "l:new"], spentUsd: 300, outcomes: 30 }], 1)!;
    expect(cost(proven, ["w:a", "l:new"])).toBeLessThan(15);
  });

  it("a part nobody spent on is neutral (effect 1), never a bonus", () => {
    const m = fitPartEffects([{ parts: ["w:a", "t:x"], spentUsd: 1000, outcomes: 10 }, { parts: ["w:b", "t:x"], spentUsd: 1000, outcomes: 2 }], 1)!;
    expect(m.effects.has("t:never")).toBe(false);
    expect(cost(m, ["w:a", "t:x", "t:never"])).toBeCloseTo(cost(m, ["w:a", "t:x"]), 9);
  });

  it("the same replies are not counted once per part: one great row lifts its parts less than three separate proofs would", () => {
    const one = fitPartEffects([{ parts: ["w:a", "t:a", "l:a"], spentUsd: 100, outcomes: 10 }, { parts: ["w:b", "t:b", "l:b"], spentUsd: 1000, outcomes: 10 }], 1)!;
    // its parts' product reproduces roughly its own rate (10 per $100), not that rate cubed
    const fitted = cost(one, ["w:a", "t:a", "l:a"]);
    expect(fitted).toBeGreaterThan(8);
    expect(fitted).toBeLessThan(25);
  });

  it("nothing to read a rate from: null", () => {
    expect(fitPartEffects([], 1)).toBeNull();
    expect(fitPartEffects([{ parts: ["w:a"], spentUsd: 100, outcomes: 0 }], 1)).toBeNull();
  });
});

// PERF-ORDER-FLASH-1023 (owner 2026-10-23 « pourquoi ce ranking change si on choisit flash ou mature »): the view moves the
// figures, never the rows. On the mature view a young combination read $0 and stood first as never used.
describe("inFlashOrder", () => {
  const perf = (rows: Array<[string, number, string, number]>) =>
    ({ pipe: "p", orderView: "flash", rows: rows.map(([key, rank, place, spent]) => ({ key, rank, place, spentUsd: { value: spent } })) }) as never as Parameters<typeof inFlashOrder>[0];
  // mature view: "young" read $0 (nothing old enough) and stands first
  const mature = perf([["young", 1, "explore", 0], ["old", 2, "money", 900], ["gone", 3, "cannot_run", 10]]);
  // flash view: "young" spent $150 for nothing, the proven one leads
  const flash = perf([["old", 1, "money", 1000], ["young", 2, "explore", 150], ["gone", 3, "cannot_run", 10]]);
  it("rows stand in the flash tab's order, with its rank and place, on the view's own figures", () => {
    const out = inFlashOrder(mature, flash);
    expect(out.rows.map((r) => [r.key, r.rank, r.place])).toEqual([["old", 1, "money"], ["young", 2, "explore"], ["gone", 3, "cannot_run"]]);
    expect(out.rows.map((r) => r.spentUsd.value)).toEqual([900, 0, 10]);
    expect(out.orderView).toBe("flash");
  });
  it("a row the flash tab lacks keeps its place, after the others", () => {
    const out = inFlashOrder(perf([["extra", 1, "explore", 0], ["old", 2, "money", 900]]), flash);
    expect(out.rows.map((r) => [r.key, r.rank])).toEqual([["old", 1], ["extra", 2]]);
  });
});
