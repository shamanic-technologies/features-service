import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({ db: { query: { features: { findMany: async () => [] } } }, sql: {} }));

// The snapshot layer serves whatever it stored, however old — which is exactly what must NOT happen to
// the brand's own statements. Here it replays a body computed before the write.
const servedCached = vi.fn();
vi.mock("./view-cache.js", () => ({
  servedCached: (args: unknown) => servedCached(args),
  buildScopeKey: (brandId: string) => brandId,
}));

const fetchBrandFunnelRates = vi.fn();
vi.mock("./brand-funnel-rates-client.js", () => ({
  fetchBrandFunnelRates: (...args: unknown[]) => fetchBrandFunnelRates(...args),
}));

vi.mock("./feature-memberships-client.js", () => ({ fetchFeatureMemberships: vi.fn(async () => []) }));

const { getBrandEffectiveRates, __resetFleetArrowMediansCache } = await import("./effective-conversion-rates.js");
const { ALL_STEP_EVIDENCE } = await import("./funnel-steps.js");

const COUNTS = {
  contactedRecipients: 100,
  evidence: ALL_STEP_EVIDENCE,
  reachedCounts: {
    clicked: 0,
    repliedPositive: 23,
    meetingBooked: 14,
    meetingAttended: 7,
    signup: 0,
    formSubmission: 0,
    purchased: 3,
  },
};

const statement = (ratePct: number) => [
  {
    funnelKey: "sales_meetings_from_conversation",
    name: "Sales Meeting from Conversation",
    steps: [],
    arrows: [{ fromStep: "Meeting attended", toStep: "Paid client", ratePct, stated: true, statedAt: null }],
  },
];

describe("getBrandEffectiveRates — the brand's statements are read live, never off a snapshot", () => {
  beforeEach(() => {
    __resetFleetArrowMediansCache();
    servedCached.mockReset();
    servedCached.mockResolvedValue(COUNTS);
    fetchBrandFunnelRates.mockReset();
  });

  it("a rate saved a moment ago is the one served, even while the measurement comes off the cache", async () => {
    fetchBrandFunnelRates.mockResolvedValue(statement(14));
    const rates = await getBrandEffectiveRates("brand-1", "org-1");
    const arrow = rates.funnels
      .find((f) => f.funnelKey === "sales_meetings_from_conversation")!
      .arrows.find((a) => a.toStep === "Paid client")!;
    // 7 leads attended: under the bar, so the brand's own value is what prices.
    expect(arrow).toMatchObject({ manualRatePct: 14, effectiveRatePct: 14, source: "manual" });
    expect(fetchBrandFunnelRates).toHaveBeenCalledWith("brand-1", "org-1");
  });

  it("only the lead walk goes through the snapshot layer", async () => {
    fetchBrandFunnelRates.mockResolvedValue(statement(50));
    await getBrandEffectiveRates("brand-1", "org-1");
    expect(servedCached).toHaveBeenCalledTimes(1);
    expect(servedCached.mock.calls[0][0]).toMatchObject({ view: "brand-conversion-step-counts" });
  });
});
