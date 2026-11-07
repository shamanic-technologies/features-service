import { describe, expect, it } from "vitest";
import { buildPipelineGeneratedSeries, firstDayByOrganization } from "./pipeline-generated.js";

describe("buildPipelineGeneratedSeries (PIPELINE-GENERATED-1107)", () => {
  const values = new Map([
    ["org:A", 100],
    ["org:B", 50],
    ["org:C", 0],
    ["lead:x", 30],
  ]);
  const days = new Map([
    ["org:A", "2026-11-01"],
    ["org:B", "2026-11-03"],
    ["org:C", "2026-10-01"],
    ["lead:x", "2026-11-03"],
  ]);

  it("measured: every day from the first valued day to today, cumulative; total = last measured point", () => {
    const s = buildPipelineGeneratedSeries({ organizationValues: values, firstDayOf: days, running: true, today: "2026-11-04", horizonDays: 3 });
    const measured = s.points.filter((p) => p.kind === "measured");
    // org:C is worth 0: it never opens the series.
    expect(measured.map((p) => [p.date, p.generatedUsd, p.cumulativeUsd])).toEqual([
      ["2026-11-01", 100, 100],
      ["2026-11-02", 0, 100],
      ["2026-11-03", 80, 180],
      ["2026-11-04", 0, 180],
    ]);
    expect(s.measuredUsd).toBe(180);
    expect(s.measuredUsd).toBe(measured.at(-1)!.cumulativeUsd);
    expect(s.firstDay).toBe("2026-11-01");
  });

  it("expected: the pace since inception carried forward; expectedUsd = last expected point", () => {
    const s = buildPipelineGeneratedSeries({ organizationValues: values, firstDayOf: days, running: true, today: "2026-11-04", horizonDays: 3 });
    expect(s.dailyPaceUsd).toBe(45); // 180 over 4 days
    const expected = s.points.filter((p) => p.kind === "expected");
    expect(expected.map((p) => [p.date, p.cumulativeUsd])).toEqual([
      ["2026-11-05", 225],
      ["2026-11-06", 270],
      ["2026-11-07", 315],
    ]);
    expect(s.expectedUsd).toBe(315);
    expect(s.expectedFlatReason).toBeNull();
  });

  it("nothing running: the expected days stay flat at the measured total", () => {
    const s = buildPipelineGeneratedSeries({ organizationValues: values, firstDayOf: days, running: false, today: "2026-11-04", horizonDays: 2 });
    expect(s.expectedFlatReason).toBe("offer_not_running");
    expect(s.expectedUsd).toBe(180);
    expect(s.points.filter((p) => p.kind === "expected").every((p) => p.cumulativeUsd === 180)).toBe(true);
  });

  it("an undated organisation counts on the first day, so the series still adds up", () => {
    const s = buildPipelineGeneratedSeries({
      organizationValues: new Map([["org:A", 100], ["org:Z", 7]]),
      firstDayOf: new Map([["org:A", "2026-11-03"]]),
      running: true,
      today: "2026-11-04",
      horizonDays: 0,
    });
    expect(s.undatedUsd).toBe(7);
    expect(s.points[0]).toEqual({ date: "2026-11-03", kind: "measured", generatedUsd: 107, cumulativeUsd: 107 });
    expect(s.measuredUsd).toBe(107);
  });

  it("no economics: every figure null, no point; nothing valued: no_pipeline_yet", () => {
    const none = buildPipelineGeneratedSeries({ organizationValues: null, firstDayOf: new Map(), running: true, today: "2026-11-04" });
    expect(none.measuredUsd).toBeNull();
    expect(none.points).toEqual([]);
    const empty = buildPipelineGeneratedSeries({ organizationValues: new Map(), firstDayOf: new Map(), running: true, today: "2026-11-04", horizonDays: 2 });
    expect(empty.measuredUsd).toBe(0);
    expect(empty.expectedFlatReason).toBe("no_pipeline_yet");
    expect(empty.firstDay).toBeNull();
  });
});

describe("firstDayByOrganization", () => {
  it("the earliest dated signal of any of the organisation's people", () => {
    const m = firstDayByOrganization([
      { leadId: "1", orgId: "A", signalDates: { contacted: "2026-11-02T10:00:00Z", lastSent: "2026-11-05T10:00:00Z" } },
      { leadId: "2", orgId: "A", signalDates: { contacted: "2026-10-30T10:00:00Z", positiveReply: null } },
      { leadId: "3", orgId: null, signalDates: { contacted: "2026-11-01T00:00:00Z" } },
      { leadId: "4", orgId: "B" },
    ]);
    expect(Object.fromEntries(m)).toEqual({ "org:A": "2026-10-30", "lead:3": "2026-11-01" });
  });
});
