/**
 * REGRESSION SUITE — the goal has ONE entry point left, and the other one must never come back.
 *
 * There used to be two doors, and the token `sales` meant opposite things on each:
 *
 *   ENTRY POINT A — a brand-service PAYLOAD (`salesEconomics.optimizationGoal`) → `sales` meant WEBSITE
 *                   PURCHASE. **THIS DOOR IS GONE.** Nothing in this service reads a brand's
 *                   optimization goal any more: the column is NOT NULL with a server default, so a brand
 *                   that never chose a goal read back as selling through website purchases when nobody
 *                   had said so, and brand-service is dropping it. What a brand sells through is its
 *                   DECLARED SALES FUNNEL SET, and every internal computation keys on that.
 *
 *   ENTRY POINT B — a CALLER's REQUEST PARAM (`goal` / `objective` / `lens`) → `sales` means COMBINED
 *                   sales, because the dashboard's local enum spells the combined goal `sales` and sends
 *                   it verbatim. This door survives as a DEPRECATION with a stated end: it keeps working
 *                   until the dashboard migrates to `?funnel=`, then it goes.
 *
 * What this suite pins now:
 *  - the surviving caller door keeps its meaning;
 *  - the producer door is GONE — no resolver for it exists, and the economics a read is priced on (the
 *    offer's terms, `lib/offer-pricing.ts`; the brand-level saved-economics read was retired 2026-10-05)
 *    carry no goal under any name (a consumer reading one again would resurrect the defaulted column);
 *  - bucket membership on the cross-org surfaces is decided by DECLARED FUNNELS, not by a goal;
 *  - `?funnel=` is sufficient on the request door, and `?goal=` still works beside it.
 *
 * The bug the old two-resolver split fixed (2026-08-01) is not re-openable: with the producer door
 * removed there is nothing left to conflate. The bug this version prevents is the opposite one —
 * quietly re-introducing a goal read (or a goal→funnel translation table) as a "compatibility layer",
 * which would put the defaulted column back in the middle of every customer-facing benchmark.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";

const goalsModule = await import("./goals.js");
const { matchCombinedSalesGoal } = goalsModule;
const crossOrgModule = await import("./cross-org-cost-per-outcome.js");
const { normalizeObjective, funnelsInObjectiveBucket } = crossOrgModule;
const { declaredFunnelsToRank } = await import("./declared-funnels.js");
const { priceOnDeclaredFunnel } = await import("./offer-pricing.js");
const { validateAudienceStatsQuery } = await import("./audience-stats-compute.js");

afterEach(() => vi.restoreAllMocks());

describe("the producer door is GONE — nothing reads a brand's optimization goal", () => {
  it("no brand-service-payload goal resolver is exported any more", () => {
    // These three resolved a goal read off a brand-service payload. Their absence IS the feature: a
    // goal read is what the retirement removes, and a re-added one would be a silent regression.
    expect("matchBrandServiceGoal" in goalsModule).toBe(false);
    expect("matchBrandServiceWebsitePurchaseGoal" in goalsModule).toBe(false);
    expect("matchDeclaredCombinedSalesGoal" in goalsModule).toBe(false);
  });

  it("the economics a read is priced on carry NO goal — only the offer's terms and the funnels walked", () => {
    // The brand-level saved-economics read (which still carried the column) is retired; what prices a
    // read now is the offer's terms on its declared funnels. A resolved goal must not appear anywhere in
    // it: the funnel keys ARE the vocabulary.
    const priced = priceOnDeclaredFunnel([
      {
        funnelKey: "sales_meetings_from_conversation",
        name: "Reply funnel",
        steps: [],
        rates: { replyToMeetingPct: 30, meetingToClosePct: 25 },
        lifetimeRevenueUsd: 100,
        destinationUrl: null,
        bookingUrl: null,
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);

    expect(Object.keys(priced).sort()).toEqual(["economics", "pricedFunnelKeys"]);
    expect(Object.keys(priced.economics).sort()).toEqual(["economics", "unpricedReason"]);
    expect(priced.pricedFunnelKeys).toEqual(["sales_meetings_from_conversation"]);
    expect(priced.economics.economics?.lifetimeRevenueUsd).toBe(100);
    for (const key of ["goal", "optimizationGoal"]) {
      expect(key in priced).toBe(false);
      expect(key in (priced.economics.economics ?? {})).toBe(false);
    }
  });

  it("a declared funnel carries no goal to read either — the funnel key is the whole vocabulary", () => {
    const ranked = declaredFunnelsToRank([
      {
        funnelKey: "sales_meetings_from_conversation",
        name: "Reply funnel",
        steps: [],
        rates: { replyToMeetingPct: 40 },
        lifetimeRevenueUsd: 5000,
        destinationUrl: null,
        bookingUrl: null,
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    expect(Object.keys(ranked[0]).sort()).toEqual(["economics", "funnelKey", "name"]);
  });
});

describe("the caller door survives, unchanged, as a deprecation", () => {
  it("a bare `sales` on a REQUEST PARAM still means COMBINED sales (the dashboard sends it verbatim)", () => {
    expect(matchCombinedSalesGoal("sales")).toBe("sales");
    expect(matchCombinedSalesGoal("combined_sales")).toBe("sales");
    expect(normalizeObjective("sales")).toBe("sales");
  });

  it("an unrecognised value still returns null — no silent fallback on either vocabulary", () => {
    expect(matchCombinedSalesGoal("nonsense")).toBeNull();
    expect(normalizeObjective("nonsense")).toBeNull();
  });
});

describe("bucket membership is decided by DECLARED FUNNELS, never by a goal", () => {
  it("the website-purchase funnel feeds the purchase + signup + CPC buckets, and not the meeting one", () => {
    expect(funnelsInObjectiveBucket("websitePurchase", ["website_purchases"])).toBe(true);
    expect(funnelsInObjectiveBucket("signup", ["website_purchases"])).toBe(true);
    expect(funnelsInObjectiveBucket("websiteVisit", ["website_purchases"])).toBe(true);
    expect(funnelsInObjectiveBucket("meetingBooked", ["website_purchases"])).toBe(false);
  });

  it("the two meeting funnels both feed the meeting bucket; only the click-bought one feeds CPC", () => {
    expect(funnelsInObjectiveBucket("meetingBooked", ["sales_meetings_from_conversation"])).toBe(true);
    expect(funnelsInObjectiveBucket("meetingBooked", ["sales_meetings_from_website"])).toBe(true);
    expect(funnelsInObjectiveBucket("websiteVisit", ["sales_meetings_from_conversation"])).toBe(false);
    expect(funnelsInObjectiveBucket("websiteVisit", ["sales_meetings_from_website"])).toBe(true);
  });

  it("a brand that declared NOTHING lands in no bucket — never defaulted into one", () => {
    for (const objective of ["websiteVisit", "signup", "meetingBooked", "websitePurchase", "sales", "formSubmission"] as const) {
      expect(funnelsInObjectiveBucket(objective, [])).toBe(false);
    }
  });
});

describe("the request door: `?funnel=` is retired, `?goal=` still works", () => {
  const req = (query: Record<string, string>) => ({ query, params: {} }) as never;

  it("a named funnel is REFUSED with funnel_retired — alone or beside a goal, legacy spelling or not", () => {
    for (const query of [
      { brandId: "b1", funnel: "sales_meetings_from_conversation" } as Record<string, string>,
      { brandId: "b1", funnel: "visit_form" },
      { brandId: "b1", goal: "positiveReply", funnel: "form_magnet" },
      { brandId: "b1", funnel: "not_a_funnel" },
    ]) {
      const res = validateAudienceStatsQuery(req(query));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(400);
        expect(res.reason).toBe("funnel_retired");
      }
    }
  });

  it("an EMPTY `?funnel=` names nothing and is read as absent, as it always was", () => {
    const res = validateAudienceStatsQuery(req({ brandId: "b1", goal: "positiveReply", funnel: "" }));
    expect(res.ok).toBe(true);
  });

  it("`?goal=` alone still answers", () => {
    const goalOnly = validateAudienceStatsQuery(req({ brandId: "b1", goal: "positiveReply" }));
    expect(goalOnly.ok).toBe(true);
    if (goalOnly.ok) expect(goalOnly.goal).toBe("positiveReply");
  });

  it("neither is the BRAND-LEVEL read (goal null); an unrecognised goal is still 400", () => {
    const neither = validateAudienceStatsQuery(req({ brandId: "b1" }));
    expect(neither.ok).toBe(true);
    if (neither.ok) expect(neither.goal).toBeNull();

    const bogusGoal = validateAudienceStatsQuery(req({ brandId: "b1", goal: "not_a_goal" }));
    expect(bogusGoal.ok).toBe(false);
    if (!bogusGoal.ok) expect(bogusGoal.status).toBe(400);
  });
});
