import { describe, expect, it, vi } from "vitest";
vi.mock("../../db/index.js", () => ({ db: {}, sql: {} }));
import type { SlugCell } from "./buckets.js";
import { pipePerformance, type PipePerformanceInput } from "./performance.js";
import { templateDynastyIndex } from "./template-dynasties.js";
import { llmDynastyIndex } from "../llm-dynasties.js";
import type { FleetPersonBucket } from "../fleet-positive-repliers.js";

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
  pb("azalea-v1", "2026-09-12", null, null, 100, 0),
  pb("azalea-v2", "2026-09-20", "gemini-3.8-flash", "cold-email-v36", 100, 0),
];

const tpl = templateDynastyIndex([
  { slug: "aurora", name: "Aurora", description: "", signature: null, identity: "", head: "cold-email-v36", versions: ["cold-email-v35", "cold-email-v36"], status: "active", statusSource: "content_generation", versionStatuses: {} },
]);
const llm = llmDynastyIndex([
  { slug: "gemini-flash", name: "Gemini Flash", provider: "google", capabilityTier: "cheap", headModelId: "gemini-3.8-flash", servedToday: true, models: [{ modelId: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", servedToday: true }, { modelId: "gemini-3.7-flash", displayName: "Gemini 3.7 Flash", servedToday: false }], legacyAliases: [] },
  { slug: "claude-opus", name: "Claude Opus", provider: "anthropic", capabilityTier: "frontier", headModelId: "claude-opus-5-5", servedToday: true, models: [{ modelId: "claude-opus-5-5", displayName: "Claude Opus 5.5", servedToday: true }], legacyAliases: [] },
]);

const input = (over: Partial<PipePerformanceInput> = {}): PipePerformanceInput => ({
  pipe: "cold-email-positive-reply",
  noun: "positive reply",
  nounPlural: "positive replies",
  legKey: "start_to_conversation",
  cells,
  persons,
  split: { screened: false, signal: "positiveReply", cutoffDay: "2026-10-02" },
  dynastyOf: (s) => s.replace(/-v\d+$/, ""),
  workflowLabelOf: (d) => d[0]!.toUpperCase() + d.slice(1),
  workflowNameOf: (d) => `Sales Cold Email Outreach ${d}`,
  templateDynasties: tpl,
  llmDynasties: llm,
  modelLabel: (id) => id,
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
  const sum = (f: (r: (typeof out.rows)[number]) => number) => out.rows.reduce((a, r) => a + f(r), 0);

  it("one row per combination; rows partition the pipe (spend, people, outcomes)", () => {
    expect(out.rows.map((r) => r.key).sort()).toEqual(["azalea|-|-", "azalea|cold-email-v35|gemini-flash", "azalea|cold-email-v36|claude-opus", "azalea|cold-email-v36|gemini-flash", "keel|-|-"]);
    expect(sum((r) => r.spentUsd.value)).toBeCloseTo(450, 9);
    expect(sum((r) => r.outcomes.value)).toBeCloseTo(6, 9);
    expect(out.totals!.spentUsd.value).toBeCloseTo(sum((r) => r.spentUsd.value), 9);
    expect(out.totals!.outcomes.value).toBeCloseTo(sum((r) => r.outcomes.value), 9);
    expect(out.totals!.contacted.value).toBeCloseTo(sum((r) => r.contacted.value), 9);
  });

  it("names each part the way the catalogue does", () => {
    const opus = out.rows.find((r) => r.key === "azalea|cold-email-v36|claude-opus")!;
    expect(opus.workflow).toEqual({ key: "azalea", label: "Azalea", name: "Sales Cold Email Outreach azalea" });
    expect(opus.template).toEqual({ key: "cold-email-v36", label: expect.any(String), dynasty: { key: "aurora", label: "Aurora" } });
    expect(opus.llm).toEqual({ key: "claude-opus", label: "Claude Opus", provider: "anthropic" });
    const none = out.rows.find((r) => r.key === "keel|-|-")!;
    expect(none.template).toBeNull();
    expect(none.llm).toBeNull();
    expect(none.writerUnavailableReason).toBe("not_on_record");
  });

  it("ROI: own outcomes' pipeline over own billed; best first; a row with no outcome is expected (pooled), never 0", () => {
    const opus = out.rows.find((r) => r.key === "azalea|cold-email-v36|claude-opus")!;
    // 4 of azalea's 6 outcomes = $800 pipeline; $100 of azalea's $400 spend = $100 billed: 8x
    expect(opus.roi).toMatchObject({ value: 8, basis: "measured", source: "own" });
    expect(opus.costPerOutcomeUsd).toMatchObject({ value: 25, basis: "measured" });
    expect(out.rows[0]!.key).toBe("azalea|cold-email-v36|claude-opus");
    expect(out.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    const learning = out.rows.find((r) => r.key === "azalea|cold-email-v36|gemini-flash")!;
    expect(learning.outcomes.value).toBe(0);
    // pooled: $1,200 / $450 billed
    expect(learning.roi).toMatchObject({ basis: "expected", source: "pipe_combinations" });
    expect(learning.roi.value).toBeCloseTo(1200 / 450, 9);
    expect(learning.costPerOutcomeUsd).toMatchObject({ value: 75, basis: "expected", source: "pipe_combinations" });
    const measured = out.rows.filter((r) => r.roi.basis === "measured").map((r) => r.roi.value!);
    expect(measured).toEqual([...measured].sort((a, b) => b - a));
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
    expect(pts[0]!.spentUsd).toBeCloseTo(100, 9);
    expect(pts[0]!.outcomes).toBeCloseTo(2, 9);
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.spentUsd).toBeGreaterThanOrEqual(pts[i - 1]!.spentUsd);
  });

  it("a pipe with no writer on record serves no combination, with its reason", () => {
    const none = pipePerformance(input({ persons: persons.map((p) => ({ ...p, generation: null })) }));
    expect(none.rows).toEqual([]);
    expect(none.unavailableReason).toBe("no_writer_recorded_on_pipe");
  });

  it("no outcome on the whole pipe: costs read null with a reason, the ROI expects the money workflow's", () => {
    const zero = pipePerformance(input({ cells: cells.map((c) => ({ ...c, flash: { ...c.flash, figures: { ...c.flash.figures, outcomes: 0 }, months: Object.fromEntries(Object.entries(c.flash.months).map(([k, f]) => [k, { ...f, outcomes: 0 }])) } })), persons: persons.map((p) => ({ ...p, positiveReplies: 0 })) }));
    expect(zero.totals!.costPerOutcomeUsd).toMatchObject({ value: null, unavailableReason: "no_outcome_on_pipe" });
    expect(zero.totals!.roi).toMatchObject({ value: 3, basis: "expected", source: "pipe_best_workflow" });
    expect(zero.rows.every((r) => r.roi.value === 3 && r.costPerOutcomeUsd.value === null)).toBe(true);
  });
});
