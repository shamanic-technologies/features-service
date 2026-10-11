import { describe, expect, it } from "vitest";
import { cashFundedDailyCents } from "./cash-funded-spend.js";

const days = (o: Record<string, number>) => new Map(Object.entries(o));

describe("cashFundedDailyCents — revenue is cash the client paid (owner rule 2026-10-11)", () => {
  it("an org that never paid has no revenue, whatever it consumed (Aireena: $9.51 of a $30 advance)", () => {
    expect([...cashFundedDailyCents(days({ "2026-10-01": 500, "2026-10-02": 451 }), { cashPaidCents: 0, nonCashCreditCents: 3000 })]).toEqual([]);
  });

  it("non-cash credit is consumed first, then cash; a day keeps only what cash funded", () => {
    const out = cashFundedDailyCents(days({ "2026-09-02": 2000, "2026-09-01": 2000, "2026-09-03": 2000 }), {
      cashPaidCents: 3000,
      nonCashCreditCents: 3000,
    });
    expect([...out]).toEqual([
      ["2026-09-02", 1000],
      ["2026-09-03", 2000],
    ]);
  });

  it("spend past cash + credit (postpaid, not charged yet) is not revenue until the charge lands", () => {
    const out = cashFundedDailyCents(days({ "2026-09-01": 5000, "2026-09-02": 5000 }), { cashPaidCents: 6000, nonCashCreditCents: 0 });
    expect([...out]).toEqual([
      ["2026-09-01", 5000],
      ["2026-09-02", 1000],
    ]);
  });

  it("a fully cash-funded org keeps every day unchanged", () => {
    const d = days({ "2026-09-01": 123, "2026-09-02": 456 });
    expect([...cashFundedDailyCents(d, { cashPaidCents: 10_000, nonCashCreditCents: 0 })]).toEqual([...d]);
  });
});
