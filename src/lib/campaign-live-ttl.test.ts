import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const { defaultTtlFor, buildScopeKey } = await import("./view-cache.js");

describe("a campaign's Overview views refresh on every poll; every other view keeps 30s", () => {
  it("goes live for the Overview views scoped to a campaign", () => {
    const campaign = buildScopeKey("sales", { orgId: "o", brandId: "b", campaignId: "c" });
    expect(defaultTtlFor("revenue", campaign)).toBe(3_000);
    expect(defaultTtlFor("stats", campaign)).toBe(3_000);
    expect(defaultTtlFor("audience-stats", campaign)).toBe(3_000);
    expect(defaultTtlFor("workflow-projection-evidence", buildScopeKey("sales", { brandId: "b", campaign: "k" }))).toBe(3_000);
    // The chart's cell is brand-keyed, and it is the Overview's chart whatever page polls it.
    expect(defaultTtlFor("pipeline-activity", buildScopeKey("sales", { brandId: "b" }))).toBe(3_000);
  });

  it("keeps 30s for a brand-wide read of the same views and for every other view", () => {
    const brand = buildScopeKey("sales", { orgId: "o", brandId: "b" });
    expect(defaultTtlFor("revenue", brand)).toBe(30_000);
    expect(defaultTtlFor("brand-revenue", buildScopeKey("sales", { brandId: "b", campaignId: "c" }))).toBe(30_000);
    expect(defaultTtlFor("offer-revenue", brand)).toBe(30_000);
  });
});
