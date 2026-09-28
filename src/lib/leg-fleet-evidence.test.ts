import { describe, it, expect, vi } from "vitest";

vi.unmock("./leg-fleet-evidence.js");
vi.unmock("./fleet-positive-repliers.js");
vi.mock("./crm-only-repliers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./crm-only-repliers.js")>()),
  fetchScopePersons: vi.fn(async () => [{ leadId: "x", campaignId: "c1", workflowSlug: "wf-a", signals: { contacted: true } }]),
}));
vi.mock("./feature-memberships-client.js", () => ({
  fetchFeatureMemberships: vi.fn(async () => [{ orgId: "org-2", brandId: "b2", workflowSlug: "wf-a" }]),
}));
const { mergeCostGroupsBySlug, mergeEmailStats, mergeMatureCostGroups, fetchLegFleetMatureEvidence } = await import(
  "./leg-fleet-evidence.js"
);

const g = (slug: string, cents: string, runs: number, min: string | null, max: string | null) => ({
  dimensions: { workflowSlug: slug },
  totalCostInUsdCents: cents,
  runCount: runs,
  minStartedAt: min,
  maxStartedAt: max,
});

describe("merging the answers of several campaignIds chunks", () => {
  it("sums cost groups per workflow slug and widens the date span", () => {
    const merged = mergeCostGroupsBySlug([
      g("wf-a", "100.5", 2, "2026-09-02", "2026-09-10"),
      g("wf-b", "40", 1, null, null),
      g("wf-a", "10", 3, "2026-09-01", "2026-09-05"),
    ]);
    const a = merged.find((x) => x.dimensions.workflowSlug === "wf-a")!;
    expect(Number(a.totalCostInUsdCents)).toBeCloseTo(110.5, 9);
    expect(a.runCount).toBe(5);
    expect(a.minStartedAt).toBe("2026-09-01");
    expect(a.maxStartedAt).toBe("2026-09-10");
    expect(merged).toHaveLength(2);
  });

  it("sums per-slug send stats across chunks, keeping slugs only one chunk holds", () => {
    const merged = mergeEmailStats([
      new Map([["wf-a", { recipientsContacted: 10, recipientsClicked: 2 }]]),
      new Map([
        ["wf-a", { recipientsContacted: 5, recipientsClicked: 1 }],
        ["wf-b", { recipientsContacted: 7, recipientsClicked: 0 }],
      ]),
    ]);
    expect(merged.get("wf-a")).toEqual({ recipientsContacted: 15, recipientsClicked: 3 });
    expect(merged.get("wf-b")).toEqual({ recipientsContacted: 7, recipientsClicked: 0 });
  });
});

describe("the fleet's MATURE spend (lib/maturity.ts)", () => {
  it("sums every org's groups per slug EXACTLY, on the incurred basis, never rounding a group", () => {
    const merged = mergeMatureCostGroups(
      [
        { dimensions: { workflowSlug: "wf-a" }, totalCostInUsdCents: "0.1000000000", runCount: 1 } as any,
        { dimensions: { workflowSlug: "wf-a" }, totalCostInUsdCents: "0.2000000000", runCount: 2 } as any,
        { dimensions: { workflowSlug: "__total__" }, totalCostInUsdCents: "99", runCount: 1 } as any,
      ],
      "gross",
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].totalCostInUsdCents).toBe("0.3000000000");
    expect(merged[0].runCount).toBe(3);
  });

  it("answers NULL — and asks runs-service NOTHING — when a pair's population states no serve date", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const out = await fetchLegFleetMatureEvidence(
      "sales-cold-email-outreach",
      "start_to_website_visit",
      "gross",
      "2026-09-07T00:00:00.000Z",
      null,
      new Set(["c1"]),
    );
    expect(out).toBeNull();
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("/v1/stats/"))).toBe(false);
    fetchSpy.mockRestore();
  });
});
