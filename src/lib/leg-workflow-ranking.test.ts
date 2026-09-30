import { describe, expect, it } from "vitest";
import { legMaturityFigures, outcomeFigures, type LegMaturityFigures } from "./maturity.js";
import { rankLegWorkflows } from "./leg-workflow-ranking.js";

const REPLY = "start_to_conversation";

/** flash [$, contacted, outcomes]; mature half or null. */
function wf(flash: [number, number, number], mature: [number, number, number] | null): LegMaturityFigures {
  return legMaturityFigures(REPLY, outcomeFigures(...flash), mature ? outcomeFigures(...mature) : null);
}

function rank(byDynasty: Record<string, LegMaturityFigures>, assignments: Record<string, "active" | "deprecated"> = {}) {
  const slugs = Object.keys(byDynasty);
  return rankLegWorkflows({
    byDynasty: new Map(Object.entries(byDynasty)),
    names: new Map(slugs.map((s) => [s, s.toUpperCase()])),
    assignments: new Map(slugs.map((s) => [s, assignments[s] ?? "active"])),
    pipelineUsd: new Map(),
    billedSpendUsd: new Map(),
  });
}

describe("rankLegWorkflows", () => {
  // The prod case the owner reported (research, Herald): Nobelium mature at $45 must hold the money,
  // learning rows cheaper than $45 above it, the dearer mature one below.
  it("puts the best MATURE workflow where the money goes, only CHEAPER learning rows above it", () => {
    const rows = rank({
      azalea: wf([262, 1900, 5], [260, 1900, 5]), // mature $52
      nobelium: wf([45, 1000, 1], [45, 1000, 1]), // mature $45
      raven: wf([14, 400, 1], [0, 0, 0]), // learning $14
      rudder: wf([47, 500, 1], [0, 0, 0]), // learning $47 > $45
      torrent: wf([14, 300, 0], [0, 0, 0]), // learning, no outcome → no price
    });
    expect(rows.map((r) => r.workflowDynastySlug)).toEqual(["raven", "nobelium", "azalea", "rudder", "torrent"]);
    expect(rows.find((r) => r.moneyGoesHere)?.workflowDynastySlug).toBe("nobelium");
    expect(rows[0]).toMatchObject({ goesFirst: true, basis: "flash", costPerOutcomeUsd: 14 });
    expect(rows.find((r) => r.workflowDynastySlug === "torrent")).toMatchObject({ costPerOutcomeUsd: null, outcomes: 0 });
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reads a mature workflow on its MATURE half and a learning one on its flash half", () => {
    const rows = rank({ a: wf([300, 1000, 3], [100, 800, 2]), b: wf([10, 50, 1], [0, 0, 0]) });
    expect(rows.find((r) => r.workflowDynastySlug === "a")).toMatchObject({ basis: "mature", costPerOutcomeUsd: 50, outcomes: 2, spentUsd: 100 });
    expect(rows.find((r) => r.workflowDynastySlug === "b")).toMatchObject({ basis: "flash", isMature: false });
  });

  it("with nothing mature, orders every selectable workflow by its flash price and marks no money row", () => {
    const rows = rank({ a: wf([30, 100, 1], [0, 0, 0]), b: wf([20, 100, 2], [0, 0, 0]) });
    expect(rows.map((r) => r.workflowDynastySlug)).toEqual(["b", "a"]);
    expect(rows.some((r) => r.moneyGoesHere)).toBe(false);
  });

  it("a deprecated workflow sits after every selectable one and is never put forward", () => {
    const rows = rank({ dead: wf([5, 100, 5], [5, 100, 5]), live: wf([300, 1000, 3], [300, 1000, 3]) }, { dead: "deprecated" });
    expect(rows.map((r) => r.workflowDynastySlug)).toEqual(["live", "dead"]);
    expect(rows[1]).toMatchObject({ selectable: false, goesFirst: false, moneyGoesHere: false });
  });

  it("a deprecated workflow at rank 1 does not go first", () => {
    const rows = rank({ dead: wf([5, 100, 5], [5, 100, 5]) }, { dead: "deprecated" });
    expect(rows[0]).toMatchObject({ rank: 1, goesFirst: false });
  });

  it("leaves out an unassigned workflow that never spent on the leg, keeps one that did", () => {
    const rows = rankLegWorkflows({
      byDynasty: new Map([
        ["never", wf([0, 0, 0], null)],
        ["ran", wf([20, 100, 1], [0, 0, 0])],
      ]),
      names: new Map(),
      assignments: new Map(),
      pipelineUsd: new Map(),
      billedSpendUsd: new Map(),
    });
    expect(rows.map((r) => r.workflowDynastySlug)).toEqual(["ran"]);
    expect(rows[0]).toMatchObject({ assignment: "unassigned", selectable: false });
  });

  it("the return is pipeline ÷ billed spend, null when either is missing or spend is zero", () => {
    const rows = rankLegWorkflows({
      byDynasty: new Map([
        ["a", wf([100, 1000, 2], [100, 1000, 2])],
        ["b", wf([100, 1000, 2], [100, 1000, 2])],
        ["c", wf([100, 1000, 2], [100, 1000, 2])],
      ]),
      names: new Map(),
      assignments: new Map([["a", "active"], ["b", "active"], ["c", "active"]]),
      pipelineUsd: new Map([["a", 500], ["c", 500]]),
      billedSpendUsd: new Map([["a", 100], ["b", 100], ["c", 0]]),
    });
    const roi = Object.fromEntries(rows.map((r) => [r.workflowDynastySlug, r.roiMultiple]));
    expect(roi).toEqual({ a: 5, b: null, c: null });
  });
});
