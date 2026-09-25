import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { dedupPersonsByLead, type EnginePerson } from "./revenue-engine.js";
import { applySignalOverlays } from "./signal-overlays.js";
import { engagedLeadsByCampaign } from "./learning-phase-compute.js";
import type { SignalDates } from "./email-status-client.js";

// A positive reply the customer's CRM evidences (lead-service#601) is the SAME fact as a reply the
// sender classified positive. These cases pin the three places the two witnesses meet: the per-lead
// merge, the reply's date, and the per-campaign count email-gateway cannot see.

const CRM_AT = "2026-09-21T13:45:00.000Z";

function person(over: Partial<EnginePerson> & { leadId: string }): EnginePerson {
  return {
    email: `${over.leadId}@x.com`,
    signals: { contacted: true, delivered: true, positiveReply: false },
    ...over,
  } as EnginePerson;
}

describe("a CRM-evidenced positive reply", () => {
  it("counts a lead once when two campaign rows both carry it", () => {
    const rows = [
      person({ leadId: "a", campaignId: "c1", crmPositiveReplyAt: CRM_AT, signals: { positiveReply: true } }),
      person({ leadId: "a", campaignId: "c2", crmPositiveReplyAt: CRM_AT, signals: { positiveReply: true } }),
    ];
    const merged = dedupPersonsByLead(rows);
    expect(merged).toHaveLength(1);
    expect(merged[0].signals.positiveReply).toBe(true);
    expect(merged[0].crmPositiveReplyAt).toBe(CRM_AT);
  });

  it("stops being CRM-only once any row of the lead carries a sender-classified reply", () => {
    const merged = dedupPersonsByLead([
      person({ leadId: "a", campaignId: "c1", crmPositiveReplyAt: CRM_AT, signals: { positiveReply: true } }),
      person({ leadId: "a", campaignId: "c2", crmPositiveReplyAt: null, signals: { positiveReply: true } }),
    ]);
    expect(merged[0].signals.positiveReply).toBe(true);
    expect(merged[0].crmPositiveReplyAt).toBeNull();
  });

  it("stays CRM-only beside a row that simply never replied", () => {
    const merged = dedupPersonsByLead([
      person({ leadId: "a", campaignId: "c1", crmPositiveReplyAt: null, signals: { positiveReply: false } }),
      person({ leadId: "a", campaignId: "c2", crmPositiveReplyAt: CRM_AT, signals: { positiveReply: true } }),
    ]);
    expect(merged[0].crmPositiveReplyAt).toBe(CRM_AT);
  });

  it("is dated by the CRM, never by a reply the sender classified otherwise", () => {
    const p = person({ leadId: "a", crmPositiveReplyAt: CRM_AT, signals: { positiveReply: true }, signalDates: { positiveReply: CRM_AT } });
    // email-gateway's first-reply timestamp: this person replied NEGATIVELY on the 10th.
    const ts = new Map<string, SignalDates>([["a@x.com", { contacted: null, sent: null, delivered: null, open: null, clicked: null, positiveReply: "2026-09-10T08:00:00.000Z" } as SignalDates]]);
    applySignalOverlays([p], ts, null);
    expect(p.signalDates?.positiveReply).toBe(CRM_AT);
  });

  it("an email-classified reply keeps the sender's date", () => {
    const p = person({ leadId: "b", signals: { positiveReply: true } });
    const ts = new Map<string, SignalDates>([["b@x.com", { contacted: null, sent: null, delivered: null, open: null, clicked: null, positiveReply: "2026-09-10T08:00:00.000Z" } as SignalDates]]);
    applySignalOverlays([p], ts, null);
    expect(p.signalDates?.positiveReply).toBe("2026-09-10T08:00:00.000Z");
  });

  it("groups EVERY positive replier (either witness) and every clicker by campaign, each lead once", () => {
    const byCampaign = engagedLeadsByCampaign([
      person({ leadId: "a", campaignId: "c1", crmPositiveReplyAt: CRM_AT, signals: { positiveReply: true } }),
      person({ leadId: "a", campaignId: "c2", crmPositiveReplyAt: CRM_AT, signals: { positiveReply: true } }),
      person({ leadId: "b", campaignId: "c1", signals: { positiveReply: true, clicked: true } }),
      person({ leadId: "b", campaignId: "c1", signals: { positiveReply: true } }),
      person({ leadId: "c", campaignId: "c1", signals: { positiveReply: false } }),
    ]);
    expect([...(byCampaign.get("c1")?.repliers ?? [])].sort()).toEqual(["a", "b"]);
    expect([...(byCampaign.get("c1")?.clickers ?? [])]).toEqual(["b"]);
    expect([...(byCampaign.get("c2")?.repliers ?? [])]).toEqual(["a"]);
  });
});
