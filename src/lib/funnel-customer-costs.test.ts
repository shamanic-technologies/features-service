/**
 * THE CUSTOMER'S OWN MONEY, PARTITIONED BY SALES FUNNEL — the rules, without a network in the way.
 *
 * What they pin: a statement lands in the row whose campaign set contains its campaign and in no
 * other; one that cannot be placed is reported apart rather than dropped or parked on a default; a
 * stated zero is an answer while an unstated leg is not; and the coverage marker never claims more
 * than the least-covered scope supports.
 */
import { describe, it, expect } from "vitest";
import {
  partitionCustomerCosts,
  customerCostsByStep,
  coverageOf,
  summariseCoverage,
} from "./funnel-customer-costs.js";

const FUNNELS = [
  { key: "conversation", campaignIds: ["c1", "c1b"] },
  { key: "website", campaignIds: ["c2"] },
];

describe("partitionCustomerCosts", () => {
  it("puts a statement in the funnel whose campaign set holds its campaign, and in no other", () => {
    const { byFunnel, unattributed } = partitionCustomerCosts(
      [
        { campaignId: "c1", costCents: 12_000 },
        { campaignId: "c1b", costCents: 3_000 },
        { campaignId: "c2", costCents: 500 },
      ],
      FUNNELS,
    );
    expect(byFunnel.conversation).toEqual({ costCents: 15_000, statedCount: 2, unstatedCount: 0 });
    expect(byFunnel.website).toEqual({ costCents: 500, statedCount: 1, unstatedCount: 0 });
    expect(unattributed).toEqual({ costCents: 0, statedCount: 0, unstatedCount: 0 });
  });

  it("reports a statement it cannot place APART — never dropped, never parked on a default funnel", () => {
    const { byFunnel, unattributed } = partitionCustomerCosts(
      [
        { campaignId: null, costCents: 100 },
        { campaignId: "another-offers-campaign", costCents: 900 },
      ],
      FUNNELS,
    );
    expect(byFunnel.conversation.costCents).toBe(0);
    expect(byFunnel.website.costCents).toBe(0);
    expect(unattributed).toEqual({ costCents: 1_000, statedCount: 2, unstatedCount: 0 });
  });

  it("counts a STATED ZERO as an answer and an UNSTATED leg as one nobody was ever asked", () => {
    const { byFunnel } = partitionCustomerCosts(
      [
        { campaignId: "c1", costCents: 0 },
        { campaignId: "c1", costCents: null },
      ],
      FUNNELS,
    );
    // Nothing is fabricated for the unstated one: it raises the count that says the sum is incomplete.
    expect(byFunnel.conversation).toEqual({ costCents: 0, statedCount: 1, unstatedCount: 1 });
  });

  it("gives every funnel a row, so a funnel nobody stated a cost for reads zeros rather than absent", () => {
    const { byFunnel } = partitionCustomerCosts([], FUNNELS);
    expect(Object.keys(byFunnel).sort()).toEqual(["conversation", "website"]);
    expect(byFunnel.conversation).toEqual({ costCents: 0, statedCount: 0, unstatedCount: 0 });
  });
});

describe("coverageOf / summariseCoverage — the stated basis is always TRUE", () => {
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

  it("summarises to the WEAKEST row, because the marker is an admission", () => {
    expect(summariseCoverage(["platform_and_customer_spend", "platform_spend_only"])).toBe("platform_spend_only");
    expect(
      summariseCoverage(["platform_spend_only", "platform_and_partial_customer_spend"]),
    ).toBe("platform_and_partial_customer_spend");
    expect(summariseCoverage(["platform_and_customer_spend", "platform_and_customer_spend"])).toBe(
      "platform_and_customer_spend",
    );
    // No rows at all cannot claim customer money.
    expect(summariseCoverage([])).toBe("platform_spend_only");
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

  it("adds up to the funnel-wide answer it sits beside, rather than restating it", () => {
    const wide = partitionCustomerCosts(COSTS, [{ key: "f", campaignIds: ["c1", "c2"] }]).byFunnel.f;
    const byStep = customerCostsByStep(COSTS, ["c1", "c2"]);
    const summed = Object.values(byStep).reduce(
      (acc, s) => ({
        costCents: acc.costCents + s.costCents,
        statedCount: acc.statedCount + s.statedCount,
        unstatedCount: acc.unstatedCount + s.unstatedCount,
      }),
      { costCents: 0, statedCount: 0, unstatedCount: 0 },
    );
    expect(summed).toEqual(wide);
  });
});
