/**
 * CAMPAIGN-NEXT-STEPS-1018: one campaign's next steps, each fact from its owner, each failing soft to a named null.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const fetchSalesFunnelCampaigns = vi.fn();
vi.mock("../lib/sales-funnel-campaigns-client.js", () => ({ fetchSalesFunnelCampaigns: (...a: unknown[]) => fetchSalesFunnelCampaigns(...a) }));
vi.mock("../lib/brand-ownership.js", () => ({
  assertBrandHeld: vi.fn(async () => undefined),
  BrandOwnershipError: class BrandOwnershipError extends Error {},
}));
const fetchEmailSendQueue = vi.fn();
const fetchReplyLatencyByCampaignGroups = vi.fn();
vi.mock("../lib/campaign-next-steps-io.js", () => ({
  fetchEmailSendQueue: (...a: unknown[]) => fetchEmailSendQueue(...a),
  fetchReplyLatencyByCampaignGroups: (...a: unknown[]) => fetchReplyLatencyByCampaignGroups(...a),
}));
const readPipeFleetReplyLatency = vi.fn();
vi.mock("./public.js", () => ({ readPipeFleetReplyLatency: (...a: unknown[]) => readPipeFleetReplyLatency(...a) }));
vi.mock("../middleware/auth.js", () => ({
  apiKeyAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.orgId = "org-1";
    req.userId = "user-1";
    req.runId = "run-1";
    next();
  },
}));

import router from "./campaign-next-steps.js";

const DAY = 86_400_000;
const ROW = {
  id: "sfc-1",
  brandId: "brand-1",
  offerId: "offer-1",
  salesFunnelId: "f",
  salesFunnelName: "Cold Follow-up Replies 5",
  status: "ongoing",
  stopReason: null,
  createdAt: "2026-10-16T00:00:00.000Z",
  units: [
    { campaignId: "u-src", pipeId: "p1", featureSlug: "lead-sourcing", legKey: "start_to_lead_found", status: "ongoing" },
    { campaignId: "u-mail", pipeId: "p2", featureSlug: "ai-follow-up-email", legKey: "lead_found_to_conversation", status: "ongoing" },
    { campaignId: "u-close", pipeId: "p3", featureSlug: "your-team-reply-closing", legKey: "conversation_to_paid_client", status: "ongoing" },
  ],
};
const QUEUE = {
  asOf: "2026-10-18T20:00:00.000Z",
  leadsAwaitingFirstEmail: 12,
  leadsWithFollowUpQueued: 0,
  queuedEmails: 12,
  firstEmailsFrom: "2026-10-19T05:00:00.000Z",
  sendWindow: { weekdays: ["monday"], startHour: 7, endHour: 19, timezoneRule: "lead_local" },
  timezones: [],
};

function app() {
  const a = express();
  a.use(router);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchSalesFunnelCampaigns.mockResolvedValue([ROW]);
  fetchEmailSendQueue.mockResolvedValue(QUEUE);
  fetchReplyLatencyByCampaignGroups.mockResolvedValue({ campaign: { sampleSize: 1, medianMs: 2 * DAY, averageMs: 2 * DAY } });
  readPipeFleetReplyLatency.mockResolvedValue({ sampleSize: 59, medianMs: 5.3 * DAY, averageMs: 19.5 * DAY });
});

describe("GET /brands/:brandId/sales-funnel-campaigns/:id/next-steps", () => {
  it("serves the queue over every pipe and the reply delay on the reply pipes only", async () => {
    const res = await request(app()).get("/brands/brand-1/sales-funnel-campaigns/sfc-1/next-steps");
    expect(res.status).toBe(200);
    expect(fetchEmailSendQueue).toHaveBeenCalledWith("org-1", ["u-src", "u-mail", "u-close"]);
    expect(fetchReplyLatencyByCampaignGroups).toHaveBeenCalledWith({ campaign: ["u-mail"] });
    expect(readPipeFleetReplyLatency).toHaveBeenCalledWith([{ featureSlug: "ai-follow-up-email", legKey: expect.stringMatching(/_to_conversation$/) }]);
    expect(res.body.emailSendQueue).toMatchObject({ leadsAwaitingFirstEmail: 12, firstEmailsFrom: "2026-10-19T05:00:00.000Z" });
    expect(res.body.timeToFirstPositiveReply).toMatchObject({ basis: "pipe_fleet", medianDays: 5.3, learning: false });
    expect(res.body.pipes.map((p: { endsOnPositiveReply: boolean }) => p.endsOnPositiveReply)).toEqual([false, true, false]);
    expect(res.body.requestedPipeCampaignId).toBeNull();
  });

  it("a pipe id answers for its campaign", async () => {
    const res = await request(app()).get("/brands/brand-1/sales-funnel-campaigns/u-mail/next-steps");
    expect(res.status).toBe(200);
    expect(res.body.salesFunnelCampaignId).toBe("sfc-1");
    expect(res.body.requestedPipeCampaignId).toBe("u-mail");
  });

  it("an unreadable sender nulls the queue only, named", async () => {
    fetchEmailSendQueue.mockRejectedValue(new Error("down"));
    const res = await request(app()).get("/brands/brand-1/sales-funnel-campaigns/sfc-1/next-steps");
    expect(res.status).toBe(200);
    expect(res.body.emailSendQueue).toBeNull();
    expect(res.body.emailSendQueueUnavailableReason).toBe("sender_unreadable");
    expect(res.body.timeToFirstPositiveReply.medianDays).toBe(5.3);
  });

  it("an unreadable latency nulls the delay only, named", async () => {
    readPipeFleetReplyLatency.mockRejectedValue(new Error("down"));
    const res = await request(app()).get("/brands/brand-1/sales-funnel-campaigns/sfc-1/next-steps");
    expect(res.status).toBe(200);
    expect(res.body.timeToFirstPositiveReply).toMatchObject({ medianDays: null, unavailableReason: "reply_latency_unreadable" });
    expect(res.body.emailSendQueue.leadsAwaitingFirstEmail).toBe(12);
  });

  it("404 on an unknown campaign, 502 when campaign-service fails", async () => {
    expect((await request(app()).get("/brands/brand-1/sales-funnel-campaigns/nope/next-steps")).status).toBe(404);
    fetchSalesFunnelCampaigns.mockRejectedValue(new Error("down"));
    expect((await request(app()).get("/brands/brand-1/sales-funnel-campaigns/sfc-1/next-steps")).status).toBe(502);
  });
});
