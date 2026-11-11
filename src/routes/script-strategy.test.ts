import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const unitOf = vi.fn();
const scriptsOf = vi.fn();
const playOf = vi.fn();
const catalogueOf = vi.fn();
vi.mock("../lib/fleet-leg-campaigns.js", () => ({ fetchCampaignPipe: (id: string) => unitOf(id) }));
vi.mock("../lib/script-catalogue-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/script-catalogue-client.js")>()), readRunnableScripts: () => scriptsOf() }));
vi.mock("./workflow-projection.js", () => ({ playOfLegRead: (...a: unknown[]) => playOf(...a) }));
vi.mock("../lib/plays-store.js", () => ({ loadPlayCatalogue: () => catalogueOf() }));
const briefOf = vi.fn();
vi.mock("./factory-shadow.js", () => ({ briefPlayOfUnit: (...a: unknown[]) => briefOf(...a) }));
const engineOf = vi.fn();
vi.mock("../lib/engine-strategy-io.js", async (orig) => ({ ...(await orig<typeof import("../lib/engine-strategy-io.js")>()), engineStrategyOfCampaign: (...a: unknown[]) => engineOf(...a) }));

import router from "./script-strategy.js";
import { __resetEngineAnswersForTest, engineAnswersNow } from "../lib/engine-held-monitor.js";
import { buildPlayCatalogue, type Strategy } from "../lib/plays.js";

const at = "2026-11-06T00:00:00.000Z";
const valid: Strategy = { id: "valid-only", name: "Valid only", description: "", requiresTacticIds: [], excludesTacticIds: ["catch-all"], createdBy: "t", createdAt: at };
const wide: Strategy = { id: "wide", name: "Wide", description: "w", requiresTacticIds: ["catch-all"], excludesTacticIds: [], createdBy: "t", createdAt: at };
const script = (outcome: string, dynasty: string) => ({ id: `${dynasty}-id`, outcome, dynasty, version: 1, description: "", tactics: {}, code: "" });

function app() {
  const a = express();
  a.use(router);
  return a;
}
const get = (q: string) => request(app()).get(`/internal/script-strategy${q}`).set("x-api-key", "k");

beforeEach(() => {
  process.env.FEATURES_SERVICE_API_KEY = "k";
  unitOf.mockReset();
  scriptsOf.mockReset();
  playOf.mockReset();
  catalogueOf.mockReset();
  briefOf.mockReset();
  briefOf.mockResolvedValue(null);
  engineOf.mockReset();
  engineOf.mockResolvedValue({ kind: "legacy" });
  catalogueOf.mockResolvedValue(
    buildPlayCatalogue({
      tactics: [{ id: "catch-all", name: "Catch-all", description: "d", createdBy: "t", createdAt: at, appliesTo: "script" }],
      strategies: [valid, wide],
      plays: [],
      verdicts: [],
      writerVerdicts: [
        { subjectKind: "script", subjectKey: "lead_found/dy_valid", tacticId: "catch-all", subjectVersion: "v1", verdict: false, probability: 0.1, model: "jev", judgedDescription: "d", judgedAt: at },
        { subjectKind: "script", subjectKey: "lead_found/dy_catch", tacticId: "catch-all", subjectVersion: "v1", verdict: true, probability: 0.9, model: "jev", judgedDescription: "d", judgedAt: at },
      ],
    }),
  );
  scriptsOf.mockResolvedValue([script("lead_found", "dy_valid"), script("lead_found", "dy_catch"), script("email_found", "dy_other")]);
});

describe("GET /internal/script-strategy", () => {
  it("a campaign keeping a strategy on the Engine runs on it, never on a pipe, play or funnel (MIGRATE-1105 S6)", async () => {
    unitOf.mockResolvedValue({ found: true, featureSlug: "lead-sourcing", legKey: "start_to_lead_found", salesFunnelId: "start_to_lead_found@lead-sourcing~valid-only", salesFunnelCampaignId: "f1", orgId: "o1", brandId: "b1" });
    engineOf.mockResolvedValue({ kind: "kept", row: { source: "carried", strategyId: "wide" }, strategy: wide });
    const r = await get("?campaignId=c1&outcome=lead_found");
    expect(engineOf).toHaveBeenCalledWith({ campaignId: "f1", orgId: "o1", brandId: "b1" }, { outcome: "lead_found" });
    expect(r.body).toMatchObject({ strategyId: "wide", strategySource: "campaign_engine_carried", keptDynasties: ["dy_catch"] });
    expect(playOf).not.toHaveBeenCalled();
    expect(briefOf).not.toHaveBeenCalled();
    engineOf.mockResolvedValue({ kind: "kept", row: { source: "empty_brief", strategyId: null }, strategy: null });
    expect((await get("?campaignId=c1&outcome=lead_found")).body).toMatchObject({ strategyId: null, keptDynasties: ["dy_catch", "dy_valid"] });
  });

  it("a row naming no campaign runs nothing (422), noted held for Monitoring; one good answer clears it", async () => {
    __resetEngineAnswersForTest();
    unitOf.mockResolvedValue({ found: true, featureSlug: "lead-sourcing", legKey: "start_to_lead_found", salesFunnelId: null, salesFunnelCampaignId: null });
    expect((await get("?campaignId=c1&outcome=lead_found")).body.reason).toBe("campaign_states_no_campaign");
    expect(engineAnswersNow()).toMatchObject([{ campaignId: "c1", outcome: "lead_found", heldReason: "campaign_states_no_campaign" }]);
    unitOf.mockResolvedValue({ found: true, featureSlug: "lead-sourcing", legKey: "start_to_lead_found", salesFunnelCampaignId: "f1", orgId: "o1", brandId: "b1" });
    engineOf.mockResolvedValue({ kind: "kept", row: { source: "empty_brief", strategyId: null }, strategy: null });
    expect((await get("?campaignId=c1&outcome=lead_found")).status).toBe(200);
    expect(engineAnswersNow()).toMatchObject([{ campaignId: "c1", outcome: "lead_found", heldReason: null }]);
  });

  it("refuses without both parameters, 404s an unknown campaign, 502s an unreadable catalogue (fail closed)", async () => {
    expect((await get("?campaignId=c1")).status).toBe(400);
    unitOf.mockResolvedValue({ found: false });
    expect((await get("?campaignId=nope&outcome=lead_found")).body.reason).toBe("campaign_not_found");
    unitOf.mockResolvedValue({ found: true, featureSlug: null, legKey: null, salesFunnelCampaignId: "f1", orgId: "o1", brandId: "b1" });
    engineOf.mockResolvedValue({ kind: "kept", row: { source: "judge", strategyId: null }, strategy: null });
    scriptsOf.mockRejectedValue(new Error("workflow-service 503"));
    const r = await get("?campaignId=c1&outcome=lead_found");
    expect(r.status).toBe(502);
    expect(r.body.reason).toBe("script_strategy_unreadable");
  });
});

describe("POST /internal/campaign-engine-answers (NEXT-STEPS-TRUE-REASON-1111)", () => {
  const post = (body: unknown) => {
    const a = express();
    a.use(express.json());
    a.use(router);
    return request(a).post("/internal/campaign-engine-answers").set("x-api-key", "k").send(body as object);
  };
  it("records another service's hold (any reason) and its clearing, like a refusal of script-strategy", async () => {
    __resetEngineAnswersForTest();
    expect((await post({ campaignId: "c9", outcome: "email_sent", heldReason: "budget_spent" })).status).toBe(202);
    expect(engineAnswersNow()).toMatchObject([{ campaignId: "c9", outcome: "email_sent", heldReason: "budget_spent" }]);
    expect((await post({ campaignId: "c9", outcome: "email_sent", heldReason: null })).status).toBe(202);
    expect(engineAnswersNow()).toMatchObject([{ campaignId: "c9", outcome: "email_sent", heldReason: null }]);
  });
  it("400 on a missing campaign, Engine or reason", async () => {
    expect((await post({ outcome: "email_sent", heldReason: "x" })).status).toBe(400);
    expect((await post({ campaignId: "c9", heldReason: "x" })).status).toBe(400);
    expect((await post({ campaignId: "c9", outcome: "email_sent" })).status).toBe(400);
    expect((await post({ campaignId: "c9", outcome: "email_sent", heldReason: "  " })).status).toBe(400);
  });
});
