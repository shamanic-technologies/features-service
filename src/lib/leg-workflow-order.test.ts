/**
 * THE LEG ORDER (WF-ORDER-EXPLORE-1018): learning workflows not yet proven worse than the best mature one
 * go first, then the mature ones (finest grain first), then the rest. ONE computation for campaign-service
 * (`workflow-projection?leg=`) and the Research page (`/public/stats/leg-workflow-ranking`).
 *
 * Prod 2026-10-18, `sales-cold-email-outreach` website-visit leg: Lyonesse mature at $0.32 per visit;
 * Aldhanab, Amansinaya, Chertan, Hamal assigned 2026-10-13 with $0 spent read rank 8+ and never ran.
 */
import { describe, it, expect } from "vitest";
import { bestMatureSlug, explorePriceUsd, legWorkflowPlaces, orderLegWorkflows, type LegWorkflowOrderEntry } from "./leg-workflow-order.js";

const m = (slug: string, cost: number, tier = 0, extra: Partial<LegWorkflowOrderEntry> = {}): LegWorkflowOrderEntry => ({
  slug,
  selectable: true,
  mature: { tier, costPerOutcomeUsd: cost },
  fleet: { spentUsd: 1000, outcomes: 100 },
  ...extra,
});
const l = (slug: string, spentUsd: number, outcomes: number, extra: Partial<LegWorkflowOrderEntry> = {}): LegWorkflowOrderEntry => ({
  slug,
  selectable: true,
  mature: null,
  fleet: { spentUsd, outcomes },
  ...extra,
});

describe("explorePriceUsd", () => {
  it("is the flash cost per outcome with outcomes, the spend with none, $0 for a workflow never run", () => {
    expect(explorePriceUsd({ spentUsd: 18.26, outcomes: 1 })).toBe(18.26);
    expect(explorePriceUsd({ spentUsd: 10, outcomes: 4 })).toBe(2.5);
    expect(explorePriceUsd({ spentUsd: 0.94, outcomes: 0 })).toBe(0.94);
    expect(explorePriceUsd({ spentUsd: 0, outcomes: 0 })).toBe(0);
  });
});

describe("orderLegWorkflows", () => {
  it("prod 2026-10-18: never-run workflows go above the best mature one; spent-and-barren ones below", () => {
    const order = orderLegWorkflows([
      m("lyonesse", 0.32),
      m("rampart", 1.56),
      m("osprey", 1.91),
      l("acamar", 18.26, 1),
      l("albaldah", 0.94, 0),
      l("aldhanab", 0, 0),
      l("amansinaya", 0, 0),
      l("chertan", 0, 0),
      l("hamal", 0, 0),
      l("estuary", 0.03, 0),
    ]);
    expect(order).toEqual(["aldhanab", "amansinaya", "chertan", "hamal", "estuary", "lyonesse", "rampart", "osprey", "albaldah", "acamar"]);
  });

  it("owner 2026-10-01: a learning workflow cheaper than the best mature sits above it; a dearer one below", () => {
    const order = orderLegWorkflows([m("osprey", 2.26), m("rampart", 3), l("lyonesse", 3, 2), l("estuary", 6, 2), l("azalea", 8, 2)]);
    expect(order).toEqual(["lyonesse", "osprey", "rampart", "estuary", "azalea"]);
  });

  it("mature workflows go finest grain first (offer, brand, fleet), cheapest first inside a grain", () => {
    const order = orderLegWorkflows([m("fleet-cheap", 1, 2), m("offer-proven", 30, 0), m("brand-proven", 2, 1), m("offer-cheap", 20, 0)]);
    expect(order).toEqual(["offer-cheap", "offer-proven", "brand-proven", "fleet-cheap"]);
  });

  it("the bar is the BEST mature workflow's price (finest grain), not a cheaper coarse one", () => {
    const order = orderLegWorkflows([m("offer-proven", 30, 0), m("fleet-only", 0.5, 2), l("learner", 10, 1)]);
    expect(order).toEqual(["learner", "offer-proven", "fleet-only"]);
  });

  it("a learning workflow that spent exactly the bar without an outcome is proven no better: below", () => {
    expect(orderLegWorkflows([m("best", 2), l("barren", 2, 0)])).toEqual(["best", "barren"]);
  });

  it("with nothing mature, every workflow is ordered on its explore price", () => {
    expect(orderLegWorkflows([l("b", 9, 1), l("a", 1, 1), l("never", 0, 0)])).toEqual(["never", "a", "b"]);
  });

  it("a non-selectable workflow sorts after every selectable one, in the same order among themselves", () => {
    const order = orderLegWorkflows([
      m("cheap-deprecated", 0.1, 0, { selectable: false }),
      l("never-ran-deprecated", 0, 0, { selectable: false }),
      l("never-ran", 0, 0),
      m("priced", 90),
    ]);
    expect(order).toEqual(["never-ran", "priced", "never-ran-deprecated", "cheap-deprecated"]);
  });

  it("ties break on the slug, so the order is total", () => {
    expect(orderLegWorkflows([m("b", 5), m("a", 5), l("d", 0, 0), l("c", 0, 0)])).toEqual(["c", "d", "a", "b"]);
  });

  it("bestMatureSlug names the money workflow among the selectable ones only", () => {
    expect(bestMatureSlug([m("deprecated", 0.1, 0, { selectable: false }), m("b", 3), l("x", 0, 0)])).toBe("b");
    expect(bestMatureSlug([l("x", 0, 0)])).toBeNull();
  });

  it("legWorkflowPlaces says why each row stands where it does", () => {
    const places = legWorkflowPlaces([m("best", 1), m("other", 5), l("fresh", 0, 0), l("barren", 3, 0), m("retired", 0.5, 0, { selectable: false })]);
    expect(Object.fromEntries(places)).toEqual({ best: "money", other: "mature", fresh: "explore", barren: "proven_worse", retired: "cannot_run" });
    expect(legWorkflowPlaces([l("a", 9, 1)]).get("a")).toBe("explore");
  });
});

