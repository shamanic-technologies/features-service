import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { addCrmRepliesToSlugStats, crmRepliesBySlug, fetchCrmOnlyRepliers, type CrmOnlyReplier } from "./crm-only-repliers.js";
import { fetchBrandWorkflowEvidence, fetchCampaignWorkflowEvidence, fetchAudienceGrainEvidence } from "./workflow-projection-grains.js";

/**
 * ONE brand, one workflow (`wf-a`, dynasty `wf-a`): email-gateway counts 2 positive replies under it.
 * Lead-service holds four people:
 *   - L1 replied positive by email AND through the CRM → the sender already counted them: +0.
 *   - L2 positive ONLY through the CRM, served under wf-a, member of audience AUD → +1.
 *   - L3 positive ONLY through the CRM, served under wf-a, in no audience → +1 brand, +0 audience.
 *   - L4 no positive reply at all → +0.
 * So every grain must read 2 + 2 = 4 at brand level (what /stats reads), never 2 and never 5.
 */
const leads = [
  { leadId: "L1", campaignId: "C1", workflowSlug: "wf-a", email: "one@x.com", contacted: true, replied: true, replyClassification: "positive", crmPositiveReplyAt: "2026-09-20T00:00:00Z" },
  { leadId: "L2", campaignId: "C1", workflowSlug: "wf-a", email: "Two@X.com", contacted: true, crmPositiveReplyAt: "2026-09-21T00:00:00Z" },
  { leadId: "L3", campaignId: "C2", workflowSlug: "wf-a", email: "three@x.com", contacted: true, crmPositiveReplyAt: "2026-09-22T00:00:00Z" },
  { leadId: "L4", campaignId: "C1", workflowSlug: "wf-a", email: "four@x.com", contacted: true },
];

const workflows = [{ workflowSlug: "wf-a", workflowDynastySlug: "wf-a", workflowDynastyName: "A", status: "active" }] as never;
const identity = { orgId: "org-1" };

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  process.env.LEAD_SERVICE_URL = "http://lead";
  process.env.LEAD_SERVICE_API_KEY = "k";
  process.env.RUNS_SERVICE_URL = "http://runs";
  process.env.RUNS_SERVICE_API_KEY = "k";
  process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email";
  process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "k";
  process.env.HUMAN_SERVICE_URL = "http://human";
  process.env.HUMAN_SERVICE_API_KEY = "k";
  process.env.LEAD_COPY_ENABLED = "false";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/orgs/leads")) {
        const u = new URL(url);
        const campaignId = u.searchParams.get("campaignId");
        return json({ leads: campaignId ? leads.filter((l) => l.campaignId === campaignId) : leads, nextCursor: null });
      }
      if (url.startsWith("http://runs")) {
        return json({ groups: [{ dimensions: { workflowSlug: "wf-a", audienceId: "AUD", campaignId: "C1" }, totalCostInUsdCents: "1000", runCount: 3 }] });
      }
      if (url.startsWith("http://email")) {
        return json({ groups: [{ key: "wf-a", broadcast: { recipientStats: { contacted: 4, clicked: 1, repliesPositive: 2 } } }] });
      }
      if (url.includes("/members")) return json({ members: [{ emailNorm: "two@x.com" }, { emailNorm: "one@x.com" }], total: 2 });
      throw new Error(`unmocked ${url}`);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("CRM-only positive repliers on the email-gateway-counted grains", () => {
  it("keeps only the people whose positive reply ONLY the CRM shows — the sender already counted L1", async () => {
    const repliers = await fetchCrmOnlyRepliers("brand-1", undefined, identity);
    expect(repliers.map((r) => r.leadId).sort()).toEqual(["L2", "L3"]);
    expect(repliers.find((r) => r.leadId === "L2")?.email).toBe("two@x.com");
  });

  it("adds them per workflow slug, creating a slug email-gateway never answered for", () => {
    const stats = new Map([["wf-a", { recipientsRepliesPositive: 2, recipientsClicked: 1 }]]);
    const repliers: CrmOnlyReplier[] = [
      { leadId: "L2", email: "a", campaignId: null, workflowSlug: "wf-a" },
      { leadId: "L2", email: "a", campaignId: null, workflowSlug: "wf-a" },
      { leadId: "L9", email: "b", campaignId: null, workflowSlug: "wf-b" },
      { leadId: "L8", email: "c", campaignId: null, workflowSlug: null },
    ];
    expect(crmRepliesBySlug(repliers)).toEqual(new Map([["wf-a", 1], ["wf-b", 1]]));
    addCrmRepliesToSlugStats(stats, repliers);
    expect(stats.get("wf-a")).toEqual({ recipientsRepliesPositive: 3, recipientsClicked: 1 });
    expect(stats.get("wf-b")).toEqual({ recipientsRepliesPositive: 1 });
  });

  it("the BRAND grain reads the sender's 2 plus the 2 CRM-only repliers — the /stats figure, not 2", async () => {
    const repliers = await fetchCrmOnlyRepliers("brand-1", undefined, identity);
    const withCrm = await fetchBrandWorkflowEvidence("brand-1", "f", workflows, identity, "gross", "charged", repliers);
    const without = await fetchBrandWorkflowEvidence("brand-1", "f", workflows, identity);
    expect(withCrm.get("wf-a")?.replies).toBe(4);
    expect(without.get("wf-a")?.replies).toBe(2);
    expect({ ...withCrm.get("wf-a"), replies: 0 }).toEqual({ ...without.get("wf-a"), replies: 0 });
  });

  it("the CAMPAIGN grain (a learning cell) counts only its own campaign's CRM-only repliers", async () => {
    const repliers = await fetchCrmOnlyRepliers("brand-1", ["C1"], identity);
    expect(repliers.map((r) => r.leadId)).toEqual(["L2"]);
    const cells = await fetchCampaignWorkflowEvidence("brand-1", "f", ["C1"], workflows, identity, "gross", "charged", repliers);
    expect(cells.get("wf-a")?.replies).toBe(3);
  });

  it("the AUDIENCE grain adds a CRM-only replier by membership — L3 is in no audience", async () => {
    const repliers = await fetchCrmOnlyRepliers("brand-1", undefined, identity);
    const slugToDynasty = new Map([["wf-a", "wf-a"]]);
    const [ev] = await fetchAudienceGrainEvidence("brand-1", "f", identity, slugToDynasty, "gross", ["AUD"], repliers);
    expect(ev.byDynasty.get("wf-a")?.replies).toBe(3);
  });

  it("a brand with no CRM-only replier reads byte-identically and reads no member list", async () => {
    const slugToDynasty = new Map([["wf-a", "wf-a"]]);
    const a = await fetchAudienceGrainEvidence("brand-1", "f", identity, slugToDynasty, "gross", ["AUD"], []);
    const b = await fetchAudienceGrainEvidence("brand-1", "f", identity, slugToDynasty, "gross", ["AUD"]);
    expect(a).toEqual(b);
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/members"))).toBe(false);
  });

  it("FAILS LOUD when the lead read fails — never a silent return to the sender's count", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(fetchCrmOnlyRepliers("brand-1", undefined, identity)).rejects.toThrow();
  });
});
