import { describe, it, expect } from "vitest";

// Pure builder — no DB, no network. The db mock is here because sibling libs in this folder pull it in
// transitively; see the CLAUDE.md note on "pure-logic" tests importing a compute helper.
import { vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const { buildRoiHistory } = await import("./roi-history.js");

/** The engine's cumulative pipeline series: ISO-stamped, already cumulative, ascending. */
const point = (date: string, cumulativePipelineUsd: number) => ({ date, cumulativePipelineUsd });

describe("buildRoiHistory", () => {
  it("is CUMULATIVE on both legs and its last point IS the headline ROI", () => {
    const spend = new Map([
      ["2026-01-01", 100],
      ["2026-01-02", 100],
      ["2026-01-03", 200],
    ]);
    const pipeline = [point("2026-01-02T10:00:00Z", 500), point("2026-01-03T09:00:00Z", 1200)];

    const history = buildRoiHistory(spend, pipeline, 1200);

    expect(history.daily).toEqual([
      { date: "2026-01-01", cumulativeSpendUsd: 100, cumulativePipelineUsd: 0, roiMultiple: 0 },
      { date: "2026-01-02", cumulativeSpendUsd: 200, cumulativePipelineUsd: 500, roiMultiple: 2.5 },
      { date: "2026-01-03", cumulativeSpendUsd: 400, cumulativePipelineUsd: 1200, roiMultiple: 3 },
    ]);
    // The headline is pipeline / spend = 1200 / 400 = 3 — the curve terminates ON it, by construction.
    const last = history.daily[history.daily.length - 1];
    expect(last.roiMultiple).toBe(1200 / 400);
    expect(last.cumulativeSpendUsd).toBe(400);
  });

  it("carries pipeline forward on a spend-only day, so the curve DIPS when more is spent for the same return", () => {
    const spend = new Map([
      ["2026-02-01", 100],
      ["2026-02-02", 100],
    ]);
    const pipeline = [point("2026-02-01T12:00:00Z", 400)];

    const { daily } = buildRoiHistory(spend, pipeline, 400);

    expect(daily.map((d) => d.roiMultiple)).toEqual([4, 2]);
    expect(daily[1].cumulativePipelineUsd).toBe(400); // carried, never re-earned and never dropped
  });

  it("keeps the HIGHEST cumulative value when several engine points land on one UTC day", () => {
    const pipeline = [
      point("2026-03-01T01:00:00Z", 100),
      point("2026-03-01T20:00:00Z", 900),
    ];

    const { daily } = buildRoiHistory(new Map([["2026-03-01", 300]]), pipeline, 900);

    expect(daily).toEqual([
      { date: "2026-03-01", cumulativeSpendUsd: 300, cumulativePipelineUsd: 900, roiMultiple: 3 },
    ]);
  });

  it("reports roiMultiple NULL — never 0 — on a day with a dated outcome but no spend yet", () => {
    const pipeline = [point("2026-04-01T00:00:00Z", 250)];

    const { daily } = buildRoiHistory(new Map([["2026-04-02", 50]]), pipeline, 250);

    expect(daily[0]).toEqual({
      date: "2026-04-01",
      cumulativeSpendUsd: 0,
      cumulativePipelineUsd: 250,
      roiMultiple: null, // divides by nothing — "could not measure", not "returned nothing"
    });
    expect(daily[1].roiMultiple).toBe(5);
  });

  it("reports UNDATED pipeline separately instead of dropping it or parking it on a day", () => {
    // 1000 in the headline, only 600 of it carried by a dated outcome.
    const history = buildRoiHistory(new Map([["2026-05-01", 200]]), [point("2026-05-01T00:00:00Z", 600)], 1000);

    expect(history.datedPipelineUsd).toBe(600);
    expect(history.undatedPipelineUsd).toBe(400);
    expect(history.datedPipelineUsd + history.undatedPipelineUsd).toBe(1000);
    // ...and no fabricated day carries it.
    expect(history.daily).toHaveLength(1);
  });

  it("is wall-clock independent and emits nothing when there is neither spend nor a dated outcome", () => {
    expect(buildRoiHistory(new Map(), [], null)).toEqual({
      daily: [],
      datedPipelineUsd: 0,
      undatedPipelineUsd: 0,
    });
  });

  it("emits one ascending point per day that has spend OR a dated outcome, and none for the days between", () => {
    const spend = new Map([
      ["2026-06-10", 10],
      ["2026-06-01", 10],
    ]);
    const pipeline = [point("2026-06-05T00:00:00Z", 40)];

    const { daily } = buildRoiHistory(spend, pipeline, 40);

    expect(daily.map((d) => d.date)).toEqual(["2026-06-01", "2026-06-05", "2026-06-10"]);
  });
});
