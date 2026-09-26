import { describe, it, expect } from "vitest";
import { priceDealsColumns } from "./deals-value.js";
import { computeRevenue, type EnginePerson, type ResolvedPath } from "./revenue-engine.js";

// LTR $1,000. A website visit is worth $100, a positive reply $400, a booked meeting $500, a sale $1,000.
const LTR = 1000;
const PATHS: ResolvedPath[] = [
  { tag: "visit", signal: "clicked", expectedRevenueUsd: 100, engagementRoute: true },
  { tag: "reply", signal: "positiveReply", expectedRevenueUsd: 400, engagementRoute: true },
  { tag: "meeting", signal: "meeting", expectedRevenueUsd: 500 },
  { tag: "closeWin", signal: "closeWin", expectedRevenueUsd: 1000, terminal: true },
];

function person(leadId: string, orgId: string | null, signals: Record<string, boolean>, extra: Partial<EnginePerson> = {}): EnginePerson {
  return {
    leadId,
    firstName: null,
    lastName: null,
    photoUrl: null,
    orgId,
    orgName: null,
    orgLogoUrl: null,
    orgDomain: null,
    title: null,
    seniority: null,
    orgIndustry: null,
    orgEmployeeCount: null,
    orgCity: null,
    orgCountry: null,
    email: `${leadId}@x.com`,
    signals: { contacted: true, ...signals },
    ...extra,
  };
}

// Interested: two people of ONE company (reply $400, meeting $500), one of another (click $100).
// Won: a stated $4,900 sale, and a sale nobody priced. A clicker lead-service does NOT place in any
// deal column, and a contacted-only lead.
const PERSONS: EnginePerson[] = [
  person("a-reply", "org-A", { positiveReply: true }),
  person("a-meeting", "org-A", { positiveReply: true, meeting: true }),
  person("b-click", "org-B", { clicked: true }),
  person("c-won-stated", "org-C", { closeWin: true }, { valueUsd: 4900 }),
  person("d-won-unpriced", "org-D", { closeWin: true }),
  person("e-other-click", "org-E", { clicked: true }),
  person("f-contacted", "org-F", {}),
];
const MEMBERS = {
  sales_interest: new Set(["a-reply", "a-meeting", "b-click", "ghost"]),
  customer: new Set(["c-won-stated", "d-won-unpriced"]),
};
const STATED = new Map([["c-won-stated@x.com", 4900]]);

const result = priceDealsColumns({
  persons: PERSONS,
  paths: PATHS,
  lifetimeRevenueUsd: LTR,
  members: MEMBERS,
  statedWonAmountUsdByEmail: STATED,
});
const col = (s: string) => result.columns.find((c) => c.standing === s)!;

describe("priceDealsColumns — Interested", () => {
  it("each card is the person's pipeline expected value, byte-equal to the engine", () => {
    const engine = computeRevenue(PATHS, PERSONS, LTR);
    const engineEv = new Map(engine.leads.map((l) => [l.leadId, l.expectedRevenueUsd]));
    for (const card of col("sales_interest").leads.filter((c) => c.leadId !== "ghost")) {
      expect(card.valueUsd).toBeCloseTo(engineEv.get(card.leadId)!, 6);
    }
  });

  it("is company-level like the pipeline: org A counts its best member ($500), not both ($900)", () => {
    expect(col("sales_interest").valueUsd).toBe(500 + 100);
    expect(col("sales_interest").organizationCount).toBe(3); // A, B, and the unheld ghost
    expect(col("sales_interest").basis).toBe("expected_value");
  });

  it("is a SUBSET of the pipeline: the column never exceeds, and the other leads' value stays outside", () => {
    const pipeline = computeRevenue(PATHS, PERSONS, LTR).headline.totalPipelineUsd;
    expect(col("sales_interest").valueUsd!).toBeLessThan(pipeline);
    // e-other-click is in the pipeline and in no deal column
    expect(col("sales_interest").leads.some((l) => l.leadId === "e-other-click")).toBe(false);
  });

  it("a person lead-service places here that this read does not hold is a null card, counted", () => {
    expect(col("sales_interest").leads.find((l) => l.leadId === "ghost")!.valueUsd).toBeNull();
    expect(col("sales_interest").unpricedLeadCount).toBe(1);
  });
});

describe("priceDealsColumns — Won", () => {
  it("a stated sale reads its amount; an unpriced one reads the lifetime revenue, and says which", () => {
    const w = col("customer");
    expect(w.leads).toEqual([
      { leadId: "c-won-stated", valueUsd: 4900, valueSource: "stated_amount" },
      { leadId: "d-won-unpriced", valueUsd: 1000, valueSource: "lifetime_revenue" },
    ]);
    expect(w.valueUsd).toBe(5900);
    expect(w.basis).toBe("won_value");
  });

  it("without a client value and no stated amount the column says so, never 0", () => {
    const r = priceDealsColumns({
      persons: PERSONS,
      paths: [],
      lifetimeRevenueUsd: 0,
      members: { sales_interest: new Set(["b-click"]), customer: new Set(["d-won-unpriced"]) },
      statedWonAmountUsdByEmail: null,
    });
    const w = r.columns.find((c) => c.standing === "customer")!;
    expect(w.valueUsd).toBeNull();
    expect(w.unvaluedReason).toBe("no_client_value");
    expect(r.columns.find((c) => c.standing === "sales_interest")!.unvaluedReason).toBe("no_client_value");
  });

  it("no economics at all reads no_economics on Interested", () => {
    const r = priceDealsColumns({
      persons: PERSONS,
      paths: [],
      lifetimeRevenueUsd: null,
      members: MEMBERS,
      statedWonAmountUsdByEmail: STATED,
    });
    expect(r.columns.find((c) => c.standing === "sales_interest")!.unvaluedReason).toBe("no_economics");
    // the stated sale still stands on its own amount
    expect(r.columns.find((c) => c.standing === "customer")!.valueUsd).toBe(4900);
  });
});

describe("priceDealsColumns — unvalued columns state a reason, never 0", () => {
  it.each([
    ["disqualified", "ruled_out"],
    ["opted_out", "opted_out"],
    ["not_contacted", "not_placed"],
    ["unresolved", "standing_unresolved"],
    ["contacted", "see_contacted_value"],
  ])("%s → %s", (standing, reason) => {
    const c = col(standing);
    expect(c.valueUsd).toBeNull();
    expect(c.unvaluedReason).toBe(reason);
  });

  it("the whole body stays small at the largest brand's scale", () => {
    const many = Array.from({ length: 5000 }, (_, i) => person(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, `o${i}`, { clicked: true }));
    const r = priceDealsColumns({
      persons: many,
      paths: PATHS,
      lifetimeRevenueUsd: LTR,
      members: { sales_interest: new Set(many.map((p) => p.leadId)), customer: new Set() },
      statedWonAmountUsdByEmail: null,
    });
    expect(JSON.stringify(r).length).toBeLessThan(500_000);
  });
});
