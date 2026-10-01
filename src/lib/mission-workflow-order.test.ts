/**
 * A MISSION'S WORKFLOWS ARE ORDERED ON MATURE COST PER OUTCOME, FINEST GRAIN FIRST (owner rules
 * 2026-09-30, 2026-10-01): offer, then brand, then fleet; the slug only after every price.
 *
 * #1227 prod shape, brand 75d7e3e8… / campaign 07ba2403… / leg start_to_conversation: the offer read helm
 * learning, lithium mature at $131 and ballad mature at $67 — the mission must lead with ballad, lithium.
 *
 * 2026-10-01 prod shape, brand c4b5284d… / campaign 583a4e74… / leg start_to_website_visit: a 2-day-old
 * mission, nothing mature on the offer or the brand; osprey $2.26 per visit on the fleet, dawn $4.73.
 * The old order tied every workflow and read the alphabet (estuary first, osprey 14th).
 */
import { describe, it, expect } from "vitest";
import { orderMissionWorkflows, maturePrice, missionPriceOf, type MissionWorkflowEntry } from "./mission-workflow-order.js";

const mature = (cost: number | null) => ({ isMature: true, mature: { costPerOutcomeUsd: cost } });
const learning = (cost: number | null) => ({ isMature: false, mature: { costPerOutcomeUsd: cost } });

let position = 0;
const entry = (slug: string, grains: MissionWorkflowEntry["grains"], extra: Partial<MissionWorkflowEntry> = {}): MissionWorkflowEntry => ({
  slug,
  excluded: false,
  grains,
  fallbackPosition: position++,
  ...extra,
});

describe("orderMissionWorkflows", () => {
  it("#1227 regression: an offer with mature evidence leads on the offer's own mature cost", () => {
    const order = orderMissionWorkflows([
      entry("helm", { offer: learning(82), crossOrg: learning(9) }),
      entry("lithium", { offer: mature(131), crossOrg: mature(40) }),
      entry("cerulean", { offer: learning(null) }),
      entry("torrent", {}),
      entry("ballad", { offer: mature(67), crossOrg: mature(90) }),
    ]);
    expect(order.slice(0, 2)).toEqual(["ballad", "lithium"]);
  });

  it("a young offer falls back to the fleet's mature price, never to the alphabet", () => {
    const order = orderMissionWorkflows([
      entry("dawn", { offer: learning(10), brand: learning(10), crossOrg: mature(4.73) }),
      entry("estuary", { crossOrg: learning(1) }),
      entry("geyser", { crossOrg: learning(null) }),
      entry("osprey", { offer: learning(16.87), brand: learning(16.87), crossOrg: mature(2.26) }),
      entry("pelican", { crossOrg: mature(3.1) }),
    ]);
    expect(order.slice(0, 3)).toEqual(["osprey", "pelican", "dawn"]);
  });

  it("an offer-mature workflow beats a cheaper one that is mature only on a coarser grain", () => {
    const order = orderMissionWorkflows([
      entry("fleet-cheap", { offer: learning(1), brand: mature(2), crossOrg: mature(1) }),
      entry("offer-proven", { offer: mature(30), crossOrg: mature(20) }),
      entry("fleet-only", { crossOrg: mature(0.5) }),
    ]);
    expect(order).toEqual(["offer-proven", "fleet-cheap", "fleet-only"]);
  });

  it("workflows with no mature price keep the general order; the slug breaks a tie only after every price", () => {
    const order = orderMissionWorkflows([
      { slug: "b", excluded: false, grains: { crossOrg: mature(5) }, fallbackPosition: 9 },
      { slug: "a", excluded: false, grains: { crossOrg: mature(5) }, fallbackPosition: 8 },
      { slug: "zz-measured-cheap", excluded: false, grains: { crossOrg: learning(1) }, fallbackPosition: 0 },
      { slug: "aa-never-ran", excluded: false, grains: {}, fallbackPosition: 1 },
    ]);
    expect(order).toEqual(["a", "b", "zz-measured-cheap", "aa-never-ran"]);
  });

  it("a learning figure is never a price, however cheap", () => {
    expect(maturePrice(learning(1))).toBeNull();
    expect(maturePrice({ isMature: null, mature: null })).toBeNull();
    expect(maturePrice(mature(0))).toBeNull();
    expect(maturePrice(mature(null))).toBeNull();
    expect(maturePrice(mature(67))).toBe(67);
    expect(missionPriceOf({ grains: { offer: learning(1), brand: mature(7), crossOrg: mature(3) } })).toEqual({
      grain: "brand",
      costPerOutcomeUsd: 7,
    });
  });

  it("a non-selectable workflow sorts after every selectable one, even when priced cheapest", () => {
    const order = orderMissionWorkflows([
      entry("cheap-deprecated", { offer: mature(5) }, { excluded: true }),
      entry("never-ran", {}),
      entry("priced", { offer: mature(90) }),
    ]);
    expect(order).toEqual(["priced", "never-ran", "cheap-deprecated"]);
  });

  it("retired lineages go last", () => {
    expect(
      orderMissionWorkflows([
        entry("z-retired", { offer: mature(1) }, { retired: true }),
        entry("b", { offer: mature(50) }),
        entry("a", { offer: mature(50) }),
      ]),
    ).toEqual(["a", "b", "z-retired"]);
  });
});
