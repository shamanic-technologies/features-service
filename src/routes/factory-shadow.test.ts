import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { BriefJudgment } from "../lib/factory-shadow.js";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

// FACTORY-P1-BRIEF-JUDGE-SHADOW-PLAN: a pass judges each pipe ONCE, reuses the stored verdict, re-judges when the brief
// moves; the reads are org-scoped and Monitoring turns red on a failure.

const mem = vi.hoisted(() => ({
  judgments: new Map<string, BriefJudgment>(),
  plans: new Map<string, any>(),
  days: [] as any[],
  cells: new Map<string, { text: string; computedAt: number }>(),
  model: null as any,
  campaigns: [] as any[],
  jevCalls: 0,
  jevFails: false,
}));

vi.mock("../lib/factory-shadow-store.js", () => ({
  readJudgments: vi.fn(async () => new Map(mem.judgments)),
  writeJudgment: vi.fn(async (j: BriefJudgment) => void mem.judgments.set(`${j.campaignId}|${j.basePipeId}`, j)),
  writePlan: vi.fn(async (r: any) => void mem.plans.set(r.campaignId, { ...r, computedAt: r.computedAt.toISOString() })),
  readPlan: vi.fn(async (id: string) => mem.plans.get(id) ?? null),
  readPlansSince: vi.fn(async () => [...mem.plans.values()]),
  writeDay: vi.fn(async (day: string, counts: any[], at: Date) => {
    mem.days = [...mem.days.filter((d) => d.day !== day), ...counts.map((c) => ({ day, ...c, sweptAt: at.toISOString() }))];
  }),
  readDays: vi.fn(async () => mem.days),
}));
vi.mock("../lib/fleet-cell-store.js", () => ({
  loadFleetCell: vi.fn(async (k: string) => mem.cells.get(k) ?? null),
  storeFleetCell: vi.fn(async (k: string, text: string, computedAt: number) => void mem.cells.set(k, { text, computedAt })),
}));
vi.mock("./agent-catalogue.js", () => ({ loadCatalogueModelForLifetimeRevenue: vi.fn(async () => mem.model) }));
vi.mock("../lib/sales-funnel-campaigns-client.js", () => ({ fetchSalesFunnelCampaigns: vi.fn(async () => mem.campaigns) }));
vi.mock("../lib/brand-leg-economics-client.js", () => ({ fetchBrandLegEconomics: vi.fn(async () => ({ legRates: [], offers: [{ offerId: "offer-1", name: "O", lifetimeRevenueUsd: 3000 }] })) }));
vi.mock("../lib/offer-lifetime-revenue.js", () => ({ offerLifetimeRevenue: vi.fn(async (usd: number) => ({ usd, source: "offer_stated" })) }));
vi.mock("../lib/offer-steps-client.js", () => ({ fetchOfferSteps: vi.fn(async () => ({ offerId: "offer-1", stated: false, steps: null, statedAt: null })) }));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign";
process.env.CAMPAIGN_SERVICE_API_KEY = "k";
process.env.CHAT_SERVICE_URL = "http://chat";
process.env.CHAT_SERVICE_API_KEY = "k";

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("http://campaign/campaigns/list")) {
      return new Response(JSON.stringify({ campaigns: [{ orgId: "org-1", brandIds: ["brand-1"], salesFunnelCampaignId: "sfc-1" }] }), { status: 200 });
    }
    if (url === "http://chat/internal/platform-judgments") {
      mem.jevCalls += 1;
      const body = JSON.parse(String(init?.body));
      expect(body.support.kind).toBe("product_feature");
      expect(body.state.brief).toBeTruthy();
      if (mem.jevFails) return new Response("out of credits", { status: 502 });
      return new Response(JSON.stringify({ model: "jev-test", answers: { play: { type: "choice", choice: "o1", confidence: 0.9, probabilities: { o0: 0.1, o1: 0.9 } } } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }),
);

const { buildCatalogueModel } = await import("../lib/agent-catalogue.js");
const { buildChannelCatalogue } = await import("../lib/channel-catalogue.js");
const { SEED_FEATURES } = await import("../seed/features.js");
const { servedLegKeyOf } = await import("../lib/funnel-legs.js");
const { default: router, runFactoryShadowPass } = await import("./factory-shadow.js");

const COLD = "sales-cold-email-outreach|lead_found_to_conversation";
const channels = buildChannelCatalogue(SEED_FEATURES.filter((f) => f.status === "active"));
const mature = (c: number, r: number) => ({ basis: "mature" as const, costPerOutcomeUsd: c, conversionRatePct: r, workflowDynastySlug: "w" });
const play = (strategyId: string, name: string, description: string, c: number) => ({ strategyId, strategyName: name, strategyDescription: description, measurement: mature(c, 1), allowedActiveWorkflowCount: 1, allowedActiveDynasties: ["w"], excludedDynasties: [] });
mem.model = buildCatalogueModel({
  channels,
  publishedPipeIds: new Set(channels.flatMap((c) => c.stepTransitions.map((t) => `${c.slug}|${servedLegKeyOf(c.slug, t.legKey)}`))),
  declaredSteps: [],
  measurements: new Map([[COLD, mature(40, 1)], ["lead-sourcing|start_to_lead_found", mature(0.5, 100)], ["sourcing-apollo-cold-filters|start_to_lead_found", mature(0.2, 100)]]),
  lifetimeRevenueUsd: 3000,
  plays: new Map([[COLD, { default: play("everyone", "Everyone", "Email every lead found.", 40), others: [play("valid-only", "Valid only", "Email only addresses verified valid.", 30)] }]]),
});

const campaign = (brief: string | null) => ({
  id: "sfc-1",
  brandId: "brand-1",
  offerId: "offer-1",
  salesFunnelId: "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client",
  salesFunnelName: "Cold Email Replies",
  status: "ongoing",
  stopReason: null,
  createdAt: "2026-10-01T00:00:00Z",
  units: [],
  target: "conversation",
  brief,
  briefUpdatedAt: brief ? "2026-10-28T00:00:00Z" : null,
  mode: "proactive",
  triggerId: null,
});

const app = express().use(express.json()).use(router);
const ORG = { "x-api-key": "test-key", "x-org-id": "11111111-1111-4111-8111-111111111111", "x-user-id": "22222222-2222-4222-8222-222222222222", "x-run-id": "33333333-3333-4333-8333-333333333333" };

beforeEach(() => {
  mem.jevCalls = 0;
  mem.jevFails = false;
});

describe("a pass: judged once, reused, re-judged when the brief moves", () => {
  it("an empty brief keeps every pipe on its default play, no Jev call", async () => {
    mem.campaigns = [campaign(null)];
    await runFactoryShadowPass();
    expect(mem.jevCalls).toBe(0);
    const j = mem.judgments.get(`sfc-1|${COLD}`)!;
    expect(j).toMatchObject({ source: "empty_brief", chosenPipeId: COLD, briefHash: null });
    const body = mem.plans.get("sfc-1").body;
    expect(body.status).toBe("ok");
    expect(body.picks[0]).toMatchObject({ basePipeId: COLD, inRunningFunnel: true, pickedPipeId: COLD, differs: false });
  });

  it("a brief is judged by Jev once, then the stored verdict is reused", async () => {
    mem.campaigns = [campaign("Only email addresses verified valid.")];
    await runFactoryShadowPass();
    expect(mem.jevCalls).toBe(1);
    expect(mem.judgments.get(`sfc-1|${COLD}`)).toMatchObject({ source: "jev", chosenPipeId: `${COLD}~valid-only`, confidence: 0.9, model: "jev-test" });
    const body = mem.plans.get("sfc-1").body;
    expect(body.picks[0]).toMatchObject({ pickedPlayName: "Valid only", runningPlayName: "Everyone", differs: true });
    expect(body.pickDiffers).toBe(true);
    expect(body.plan.shadow.legs[1].pipeId).toBe(`${COLD}~valid-only`);
    await runFactoryShadowPass();
    expect(mem.jevCalls).toBe(1);
  });

  it("an edited brief is judged again", async () => {
    mem.campaigns = [campaign("Valid addresses only, and test for 30 days.")];
    await runFactoryShadowPass();
    expect(mem.jevCalls).toBe(1);
  });

  it("a judge failure is the campaign's status and turns Monitoring red", async () => {
    mem.jevFails = true;
    mem.campaigns = [campaign("A brief nobody judged yet.")];
    await runFactoryShadowPass();
    expect(mem.plans.get("sfc-1")).toMatchObject({ status: "judge_failed" });
    const res = await request(app).get("/internal/factory-shadow/monitoring").set({ "x-api-key": "test-key" });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toEqual({ red: true, reasons: ["judge_failed"] });
    expect(res.body.series.at(-1)).toMatchObject({ campaigns: 1, judgeFailed: 1, orgs: [expect.objectContaining({ orgId: "org-1", judgeFailed: 1 })] });
    expect(res.body.campaigns[0]).toMatchObject({ campaignId: "sfc-1", status: "judge_failed" });
  });
});

describe("reads", () => {
  it("serves the stored plan to its own org only", async () => {
    mem.plans.set("sfc-x", { orgId: ORG["x-org-id"], brandId: "brand-1", status: "ok", body: { campaignId: "sfc-x", status: "ok" } });
    const own = await request(app).get("/brands/brand-1/sales-funnel-campaigns/sfc-x/factory-shadow").set(ORG);
    expect(own.status).toBe(200);
    expect(own.body).toEqual({ campaignId: "sfc-x", status: "ok" });
    const other = await request(app).get("/brands/brand-2/sales-funnel-campaigns/sfc-x/factory-shadow").set(ORG);
    expect(other.status).toBe(404);
    const none = await request(app).get("/brands/brand-1/sales-funnel-campaigns/nope/factory-shadow").set(ORG);
    expect(none.body.error).toBe("factory_shadow_not_computed");
  });

  it("refuses a days window out of range", async () => {
    const res = await request(app).get("/internal/factory-shadow/monitoring?days=0").set({ "x-api-key": "test-key" });
    expect(res.status).toBe(400);
  });
});
