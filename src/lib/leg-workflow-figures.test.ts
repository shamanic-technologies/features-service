import { describe, expect, it } from "vitest";
import { legMaturityFigures, outcomeFigures, type LegMaturityFigures } from "./maturity.js";
import { rankLegWorkflows } from "./leg-workflow-ranking.js";
import { withWorkflowFigures, type CatalogWorkflow } from "./research/catalog.js";

// RESEARCH-WF-FIGURES-1022 (owner 2026-10-22): one ROI per workflow on the list and the page; a ROI and a % conversion
// are never blank; a workflow with 0 outcomes never shows a measured ROI.

const REPLY = "start_to_conversation";
const wf = (flash: [number, number, number], mature: [number, number, number] | null): LegMaturityFigures =>
  legMaturityFigures(REPLY, outcomeFigures(...flash), mature ? outcomeFigures(...mature) : null);

function rank(opts: { netSpend?: Map<string, { flash: number; mature: number | null }> | null; lastRunAt?: Map<string, string> | null } = {}) {
  // Prod shape, pipe Cold email -> Positive reply, 2026-10-22.
  const byDynasty = new Map<string, LegMaturityFigures>([
    ["cerulean", wf([4219.64, 15665, 26], [4219.64, 15665, 26])], // mature, 26 replies
    ["keel", wf([36.74, 184, 0], [0, 0, 0])], // learning, 0 replies, contacted value only
    ["eden", wf([22.37, 212, 0], [0, 0, 0])], // learning, 0 replies, no pipeline
  ]);
  return rankLegWorkflows({
    byDynasty,
    names: new Map(),
    assignments: new Map([
      ["cerulean", "active"],
      ["keel", "active"],
      ["eden", "active"],
      ["pharaoh", "active"], // never run: assigned, no evidence
    ]),
    executable: new Set(["cerulean", "keel", "eden", "pharaoh"]),
    pipelineUsd: new Map([
      ["cerulean", 7914.4],
      ["keel", 771.7],
      ["eden", 0],
    ]),
    billedSpendUsd: new Map([
      ["cerulean", 3006.74],
      ["keel", 25.86],
      ["eden", 22.37],
    ]),
    netSpend: opts.netSpend,
    lastRunAt: opts.lastRunAt,
    defaultConversionPct: 1,
  });
}
const row = (rows: ReturnType<typeof rank>, slug: string) => rows.find((r) => r.workflowDynastySlug === slug)!;
const POOLED_ROI = (7914.4 + 771.7 + 0) / (3006.74 + 25.86 + 22.37);
const POOLED_CONVERSION = (100 * 26) / (15665 + 184 + 212);

describe("leg workflow figures", () => {
  it("a workflow with an outcome reads its measured return, cost and conversion", () => {
    const f = row(rank(), "cerulean").figures!;
    expect(f.roi).toMatchObject({ basis: "measured", source: "workflow" });
    expect(f.roi.value).toBeCloseTo(7914.4 / 3006.74, 6);
    expect(f.costPerOutcomeUsd.value).toBeCloseTo(4219.64 / 26, 6);
    expect(f.conversionRatePct).toMatchObject({ basis: "measured" });
    expect(f.spentUsd).toEqual({ value: 4219.64, basis: "measured", unavailableReason: null });
  });

  it("0 outcomes never reads a measured ROI: Keel's 30x on contacted value alone becomes the pipe's expected return", () => {
    const keel = row(rank(), "keel");
    expect(keel.roiMultiple).toBeCloseTo(771.7 / 25.86, 6); // the legacy field, unchanged
    expect(keel.figures!.roi.basis).toBe("expected");
    expect(keel.figures!.roi.source).toBe("pipe_pooled");
    expect(keel.figures!.roi.value).toBeCloseTo(POOLED_ROI, 6);
    expect(keel.figures!.conversionRatePct).toMatchObject({ basis: "expected", source: "pipe_pooled" });
    expect(keel.figures!.conversionRatePct.value).toBeCloseTo(POOLED_CONVERSION, 6);
    expect(keel.figures!.costPerOutcomeUsd.basis).toBe("expected");
    // A learning 0.0x is no measured figure either.
    expect(row(rank(), "eden").figures!.roi).toMatchObject({ basis: "expected" });
  });

  it("a never-run workflow carries an expected ROI and an expected conversion, never a blank", () => {
    const f = row(rank(), "pharaoh").figures!;
    expect(f.roi.basis).toBe("expected");
    expect(f.roi.value).toBeCloseTo(POOLED_ROI, 6);
    expect(f.conversionRatePct.basis).toBe("expected");
    expect(f.conversionRatePct.value).toBeCloseTo(POOLED_CONVERSION, 6);
    expect(f.spentUsd.value).toBe(0);
  });

  it("every row has a ROI and a conversion; a pipe with no outcome falls to the leg default conversion", () => {
    for (const r of rank()) {
      expect(r.figures!.roi.value).not.toBeNull();
      expect(r.figures!.conversionRatePct.value).not.toBeNull();
    }
    const empty = rankLegWorkflows({
      byDynasty: new Map(),
      names: new Map(),
      assignments: new Map([["new", "active"]]),
      executable: new Set(["new"]),
      pipelineUsd: new Map(),
      billedSpendUsd: new Map(),
      defaultConversionPct: 1,
    });
    expect(empty[0].figures!.conversionRatePct).toMatchObject({ value: 1, basis: "expected", source: "leg_default" });
    expect(empty[0].figures!.roi).toMatchObject({ value: null, unavailableReason: "no_return_on_pipe" });
  });

  it("net pricing reads the net spend on the same half; an unmeasured net says so", () => {
    const net = new Map([
      ["cerulean", { flash: 3006.74, mature: 3006.74 }],
      ["keel", { flash: 25.86, mature: 0 }],
      ["eden", { flash: 22.37, mature: 0 }],
    ]);
    const c = row(rank({ netSpend: net }), "cerulean");
    expect(c.figuresNet!.pricing).toBe("net");
    expect(c.figuresNet!.costPerOutcomeUsd.value).toBeCloseTo(3006.74 / 26, 6);
    expect(c.figuresNet!.spentUsd.value).toBe(3006.74);
    expect(c.figuresNet!.roi.value).toBe(c.figures!.roi.value); // the return is already on what clients paid
    const unmeasured = row(rank({ netSpend: null }), "cerulean").figuresNet!;
    expect(unmeasured.costPerOutcomeUsd.unavailableReason).toBe("net_not_measured_on_pipe");
    expect(unmeasured.conversionRatePct.basis).toBe("measured"); // counts do not depend on pricing
  });

  it("the workflow page prints the list's ROI: the catalogue takes the ranking row's figures", () => {
    const rows = rank();
    const page = (key: string, roi: string): CatalogWorkflow => ({ key, roi, roiDetail: { value: 0.02, display: roi, basis: "measured", source: "workflow", spendCovered: null, unavailableReason: null }, figures: null }) as unknown as CatalogWorkflow;
    const pipe = withWorkflowFigures({ workflows: [page("cerulean", "0.02x"), page("keel", "29.84x")] }, rows);
    for (const w of pipe.workflows) {
      const r = row(rows, w.key);
      expect(w.roiDetail.value).toBe(r.figures!.roi.value);
      expect(w.roiDetail.basis).toBe(r.figures!.roi.basis);
      expect(w.figures).toBe(r.figures);
    }
    expect(pipe.workflows.find((w) => w.key === "keel")!.roiDetail).toMatchObject({ basis: "expected", source: "pipe_workflows" });
  });

  it("states each workflow's last run on the pipe: null for a never-run one, a reason when the pipe was not read", () => {
    const rows = rank({ lastRunAt: new Map([["cerulean", "2026-10-22T16:00:00.000Z"]]) });
    expect(row(rows, "cerulean")).toMatchObject({ lastRunAt: "2026-10-22T16:00:00.000Z", lastRunUnavailableReason: null });
    expect(row(rows, "pharaoh")).toMatchObject({ lastRunAt: null, lastRunUnavailableReason: "never_ran" });
    // It ran (spent, contacted) but the run-time read states no date: never read as "never ran".
    expect(row(rows, "keel")).toMatchObject({ lastRunAt: null, lastRunUnavailableReason: "run_time_not_served" });
    expect(row(rank({ lastRunAt: null }), "cerulean")).toMatchObject({ lastRunAt: null, lastRunUnavailableReason: "not_read_on_pipe" });
  });
});
