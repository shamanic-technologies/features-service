import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const B = "75d7e3e8-6926-4f85-a557-976895400666";
const READ_BRAND = "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb";
const NEVER_READ_ORG_BRAND = "11111111-1111-4111-8111-111111111111";

let cells: Record<string, unknown>[] = [];
vi.mock("../db/index.js", () => ({
  db: { select: () => ({ from: () => ({ where: async () => cells }) }) },
  sql: {},
}));
vi.mock("./feature-memberships-client.js", () => ({
  fetchFeatureMemberships: async () => [
    { orgId: "org-a", brandId: B, workflowSlug: "w" },
    { orgId: "org-a", brandId: READ_BRAND, workflowSlug: "w" },
    { orgId: "org-silent", brandId: NEVER_READ_ORG_BRAND, workflowSlug: "w" },
  ],
}));
vi.mock("./campaign-identity-client.js", () => ({
  fetchBrandCampaignRows: async (brandId: string) => [
    { id: `${brandId.slice(0, 4)}-c1`, orgId: "org-a", brandId, featureSlug: "sales-cold-email-outreach", acquisitionChannel: "email", offerId: "off", legKey: "start_to_conversation", status: "ongoing", createdAt: "2026-09-01" },
  ],
}));

const { materializeRound, __resetKeeperStateForTest } = await import("./view-keeper.js");

const ORG_A_UUID = "0a0a0a0a-0000-4000-8000-00000000000a";
const HEADERS = {
  "x-org-id": ORG_A_UUID,
  "x-user-id": "0b0b0b0b-0000-4000-8000-00000000000b",
  "x-run-id": "0c0c0c0c-0000-4000-8000-00000000000c",
  "x-brand-id": READ_BRAND,
};
const now = Date.now();
const recent = new Date(now - 60_000).toISOString();

describe("materializeRound", () => {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  beforeEach(() => {
    asked.length = 0;
    __resetKeeperStateForTest();
    process.env.VIEW_REFRESHER_PORT = "9999";
    process.env.FEATURES_SERVICE_API_KEY = "svc-key";
    delete process.env.VIEW_CACHE_ROLE;
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      asked.push({ url, headers: init.headers });
      return new Response("{}", { status: 200 });
    });
    // One customer read of READ_BRAND's brand page and one of its campaign page. B has never been read.
    cells = [
      { replayUrl: `/brands/${READ_BRAND}/revenue?pricing=net`, replayHeaders: HEADERS, orgId: "org-a", brandId: READ_BRAND, lastReadAt: recent, computedAt: recent },
      {
        replayUrl: `/features/sales-cold-email-outreach/revenue?brandId=${READ_BRAND}&campaignId=f4d7-c1&pricing=net`,
        replayHeaders: HEADERS,
        orgId: "org-a",
        brandId: READ_BRAND,
        lastReadAt: recent,
        computedAt: recent,
      },
    ];
  });
  afterEach(() => vi.unstubAllGlobals());

  it("precomputes every shape read anywhere for a brand never read, under its org's own identity", async () => {
    const report = await materializeRound();
    const urls = asked.map((a) => a.url.replace("http://127.0.0.1:9999", "")).sort();
    expect(urls).toEqual([
      `/brands/${B}/revenue?pricing=net`,
      `/features/sales-cold-email-outreach/revenue?brandId=${B}&campaignId=75d7-c1&pricing=net`,
    ]);
    for (const a of asked) {
      expect(a.headers["x-view-precompute"]).toBe("1");
      expect(a.headers["x-api-key"]).toBe("svc-key");
      expect(a.headers["x-org-id"]).toBe(ORG_A_UUID);
      expect(a.headers["x-brand-id"]).toBe(B);
    }
    expect(report.computed).toBe(2);
    expect(report.held).toBe(2); // READ_BRAND's two cells are already there
    expect(report.noIdentity).toBe(1); // an org that never read a dashboard has nobody to replay as
  });

  it("re-asks a held cell older than a day, never a fresh one", async () => {
    const old = new Date(now - 26 * 3_600_000).toISOString();
    cells.push({ replayUrl: `/brands/${B}/revenue?pricing=net`, replayHeaders: HEADERS, orgId: "org-a", brandId: B, lastReadAt: null, computedAt: old });
    const report = await materializeRound();
    expect(report.stale).toBe(1);
    expect(report.refreshedStale + report.computed).toBe(asked.length);
  });

  it("never replays the org under a MALFORMED identity a probe left on a cell (prod 2026-10-09, x-user-id: x)", async () => {
    // The org's most recent read is a probe's, with non-UUID ids. Adopting it made every precompute of
    // the org fail at runs-service and parked those cells for hours; the older WELL-FORMED read wins.
    cells.push({
      replayUrl: `/brands/${READ_BRAND}/revenue?pricing=gross`,
      replayHeaders: { "x-org-id": ORG_A_UUID, "x-user-id": "x", "x-run-id": "x", "x-brand-id": READ_BRAND },
      orgId: "org-a",
      brandId: READ_BRAND,
      lastReadAt: new Date(now - 1_000).toISOString(),
      computedAt: recent,
    });
    await materializeRound();
    expect(asked.length).toBeGreaterThan(0);
    for (const a of asked) {
      expect(a.headers["x-user-id"]).toBe(HEADERS["x-user-id"]);
      expect(a.headers["x-run-id"]).toBe(HEADERS["x-run-id"]);
    }
  });

  it("an org whose ONLY recorded identity is malformed has nobody to replay as", async () => {
    cells = cells.map((c) => ({ ...c, replayHeaders: { ...HEADERS, "x-user-id": "system-probe" } }));
    const report = await materializeRound();
    expect(asked).toEqual([]);
    expect(report.noIdentity).toBe(3);
  });
});
