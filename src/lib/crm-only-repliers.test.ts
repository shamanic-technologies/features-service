import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { crmRepliesBySlug, fetchCrmOnlyRepliers, fetchPositiveRepliers, setPersonRepliesOnSlugStats, type PositiveReplier } from "./crm-only-repliers.js";
import {
  brandGrainDynasties,
  fetchAudienceGrainEvidence,
  fetchBrandWorkflowEvidence,
  fetchBrandWorkflowEvidenceWithRetired,
  fetchCampaignWorkflowEvidence,
} from "./workflow-projection-grains.js";

/**
 * ONE brand. Workflow `wf-a` is active; `wf-old` is a RETIRED dynasty (deprecated, no active version).
 * email-gateway's per-slug counts are WRONG in both known ways: it counts 3 positive replies under wf-a
 * (one replier twice) and none under wf-old (it cannot see a CRM-evidenced reply). Lead-service holds:
 *   - L1 replied positive by email (and through the CRM) — wf-a, campaign C1.
 *   - L2 positive ONLY through the CRM — wf-a, C1, member of audience AUD.
 *   - L3 positive ONLY through the CRM — wf-old, C2, in no audience.
 *   - L4 no positive reply at all.
 * Three people replied, so the rows must sum to 3: wf-a 2 + wf-old 1 — never email-gateway's 3 + 0.
 */
const leads = [
  { leadId: "L1", campaignId: "C1", workflowSlug: "wf-a", email: "one@x.com", contacted: true, replied: true, replyClassification: "positive", crmPositiveReplyAt: "2026-09-20T00:00:00Z" },
  { leadId: "L2", campaignId: "C1", workflowSlug: "wf-a", email: "Two@X.com", contacted: true, crmPositiveReplyAt: "2026-09-21T00:00:00Z" },
  { leadId: "L3", campaignId: "C2", workflowSlug: "wf-old", email: "three@x.com", contacted: true, crmPositiveReplyAt: "2026-09-22T00:00:00Z" },
  { leadId: "L4", campaignId: "C1", workflowSlug: "wf-a", email: "four@x.com", contacted: true },
];

const workflows = [
  { id: "1", workflowSlug: "wf-a", workflowDynastySlug: "wf-a", workflowDynastyName: "A", status: "active" },
  { id: "2", workflowSlug: "wf-old", workflowDynastySlug: "wf-old", workflowDynastyName: "Old", status: "deprecated" },
] as never;
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
        const campaignId = new URL(url).searchParams.get("campaignId");
        return json({ leads: campaignId ? leads.filter((l) => l.campaignId === campaignId) : leads, nextCursor: null });
      }
      if (url.startsWith("http://runs")) {
        return json({
          groups: [
            { dimensions: { workflowSlug: "wf-a", audienceId: "AUD", campaignId: "C1" }, totalCostInUsdCents: "1000", runCount: 3 },
            { dimensions: { workflowSlug: "wf-old", audienceId: null, campaignId: "C2" }, totalCostInUsdCents: "400", runCount: 2 },
          ],
        });
      }
      if (url.startsWith("http://email")) {
        return json({ groups: [{ key: "wf-a", broadcast: { recipientStats: { contacted: 4, clicked: 1, repliesPositive: 3 } } }] });
      }
      if (url.includes("/members")) return json({ members: [{ emailNorm: "two@x.com" }, { emailNorm: "one@x.com" }], total: 2 });
      throw new Error(`unmocked ${url}`);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("positive replies on the workflow grains are counted per PERSON", () => {
  it("reads every positive replier once, flagging the ones only the CRM saw", async () => {
    const repliers = await fetchPositiveRepliers("brand-1", undefined, identity);
    expect(repliers.map((r) => `${r.leadId}:${r.crmOnly}`).sort()).toEqual(["L1:false", "L2:true", "L3:true"]);
    expect((await fetchCrmOnlyRepliers("brand-1", undefined, identity)).map((r) => r.leadId).sort()).toEqual(["L2", "L3"]);
  });

  it("REPLACES email-gateway's per-slug reply count, zeroing a slug nobody replied under", () => {
    const stats = new Map<string, Record<string, number>>([
      ["wf-a", { recipientsRepliesPositive: 3, recipientsClicked: 1 }],
      ["wf-b", { recipientsRepliesPositive: 1 }],
    ]);
    const repliers: PositiveReplier[] = [
      { leadId: "L1", email: "a", campaignId: null, workflowSlug: "wf-a", crmOnly: false },
      { leadId: "L2", email: "b", campaignId: null, workflowSlug: "wf-a", crmOnly: true },
      { leadId: "L3", email: "c", campaignId: null, workflowSlug: "wf-c", crmOnly: true },
    ];
    expect(crmRepliesBySlug(repliers)).toEqual(new Map([["wf-a", 2], ["wf-c", 1]]));
    setPersonRepliesOnSlugStats(stats, repliers);
    expect(stats.get("wf-a")).toEqual({ recipientsRepliesPositive: 2, recipientsClicked: 1 });
    expect(stats.get("wf-b")).toEqual({ recipientsRepliesPositive: 0 });
    expect(stats.get("wf-c")).toEqual({ recipientsRepliesPositive: 1 });
  });

  it("keeps a RETIRED lineage apart, and folds an unreached version into its active dynasty", () => {
    const wfs = [
      { id: "1", workflowSlug: "x-v2", workflowDynastySlug: "x", status: "active" },
      { id: "2", workflowSlug: "x", workflowDynastySlug: "x", status: "deprecated" },
      { id: "3", workflowSlug: "old", workflowDynastySlug: "old", status: "deprecated" },
    ] as never;
    const { active, retired } = brandGrainDynasties(wfs, ["x-v2", "old", "ghost"]);
    expect(active.get("x-v2")?.slice().sort()).toEqual(["x", "x-v2"]);
    expect(retired.get("old")).toEqual(["old"]);
    expect(retired.get("ghost")).toEqual(["ghost"]);
  });

  it("the BRAND rows sum to the three people who replied — wf-a 2 + retired wf-old 1, not email-gateway's 3 + 0", async () => {
    const repliers = await fetchPositiveRepliers("brand-1", undefined, identity);
    const grain = await fetchBrandWorkflowEvidenceWithRetired("brand-1", "f", workflows, identity, "gross", "charged", repliers);
    expect(grain.active.get("wf-a")?.replies).toBe(2);
    expect(grain.retired.get("wf-old")?.replies).toBe(1);
    expect(grain.retired.get("wf-old")?.totalCostInUsdCents).toBe(400);
    // The active map is what every ranked surface reads — the retired lineage is never in it.
    const active = await fetchBrandWorkflowEvidence("brand-1", "f", workflows, identity, "gross", "charged", repliers);
    expect([...active.keys()]).toEqual(["wf-a"]);
  });

  it("without the person set, the grain reads email-gateway exactly as before", async () => {
    const without = await fetchBrandWorkflowEvidence("brand-1", "f", workflows, identity);
    expect(without.get("wf-a")?.replies).toBe(3);
  });

  it("the CAMPAIGN grain counts only its own identity's people", async () => {
    const repliers = await fetchPositiveRepliers("brand-1", ["C1"], identity);
    expect(repliers.map((r) => r.leadId).sort()).toEqual(["L1", "L2"]);
    const cells = await fetchCampaignWorkflowEvidence("brand-1", "f", ["C1"], workflows, identity, "gross", "charged", repliers);
    expect(cells.get("wf-a")?.replies).toBe(2);
  });

  it("the AUDIENCE grain adds only CRM-ONLY repliers, by membership — L1 is already in email-gateway's count", async () => {
    const repliers = await fetchPositiveRepliers("brand-1", undefined, identity);
    const slugToDynasty = new Map([["wf-a", "wf-a"], ["wf-old", "wf-old"]]);
    const [ev] = await fetchAudienceGrainEvidence("brand-1", "f", identity, slugToDynasty, "gross", ["AUD"], repliers);
    expect(ev.byDynasty.get("wf-a")?.replies).toBe(4); // email-gateway 3 + L2
  });

  it("a brand with no CRM-only replier reads no member list", async () => {
    const slugToDynasty = new Map([["wf-a", "wf-a"]]);
    const a = await fetchAudienceGrainEvidence("brand-1", "f", identity, slugToDynasty, "gross", ["AUD"], []);
    const b = await fetchAudienceGrainEvidence("brand-1", "f", identity, slugToDynasty, "gross", ["AUD"]);
    expect(a).toEqual(b);
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/members"))).toBe(false);
  });

  it("FAILS LOUD when the lead read fails — never a silent return to the sender's count", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(fetchPositiveRepliers("brand-1", undefined, identity)).rejects.toThrow();
  });
});
