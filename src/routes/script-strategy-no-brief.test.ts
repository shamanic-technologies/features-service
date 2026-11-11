/**
 * NO-BRIEF-UNBLOCK-1111 (owner 2026-11-11: « Une stratégie est un booléen de tactics. Des tactics sont des filtres sur des
 * scripts »): a campaign with no brief, or a brief silent on an Engine, keeps NO condition there: the Engine runner gets
 * every runnable script (`strategyId: null`), the Rating picks. Was 503 `campaign_states_no_brief` on any Engine with no
 * per-Engine default strategy (message_written: 14 refusals, 0 emails written for a paying client, prod 2026-11-11).
 * The real `engineStrategyOfCampaign`, with the DB, campaign-service, workflow-service and Jev mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const stored: Record<string, unknown>[] = [];
vi.mock("../db/index.js", () => ({
  sql: {},
  db: {
    select: () => ({ from: () => ({ where: async () => stored.slice() }) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: async () => {
          stored.length = 0;
          stored.push(v);
        },
      }),
    }),
  },
}));
const unitOf = vi.fn();
vi.mock("../lib/fleet-leg-campaigns.js", () => ({ fetchCampaignPipe: (id: string) => unitOf(id) }));
const funnelCampaigns = vi.fn();
vi.mock("../lib/sales-funnel-campaigns-client.js", () => ({ fetchSalesFunnelCampaigns: (...a: unknown[]) => funnelCampaigns(...a) }));
const scriptsOf = vi.fn();
vi.mock("../lib/script-catalogue-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/script-catalogue-client.js")>()), readRunnableScripts: () => scriptsOf() }));
const catalogueOf = vi.fn();
vi.mock("../lib/plays-store.js", () => ({ loadPlayCatalogue: () => catalogueOf() }));
const jev = vi.fn();
vi.mock("../lib/fetch-retry.js", () => ({ fetchWithRetry: (...a: unknown[]) => jev(...a) }));

import router from "./script-strategy.js";
import { __resetEngineStrategyForTest } from "../lib/engine-strategy-io.js";
import { buildPlayCatalogue, type Strategy } from "../lib/plays.js";

const at = "2026-11-11T00:00:00.000Z";
const glmOnly: Strategy = { id: "glm-only", name: "GLM only", description: "only scripts writing with GLM", requiresTacticIds: ["writes-glm"], excludesTacticIds: [], createdBy: "t", createdAt: at };
const script = (outcome: string, dynasty: string) => ({ id: `${dynasty}-id`, outcome, dynasty, version: 1, description: `${dynasty} writes`, tactics: {}, code: "" });

const get = (q: string) => {
  const a = express();
  a.use(router);
  return request(a).get(`/internal/script-strategy${q}`).set("x-api-key", "k");
};

beforeEach(() => {
  process.env.FEATURES_SERVICE_API_KEY = "k";
  process.env.CHAT_SERVICE_URL = "http://chat";
  process.env.CHAT_SERVICE_API_KEY = "c";
  stored.length = 0;
  __resetEngineStrategyForTest();
  jev.mockReset();
  unitOf.mockResolvedValue({ found: true, featureSlug: null, legKey: null, salesFunnelCampaignId: "3cfc2aaa", orgId: "b4a43279", brandId: "f25037e6" });
  catalogueOf.mockResolvedValue(
    buildPlayCatalogue({
      tactics: [{ id: "writes-glm", name: "Writes with GLM", description: "d", createdBy: "t", createdAt: at, appliesTo: "script" }],
      strategies: [glmOnly],
      plays: [],
      verdicts: [],
      writerVerdicts: [
        { subjectKind: "script", subjectKey: "message_written/dy_glm", tacticId: "writes-glm", subjectVersion: "v1", verdict: true, probability: 0.9, model: "jev", judgedDescription: "d", judgedAt: at },
        { subjectKind: "script", subjectKey: "message_written/dy_opus", tacticId: "writes-glm", subjectVersion: "v1", verdict: false, probability: 0.1, model: "jev", judgedDescription: "d", judgedAt: at },
      ],
    }),
  );
  scriptsOf.mockResolvedValue([script("message_written", "dy_glm"), script("message_written", "dy_opus"), script("lead_found", "dy_find")]);
});

describe("a campaign with no brief keeps no condition on every Engine (NO-BRIEF-UNBLOCK-1111)", () => {
  it("brief NULL: message_written answers 200 with every runnable script, strategyId null, stored as empty_brief", async () => {
    funnelCampaigns.mockResolvedValue([{ id: "3cfc2aaa", brief: null }]);
    const r = await get("?campaignId=c5df3208&outcome=message_written");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ strategyId: null, strategySource: "campaign_engine_empty_brief" });
    expect([...r.body.keptDynasties].sort()).toEqual(["dy_glm", "dy_opus"]);
    expect(stored).toMatchObject([{ campaignId: "3cfc2aaa", outcome: "message_written", strategyId: null, source: "empty_brief" }]);
    expect(jev).not.toHaveBeenCalled();
  });

  it("a brief silent on the Engine: Jev says it does not bear, no condition is kept (same answer)", async () => {
    funnelCampaigns.mockResolvedValue([{ id: "3cfc2aaa", brief: "Find dentists in Lyon with the Apollo filters this brand set." }]);
    jev.mockResolvedValue({ ok: true, json: async () => ({ model: "jev-1", answers: { bears: { type: "noul", noul: 0.12 }, strategy: { type: "choice", choice: "o1", confidence: 0.6 } } }) });
    const r = await get("?campaignId=c5df3208&outcome=message_written");
    expect(jev).toHaveBeenCalledTimes(1);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ strategyId: null, strategySource: "campaign_engine_judge" });
    expect([...r.body.keptDynasties].sort()).toEqual(["dy_glm", "dy_opus"]);
  });

  it("a brief that bears on the Engine still narrows it", async () => {
    funnelCampaigns.mockResolvedValue([{ id: "3cfc2aaa", brief: "Write every email with GLM." }]);
    jev.mockResolvedValue({ ok: true, json: async () => ({ model: "jev-1", answers: { bears: { type: "noul", noul: 0.9 }, strategy: { type: "choice", choice: "o1", confidence: 0.8 } } }) });
    const r = await get("?campaignId=c5df3208&outcome=message_written");
    expect(r.body).toMatchObject({ strategyId: "glm-only", keptDynasties: ["dy_glm"] });
  });
});
