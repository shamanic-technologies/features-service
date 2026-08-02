/**
 * REGRESSION SUITE — the token `sales` means TWO different things, and which one it means is decided by
 * the ENTRY POINT it arrived through. This suite drives each real entry point and pins its meaning, so
 * the two can never be collapsed back into one resolver.
 *
 *   ENTRY POINT A — brand-service PAYLOAD  (`salesEconomics.optimizationGoal` on
 *                   `GET /internal/brands/:id/sales-economics`; a declared funnel's `goal` /
 *                   `currentGoal` on `GET /internal/brands/:brandId/sales-funnels`)
 *                   → `sales` means WEBSITE PURCHASE. brand-service's own source: the legacy `sales`
 *                     wire spelling "ALWAYS means website-purchase, and can NEVER be re-purposed for the
 *                     new combined goal (that would silently reinterpret every stored purchase-brand)".
 *                     Its internal read collapses the `website_purchase` wire sub-type onto `sales`, so
 *                     every stored purchase brand reads back as `sales`. The combined goal has its own
 *                     token there: `combined_sales` (runtime `combinedSales`).
 *
 *   ENTRY POINT B — a CALLER's REQUEST PARAM (`goal` / `objective` / `lens`)
 *                   → `sales` means COMBINED sales. The dashboard's local enum spells the combined goal
 *                     `sales` and sends it verbatim (distribute.you `strategy-model.ts`
 *                     `goalForOptimizationGoal("sales") === "sales"`).
 *
 * The bug this pins (fixed 2026-08-01): entry point A resolved `sales` to the COMBINED goal, so every
 * website-purchase brand in production (20+, real customers) was bucketed into the combined-sales
 * cross-org cost-per-outcome benchmark, polluting it and emptying the website-purchase one. That number
 * is customer-facing — it is the fleet benchmark the Audiences + Strategy pages floor on and the rate the
 * landing page prints.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";

const { matchBrandServiceGoal, matchCombinedSalesGoal, matchDeclaredCombinedSalesGoal } = await import("./goals.js");
const { normalizeObjective, goalInObjectiveBucket } = await import("./cross-org-cost-per-outcome.js");
const { declaredFunnelsToRank } = await import("./declared-funnels.js");
const { fetchBrandSavedEconomicsWithGoal } = await import("./sales-economics-client.js");
const { validateAudienceStatsQuery } = await import("./audience-stats-compute.js");

const savedEconomicsPayload = (optimizationGoal: string) =>
  new Response(
    JSON.stringify({
      salesEconomics: {
        lifetimeRevenueUsd: 100,
        replyToMeetingPct: 30,
        visitToMeetingPct: 3,
        meetingToClosePct: 25,
        visitToSignupPct: 5,
        signupToPaidClientPct: 10,
        visitToClosePct: 0.5,
        visitToPaidClientPct: 1,
        replyToPaidClientPct: 5,
        optimizationGoal,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

afterEach(() => vi.restoreAllMocks());

describe("ENTRY POINT A — a value read out of a brand-service PAYLOAD", () => {
  describe("resolver: matchBrandServiceGoal", () => {
    it("`sales` is WEBSITE PURCHASE — brand-service's older, data-backed meaning", () => {
      expect(matchBrandServiceGoal("sales")).toBe("websitePurchase");
    });

    it("`website_purchase` (the preferred wire spelling of the same goal) agrees with it", () => {
      expect(matchBrandServiceGoal("website_purchase")).toBe("websitePurchase");
      // ...as does the runtime token brand-service collapses both onto.
      expect(matchBrandServiceGoal("purchase")).toBe("websitePurchase");
    });

    it("`combined_sales` / `combinedSales` is the ONLY way the combined goal arrives from brand-service", () => {
      expect(matchBrandServiceGoal("combined_sales")).toBe("sales");
      expect(matchBrandServiceGoal("combinedSales")).toBe("sales");
    });

    it("still returns null for an unrecognised value — no silent fallback", () => {
      expect(matchBrandServiceGoal("nonsense")).toBeNull();
      expect(matchBrandServiceGoal("")).toBeNull();
    });
  });

  describe("real reader: fetchBrandSavedEconomicsWithGoal (the cross-org bucketing's goal source)", () => {
    it("a brand whose payload says `sales` resolves to websitePurchase", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(savedEconomicsPayload("sales"));
      // Verified live 2026-08-01 against brand emailtoolshub.com (stored `website_purchase`,
      // current goal `purchase`): the internal read emits `"sales"`.
      // The reader is org-scoped (#715): brand-service refuses to guess which
      // org's configuration to answer with for a brand claimed by several orgs.
      const { goal } = await fetchBrandSavedEconomicsWithGoal(
        "7604c385-1f02-4016-b42f-344565bcd36d",
        "11111111-1111-4111-8111-111111111111",
      );
      expect(goal).toBe("websitePurchase");
    });

    it("a brand whose payload says `combined_sales` still resolves to combined sales", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(savedEconomicsPayload("combined_sales"));
      const { goal } = await fetchBrandSavedEconomicsWithGoal(
        "brand-combined",
        "11111111-1111-4111-8111-111111111111",
      );
      expect(goal).toBe("sales");
    });
  });

  describe("the declared-funnel reader is NO LONGER one of these doors", () => {
    it("a declared funnel carries no goal at all — the funnel key is the whole vocabulary", () => {
      // brand-service retired the goal from every funnel read (#434). This reader used to be entry
      // point A's second door and resolved `goal` / `currentGoal` through matchBrandServiceGoal; a
      // funnel now arrives with a key and nothing else, so there is no goal here to resolve wrongly.
      const [entry] = declaredFunnelsToRank([
        {
          funnelKey: "website_purchases",
          name: "Website Purchase",
          steps: ["Website visit", "Signup", "Paid client"],
          rates: {},
          lifetimeRevenueUsd: null,
          destinationUrl: null,
          bookingUrl: null,
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ]);
      expect(entry).not.toHaveProperty("goal");
      expect(entry.funnelKey).toBe("website_purchases");
    });
  });

  describe("the consequence this bug had: cross-org cost-per-outcome bucketing", () => {
    it("a `sales`-payload brand feeds the websitePurchase bucket, NOT the combined-sales one", () => {
      const goal = matchBrandServiceGoal("sales")!;
      expect(goalInObjectiveBucket("websitePurchase", goal)).toBe(true);
      expect(goalInObjectiveBucket("sales", goal)).toBe(false);
      // A website purchase closes partly through a meeting, so it legitimately also feeds that bucket.
      expect(goalInObjectiveBucket("meetingBooked", goal)).toBe(true);
    });

    it("a `combined_sales`-payload brand still feeds the combined-sales bucket only", () => {
      const goal = matchBrandServiceGoal("combined_sales")!;
      expect(goalInObjectiveBucket("sales", goal)).toBe(true);
      expect(goalInObjectiveBucket("websitePurchase", goal)).toBe(false);
    });
  });
});

describe("ENTRY POINT B — a value a CALLER sent us on a request param", () => {
  it("`objective=sales` (cross-org surfaces) still means COMBINED sales", () => {
    expect(normalizeObjective("sales")).toBe("sales");
    expect(normalizeObjective("combined_sales")).toBe("sales");
    // ...and the purchase goal keeps its own param spellings on this door.
    expect(normalizeObjective("website_purchase")).toBe("websitePurchase");
    expect(normalizeObjective("purchase")).toBe("websitePurchase");
  });

  it("`goal=sales` on /audience-stats (the dashboard's own spelling) still means COMBINED sales", () => {
    const parsed = validateAudienceStatsQuery({
      query: { brandId: "brand-1", goal: "sales" },
    } as never);
    expect(parsed).toMatchObject({ ok: true, goal: "sales" });
  });

  it("resolver: matchCombinedSalesGoal accepts a bare `sales`; its payload twin refuses it", () => {
    expect(matchCombinedSalesGoal("sales")).toBe("sales");
    expect(matchDeclaredCombinedSalesGoal("sales")).toBeNull();
    expect(matchDeclaredCombinedSalesGoal("combined_sales")).toBe("sales");
  });
});

describe("the two doors disagree on purpose", () => {
  it("the SAME string resolves to different goals depending on where it came from", () => {
    expect(matchBrandServiceGoal("sales")).toBe("websitePurchase");
    expect(normalizeObjective("sales")).toBe("sales");
    expect(matchBrandServiceGoal("sales")).not.toBe(normalizeObjective("sales"));
  });
});
