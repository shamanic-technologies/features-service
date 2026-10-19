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
  readModelIds: vi.fn(async () => [{ modelId: "claude-opus-5-5", displayName: "Claude Opus 5.5", provider: "anthropic", capabilityTier: "frontier", aliases: ["opus"], formerAliases: [] }]),
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
        ["blind-angle", { id: "blind-angle", name: "Blind angle", clientLine: "Brand not named in the first email" }],
        ["named-angle", { id: "named-angle", name: "Named angle", clientLine: "Brand named in the email" }],
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

vi.mock("../lib/workflow-definitions-client.js", () => ({
  fetchWorkflowDefinitions: vi.fn(async () => [
    { workflowSlug: "sales-cold-email-outreach-ainalrami-v2", workflowDynastySlug: "sales-cold-email-outreach-ainalrami", version: 2, versionActive: true, description: null, dag: { nodes: [{ config: { service: "content-generation", path: "/generate", body: { type: "blind-discovery-email-v15", model: "opus" } } }] } },
  ]),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.LEAD_SERVICE_URL = "http://lead";
process.env.LEAD_SERVICE_API_KEY = "lk";
process.env.RUNS_SERVICE_URL = "http://runs";
process.env.RUNS_SERVICE_API_KEY = "rk";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const app = (await import("../index.js")).default;
const AUTH = { "x-api-key": "test-key", "x-org-id": "0e9a0000-0000-4000-8000-000000000001", "x-user-id": "05e40000-0000-4000-8000-000000000001", "x-run-id": "07a00000-0000-4000-8000-000000000001" };
const LEAD = "dc73337b-71fc-49d8-b927-de66773387d3";

describe("GET /orgs/leads/:leadId/written-by (WRITTEN-BY-1019)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async (url: string) =>
      url.includes("/sent-messages")
        ? new Response(
            JSON.stringify({
              leadId: LEAD,
              count: 2,
              messages: [
                { id: "subj-1", kind: "email_sent", source: "outreach", channel: "email", campaignId: "cb8704c3-8763-4739-8c19-48f7ef2b13bd", brandIds: [], sentAt: "2026-10-19T06:00:00.000Z", writtenBy: { by: "workflow", basis: "holding_run", runId: "r1", workflowSlug: "sales-cold-email-outreach-ainalrami-v2", campaignId: "cb8704c3-8763-4739-8c19-48f7ef2b13bd", workflowSource: "serve", reason: null } },
                { id: "crm-2", kind: "message_out", source: "crm", channel: "whatsapp", campaignId: null, brandIds: [], sentAt: "2026-10-19T07:00:00.000Z", writtenBy: { by: "person", basis: "person", runId: null, workflowSlug: null, campaignId: null, workflowSource: null, reason: null } },
              ],
            }),
            { status: 200 },
          )
        : new Response("{}", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
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
          tactics: [{ name: "Blind angle", line: "Brand not named in the first email" }],
          tacticsUnavailableReason: null,
          underTest: true,
          underTestUnavailableReason: null,
        },
      ],
      messages: [
        {
          id: "subj-1",
          kind: "email_sent",
          channel: "email",
          campaignId: "cb8704c3-8763-4739-8c19-48f7ef2b13bd",
          sentAt: "2026-10-19T06:00:00.000Z",
          writtenBy: "workflow",
          model: { name: "Claude Opus 5.5", vendor: { id: "anthropic", name: "Anthropic" } },
          modelUnavailableReason: null,
          tactics: [{ name: "Blind angle", line: "Brand not named in the first email" }],
          tacticsUnavailableReason: null,
          underTest: true,
          underTestUnavailableReason: null,
        },
        {
          id: "crm-2",
          kind: "message_out",
          channel: "whatsapp",
          campaignId: null,
          sentAt: "2026-10-19T07:00:00.000Z",
          writtenBy: "person",
          model: null,
          modelUnavailableReason: "written_by_a_person",
          tactics: [],
          tacticsUnavailableReason: "written_by_a_person",
          underTest: null,
          underTestUnavailableReason: "written_by_a_person",
        },
      ],
      messagesUnavailableReason: null,
    });
    expect(fetchMock.mock.calls[0][1].headers["x-org-id"]).toBe(AUTH["x-org-id"]);
    // Never a workflow name/id, a run id or a cost on the client's read.
    expect(JSON.stringify(res.body)).not.toMatch(/ainalrami|"r1"|runId|workflowSlug|cost/i);
  });

  it("an act recorded before lead-service stored the version reads its run's version at runs-service (the org's run only)", async () => {
    const act = (id: string, runId: string) => ({ id, kind: "followup_act", source: "followup_ledger", channel: null, campaignId: null, brandIds: [], sentAt: "2026-10-16T08:20:40.229Z", writtenBy: { by: "workflow", basis: "recorded_act", runId, workflowSlug: null, campaignId: "a27bb0e7-b955-4586-a5bd-4a02cb54a29d", workflowSource: null, reason: null } });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/sent-messages")) return new Response(JSON.stringify({ leadId: LEAD, count: 2, messages: [act("fa-1", "run-own"), act("fa-2", "run-foreign")] }), { status: 200 });
      if (url.endsWith("/v1/runs/run-own")) return new Response(JSON.stringify({ organizationId: AUTH["x-org-id"], workflowSlug: "sales-cold-email-outreach-ainalrami-v2" }), { status: 200 });
      if (url.endsWith("/v1/runs/run-foreign")) return new Response(JSON.stringify({ organizationId: "another-org", workflowSlug: "sales-cold-email-outreach-ainalrami-v2" }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    const res = await request(app).get(`/orgs/leads/${LEAD}/written-by`).set(AUTH);
    const [own, foreign] = res.body.messages;
    expect(own).toMatchObject({ id: "fa-1", writtenBy: "workflow", model: { name: "Claude Opus 5.5" }, tactics: [{ name: "Blind angle", line: "Brand not named in the first email" }], underTest: true });
    expect(foreign).toMatchObject({ id: "fa-2", writtenBy: "workflow", model: null, modelUnavailableReason: "no_workflow_recorded" });
  });

  it("lead-service unreadable: the writer records still answer, messages null with a reason", async () => {
    fetchMock.mockImplementation(async () => new Response("boom", { status: 500 }));
    const res = await request(app).get(`/orgs/leads/${LEAD}/written-by`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body).toMatchObject({ messages: null, messagesUnavailableReason: "sent_messages_unreadable" });
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
