/**
 * A MISSION'S MATURE PRICE IS READ FINEST GRAIN FIRST (owner rules 2026-09-30, 2026-10-01): offer, then
 * brand, then fleet. The ORDER itself is the shared leg order (`lib/leg-workflow-order.ts`).
 */
import { describe, it, expect } from "vitest";
import { maturePrice, missionPriceOf } from "./mission-workflow-order.js";

const mature = (cost: number | null) => ({ isMature: true, mature: { costPerOutcomeUsd: cost } });
const learning = (cost: number | null) => ({ isMature: false, mature: { costPerOutcomeUsd: cost } });

describe("missionPriceOf", () => {
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

});
