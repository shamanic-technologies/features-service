import { describe, it, expect } from "vitest";
import { computeRevenue, type ResolvedPath, type EnginePerson } from "./revenue-engine.js";

// LTR=1000, visitToClose=2%, visitToMeeting=5%, meetingToClose=30%, replyToMeeting=40%
//   visit_EV = 1000 × max(0.02, 0.05×0.30=0.015) = 20
//   reply_EV = 1000 × 0.40 × 0.30               = 120
const PATHS: ResolvedPath[] = [
  { tag: "visit", signal: "clicked", expectedRevenueUsd: 20 },
  { tag: "reply", signal: "positiveReply", expectedRevenueUsd: 120 },
];

function person(over: Partial<EnginePerson> & { leadId: string; signals: Record<string, boolean> }): EnginePerson {
  return {
    firstName: "A",
    lastName: "B",
    photoUrl: null,
    orgId: null,
    orgName: null,
    orgLogoUrl: null,
    ...over,
  };
}

describe("computeRevenue — per-person EV", () => {
  it("clicked only → visit path EV, tag [visit]", () => {
    const r = computeRevenue(PATHS, [person({ leadId: "l1", signals: { clicked: true, positiveReply: false } })]);
    expect(r.leads[0].expectedRevenueUsd).toBe(20);
    expect(r.leads[0].tags).toEqual(["visit"]);
  });

  it("positive reply only → reply path EV, tag [reply]", () => {
    const r = computeRevenue(PATHS, [person({ leadId: "l1", signals: { clicked: false, positiveReply: true } })]);
    expect(r.leads[0].expectedRevenueUsd).toBe(120);
    expect(r.leads[0].tags).toEqual(["reply"]);
  });

  it("both signals → MAX EV, union tags", () => {
    const r = computeRevenue(PATHS, [person({ leadId: "l1", signals: { clicked: true, positiveReply: true } })]);
    expect(r.leads[0].expectedRevenueUsd).toBe(120);
    expect(r.leads[0].tags.sort()).toEqual(["reply", "visit"]);
  });

  it("no signal fired → excluded from tables and total", () => {
    const r = computeRevenue(PATHS, [person({ leadId: "l1", signals: { clicked: false, positiveReply: false } })]);
    expect(r.leads).toHaveLength(0);
    expect(r.organizations).toHaveLength(0);
    expect(r.headline.totalPipelineUsd).toBe(0);
  });
});

describe("computeRevenue — org dedup (MAX inside, SUM between)", () => {
  it("two persons same org → org EV = MAX, topPerson = argmax, tags union", () => {
    const r = computeRevenue(PATHS, [
      person({ leadId: "l1", firstName: "Click", orgId: "o1", orgName: "Org1", signals: { clicked: true, positiveReply: false } }),
      person({ leadId: "l2", firstName: "Reply", orgId: "o1", orgName: "Org1", signals: { clicked: false, positiveReply: true } }),
    ]);
    expect(r.organizations).toHaveLength(1);
    expect(r.organizations[0].expectedRevenueUsd).toBe(120); // MAX not 140
    expect(r.organizations[0].topPerson.firstName).toBe("Reply");
    expect(r.organizations[0].tags.sort()).toEqual(["reply", "visit"]);
    expect(r.leads).toHaveLength(2); // leads table keeps both
    expect(r.headline.totalPipelineUsd).toBe(120);
  });

  it("two distinct orgs → total = SUM of org EV", () => {
    const r = computeRevenue(PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { clicked: false, positiveReply: true } }), // 120
      person({ leadId: "l2", orgId: "o2", signals: { clicked: true, positiveReply: false } }), // 20
    ]);
    expect(r.organizations).toHaveLength(2);
    expect(r.headline.totalPipelineUsd).toBe(140);
  });

  it("person with no org → own singleton org, still in pipeline", () => {
    const r = computeRevenue(PATHS, [person({ leadId: "l1", orgId: null, signals: { clicked: true, positiveReply: false } })]);
    expect(r.organizations).toHaveLength(1);
    expect(r.organizations[0].orgId).toBeNull();
    expect(r.headline.totalPipelineUsd).toBe(20);
  });
});

describe("computeRevenue — lead dedup across campaign rows", () => {
  it("same leadId in two rows → one person, signals OR'd", () => {
    const r = computeRevenue(PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { clicked: true, positiveReply: false } }),
      person({ leadId: "l1", orgId: "o1", signals: { clicked: false, positiveReply: true } }),
    ]);
    expect(r.leads).toHaveLength(1);
    expect(r.leads[0].expectedRevenueUsd).toBe(120); // OR → both → max
    expect(r.leads[0].tags.sort()).toEqual(["reply", "visit"]);
  });
});
