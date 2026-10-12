/**
 * ONE FUNNEL CAMPAIGN'S FUNNEL AND PIPES (owner 2026-10-11): steps in people with rates, a takeover pipe's daily work,
 * a call pipe's calls. Producers mocked at their clients.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const fetchSalesFunnelCampaigns = vi.fn();
vi.mock("../lib/sales-funnel-campaigns-client.js", () => ({ fetchSalesFunnelCampaigns: (...a: unknown[]) => fetchSalesFunnelCampaigns(...a) }));
const PROACTIVE = "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked+meeting_booked_to_paid_client";
const REACTIVE = "conversation_to_booking_call@ai-instant-call+booking_call_to_meeting_booked";
const LEADS_ONLY = "start_to_lead_found@sourcing-apollo-cold-filters+lead_found_to_paid_client";
const step = (key: string, label: string) => ({ kind: "step", key, label });
vi.mock("./agent-catalogue.js", () => ({
  funnelCopiesFor: vi.fn(async () => ({
    copies: new Map<string, unknown>([
      [PROACTIVE, { firstStep: null, path: { items: [step("start", "Start"), { kind: "channel" }, step("lead_found", "Lead found"), step("conversation", "Positive reply"), step("meeting_booked", "Meeting booked"), step("paid_client", "Paid client")], legs: [] } }],
      [LEADS_ONLY, { firstStep: null, path: { items: [step("start", "Start"), { kind: "channel" }, step("lead_found", "Lead found"), { kind: "channel" }, step("paid_client", "Paid client")], legs: [] } }],
      [REACTIVE, { firstStep: "conversation", path: { items: [step("conversation", "Positive reply"), step("booking_call", "Booking call"), step("meeting_booked", "Meeting booked")], legs: [] } }],
    ]),
    pipeSteps: new Map([
      ["sales-cold-email-outreach|lead_found_to_conversation", { fromStep: "lead_found", toStep: "conversation" }],
      ["sourcing-apollo-cold-filters|start_to_lead_found", { fromStep: null, toStep: "lead_found" }],
      ["ai-meeting-booking|conversation_to_meeting_booked", { fromStep: "conversation", toStep: "meeting_booked" }],
      ["ai-instant-call|conversation_to_booking_call", { fromStep: "conversation", toStep: "booking_call" }],
      ["your-team-closing-calls|lead_found_to_paid_client", { fromStep: "lead_found", toStep: "paid_client" }],
    ]),
    pathOf: () => null,
  })),
}));
vi.mock("../lib/brand-ownership.js", () => ({ assertBrandHeld: vi.fn(async () => {}), BrandOwnershipError: class extends Error {} }));
vi.mock("../lib/view-cache.js", () => ({ servedCached: async (a: { compute: () => unknown }) => a.compute(), buildScopeKey: () => "k" }));
const fetchLeadBucketCounts = vi.fn();
vi.mock("../lib/lead-bucket-counts-client.js", () => ({ fetchLeadBucketCounts: (...a: unknown[]) => fetchLeadBucketCounts(...a) }));
const fetchFollowupActionRows = vi.fn();
vi.mock("../lib/followup-actions-client.js", () => ({ fetchFollowupActionRows: (...a: unknown[]) => fetchFollowupActionRows(...a) }));
const fetchStepOutcomes = vi.fn();
vi.mock("../lib/step-outcomes-client.js", () => ({ fetchStepOutcomes: (...a: unknown[]) => fetchStepOutcomes(...a) }));
const fetchCampaignCalls = vi.fn();
vi.mock("../lib/campaign-calls-client.js", () => ({ fetchCampaignCalls: (...a: unknown[]) => fetchCampaignCalls(...a) }));
const fetchLeadsFound = vi.fn();
vi.mock("../lib/on-demand-pipe-fleet.js", () => ({ fetchLeadsFound: (...a: unknown[]) => fetchLeadsFound(...a) }));
const fetchRunsCostCents = vi.fn();
vi.mock("../lib/runs-cost-client.js", () => ({ fetchRunsCostCents: (...a: unknown[]) => fetchRunsCostCents(...a) }));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
const router = (await import("./sales-funnel-campaign-activity.js")).default;
const app = express().use(router);
const AUTH = { "x-api-key": "test-key", "x-org-id": "0e9a0000-0000-4000-8000-000000000001", "x-user-id": "05e40000-0000-4000-8000-000000000001", "x-run-id": "07a00000-0000-4000-8000-000000000001" };

const unit = (campaignId: string, featureSlug: string, legKey: string) => ({ campaignId, pipeId: `${featureSlug}|${legKey}`, featureSlug, legKey, status: "ongoing" });
const FC = (id: string, salesFunnelId: string, units: unknown[]) => ({ id, brandId: "b1", offerId: "of1", salesFunnelId, salesFunnelName: "Bliss", status: "ongoing", stopReason: null, createdAt: "2026-10-10T00:00:00Z", units });

beforeEach(() => {
  for (const m of [fetchSalesFunnelCampaigns, fetchLeadBucketCounts, fetchFollowupActionRows, fetchStepOutcomes, fetchCampaignCalls, fetchRunsCostCents, fetchLeadsFound]) m.mockReset();
  fetchLeadsFound.mockResolvedValue({ recordedSince: null, counts: [] });
});

describe("GET /brands/:brandId/sales-funnel-campaigns/:id/activity", () => {
  it("proactive: Lead found = what its source found (per source campaign), later steps off the outreach unit's counts, rates served", async () => {
    fetchSalesFunnelCampaigns.mockResolvedValue([FC("fc1", PROACTIVE, [unit("src", "sourcing-apollo-cold-filters", "start_to_lead_found"), unit("ce", "sales-cold-email-outreach", "lead_found_to_conversation")])]);
    // The source found 230 (lead-service leads-found, its own campaign); the outreach unit holds the 226 it was handed.
    fetchLeadsFound.mockResolvedValue({ recordedSince: null, counts: [{ campaignId: "src", ran: 230 }, { campaignId: "other-funnel-src", ran: 999 }] });
    fetchLeadBucketCounts.mockResolvedValue({ total: 226, counts: { contacted: 223, positive_reply: 2, meeting_booked: 1, sale: 0 }, people: { sent: 182, delivered: 180, interested: 1 } });

    const res = await request(app).get("/brands/b1/sales-funnel-campaigns/fc1/activity").set(AUTH);
    expect(res.status).toBe(200);
    // Never the source's bucket-counts: lead-service resolves it to its identity (a sibling funnel's source on the brand).
    expect(fetchLeadBucketCounts.mock.calls.map((c) => c[0])).toEqual(["ce"]);
    expect(res.body.funnel.mode).toBe("proactive");
    expect(res.body.funnel.steps.map((s: { key: string; people: number }) => [s.key, s.people])).toEqual([
      ["lead_found", 230], ["contacted", 223], ["delivered", 180], ["conversation", 2], ["meeting_booked", 1], ["paid_client", 0],
    ]);
    expect(res.body.funnel.steps[1].rateToNextPct).toBe(80.72);
    const ce = res.body.pipes.find((p: { campaignId: string }) => p.campaignId === "ce");
    expect(ce).toMatchObject({ kind: "outreach", people: { found: 226, contacted: 223, sent: 182, delivered: 180, reachedToStep: 2 }, dailySource: "campaign_revenue", calls: null, callsUnavailableReason: "pipe_places_no_calls" });
    expect(res.body.pipes.find((p: { campaignId: string }) => p.campaignId === "src")).toMatchObject({ kind: "sourcing", people: null, work: null });
    expect(fetchFollowupActionRows).not.toHaveBeenCalled();
  });

  it("a leads-only funnel (Start -> Lead found -> your team): Lead found = the leads its source found, nobody contacted", async () => {
    fetchSalesFunnelCampaigns.mockResolvedValue([FC("fc3", LEADS_ONLY, [unit("team", "your-team-closing-calls", "lead_found_to_paid_client"), unit("src", "sourcing-apollo-cold-filters", "start_to_lead_found")])]);
    fetchLeadsFound.mockResolvedValue({ recordedSince: null, counts: [{ campaignId: "src", ran: 30 }] });
    // The team's unit works Lead found onward: lead-service holds nobody under it yet.
    fetchLeadBucketCounts.mockResolvedValue({ total: 0, counts: { contacted: 0, positive_reply: 0, sale: 0 }, people: { sent: 0, delivered: 0, interested: 0 } });

    const res = await request(app).get("/brands/b1/sales-funnel-campaigns/fc3/activity").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.funnelUnavailableReason).toBeNull();
    expect(fetchLeadBucketCounts.mock.calls.map((c) => c[0])).toEqual(["team"]);
    expect(res.body.funnel.steps.map((s: { key: string; people: number | null }) => [s.key, s.people])).toEqual([["lead_found", 30], ["contacted", 0], ["delivered", 0], ["paid_client", 0]]);
  });

  it("a stopped funnel whose source found nothing reads 0, never a sibling funnel's source", async () => {
    fetchSalesFunnelCampaigns.mockResolvedValue([FC("perky", PROACTIVE, [unit("src-old", "sourcing-apollo-cold-filters", "start_to_lead_found"), unit("ce", "sales-cold-email-outreach", "lead_found_to_conversation")])]);
    fetchLeadsFound.mockResolvedValue({ recordedSince: null, counts: [{ campaignId: "src-smiling", ran: 30 }] });
    fetchLeadBucketCounts.mockResolvedValue({ total: 0, counts: { contacted: 0, positive_reply: 0, meeting_booked: 0, sale: 0 }, people: { sent: 0, delivered: 0, interested: 0 } });

    const res = await request(app).get("/brands/b1/sales-funnel-campaigns/perky/activity").set(AUTH);
    expect(res.body.funnel.steps[0]).toMatchObject({ key: "lead_found", people: 0 });
  });

  it("reactive call funnel: handed people, the calls placed as the act, a booked meeting among them; the call pipe serves its calls", async () => {
    fetchSalesFunnelCampaigns.mockResolvedValue([FC("fc2", REACTIVE, [unit("call", "ai-instant-call", "conversation_to_booking_call")])]);
    fetchFollowupActionRows.mockResolvedValue([
      { actingCampaignId: "call", leadId: "a", firstClaimedAt: "2026-10-07T10:00:00Z", firstActedAt: "2026-10-07T10:01:00Z", actedCount: 1, claimCount: 1 },
      { actingCampaignId: "call", leadId: "b", firstClaimedAt: "2026-10-08T10:00:00Z", firstActedAt: null, actedCount: 0, claimCount: 1 },
    ]);
    fetchStepOutcomes.mockResolvedValue([{ leadId: "a", occurredAt: "2026-10-09T00:00:00Z" }, { leadId: "zz", occurredAt: null }]);
    const counts = (placed: number, accepted: number, connected: number) => ({ requested: placed, placed, accepted, connected, outcomes: {}, billedMinutes: 1, connectBilledMinutes: 0, totalBilledMinutes: 1 });
    const calls = { totals: counts(4, 2, 1), daily: [{ day: "2026-10-07", ...counts(4, 2, 1) }] };
    fetchCampaignCalls.mockResolvedValue(new Map([["call", calls]]));
    fetchRunsCostCents.mockResolvedValue({ committedCents: 1000, actualCents: 900 });

    const res = await request(app).get("/brands/b1/sales-funnel-campaigns/fc2/activity?pricing=net").set(AUTH);
    expect(res.status).toBe(200);
    expect(fetchStepOutcomes).toHaveBeenCalledWith("b1", "meeting_booked");
    expect(res.body.funnel.steps.map((s: { key: string; people: number; rateToNextPct: number | null }) => [s.key, s.people, s.rateToNextPct])).toEqual([
      ["conversation", 2, 50], ["booking_call", 1, 100], ["meeting_booked", 1, null],
    ]);
    const pipe = res.body.pipes[0];
    expect(pipe).toMatchObject({ kind: "takeover", calls: { ...calls, spend: { committedUsd: 10, costPerPlacedCallUsd: 2.5, costPerConnectedCallUsd: 10 }, spendUnavailableReason: null }, callsUnavailableReason: null, dailySource: null });
    expect(fetchRunsCostCents.mock.calls[0].slice(0, 2)).toEqual(["b1", "call"]);
    expect(fetchRunsCostCents.mock.calls[0][4]).toBe("net");
    expect(res.body.pricing).toBe("net");
    expect(pipe.work).toMatchObject({ handed: 2, actedOn: 1, reached: 1, daily: [{ date: "2026-10-07", handed: 1, actedOn: 1, reached: 1 }, { date: "2026-10-08", handed: 1, actedOn: 0, reached: 0 }] });
  });

  it("an unknown funnel campaign is a 404; a producer failure is a 502 (never a guessed count)", async () => {
    fetchSalesFunnelCampaigns.mockResolvedValue([]);
    expect((await request(app).get("/brands/b1/sales-funnel-campaigns/nope/activity").set(AUTH)).body.reason).toBe("sales_funnel_campaign_not_found");
    fetchSalesFunnelCampaigns.mockResolvedValue([FC("fc1", PROACTIVE, [unit("ce", "sales-cold-email-outreach", "lead_found_to_conversation")])]);
    fetchLeadBucketCounts.mockRejectedValue(new Error("lead-service down"));
    expect((await request(app).get("/brands/b1/sales-funnel-campaigns/fc1/activity").set(AUTH)).status).toBe(502);
  });

  it("twillio-service unreadable leaves the call pipe's calls null with a reason, never a 502 of the funnel", async () => {
    fetchSalesFunnelCampaigns.mockResolvedValue([FC("fc2", REACTIVE, [unit("call", "ai-instant-call", "conversation_to_booking_call")])]);
    fetchFollowupActionRows.mockResolvedValue([]);
    fetchStepOutcomes.mockResolvedValue([]);
    fetchCampaignCalls.mockRejectedValue(new Error("twilio down"));
    fetchRunsCostCents.mockResolvedValue({ committedCents: 0, actualCents: 0 });
    const res = await request(app).get("/brands/b1/sales-funnel-campaigns/fc2/activity").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.pipes[0]).toMatchObject({ calls: null, callsUnavailableReason: "calls_unreadable" });
    expect((await request(app).get("/brands/b1/sales-funnel-campaigns/fc2/activity?pricing=bogus").set(AUTH)).body.reason).toBe("pricing_unrecognised");
  });
});
