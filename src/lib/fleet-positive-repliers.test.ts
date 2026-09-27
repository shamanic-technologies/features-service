import { describe, it, expect, vi, beforeEach } from "vitest";

vi.unmock("./fleet-positive-repliers.js");
vi.mock("./feature-memberships-client.js", () => ({ fetchFeatureMemberships: vi.fn() }));
vi.mock("./crm-only-repliers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./crm-only-repliers.js")>()),
  fetchPositiveRepliers: vi.fn(),
}));

const { fetchFeatureMemberships } = await import("./feature-memberships-client.js");
const { fetchPositiveRepliers } = await import("./crm-only-repliers.js");
const { fetchFleetPositiveRepliesBySlug, __resetFleetPositiveRepliers } = await import("./fleet-positive-repliers.js");

const replier = (leadId: string, workflowSlug: string | null) => ({ leadId, email: null, campaignId: null, workflowSlug, crmOnly: false });

// Two orgs, three brands; the requesting pair is (org-1, brand-own).
const MEMBERSHIPS = [
  { orgId: "org-1", brandId: "brand-own", workflowSlug: "wf-a" },
  { orgId: "org-1", brandId: "brand-own", workflowSlug: "wf-b" }, // same pair, second workflow row
  { orgId: "org-2", brandId: "brand-x", workflowSlug: "wf-a" },
  { orgId: "org-3", brandId: "brand-y", workflowSlug: "wf-b" },
];
const BY_PAIR: Record<string, ReturnType<typeof replier>[]> = {
  "org-1:brand-own": [replier("stale-1", "wf-a")],
  "org-2:brand-x": [replier("x1", "wf-a"), replier("x2", "wf-a"), replier("x3", null)],
  "org-3:brand-y": [replier("y1", "wf-b")],
};

beforeEach(() => {
  __resetFleetPositiveRepliers();
  vi.mocked(fetchFeatureMemberships).mockReset().mockResolvedValue(MEMBERSHIPS);
  vi.mocked(fetchPositiveRepliers)
    .mockReset()
    .mockImplementation(async (brandId, _scope, identity) => BY_PAIR[`${identity.orgId}:${brandId}`] as any);
});

describe("fetchFleetPositiveRepliesBySlug", () => {
  it("sums every other pair's PERSON count per slug and adds the requesting pair's LIVE repliers", async () => {
    const live = [replier("o1", "wf-a"), replier("o2", "wf-a"), replier("o3", "wf-b")];
    const fleet = await fetchFleetPositiveRepliesBySlug("sales-cold-email-outreach", { orgId: "org-1", brandId: "brand-own", repliers: live as any });
    // wf-a: brand-x 2 + own live 2 (the cached "stale-1" is replaced, never added) ; wf-b: brand-y 1 + own 1.
    expect(Object.fromEntries(fleet)).toEqual({ "wf-a": 4, "wf-b": 2 });
    // Each pair walked once (the duplicate membership row did not cause a second walk), org-only identity.
    expect(vi.mocked(fetchPositiveRepliers)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetchPositiveRepliers)).toHaveBeenCalledWith("brand-x", undefined, { orgId: "org-2" });
  });

  it("can never read below the requesting pair, even when the pair is not in the cell", async () => {
    const live = [replier("n1", "wf-c")];
    const fleet = await fetchFleetPositiveRepliesBySlug("sales-cold-email-outreach", { orgId: "org-9", brandId: "brand-new", repliers: live as any });
    expect(fleet.get("wf-c")).toBe(1);
  });

  it("serves the cell from memory on the next read (one fleet walk per fresh window)", async () => {
    const own = { orgId: "org-1", brandId: "brand-own", repliers: [] };
    await fetchFleetPositiveRepliesBySlug("sales-cold-email-outreach", own);
    await fetchFleetPositiveRepliesBySlug("sales-cold-email-outreach", own);
    expect(vi.mocked(fetchFeatureMemberships)).toHaveBeenCalledTimes(1);
  });

  it("fails LOUD on a cold cell when one pair cannot be read — never a fleet total missing a brand", async () => {
    vi.mocked(fetchPositiveRepliers).mockImplementation(async (brandId) => {
      if (brandId === "brand-y") throw new Error("lead-service down");
      return [] as any;
    });
    await expect(
      fetchFleetPositiveRepliesBySlug("sales-cold-email-outreach", { orgId: "org-1", brandId: "brand-own", repliers: [] }),
    ).rejects.toThrow("lead-service down");
  });
});
