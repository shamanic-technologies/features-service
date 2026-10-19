import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const state = vi.hoisted(() => ({ records: [] as unknown[], whereArgs: [] as unknown[] }));

vi.mock("../db/index.js", () => ({
  db: {
    query: { features: { findFirst: vi.fn(), findMany: vi.fn() } },
    select: vi.fn(() => ({ from: () => ({ where: (w: unknown) => (state.whereArgs.push(w), Promise.resolve(state.records)) }) })),
  },
  sql: {},
}));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({ default: { setupExpressErrorHandler: vi.fn() }, setupExpressErrorHandler: vi.fn() }));
vi.mock("../lib/model-ids-client.js", () => ({
  readModelIds: vi.fn(async () => [{ modelId: "claude-opus-5-5", displayName: "Claude Opus 5.5", provider: "anthropic", capabilityTier: "frontier", aliases: [], formerAliases: [] }]),
}));
vi.mock("../lib/plays-store.js", async (orig) => {
  const real = await orig<typeof import("../lib/plays-store.js")>();
  return {
    ...real,
    listVerdictsOfVersions: vi.fn(async () => [
      { workflowSlug: "sales-cold-email-outreach-ainalrami-v2", workflowDynastySlug: "sales-cold-email-outreach-ainalrami", tacticId: "blind-angle", verdict: true },
      { workflowSlug: "sales-cold-email-outreach-ainalrami-v2", workflowDynastySlug: "sales-cold-email-outreach-ainalrami", tacticId: "named-angle", verdict: false },
    ]),
    loadPlayCatalogue: vi.fn(async () => ({
      tactics: new Map([
        ["blind-angle", { id: "blind-angle", clientLine: "Brand not named in the first email" }],
        ["named-angle", { id: "named-angle", clientLine: "Brand named in the email" }],
      ]),
    })),
  };
});
vi.mock("../lib/workflow-leg-assignments.js", async (orig) => ({
  ...(await orig<typeof import("../lib/workflow-leg-assignments.js")>()),
  listLegAssignments: vi.fn(async () => [{ featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", workflowDynastySlug: "sales-cold-email-outreach-ainalrami", state: "active" }]),
}));
vi.mock("./public.js", async (orig) => ({
  ...(await orig<typeof import("./public.js")>()),
  readLegWorkflowRanking: vi.fn(async () => ({ rows: [{ workflowDynastySlug: "sales-cold-email-outreach-ainalrami", isMature: false }] })),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const app = (await import("../index.js")).default;
const AUTH = { "x-api-key": "test-key", "x-org-id": "0e9a0000-0000-4000-8000-000000000001", "x-user-id": "05e40000-0000-4000-8000-000000000001", "x-run-id": "07a00000-0000-4000-8000-000000000001" };
const LEAD = "dc73337b-71fc-49d8-b927-de66773387d3";

describe("GET /orgs/leads/:leadId/written-by (WRITTEN-BY-1019)", () => {
  beforeEach(() => {
    state.whereArgs = [];
    state.records = [{ campaignId: "cb8704c3-8763-4739-8c19-48f7ef2b13bd", model: "claude-opus-5-5", workflowSlug: "sales-cold-email-outreach-ainalrami-v2", createdAt: new Date("2026-10-19T05:38:48.854Z") }];
  });

  it("serves the model, the client lines of the version's tactics and whether it is under test", async () => {
    const res = await request(app).get(`/orgs/leads/${LEAD}/written-by`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      leadId: LEAD,
      campaignId: null,
      entries: [
        {
          campaignId: "cb8704c3-8763-4739-8c19-48f7ef2b13bd",
          writtenAt: "2026-10-19T05:38:48.854Z",
          model: { name: "Claude Opus 5.5", vendor: { id: "anthropic", name: "Anthropic" } },
          modelUnavailableReason: null,
          tactics: [{ line: "Brand not named in the first email" }],
          tacticsUnavailableReason: null,
          underTest: true,
          underTestUnavailableReason: null,
        },
      ],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/ainalrami/);
  });

  it("refuses an id that is not one, and answers nothing written as an empty list", async () => {
    expect((await request(app).get("/orgs/leads/nope/written-by").set(AUTH)).body.reason).toBe("lead_id_unrecognised");
    expect((await request(app).get(`/orgs/leads/${LEAD}/written-by?campaignId=x`).set(AUTH)).body.reason).toBe("campaign_id_unrecognised");
    state.records = [];
    const empty = await request(app).get(`/orgs/leads/${LEAD}/written-by`).set(AUTH);
    expect(empty.status).toBe(200);
    expect(empty.body.entries).toEqual([]);
  });

  it("needs the service key", async () => {
    expect((await request(app).get(`/orgs/leads/${LEAD}/written-by`)).status).toBe(401);
  });
});
