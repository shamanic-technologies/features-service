import { describe, it, expect } from "vitest";
import { computeRevenue, type ResolvedPath, type EnginePerson } from "./revenue-engine.js";

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

// ── Decay (stage staleness) ───────────────────────────────────────────────────
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-01T00:00:00Z");
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString();

// Mirrors the sales funnel: pre-engagement delivery stages carry a decay window; click/reply don't.
const DECAY_PATHS: ResolvedPath[] = [
  { tag: "contacted", signal: "contacted", expectedRevenueUsd: 3, kind: "delivery", staleAfterMs: 7 * DAY },
  { tag: "sent", signal: "sent", expectedRevenueUsd: 6, kind: "delivery", staleAfterMs: 3 * DAY },
  { tag: "delivered", signal: "delivered", expectedRevenueUsd: 12, kind: "delivery", staleAfterMs: 14 * DAY },
  { tag: "opened", signal: "open", expectedRevenueUsd: 12, kind: "delivery", staleAfterMs: 14 * DAY },
  { tag: "visit", signal: "clicked", expectedRevenueUsd: 20, kind: "engagement" },
  { tag: "reply", signal: "positiveReply", expectedRevenueUsd: 120, kind: "engagement" },
];

describe("computeRevenue — decay (stall phase-out)", () => {
  it("contacted but no sent past the 1-week window → dead (0 EV, stale tag, off the total)", () => {
    const r = computeRevenue(DECAY_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { contacted: true }, signalDates: { contacted: ago(8) } }),
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(0);
    expect(r.organizations).toEqual([]);
    expect(r.leads).toHaveLength(1); // still shown
    expect(r.leads[0].expectedRevenueUsd).toBe(0);
    expect(r.leads[0].tags).toEqual(["contacted", "stale"]);
    expect(r.events).toEqual([]);
  });

  it("contacted within the window → alive", () => {
    const r = computeRevenue(DECAY_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { contacted: true }, signalDates: { contacted: ago(5) } }),
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(3);
    expect(r.leads[0].tags).toEqual(["contacted"]);
  });

  it("sent stalls on the tighter 3-day window (furthest stage drives decay)", () => {
    const r = computeRevenue(DECAY_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { contacted: true, sent: true }, signalDates: { contacted: ago(6), sent: ago(4) } }),
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(0); // sent 4d ago > 3d window
    expect(r.leads[0].tags).toEqual(["sent", "stale"]);
  });

  it("delivered: alive at 10d, dead at 15d", () => {
    const alive = computeRevenue(DECAY_PATHS, [person({ leadId: "l1", signals: { delivered: true }, signalDates: { delivered: ago(10) } })], NOW);
    expect(alive.headline.totalPipelineUsd).toBe(12);
    const dead = computeRevenue(DECAY_PATHS, [person({ leadId: "l1", signals: { delivered: true }, signalDates: { delivered: ago(15) } })], NOW);
    expect(dead.headline.totalPipelineUsd).toBe(0);
  });

  it("open resets the clock: opened 10d ago is alive (tag opened) even though delivered is old", () => {
    const r = computeRevenue(DECAY_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { delivered: true, open: true }, signalDates: { delivered: ago(40), open: ago(10) } }),
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(12);
    expect(r.leads[0].tags).toEqual(["opened"]);
  });

  it("opened but stalled past 2 weeks → dead", () => {
    const r = computeRevenue(DECAY_PATHS, [
      person({ leadId: "l1", signals: { delivered: true, open: true }, signalDates: { delivered: ago(40), open: ago(20) } }),
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(0);
  });

  it("engagement never decays in Phase 1: a 60-day-old click stays alive", () => {
    const r = computeRevenue(DECAY_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { delivered: true, clicked: true }, signalDates: { delivered: ago(90), clicked: ago(60) } }),
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(20);
    expect(r.leads[0].tags).toEqual(["visit"]);
  });

  it("fail-open: a delivery stage with no known date never decays", () => {
    const r = computeRevenue(DECAY_PATHS, [
      person({ leadId: "l1", signals: { delivered: true } }), // no signalDates
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(12);
  });

  it("time series steps UP at engagement and DOWN at a stalled org's death; final = alive total", () => {
    const r = computeRevenue(DECAY_PATHS, [
      person({ leadId: "l1", orgId: "alive", signals: { clicked: true }, signalDates: { clicked: "2026-01-01T00:00:00Z" } }), // +20, stays
      person({ leadId: "l2", orgId: "dead", signals: { delivered: true }, signalDates: { delivered: ago(20) } }),             // +12 then -12 (death = 20d-14d = 6d ago)
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(20); // only the alive org
    expect(r.timeSeries).toEqual([
      { date: "2026-01-01T00:00:00Z", cumulativePipelineUsd: 20 },
      { date: ago(20), cumulativePipelineUsd: 32 },
      { date: ago(6), cumulativePipelineUsd: 20 }, // stalled org phased out
    ]);
  });

  it("org with one alive + one stalled member stays alive at the live member's EV", () => {
    const r = computeRevenue(DECAY_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { clicked: true }, signalDates: { clicked: ago(2) } }),     // alive 20
      person({ leadId: "l2", orgId: "o1", signals: { contacted: true }, signalDates: { contacted: ago(30) } }), // stale
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(20);
    expect(r.organizations).toHaveLength(1);
    expect(r.leads).toHaveLength(2); // both rows shown
  });
});

// ── Phase 2 decay: post-engagement (reply → meeting → close-win) ──────────────────
// Mirrors the live sales funnel: reply carries a 14d onward window, meeting a 30d window,
// click & closeWin are terminals with no window. closeWin EV = full LTR (realized).
const PHASE2_PATHS: ResolvedPath[] = [
  { tag: "contacted", signal: "contacted", expectedRevenueUsd: 3, kind: "delivery", staleAfterMs: 7 * DAY },
  { tag: "sent", signal: "sent", expectedRevenueUsd: 6, kind: "delivery", staleAfterMs: 3 * DAY },
  { tag: "delivered", signal: "delivered", expectedRevenueUsd: 12, kind: "delivery", staleAfterMs: 14 * DAY },
  { tag: "opened", signal: "open", expectedRevenueUsd: 12, kind: "delivery", staleAfterMs: 14 * DAY },
  { tag: "visit", signal: "clicked", expectedRevenueUsd: 20, kind: "engagement" },
  { tag: "reply", signal: "positiveReply", expectedRevenueUsd: 120, kind: "engagement", staleAfterMs: 14 * DAY },
  { tag: "meeting", signal: "meeting", expectedRevenueUsd: 300, kind: "engagement", staleAfterMs: 30 * DAY },
  { tag: "closeWin", signal: "closeWin", expectedRevenueUsd: 1000, kind: "engagement" },
];

describe("computeRevenue — Phase 2 decay (post-engagement)", () => {
  it("reply within 14d, no meeting → alive at reply EV, tag [reply]", () => {
    const r = computeRevenue(PHASE2_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { positiveReply: true }, signalDates: { positiveReply: ago(10) } }),
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(120);
    expect(r.leads[0].tags).toEqual(["reply"]);
  });

  it("reply 20d ago, no meeting → dead (0 EV, [reply, stale], off total, kept in leads)", () => {
    const r = computeRevenue(PHASE2_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { positiveReply: true }, signalDates: { positiveReply: ago(20) } }),
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(0);
    expect(r.organizations).toEqual([]);
    expect(r.leads).toHaveLength(1);
    expect(r.leads[0].expectedRevenueUsd).toBe(0);
    expect(r.leads[0].tags).toEqual(["reply", "stale"]);
    expect(r.events).toEqual([]);
  });

  it("meeting booked within 30d → alive at meeting EV, tag includes meeting", () => {
    const r = computeRevenue(PHASE2_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { positiveReply: true, meeting: true }, signalDates: { positiveReply: ago(20), meeting: ago(10) } }),
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(300); // meeting EV (reply alone would be dead at 20d, but meeting reset the clock)
    expect(r.leads[0].tags.sort()).toEqual(["meeting", "reply"]);
  });

  it("meeting 40d ago, no close → dead ([reply, meeting, stale], off total)", () => {
    const r = computeRevenue(PHASE2_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { positiveReply: true, meeting: true }, signalDates: { positiveReply: ago(60), meeting: ago(40) } }),
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(0);
    expect(r.leads[0].expectedRevenueUsd).toBe(0);
    expect(r.leads[0].tags).toContain("stale");
    expect(r.leads[0].tags).toContain("meeting");
  });

  it("closed-won books full LTR and never decays, even 400 days old", () => {
    const r = computeRevenue(PHASE2_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { positiveReply: true, meeting: true, closeWin: true }, signalDates: { positiveReply: ago(420), meeting: ago(410), closeWin: ago(400) } }),
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(1000); // full LTR (MAX over fired paths)
    expect(r.leads[0].expectedRevenueUsd).toBe(1000);
    expect(r.leads[0].tags).toContain("closeWin");
    expect(r.leads[0].tags).not.toContain("stale");
  });

  it("closeWin with no prior reply/meeting → tag [closeWin] alone (delivery suppressed), EV = LTR", () => {
    const r = computeRevenue(PHASE2_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { delivered: true, closeWin: true }, signalDates: { delivered: ago(300), closeWin: ago(250) } }),
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(1000);
    expect(r.leads[0].tags).toEqual(["closeWin"]);
  });

  it("fail-open: replied but reply date unknown → alive even if an earlier delivery is old & stale", () => {
    const r = computeRevenue(PHASE2_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { delivered: true, positiveReply: true }, signalDates: { delivered: ago(90) } }), // no reply date
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(120); // furthest stage = reply (undated) → fail-open
    expect(r.leads[0].tags).toEqual(["reply"]);
  });

  it("a click (visit) still never decays in Phase 2: a 60-day-old click stays alive", () => {
    const r = computeRevenue(PHASE2_PATHS, [
      person({ leadId: "l1", orgId: "o1", signals: { delivered: true, clicked: true }, signalDates: { delivered: ago(90), clicked: ago(60) } }),
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(20);
    expect(r.leads[0].tags).toEqual(["visit"]);
  });

  it("closeWin steps the time series UP and stays (realized revenue never reverses)", () => {
    const r = computeRevenue(PHASE2_PATHS, [
      person({ leadId: "l1", orgId: "won", signals: { closeWin: true }, signalDates: { closeWin: "2026-01-01T00:00:00Z" } }),
      person({ leadId: "l2", orgId: "dead", signals: { positiveReply: true }, signalDates: { positiveReply: ago(20) } }), // reply 20d → dead
    ], NOW);
    expect(r.headline.totalPipelineUsd).toBe(1000); // only the closed org
    expect(r.timeSeries[0]).toEqual({ date: "2026-01-01T00:00:00Z", cumulativePipelineUsd: 1000 });
  });
});

// ── Engagement-route combine (click + reply summed as independent probabilities, bounded 1 LTR) ──
// No decay windows on these fixtures → date-independent (terminals/engagement routes never decay).
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
    const r = computeRevenue(ROUTE_PATHS, [person({ leadId: "l1", signals: { clicked: true, positiveReply: false } })], undefined, LTR);
    expect(r.leads[0].expectedRevenueUsd).toBe(20);
  });

  it("reply only → unchanged route EV", () => {
    const r = computeRevenue(ROUTE_PATHS, [person({ leadId: "l1", signals: { clicked: false, positiveReply: true } })], undefined, LTR);
    expect(r.leads[0].expectedRevenueUsd).toBe(120);
  });

  it("BOTH routes → combined a+b−a·b/LTR, strictly > max(either) and < plain sum", () => {
    const r = computeRevenue(ROUTE_PATHS, [person({ leadId: "l1", signals: { clicked: true, positiveReply: true } })], undefined, LTR);
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
    const r = computeRevenue(HOT, [person({ leadId: "l1", signals: { clicked: true, positiveReply: true } })], undefined, LTR);
    expect(r.leads[0].expectedRevenueUsd).toBeCloseTo(920, 6); // 600 + 800 − 480
    expect(r.leads[0].expectedRevenueUsd).toBeLessThanOrEqual(LTR);
  });

  it("no cap passed (default 0) → routes fall back to bare MAX (no combine)", () => {
    const r = computeRevenue(ROUTE_PATHS, [person({ leadId: "l1", signals: { clicked: true, positiveReply: true } })]);
    expect(r.leads[0].expectedRevenueUsd).toBe(120);
  });

  it("delivery-furthest only (no engagement) → unchanged MAX", () => {
    const r = computeRevenue(FULL_PATHS, [person({ leadId: "l1", signals: { delivered: true } })], undefined, LTR);
    expect(r.leads[0].expectedRevenueUsd).toBe(12);
    expect(r.leads[0].tags).toEqual(["delivered"]);
  });

  it("routes + meeting → MAX(combined, meeting) — convergence not double-counted", () => {
    const r = computeRevenue(FULL_PATHS, [person({ leadId: "l1", signals: { clicked: true, positiveReply: true, meeting: true } })], undefined, LTR);
    expect(r.leads[0].expectedRevenueUsd).toBe(300); // combined(137.6) < meeting(300) → meeting dominates
  });

  it("closeWin → full LTR dominates the combine (realized revenue)", () => {
    const r = computeRevenue(FULL_PATHS, [person({ leadId: "l1", signals: { clicked: true, positiveReply: true, closeWin: true } })], undefined, LTR);
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
