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
 * The org-scoped ownership check (`assertBrandHeld`, `/orgs/brands/:id/leg-rates`) forwards the org
 * too; it replaced the retired brand sales-economics reads (owner 2026-10-05) and is covered here, with
 * the stale-membership contract those reads used to carry (403/404 -> BrandOwnershipError, else loud).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../db/index.js", () => ({ db: { query: { features: { findMany: async () => [] } } }, sql: {} }));

process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";

process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";

const { SalesFunnelsUnavailableError } = await import("./sales-funnels-client.js");
const { fetchBrandLegEconomics } = await import("./brand-leg-economics-client.js");
const { assertBrandHeld, BrandOwnershipError } = await import("./brand-ownership.js");
const { fetchFunnelBucketDataset } = await import("./cross-org-cost-per-outcome.js");

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

describe("internal brand-service config reads carry the org whose configuration is wanted", () => {
  afterEach(() => vi.restoreAllMocks());

  it("GET /internal/brands/:id/offer-economics sends x-org-id (a brand id alone cannot name whose leg rates)", async () => {
    const seen = captureFetch({ legRates: [], offers: [] });

    await fetchBrandLegEconomics("brand-1", "org-A");

    expect(seen.url()).toBe("http://brand:3000/internal/brands/brand-1/offer-economics");
    expect(seen.headers()["x-api-key"]).toBe("brand-key");
    expect(seen.headers()["x-org-id"]).toBe("org-A");
  });

  it("GET /orgs/brands/:id/leg-rates (the ownership check) sends x-org-id + x-brand-id, and resolves when held", async () => {
    const seen = captureFetch({});

    await expect(assertBrandHeld("brand-1", { orgId: "org-A", userId: "u-1", runId: "r-1" })).resolves.toBeUndefined();

    expect(seen.url()).toBe("http://brand:3000/orgs/brands/brand-1/leg-rates");
    expect(seen.headers()["x-api-key"]).toBe("brand-key");
    expect(seen.headers()["x-org-id"]).toBe("org-A");
    expect(seen.headers()["x-brand-id"]).toBe("brand-1");
    expect(seen.headers()["x-user-id"]).toBe("u-1");
    expect(seen.headers()["x-run-id"]).toBe("r-1");
  });

  it("two orgs claiming ONE brand each get their OWN ownership answer — the org, not the brand, selects it", async () => {
    // Same brand id, two claiming orgs: brand-service answers per org, so the check must ask under each.
    const heldBy: Record<string, boolean> = { "org-A": true, "org-B": false };
    const seenOrgs: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const orgId = ((init?.headers as Record<string, string>) ?? {})["x-org-id"];
      seenOrgs.push(orgId);
      return heldBy[orgId] ? json({}) : new Response("forbidden", { status: 403 });
    });

    await expect(assertBrandHeld("shared-brand", { orgId: "org-A" })).resolves.toBeUndefined();
    await expect(assertBrandHeld("shared-brand", { orgId: "org-B" })).rejects.toBeInstanceOf(BrandOwnershipError);

    expect(seenOrgs).toEqual(["org-A", "org-B"]);
  });

  it("a caller with NO org FAILS LOUD on both reads — never a substituted stand-in, never an org-less read", async () => {
    // A non-empty list: an empty one now means "this org never stated a set" and fails loud,
    // which would abort before the headers this test is about could be asserted.
    const seen = captureFetch({ legRates: [], offers: [] });

    await expect(fetchBrandLegEconomics("brand-1", "")).rejects.toBeInstanceOf(SalesFunnelsUnavailableError);
    await expect(fetchBrandLegEconomics("brand-1", "")).rejects.toThrow(/requires the org/);
    await expect(assertBrandHeld("brand-1", { orgId: "" })).rejects.toThrow(/requires the org/);

    // The point of failing loud: nothing was asked of brand-service without an org.
    expect(seen.url()).toBe("");
  });

  it("the cross-org funnel-bucket dataset asks under the CLAIMING org from the feature membership, one row per brand", async () => {
    // Cross-org fleet analytics has no single caller org, but it is not org-LESS either: the membership
    // that put a brand in the dataset names a real claiming org, and that is what the read asks under.
    // The dataset stays one row per brand — its spend + outcome legs are brand-grained, so a row per
    // (org, brand) would count a multi-org brand's fleet spend once per claimant.
    const seenFunnelOrgs: Array<string | undefined> = [];
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
      if (url.includes("/internal/brands/") && url.includes("/offer-economics")) {
        seenFunnelOrgs.push(headers["x-org-id"]);
        return json({
          legRates: [{ fromStep: "Positive reply", toStep: "Meeting booked", ratePct: 30, stated: true, statedAt: "x" }],
          // The offer states its lifetime revenue: a brand priced on no stated LTR is omitted (no average).
          offers: [{ offerId: "offer-1", name: "O", lifetimeRevenueUsd: 1000, lifetimeRevenueStatedAt: "x" }],
        });
      }
      if (url.includes("campaign:3000/campaigns")) {
        return json({ campaigns: [{ id: "c1", orgId: "org-A", brandId: "shared", featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation", offerId: "offer-1", status: "ongoing" }] });
      }
      if (url.includes("/v1/stats/public/costs/timeseries")) {
        spendCalls += 1;
        return json({ buckets: [{ period: "2026-07-30", totalCostInUsdCents: "1000" }] });
      }
      if (url.includes("/public/stats")) return json({ groups: [] });
      return json({});
    });

    const dataset = await fetchFunnelBucketDataset("sales-cold-email-outreach");

    // Asked under a REAL claimant — never org-less, never a stand-in. The per-brand configuration read
    // (the leg statements + offer terms) names that claiming org.
    expect(seenFunnelOrgs).toEqual(["org-A"]);
    // ...and the brand's fleet spend is read (and so counted) exactly ONCE.
    expect(spendCalls).toBe(1);
    expect(dataset).toHaveLength(1);
    expect(dataset[0].brandId).toBe("shared");
    expect(dataset[0].funnels).toEqual(["sales_meetings_from_conversation"]);
  });

  // A brand deleted (404) or claimed away (403) after its feature membership was recorded: every fleet
  // fan-out skips a BrandOwnershipError, while a plain Error takes the whole read down. Pinned because
  // one deleted brand 500'd the public workflow-cost-per-outcome read for every caller on 2026-09-18.
  for (const status of [403, 404]) {
    it(`the ownership check throws BrandOwnershipError on ${status} (a stale membership, skipped by fleet sweeps)`, async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () => new Response(JSON.stringify({ error: "Brand not found" }), { status }),
      );
      const err = await assertBrandHeld("b1", { orgId: "o1" }).catch((e) => e);
      expect(err).toBeInstanceOf(BrandOwnershipError);
      // It is also "we could not read what this brand sells": soft pricing callers degrade on it.
      expect(err).toBeInstanceOf(SalesFunnelsUnavailableError);
      expect(err.brandId).toBe("b1");
      expect(err.orgId).toBe("o1");
    });
  }

  it("the ownership check still fails LOUD on a 500 — a plain Error, never a stale-membership skip", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("boom", { status: 500 }));
    const err = await assertBrandHeld("b1", { orgId: "o1" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BrandOwnershipError);
    expect(String(err.message)).toMatch(/500/);
  });
});
