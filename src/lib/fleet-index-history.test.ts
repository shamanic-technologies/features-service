import { describe, expect, it } from "vitest";
import { SCEO_FEATURE_SLUG, SCEO_POSITIVE_REPLY_LEG, SCEO_WEBSITE_VISIT_LEG } from "./fleet-indexes.js";
import {
  addPairPersons,
  cutoffDayOn,
  dayRange,
  emptyPersonHistory,
  planRecomputedWrites,
  recomputeIndexHistory,
  type AssignmentChange,
  type DatedIndexPoint,
  type DatedSlugSpend,
  type HistoryInputs,
  type StoredIndexRow,
  type WorkflowVersion,
  executableDynastiesOn,
} from "./fleet-index-history.js";
import { matchChannelLegKey } from "./funnel-legs.js";
import type { Journey } from "./lived-sales-paths.js";
import type { EnginePerson } from "./revenue-engine.js";
import { asOfPerson, indexTimelines } from "./serving-row-credit.js";

const REPLY_LEG = matchChannelLegKey(SCEO_FEATURE_SLUG, SCEO_POSITIVE_REPLY_LEG)!;
const VISIT_LEG = matchChannelLegKey(SCEO_FEATURE_SLUG, SCEO_WEBSITE_VISIT_LEG)!;
const DAYS = dayRange("2026-08-01", "2026-09-30");
const CAMPAIGN = "c1";
const LEGS = [
  { legKey: REPLY_LEG, campaignIds: new Set([CAMPAIGN]) },
  { legKey: VISIT_LEG, campaignIds: new Set([CAMPAIGN]) },
];
const CREATED = "2026-07-01T00:00:00.000Z";
/** Both executable today unless `executableUntil` names when workflow-service stopped running them. */
function versions(executableUntil: Record<string, string> = {}): WorkflowVersion[] {
  return [
    { workflowSlug: "a1", workflowDynastySlug: "alpha", workflowDynastyName: "Alpha", createdAt: CREATED, executableUntil: executableUntil.alpha ?? null },
    { workflowSlug: "b1", workflowDynastySlug: "beta", workflowDynastyName: "Beta", createdAt: CREATED, executableUntil: executableUntil.beta ?? null },
  ];
}

interface Lead {
  id: string;
  slug: string;
  servedAt: string;
  replyAt?: string | null;
}

function person(l: Lead): EnginePerson {
  return {
    leadId: l.id,
    campaignId: CAMPAIGN,
    workflowSlug: l.slug,
    servedAt: l.servedAt,
    signals: { contacted: true, sent: true, positiveReply: l.replyAt !== undefined },
  } as unknown as EnginePerson;
}

function journey(l: Lead): Journey {
  return {
    leadId: l.id,
    offerId: null,
    acts: [{ campaignId: CAMPAIGN, firstActedAt: l.servedAt, kind: "email" }],
    emailSends: [{ campaignId: CAMPAIGN, workflowSlug: l.slug, firstSentAt: l.servedAt, lastSentAt: l.servedAt, screenable: true }],
    facts:
      l.replyAt !== undefined
        ? [{ label: "interested", source: "reply", occurredAt: l.replyAt, campaignId: CAMPAIGN, attributable: true, valueCents: null }]
        : [],
  };
}

const BASE_LEADS: Lead[] = [
  ...["a-1", "a-2", "a-3", "a-4", "a-5"].map((id) => ({ id, slug: "a1", servedAt: "2026-08-01T10:00:00.000Z" })),
  ...["b-1", "b-2", "b-3", "b-4"].map((id) => ({ id, slug: "b1", servedAt: "2026-08-01T10:00:00.000Z" })),
];
BASE_LEADS[0]!.replyAt = "2026-08-05T09:00:00.000Z";
BASE_LEADS[5]!.replyAt = "2026-08-03T09:00:00.000Z";

function spendDays(slug: string, from: string, to: string, cents: number): DatedSlugSpend[] {
  return dayRange(from, to).map((day) => ({ legKey: REPLY_LEG, workflowSlug: slug, day, spentCents: cents, runCount: 1 }));
}
const BASE_SPEND = [...spendDays("a1", "2026-08-01", "2026-08-10", 1000), ...spendDays("b1", "2026-08-01", "2026-09-30", 200)];

function inputs(leads: Lead[], spend: DatedSlugSpend[], changes: AssignmentChange[] = [], workflows: WorkflowVersion[] = versions()): HistoryInputs {
  const persons = emptyPersonHistory(DAYS);
  addPairPersons(persons, leads.map(person), indexTimelines(leads.map(journey)), LEGS);
  return { days: DAYS, websiteVisitLeg: VISIT_LEG, positiveReplyLeg: REPLY_LEG, persons, spend, assignmentChanges: changes, workflows };
}

const on = (points: DatedIndexPoint[], slug: string, day: string) => points.find((p) => p.point.indexSlug === slug && p.day === day)?.point;
const COST = "cold-email-cost-per-positive-reply";
const RATE = "cold-email-positive-reply-rate";

describe("fleet index history (INDEX-HISTORY-BACKFILL-1019)", () => {
  it("a workflow that can still run stays pickable after its last run; a retired one stops when workflow-service retired it", () => {
    const spend = [...spendDays("a1", "2026-08-01", "2026-08-10", 100), ...spendDays("b1", "2026-08-01", "2026-09-30", 200)];
    // Alpha ($1 per reply) last ran 08-10. Executable today: the money still goes to it once mature (08-23 on).
    const runnable = recomputeIndexHistory(inputs(BASE_LEADS, spend));
    expect(on(runnable, COST, "2026-09-30")!.workflowDynastySlug).toBe("alpha");
    expect(runnable.some((p) => p.point.indexSlug === COST && p.point.workflowDynastySlug === "beta")).toBe(false);
    // Retired 09-05 15:00: still the index on 09-04, Beta from 09-05 (the end of a day is the instant read).
    const retired = recomputeIndexHistory(inputs(BASE_LEADS, spend, [], versions({ alpha: "2026-09-05T15:00:00.000Z" })));
    expect(on(retired, COST, "2026-09-04")!.workflowDynastySlug).toBe("alpha");
    expect(on(retired, COST, "2026-09-05")!.workflowDynastySlug).toBe("beta");
  });

  it("cost rows landing after a retirement never make a workflow pickable again (arcadia, INDEX-HISTORY-MATURITY-AUDIT-1019)", () => {
    // Alpha retired 08-20 but its old sequences keep costing (reply handling) until 09-30: the index is Beta's from 08-23.
    const spend = [...spendDays("a1", "2026-08-01", "2026-09-30", 100), ...spendDays("b1", "2026-08-01", "2026-09-30", 200)];
    const points = recomputeIndexHistory(inputs(BASE_LEADS, spend, [], versions({ alpha: "2026-08-20T10:00:00.000Z" })));
    for (const day of dayRange("2026-08-23", "2026-09-30")) expect(on(points, COST, day)!.workflowDynastySlug, day).toBe("beta");
  });

  it("a dynasty can run when one of its versions was executable at the end of the day", () => {
    const v: WorkflowVersion[] = [
      { workflowSlug: "a1", workflowDynastySlug: "alpha", workflowDynastyName: null, createdAt: "2026-08-01T09:00:00.000Z", executableUntil: "2026-08-10T12:00:00.000Z" },
      { workflowSlug: "a2", workflowDynastySlug: "alpha", workflowDynastyName: null, createdAt: "2026-08-10T12:00:00.000Z", executableUntil: "2026-08-20T08:00:00.000Z" },
      { workflowSlug: "g1", workflowDynastySlug: "gamma", workflowDynastyName: null, createdAt: "2026-08-15T09:00:00.000Z", executableUntil: null },
    ];
    expect([...executableDynastiesOn("2026-07-31", v)]).toEqual([]);
    expect([...executableDynastiesOn("2026-08-01", v)]).toEqual(["alpha"]);
    expect([...executableDynastiesOn("2026-08-10", v)]).toEqual(["alpha"]);
    expect([...executableDynastiesOn("2026-08-19", v)].sort()).toEqual(["alpha", "gamma"]);
    expect([...executableDynastiesOn("2026-08-20", v)]).toEqual(["gamma"]);
  });

  it("cuts maturity on the live rule: a person served on day S is mature from S + duration + 1", () => {
    expect(cutoffDayOn(REPLY_LEG, "2026-08-22")).toBe("2026-08-01");
    const points = recomputeIndexHistory(inputs(BASE_LEADS, BASE_SPEND));
    // Served 08-01: not mature on 08-22 (cutoff 08-01), mature on 08-23 (cutoff 08-02). The series starts there.
    expect(on(points, COST, "2026-08-22")).toBeUndefined();
    const first = on(points, COST, "2026-08-23")!;
    // Both can run; Beta is cheaper ($2 vs $10 per reply). Mature spend = runs started before 08-02.
    expect(first.workflowDynastySlug).toBe("beta");
    expect(first.value).toBeCloseTo(2, 6);
    expect(on(points, RATE, "2026-08-23")!.value).toBeCloseTo(25, 6);
  });

  it("data dated after day D never moves D's point", () => {
    const base = recomputeIndexHistory(inputs(BASE_LEADS, BASE_SPEND));
    // Later facts: a reply on 09-10, a person served on 09-05, a deprecation on 09-15, spend on a new day.
    const later: Lead[] = BASE_LEADS.map((l) => (l.id === "b-2" ? { ...l, replyAt: "2026-09-10T08:00:00.000Z" } : l));
    later.push({ id: "b-9", slug: "b1", servedAt: "2026-09-05T08:00:00.000Z", replyAt: "2026-09-06T08:00:00.000Z" });
    const changes: AssignmentChange[] = [
      { legKey: REPLY_LEG, workflowDynastySlug: "alpha", toState: "active", decidedAt: "2026-08-01T00:00:00.000Z" },
      { legKey: REPLY_LEG, workflowDynastySlug: "beta", toState: "active", decidedAt: "2026-08-01T00:00:00.000Z" },
      { legKey: REPLY_LEG, workflowDynastySlug: "beta", toState: "deprecated", decidedAt: "2026-09-15T12:00:00.000Z" },
    ];
    const withLater = recomputeIndexHistory(inputs(later, [...BASE_SPEND, ...spendDays("a1", "2026-09-20", "2026-09-20", 5000)], changes));
    for (const day of dayRange("2026-08-23", "2026-09-05")) {
      expect(on(withLater, COST, day), day).toEqual(on(base, COST, day));
      expect(on(withLater, RATE, day), day).toEqual(on(base, RATE, day));
    }
    // The 09-10 reply is in the 09-10 point on (served 08-01, mature), not before.
    expect(on(withLater, COST, "2026-09-09")!.outcomes).toBe(1);
    expect(on(withLater, COST, "2026-09-10")!.outcomes).toBe(2);
    // From the deprecation on, Beta can no longer be picked: Alpha (still runnable) is the index.
    expect(on(withLater, COST, "2026-09-14")!.workflowDynastySlug).toBe("beta");
    expect(on(withLater, COST, "2026-09-16")!.workflowDynastySlug).toBe("alpha");
  });

  it("a person stands as they stood at the end of the day: later and undated evidence are out", () => {
    const lead: Lead = { id: "x", slug: "b1", servedAt: "2026-09-20T08:00:00.000Z", replyAt: "2026-09-25T08:00:00.000Z" };
    const p = person(lead);
    const t = indexTimelines([
      {
        ...journey(lead),
        // First emailed on 08-01 by another serve; the recorded serve (the LATEST) is 09-20.
        emailSends: [{ campaignId: CAMPAIGN, workflowSlug: "b1", firstSentAt: "2026-08-01T08:00:00.000Z", lastSentAt: "2026-09-20T08:00:00.000Z", screenable: true }],
        facts: [
          { label: "interested", source: "reply", occurredAt: "2026-09-25T08:00:00.000Z", campaignId: CAMPAIGN, attributable: true, valueCents: null },
          { label: "interested", source: "reply", occurredAt: null, campaignId: CAMPAIGN, attributable: true, valueCents: null },
        ],
      },
    ]).get("x");
    const cut = asOfPerson(p, t, Date.parse("2026-09-10T23:59:59.999Z"))!;
    expect(cut.person.servedAt).toBe("2026-08-01T08:00:00.000Z");
    expect(cut.person.signals.positiveReply).toBe(false);
    expect(cut.timeline!.replies).toEqual([]);
    expect(asOfPerson(p, t, Date.parse("2026-07-31T23:59:59.999Z"))).toBeNull();
    expect(asOfPerson(p, t, Date.parse("2026-09-25T23:59:59.999Z"))!.person.signals.positiveReply).toBe(true);
  });

  it("a person with no serve date stands on their first send", () => {
    const lead: Lead = { id: "n", slug: "b1", servedAt: "2026-08-04T08:00:00.000Z", replyAt: "2026-08-06T08:00:00.000Z" };
    const p = { ...person(lead), servedAt: null } as EnginePerson;
    const t = indexTimelines([journey(lead)]).get("n");
    expect(asOfPerson(p, t, Date.parse("2026-08-03T23:59:59.999Z"))).toBeNull();
    const cut = asOfPerson(p, t, Date.parse("2026-08-10T23:59:59.999Z"))!;
    expect(cut.person.servedAt).toBe("2026-08-04T08:00:00.000Z");
    expect(cut.person.signals.positiveReply).toBe(true);
    const h = emptyPersonHistory(DAYS);
    addPairPersons(h, [p], indexTimelines([journey(lead)]), LEGS);
    expect(h.undatedPersons).toBe(0);
  });

  it("a re-run writes nothing and a recorded day is never in the plan", () => {
    const points = recomputeIndexHistory(inputs(BASE_LEADS, BASE_SPEND));
    const first = planRecomputedWrites(points, [
      { indexSlug: COST, day: "2026-09-30", basis: "recorded", value: 9, status: "noise", outcomes: 1, contacted: 4, workflowDynastySlug: "beta", unavailableReason: null, inputs: {} },
    ]);
    expect(first.skippedRecorded).toBe(1);
    expect(first.writes.some((w) => w.point.indexSlug === COST && w.day === "2026-09-30")).toBe(false);
    // What the first run wrote, read back as stored rows (jsonb round trip).
    const stored: StoredIndexRow[] = [
      // jsonb hands the keys back in its own order (shortest first), never the written one.
      ...first.writes.map((w) => ({ ...w.point, day: w.day, basis: "recomputed", inputs: Object.fromEntries(Object.entries(w.point.inputs).reverse()) })),
      { indexSlug: COST, day: "2026-09-30", basis: "recorded", value: 9, status: "noise", outcomes: 1, contacted: 4, workflowDynastySlug: "beta", unavailableReason: null, inputs: {} },
    ];
    const again = planRecomputedWrites(recomputeIndexHistory(inputs(BASE_LEADS, BASE_SPEND)), stored);
    expect(again.writes).toEqual([]);
    expect(again.unchanged).toBe(first.writes.length);
    expect(again.skippedRecorded).toBe(1);
  });
});
