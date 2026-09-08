import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  buildFleetReturnOnSpend,
  parseMinSpendUsd,
  DEFAULT_MIN_SPEND_USD,
  MIN_RETURN_BRANDS,
  type BrandReturnRow,
} from "./fleet-return-on-spend.js";

/** A brand that spent `spend` and is expected to return `spend * multiple`. */
const at = (brandId: string, spend: number, multiple: number | null): BrandReturnRow => ({
  brandId,
  committedSpendUsd: spend,
  expectedPipelineUsd: multiple === null ? null : spend * multiple,
});

describe("the fleet median return on spend", () => {
  it("is the MIDDLE brand's return, not the mean — a few outliers must not carry the figure", () => {
    // Five brands at 1x, 2x, 3x, 40x, 57x. Median 3, mean 20.6 — the mean describes nobody here.
    const rows = [at("a", 1000, 1), at("b", 1000, 2), at("c", 1000, 3), at("d", 1000, 40), at("e", 1000, 57)];
    const out = buildFleetReturnOnSpend(rows, 100);
    expect(out.measured).toBe(true);
    expect(out.medianReturnPerDollar).toBeCloseTo(3, 10);
    expect(out.brandCount).toBe(5);
    // The spread rides beside it so a consumer can show the bulk rather than one scalar.
    expect(out.minReturnPerDollar).toBeCloseTo(1, 10);
    expect(out.maxReturnPerDollar).toBeCloseTo(57, 10);
    expect(out.p25ReturnPerDollar).toBeCloseTo(2, 10);
    expect(out.p75ReturnPerDollar).toBeCloseTo(40, 10);
  });

  it("counts a brand's return on ITS OWN spend — a big spender does not weight the median", () => {
    // The 100x brand spent a hundredth of what the 1x brands spent; unweighted, it is still one vote.
    const rows = [at("a", 100_000, 1), at("b", 100_000, 1), at("c", 100_000, 1), at("d", 100_000, 1), at("e", 1000, 100)];
    const out = buildFleetReturnOnSpend(rows, 100);
    expect(out.medianReturnPerDollar).toBeCloseTo(1, 10);
  });

  it("EXCLUDES brands under the spend floor — that is the whole reason the floor exists", () => {
    // Six barely-started brands whose ratios are noise, plus five real ones at 2x..6x.
    const noise = [10, 20, 30, 40, 50, 99].map((s, i) => at(`noise${i}`, s, 500));
    const real = [2, 3, 4, 5, 6].map((m, i) => at(`real${i}`, 5000, m));
    const out = buildFleetReturnOnSpend([...noise, ...real], 100);
    expect(out.brandCount).toBe(5);
    expect(out.medianReturnPerDollar).toBeCloseTo(4, 10);
    // Without the floor the noise dominates and the answer is a different figure entirely.
    const unfloored = buildFleetReturnOnSpend([...noise, ...real], 0);
    expect(unfloored.brandCount).toBe(11);
    expect(unfloored.medianReturnPerDollar).toBeCloseTo(500, 10);
  });

  it("includes a brand sitting EXACTLY on the floor — the floor is inclusive", () => {
    const rows = [100, 100, 100, 100, 100].map((s, i) => at(`b${i}`, s, i + 1));
    const out = buildFleetReturnOnSpend(rows, 100);
    expect(out.brandCount).toBe(5);
    expect(out.medianReturnPerDollar).toBeCloseTo(3, 10);
  });

  it("gives a brand with NO usable economics no data point — a null pipeline is never a 0", () => {
    // Six qualifying brands, one of which cannot be priced. Folding it in as 0 would drag the median.
    const rows = [
      at("a", 1000, 2),
      at("b", 1000, 4),
      at("c", 1000, 6),
      at("d", 1000, 8),
      at("e", 1000, 10),
      at("unpriced", 1000, null),
    ];
    const out = buildFleetReturnOnSpend(rows, 100);
    expect(out.brandCount).toBe(5);
    expect(out.medianReturnPerDollar).toBeCloseTo(6, 10);

    const asZero = buildFleetReturnOnSpend([...rows.slice(0, 5), at("unpriced", 1000, 0)], 100);
    expect(asZero.medianReturnPerDollar).toBeCloseTo(5, 10);
    expect(asZero.medianReturnPerDollar).not.toBeCloseTo(out.medianReturnPerDollar!, 10);
  });

  it("says NOT ENOUGH BRANDS rather than widening the population or answering 0", () => {
    const rows = [at("a", 1000, 3), at("b", 1000, 4)];
    const out = buildFleetReturnOnSpend(rows, 100);
    expect(out.measured).toBe(false);
    expect(out.reason).toBe("not_enough_brands");
    expect(out.medianReturnPerDollar).toBeNull();
    expect(out.p25ReturnPerDollar).toBeNull();
    expect(out.maxReturnPerDollar).toBeNull();
    // The count is still stated, so a consumer can say how thin the evidence was.
    expect(out.brandCount).toBe(2);
    // And the floor it was asked at is echoed even on the unmeasurable answer.
    expect(out.minSpendUsd).toBe(100);
  });

  it("tells NO SNAPSHOT YET apart from a snapshot whose population is too thin", () => {
    const none = buildFleetReturnOnSpend(null, 100);
    expect(none.measured).toBe(false);
    expect(none.reason).toBe("no_snapshot_yet");
    expect(none.brandCount).toBe(0);

    const thin = buildFleetReturnOnSpend([at("a", 1000, 3)], 100);
    expect(thin.reason).toBe("not_enough_brands");
    // A caller acts differently on each, so the two must never collapse into one word.
    expect(thin.reason).not.toBe(none.reason);
  });

  it("treats an EMPTY snapshot as too few brands, not as a missing one", () => {
    const out = buildFleetReturnOnSpend([], 100);
    expect(out.reason).toBe("not_enough_brands");
    expect(out.brandCount).toBe(0);
  });

  it("drops a brand with zero spend — its return is a division by nothing, not an infinite one", () => {
    const rows = [
      at("zero", 0, 5),
      ...[2, 3, 4, 5, 6].map((m, i) => at(`b${i}`, 1000, m)),
    ];
    const out = buildFleetReturnOnSpend(rows, 0);
    expect(out.brandCount).toBe(5);
    expect(Number.isFinite(out.maxReturnPerDollar!)).toBe(true);
    expect(out.medianReturnPerDollar).toBeCloseTo(4, 10);
  });

  it("answers at ANY floor from the SAME rows — the floor is a parameter of the question", () => {
    const rows = [
      ...[1, 2, 3, 4, 5].map((m, i) => at(`small${i}`, 150, m)),
      ...[10, 11, 12, 13, 14].map((m, i) => at(`big${i}`, 5000, m)),
    ];
    expect(buildFleetReturnOnSpend(rows, 100).brandCount).toBe(10);
    expect(buildFleetReturnOnSpend(rows, 1000).brandCount).toBe(5);
    expect(buildFleetReturnOnSpend(rows, 1000).medianReturnPerDollar).toBeCloseTo(12, 10);
  });

  it("interpolates the median across an even population", () => {
    const rows = [2, 4, 6, 8, 10, 12].map((m, i) => at(`b${i}`, 1000, m));
    // Middle two are 6 and 8.
    expect(buildFleetReturnOnSpend(rows, 100).medianReturnPerDollar).toBeCloseTo(7, 10);
  });

  it("requires MIN_RETURN_BRANDS qualifying brands, and the bar is overridable for a caller that states its own", () => {
    const rows = Array.from({ length: MIN_RETURN_BRANDS - 1 }, (_, i) => at(`b${i}`, 1000, i + 1));
    expect(buildFleetReturnOnSpend(rows, 100).measured).toBe(false);
    expect(buildFleetReturnOnSpend(rows, 100, MIN_RETURN_BRANDS - 1).measured).toBe(true);
  });
});

describe("?minSpendUsd= parsing", () => {
  it("defaults to the $100 floor when absent, so a caller that names nothing still gets a real population", () => {
    expect(parseMinSpendUsd(undefined)).toBe(DEFAULT_MIN_SPEND_USD);
    expect(parseMinSpendUsd("")).toBe(DEFAULT_MIN_SPEND_USD);
    expect(DEFAULT_MIN_SPEND_USD).toBe(100);
  });

  it("accepts a stated floor, including zero", () => {
    expect(parseMinSpendUsd("250")).toBe(250);
    expect(parseMinSpendUsd("0")).toBe(0);
    expect(parseMinSpendUsd("12.5")).toBe(12.5);
  });

  it("REFUSES a value it cannot read rather than quietly using the default", () => {
    expect(parseMinSpendUsd("lots")).toBeNull();
    expect(parseMinSpendUsd("-1")).toBeNull();
    expect(parseMinSpendUsd("NaN")).toBeNull();
    expect(parseMinSpendUsd("Infinity")).toBeNull();
  });
});
