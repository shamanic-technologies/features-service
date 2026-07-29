import { describe, it, expect } from "vitest";
import {
  observedCostPerOutcome,
  projectedCostPerOutcome,
  flooredCostPerOutcome,
  derivedCostPerOutcome,
} from "./cost-engine.js";

describe("cost-engine — observedCostPerOutcome (accounting: real, null on 0)", () => {
  it("real ratio when spend and outcomes present", () => {
    expect(observedCostPerOutcome(100, 4)).toBe(25);
  });

  it("null when 0 outcomes (never a false $0)", () => {
    expect(observedCostPerOutcome(100, 0)).toBeNull();
  });

  it("null when 0 spend", () => {
    expect(observedCostPerOutcome(0, 4)).toBeNull();
  });
});

describe("cost-engine — projectedCostPerOutcome (rankable: cascade floor, never null)", () => {
  it("real ratio when outcomes present — parent is ignored", () => {
    expect(projectedCostPerOutcome(100, 4, 999)).toBe(25);
  });

  it("0 SPEND but outcomes present (cost un-attributed) → NOT a false $0; floors to parent", () => {
    expect(projectedCostPerOutcome(0, 4, 30)).toBe(30); // clicks tracked, cost untagged → assume parent
    expect(projectedCostPerOutcome(0, 4, null)).toBe(0); // no parent → 0 (no evidence at all)
  });

  it("0 outcomes, no parent → floor to own spend", () => {
    expect(projectedCostPerOutcome(120, 0)).toBe(120);
    expect(projectedCostPerOutcome(5, 0, null)).toBe(5);
  });

  it("0 outcomes, spend BELOW parent → assume the parent cost (not yet proven worse)", () => {
    // $5 spent, 0 outcomes, parent cpc $30 → $30
    expect(projectedCostPerOutcome(5, 0, 30)).toBe(30);
  });

  it("0 outcomes, spend ABOVE parent → own spend is the higher conservative floor", () => {
    // $120 spent, 0 outcomes, parent cpc $30 → $120
    expect(projectedCostPerOutcome(120, 0, 30)).toBe(120);
  });

  it("never null — always a comparable number at any spend", () => {
    expect(projectedCostPerOutcome(0, 0, null)).toBe(0);
    expect(projectedCostPerOutcome(0, 0, 30)).toBe(30);
  });
});

describe("cost-engine — flooredCostPerOutcome (display: floored on spend, null only when truly empty)", () => {
  it("real observed ratio when spend and outcomes present — parent ignored", () => {
    expect(flooredCostPerOutcome(100, 4, 999)).toBe(25);
    expect(flooredCostPerOutcome(100, 4)).toBe(25);
  });

  it("0 outcomes with spend BELOW parent → the brand parent floor (never dips below the projection)", () => {
    expect(flooredCostPerOutcome(5, 0, 30)).toBe(30);
  });

  it("0 outcomes with spend ABOVE parent → own spend (never looks artificially free)", () => {
    expect(flooredCostPerOutcome(120, 0, 30)).toBe(120);
  });

  it("0 outcomes, no parent → own spend (base case of the cascade), never null when there is spend", () => {
    expect(flooredCostPerOutcome(120, 0)).toBe(120);
    expect(flooredCostPerOutcome(5, 0, null)).toBe(5);
  });

  it("0 spend but outcomes present (cost un-attributed) → the brand parent, null when no parent (no false $0)", () => {
    expect(flooredCostPerOutcome(0, 4, 30)).toBe(30);
    expect(flooredCostPerOutcome(0, 4, null)).toBeNull();
  });

  it("0 spend AND 0 outcomes → the parent benchmark (same as its barely-started siblings); null only with no parent", () => {
    // Never-started is not a distinct regime from barely-started: both are un-evidenced and both floor to
    // the benchmark. Showing one the parent and the other "-" is the "three priced, one blank" split for
    // four equally unstarted audiences — and the Strategy page shows all four the same benchmark row.
    expect(flooredCostPerOutcome(0, 0, 30)).toBe(30);
    expect(flooredCostPerOutcome(0, 0, null)).toBeNull();
  });
});

describe("cost-engine — derivedCostPerOutcome (display, FUNNEL columns: evidence before spend)", () => {
  // The prod bug (2026-07-29): an audience with $23.16 of spend, 3 observed clicks and 0 form
  // submissions displayed $23.16 as its cost PER FORM SUBMISSION — a raw dollar total answering a
  // per-outcome question, with its 3 clicks thrown away. The funnel projection of its own resolved click
  // cost is the evidence-grounded answer, and the one the Strategy surface resolves for it.
  it("ZERO outcomes WITH observed clicks → the funnel projection, never the raw dollar total", () => {
    expect(derivedCostPerOutcome(23.16, 0, 11.24, 15.55)).toBe(11.24);
    expect(derivedCostPerOutcome(23.16, 0, 11.24, 15.55)).not.toBe(23.16);
  });

  it("ZERO outcomes with NO projection (cold start: no economics) → the raw cascade floor", () => {
    // Only legitimate use of a raw dollar total: there is no funnel to project through, so nothing on the
    // projection surface to be coherent with either.
    expect(derivedCostPerOutcome(23.16, 0, null, 15.55)).toBe(23.16); // own spend wins above the parent
    expect(derivedCostPerOutcome(5, 0, null, 15.55)).toBe(15.55); // below the parent → the parent
    expect(derivedCostPerOutcome(5, 0, null, null)).toBe(5); // no parent → own spend (base case)
  });

  it("outcome OBSERVED → the real measured ratio; projection and parent are ignored", () => {
    expect(derivedCostPerOutcome(100, 4, 11.24, 15.55)).toBe(25);
  });

  it("0 spend AND 0 outcomes → the SAME projection its barely-started siblings get, null only with nothing to fall back on", () => {
    // An unstarted audience and one that spent a few cents are equally un-evidenced. Blanking only the
    // unstarted one splits equally-unstarted audiences into "priced" and "-", while the Strategy page
    // shows every one of them the same benchmark row.
    expect(derivedCostPerOutcome(0, 0, 11.24, 15.55)).toBe(11.24);
    expect(derivedCostPerOutcome(0, 0, null, 15.55)).toBe(15.55); // no projection → the raw parent
    expect(derivedCostPerOutcome(0, 0, null, null)).toBeNull(); // nothing to fall back on → "-"
  });

  it("0 spend but outcomes present (cost un-attributed) → the projection, else null (no false $0)", () => {
    expect(derivedCostPerOutcome(0, 4, 11.24, 15.55)).toBe(11.24);
    expect(derivedCostPerOutcome(0, 4, null, null)).toBeNull();
  });

  it("a non-positive projection is not a value — falls through to the cascade floor", () => {
    expect(derivedCostPerOutcome(23.16, 0, 0, 15.55)).toBe(23.16);
  });
});
