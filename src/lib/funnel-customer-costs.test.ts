/**
 * THE CUSTOMER'S OWN MONEY, PARTITIONED BY FUNNEL STEP — the rules, without a network in the way.
 *
 * What they pin: a statement counts only inside the scope its campaign belongs to; a stated zero is
 * an answer while an unstated leg is not; and the coverage marker never claims more than it supports.
 */
import { describe, it, expect } from "vitest";
import { customerCostsByStep, coverageOf } from "./funnel-customer-costs.js";

describe("coverageOf — the stated basis is always TRUE", () => {
  it("says platform_spend_only when nothing is attributable, including when the read failed", () => {
    expect(coverageOf(null)).toBe("platform_spend_only");
    expect(coverageOf({ costCents: 0, statedCount: 0, unstatedCount: 0 })).toBe("platform_spend_only");
  });

  it("says whole only when every attributable statement carries a cost", () => {
    expect(coverageOf({ costCents: 12_000, statedCount: 2, unstatedCount: 0 })).toBe("platform_and_customer_spend");
    // A stated zero still counts as answered — a leg somebody did for free is a costed leg.
    expect(coverageOf({ costCents: 0, statedCount: 1, unstatedCount: 0 })).toBe("platform_and_customer_spend");
  });

  it("admits a partial cost the moment one leg was never stated", () => {
    expect(coverageOf({ costCents: 12_000, statedCount: 1, unstatedCount: 1 })).toBe(
      "platform_and_partial_customer_spend",
    );
    expect(coverageOf({ costCents: 0, statedCount: 0, unstatedCount: 3 })).toBe(
      "platform_and_partial_customer_spend",
    );
  });
});

describe("what the customer states each STEP cost them", () => {
  const COSTS = [
    { campaignId: "c1", step: "meeting_booked", costCents: 1500 },
    { campaignId: "c1", step: "meeting_booked", costCents: 2500 },
    { campaignId: "c1", step: "meeting_attended", costCents: null },
    { campaignId: "c2", step: "meeting_booked", costCents: 9000 },
    { campaignId: null, step: "sale", costCents: 700 },
  ];

  it("partitions the SAME statements the funnel-wide total is made of, one rung at a time", () => {
    const byStep = customerCostsByStep(COSTS, ["c1"]);
    expect(byStep.meeting_booked).toEqual({ costCents: 4000, statedCount: 2, unstatedCount: 0 });
    // A stated cost and an unanswered one are counted apart, so a rung says whether it is complete.
    expect(byStep.meeting_attended).toEqual({ costCents: 0, statedCount: 0, unstatedCount: 1 });
    // A rung nobody has been asked about is ABSENT rather than a fabricated zero row.
    expect(byStep.sale).toBeUndefined();
  });

  it("counts only the scope's own campaigns, and cannot place an unattributed statement in one", () => {
    expect(customerCostsByStep(COSTS, ["c2"]).meeting_booked).toEqual({
      costCents: 9000,
      statedCount: 1,
      unstatedCount: 0,
    });
    expect(customerCostsByStep(COSTS, ["c1", "c2"]).sale).toBeUndefined();
  });

  it("counts every statement the brand has made when the scope is the whole brand", () => {
    const byStep = customerCostsByStep(COSTS, null);
    expect(byStep.meeting_booked).toEqual({ costCents: 13000, statedCount: 3, unstatedCount: 0 });
    expect(byStep.sale).toEqual({ costCents: 700, statedCount: 1, unstatedCount: 0 });
  });
});
