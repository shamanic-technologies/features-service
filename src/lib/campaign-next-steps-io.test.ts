import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const fetchWithRetry = vi.fn();
vi.mock("./fetch-retry.js", () => ({ fetchWithRetry: (...a: unknown[]) => fetchWithRetry(...a) }));

import { fetchReplyLatencyByCampaignGroups } from "./campaign-next-steps-io.js";

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
