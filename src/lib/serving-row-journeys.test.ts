import { describe, it, expect, vi, beforeEach } from "vitest";

vi.unmock("./serving-row-journeys.js");
const fetchBrandJourneys = vi.fn();
vi.mock("./brand-journeys-client.js", () => ({ fetchBrandJourneys: (...args: unknown[]) => fetchBrandJourneys(...args) }));

const { fetchServingRowJourneys, __resetServingRowJourneys } = await import("./serving-row-journeys.js");

describe("fetchServingRowJourneys: the sender attribution never silently falls back to the serve row", () => {
  beforeEach(() => {
    __resetServingRowJourneys();
    fetchBrandJourneys.mockReset();
  });

  it("fails loud when a journey states no emailSends (a producer predating lead-service v0.83.116)", async () => {
    fetchBrandJourneys.mockResolvedValue([
      { leadId: "l1", offerId: null, facts: [], acts: [], emailSends: [] },
      { leadId: "l2", offerId: null, facts: [], acts: [] },
    ]);
    await expect(fetchServingRowJourneys("b1", { orgId: "o1" })).rejects.toThrow(/1 of 2 journeys of brand b1 state no emailSends/);
  });

  it("serves journeys that all state emailSends, an empty list included", async () => {
    const journeys = [{ leadId: "l1", offerId: null, facts: [], acts: [], emailSends: [] }];
    fetchBrandJourneys.mockResolvedValue(journeys);
    await expect(fetchServingRowJourneys("b1", { orgId: "o1" })).resolves.toEqual(journeys);
  });
});
