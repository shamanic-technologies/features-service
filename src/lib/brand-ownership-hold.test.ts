import { describe, it, expect, vi, beforeEach } from "vitest";

// DASH-SPEED-1110: a "yes" from brand-service is held; a refusal or an error never is.
const fetchWithRetry = vi.fn();
vi.mock("./fetch-retry.js", () => ({ fetchWithRetry: (...a: unknown[]) => fetchWithRetry(...a) }));

const { assertBrandHeld, BrandOwnershipError, dropBrandOwnershipHolds, __resetBrandOwnershipHolds } = await import("./brand-ownership.js");

const ok = () => new Response("{}", { status: 200 });
const refused = () => new Response("Brand not found", { status: 404 });
const H = { orgId: "org-1", userId: "u", runId: "r" };

beforeEach(() => {
  process.env.BRAND_SERVICE_URL = "http://brand";
  process.env.BRAND_SERVICE_API_KEY = "k";
  process.env.BRAND_OWNERSHIP_HOLD_MS = "60000";
  fetchWithRetry.mockReset();
  __resetBrandOwnershipHolds();
  vi.useRealTimers();
});

describe("assertBrandHeld — held yes", () => {
  it("asks brand-service once for concurrent and later reads inside the hold", async () => {
    fetchWithRetry.mockImplementation(async () => ok());
    await Promise.all([assertBrandHeld("b-1", H), assertBrandHeld("b-1", H)]);
    await assertBrandHeld("b-1", H);
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
  });

  it("is per (org, brand): another org is asked", async () => {
    fetchWithRetry.mockImplementation(async () => ok());
    await assertBrandHeld("b-1", H);
    await assertBrandHeld("b-1", { ...H, orgId: "org-2" });
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
  });

  it("never holds a refusal: every read asks and throws", async () => {
    fetchWithRetry.mockImplementation(async () => refused());
    await expect(assertBrandHeld("b-1", H)).rejects.toBeInstanceOf(BrandOwnershipError);
    await expect(assertBrandHeld("b-1", H)).rejects.toBeInstanceOf(BrandOwnershipError);
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
  });

  it("past the hold answers at once and re-checks behind; a refusal then ends the hold", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fetchWithRetry.mockImplementation(async () => ok());
    await assertBrandHeld("b-1", H);
    vi.setSystemTime(Date.now() + 61_000);
    fetchWithRetry.mockImplementation(async () => refused());
    await assertBrandHeld("b-1", H); // answered from the hold
    await vi.waitFor(() => expect(fetchWithRetry).toHaveBeenCalledTimes(2));
    await new Promise((r) => setImmediate(r));
    await expect(assertBrandHeld("b-1", H)).rejects.toBeInstanceOf(BrandOwnershipError);
  });

  it("a brand transfer drops the holds of its orgs", async () => {
    fetchWithRetry.mockImplementation(async () => ok());
    await assertBrandHeld("b-1", H);
    expect(dropBrandOwnershipHolds(["org-1"])).toBe(1);
    await assertBrandHeld("b-1", H);
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
  });

  it("BRAND_OWNERSHIP_HOLD_MS=0 asks on every read", async () => {
    process.env.BRAND_OWNERSHIP_HOLD_MS = "0";
    fetchWithRetry.mockImplementation(async () => ok());
    await assertBrandHeld("b-1", H);
    await assertBrandHeld("b-1", H);
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
  });
});
