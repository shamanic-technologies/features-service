import { describe, it, expect } from "vitest";
import { computeRevenue, type EnginePerson, type ResolvedPath } from "./revenue-engine.js";
import { perOfferPricer } from "./per-offer-revenue.js";
import type { FunnelDefinition, SalesEconomics } from "./funnel-registry.js";
import type { OfferPricing } from "./per-offer-pricing.js";

function person(leadId: string, campaignId: string | null, orgId: string, signals: Record<string, boolean>): EnginePerson {
  return {
    leadId, firstName: "A", lastName: "B", photoUrl: null, orgId, orgName: orgId, orgLogoUrl: null, orgDomain: null,
    title: null, seniority: null, orgIndustry: null, orgEmployeeCount: null, orgCity: null, orgCountry: null,
    campaignId, signals,
  };
}

// A reply is worth 10% of the offer's lifetime revenue on this fake funnel.
const FUNNEL = {
  resolvePaths: ({ economics }: { economics: SalesEconomics }): ResolvedPath[] => [
    { tag: "reply", signal: "positiveReply", expectedRevenueUsd: economics.lifetimeRevenueUsd * 0.1 },
  ],
  milestones: [],
} as unknown as FunnelDefinition;

const offer = (offerId: string, campaignIds: string[], ltr: number | null): OfferPricing => ({
  offerId,
  campaignIds,
  priced: {
    pricedFunnelKeys: ["sales_meetings_from_conversation"],
    economics: ltr === null
      ? { economics: null, unpricedReason: "lifetime_revenue_not_stated" }
      : { economics: { lifetimeRevenueUsd: ltr } as SalesEconomics, unpricedReason: null },
  },
});

describe("a several-offer brand prices each person on the offer of their own campaign (owner 2026-10-09)", () => {
  const pricer = perOfferPricer([offer("A", ["c1"], 1000), offer("B", ["c2"], 4000), offer("C", ["c3"], null)], FUNNEL)!;
  const people = [
    person("l1", "c1", "org1", { positiveReply: true }),
    person("l2", "c2", "org2", { positiveReply: true }),
    person("l3", "c3", "org3", { positiveReply: true }), // its offer prices nothing
    person("l4", null, "org4", { positiveReply: true }), // a campaign stating no offer
  ];

  it("each company is valued on its own offer's terms; an unpriced offer's people are worth 0", () => {
    const r = computeRevenue(pricer.paths, people, 0, [], null, pricer.pricingOf);
    const byOrg: Record<string, number> = Object.fromEntries(r.organizations.map((o) => [o.orgId ?? o.orgName ?? "", o.expectedRevenueUsd]));
    expect(r.headline.totalPipelineUsd).toBeCloseTo(500, 6);
    expect(Object.keys(byOrg).sort()).toEqual(["org1", "org2"]);
    expect(Object.values(byOrg).sort((a, b) => a - b)).toEqual([100, 400]);
  });

  it("the lifetime revenue served reproduces the exact expected paying clients", () => {
    const ltr = pricer.lifetimeRevenueOver(people, (ps, paths, l) => computeRevenue(paths, ps, l).headline.totalPipelineUsd);
    // 100/1000 + 400/4000 = 0.2 clients for $500 → $2,500 per client (never the plain average $2,500 by luck: see below).
    expect(ltr).toBeCloseTo(2500, 6);
    const skewed = pricer.lifetimeRevenueOver([people[0], people[0], people[1]], (ps, paths, l) =>
      computeRevenue(paths, ps.map((p, i) => ({ ...p, leadId: `${p.leadId}-${i}`, orgId: `${p.orgId}-${i}` })), l).headline.totalPipelineUsd,
    );
    // 200/1000 + 400/4000 = 0.3 clients for $600 → $2,000, not the offers' average.
    expect(skewed).toBeCloseTo(2000, 6);
  });

  it("no priced offer → no pricer (the read stays unpriced)", () => {
    expect(perOfferPricer([offer("C", ["c3"], null)], FUNNEL)).toBeNull();
  });
});
