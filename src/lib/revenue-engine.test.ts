import { describe, it, expect } from "vitest";
import { computeRevenue, buildContactedSeries, buildSignalSeries, type ResolvedPath, type EnginePerson, type LeadRow } from "./revenue-engine.js";

// Engine is funnel-agnostic — these are arbitrary fixture EVs (NOT the live funnel formula, which
// now combines the click's two routes via orP). visit_EV=20, reply_EV=120 keep the engine assertions
// simple; the funnel→EV math itself is covered in funnel-registry.test.ts.
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
    title: null,
    seniority: null,
    orgIndustry: null,
    orgEmployeeCount: null,
    orgCity: null,
    orgCountry: null,
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

// ── NO DECAY — an outcome that happened stays counted ─────────────────────────
// The engine used to zero a lead whose FURTHEST reached stage sat past a per-stage window
// (contacted 7d, sent 3d, reply 14d, meeting 30d …): it tagged the row `stale`, dropped its events
// from the ledger and stepped the cumulative series back DOWN at the lead's "death". All of that is
// gone. The pipeline is a lifetime figure, exactly like the spend it is divided by — measuring a
// 14-day numerator against an all-time denominator drove ROI under 1 purely by ageing. These cases
// pin the removal; `ResolvedPath` no longer even has a window field, so a freshness weight /
// half-life / recency multiplier cannot come back without failing to compile here.
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-01T00:00:00Z");
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString();

// The live sales funnel's shape: delivery milestones, the two engagement routes, then the
// post-engagement positions. Not one of them expires.
const AGE_PATHS: ResolvedPath[] = [
  { tag: "contacted", signal: "contacted", expectedRevenueUsd: 3, kind: "delivery" },
  { tag: "sent", signal: "sent", expectedRevenueUsd: 6, kind: "delivery" },
  { tag: "delivered", signal: "delivered", expectedRevenueUsd: 12, kind: "delivery" },
  { tag: "opened", signal: "open", expectedRevenueUsd: 12, kind: "delivery" },
  { tag: "visit", signal: "clicked", expectedRevenueUsd: 20, kind: "engagement" },
  { tag: "reply", signal: "positiveReply", expectedRevenueUsd: 120, kind: "engagement" },
  { tag: "meeting", signal: "meeting", expectedRevenueUsd: 300, kind: "engagement" },
  { tag: "closeWin", signal: "closeWin", expectedRevenueUsd: 1000, kind: "engagement" },
];

describe("computeRevenue — no decay: age never reduces a lead", () => {
  it("a lead contacted a year ago counts exactly as much as one contacted yesterday", () => {
    const old = computeRevenue(AGE_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { contacted: true }, signalDates: { contacted: ago(365) } }),
    ]);
    const fresh = computeRevenue(AGE_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { contacted: true }, signalDates: { contacted: ago(1) } }),
    ]);
    expect(old.headline.totalPipelineUsd).toBe(3);
    expect(old.headline.totalPipelineUsd).toBe(fresh.headline.totalPipelineUsd);
    expect(old.leads[0].tags).toEqual(["contacted"]); // no `stale` tag exists any more
    expect(old.organizations).toHaveLength(1);
  });

  it("a positive reply from months ago still counts, and its event stays on the ledger", () => {
    const r = computeRevenue(AGE_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { positiveReply: true }, signalDates: { positiveReply: ago(200) } }),
    ]);
    expect(r.headline.totalPipelineUsd).toBe(120);
    expect(r.leads[0].expectedRevenueUsd).toBe(120);
    expect(r.leads[0].tags).toEqual(["reply"]);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].eventType).toBe("reply");
  });

  it("a meeting booked long ago still counts at the meeting EV", () => {
    const r = computeRevenue(AGE_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { positiveReply: true, meeting: true }, signalDates: { positiveReply: ago(300), meeting: ago(250) } }),
    ]);
    expect(r.headline.totalPipelineUsd).toBe(300);
    expect(r.leads[0].tags.sort()).toEqual(["meeting", "reply"]);
  });

  it("closed-won books full LTR however old it is", () => {
    const r = computeRevenue(AGE_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { positiveReply: true, meeting: true, closeWin: true }, signalDates: { positiveReply: ago(420), meeting: ago(410), closeWin: ago(400) } }),
    ]);
    expect(r.headline.totalPipelineUsd).toBe(1000);
    expect(r.leads[0].tags).toContain("closeWin");
  });

  it("every org contributes: an old stalled lead is NOT dropped from the total or the table", () => {
    const r = computeRevenue(AGE_PATHS, [
      person({ leadId: "l1", orgId: "recent", signals: { clicked: true }, signalDates: { clicked: ago(2) } }),
      person({ leadId: "l2", orgId: "ancient", signals: { delivered: true }, signalDates: { delivered: ago(400) } }),
    ]);
    expect(r.headline.totalPipelineUsd).toBe(32); // 20 + 12 — the old org is still pipeline
    expect(r.organizations).toHaveLength(2);
  });

  it("the cumulative time series is MONOTONE NON-DECREASING and ends at the headline total", () => {
    const r = computeRevenue(AGE_PATHS, [
      person({ leadId: "l1", orgId: "a", signals: { delivered: true }, signalDates: { delivered: ago(400) } }),
      person({ leadId: "l2", orgId: "b", signals: { positiveReply: true }, signalDates: { positiveReply: ago(200) } }),
      person({ leadId: "l3", orgId: "c", signals: { clicked: true }, signalDates: { clicked: ago(2) } }),
    ]);
    const series = r.timeSeries.map((p) => p.cumulativePipelineUsd);
    expect(series).toEqual([...series].sort((x, y) => x - y));
    for (let i = 1; i < series.length; i += 1) expect(series[i]).toBeGreaterThanOrEqual(series[i - 1]);
    expect(series[series.length - 1]).toBe(r.headline.totalPipelineUsd);
    expect(r.headline.totalPipelineUsd).toBe(152); // 12 + 120 + 20, nothing phased out
  });

  it("a lead with no known date is unaffected (it simply cannot be placed on the timeline)", () => {
    const r = computeRevenue(AGE_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { delivered: true } }), // no signalDates
    ]);
    expect(r.headline.totalPipelineUsd).toBe(12);
    expect(r.timeSeries).toEqual([]);
  });
});

// ── Engagement-route combine (click + reply summed as independent probabilities, bounded 1 LTR) ──
const LTR = 1000;
const ROUTE_PATHS: ResolvedPath[] = [
  { tag: "visit", signal: "clicked", expectedRevenueUsd: 20, kind: "engagement", engagementRoute: true },
  { tag: "reply", signal: "positiveReply", expectedRevenueUsd: 120, kind: "engagement", engagementRoute: true },
];
// delivery + both routes + convergence/terminal (meeting, closeWin are NOT routes → stay MAX).
const FULL_PATHS: ResolvedPath[] = [
  { tag: "delivered", signal: "delivered", expectedRevenueUsd: 12, kind: "delivery" },
  { tag: "visit", signal: "clicked", expectedRevenueUsd: 20, kind: "engagement", engagementRoute: true },
  { tag: "reply", signal: "positiveReply", expectedRevenueUsd: 120, kind: "engagement", engagementRoute: true },
  { tag: "meeting", signal: "meeting", expectedRevenueUsd: 300, kind: "engagement" },
  { tag: "closeWin", signal: "closeWin", expectedRevenueUsd: 1000, kind: "engagement" },
];

describe("computeRevenue — engagement-route combine (independent-probability SUM)", () => {
  it("click only → unchanged route EV", () => {
    const r = computeRevenue(ROUTE_PATHS, [person({ leadId: "l1", signals: { clicked: true, positiveReply: false } })], LTR);
    expect(r.leads[0].expectedRevenueUsd).toBe(20);
  });

  it("reply only → unchanged route EV", () => {
    const r = computeRevenue(ROUTE_PATHS, [person({ leadId: "l1", signals: { clicked: false, positiveReply: true } })], LTR);
    expect(r.leads[0].expectedRevenueUsd).toBe(120);
  });

  it("BOTH routes → combined a+b−a·b/LTR, strictly > max(either) and < plain sum", () => {
    const r = computeRevenue(ROUTE_PATHS, [person({ leadId: "l1", signals: { clicked: true, positiveReply: true } })], LTR);
    const ev = r.leads[0].expectedRevenueUsd;
    expect(ev).toBeCloseTo(137.6, 6); // 20 + 120 − 20·120/1000
    expect(ev).toBeGreaterThan(120);  // > MAX of either route alone
    expect(ev).toBeLessThan(140);     // < plain sum (independence discount)
    expect(r.leads[0].tags.sort()).toEqual(["reply", "visit"]);
  });

  it("BOTH routes with high rates → bounded ≤ 1 LTR", () => {
    const HOT: ResolvedPath[] = [
      { tag: "visit", signal: "clicked", expectedRevenueUsd: 600, kind: "engagement", engagementRoute: true },
      { tag: "reply", signal: "positiveReply", expectedRevenueUsd: 800, kind: "engagement", engagementRoute: true },
    ];
    const r = computeRevenue(HOT, [person({ leadId: "l1", signals: { clicked: true, positiveReply: true } })], LTR);
    expect(r.leads[0].expectedRevenueUsd).toBeCloseTo(920, 6); // 600 + 800 − 480
    expect(r.leads[0].expectedRevenueUsd).toBeLessThanOrEqual(LTR);
  });

  it("no cap passed (default 0) → routes fall back to bare MAX (no combine)", () => {
    const r = computeRevenue(ROUTE_PATHS, [person({ leadId: "l1", signals: { clicked: true, positiveReply: true } })]);
    expect(r.leads[0].expectedRevenueUsd).toBe(120);
  });

  it("delivery-furthest only (no engagement) → unchanged MAX", () => {
    const r = computeRevenue(FULL_PATHS, [person({ leadId: "l1", signals: { delivered: true } })], LTR);
    expect(r.leads[0].expectedRevenueUsd).toBe(12);
    expect(r.leads[0].tags).toEqual(["delivered"]);
  });

  it("routes + meeting → MAX(combined, meeting) — convergence not double-counted", () => {
    const r = computeRevenue(FULL_PATHS, [person({ leadId: "l1", signals: { clicked: true, positiveReply: true, meeting: true } })], LTR);
    expect(r.leads[0].expectedRevenueUsd).toBe(300); // combined(137.6) < meeting(300) → meeting dominates
  });

  it("closeWin → full LTR dominates the combine (realized revenue)", () => {
    const r = computeRevenue(FULL_PATHS, [person({ leadId: "l1", signals: { clicked: true, positiveReply: true, closeWin: true } })], LTR);
    expect(r.leads[0].expectedRevenueUsd).toBe(1000);
  });
});

// features-service#371 — the leads payload carries the per-lead `contacted` flag + `contactedAt`
// date so the Outreach stat card (a count) and the pipeline-activity daily graph (per-day buckets)
// can render from this ONE snapshot, agreeing with the leads table they share. Single source.
describe("computeRevenue — contacted flag + contactedAt (features-service#371)", () => {
  const STAGE_PATHS: ResolvedPath[] = [
    { tag: "contacted", signal: "contacted", expectedRevenueUsd: 3, kind: "delivery" },
    { tag: "visit", signal: "clicked", expectedRevenueUsd: 20 },
  ];

  it("exposes contacted=true + the firstContactedAt date from the overlay", () => {
    const r = computeRevenue(STAGE_PATHS, [
      person({
        leadId: "l1",
        signals: { contacted: true, clicked: false },
        signalDates: { contacted: "2026-06-20T10:00:00.000Z" },
      }),
    ]);
    expect(r.leads[0].contacted).toBe(true);
    expect(r.leads[0].contactedAt).toBe("2026-06-20T10:00:00.000Z");
  });

  it("a clicked (engaged) lead is still contacted=true — count never undercounts past contacted", () => {
    const r = computeRevenue(STAGE_PATHS, [
      person({
        leadId: "l1",
        signals: { contacted: true, clicked: true },
        signalDates: { contacted: "2026-06-20T10:00:00.000Z" },
      }),
    ]);
    // The lead's furthest tag is "visit", NOT "contacted" — counting tags would miss it. The
    // explicit `contacted` flag does not.
    expect(r.leads[0].tags).toEqual(["visit"]);
    expect(r.leads[0].contacted).toBe(true);
  });

  it("contactedAt null when contacted but no date known (no synthesis)", () => {
    const r = computeRevenue(STAGE_PATHS, [
      person({ leadId: "l1", signals: { contacted: true, clicked: false } }),
    ]);
    expect(r.leads[0].contacted).toBe(true);
    expect(r.leads[0].contactedAt).toBeNull();
  });

  it("the card count + daily buckets are both derivable from one snapshot (three surfaces agree)", () => {
    const r = computeRevenue(STAGE_PATHS, [
      person({ leadId: "l1", signals: { contacted: true, clicked: true }, signalDates: { contacted: "2026-06-20T09:00:00.000Z" } }),
      person({ leadId: "l2", signals: { contacted: true, clicked: false }, signalDates: { contacted: "2026-06-20T23:00:00.000Z" } }),
      person({ leadId: "l3", signals: { contacted: true, clicked: false }, signalDates: { contacted: "2026-06-21T08:00:00.000Z" } }),
    ]);
    // Outreach stat card = count of contacted leads (the leads table is the single source).
    const cardCount = r.leads.filter((l) => l.contacted).length;
    expect(cardCount).toBe(3);
    // Daily graph = bucket the SAME leads by contactedAt's UTC calendar day.
    const byDay = new Map<string, number>();
    for (const l of r.leads) {
      if (!l.contactedAt) continue;
      const day = l.contactedAt.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    expect(byDay.get("2026-06-20")).toBe(2);
    expect(byDay.get("2026-06-21")).toBe(1);
    // Coherence: the per-day buckets sum to the card count — same snapshot, same population.
    const bucketSum = [...byDay.values()].reduce((a, b) => a + b, 0);
    expect(bucketSum).toBe(cardCount);
  });
});

// features-service follow-up (#372 → server-side aggregates): the Outreach stat-card COUNT and the
// 7-day graph's daily ACTUALS are computed server-side from the SAME leads[] snapshot the table
// renders, so the dashboard renders only. buildContactedSeries is that pure aggregator.
describe("buildContactedSeries — server-computed Outreach aggregates (features-service#372)", () => {
  function lead(over: Partial<LeadRow> & { leadId: string }): LeadRow {
    return {
      firstName: null, lastName: null, photoUrl: null,
      orgName: null, orgLogoUrl: null, orgDomain: null,
      title: null, seniority: null, orgIndustry: null, orgEmployeeCount: null, orgCity: null, orgCountry: null,
      tags: [], expectedRevenueUsd: 0, date: null,
      contacted: false, contactedAt: null,
      opened: false, openedAt: null, clicked: false, clickedAt: null,
      repliedPositive: false, repliedPositiveAt: null,
      meetingBooked: false, meetingBookedAt: null, purchased: false, purchasedAt: null,
      signup: false, signupAt: null, formSubmission: false, formSubmissionAt: null,
      ...over,
    };
  }

  it("total = stat-card count = number of contacted leads in the payload", () => {
    const s = buildContactedSeries([
      lead({ leadId: "l1", contacted: true, contactedAt: "2026-06-20T09:00:00.000Z" }),
      lead({ leadId: "l2", contacted: true, contactedAt: "2026-06-21T08:00:00.000Z" }),
      lead({ leadId: "l3", contacted: false }), // not contacted → excluded
    ]);
    expect(s.total).toBe(2);
  });

  it("daily buckets group by the UTC calendar day of contactedAt, ascending", () => {
    const s = buildContactedSeries([
      lead({ leadId: "l1", contacted: true, contactedAt: "2026-06-21T08:00:00.000Z" }),
      lead({ leadId: "l2", contacted: true, contactedAt: "2026-06-20T09:00:00.000Z" }),
      lead({ leadId: "l3", contacted: true, contactedAt: "2026-06-20T23:30:00.000Z" }),
    ]);
    expect(s.daily).toEqual([
      { date: "2026-06-20", count: 2 },
      { date: "2026-06-21", count: 1 },
    ]);
  });

  it("contacted lead with null contactedAt → undatedCount, never a synthesized bucket", () => {
    const s = buildContactedSeries([
      lead({ leadId: "l1", contacted: true, contactedAt: "2026-06-20T09:00:00.000Z" }),
      lead({ leadId: "l2", contacted: true, contactedAt: null }),
    ]);
    expect(s.undatedCount).toBe(1);
    expect(s.daily).toEqual([{ date: "2026-06-20", count: 1 }]);
  });

  it("COHERENCE: total === sum(daily counts) + undatedCount === count(leads contacted)", () => {
    const leads = [
      lead({ leadId: "l1", contacted: true, contactedAt: "2026-06-20T09:00:00.000Z" }),
      lead({ leadId: "l2", contacted: true, contactedAt: "2026-06-20T22:00:00.000Z" }),
      lead({ leadId: "l3", contacted: true, contactedAt: "2026-06-21T08:00:00.000Z" }),
      lead({ leadId: "l4", contacted: true, contactedAt: null }), // dated-unknown
      lead({ leadId: "l5", contacted: false }),                    // not contacted
    ];
    const s = buildContactedSeries(leads);
    const sumDaily = s.daily.reduce((a, b) => a + b.count, 0);
    const contactedLeads = leads.filter((l) => l.contacted).length;
    expect(s.total).toBe(contactedLeads);
    expect(sumDaily + s.undatedCount).toBe(s.total);
  });

  it("card count == sum(daily buckets) exactly when every contacted lead is dated (undatedCount 0)", () => {
    const s = buildContactedSeries([
      lead({ leadId: "l1", contacted: true, contactedAt: "2026-06-20T09:00:00.000Z" }),
      lead({ leadId: "l2", contacted: true, contactedAt: "2026-06-21T08:00:00.000Z" }),
    ]);
    expect(s.undatedCount).toBe(0);
    expect(s.daily.reduce((a, b) => a + b.count, 0)).toBe(s.total);
  });

  it("empty leads → zeroed series (cold-start / no-funnel body)", () => {
    expect(buildContactedSeries([])).toEqual({ total: 0, daily: [], undatedCount: 0 });
  });
});

// features-service#377 — Opens / Clicks / goal-outcome ACTUAL series come from the SAME leads[]
// snapshot, exactly like Outreach, so the four actual series + the table cannot contradict each
// other (no "open with nothing contacted"). The engine exposes the per-lead signal flags + dates;
// buildSignalSeries buckets ANY of them the same coherent way as buildContactedSeries.
describe("computeRevenue — opened/clicked/meeting/purchase flags + dates (features-service#377)", () => {
  const PATHS: ResolvedPath[] = [
    { tag: "contacted", signal: "contacted", expectedRevenueUsd: 3, kind: "delivery" },
    { tag: "opened", signal: "open", expectedRevenueUsd: 3, kind: "delivery" },
    { tag: "visit", signal: "clicked", expectedRevenueUsd: 20, engagementRoute: true },
    { tag: "meeting", signal: "meeting", expectedRevenueUsd: 40 },
    { tag: "closeWin", signal: "closeWin", expectedRevenueUsd: 100 },
  ];

  it("exposes opened/clicked/repliedPositive/meetingBooked/purchased flags + their first-occurrence dates", () => {
    const r = computeRevenue(PATHS, [
      person({
        leadId: "l1",
        signals: { contacted: true, open: true, clicked: true, positiveReply: true, meeting: true, closeWin: true },
        signalDates: {
          contacted: "2026-06-20T10:00:00.000Z",
          open: "2026-06-21T10:00:00.000Z",
          clicked: "2026-06-22T10:00:00.000Z",
          positiveReply: "2026-06-22T18:00:00.000Z",
          meeting: "2026-06-23T10:00:00.000Z",
          closeWin: "2026-06-24T10:00:00.000Z",
        },
      }),
    ]);
    const lead = r.leads[0];
    expect([lead.opened, lead.clicked, lead.repliedPositive, lead.meetingBooked, lead.purchased]).toEqual([true, true, true, true, true]);
    expect(lead.openedAt).toBe("2026-06-21T10:00:00.000Z");
    expect(lead.clickedAt).toBe("2026-06-22T10:00:00.000Z");
    expect(lead.repliedPositiveAt).toBe("2026-06-22T18:00:00.000Z");
    expect(lead.meetingBookedAt).toBe("2026-06-23T10:00:00.000Z");
    expect(lead.purchasedAt).toBe("2026-06-24T10:00:00.000Z");
  });

  it("flags default false + dates null when the signal did not fire (no synthesis)", () => {
    const r = computeRevenue(PATHS, [
      person({ leadId: "l1", signals: { contacted: true, open: true, clicked: false }, signalDates: { contacted: "2026-06-20T10:00:00.000Z", open: "2026-06-21T10:00:00.000Z" } }),
    ]);
    const lead = r.leads[0];
    expect(lead.opened).toBe(true);
    expect(lead.clicked).toBe(false);
    expect(lead.clickedAt).toBeNull();
    expect(lead.repliedPositive).toBe(false);
    expect(lead.repliedPositiveAt).toBeNull();
    expect(lead.meetingBooked).toBe(false);
    expect(lead.meetingBookedAt).toBeNull();
    expect(lead.purchased).toBe(false);
  });

  // Bug: email-gateway's `firstRepliedAt` (→ signalDates.positiveReply) is sentiment-AGNOSTIC, so a
  // negative/neutral-only replier gets a populated date while signals.positiveReply stays false. The
  // per-lead `repliedPositiveAt` must honor its contract (null unless positive-classified) so the daily
  // digest never surfaces a non-positive replier as a positive reply.
  it("repliedPositiveAt is NULL when a lead replied but is NOT positive-classified, even with a firstRepliedAt date", () => {
    const r = computeRevenue(PATHS, [
      // negative-only replier: reply date present (sentiment-agnostic firstRepliedAt), positiveReply signal false
      person({ leadId: "neg", signals: { contacted: true, positiveReply: false }, signalDates: { contacted: "2026-06-20T10:00:00.000Z", positiveReply: "2026-06-21T09:00:00.000Z" } }),
      // neutral-only replier: same shape
      person({ leadId: "neu", signals: { contacted: true, positiveReply: false }, signalDates: { contacted: "2026-06-20T10:00:00.000Z", positiveReply: "2026-06-21T12:00:00.000Z" } }),
      // genuine positive replier: signal true + date → date surfaces
      person({ leadId: "pos", signals: { contacted: true, positiveReply: true }, signalDates: { contacted: "2026-06-20T10:00:00.000Z", positiveReply: "2026-06-21T15:00:00.000Z" } }),
    ]);
    const byId = new Map(r.leads.map((l) => [l.leadId, l]));
    // AC1/AC2: not positive-classified → both false and null (never the sentiment-agnostic date)
    expect([byId.get("neg")!.repliedPositive, byId.get("neg")!.repliedPositiveAt]).toEqual([false, null]);
    expect([byId.get("neu")!.repliedPositive, byId.get("neu")!.repliedPositiveAt]).toEqual([false, null]);
    // AC3: positive-classified → true + its reply date
    expect([byId.get("pos")!.repliedPositive, byId.get("pos")!.repliedPositiveAt]).toEqual([true, "2026-06-21T15:00:00.000Z"]);
    // AC5: the positive-replies series still counts exactly the one positive lead (boolean-gated, unchanged)
    const series = buildSignalSeries(r.leads, (l) => l.repliedPositive, (l) => l.repliedPositiveAt);
    expect(series.total).toBe(1);
  });

  it("opened/clicked counts never exceed the contacted snapshot — all from the same leads[]", () => {
    const r = computeRevenue(PATHS, [
      person({ leadId: "l1", signals: { contacted: true, open: true, clicked: true }, signalDates: { contacted: "2026-06-20T09:00:00.000Z", open: "2026-06-20T10:00:00.000Z", clicked: "2026-06-20T11:00:00.000Z" } }),
      person({ leadId: "l2", signals: { contacted: true, open: true, clicked: false }, signalDates: { contacted: "2026-06-20T09:00:00.000Z", open: "2026-06-21T10:00:00.000Z" } }),
      person({ leadId: "l3", signals: { contacted: true, open: false, clicked: false }, signalDates: { contacted: "2026-06-21T09:00:00.000Z" } }),
    ]);
    const contacted = buildContactedSeries(r.leads);
    const opened = buildSignalSeries(r.leads, (l) => l.opened, (l) => l.openedAt);
    const clicked = buildSignalSeries(r.leads, (l) => l.clicked, (l) => l.clickedAt);
    expect(contacted.total).toBe(3);
    expect(opened.total).toBe(2);
    expect(clicked.total).toBe(1);
    // Coherence: no actual series exceeds contacted; opens supersets clicks; each reconciles.
    expect(opened.total).toBeLessThanOrEqual(contacted.total);
    expect(clicked.total).toBeLessThanOrEqual(opened.total);
    for (const s of [contacted, opened, clicked]) {
      expect(s.daily.reduce((a, b) => a + b.count, 0) + s.undatedCount).toBe(s.total);
    }
  });
});

describe("buildSignalSeries — generic per-signal aggregator (features-service#377)", () => {
  function lead(over: Partial<LeadRow> & { leadId: string }): LeadRow {
    return {
      firstName: null, lastName: null, photoUrl: null,
      orgName: null, orgLogoUrl: null, orgDomain: null,
      title: null, seniority: null, orgIndustry: null, orgEmployeeCount: null, orgCity: null, orgCountry: null,
      tags: [], expectedRevenueUsd: 0, date: null,
      contacted: false, contactedAt: null,
      opened: false, openedAt: null, clicked: false, clickedAt: null,
      repliedPositive: false, repliedPositiveAt: null,
      meetingBooked: false, meetingBookedAt: null, purchased: false, purchasedAt: null,
      signup: false, signupAt: null, formSubmission: false, formSubmissionAt: null,
      ...over,
    };
  }

  it("buckets by the selected signal's UTC day; undated counted in total only", () => {
    const s = buildSignalSeries(
      [
        lead({ leadId: "l1", opened: true, openedAt: "2026-06-20T08:00:00.000Z" }),
        lead({ leadId: "l2", opened: true, openedAt: "2026-06-20T23:30:00.000Z" }),
        lead({ leadId: "l3", opened: true, openedAt: null }), // dated unknown → undatedCount
        lead({ leadId: "l4", opened: false, openedAt: "2026-06-20T08:00:00.000Z" }), // not opened → excluded
      ],
      (l) => l.opened,
      (l) => l.openedAt,
    );
    expect(s.total).toBe(3);
    expect(s.daily).toEqual([{ date: "2026-06-20", count: 2 }]);
    expect(s.undatedCount).toBe(1);
    expect(s.daily.reduce((a, b) => a + b.count, 0) + s.undatedCount).toBe(s.total);
  });
});

// Firmographic passthrough — the person's title/seniority + company industry/headcount/location ride
// through computeRevenue onto each leads[] row so the outcome digest + dashboard can show WHO the
// prospect is. Present when known, null when unknown (no synthesis); dedup backfills null from a
// later campaign row of the same lead.
describe("computeRevenue — firmographic passthrough onto leads[]", () => {
  function fp(over: Partial<EnginePerson> & { leadId: string; signals: Record<string, boolean> }): EnginePerson {
    return {
      firstName: "A", lastName: "B", photoUrl: null,
      orgId: null, orgName: null, orgLogoUrl: null, orgDomain: null,
      title: null, seniority: null, orgIndustry: null, orgEmployeeCount: null, orgCity: null, orgCountry: null,
      ...over,
    };
  }

  it("carries known firmographics onto the leads[] row", () => {
    const r = computeRevenue(PATHS, [
      fp({
        leadId: "l1", signals: { clicked: true, positiveReply: false },
        title: "VP Sales", seniority: "vp",
        orgId: "o1", orgName: "Acme", orgIndustry: "software",
        orgEmployeeCount: 42, orgCity: "Portland", orgCountry: "United States",
      }),
    ]);
    expect(r.leads[0]).toMatchObject({
      title: "VP Sales", seniority: "vp",
      orgIndustry: "software", orgEmployeeCount: 42,
      orgCity: "Portland", orgCountry: "United States",
    });
  });

  it("leaves every unknown firmographic null — no synthesis", () => {
    const r = computeRevenue(PATHS, [fp({ leadId: "l1", signals: { clicked: true, positiveReply: false } })]);
    expect(r.leads[0]).toMatchObject({
      title: null, seniority: null, orgIndustry: null,
      orgEmployeeCount: null, orgCity: null, orgCountry: null,
    });
  });

  it("dedup backfills null firmographics from a later campaign row of the same lead", () => {
    const r = computeRevenue(PATHS, [
      // First row: engaged but no firmographics resolved yet.
      fp({ leadId: "l1", signals: { clicked: true, positiveReply: false } }),
      // Second row (same lead, another campaign): carries the enrichment.
      fp({
        leadId: "l1", signals: { clicked: false, positiveReply: true },
        title: "Director", seniority: "director",
        orgId: "o1", orgName: "Acme", orgIndustry: "fintech",
        orgEmployeeCount: 500, orgCity: "Berlin", orgCountry: "Germany",
      }),
    ]);
    expect(r.leads).toHaveLength(1);
    expect(r.leads[0]).toMatchObject({
      title: "Director", seniority: "director",
      orgIndustry: "fintech", orgEmployeeCount: 500,
      orgCity: "Berlin", orgCountry: "Germany",
    });
  });

  it("dedup never overwrites a known person firmographic with a later null", () => {
    const r = computeRevenue(PATHS, [
      fp({ leadId: "l1", signals: { clicked: true, positiveReply: false }, title: "CEO", seniority: "c_suite" }),
      fp({ leadId: "l1", signals: { clicked: false, positiveReply: true } }), // no title/seniority
    ]);
    expect(r.leads[0]).toMatchObject({ title: "CEO", seniority: "c_suite" });
  });
});
