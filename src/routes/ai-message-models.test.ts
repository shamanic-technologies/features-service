import { describe, expect, it, vi } from "vitest";
import request from "supertest";

const today = new Date().toISOString().slice(0, 10);
const old = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
const stored = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("../db/index.js", () => ({ db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } }, sql: {} }));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({ default: { setupExpressErrorHandler: vi.fn() }, setupExpressErrorHandler: vi.fn() }));
vi.mock("../lib/ai-message-models-io.js", () => ({ readStoredAiMessageModelDays: vi.fn(async () => stored.rows), startAiMessageModelsLoop: vi.fn() }));
vi.mock("../lib/model-ids-client.js", () => ({
  readModelIds: vi.fn(async () => [{ modelId: "glm-5.3-flash", displayName: "GLM 5.3 Flash", provider: "zai", capabilityTier: "cheap", aliases: [], formerAliases: [] }]),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
const app = (await import("../index.js")).default;

const row = (day: string, orgId: string, withModel: number, withoutModel: number, reasons: Record<string, number> = {}) => ({
  day,
  orgId,
  sentNotWrittenByOurRuns: 0,
  messages: withModel + withoutModel,
  withModel,
  withoutModel,
  withoutByReason: reasons,
  byModel: withModel ? { "glm-5.3-flash": withModel } : {},
  computedAt: new Date().toISOString(),
});

describe("GET /internal/stats/ai-message-models (MODEL-TAG-EVERY-AI-MESSAGE-1126)", () => {
  it("serves the fleet and each org per day, newest first; red only for an unnamed message on a recent send", async () => {
    stored.rows = [row(today, "o1", 10, 0), row(today, "o2", 3, 0), row(old, "o1", 4, 2, { no_llm_billed: 2 })];
    const res = await request(app).get("/internal/stats/ai-message-models?days=7").set({ "x-api-key": "test-key" });
    expect(res.status).toBe(200);
    expect(res.body.days.map((d: { day: string }) => d.day)).toEqual([today, old]);
    expect(res.body.days[0].fleet).toMatchObject({ messages: 13, withModel: 13, withoutModel: 0 });
    expect(res.body.days[0].orgs).toHaveLength(2);
    expect(res.body.modelNames["glm-5.3-flash"]).toEqual({ name: "GLM 5.3 Flash", vendor: { id: "zai", name: "Z.ai" } });
    expect(res.body.health).toMatchObject({ broken: false, unnamedOnRecentSends: 0, reason: null });

    stored.rows = [row(today, "o1", 9, 1, { no_llm_billed: 1 })];
    const red = await request(app).get("/internal/stats/ai-message-models").set({ "x-api-key": "test-key" });
    expect(red.body.health).toMatchObject({ broken: true, unnamedOnRecentSends: 1, reason: "ai_messages_with_no_model_named" });
  });

  it("an empty series is the series stopped; days out of range are refused; the key is required", async () => {
    stored.rows = [];
    expect((await request(app).get("/internal/stats/ai-message-models").set({ "x-api-key": "test-key" })).body.health).toMatchObject({ broken: true, reason: "series_not_rebuilt" });
    expect((await request(app).get("/internal/stats/ai-message-models?days=0").set({ "x-api-key": "test-key" })).body.reason).toBe("days_unrecognised");
    expect((await request(app).get("/internal/stats/ai-message-models")).status).toBe(401);
  });
});
