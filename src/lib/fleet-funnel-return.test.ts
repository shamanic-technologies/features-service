import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  buildFunnelReturnOnSpend,
  MIN_FUNNEL_RETURN_BRANDS,
  type BrandFunnelReturnRow,
} from "./fleet-funnel-return.js";
import type { SalesFunnelKey } from "./sales-funnels.js";

const FUNNEL: SalesFunnelKey = "sales_meetings_from_conversation";

/**
 * A brand that spent `spend` on the channel and is expected to return `spend * multiple` through the
 * funnel, off `clients` expected paying clients (null = it states no lifetime revenue per client).
 */
const at = (
  brandId: string,
  spend: number,
  multiple: number | null,
  clients: number | null = 1,
): BrandFunnelReturnRow => ({
  brandId,
  funnelKey: FUNNEL,
  committedSpendUsd: spend,
  expectedPipelineUsd: multiple === null ? null : spend * multiple,
  expectedPaidClients: clients,
});

describe("the median return on spend through ONE sales funnel", () => {
  it("is the MIDDLE brand's return, not the mean — one brand near zero must not carry the pair", () => {
    // The production shape this exists to fix: four brands at 2x-ish and one at 0.02x. Median ~2,
    // mean ~1.6 and falling with the outlier — and the projected surface beside it reads 0.7x.
    const rows = [at("a", 1000, 0.02), at("b", 1000, 1.8), at("c", 1000, 2), at("d", 1000, 2.2), at("e", 1000, 3)];
    const out = buildFunnelReturnOnSpend(rows, 100);
    expect(out.measured).toBe(true);
    expect(out.reason).toBeNull();
    expect(out.medianReturnPerDollar).toBeCloseTo(2, 10);
    expect(out.brandCount).toBe(5);
    // The spread rides beside it so a consumer can show the bulk rather than one scalar.
    expect(out.minReturnPerDollar).toBeCloseTo(0.02, 10);
    expect(out.maxReturnPerDollar).toBeCloseTo(3, 10);
    expect(out.p25ReturnPerDollar).toBeCloseTo(1.8, 10);
    expect(out.p75ReturnPerDollar).toBeCloseTo(2.2, 10);
  });

  it("counts a brand's return on ITS OWN spend — a big spender does not weight the median", () => {
    const rows = [at("a", 100_000, 1), at("b", 100_000, 1), at("c", 100_000, 1), at("d", 1000, 100)];
    expect(buildFunnelReturnOnSpend(rows, 100).medianReturnPerDollar).toBeCloseTo(1, 10);
  });

  it("states the median cost per PAYING CLIENT on the same population", () => {
    // Spend ÷ clients: 100, 200, 300 → 200.
    const rows = [at("a", 1000, 2, 10), at("b", 1000, 2, 5), at("c", 1000, 2, 3.3333333333333335)];
    const out = buildFunnelReturnOnSpend(rows, 100);
    expect(out.medianCostPerPaidClientUsd).toBeCloseTo(200, 6);
    expect(out.costPerPaidClientBrandCount).toBe(3);
  });

  it("states a return while the cost per paying client stays NULL when too few brands price a client", () => {
    // All three return; only one states a lifetime revenue. A cost per client over one brand would be
    // that brand's own economics printed publicly, so it is not stated — and the return still is.
    const rows = [at("a", 1000, 2, null), at("b", 1000, 3, null), at("c", 1000, 4, 5)];
    const out = buildFunnelReturnOnSpend(rows, 100);
    expect(out.measured).toBe(true);
    expect(out.medianReturnPerDollar).toBeCloseTo(3, 10);
    expect(out.medianCostPerPaidClientUsd).toBeNull();
    expect(out.costPerPaidClientBrandCount).toBe(1);
  });

  it("drops a brand whose pipeline is NULL — it is not a 0, and a 0 would drag the median down", () => {
    const priced = [at("a", 1000, 2), at("b", 1000, 3), at("c", 1000, 4)];
    const withNull = buildFunnelReturnOnSpend([...priced, at("d", 1000, null)], 100);
    expect(withNull.brandCount).toBe(3);
    expect(withNull.medianReturnPerDollar).toBeCloseTo(3, 10);
    // Had the unpriced brand been folded in as a 0, the median would have moved to 2.5.
    const asZero = buildFunnelReturnOnSpend([...priced, at("d", 1000, 0)], 100);
    expect(asZero.medianReturnPerDollar).toBeCloseTo(2.5, 10);
  });

  it("makes the spend floor the population — one row set answers at two floors", () => {
    const rows = [at("a", 50, 10), at("b", 60, 10), at("c", 70, 10), at("d", 1000, 2), at("e", 2000, 2), at("f", 3000, 2)];
    const low = buildFunnelReturnOnSpend(rows, 10);
    expect(low.brandCount).toBe(6);
    expect(low.medianReturnPerDollar).toBeCloseTo(6, 10);
    const high = buildFunnelReturnOnSpend(rows, 100);
    expect(high.brandCount).toBe(3);
    expect(high.medianReturnPerDollar).toBeCloseTo(2, 10);
  });

  it("applies the floor INCLUSIVELY — a brand exactly at it is in the population", () => {
    const rows = [at("a", 100, 1), at("b", 100, 2), at("c", 100, 3)];
    expect(buildFunnelReturnOnSpend(rows, 100).brandCount).toBe(3);
  });

  it("drops a zero-spend brand — there is no dollar to state a return on", () => {
    const rows = [at("a", 0, 5), at("b", 1000, 2), at("c", 1000, 3), at("d", 1000, 4)];
    const out = buildFunnelReturnOnSpend(rows, 0);
    expect(out.brandCount).toBe(3);
  });

  it("tells the two unmeasurable answers APART, and never states a figure for either", () => {
    const nothing = buildFunnelReturnOnSpend(null, 100);
    expect(nothing).toMatchObject({
      measured: false,
      reason: "no_snapshot_yet",
      brandCount: 0,
      medianReturnPerDollar: null,
      medianCostPerPaidClientUsd: null,
    });

    const thin = buildFunnelReturnOnSpend([at("a", 1000, 2), at("b", 1000, 3)], 100);
    expect(thin).toMatchObject({ measured: false, reason: "not_enough_brands", brandCount: 2 });
    expect(thin.medianReturnPerDollar).toBeNull();
    // The count is still stated when it is too few — that is how a consumer says "1 client, not enough".
    expect(thin.p25ReturnPerDollar).toBeNull();
    expect(thin.maxReturnPerDollar).toBeNull();
  });

  it("holds the pair to a bar of three brands — a median over two is one customer's economics", () => {
    expect(MIN_FUNNEL_RETURN_BRANDS).toBe(3);
    const two = [at("a", 1000, 2), at("b", 1000, 3)];
    expect(buildFunnelReturnOnSpend(two, 100).measured).toBe(false);
    expect(buildFunnelReturnOnSpend([...two, at("c", 1000, 4)], 100).measured).toBe(true);
  });

  it("echoes the floor it was asked for, measured or not", () => {
    expect(buildFunnelReturnOnSpend(null, 42).minSpendUsd).toBe(42);
    expect(buildFunnelReturnOnSpend([at("a", 1000, 2), at("b", 1000, 3), at("c", 1000, 4)], 42).minSpendUsd).toBe(42);
  });
});
