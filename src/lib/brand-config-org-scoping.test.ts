/**
 * REGRESSION GUARD — every INTERNAL brand-service read of PER-BRAND CONFIGURATION names the org whose
 * configuration is wanted.
 *
 * A brand row is a SHARED GLOBAL IDENTITY: any org that claims the same domain lands on the same brand
 * id. What that brand sells, at what rates, through which funnels, is therefore the data of an
 * (org, brand) PAIR — two orgs claiming one domain legitimately sell different things, so there is no
 * single answer to give. brand-service can still answer when exactly one org claims the brand, but for
 * a brand claimed by several it refuses rather than guess (guessing is the cross-org leak it closes).
 *
 * So these reads must carry `x-org-id`, and this suite exists so that can never be dropped again
 * silently: the org header travels as a value assertion, not as a comment. The paired rule is that a
 * caller with NO org must FAIL LOUD — picking a plausible stand-in is the bug, not the fix.
 *
 * The `/orgs/*` economics reads (`fetchSalesEconomics` / `fetchEffectiveEconomics`) already forwarded
 * the org and are the in-repo precedent; they are covered here too so the two halves stay symmetric.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";

const { fetchDeclaredSalesFunnels, SalesFunnelsUnavailableError } = await import("./sales-funnels-client.js");
const { fetchBrandSavedEconomicsWithGoal, fetchEffectiveEconomics, fetchSalesEconomics } = await import(
  "./sales-economics-client.js"
);
const { fetchGoalBucketDataset } = await import("./cross-org-cost-per-outcome.js");

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Records the URL + headers of the single outbound call and answers with `body`. */
function captureFetch(body: unknown): { url: () => string; headers: () => Record<string, string> } {
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    seenUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    seenHeaders = (init?.headers as Record<string, string>) ?? {};
    return json(body);
  });
  return { url: () => seenUrl, headers: () => seenHeaders };
}

const SAVED_ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  visitToClosePct: 1,
  visitToMeetingPct: 2,
  meetingToClosePct: 30,
  replyToMeetingPct: 20,
  optimizationGoal: "positive_replies",
};

describe("internal brand-service config reads carry the org whose configuration is wanted", () => {
  afterEach(() => vi.restoreAllMocks());

  it("GET /internal/brands/:id/sales-funnels sends x-org-id (a brand id alone cannot name whose funnels)", async () => {
    const seen = captureFetch({ declared: true, funnels: [] });

    await fetchDeclaredSalesFunnels("brand-1", "org-A");

    expect(seen.url()).toBe("http://brand:3000/internal/brands/brand-1/sales-funnels");
    expect(seen.headers()["x-api-key"]).toBe("brand-key");
    expect(seen.headers()["x-org-id"]).toBe("org-A");
  });

  it("GET /internal/brands/:id/sales-economics sends x-org-id", async () => {
    const seen = captureFetch({ salesEconomics: SAVED_ECONOMICS });

    const res = await fetchBrandSavedEconomicsWithGoal("brand-1", "org-A");

    expect(seen.url()).toBe("http://brand:3000/internal/brands/brand-1/sales-economics");
    expect(seen.headers()["x-api-key"]).toBe("brand-key");
    expect(seen.headers()["x-org-id"]).toBe("org-A");
    expect(res.goal).toBe("positiveReply");
  });

  it("two orgs claiming ONE brand each get their OWN answer — the org, not the brand, selects it", async () => {
    // Exactly the case brand-service now refuses to guess at: same brand id, two claiming orgs, two
    // different declared goals. The read must be able to ask for either one.
    const byOrg: Record<string, unknown> = {
      "org-A": { salesEconomics: { ...SAVED_ECONOMICS, optimizationGoal: "positive_replies" } },
      "org-B": { salesEconomics: { ...SAVED_ECONOMICS, optimizationGoal: "signups" } },
    };
    const seenOrgs: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const orgId = ((init?.headers as Record<string, string>) ?? {})["x-org-id"];
      seenOrgs.push(orgId);
      return json(byOrg[orgId]);
    });

    const a = await fetchBrandSavedEconomicsWithGoal("shared-brand", "org-A");
    const b = await fetchBrandSavedEconomicsWithGoal("shared-brand", "org-B");

    expect(seenOrgs).toEqual(["org-A", "org-B"]);
    expect(a.goal).toBe("positiveReply");
    expect(b.goal).toBe("signup");
  });

  it("a caller with NO org FAILS LOUD on both reads — never a substituted stand-in, never an org-less read", async () => {
    const seen = captureFetch({ declared: true, funnels: [] });

    await expect(fetchDeclaredSalesFunnels("brand-1", "")).rejects.toBeInstanceOf(SalesFunnelsUnavailableError);
    await expect(fetchDeclaredSalesFunnels("brand-1", "")).rejects.toThrow(/requires the org/);
    await expect(fetchBrandSavedEconomicsWithGoal("brand-1", "")).rejects.toThrow(/requires the org/);

    // The point of failing loud: nothing was asked of brand-service without an org.
    expect(seen.url()).toBe("");
  });

  it("the cross-org goal-bucket dataset asks under the CLAIMING org from the feature membership, one row per brand", async () => {
    // Cross-org fleet analytics has no single caller org, but it is not org-LESS either: the membership
    // that put a brand in the dataset names a real claiming org, and that is what the read asks under.
    // The dataset stays one row per brand — its spend + outcome legs are brand-grained, so a row per
    // (org, brand) would count a multi-org brand's fleet spend once per claimant.
    const seenEconomicsOrgs: Array<string | undefined> = [];
    let spendCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      const headers = (init?.headers as Record<string, string>) ?? {};

      if (url.includes("/internal/feature-memberships")) {
        return json({
          memberships: [
            { orgId: "org-A", brandId: "shared", workflowSlug: "wf" },
            { orgId: "org-B", brandId: "shared", workflowSlug: "wf" }, // second claimant of the SAME brand
          ],
        });
      }
      if (url.includes("/internal/brands/") && url.includes("/sales-economics")) {
        seenEconomicsOrgs.push(headers["x-org-id"]);
        return json({ salesEconomics: SAVED_ECONOMICS });
      }
      if (url.includes("/v1/stats/public/costs/timeseries")) {
        spendCalls += 1;
        return json({ buckets: [{ period: "2026-07-30", totalCostInUsdCents: "1000" }] });
      }
      if (url.includes("/public/stats")) return json({ groups: [] });
      return json({});
    });

    const dataset = await fetchGoalBucketDataset("sales-cold-email-outreach");

    // Asked under a REAL claimant — never org-less, never a stand-in.
    expect(seenEconomicsOrgs).toEqual(["org-A"]);
    // ...and the brand's fleet spend is read (and so counted) exactly ONCE.
    expect(spendCalls).toBe(1);
    expect(dataset).toHaveLength(1);
    expect(dataset[0].brandId).toBe("shared");
    expect(dataset[0].goal).toBe("positiveReply");
  });

  it("the org-scoped /orgs/* economics reads keep forwarding the caller's org (the in-repo precedent)", async () => {
    const effective = captureFetch({ economics: SAVED_ECONOMICS, source: "user" });
    await fetchEffectiveEconomics("brand-1", { orgId: "org-A" });
    expect(effective.url()).toBe("http://brand:3000/orgs/brands/brand-1/sales-economics-effective");
    expect(effective.headers()["x-org-id"]).toBe("org-A");

    vi.restoreAllMocks();

    const saved = captureFetch({ salesEconomics: SAVED_ECONOMICS });
    await fetchSalesEconomics("brand-1", { orgId: "org-B" });
    expect(saved.url()).toBe("http://brand:3000/orgs/brands/brand-1/sales-economics");
    expect(saved.headers()["x-org-id"]).toBe("org-B");
  });
});
