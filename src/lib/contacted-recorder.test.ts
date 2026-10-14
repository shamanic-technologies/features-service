/**
 * WA-CONTACTED-1014: a pipe that writes on a non-email channel counts the people it wrote to as contacted, from
 * lead-service's served rows (which fold the channel sender's own send record), never email-gateway's 0. Email
 * channels are untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EnginePerson } from "./revenue-engine.js";
import { contactedPersonsBySlug, contactedRecorderOf, setContactedCountsOnSlugStats } from "./contacted-recorder.js";

process.env.FEATURES_SERVICE_DATABASE_URL ??= "postgres://fake:5432/test";

const scopePersons = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("./crm-only-repliers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./crm-only-repliers.js")>()),
  fetchScopePersons: scopePersons.fn,
}));

const person = (over: Partial<EnginePerson> & { contacted?: boolean }): EnginePerson =>
  ({
    leadId: over.leadId ?? Math.random().toString(36),
    campaignId: over.campaignId ?? "c-wa",
    workflowSlug: "workflowSlug" in over ? over.workflowSlug : "cold-whatsapp-outreach-zaurak",
    audienceId: over.audienceId ?? null,
    servedAt: over.servedAt ?? "2026-10-12T14:00:00Z",
    signals: { contacted: over.contacted ?? true },
  }) as unknown as EnginePerson;

describe("contactedRecorderOf (the channel's own contact methods, never a slug list)", () => {
  it("email channels and a channel stating no method keep email-gateway", () => {
    expect(contactedRecorderOf("sales-cold-email-outreach")).toBe("email-gateway");
    expect(contactedRecorderOf("pr-cold-email-outreach")).toBe("email-gateway");
    expect(contactedRecorderOf("ai-meeting-booking")).toBe("email-gateway");
    expect(contactedRecorderOf("")).toBe("email-gateway");
  });
  it("every non-email one-to-one channel takes lead-service", () => {
    for (const slug of ["cold-whatsapp-outreach", "cold-sms-outreach", "cold-call-outreach", "cold-linkedin-outreach", "cold-x-outreach"]) {
      expect(contactedRecorderOf(slug)).toBe("lead-service");
    }
  });
  it("a lineage mixing an email channel keeps email-gateway", () => {
    expect(contactedRecorderOf("cold-whatsapp-outreach,cold-sms-outreach")).toBe("lead-service");
    expect(contactedRecorderOf("cold-whatsapp-outreach,sales-cold-email-outreach")).toBe("email-gateway");
  });
});

describe("contactedPersonsBySlug + setContactedCountsOnSlugStats", () => {
  it("counts contacted persons per slug, narrowed to the campaigns asked", () => {
    const persons = [
      person({ campaignId: "c-wa" }),
      person({ campaignId: "c-wa" }),
      person({ campaignId: "c-wa", contacted: false }),
      person({ campaignId: "c-other" }),
      person({ campaignId: "c-wa", workflowSlug: null }),
    ];
    expect(contactedPersonsBySlug(persons)).toEqual(new Map([["cold-whatsapp-outreach-zaurak", 3]]));
    expect(contactedPersonsBySlug(persons, new Set(["c-wa"]))).toEqual(new Map([["cold-whatsapp-outreach-zaurak", 2]]));
  });

  it("REPLACES email-gateway's 0 contacted and sent; a slug absent from the counts reads 0", () => {
    const stats = new Map<string, Record<string, number>>([
      ["cold-whatsapp-outreach-zaurak", { recipientsContacted: 0, recipientsSent: 0, recipientsClicked: 0 }],
      ["cold-whatsapp-outreach-other", { recipientsContacted: 3, recipientsClicked: 1 }],
    ]);
    setContactedCountsOnSlugStats(stats, new Map([["cold-whatsapp-outreach-zaurak", 9], ["cold-whatsapp-outreach-new", 2]]));
    expect(stats.get("cold-whatsapp-outreach-zaurak")).toEqual({ recipientsContacted: 9, recipientsSent: 9, recipientsClicked: 0 });
    expect(stats.get("cold-whatsapp-outreach-other")).toEqual({ recipientsContacted: 0, recipientsSent: 0, recipientsClicked: 1 });
    expect(stats.get("cold-whatsapp-outreach-new")).toEqual({ recipientsContacted: 2, recipientsSent: 2 });
  });
});

describe("fetchPublicEmailStats (the fleet's per-workflow grain every ranking reads)", () => {
  const emailGatewayBody = {
    groups: [{ key: "cold-whatsapp-outreach-zaurak", broadcast: { recipientStats: { contacted: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, repliesPositive: 0 } } }],
  };
  beforeEach(() => {
    process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email-gateway:3000";
    process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "eg-key";
  });
  afterEach(() => vi.restoreAllMocks());

  it("a WhatsApp pipe reads the people lead-service states were written to, not email-gateway's 0", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(emailGatewayBody), { status: 200 }));
    const fleet = await import("./fleet-positive-repliers.js");
    const spy = vi.mocked(fleet.fetchFleetContactedBySlug).mockResolvedValue(new Map([["cold-whatsapp-outreach-zaurak", 9]]));
    const { fetchPublicEmailStats } = await import("./public-stats-clients.js");

    const stats = await fetchPublicEmailStats("cold-whatsapp-outreach", "workflowSlug", undefined, undefined, ["c-wa"]);

    expect(stats.get("cold-whatsapp-outreach-zaurak")?.recipientsContacted).toBe(9);
    expect(stats.get("cold-whatsapp-outreach-zaurak")?.recipientsSent).toBe(9);
    expect(spy).toHaveBeenCalledWith("cold-whatsapp-outreach", new Set(["c-wa"]));
  });

  it("an email pipe is byte-unchanged and never reads the person cell", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ groups: [{ key: "sales-x", broadcast: { recipientStats: { contacted: 12, sent: 10, clicked: 1 } } }] }), { status: 200 }),
    );
    const fleet = await import("./fleet-positive-repliers.js");
    const spy = vi.mocked(fleet.fetchFleetContactedBySlug);
    spy.mockClear();
    const { fetchPublicEmailStats } = await import("./public-stats-clients.js");

    const stats = await fetchPublicEmailStats("sales-cold-email-outreach", "workflowSlug");

    expect(stats.get("sales-x")?.recipientsContacted).toBe(10);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("brand / campaign grain (workflow-projection, per workflow of the channel)", () => {
  const wf = {
    id: "w1", workflowSlug: "cold-whatsapp-outreach-zaurak", workflowName: "Z", workflowDynastyName: "Z",
    workflowDynastySlug: "cold-whatsapp-outreach-zaurak", version: 1, status: "active", workflowDynastyStatus: "active" as const,
    featureSlug: "cold-whatsapp-outreach", createdForBrandId: null, upgradedTo: null,
  };
  beforeEach(() => {
    process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email-gateway:3000";
    process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "eg-key";
    process.env.RUNS_SERVICE_URL = "http://runs:3000";
    process.env.RUNS_SERVICE_API_KEY = "runs-key";
    scopePersons.fn.mockReset();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("http://runs")) {
        return new Response(JSON.stringify({ groups: [{ dimensions: { workflowSlug: wf.workflowSlug }, totalCostInUsdCents: "500", runCount: 3 }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ groups: [{ key: wf.workflowSlug, broadcast: { recipientStats: { sent: 0, clicked: 0, repliesPositive: 0 } } }] }), { status: 200 });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("Valued (cold WhatsApp): the brand grain counts the people written to, not 0", async () => {
    scopePersons.fn.mockResolvedValue([person({}), person({}), person({ contacted: false })]);
    const { fetchBrandWorkflowEvidence } = await import("./workflow-projection-grains.js");
    const ev = await fetchBrandWorkflowEvidence("brand-1", "cold-whatsapp-outreach", [wf], { orgId: "org-1" });
    expect(ev.get(wf.workflowSlug)?.contacted).toBe(2);
    expect(ev.get(wf.workflowSlug)?.totalCostInUsdCents).toBe(500);
  });

  it("the campaign grain counts only the identity's campaigns", async () => {
    scopePersons.fn.mockResolvedValue([person({ campaignId: "c-wa" }), person({ campaignId: "c-elsewhere" })]);
    const { fetchCampaignWorkflowEvidence } = await import("./workflow-projection-grains.js");
    const ev = await fetchCampaignWorkflowEvidence("brand-1", "cold-whatsapp-outreach", ["c-wa"], [wf], { orgId: "org-1" });
    expect(ev.get(wf.workflowSlug)?.contacted).toBe(1);
    expect(scopePersons.fn).toHaveBeenCalledWith("brand-1", ["c-wa"], { orgId: "org-1" });
  });

  it("an email channel reads no person and keeps email-gateway's figure", async () => {
    const { fetchBrandWorkflowEvidence } = await import("./workflow-projection-grains.js");
    const ev = await fetchBrandWorkflowEvidence("brand-1", "sales-cold-email-outreach", [{ ...wf, featureSlug: "sales-cold-email-outreach" }], { orgId: "org-1" });
    expect(ev.get(wf.workflowSlug)?.contacted).toBe(0);
    expect(scopePersons.fn).not.toHaveBeenCalled();
  });
});
