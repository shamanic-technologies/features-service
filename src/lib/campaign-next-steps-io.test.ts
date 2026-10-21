import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const fetchWithRetry = vi.fn();
vi.mock("./fetch-retry.js", () => ({ fetchWithRetry: (...a: unknown[]) => fetchWithRetry(...a) }));

import { fetchReplyDelayDistribution, fetchReplyLatencyByCampaignGroups } from "./campaign-next-steps-io.js";

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

describe("fetchReplyLatencyByCampaignGroups (REPLY-LATENCY-ALL-CHANNELS-1019)", () => {
  beforeEach(() => {
    process.env.LEAD_SERVICE_URL = "http://lead";
    process.env.LEAD_SERVICE_API_KEY = "k";
    fetchWithRetry.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("asks lead-service (every channel), never the email sender, and keys each group", async () => {
    fetchWithRetry.mockResolvedValue(
      json({
        basis: "first_message_sent_to_first_positive_reply_since_inception",
        groups: [
          { key: "campaign", campaignIds: ["a"], timeToFirstPositiveReply: { sampleSize: 0, medianMs: null, averageMs: null } },
          { key: "fleet", campaignIds: ["a", "b"], timeToFirstPositiveReply: { sampleSize: 43, medianMs: 173_880_000, averageMs: 380_160_000 } },
        ],
      }),
    );
    const out = await fetchReplyLatencyByCampaignGroups({ campaign: ["a"], fleet: ["a", "b"], empty: [] });
    const [url, init] = fetchWithRetry.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://lead/internal/reply-latency/grouped");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ groups: { campaign: { campaignIds: ["a"] }, fleet: { campaignIds: ["a", "b"] } } });
    expect(out).toEqual({
      campaign: { sampleSize: 0, medianMs: null, averageMs: null },
      fleet: { sampleSize: 43, medianMs: 173_880_000, averageMs: 380_160_000 },
    });
  });

  it("makes no call when every group is empty", async () => {
    expect(await fetchReplyLatencyByCampaignGroups({ campaign: [] })).toEqual({});
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it("fails loud on a refused read (never a zero)", async () => {
    fetchWithRetry.mockResolvedValue(json({ error: "boom" }, 500));
    await expect(fetchReplyLatencyByCampaignGroups({ campaign: ["a"] })).rejects.toThrow(/reply-latency\/grouped failed \(500\)/);
  });

  it("fails loud on a metric without a sample size", async () => {
    fetchWithRetry.mockResolvedValue(json({ groups: [{ key: "campaign", timeToFirstPositiveReply: { medianMs: 1 } }] }));
    await expect(fetchReplyLatencyByCampaignGroups({ campaign: ["a"] })).rejects.toThrow(/sampleSize/);
  });
});

describe("fetchReplyDelayDistribution (TTFPR-RESEARCH-STUDY-1021)", () => {
  beforeEach(() => {
    process.env.LEAD_SERVICE_URL = "http://lead";
    process.env.LEAD_SERVICE_API_KEY = "k";
    fetchWithRetry.mockReset();
  });
  const H = 3_600_000;
  const metric = {
    sampleSize: 3,
    medianMs: 2 * H,
    averageMs: 3 * H,
    percentilesMs: { p10: H, p25: 1.5 * H, p50: 2 * H, p75: 4 * H, p90: 5 * H },
    distribution: [
      { key: "lt_1h", label: "Under 1 hour", fromMs: 0, toMs: H, count: 0, cumulativeCount: 0 },
      { key: "1h_3h", label: "1 to 3 hours", fromMs: H, toMs: 3 * H, count: 2, cumulativeCount: 2 },
      { key: "3h_6h", label: "3 to 6 hours", fromMs: 3 * H, toMs: null, count: 1, cumulativeCount: 3 },
    ],
  };

  it("reads lead-service's percentiles and buckets by its own names, as ONE fleet group", async () => {
    fetchWithRetry.mockResolvedValue(json({ groups: [{ key: "fleet", campaignIds: ["a", "b"], timeToFirstPositiveReply: metric }] }));
    expect(await fetchReplyDelayDistribution(["a", "b"])).toEqual(metric);
    const [, init] = fetchWithRetry.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ groups: { fleet: { campaignIds: ["a", "b"] } } });
  });

  it("fails loud on a lead-service without the distribution fields", async () => {
    fetchWithRetry.mockResolvedValue(json({ groups: [{ key: "fleet", campaignIds: ["a"], timeToFirstPositiveReply: { sampleSize: 3, medianMs: 1, averageMs: 1 } }] }));
    await expect(fetchReplyDelayDistribution(["a"])).rejects.toThrow(/percentilesMs missing/);
  });

  it("fails loud on buckets that do not add up to the sample", async () => {
    fetchWithRetry.mockResolvedValue(json({ groups: [{ key: "fleet", campaignIds: ["a"], timeToFirstPositiveReply: { ...metric, sampleSize: 4 } }] }));
    await expect(fetchReplyDelayDistribution(["a"])).rejects.toThrow(/sum to 3/);
  });

  it("refuses more ids than lead-service's per-group cap (percentiles cannot be split)", async () => {
    await expect(fetchReplyDelayDistribution(Array.from({ length: 501 }, (_, i) => `c${i}`))).rejects.toThrow(/500/);
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });
});
