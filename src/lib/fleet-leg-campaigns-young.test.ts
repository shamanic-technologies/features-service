/**
 * NEW-CAMPAIGN-STRATEGY-404-1126: a campaign campaign-service lists at the moment of the read is found, however young;
 * one it truly does not list still reads as absent (the route's 404 `campaign_not_found`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let listed: Array<Record<string, unknown>> = [];
const reads = vi.fn();
vi.mock("./fetch-retry.js", () => ({
  fetchWithRetry: async (url: string) => {
    reads(url);
    const snapshot = listed.map((r) => ({ ...r }));
    return new Response(JSON.stringify({ campaigns: snapshot }), { status: 200 });
  },
}));

const { fetchCampaignPipe, fetchCampaignSalesFunnelId, __resetCampaignListShareForTest } = await import("./fleet-leg-campaigns.js");

const OLD = { id: "old", orgId: "o1", brandIds: ["b1"], featureSlug: null, legKey: null, salesFunnelId: "f1", salesFunnelCampaignId: "sfc-old" };
const YOUNG = { id: "e2f7850d", orgId: "o1", brandIds: ["b1"], featureSlug: null, legKey: null, salesFunnelId: "f2", salesFunnelCampaignId: "sfc-young" };

beforeEach(() => {
  process.env.CAMPAIGN_SERVICE_URL = "http://campaign";
  process.env.CAMPAIGN_SERVICE_API_KEY = "k";
  __resetCampaignListShareForTest();
  reads.mockClear();
  listed = [OLD];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-26T03:27:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("a campaign created after the shared list copy was taken", () => {
  it("is found by a later read inside the share window (one fresh re-read)", async () => {
    expect(await fetchCampaignPipe("old")).toMatchObject({ found: true, salesFunnelCampaignId: "sfc-old" });
    expect(reads).toHaveBeenCalledTimes(1);
    // campaign-service creates the campaign 16 s later; the shared copy (60 s) predates it.
    vi.setSystemTime(new Date("2026-11-26T03:27:16Z"));
    listed = [OLD, YOUNG];
    vi.setSystemTime(new Date("2026-11-26T03:28:06Z"));
    expect(await fetchCampaignPipe("e2f7850d")).toMatchObject({ found: true, salesFunnelCampaignId: "sfc-young", brandId: "b1", orgId: "o1" });
    expect(reads).toHaveBeenCalledTimes(2);
    // The re-read is the new shared copy: the next ask of either campaign reads nothing more.
    expect(await fetchCampaignSalesFunnelId("e2f7850d")).toEqual({ found: true, salesFunnelId: "f2" });
    expect(await fetchCampaignPipe("old")).toMatchObject({ found: true });
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("a campaign campaign-service truly does not list stays absent (after one re-read)", async () => {
    await fetchCampaignPipe("old");
    vi.setSystemTime(new Date("2026-11-26T03:27:30Z"));
    expect(await fetchCampaignPipe("unknown")).toEqual({ found: false });
    expect(reads).toHaveBeenCalledTimes(2);
    // An ask in the same instant reuses that re-read; a later ask re-reads again (the id may exist by then).
    expect(await fetchCampaignSalesFunnelId("unknown")).toEqual({ found: false, salesFunnelId: null });
    expect(reads).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-11-26T03:27:31Z"));
    expect(await fetchCampaignSalesFunnelId("unknown")).toEqual({ found: false, salesFunnelId: null });
    expect(reads).toHaveBeenCalledTimes(3);
  });

  it("a miss on a copy read for this very ask is final (no second read)", async () => {
    expect(await fetchCampaignPipe("unknown")).toEqual({ found: false });
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("askers missing together share one re-read", async () => {
    await fetchCampaignPipe("old");
    listed = [OLD, YOUNG];
    vi.setSystemTime(new Date("2026-11-26T03:27:40Z"));
    const [a, b] = await Promise.all([fetchCampaignPipe("e2f7850d"), fetchCampaignPipe("e2f7850d")]);
    expect(a).toMatchObject({ found: true });
    expect(b).toMatchObject({ found: true });
    expect(reads).toHaveBeenCalledTimes(2);
  });
});
