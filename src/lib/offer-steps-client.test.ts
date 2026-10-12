import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchWithRetry = vi.hoisted(() => vi.fn());
vi.mock("./fetch-retry.js", () => ({ fetchWithRetry }));
const { fetchOfferSteps, OfferStepsOfferNotFoundError, OfferStepsUnreadableError } = await import("./offer-steps-client.js");

const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("fetchOfferSteps", () => {
  beforeEach(() => {
    process.env.BRAND_SERVICE_URL = "http://brand";
    process.env.BRAND_SERVICE_API_KEY = "k";
    fetchWithRetry.mockReset();
  });

  it("reads a stated and a never-stated offer", async () => {
    fetchWithRetry.mockResolvedValueOnce(reply(200, { offerId: "o", stated: true, steps: ["conversation"], statedAt: "t" }));
    expect(await fetchOfferSteps("b", "o", { orgId: "org" })).toEqual({ offerId: "o", stated: true, steps: ["conversation"], statedAt: "t" });
    fetchWithRetry.mockResolvedValueOnce(reply(200, { offerId: "o", stated: false, steps: null, statedAt: null }));
    expect(await fetchOfferSteps("b", "o", { orgId: "org" })).toMatchObject({ stated: false, steps: null });
  });

  it("a brand the org does not hold (403) or an offer not on it (404) is not found, never unreadable", async () => {
    fetchWithRetry.mockResolvedValueOnce(reply(403, { error: "Brand does not belong to the caller's org" }));
    await expect(fetchOfferSteps("b", "o", { orgId: "org" })).rejects.toBeInstanceOf(OfferStepsOfferNotFoundError);
    fetchWithRetry.mockResolvedValueOnce(reply(404, { error: "no offer" }));
    await expect(fetchOfferSteps("b", "o", { orgId: "org" })).rejects.toBeInstanceOf(OfferStepsOfferNotFoundError);
  });

  it("fails loud on anything else", async () => {
    fetchWithRetry.mockResolvedValueOnce(reply(500, "boom"));
    await expect(fetchOfferSteps("b", "o", { orgId: "org" })).rejects.toBeInstanceOf(OfferStepsUnreadableError);
    fetchWithRetry.mockResolvedValueOnce(reply(200, { stated: true, steps: null }));
    await expect(fetchOfferSteps("b", "o", { orgId: "org" })).rejects.toBeInstanceOf(OfferStepsUnreadableError);
  });
});
