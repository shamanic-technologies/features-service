/**
 * THE CAMPAIGNS TABLE READ (owner 2026-10-11): one row per sales funnel campaign, its copy served, its money
 * computed ONCE over its units together (never a sum of unit ROIs), invested = the units' committed spend.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// This suite pins the engine's IN-PROCESS figures (pipeline, the ROI pair): the cut each route applies
// before serving is `lib/retired-returns.test.ts`'s subject (ROI-CONSISTENCY-1103), so it is identity here.
vi.mock("../lib/retired-returns.js", () => ({
  servedRevenueBody: <T,>(b: T) => b,
  servedCostEconomics: <T,>(c: T) => c,
  servedHeadline: <T,>(h: T) => h,
}));

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const computeFeatureRevenue = vi.fn();
vi.mock("./revenue.js", () => ({
  computeFeatureRevenue: (...a: unknown[]) => computeFeatureRevenue(...a),
  fetchDeclaredFunnelsSoft: vi.fn(async () => []),
  priceOnDeclaredFunnel: vi.fn(() => ({ economics: null, pricedFunnelKeys: [] })),
  pricedFingerprint: vi.fn(() => "fp"),
}));
const distinctChannelFunnels = vi.fn();
vi.mock("./offer-economics.js", () => ({ distinctChannelFunnels: (...a: unknown[]) => distinctChannelFunnels(...a) }));
const REACTIVE = "conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended";
vi.mock("./agent-catalogue.js", () => ({
  funnelCopiesFor: vi.fn(async (ids: string[]) => ({
    copies: new Map(
      ids.map((id) => [
        id,
        id === "unknown"
          ? null
          : id === REACTIVE
            ? { name: "Motivate", face: "/f", type: "reactive", triggerLabel: "Positive replies", shortDescription: "We book meetings with buyers who reply with interest.", shortDescriptionUnavailableReason: null, firstStep: "conversation", path: { items: [], legs: [] } }
            : { name: "Bliss", face: "/f", type: "proactive", triggerLabel: null, shortDescription: "We email new buyers until they reply with interest.", shortDescriptionUnavailableReason: null, firstStep: "lead_found", path: { items: [{ kind: "step", key: "lead_found", label: "Lead found" }], legs: [] } },
      ]),
    ),
    pipeSteps: new Map([
      ["sales-cold-email-outreach|lead_found_to_conversation", { fromStep: "lead_found", toStep: "conversation" }],
      ["sourcing-apollo-cold-filters|start_to_lead_found", { fromStep: null, toStep: "lead_found" }],
      ["ai-meeting-booking|conversation_to_meeting_booked", { fromStep: "conversation", toStep: "meeting_booked" }],
    ]),
    // The campaign's path is its funnel's (one channel per leg, owner 2026-10-11): asked by funnel id only.
    pathOf: (id: string, ...extra: unknown[]) =>
      id === "unknown" || extra.length > 0
        ? null
        : {
            items: [
              { kind: "step", key: "start", label: "Start" },
              { kind: "channel", slug: `of:${id}`, name: "Lead Sourcing", runByUs: true, pipeId: "sourcing-apollo-cold-filters|start_to_lead_found" },
              { kind: "step", key: "lead_found", label: "Lead found" },
              { kind: "channel", slug: "sales-cold-email-outreach", name: "Sales Cold Email Outreach", runByUs: true, pipeId: "sales-cold-email-outreach|lead_found_to_conversation" },
              { kind: "step", key: "conversation", label: "Positive reply" },
              { kind: "channel", slug: "ai-meeting-booking", name: "AI Meeting Booking", runByUs: true, pipeId: "ai-meeting-booking|conversation_to_meeting_booked" },
            ],
            legs: [],
          },
    // A unit off the path (CAMPAIGN-PATH-SHOWS-AI-ANSWER-1109): the catalogue knows ai-follow-up-email and lead_event only.
    unitPipeIdOf: (u: { featureSlug: string; legKey: string }) => (u.featureSlug === "not-in-catalogue" ? null : `${u.featureSlug}|${u.legKey}`),
    partOf: (u: { featureSlug: string; legKey: string }, triggerId: string | null) =>
      u.featureSlug !== "ai-follow-up-email" || (triggerId !== null && triggerId !== "lead_event")
        ? null
        : {
            pipeId: `${u.featureSlug}|${u.legKey}`,
            trigger: triggerId ? { slug: "lead_event", name: "Lead event" } : null,
            items: [
              triggerId ? { kind: "trigger", slug: "lead_event", name: "Lead event" } : { kind: "step", key: "start", label: "Start" },
              { kind: "channel", slug: "ai-follow-up-email", name: "AI Follow-up Email", runByUs: true, pipeId: `${u.featureSlug}|${u.legKey}` },
              { kind: "step", key: "paid_client", label: "Paid client" },
            ],
            shortDescription: "Our AI emails leads the moment they act until they buy.",
            shortDescriptionUnavailableReason: null,
          },
  })),
}));
const funnelCampaignActivity = vi.fn();
vi.mock("./sales-funnel-campaign-activity.js", () => ({ funnelCampaignActivity: (...a: unknown[]) => funnelCampaignActivity(...a) }));
const computeTakeoverReturn = vi.fn();
vi.mock("../lib/value-added-io.js", () => ({ computeTakeoverReturn: (...a: unknown[]) => computeTakeoverReturn(...a) }));
vi.mock("../lib/brand-ownership.js", () => ({ assertBrandHeld: vi.fn(async () => {}), BrandOwnershipError: class extends Error {} }));
const fetchWithRetry = vi.fn();
vi.mock("../lib/fetch-retry.js", () => ({ fetchWithRetry: (...a: unknown[]) => fetchWithRetry(...a) }));
const warmFunnelCampaignReads = vi.fn(async () => ({ urls: [], skippedReason: null }));
vi.mock("../lib/funnel-campaign-warm.js", () => ({ warmFunnelCampaignReads: (...a: unknown[]) => warmFunnelCampaignReads(...(a as [])) }));
const servedCachedArgs: Array<{ view: string; responseShape?: string }> = [];
vi.mock("../lib/view-cache.js", () => ({
  servedCached: async (a: { view: string; responseShape?: string; compute: () => unknown }) => {
    servedCachedArgs.push(a);
    return a.compute();
  },
  buildScopeKey: () => "k",
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";

const router = (await import("./sales-funnel-campaigns.js")).default;
const app = express().use(router);
const AUTH = { "x-api-key": "test-key", "x-org-id": "0e9a0000-0000-4000-8000-000000000001", "x-user-id": "05e40000-0000-4000-8000-000000000001", "x-run-id": "07a00000-0000-4000-8000-000000000001" };

const unit = (campaignId: string, featureSlug: string, legKey: string) => ({ campaignId, pipeId: `${featureSlug}|${legKey}`, featureSlug, legKey, status: "ongoing", workflowSlug: null, name: campaignId });
const FC = (id: string, salesFunnelId: string, units: unknown[]) => ({
  id, orgId: "o", brandId: "b1", offerId: "of1", salesFunnelId, salesFunnelName: "Bliss", status: "ongoing", stopReason: null, createdByUserId: null, createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z", units,
});

beforeEach(() => {
  computeTakeoverReturn.mockReset();
  computeFeatureRevenue.mockReset();
  distinctChannelFunnels.mockReset();
  fetchWithRetry.mockReset();
  funnelCampaignActivity.mockReset();
  warmFunnelCampaignReads.mockClear();
  funnelCampaignActivity.mockResolvedValue({ funnel: null, funnelUnavailableReason: "sales_funnel_not_in_catalogue" });
});

describe("GET /brands/:brandId/sales-funnel-campaigns", () => {
  it("one engine pass over the units together: invested = committed of the units, ROI from the same body, copy served", async () => {
    fetchWithRetry.mockResolvedValue(new Response(JSON.stringify({ salesFunnelCampaigns: [FC("fc1", "f1", [unit("c2", "sales-cold-email-outreach", "lead_found_to_conversation"), unit("c1", "sourcing-apollo-cold-filters", "start_to_lead_found")])] })));
    distinctChannelFunnels.mockReturnValue([{ key: "sales" }]);
    computeFeatureRevenue.mockResolvedValue({ headline: { totalPipelineUsd: 30, unpricedReason: null }, costEconomics: { committedCostUsd: 12.34, roiMultiple: 2.5, unmeasuredReason: null }, maturity: { isMature: false, legs: [] } });

    const res = await request(app).get("/brands/b1/sales-funnel-campaigns?pricing=net").set(AUTH);
    expect(res.status).toBe(200);
    expect(computeFeatureRevenue).toHaveBeenCalledTimes(1);
    const args = computeFeatureRevenue.mock.calls[0];
    expect(args[0]).toEqual(["sales-cold-email-outreach", "sourcing-apollo-cold-filters"]);
    expect(args[2]).toEqual(["c1", "c2"]);
    expect(args[8]).toBe("net");
    expect(args[10]).toBe("of1");
    const row = res.body.salesFunnelCampaigns[0];
    expect(row).toMatchObject({ id: "fc1", name: "Bliss", typeLabel: "Daily", type: "proactive", triggerLabel: null, investedUsd: 12.34, moneyUnavailableReason: null, copyUnavailableReason: null });
    expect(row).not.toHaveProperty("description");
    expect(row.maturity).toEqual({ isMature: false, legs: [] });
    expect(row.headline).toEqual({ totalPipelineUsd: 30, unpricedReason: null });
    expect(row.path.items[0]).toEqual({ kind: "step", key: "start", label: "Start" });
    // The path is the funnel's own (one channel per leg), never re-drawn from the campaign's units.
    expect(row.path.items[1].slug).toBe("of:f1");
    // Every unit is on the path: no other part, the funnel's sentence alone.
    expect(row.otherParts).toEqual([]);
    expect(row.shortDescription).toBe("We email new buyers until they reply with interest.");
    expect(fetchWithRetry.mock.calls[0][0]).toBe("http://campaign:3000/sales-funnel-campaigns?brandId=b1");
  });

  it("every row serves what it produced, step by step (the campaign page's funnel); unreadable = null + reason, money still served", async () => {
    fetchWithRetry.mockResolvedValue(new Response(JSON.stringify({ salesFunnelCampaigns: [FC("fc1", "f1", [unit("c1", "sourcing-apollo-cold-filters", "start_to_lead_found")]), FC("fc2", "f1", [unit("c3", "sourcing-apollo-cold-filters", "start_to_lead_found")])] })));
    distinctChannelFunnels.mockReturnValue([{ key: "sales" }]);
    computeFeatureRevenue.mockResolvedValue({ headline: { totalPipelineUsd: 0, unpricedReason: null }, costEconomics: { committedCostUsd: 2.24, roiMultiple: 0, unmeasuredReason: null }, maturity: { isMature: null, legs: [] } });
    const funnel = { mode: "proactive", steps: [{ key: "lead_found", label: "Lead found", kind: "step", people: 12, rateToNextPct: 0, unmeasuredReason: null }] };
    funnelCampaignActivity.mockImplementation(async (row: { id: string }) => {
      if (row.id === "fc2") throw new Error("lead-service down");
      return { funnel, funnelUnavailableReason: null };
    });

    const res = await request(app).get("/brands/b1/sales-funnel-campaigns?pricing=net").set(AUTH);
    expect(res.status).toBe(200);
    const [a, b] = res.body.salesFunnelCampaigns;
    expect(a).toMatchObject({ funnel, funnelUnavailableReason: null, investedUsd: 2.24 });
    expect(funnelCampaignActivity.mock.calls[0][3]).toBe("net");
    expect(b).toMatchObject({ funnel: null, funnelUnavailableReason: "funnel_steps_unreadable", investedUsd: 2.24 });
  });

  it("the money cell is keyed on THIS route's response shape, so a deploy changing another route keeps it warm (SFC-MONEY-SLOW-1016)", async () => {
    servedCachedArgs.length = 0;
    fetchWithRetry.mockResolvedValue(new Response(JSON.stringify({ salesFunnelCampaigns: [FC("fc1", "f1", [unit("c1", "sourcing-apollo-cold-filters", "start_to_lead_found")])] })));
    distinctChannelFunnels.mockReturnValue([{ key: "sales" }]);
    computeFeatureRevenue.mockResolvedValue({ headline: null, costEconomics: { committedCostUsd: 1, roiMultiple: null, unmeasuredReason: null }, maturity: null });
    await request(app).get("/brands/b1/sales-funnel-campaigns?pricing=net").set(AUTH);
    const { routeResponseShapeFingerprint, responseShapeFingerprint } = await import("../lib/response-shape.js");
    const money = servedCachedArgs.find((a) => a.view === "sales-funnel-campaign-money");
    expect(money?.responseShape).toBe(routeResponseShapeFingerprint("/brands/{brandId}/sales-funnel-campaigns"));
    expect(money?.responseShape).not.toBe(responseShapeFingerprint());
  });

  it("units pricing on two funnel definitions: invested served, ROI null with a reason (never one funnel picked)", async () => {
    fetchWithRetry.mockResolvedValue(new Response(JSON.stringify({ salesFunnelCampaigns: [FC("fc1", "f1", [{ ...unit("c1", "a", "x_to_y"), runsOnTriggerId: null }])] })));
    distinctChannelFunnels.mockReturnValue([{ key: "one" }, { key: "two" }]);
    computeFeatureRevenue.mockResolvedValue({ costEconomics: { committedCostUsd: 3, roiMultiple: null, unmeasuredReason: null }, maturity: null });

    const res = await request(app).get("/brands/b1/sales-funnel-campaigns").set(AUTH);
    expect(computeFeatureRevenue.mock.calls[0][3]).toBeNull();
    expect(res.body.salesFunnelCampaigns[0]).toMatchObject({ investedUsd: 3, moneyUnavailableReason: "units_price_differently" });
  });

  it("a funnel the catalogue does not know: copy null with a reason; offer filter forwarded", async () => {
    fetchWithRetry.mockResolvedValue(new Response(JSON.stringify({ salesFunnelCampaigns: [FC("fc1", "unknown", [])] })));
    distinctChannelFunnels.mockReturnValue([]);
    const res = await request(app).get("/brands/b1/sales-funnel-campaigns?offerId=of1").set(AUTH);
    expect(res.body.offerId).toBe("of1");
    expect(fetchWithRetry.mock.calls[0][0]).toContain("offerId=of1");
    expect(res.body.salesFunnelCampaigns[0]).toMatchObject({ path: null, copyUnavailableReason: "sales_funnel_not_in_catalogue", investedUsd: 0, costEconomics: null });
    expect(computeFeatureRevenue).not.toHaveBeenCalled();
  });

  it("campaign-service unreadable = 502, never a guessed row; bad pricing = 400", async () => {
    fetchWithRetry.mockResolvedValue(new Response("boom", { status: 500 }));
    expect((await request(app).get("/brands/b1/sales-funnel-campaigns").set(AUTH)).status).toBe(502);
    expect((await request(app).get("/brands/b1/sales-funnel-campaigns?pricing=x").set(AUTH)).status).toBe(400);
  });

  it("a campaign that TOOK its people over is credited the value it adds; one that found them keeps the engine's figures", async () => {
    fetchWithRetry.mockResolvedValue(
      new Response(
        JSON.stringify({
          salesFunnelCampaigns: [
            FC("bliss", "lead_found_to_conversation@sales-cold-email-outreach", [unit("c2", "sales-cold-email-outreach", "lead_found_to_conversation"), unit("c1", "sourcing-apollo-cold-filters", "start_to_lead_found")]),
            FC("motivate", REACTIVE, [unit("c3", "ai-meeting-booking", "conversation_to_meeting_booked")]),
          ],
        }),
      ),
    );
    distinctChannelFunnels.mockReturnValue([{ key: "sales" }]);
    computeFeatureRevenue.mockResolvedValue({ headline: { totalPipelineUsd: 30, unpricedReason: null }, costEconomics: { committedCostUsd: 12, roiMultiple: 2.5, unmeasuredReason: null }, maturity: null });
    computeTakeoverReturn.mockResolvedValue({
      headline: { totalPipelineUsd: 500, unpricedReason: null },
      costEconomics: { committedCostUsd: 10, roiMultiple: 50, unmeasuredReason: null },
      maturity: { isMature: false, legs: [] },
      valueAdded: { people: 3, valueNowUsd: 950, valueAtTakeoverUsd: 450, valueAddedUsd: 500, takeoverStep: "conversation" },
    });

    const res = await request(app).get("/brands/b1/sales-funnel-campaigns?pricing=net").set(AUTH);
    const [bliss, motivate] = res.body.salesFunnelCampaigns;
    // Bliss's sourcing unit produces Lead found: it took its people from nothing, the engine's figures stand.
    expect(bliss).toMatchObject({ takeoverStep: null, investedUsd: 12 });
    expect(bliss).not.toHaveProperty("roiMultiple");
    expect(bliss).not.toHaveProperty("valueAdded");
    // Motivate answers Positive replies it did not produce: 2 x ($400 - $150) style value added over its spend.
    expect(motivate).toMatchObject({ takeoverStep: "conversation", investedUsd: 10 });
    expect(motivate).not.toHaveProperty("roiMultiple");
    expect(computeFeatureRevenue).toHaveBeenCalledTimes(1);
    expect(computeTakeoverReturn.mock.calls[0][0]).toMatchObject({ takeoverStep: "conversation", unitCampaignIds: ["c3"], takeoverLeg: { legKey: "conversation_to_meeting_booked", toStep: "meeting_booked" } });
  });
});

describe("every part a campaign runs is in its description (CAMPAIGN-PATH-SHOWS-AI-ANSWER-1109)", () => {
  const AI = { ...unit("c9", "ai-follow-up-email", "start_to_paid_client"), runsOnTriggerId: "lead_event" };
  const COLD = [unit("c1", "sourcing-apollo-cold-filters", "start_to_lead_found"), unit("c2", "sales-cold-email-outreach", "lead_found_to_conversation")];

  it("a unit answering every Lead event beside a cold email path is served as its own part, its sentence joins the description (copy and full rows alike)", async () => {
    fetchWithRetry.mockImplementation(async () => new Response(JSON.stringify({ salesFunnelCampaigns: [FC("fc1", "f1", [...COLD, AI])] })));
    distinctChannelFunnels.mockReturnValue([{ key: "sales" }]);
    computeFeatureRevenue.mockResolvedValue({ headline: null, costEconomics: { committedCostUsd: 1, roiMultiple: null, unmeasuredReason: null }, maturity: null });
    const copy = (await request(app).get("/brands/b1/sales-funnel-campaigns?fields=copy").set(AUTH)).body.salesFunnelCampaigns[0];
    const full = (await request(app).get("/brands/b1/sales-funnel-campaigns?pricing=net").set(AUTH)).body.salesFunnelCampaigns[0];
    for (const row of [copy, full]) {
      expect(row.otherParts).toEqual([
        {
          campaignId: "c9",
          pipeId: "ai-follow-up-email|start_to_paid_client",
          trigger: { slug: "lead_event", name: "Lead event" },
          items: [
            { kind: "trigger", slug: "lead_event", name: "Lead event" },
            { kind: "channel", slug: "ai-follow-up-email", name: "AI Follow-up Email", runByUs: true, pipeId: "ai-follow-up-email|start_to_paid_client" },
            { kind: "step", key: "paid_client", label: "Paid client" },
          ],
          shortDescription: "Our AI emails leads the moment they act until they buy.",
          unavailableReason: null,
        },
      ]);
      expect(row.shortDescription).toBe("We email new buyers until they reply with interest. Our AI emails leads the moment they act until they buy.");
      expect(row.shortDescriptionUnavailableReason).toBeNull();
    }
    // The units listing served the trigger: no per-unit read.
    expect(fetchWithRetry.mock.calls.every((c) => !String(c[0]).includes("/campaigns/c9"))).toBe(true);
  });

  it("a listing that does not serve the unit's trigger reads it off the unit's own campaign; a stopped unit is no part", async () => {
    const { runsOnTriggerId: _t, ...bare } = AI;
    fetchWithRetry.mockImplementation(async (url: string) =>
      url.endsWith("/campaigns/c9")
        ? new Response(JSON.stringify({ campaign: { id: "c9", runsOnTriggerId: "lead_event" } }))
        : new Response(JSON.stringify({ salesFunnelCampaigns: [FC("fc1", "f1", [...COLD, bare, { ...unit("c10", "ai-follow-up-email", "start_to_paid_client"), status: "stopped" }])] })),
    );
    const row = (await request(app).get("/brands/b1/sales-funnel-campaigns?fields=copy").set(AUTH)).body.salesFunnelCampaigns[0];
    expect(row.otherParts.map((p: { campaignId: string; trigger: unknown }) => [p.campaignId, p.trigger])).toEqual([["c9", { slug: "lead_event", name: "Lead event" }]]);
    expect(fetchWithRetry.mock.calls.filter((c) => String(c[0]).endsWith("/campaigns/c9"))).toHaveLength(1);
  });

  it("a unit the catalogue cannot describe is still listed, with its reason, never dropped", async () => {
    fetchWithRetry.mockImplementation(async () => new Response(JSON.stringify({ salesFunnelCampaigns: [FC("fc1", "f1", [...COLD, { ...unit("c11", "not-in-catalogue", "start_to_paid_client"), runsOnTriggerId: null }])] })));
    const row = (await request(app).get("/brands/b1/sales-funnel-campaigns?fields=copy").set(AUTH)).body.salesFunnelCampaigns[0];
    expect(row.otherParts).toEqual([{ campaignId: "c11", pipeId: "not-in-catalogue|start_to_paid_client", trigger: null, items: null, shortDescription: null, unavailableReason: "pipe_not_in_catalogue" }]);
    expect(row.shortDescription).toBe("We email new buyers until they reply with interest.");
  });

  it("an unreadable unit trigger fails the read (502), never reads as proactive", async () => {
    const { runsOnTriggerId: _t, ...bare } = AI;
    fetchWithRetry.mockImplementation(async (url: string) =>
      url.endsWith("/campaigns/c9") ? new Response("down", { status: 503 }) : new Response(JSON.stringify({ salesFunnelCampaigns: [FC("fc1", "f1", [...COLD, bare])] })),
    );
    expect((await request(app).get("/brands/b1/sales-funnel-campaigns?fields=copy").set(AUTH)).status).toBe(502);
  });
});

describe("GET /brands/:brandId/sales-funnel-campaigns?fields=copy (INSTANT-CAMPAIGN-ROWS)", () => {
  it("serves each row's copy, byte-equal to the full row's same fields, with no money read", async () => {
    const rows = [FC("fc1", "f1", [unit("c1", "sourcing-apollo-cold-filters", "start_to_lead_found")]), FC("fc2", REACTIVE, [unit("c2", "ai-meeting-booking", "conversation_to_meeting_booked")]), FC("fc3", "unknown", [])];
    fetchWithRetry.mockImplementation(async () => new Response(JSON.stringify({ salesFunnelCampaigns: rows })));
    distinctChannelFunnels.mockReturnValue([{ key: "sales" }]);
    computeFeatureRevenue.mockResolvedValue({ headline: null, costEconomics: { committedCostUsd: 1, roiMultiple: 1, unmeasuredReason: null }, maturity: null });
    computeTakeoverReturn.mockResolvedValue({ headline: null, costEconomics: { committedCostUsd: 1, roiMultiple: 1, unmeasuredReason: null }, maturity: null, valueAdded: null });

    const lean = await request(app).get("/brands/b1/sales-funnel-campaigns?offerId=of1&fields=copy").set(AUTH);
    expect(lean.status).toBe(200);
    expect(computeFeatureRevenue).not.toHaveBeenCalled();
    expect(computeTakeoverReturn).not.toHaveBeenCalled();
    expect(funnelCampaignActivity).not.toHaveBeenCalled();
    expect(lean.body).toMatchObject({ brandId: "b1", offerId: "of1", fields: "copy" });
    expect(lean.body.salesFunnelCampaigns.map((r: { typeLabel: string | null }) => r.typeLabel)).toEqual(["Daily", "Positive replies", null]);
    expect(lean.body.salesFunnelCampaigns[2]).toMatchObject({ path: null, copyUnavailableReason: "sales_funnel_not_in_catalogue" });
    // One short customer sentence per row (owner 2026-10-14), null + reason when the funnel is unknown.
    expect(lean.body.salesFunnelCampaigns.map((r: { shortDescription: string | null }) => r.shortDescription)).toEqual(["We email new buyers until they reply with interest.", "We book meetings with buyers who reply with interest.", null]);
    expect(lean.body.salesFunnelCampaigns[2]).toMatchObject({ shortDescriptionUnavailableReason: "sales_funnel_not_in_catalogue" });

    const full = await request(app).get("/brands/b1/sales-funnel-campaigns?offerId=of1").set(AUTH);
    const keys = Object.keys(lean.body.salesFunnelCampaigns[0]);
    expect(keys).toEqual(["id", "brandId", "offerId", "salesFunnelId", "runningSalesFunnelId", "name", "face", "status", "stopReason", "createdAt", "type", "triggerLabel", "typeLabel", "shortDescription", "shortDescriptionUnavailableReason", "path", "otherParts", "copyUnavailableReason", "target", "units"]);
    full.body.salesFunnelCampaigns.forEach((row: Record<string, unknown>, i: number) => {
      expect(Object.fromEntries(keys.map((k) => [k, row[k]]))).toEqual(lean.body.salesFunnelCampaigns[i]);
    });
  });

  it("the path is the funnel the campaign RUNS now (runningSalesFunnelId), never the one it was born on (P5.1)", async () => {
    const following = { ...FC("fc1", "f1", [unit("c1", "sourcing-apollo-cold-filters", "start_to_lead_found")]), followsPlan: true, runningSalesFunnelId: "f2" };
    const older = FC("fc2", "f1", [unit("c2", "sourcing-apollo-cold-filters", "start_to_lead_found")]);
    const lost = { ...FC("fc3", "f1", []), runningSalesFunnelId: "unknown" };
    fetchWithRetry.mockImplementation(async () => new Response(JSON.stringify({ salesFunnelCampaigns: [following, older, lost] })));
    const res = await request(app).get("/brands/b1/sales-funnel-campaigns?offerId=of1&fields=copy").set(AUTH);
    expect(res.status).toBe(200);
    const [a, b, c] = res.body.salesFunnelCampaigns;
    expect(a).toMatchObject({ salesFunnelId: "f1", runningSalesFunnelId: "f2" });
    expect(a.path.items[1]).toMatchObject({ kind: "channel", slug: "of:f2" });
    // An older campaign-service body (no runningSalesFunnelId) runs the funnel it was born on.
    expect(b).toMatchObject({ salesFunnelId: "f1", runningSalesFunnelId: "f1" });
    expect(b.path.items[1]).toMatchObject({ slug: "of:f1" });
    // A running funnel the catalogue does not know: path null (logged), the born funnel's copy still served.
    expect(c).toMatchObject({ runningSalesFunnelId: "unknown", path: null, typeLabel: "Daily" });
  });

  it("warms the money of a campaign created in the last 15 minutes, under the caller's identity; an older one warms nothing", async () => {
    const fresh = { ...FC("fc1", "f1", []), createdAt: new Date(Date.now() - 5_000).toISOString() };
    fetchWithRetry.mockImplementation(async () => new Response(JSON.stringify({ salesFunnelCampaigns: [fresh, FC("fc2", "f1", [])] })));
    await request(app).get("/brands/b1/sales-funnel-campaigns?fields=copy").set(AUTH).expect(200);
    expect(warmFunnelCampaignReads).toHaveBeenCalledTimes(1);
    expect(warmFunnelCampaignReads.mock.calls[0]).toEqual([{ brandId: "b1", offerId: "of1", identity: { orgId: AUTH["x-org-id"], userId: AUTH["x-user-id"], runId: AUTH["x-run-id"] } }]);

    warmFunnelCampaignReads.mockClear();
    fetchWithRetry.mockImplementation(async () => new Response(JSON.stringify({ salesFunnelCampaigns: [FC("fc2", "f1", [])] })));
    await request(app).get("/brands/b1/sales-funnel-campaigns?fields=copy").set(AUTH).expect(200);
    expect(warmFunnelCampaignReads).not.toHaveBeenCalled();
  });

  it("an unknown fields value is a 400; campaign-service down is still a 502", async () => {
    expect((await request(app).get("/brands/b1/sales-funnel-campaigns?fields=money").set(AUTH)).body.reason).toBe("fields_unrecognised");
    fetchWithRetry.mockResolvedValue(new Response("boom", { status: 500 }));
    expect((await request(app).get("/brands/b1/sales-funnel-campaigns?fields=copy").set(AUTH)).status).toBe(502);
  });
});

describe("POST /internal/brands/:brandId/sales-funnel-campaigns/precompute", () => {
  const app2 = express().use(express.json()).use(router);
  it("answers 202 at once and warms the brand's reads under the caller's identity", async () => {
    const res = await request(app2).post("/internal/brands/b1/sales-funnel-campaigns/precompute").set(AUTH).send({ offerId: "of1" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ brandId: "b1", offerId: "of1", accepted: true });
    expect(warmFunnelCampaignReads.mock.calls[0]).toEqual([{ brandId: "b1", offerId: "of1", identity: { orgId: AUTH["x-org-id"], userId: AUTH["x-user-id"], runId: AUTH["x-run-id"] } }]);
  });
  it("no offer = brand-wide; a malformed offer = 400", async () => {
    expect((await request(app2).post("/internal/brands/b1/sales-funnel-campaigns/precompute").set(AUTH).send({})).body.offerId).toBeNull();
    expect((await request(app2).post("/internal/brands/b1/sales-funnel-campaigns/precompute").set(AUTH).send({ offerId: 3 })).body.reason).toBe("offer_id_unrecognised");
  });
});
