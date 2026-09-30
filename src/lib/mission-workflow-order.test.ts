/**
 * A MISSION'S WORKFLOWS ARE ORDERED ON THE OFFER'S OWN COST PER OUTCOME (owner rule 2026-09-30).
 *
 * Prod shape, brand 75d7e3e8… / campaign 07ba2403… / leg start_to_conversation: the old order put helm
 * first on ONE audience cell ($9.46, 1 reply) while the offer read helm learning, lithium mature at $131
 * and ballad mature at $67; cerulean had spent $334 for 0 replies and torrent/raven/concerto never ran
 * for the offer. The mission order must read ballad, lithium, then every learning / never-run workflow.
 */
import { describe, it, expect } from "vitest";
import { orderMissionWorkflows, offerPrice, type MissionWorkflowEntry } from "./mission-workflow-order.js";

const mature = (cost: number | null) => ({ isMature: true, mature: { costPerOutcomeUsd: cost } });
const learning = (cost: number | null) => ({ isMature: false, mature: { costPerOutcomeUsd: cost } });

const PROD: MissionWorkflowEntry[] = [
  // Listed in the OLD served order (cheapest audience cell / fleet spend), to prove nothing of it survives.
  { slug: "helm", excluded: false, offer: learning(82) },
  { slug: "lithium", excluded: false, offer: mature(131) },
  { slug: "cerulean", excluded: false, offer: learning(null) },
  { slug: "torrent", excluded: false, offer: null },
  { slug: "ballad", excluded: false, offer: mature(67) },
  { slug: "raven", excluded: false, offer: null },
  { slug: "concerto", excluded: false, offer: null },
];

describe("orderMissionWorkflows", () => {
  it("orders the prod mission ascending on the offer's mature cost, learning and never-run after", () => {
    expect(orderMissionWorkflows(PROD)).toEqual([
      "ballad", // $67 mature
      "lithium", // $131 mature
      "cerulean", // offer evidence, 0 outcomes: never priced on its $334 spend
      "helm", // learning on the offer: its cheap audience cell does not count
      "concerto",
      "raven",
      "torrent", // never ran for this offer
    ]);
  });

  it("a learning figure is never a price, however cheap", () => {
    expect(offerPrice(learning(1))).toBeNull();
    expect(offerPrice({ isMature: null, mature: null })).toBeNull();
    expect(offerPrice(mature(0))).toBeNull();
    expect(offerPrice(mature(null))).toBeNull();
    expect(offerPrice(mature(67))).toBe(67);
  });

  it("a non-selectable workflow sorts after every selectable one, even when priced cheapest", () => {
    const order = orderMissionWorkflows([
      { slug: "cheap-deprecated", excluded: true, offer: mature(5) },
      { slug: "never-ran", excluded: false, offer: null },
      { slug: "priced", excluded: false, offer: mature(90) },
    ]);
    expect(order).toEqual(["priced", "never-ran", "cheap-deprecated"]);
  });

  it("retired lineages go last and ties break on the slug", () => {
    expect(
      orderMissionWorkflows([
        { slug: "z-retired", excluded: false, retired: true, offer: mature(1) },
        { slug: "b", excluded: false, offer: mature(50) },
        { slug: "a", excluded: false, offer: mature(50) },
      ]),
    ).toEqual(["a", "b", "z-retired"]);
  });
});
