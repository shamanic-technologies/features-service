import { describe, it, expect, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const { warmUrlsFor } = await import("./funnel-campaign-warm.js");

describe("warmUrlsFor", () => {
  const base = "/brands/b1/sales-funnel-campaigns";
  it("the dashboard's offer shape first, then brand-wide, then recorded shapes of that offer or all; never a copy read or another brand/offer", () => {
    expect(
      warmUrlsFor("b1", "of1", [
        `${base}?offerId=of1&pricing=net`,
        `${base}?offerId=of1`,
        `${base}?offerId=of2&pricing=net`,
        `${base}?fields=copy&offerId=of1`,
        `/brands/b2/sales-funnel-campaigns?pricing=net`,
        `${base}/x/activity?pricing=net`,
      ]),
    ).toEqual([`${base}?offerId=of1&pricing=net`, `${base}?pricing=net`, `${base}?offerId=of1`]);
  });
  it("no offer = brand-wide shapes only", () => {
    expect(warmUrlsFor("b1", null, [`${base}?offerId=of1&pricing=net`, `${base}?pricing=gross`])).toEqual([`${base}?pricing=net`, `${base}?pricing=gross`]);
  });
});
