import { describe, it, expect } from "vitest";
import {
  buildMaturityPlan,
  matureCohortPersons,
  maturityCutoffIso,
  maturityDaysForLeg,
  scopePredicate,
} from "./roi-maturity.js";
import { OUTCOME_LAG_DAYS } from "./learning-phase.js";
import { buildCombinedCostEconomics, buildCostEconomics, matureBasisOf } from "./cost-economics.js";
import type { EnginePerson } from "./revenue-engine.js";

const NOW = new Date("2026-10-01T12:34:56.000Z");

function person(leadId: string, campaignId: string | null, contacted: string | null): EnginePerson {
  return {
    leadId, firstName: null, lastName: null, photoUrl: null, orgId: null, orgName: null, orgLogoUrl: null,
    orgDomain: null, title: null, seniority: null, orgIndustry: null, orgEmployeeCount: null, orgCity: null,
    orgCountry: null, campaignId, signals: {}, signalDates: { contacted },
  };
}

describe("the maturity delay is a property of the LEG", () => {
  it("waits OUTCOME_LAG_DAYS on the two cold-email entry legs and 0 on every other leg", () => {
    expect(maturityDaysForLeg("start_to_website_visit")).toBe(OUTCOME_LAG_DAYS);
    expect(maturityDaysForLeg("start_to_conversation")).toBe(OUTCOME_LAG_DAYS);
    expect(OUTCOME_LAG_DAYS).toBe(14);
    expect(maturityDaysForLeg("conversation_to_meeting_booked")).toBe(0);
    expect(maturityDaysForLeg(null)).toBe(0);
  });

  it("cuts at UTC midnight, so the cutoff moves once a day", () => {
    expect(maturityCutoffIso(14, NOW)).toBe("2026-09-17T00:00:00.000Z");
    expect(maturityCutoffIso(14, new Date("2026-10-01T00:00:00.000Z"))).toBe("2026-09-17T00:00:00.000Z");
  });
});

describe("the plan covers the read's own scope", () => {
  const rows = [
    { id: "cold", featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation" },
    { id: "ai", featureSlug: "ai-meeting-booking", legKey: "conversation_to_meeting_booked" },
    { id: "old", featureSlug: "sales-cold-email-outreach", legKey: null },
  ];

  it("delays only the campaigns on a delayed leg, and states the longest delay", () => {
    const plan = buildMaturityPlan(rows, scopePredicate({ featureSlugs: ["sales-cold-email-outreach", "ai-meeting-booking"], campaignIds: [] }), NOW);
    expect(plan.days).toBe(14);
    expect([...plan.delayedCampaignIds]).toEqual(["cold"]);
  });

  it("a scope on zero-delay legs only waits for nothing", () => {
    const plan = buildMaturityPlan(rows, scopePredicate({ featureSlugs: ["ai-meeting-booking"], campaignIds: [] }), NOW);
    expect(plan.cutoffIso).toBeNull();
    expect(plan.days).toBe(0);
  });

  it("a campaign-narrowed read looks at its own campaigns, not the brand's", () => {
    const plan = buildMaturityPlan(rows, scopePredicate({ featureSlugs: ["sales-cold-email-outreach"], campaignIds: ["old"] }), NOW);
    expect(plan.cutoffIso).toBeNull();
  });
});

describe("the mature cohort of leads", () => {
  const plan = buildMaturityPlan(
    [{ id: "cold", featureSlug: "s", legKey: "start_to_conversation" }],
    scopePredicate({ featureSlugs: ["s"], campaignIds: [] }),
    NOW,
  );

  it("drops a maturing campaign's lead first contacted on or after the cutoff, keeps the rest", () => {
    const kept = matureCohortPersons(
      [
        person("old", "cold", "2026-09-16T23:59:59.999Z"),
        person("edge", "cold", "2026-09-17T00:00:00.000Z"),
        person("young", "cold", "2026-09-25T00:00:00.000Z"),
        person("undated", "cold", null),
        person("other", "zero-delay", "2026-09-30T00:00:00.000Z"),
        person("orphan", null, "2026-09-30T00:00:00.000Z"),
      ],
      plan,
    ).map((p) => p.leadId);
    expect(kept).toEqual(["old", "undated", "other", "orphan"]);
  });
});

describe("the ratios ride the mature cohort; the displays keep the whole history", () => {
  it("divides the mature pipeline by the mature spend", () => {
    const ce = buildCostEconomics({
      committedCostInUsdCents: 10_000,
      actualCostInUsdCents: 9_000,
      totalPipelineUsd: 700,
      lifetimeRevenueUsd: 100,
      maturity: { days: 14, committedCostInUsdCents: 6_000, totalPipelineUsd: 400 },
    });
    expect(ce.committedCostUsd).toBe(100);
    expect(ce.actualCostUsd).toBe(90);
    expect(ce.roiMultiple).toBeCloseTo(400 / 60, 9);
    expect(ce.costOfAcquisitionPct).toBeCloseTo((60 / 400) * 100, 9);
    expect(ce.costPerAcquisitionUsd).toBeCloseTo(60 / 4, 9);
    expect(ce.maturityDays).toBe(14);
    expect(ce.unmeasuredReason).toBeNull();
    expect(matureBasisOf(ce)).toEqual({ committedCents: 6_000, pipelineUsd: 400, days: 14 });
  });

  it("no mature spend yet reads `maturing`, never 0 — and nothing spent at all states no reason", () => {
    const young = buildCostEconomics({
      committedCostInUsdCents: 4_000, actualCostInUsdCents: 4_000, totalPipelineUsd: 50, lifetimeRevenueUsd: 100,
      maturity: { days: 14, committedCostInUsdCents: 0, totalPipelineUsd: 0 },
    });
    expect(young.roiMultiple).toBeNull();
    expect(young.costOfAcquisitionPct).toBeNull();
    expect(young.costPerAcquisitionUsd).toBeNull();
    expect(young.unmeasuredReason).toBe("maturing");

    const none = buildCostEconomics({
      committedCostInUsdCents: 0, actualCostInUsdCents: 0, totalPipelineUsd: 0,
      maturity: { days: 14, committedCostInUsdCents: 0, totalPipelineUsd: 0 },
    });
    expect(none.unmeasuredReason).toBeNull();
    expect(none.roiMultiple).toBeNull();
  });

  it("without a maturity input the block is the whole-history one, stating 0 days", () => {
    const ce = buildCostEconomics({ committedCostInUsdCents: 10_000, actualCostInUsdCents: 10_000, totalPipelineUsd: 700 });
    expect(ce.roiMultiple).toBeCloseTo(7, 9);
    expect(ce.maturityDays).toBe(0);
    expect(ce.unmeasuredReason).toBeNull();
  });

  it("the combined (charged + customer) return rides the same mature cohort, with every customer cost in it", () => {
    const charged = buildCostEconomics({
      committedCostInUsdCents: 10_000, actualCostInUsdCents: 10_000, totalPipelineUsd: 700, lifetimeRevenueUsd: 100,
      maturity: { days: 14, committedCostInUsdCents: 6_000, totalPipelineUsd: 400 },
    });
    const combined = buildCombinedCostEconomics({ charged, customerDeclaredCostCents: 2_000, totalPipelineUsd: 700, lifetimeRevenueUsd: 100 });
    expect(combined.committedCostUsd).toBe(120);
    expect(combined.roiMultiple).toBeCloseTo(400 / 80, 9);
    expect(combined.maturityDays).toBe(14);

    const youngCharged = buildCostEconomics({
      committedCostInUsdCents: 4_000, actualCostInUsdCents: 4_000, totalPipelineUsd: 50,
      maturity: { days: 14, committedCostInUsdCents: 0, totalPipelineUsd: 0 },
    });
    const youngCombined = buildCombinedCostEconomics({ charged: youngCharged, customerDeclaredCostCents: 2_000, totalPipelineUsd: 50 });
    expect(youngCombined.roiMultiple).toBeNull();
    expect(youngCombined.unmeasuredReason).toBe("maturing");
  });

  it("a block that did not come from the builder has no mature basis, and says so loudly", () => {
    expect(() => matureBasisOf(JSON.parse(JSON.stringify(buildCostEconomics({ committedCostInUsdCents: 1, actualCostInUsdCents: 1, totalPipelineUsd: 1 }))))).toThrow(/mature basis/);
  });
});
