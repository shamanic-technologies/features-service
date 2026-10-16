import { describe, it, expect, vi, beforeEach } from "vitest";

vi.unmock("./fleet-positive-repliers.js");
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { asServingRowEarned, creditServingRows, creditedSignal } from "./serving-row-credit.js";
import { positiveRepliersOf, crmRepliesBySlug } from "./crm-only-repliers.js";
import { matureSlugStats } from "./mature-evidence.js";
import { contactedPersonsBySlug } from "./contacted-recorder.js";
import type { Journey } from "./lived-sales-paths.js";
import type { EnginePerson } from "./revenue-engine.js";

const { bucketPopulation } = await import("./fleet-positive-repliers.js");

/**
 * prod 2026-10-15 (OUTCOME-BEFORE-WORKFLOW-1015): a person's brand-scoped row is the LATEST one served, and it
 * carries the person's brand-wide evidence. `new-wf` (campaign C-NEW) was served people in October who had
 * replied positively in May to `old-wf` (campaign C-OLD), and counted their replies as its own.
 */
function person(leadId: string, campaignId: string, workflowSlug: string, signals: Record<string, boolean>, extra: Partial<EnginePerson> = {}): EnginePerson {
  return {
    leadId,
    firstName: null,
    lastName: null,
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
    campaignId,
    workflowSlug,
    servedAt: "2026-10-15T12:00:00.000Z",
    signals,
    ...extra,
  };
}

const email = (campaignId: string, firstAt: string) => ({ campaignId, firstActedAt: firstAt, kind: "email" });
const reply = (campaignId: string | null, occurredAt: string, label = "interested") => ({
  label,
  source: "reply",
  occurredAt,
  campaignId,
  attributable: true,
  valueCents: null,
});

const journeys: Journey[] = [
  // BEFORE: replied positively in May to the old campaign; the new one never emailed them.
  { leadId: "before", offerId: "o", facts: [reply("C-OLD", "2026-05-24T14:27:09Z")], acts: [email("C-OLD", "2026-05-16T00:00:00Z")] },
  // BEFORE, re-emailed: the new campaign did email them in October, but the reply is May's, in the old thread.
  { leadId: "before-emailed", offerId: "o", facts: [reply("C-OLD", "2026-07-06T14:00:00Z")], acts: [email("C-OLD", "2026-07-01T00:00:00Z"), email("C-NEW", "2026-10-12T22:44:17Z")] },
  // AFTER: replied in the new campaign's own thread, minutes after its email (Jerry Clark).
  { leadId: "after", offerId: "o", facts: [reply("C-OLD", "2026-07-08T15:01:52Z"), reply("C-NEW", "2026-10-12T23:13:23Z")], acts: [email("C-OLD", "2026-07-08T13:09:02Z"), email("C-NEW", "2026-10-12T23:11:34Z")] },
  // A question is a positive reply too (lead-service's conversation rung), in the new campaign's thread.
  { leadId: "question", offerId: "o", facts: [reply("C-NEW", "2026-10-13T08:00:00Z", "question")], acts: [email("C-NEW", "2026-10-12T00:00:00Z")] },
  // CRM: the customer's CRM says positive in August, before the new campaign's first email in October.
  { leadId: "crm-before", offerId: "o", facts: [], acts: [email("C-OLD", "2026-08-01T00:00:00Z"), email("C-NEW", "2026-10-12T00:00:00Z")] },
  // CRM after the new campaign's first email.
  { leadId: "crm-after", offerId: "o", facts: [], acts: [email("C-NEW", "2026-10-12T00:00:00Z")] },
];

function population(): EnginePerson[] {
  return [
    person("before", "C-NEW", "new-wf", { contacted: true, positiveReply: true }),
    person("before-emailed", "C-NEW", "new-wf", { contacted: true, positiveReply: true }),
    person("after", "C-NEW", "new-wf", { contacted: true, positiveReply: true }),
    person("question", "C-NEW", "new-wf", { contacted: true, positiveReply: true }),
    person("crm-before", "C-NEW", "new-wf", { contacted: true, positiveReply: true }, { crmPositiveReplyAt: "2026-08-10T18:46:12Z" }),
    person("crm-after", "C-NEW", "new-wf", { contacted: true, positiveReply: true }, { crmPositiveReplyAt: "2026-10-14T00:00:00Z" }),
    // No act anywhere on the timeline (a channel send recorded on the row itself): the row's attribution stands.
    person("no-acts", "C-WA", "wa-wf", { contacted: true, positiveReply: true }),
  ];
}

describe("serving-row credit: a positive reply counts for a workflow only after THAT workflow contacted the person", () => {
  let persons: EnginePerson[];
  beforeEach(() => {
    persons = creditServingRows(population(), journeys);
  });
  const credit = (id: string) => persons.find((p) => p.leadId === id)!.servingRowCredit;

  it("a person who replied positively BEFORE the workflow's first send to them is not counted for it", () => {
    expect(credit("before")).toEqual({ contacted: false, clicked: false, positiveReply: false });
    expect(credit("before-emailed")).toEqual({ contacted: true, clicked: false, positiveReply: false });
    expect(credit("crm-before")?.positiveReply).toBe(false);
  });

  it("a person who replied AFTER the workflow contacted them is counted for it", () => {
    expect(credit("after")?.positiveReply).toBe(true);
    expect(credit("question")?.positiveReply).toBe(true);
    expect(credit("crm-after")?.positiveReply).toBe(true);
  });

  it("a person the timeline holds no act for keeps the row's own attribution", () => {
    expect(credit("no-acts")).toEqual({ contacted: true, clicked: false, positiveReply: true });
  });

  it("the person's own signals are untouched: the brand still counts every reply", () => {
    expect(persons.filter((p) => p.signals.positiveReply)).toHaveLength(7);
    expect(positiveRepliersOf(persons)).toHaveLength(7);
  });

  it("every per-workflow grain counts the same earned set: replier partition, fleet bucket, mature cohort, contacted", () => {
    expect(crmRepliesBySlug(positiveRepliersOf(persons))).toEqual(new Map([["new-wf", 3], ["wa-wf", 1]]));
    const buckets = bucketPopulation(persons).buckets;
    expect(buckets.get("C-NEW\tnew-wf\t2026-10-15")).toEqual([5, 0, 3]);
    expect(matureSlugStats(persons, null).get("new-wf")).toEqual({ recipientsContacted: 5, recipientsClicked: 0, recipientsRepliesPositive: 3 });
    expect(contactedPersonsBySlug(persons).get("new-wf")).toBe(5);
  });

  it("an unearned replier stays in the brand's list with no workflow and no campaign", () => {
    const before = positiveRepliersOf(persons).find((r) => r.leadId === "before")!;
    expect(before).toMatchObject({ campaignId: null, workflowSlug: null });
  });

  it("a person read outside fetchScopePersons (no credit stamped) counts on its own signals", () => {
    const bare = person("bare", "C-NEW", "new-wf", { positiveReply: true });
    expect(creditedSignal(bare, "positiveReply")).toBe(true);
  });
});

describe("serving-row credit: the per-workflow pipeline prices only what the row earned", () => {
  const persons = creditServingRows(
    [
      person("before", "C-NEW", "new-wf", { contacted: true, positiveReply: true, meetingBooked: true }),
      person("before-emailed", "C-NEW", "new-wf", { contacted: true, sent: true, positiveReply: true, meetingBooked: true }),
      person("after", "C-NEW", "new-wf", { contacted: true, positiveReply: true, meetingBooked: true }),
    ],
    journeys,
  );
  const byId = (id: string) => persons.find((p) => p.leadId === id)!;

  it("a row whose campaign never acted on the person puts the person in no workflow group", () => {
    expect(asServingRowEarned(byId("before"))).toBeNull();
  });

  it("a row that contacted the person but earned no reply keeps the send, not the reply nor the meeting after it", () => {
    expect(asServingRowEarned(byId("before-emailed"))!.signals).toEqual({ contacted: true, sent: true, positiveReply: false, meetingBooked: false });
  });

  it("a row that earned the reply is priced on everything, unchanged", () => {
    expect(asServingRowEarned(byId("after"))).toBe(byId("after"));
  });
});
