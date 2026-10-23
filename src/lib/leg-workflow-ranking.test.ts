import { describe, expect, it } from "vitest";
import { legMaturityFigures, outcomeFigures, type LegMaturityFigures } from "./maturity.js";
import { rankLegWorkflows } from "./leg-workflow-ranking.js";
import { orderLegWorkflows } from "./leg-workflow-order.js";

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
    executable: new Set(slugs),
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
      torrent: wf([14, 300, 0], [0, 0, 0]), // learning, no outcome: $14 spent < $45, not proven worse yet
      sirius: wf([60, 300, 0], [0, 0, 0]), // learning, no outcome: $60 spent > $45, proven no better
    });
    expect(rows.map((r) => r.workflowDynastySlug)).toEqual(["raven", "torrent", "nobelium", "azalea", "rudder", "sirius"]);
    expect(rows.find((r) => r.moneyGoesHere)?.workflowDynastySlug).toBe("nobelium");
    expect(rows[0]).toMatchObject({ goesFirst: true, basis: "flash", costPerOutcomeUsd: 14 });
    expect(rows.find((r) => r.workflowDynastySlug === "torrent")).toMatchObject({ costPerOutcomeUsd: null, outcomes: 0 });
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.map((r) => r.place)).toEqual(["explore", "explore", "money", "mature", "proven_worse", "proven_worse"]);
    expect(rows.find((r) => r.workflowDynastySlug === "torrent")!.explorePriceUsd).toBe(14);
    expect(rows.find((r) => r.workflowDynastySlug === "nobelium")!.explorePriceUsd).toBeNull();
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
      executable: new Set(["never", "ran"]),
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
      executable: new Set(["a", "b", "c"]),
      pipelineUsd: new Map([["a", 500], ["c", 500]]),
      billedSpendUsd: new Map([["a", 100], ["b", 100], ["c", 0]]),
    });
    const roi = Object.fromEntries(rows.map((r) => [r.workflowDynastySlug, r.roiMultiple]));
    expect(roi).toEqual({ a: 5, b: null, c: null });
  });

  it("lists a workflow ASSIGNED to the leg before its first run, never an empty list (owner 2026-10-10)", () => {
    const rows = rankLegWorkflows({
      byDynasty: new Map([["raven", wf([14, 400, 1], [0, 0, 0])]]),
      names: new Map(),
      assignments: new Map([["algenib", "active"], ["raven", "active"]]),
      executable: new Set(["algenib", "raven"]),
      pipelineUsd: new Map(),
      billedSpendUsd: new Map(),
    });
    // Nothing mature: ordered on the explore price, so the never-run algenib ($0) goes before raven ($14).
    expect(rows.map((r) => r.workflowDynastySlug)).toEqual(["algenib", "raven"]);
    expect(rows[0]).toMatchObject({ assignment: "active", selectable: true, outcomes: 0, spentUsd: 0, costPerOutcomeUsd: null, basis: "flash" });
  });

  // RANKING-RETIRED-SELECTABLE-1013: allegro/atlantis/bastion read "active, selectable" on a cold email leg while
  // workflow-service had no runnable version of them (every version deprecated) and refused every run with a 410.
  it("a workflow assigned active whose every version is retired is never selectable and sits after every runnable one", () => {
    const rows = rankLegWorkflows({
      byDynasty: new Map([
        ["allegro", wf([10, 1000, 5], [10, 1000, 5])], // mature $2, cheapest, but nothing runs it
        ["lyonesse", wf([50, 1000, 1], [50, 1000, 1])], // mature $50, runnable
      ]),
      names: new Map(),
      assignments: new Map([["allegro", "active"], ["lyonesse", "active"]]),
      executable: new Set(["lyonesse"]),
      pipelineUsd: new Map(),
      billedSpendUsd: new Map(),
    });
    expect(rows.map((r) => r.workflowDynastySlug)).toEqual(["lyonesse", "allegro"]);
    expect(rows[0]).toMatchObject({ selectable: true, executable: true, goesFirst: true, moneyGoesHere: true });
    expect(rows[1]).toMatchObject({ assignment: "active", executable: false, selectable: false, goesFirst: false, moneyGoesHere: false });
  });

  // WF-ORDER-EXPLORE-1018: the Research page's order IS the order campaign-service receives, one computation.
  it("orders with the shared leg order, byte-same as orderLegWorkflows on the same evidence", () => {
    const rows = rank({
      lyonesse: wf([4.49, 326, 14], [4.49, 326, 14]),
      rampart: wf([250, 4022, 160], [250, 4022, 160]),
      acamar: wf([18.26, 108, 1], [0, 0, 0]),
      albaldah: wf([0.94, 1, 0], [0, 0, 0]),
      aldhanab: wf([0, 0, 0], [0, 0, 0]),
      hamal: wf([0, 0, 0], [0, 0, 0]),
    });
    const shared = orderLegWorkflows(
      rows.map((r) => ({
        slug: r.workflowDynastySlug,
        selectable: r.selectable,
        mature: r.basis === "mature" && r.costPerOutcomeUsd ? { tier: 0, costPerOutcomeUsd: r.costPerOutcomeUsd } : null,
        fleet: { spentUsd: r.spentUsd, outcomes: r.outcomes },
      })),
    );
    expect(rows.map((r) => r.workflowDynastySlug)).toEqual(shared);
    expect(shared).toEqual(["aldhanab", "hamal", "lyonesse", "rampart", "albaldah", "acamar"]);
  });
});

// MATURITY-VIEW-1023: the Research page's Mature / Flash view reads every row on ONE half; the order never moves.
describe("rankLegWorkflows figuresByView", () => {
  it("serves each row's figures on both halves whatever its own basis", () => {
    const rows = rank({
      nobelium: wf([45, 1000, 1], [45, 1000, 1]), // mature
      raven: wf([14, 400, 1], [0, 0, 0]), // learning, mature cut holds nothing yet
      lone: wf([9, 50, 0], null), // no mature cut
    });
    const by = (s: string) => rows.find((r) => r.workflowDynastySlug === s)!;
    expect(by("raven").basis).toBe("flash");
    expect(by("raven").figuresByView!.flash).toMatchObject({ half: "flash", outcomes: 1, contacted: 400 });
    expect(by("raven").figuresByView!.mature).toMatchObject({ half: "mature", outcomes: 0, contacted: 0 });
    expect(by("nobelium").figuresByView!.flash.half).toBe("flash");
    expect(by("lone").figuresByView!.mature.half).toBe("flash");
    // the order is the one leg order, untouched
    expect(rows.map((r) => r.workflowDynastySlug)).toEqual(orderLegWorkflows(rows.map((r) => ({ slug: r.workflowDynastySlug, selectable: r.selectable, mature: r.basis === "mature" && r.costPerOutcomeUsd ? { tier: 0, costPerOutcomeUsd: r.costPerOutcomeUsd } : null, fleet: { spentUsd: r.spentUsd, outcomes: r.outcomes } }))));
  });
});
