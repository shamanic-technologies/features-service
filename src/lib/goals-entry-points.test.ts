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
 *  - the producer door is GONE — no resolver for it exists, and the saved-economics read returns no goal
 *    under any name (a consumer reading one again would resurrect the defaulted column);
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
const salesEconomicsModule = await import("./sales-economics-client.js");
const { fetchBrandSavedEconomics } = salesEconomicsModule;
const { validateAudienceStatsQuery } = await import("./audience-stats-compute.js");

const savedEconomicsPayload = (extra: Record<string, unknown> = {}) =>
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
        ...extra,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

afterEach(() => vi.restoreAllMocks());

describe("the producer door is GONE — nothing reads a brand's optimization goal", () => {
  it("no brand-service-payload goal resolver is exported any more", () => {
    // These three resolved a goal read off a brand-service payload. Their absence IS the feature: a
    // goal read is what the retirement removes, and a re-added one would be a silent regression.
    expect("matchBrandServiceGoal" in goalsModule).toBe(false);
    expect("matchBrandServiceWebsitePurchaseGoal" in goalsModule).toBe(false);
    expect("matchDeclaredCombinedSalesGoal" in goalsModule).toBe(false);
  });

  it("the saved-economics read returns economics ONLY — no goal under any name, even when the payload still carries the column", async () => {
    // brand-service has not dropped the column yet, so the payload below still has it. Reading it is
    // what must not happen: it is NOT NULL with a server default, so it says "website purchases" for a
    // brand that chose nothing.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(savedEconomicsPayload({ optimizationGoal: "sales" }));

    const res = await fetchBrandSavedEconomics("brand-1", "org-A");

    // The economics object is a passthrough of the producer's payload, so the column may still ride
    // along in it while brand-service has it. What must never come back is a RESOLVED goal — a value
    // this service derived and then branched on.
    expect(Object.keys(res)).toEqual(["economics"]);
    expect(res.economics?.lifetimeRevenueUsd).toBe(100);
    expect((res as unknown as Record<string, unknown>).goal).toBeUndefined();
  });

  it("a declared funnel carries no goal to read either — the funnel key is the whole vocabulary", () => {
    const ranked = declaredFunnelsToRank([
      {
        funnelKey: "sales_meetings_from_conversation",
        name: "Reply chain",
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
  it("the website-purchase chain feeds the purchase + signup + CPC buckets, and not the meeting one", () => {
    expect(funnelsInObjectiveBucket("websitePurchase", ["website_purchases"])).toBe(true);
    expect(funnelsInObjectiveBucket("signup", ["website_purchases"])).toBe(true);
    expect(funnelsInObjectiveBucket("websiteVisit", ["website_purchases"])).toBe(true);
    expect(funnelsInObjectiveBucket("meetingBooked", ["website_purchases"])).toBe(false);
  });

  it("the two meeting chains both feed the meeting bucket; only the click-bought one feeds CPC", () => {
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

describe("the request door: `?funnel=` is sufficient, `?goal=` still works beside it", () => {
  const req = (query: Record<string, string>) => ({ query, params: {} }) as never;

  it("a funnel alone is a valid request — the goal is derived from it, not demanded of the caller", () => {
    const res = validateAudienceStatsQuery(req({ brandId: "b1", funnel: "sales_meetings_from_conversation" }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.funnelKey).toBe("sales_meetings_from_conversation");
      expect(res.goal).toBe("meetingBooked");
    }
  });

  it("a legacy funnel spelling resolves to the canonical key (accepted forever on the way in)", () => {
    const res = validateAudienceStatsQuery(req({ brandId: "b1", funnel: "visit_form" }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.funnelKey).toBe("form_magnet");
  });

  it("the deprecated `?goal=` alone still answers, and a named funnel WINS over it", () => {
    const goalOnly = validateAudienceStatsQuery(req({ brandId: "b1", goal: "positiveReply" }));
    expect(goalOnly.ok).toBe(true);
    if (goalOnly.ok) {
      expect(goalOnly.goal).toBe("positiveReply");
      expect(goalOnly.funnelKey).toBeUndefined();
    }

    const both = validateAudienceStatsQuery(req({ brandId: "b1", goal: "positiveReply", funnel: "form_magnet" }));
    expect(both.ok).toBe(true);
    if (both.ok) expect(both.funnelKey).toBe("form_magnet");
  });

  it("neither one is the BRAND-LEVEL read (goal null, no chain named); an unrecognised funnel/goal is still 400", () => {
    // A brand runs several funnels at once, so at brand level there is no goal — the read is combined
    // over the brand's DECLARED set and carries no goal at all. It is a request, not a missing parameter.
    const neither = validateAudienceStatsQuery(req({ brandId: "b1" }));
    expect(neither.ok).toBe(true);
    if (neither.ok) {
      expect(neither.goal).toBeNull();
      expect(neither.funnelKey).toBeUndefined();
    }

    // A NAMED-but-unrecognised value stays a 400 — never a silent fall back to the brand-level read,
    // which would answer a chain-specific question with a brand-wide number and look right.
    const bogusGoal = validateAudienceStatsQuery(req({ brandId: "b1", goal: "not_a_goal" }));
    expect(bogusGoal.ok).toBe(false);
    if (!bogusGoal.ok) expect(bogusGoal.status).toBe(400);

    const bogus = validateAudienceStatsQuery(req({ brandId: "b1", funnel: "not_a_funnel" }));
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) expect(bogus.status).toBe(400);
  });
});
