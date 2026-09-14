/**
 * Guards for the per-day fact readers behind the MRR split.
 *
 * Every case is about the same thing: `not_recorded` SURVIVES the read. A reader that collapsed it to
 * a 0 or a false would look correct on every fixture and would silently turn "we know nothing about
 * this day" into "the budget was zero" / "the campaign was stopped" — the conflation the whole
 * two-era marking rests on. So each case asserts that an unrecorded answer is ABSENT or `null`, never
 * a value, beside a recorded one on the same response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  EARNING_BATCH_SIZE,
  fetchBrandBudgetByDay,
  fetchBrandCurrentDailyBudget,
  fetchCampaignEarningOnDay,
  fetchFleetCampaigns,
  fetchPaymentStoppedPeriods,
} from "./mrr-day-facts-clients.js";

const ORIGINAL_FETCH = globalThis.fetch;

function mockJson(body: unknown, status = 200) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

beforeEach(() => {
  process.env.BILLING_SERVICE_URL = "http://billing";
  process.env.BILLING_SERVICE_API_KEY = "k";
  process.env.CAMPAIGN_SERVICE_URL = "http://campaign";
  process.env.CAMPAIGN_SERVICE_API_KEY = "k";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("fetchBrandCurrentDailyBudget", () => {
  it("reads the amount billing holds RIGHT NOW, in USD, on the api-key + org-header contract", async () => {
    const spy = mockJson({ brandId: "b", dailyBudgetCents: "1500.0000000000", updatedAt: "2026-08-05T13:31:32.764Z" });
    // Shaped like prod brand `b97440f6…`, whose live $15/day the change log still reports as $1.
    expect(await fetchBrandCurrentDailyBudget("b", "o")).toBe(15);

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://billing/internal/brands/b/daily-budget");
    expect((init.headers as Record<string, string>)["x-org-id"]).toBe("o");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });

  it("returns NULL when billing holds no amount — absent is not a zero", async () => {
    mockJson({ brandId: "b", dailyBudgetCents: null, updatedAt: null });
    expect(await fetchBrandCurrentDailyBudget("b", "o")).toBeNull();
  });

  it("keeps a RECORDED zero as 0 — a brand deliberately defunded is a different fact", async () => {
    mockJson({ brandId: "b", dailyBudgetCents: "0", updatedAt: "2026-08-05T13:31:32.764Z" });
    expect(await fetchBrandCurrentDailyBudget("b", "o")).toBe(0);
  });

  it("fails LOUD on a non-OK response rather than reading it as no budget", async () => {
    mockJson({ error: "nope" }, 500);
    await expect(fetchBrandCurrentDailyBudget("b", "o")).rejects.toThrow(/daily-budget failed \(500\)/);
  });
});

describe("fetchBrandBudgetByDay", () => {
  it("keeps a recorded amount and DROPS a not_recorded day — absent is not zero", async () => {
    mockJson({
      brandId: "b",
      orgId: "o",
      grain: "brand",
      recordBeginsAt: "2026-09-11T15:46:15.136Z",
      days: [
        { date: "2026-09-10", state: "not_recorded", dailyBudgetCents: null, inForceSince: null },
        { date: "2026-09-11", state: "recorded", dailyBudgetCents: "4900.0000000000", inForceSince: "2026-09-11T15:46:15.136Z" },
        { date: "2026-09-12", state: "recorded", dailyBudgetCents: 0, inForceSince: "2026-09-11T15:46:15.136Z" },
      ],
    });

    const out = await fetchBrandBudgetByDay("b", "o", "2026-09-10", "2026-09-12");
    expect(out.recordBeginsAt).toBe("2026-09-11T15:46:15.136Z");
    expect(out.byDay.has("2026-09-10")).toBe(false); // unrecorded: no amount asserted
    expect(out.byDay.get("2026-09-11")).toBe(49);
    expect(out.byDay.get("2026-09-12")).toBe(0); // a recorded ZERO is a real answer and is kept
  });

  it("sends the org header and the range, and fails loud on a non-OK", async () => {
    const spy = mockJson({ days: [] });
    await fetchBrandBudgetByDay("b", "o", "2026-09-01", "2026-09-12");
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/internal/brands/b/daily-budget/by-day?from=2026-09-01&to=2026-09-12");
    expect((init.headers as Record<string, string>)["x-org-id"]).toBe("o");

    mockJson({ error: "nope" }, 500);
    await expect(fetchBrandBudgetByDay("b", "o", "a", "b")).rejects.toThrow(/daily-budget\/by-day failed \(500\)/);
  });
});

describe("fetchPaymentStoppedPeriods", () => {
  it("reads the record start and both closed and open periods, as UTC days", async () => {
    mockJson({
      orgId: "o",
      recordBeginsAt: "2026-06-12T13:06:55.880Z",
      periods: [
        { startedAt: "2026-07-01T10:00:00.000Z", endedAt: "2026-07-05T10:00:00.000Z" },
        { startedAt: "2026-08-01T10:00:00.000Z", endedAt: null },
      ],
    });
    const out = await fetchPaymentStoppedPeriods("o");
    expect(out.recordBeginsOn).toBe("2026-06-12");
    expect(out.periods).toEqual([
      { startedOn: "2026-07-01", endedOn: "2026-07-05" },
      { startedOn: "2026-08-01", endedOn: null },
    ]);
  });

  it("keeps a NULL record start distinct from an empty period list", async () => {
    mockJson({ orgId: "o", recordBeginsAt: null, periods: [] });
    const out = await fetchPaymentStoppedPeriods("o");
    expect(out.recordBeginsOn).toBeNull(); // nothing recorded — NOT evidence that payment was on
    expect(out.periods).toEqual([]);
  });

  it("sends the api-key only, with the org in the PATH — no x-org-id, no sentinel identity", async () => {
    const spy = mockJson({ recordBeginsAt: null, periods: [] });
    await fetchPaymentStoppedPeriods("org-1");
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/internal/accounts/by-org/org-1/payment-stopped-periods");
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(["x-api-key"]);
  });
});

describe("fetchFleetCampaigns", () => {
  it("prefers brandIds[0], falls back to brandId, and keeps a row that names neither", async () => {
    mockJson({
      campaigns: [
        { id: "c1", orgId: "o1", brandIds: ["b1"], brandId: null },
        { id: "c2", orgId: "o1", brandIds: null, brandId: "b2" },
        { id: "c3", orgId: "o2", brandIds: null, brandId: null },
        { id: "c4" }, // malformed row, skipped rather than throwing the fleet read
      ],
    });
    expect(await fetchFleetCampaigns()).toEqual([
      { campaignId: "c1", orgId: "o1", brandId: "b1" },
      { campaignId: "c2", orgId: "o1", brandId: "b2" },
      { campaignId: "c3", orgId: "o2", brandId: null },
    ]);
  });
});

describe("fetchCampaignEarningOnDay", () => {
  it("asks for ONE day and preserves each axis, including not_recorded", async () => {
    const spy = mockJson({
      campaigns: [
        {
          campaignId: "c1",
          statusRecordedSince: "2026-09-12T08:36:00.735Z",
          audienceRecordedSince: null,
          days: [{ day: "2026-09-13", status: "stopped", audience: "not_recorded", earning: null, unknownReason: "audience_not_recorded" }],
        },
        {
          campaignId: "c2",
          statusRecordedSince: "2026-09-12T08:36:00.735Z",
          audienceRecordedSince: "2026-09-13T00:00:00.000Z",
          days: [{ day: "2026-09-13", status: "ongoing", audience: "available", earning: true }],
        },
      ],
    });

    const out = await fetchCampaignEarningOnDay(["c1", "c2"], "2026-09-13");
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ campaignIds: ["c1", "c2"], from: "2026-09-13", to: "2026-09-13" });
    expect(out[0]).toMatchObject({ campaignId: "c1", status: "stopped", audience: "not_recorded", earning: null, audienceRecordedSince: null });
    expect(out[1]).toMatchObject({ campaignId: "c2", status: "ongoing", audience: "available", earning: true });
  });

  it("spends nothing on an empty list, and refuses a batch over the producer's cap", async () => {
    const spy = mockJson({ campaigns: [] });
    expect(await fetchCampaignEarningOnDay([], "2026-09-13")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    await expect(
      fetchCampaignEarningOnDay(Array.from({ length: EARNING_BATCH_SIZE + 1 }, (_, i) => `c${i}`), "2026-09-13"),
    ).rejects.toThrow(/exceeds the producer cap/);
  });

  it("reads an unrecognised status or audience word as not_recorded rather than trusting it", async () => {
    mockJson({
      campaigns: [{ campaignId: "c1", statusRecordedSince: null, audienceRecordedSince: null, days: [{ day: "2026-09-13", status: "weird", audience: "odd", earning: null }] }],
    });
    const out = await fetchCampaignEarningOnDay(["c1"], "2026-09-13");
    expect(out[0].status).toBe("not_recorded");
    expect(out[0].audience).toBe("not_recorded");
  });
});
