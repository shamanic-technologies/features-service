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
    orgDomain: null,
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

describe("computeRevenue — orgDomain (for logo.dev)", () => {
  it("domain present → surfaced on both leads[] and organizations[]", () => {
    const r = computeRevenue(PATHS, [
      person({ leadId: "l1", orgId: "o1", orgName: "Acme", orgDomain: "acme.com", signals: { clicked: true, positiveReply: false } }),
    ]);
    expect(r.leads[0].orgDomain).toBe("acme.com");
    expect(r.organizations[0].orgDomain).toBe("acme.com");
  });

  it("domain unknown → null on both leads[] and organizations[]", () => {
    const r = computeRevenue(PATHS, [
      person({ leadId: "l1", orgId: "o1", orgName: "Acme", orgDomain: null, signals: { clicked: true, positiveReply: false } }),
    ]);
    expect(r.leads[0].orgDomain).toBeNull();
    expect(r.organizations[0].orgDomain).toBeNull();
  });

  it("org-level domain coalesces a sibling's domain even when the top-EV person has none", () => {
    const r = computeRevenue(PATHS, [
      // top-EV person (reply, 120) has no domain; sibling (visit, 20) carries it
      person({ leadId: "l1", firstName: "Reply", orgId: "o1", orgName: "Acme", orgDomain: null, signals: { clicked: false, positiveReply: true } }),
      person({ leadId: "l2", firstName: "Click", orgId: "o1", orgName: "Acme", orgDomain: "acme.com", signals: { clicked: true, positiveReply: false } }),
    ]);
    expect(r.organizations).toHaveLength(1);
    expect(r.organizations[0].topPerson.firstName).toBe("Reply"); // argmax unchanged
    expect(r.organizations[0].orgDomain).toBe("acme.com"); // coalesced from the sibling
  });
});

// 5-stage funnel: contacted < sent < delivered (delivery) + visit/reply (engagement)
const STAGE_PATHS: ResolvedPath[] = [
  { tag: "contacted", signal: "contacted", expectedRevenueUsd: 3, kind: "delivery" },
  { tag: "sent", signal: "sent", expectedRevenueUsd: 6, kind: "delivery" },
  { tag: "delivered", signal: "delivered", expectedRevenueUsd: 12, kind: "delivery" },
  { tag: "visit", signal: "clicked", expectedRevenueUsd: 20, kind: "engagement" },
  { tag: "reply", signal: "positiveReply", expectedRevenueUsd: 120, kind: "engagement" },
];

describe("computeRevenue — tag collapse (furthest delivery stage, engagement multi-tag)", () => {
  it("contacted only → tag [contacted], EV from contacted stage", () => {
    const r = computeRevenue(STAGE_PATHS, [person({ leadId: "l1", orgId: "o1", signals: { contacted: true, sent: false, delivered: false, clicked: false, positiveReply: false } })]);
    expect(r.leads[0].tags).toEqual(["contacted"]);
    expect(r.leads[0].expectedRevenueUsd).toBe(3);
  });

  it("contacted+sent+delivered (no engagement) → only the FURTHEST stage tag", () => {
    const r = computeRevenue(STAGE_PATHS, [person({ leadId: "l1", orgId: "o1", signals: { contacted: true, sent: true, delivered: true, clicked: false, positiveReply: false } })]);
    expect(r.leads[0].tags).toEqual(["delivered"]);
    expect(r.leads[0].expectedRevenueUsd).toBe(12);
  });

  it("engagement suppresses the delivery tag → clicked shows [visit], not [delivered]", () => {
    const r = computeRevenue(STAGE_PATHS, [person({ leadId: "l1", orgId: "o1", signals: { contacted: true, sent: true, delivered: true, clicked: true, positiveReply: false } })]);
    expect(r.leads[0].tags).toEqual(["visit"]);
    expect(r.leads[0].expectedRevenueUsd).toBe(20);
  });

  it("both engagements → multi-tag [visit, reply]", () => {
    const r = computeRevenue(STAGE_PATHS, [person({ leadId: "l1", orgId: "o1", signals: { contacted: true, sent: true, delivered: true, clicked: true, positiveReply: true } })]);
    expect(r.leads[0].tags.sort()).toEqual(["reply", "visit"]);
    expect(r.leads[0].expectedRevenueUsd).toBe(120);
  });

  it("events ledger itemises EVERY dated stage (delivery + engagement)", () => {
    const r = computeRevenue(STAGE_PATHS, [
      person({
        leadId: "l1", orgId: "o1",
        signals: { contacted: true, sent: true, delivered: true, clicked: true, positiveReply: false },
        signalDates: { contacted: "2026-01-01T00:00:00Z", sent: "2026-01-02T00:00:00Z", delivered: "2026-01-03T00:00:00Z", clicked: "2026-01-04T00:00:00Z" },
      }),
    ]);
    // Default sort is most-advanced status first → visit, delivered, sent, contacted.
    expect(r.events.map((e) => e.eventType)).toEqual(["visit", "delivered", "sent", "contacted"]);
    expect(r.events.find((e) => e.eventType === "contacted")!.contributionUsd).toBe(3);
  });
});

describe("computeRevenue — default sort (most-advanced status desc, then date desc)", () => {
  const D = (iso: string) => iso;

  it("leads: most-advanced status first (reply > visit > delivered)", () => {
    const r = computeRevenue(STAGE_PATHS, [
      person({ leadId: "deliv", orgId: "o1", signals: { contacted: true, sent: true, delivered: true, clicked: false, positiveReply: false } }),
      person({ leadId: "rep", orgId: "o2", signals: { contacted: true, sent: true, delivered: true, clicked: false, positiveReply: true } }),
      person({ leadId: "vis", orgId: "o3", signals: { contacted: true, sent: true, delivered: true, clicked: true, positiveReply: false } }),
    ]);
    expect(r.leads.map((l) => l.leadId)).toEqual(["rep", "vis", "deliv"]);
  });

  it("leads: iso-status → most-recent conversion date first", () => {
    const r = computeRevenue(STAGE_PATHS, [
      person({ leadId: "old", orgId: "o1", signals: { contacted: true, sent: true, delivered: true, clicked: false, positiveReply: false }, signalDates: { delivered: D("2026-01-01T00:00:00Z") } }),
      person({ leadId: "new", orgId: "o2", signals: { contacted: true, sent: true, delivered: true, clicked: false, positiveReply: false }, signalDates: { delivered: D("2026-03-01T00:00:00Z") } }),
      person({ leadId: "mid", orgId: "o3", signals: { contacted: true, sent: true, delivered: true, clicked: false, positiveReply: false }, signalDates: { delivered: D("2026-02-01T00:00:00Z") } }),
    ]);
    expect(r.leads.map((l) => l.leadId)).toEqual(["new", "mid", "old"]);
  });

  it("leads: iso-status → null conversion date sorts last", () => {
    const r = computeRevenue(STAGE_PATHS, [
      person({ leadId: "undated", orgId: "o1", signals: { contacted: true, sent: true, delivered: true, clicked: false, positiveReply: false } }),
      person({ leadId: "dated", orgId: "o2", signals: { contacted: true, sent: true, delivered: true, clicked: false, positiveReply: false }, signalDates: { delivered: D("2026-01-01T00:00:00Z") } }),
    ]);
    expect(r.leads.map((l) => l.leadId)).toEqual(["dated", "undated"]);
  });

  it("organizations: furthest stage desc, then most-recent date desc", () => {
    const r = computeRevenue(STAGE_PATHS, [
      person({ leadId: "l1", orgId: "deliv", signals: { contacted: true, sent: true, delivered: true, clicked: false, positiveReply: false }, signalDates: { delivered: D("2026-05-01T00:00:00Z") } }),
      person({ leadId: "l2", orgId: "repA", signals: { contacted: true, sent: true, delivered: true, clicked: false, positiveReply: true }, signalDates: { positiveReply: D("2026-01-01T00:00:00Z") } }),
      person({ leadId: "l3", orgId: "repB", signals: { contacted: true, sent: true, delivered: true, clicked: false, positiveReply: true }, signalDates: { positiveReply: D("2026-02-01T00:00:00Z") } }),
    ]);
    // both reply orgs (rank 4) before the delivered org (rank 2); reply orgs by recent date desc.
    expect(r.organizations.map((o) => o.orgId)).toEqual(["repB", "repA", "deliv"]);
  });

  it("events: most-advanced status desc, then most-recent date desc across leads", () => {
    const r = computeRevenue(STAGE_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { contacted: true, sent: false, delivered: false, clicked: true, positiveReply: false }, signalDates: { contacted: D("2026-01-01T00:00:00Z"), clicked: D("2026-01-10T00:00:00Z") } }),
      person({ leadId: "l2", orgId: "o2", signals: { contacted: true, sent: false, delivered: false, clicked: true, positiveReply: false }, signalDates: { contacted: D("2026-02-01T00:00:00Z"), clicked: D("2026-02-10T00:00:00Z") } }),
    ]);
    // visit events (rank 3) before contacted events (rank 0); within each stage recent-first.
    expect(r.events.map((e) => `${e.eventType}@${e.eventDate}`)).toEqual([
      "visit@2026-02-10T00:00:00Z",
      "visit@2026-01-10T00:00:00Z",
      "contacted@2026-02-01T00:00:00Z",
      "contacted@2026-01-01T00:00:00Z",
    ]);
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

  it("signal dates merge to the earliest (MIN) across rows", () => {
    const r = computeRevenue(PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { clicked: true, positiveReply: false }, signalDates: { clicked: "2026-02-01T00:00:00Z" } }),
      person({ leadId: "l1", orgId: "o1", signals: { clicked: true, positiveReply: false }, signalDates: { clicked: "2026-01-01T00:00:00Z" } }),
    ]);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].eventDate).toBe("2026-01-01T00:00:00Z");
  });
});

describe("computeRevenue — dates, time series, events", () => {
  it("no signal dates → dateless output (null dates, empty series/events)", () => {
    const r = computeRevenue(PATHS, [person({ leadId: "l1", orgId: "o1", signals: { clicked: true, positiveReply: false } })]);
    expect(r.leads[0].date).toBeNull();
    expect(r.organizations[0].mostAdvancedDate).toBeNull();
    expect(r.timeSeries).toEqual([]);
    expect(r.events).toEqual([]);
  });

  it("entity date = MAX of fired-event dates; one event row per fired dated event", () => {
    const r = computeRevenue(PATHS, [
      person({ leadId: "l1", firstName: "Jo", lastName: "Vo", orgId: "o1", orgName: "Org1", signals: { clicked: true, positiveReply: true }, signalDates: { clicked: "2026-01-01T00:00:00Z", positiveReply: "2026-03-01T00:00:00Z" } }),
    ]);
    expect(r.leads[0].date).toBe("2026-03-01T00:00:00Z"); // max(click, reply)
    expect(r.organizations[0].mostAdvancedDate).toBe("2026-03-01T00:00:00Z");
    expect(r.events).toHaveLength(2);
    const reply = r.events.find((e) => e.eventType === "reply")!;
    expect(reply.person).toBe("Jo Vo");
    expect(reply.org).toBe("Org1");
    expect(reply.contributionUsd).toBe(120);
  });

  it("time series cumulates org EV ordered by org date; undated org absent but in total", () => {
    const r = computeRevenue(PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { clicked: false, positiveReply: true }, signalDates: { positiveReply: "2026-02-01T00:00:00Z" } }), // 120 @ Feb
      person({ leadId: "l2", orgId: "o2", signals: { clicked: true, positiveReply: false }, signalDates: { clicked: "2026-01-01T00:00:00Z" } }),       // 20 @ Jan
      person({ leadId: "l3", orgId: "o3", signals: { clicked: true, positiveReply: false } }),                                                          // 20 undated
    ]);
    expect(r.headline.totalPipelineUsd).toBe(160); // all three orgs
    expect(r.timeSeries).toEqual([
      { date: "2026-01-01T00:00:00Z", cumulativePipelineUsd: 20 },
      { date: "2026-02-01T00:00:00Z", cumulativePipelineUsd: 140 },
    ]); // o3 (undated) absent from the timeline
  });
});
