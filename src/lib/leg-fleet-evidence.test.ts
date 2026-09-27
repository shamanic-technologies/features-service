import { describe, it, expect, vi } from "vitest";

vi.unmock("./leg-fleet-evidence.js");
const { mergeCostGroupsBySlug, mergeEmailStats } = await import("./leg-fleet-evidence.js");

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
