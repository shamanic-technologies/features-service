import { describe, it, expect, vi, beforeEach } from "vitest";

// A fake runs-service `/v1/stats/costs` over cost rows (campaign, run feature slug, cents): it applies the same
// filters runs-service does (`campaignId`, `featureSlugs`) and groups by the asked dimensions.
type CostRow = { campaignId: string; featureSlug: string; cents: number };
let ROWS: CostRow[] = [];
const seenUrls: string[] = [];
vi.mock("./fetch-retry.js", () => ({
  fetchWithRetry: async (url: string) => {
    seenUrls.push(url);
    const u = new URL(url);
    const slugs = (u.searchParams.get("featureSlugs") ?? "").split(",");
    const campaignId = u.searchParams.get("campaignId");
    const groupBy = (u.searchParams.get("groupBy") ?? "").split(",").filter(Boolean);
    const groups = new Map<string, { dimensions: Record<string, string>; cents: number }>();
    for (const r of ROWS) {
      if (!slugs.includes(r.featureSlug)) continue;
      if (campaignId && r.campaignId !== campaignId) continue;
      const dims: Record<string, string> = {};
      for (const g of groupBy) dims[g] = g === "campaignId" ? r.campaignId : g === "workflowSlug" ? "wf-v1" : "x";
      const key = JSON.stringify(dims);
      const prev = groups.get(key) ?? { dimensions: dims, cents: 0 };
      prev.cents += r.cents;
      groups.set(key, prev);
    }
    const body = {
      groups: [...groups.values()].map((g) => ({
        dimensions: g.dimensions,
        totalCostInUsdCents: String(g.cents),
        actualCostInUsdCents: String(g.cents),
        netTotalCostInUsdCents: String(g.cents),
        netActualCostInUsdCents: String(g.cents),
      })),
    };
    return new Response(JSON.stringify(body), { status: 200 });
  },
}));

const { planPipeSpend, planChannelSpend, planBrandWideChannelSpend, withPipeSpendAttribution, pipeRunsScope, pipeSpendAttributionKey, attributedCampaignId } = await import("./pipe-spend-attribution.js");
const { runsFeatureSlugsParam } = await import("./feature-scope.js");
const { fetchRunsCostCents } = await import("./runs-cost-client.js");
import type { SalesFunnelCampaignRow } from "./sales-funnel-campaigns-client.js";

const COLD_EMAIL = "sales-cold-email-outreach";
const COLD_FILTERS = "sourcing-apollo-cold-filters";
const BUYING = "sourcing-apollo-buying-signals";
const LINKEDIN = "sourcing-linkedin-engagement-signals";

// The prod funnel 7fcf42ab: three sourcing pipes feeding one cold email pipe.
const unit = (campaignId: string, featureSlug: string) => ({ campaignId, pipeId: `${featureSlug}|leg`, featureSlug, legKey: "leg", status: "ongoing" });
const funnel = (units: ReturnType<typeof unit>[], id = "funnel-1"): SalesFunnelCampaignRow => ({
  id,
  brandId: "b",
  offerId: "o",
  salesFunnelId: "sf",
  salesFunnelName: "Bliss",
  status: "ongoing",
  stopReason: null,
  createdAt: "2026-10-07T00:00:00Z",
  units,
});
const ROWS_7FCF = [funnel([unit("cf", COLD_FILTERS), unit("bs", BUYING), unit("li", LINKEDIN), unit("ce", COLD_EMAIL)])];

describe("planPipeSpend (who releases, who adopts, within one sales funnel campaign)", () => {
  it("the outreach pipe releases every origin a sibling sourcing pipe runs", () => {
    expect(planPipeSpend(ROWS_7FCF, "ce", COLD_EMAIL)).toEqual({ releasedOriginSlugs: [BUYING, COLD_FILTERS, LINKEDIN].sort(), adoptFrom: [] });
  });

  it("a sourcing pipe adopts the outreach units that serve its origin", () => {
    expect(planPipeSpend(ROWS_7FCF, "cf", COLD_FILTERS)).toEqual({ releasedOriginSlugs: [], adoptFrom: [{ campaignId: "ce", featureSlug: COLD_EMAIL }] });
  });

  it("an origin no sibling runs stays on the outreach pipe", () => {
    const rows = [funnel([unit("bs", BUYING), unit("ce", COLD_EMAIL)])];
    expect(planPipeSpend(rows, "ce", COLD_EMAIL)?.releasedOriginSlugs).toEqual([BUYING]);
  });

  it("nothing moves for a campaign in no funnel, a unit read as another channel, or two units of one origin", () => {
    expect(planPipeSpend(ROWS_7FCF, "legacy", COLD_EMAIL)).toBeNull();
    expect(planPipeSpend(ROWS_7FCF, "ce", COLD_FILTERS)).toBeNull();
    const twice = [funnel([unit("cf1", COLD_FILTERS), unit("cf2", COLD_FILTERS), unit("ce", COLD_EMAIL)])];
    expect(planPipeSpend(twice, "ce", COLD_EMAIL)).toBeNull();
    expect(planPipeSpend(twice, "cf1", COLD_FILTERS)).toBeNull();
  });

  it("a campaign that is a unit of two funnel campaigns is not re-attributed", () => {
    const rows = [funnel([unit("cf", COLD_FILTERS), unit("ce", COLD_EMAIL)], "f1"), funnel([unit("ce", COLD_EMAIL)], "f2")];
    expect(planPipeSpend(rows, "ce", COLD_EMAIL)).toBeNull();
  });
});

describe("runsFeatureSlugsParam with released origins", () => {
  it("drops a released origin from the expansion only, never a slug the scope names", () => {
    const param = runsFeatureSlugsParam(COLD_EMAIL, [COLD_FILTERS]).split(",");
    expect(param).toContain(COLD_EMAIL);
    expect(param).toContain(BUYING);
    expect(param).not.toContain(COLD_FILTERS);
    expect(runsFeatureSlugsParam(COLD_FILTERS, [COLD_FILTERS])).toBe(COLD_FILTERS);
    expect(runsFeatureSlugsParam(COLD_EMAIL, [])).toBe(runsFeatureSlugsParam(COLD_EMAIL));
  });
});

describe("a pipe's runs spend reads under the attribution (prod funnel 7fcf42ab)", () => {
  const headers = { orgId: "org-1" };
  beforeEach(() => {
    process.env.RUNS_SERVICE_URL = "http://runs";
    process.env.RUNS_SERVICE_API_KEY = "k";
    seenUrls.length = 0;
    // Before 10-08 the cold filters serves ran under the cold email pipe; since then each source books its own.
    ROWS = [
      { campaignId: "ce", featureSlug: COLD_EMAIL, cents: 9202 },
      { campaignId: "ce", featureSlug: COLD_FILTERS, cents: 3271 },
      { campaignId: "bs", featureSlug: BUYING, cents: 1013 },
      { campaignId: "li", featureSlug: LINKEDIN, cents: 770 },
      { campaignId: "other", featureSlug: COLD_FILTERS, cents: 5000 },
    ];
  });

  const coldEmail = { pipeCampaignIds: ["ce"], releasedOriginSlugs: [BUYING, COLD_FILTERS, LINKEDIN].sort(), adoptedCampaignIds: [] };
  const coldFilters = { pipeCampaignIds: ["cf"], releasedOriginSlugs: [], adoptedCampaignIds: ["ce"] };

  it("BEFORE: the cold email pipe carries the cold filters history, the cold filters pipe reads $0", async () => {
    expect((await fetchRunsCostCents("b", "ce", COLD_EMAIL, headers)).committedCents).toBe(12473);
    expect((await fetchRunsCostCents("b", "cf", COLD_FILTERS, headers)).committedCents).toBe(0);
  });

  it("AFTER: each pipe reads its own spend and the funnel's total is unchanged", async () => {
    const ce = await withPipeSpendAttribution(coldEmail, () => fetchRunsCostCents("b", "ce", COLD_EMAIL, headers));
    const cf = await withPipeSpendAttribution(coldFilters, () => fetchRunsCostCents("b", "cf", COLD_FILTERS, headers));
    const bs = await fetchRunsCostCents("b", "bs", BUYING, headers);
    const li = await fetchRunsCostCents("b", "li", LINKEDIN, headers);
    expect(ce.committedCents).toBe(9202);
    expect(cf.committedCents).toBe(3271);
    expect(bs.committedCents).toBe(1013);
    expect(li.committedCents).toBe(770);
    expect(ce.committedCents + cf.committedCents + bs.committedCents + li.committedCents).toBe(12473 + 1013 + 770);
  });

  it("a read whose scope is not the pipe's identity is untouched inside the same compute", async () => {
    const brandWide = await withPipeSpendAttribution(coldEmail, () => fetchRunsCostCents("b", undefined, COLD_EMAIL, headers));
    expect(brandWide.committedCents).toBe(9202 + 3271 + 1013 + 770 + 5000);
    expect(pipeRunsScope(["ce", "x"])).toEqual({ campaignScope: ["ce", "x"], releasedOriginSlugs: [] });
  });

  it("an adopted outreach id folds onto the pipe; outside the attribution nothing is folded", async () => {
    expect(attributedCampaignId("ce")).toBe("ce");
    await withPipeSpendAttribution(coldFilters, async () => {
      expect(attributedCampaignId("ce")).toBe("cf");
      expect(attributedCampaignId("bs")).toBe("bs");
    });
  });

  it("keys a cell only when something moves", () => {
    expect(pipeSpendAttributionKey(null)).toBeUndefined();
    expect(pipeSpendAttributionKey(coldFilters)).toBe("r:|a:ce");
  });
});

describe("planChannelSpend: an offer's / a brand's channel rows each read their OWN spend (owner 2026-10-11)", () => {
  const headers = { orgId: "org-1" };
  beforeEach(() => {
    process.env.RUNS_SERVICE_URL = "http://runs";
    process.env.RUNS_SERVICE_API_KEY = "k";
    // Prod brand 448eea76's shape: the cold filters history under the cold email campaign, none under its source campaign.
    ROWS = [
      { campaignId: "ce", featureSlug: COLD_EMAIL, cents: 6452 },
      { campaignId: "ce", featureSlug: COLD_FILTERS, cents: 3590 },
      { campaignId: "cf", featureSlug: COLD_FILTERS, cents: 0 },
      { campaignId: "ls", featureSlug: "lead-sourcing", cents: 120 },
    ];
  });

  it("the outreach row releases the origins the set runs as channels; each such channel adopts the outreach ids", () => {
    const plan = planChannelSpend([
      { featureSlug: COLD_EMAIL, campaignIds: ["ce"] },
      { featureSlug: COLD_FILTERS, campaignIds: ["cf"] },
      { featureSlug: "your-team-website", campaignIds: ["w"] },
    ]);
    expect(plan.get(COLD_EMAIL)).toEqual({ pipeCampaignIds: ["ce"], releasedOriginSlugs: [COLD_FILTERS], adoptedCampaignIds: [] });
    expect(plan.get(COLD_FILTERS)).toEqual({ pipeCampaignIds: ["cf"], releasedOriginSlugs: [], adoptedCampaignIds: ["ce"] });
    expect(plan.has("your-team-website")).toBe(false);
  });

  it("an origin the set does not run as a channel stays with the outreach row (no channel to own it)", () => {
    expect(planChannelSpend([{ featureSlug: COLD_EMAIL, campaignIds: ["ce"] }]).size).toBe(0);
  });

  it("AFTER: the rows add up to the same total, the sourcing row now carrying its own spend", async () => {
    const plan = planChannelSpend([
      { featureSlug: COLD_EMAIL, campaignIds: ["ce"] },
      { featureSlug: COLD_FILTERS, campaignIds: ["cf"] },
      { featureSlug: "lead-sourcing", campaignIds: ["ls"] },
    ]);
    const before = (await fetchRunsCostCents("b", ["ce"], COLD_EMAIL, headers)).committedCents
      + (await fetchRunsCostCents("b", ["cf"], COLD_FILTERS, headers)).committedCents
      + (await fetchRunsCostCents("b", ["ls"], "lead-sourcing", headers)).committedCents;
    const ce = await withPipeSpendAttribution(plan.get(COLD_EMAIL)!, () => fetchRunsCostCents("b", ["ce"], COLD_EMAIL, headers));
    const cf = await withPipeSpendAttribution(plan.get(COLD_FILTERS)!, () => fetchRunsCostCents("b", ["cf"], COLD_FILTERS, headers));
    const ls = await withPipeSpendAttribution(plan.get("lead-sourcing") ?? null, () => fetchRunsCostCents("b", ["ls"], "lead-sourcing", headers));
    expect([ce.committedCents, cf.committedCents, ls.committedCents]).toEqual([6452, 3590, 120]);
    expect(ce.committedCents + cf.committedCents + ls.committedCents).toBe(before);
  });

  it("a BRAND-WIDE read of the outreach channel releases every origin feeding it (each reads its own brand-wide)", async () => {
    const plan = planBrandWideChannelSpend(COLD_EMAIL)!;
    expect(plan.pipeCampaignIds).toEqual([]);
    expect(plan.releasedOriginSlugs).toContain(COLD_FILTERS);
    expect(plan.releasedOriginSlugs).toContain("lead-sourcing");
    const ce = await withPipeSpendAttribution(plan, () => fetchRunsCostCents("b", undefined, COLD_EMAIL, headers));
    const cf = await fetchRunsCostCents("b", undefined, COLD_FILTERS, headers);
    const ls = await fetchRunsCostCents("b", undefined, "lead-sourcing", headers);
    expect(ce.committedCents).toBe(6452);
    expect(ce.committedCents + cf.committedCents + ls.committedCents).toBe(6452 + 3590 + 120);
    expect(planBrandWideChannelSpend(COLD_FILTERS)).toBeNull();
  });
});
