import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const rows = vi.hoisted(() => new Map<string, any>());
// Legs a test adds to a channel, as a declaration would (`{ slug: [transition, ...] }`).
const extraLegs = vi.hoisted(() => new Map<string, any[]>());
vi.mock("../db/index.js", () => ({ db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn(async () => []) } } }, sql: {} }));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({ default: { setupExpressErrorHandler: vi.fn() }, setupExpressErrorHandler: vi.fn() }));
vi.mock("../lib/channel-declarations-store.js", async (importOriginal) => {
  const { buildChannelCatalogue } = await import("../lib/channel-catalogue.js");
  const { SEED_FEATURES } = await import("../seed/features.js");
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    loadChannelCatalogue: async () => ({
      channels: buildChannelCatalogue(SEED_FEATURES.filter((f) => f.status === "active")).map((c) =>
        extraLegs.has(c.slug) ? { ...c, stepTransitions: [...c.stepTransitions, ...extraLegs.get(c.slug)!] } : c,
      ),
      declared: { channels: [], legs: [], triggers: [] },
    }),
  };
});
vi.mock("../lib/public-stats-clients.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPublicWorkflows: vi.fn(async () => [{ workflowSlug: "ai-meeting-booking-avior", workflowDynastySlug: "ai-meeting-booking-avior", status: "active" }]),
}));
vi.mock("../lib/workflow-leg-assignments.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerLegAssignment: async (input: any) => {
    const key = `${input.featureSlug}|${input.legKey}|${input.workflowDynastySlug}`;
    if (rows.has(key)) return { assignment: rows.get(key), created: false };
    const row = { featureSlug: input.featureSlug, legKey: input.legKey, workflowDynastySlug: input.workflowDynastySlug, state: "active", decidedBy: input.registeredBy, decidedAt: "2026-10-10T00:00:00.000Z", note: null };
    rows.set(key, row);
    return { assignment: row, created: true };
  },
}));

vi.mock("./public.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invalidateChannelCatalogue: vi.fn(),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
const app = (await import("../index.js")).default;
const KEY = { "x-api-key": "test-key" };
const post = (body: object) => request(app).post("/internal/workflow-leg-assignments/register").set(KEY).send(body);

beforeEach(() => {
  rows.clear();
  extraLegs.clear();
});

describe("POST /internal/workflow-leg-assignments/register (owner 2026-10-10, option A)", () => {
  it("registers a workflow ACTIVE on the pipe it was created for, and serves the pipe (its produced step)", async () => {
    const res = await post({ pipeId: "ai-meeting-booking|conversation_to_meeting_booked", workflowDynastySlug: "ai-meeting-booking-avior", registeredBy: "workflow-service" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      created: true,
      assignment: { state: "active", decidedBy: "workflow-service" },
      pipe: { id: "ai-meeting-booking|conversation_to_meeting_booked", fromStep: "conversation", toStep: "meeting_booked", mode: "reactive" },
    });
  });

  it("drops the cached public catalogue, so the channel reads managed at once (owner 2026-10-13, Email Sending)", async () => {
    const { invalidateChannelCatalogue } = await import("./public.js");
    vi.mocked(invalidateChannelCatalogue).mockClear();
    await post({ pipeId: "ai-meeting-booking|conversation_to_meeting_booked", workflowDynastySlug: "ai-meeting-booking-avior", registeredBy: "workflow-service" });
    expect(invalidateChannelCatalogue).toHaveBeenCalled();
  });

  it("is insert-if-absent: a second call returns the existing row untouched", async () => {
    await post({ pipeId: "ai-meeting-booking|conversation_to_meeting_booked", workflowDynastySlug: "ai-meeting-booking-avior", registeredBy: "workflow-service" });
    const again = await post({ pipeId: "ai-meeting-booking|conversation_to_meeting_booked", workflowDynastySlug: "ai-meeting-booking-avior", registeredBy: "workflow-service" });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
  });

  it("refuses a pipe the channel does not perform, and an unknown dynasty", async () => {
    expect((await post({ pipeId: "ai-meeting-booking|start_to_website_visit", workflowDynastySlug: "ai-meeting-booking-avior", registeredBy: "x" })).body.reason).toBe("pipe_not_found");
    expect((await post({ pipeId: "ai-meeting-booking|conversation_to_meeting_booked", workflowDynastySlug: "nope", registeredBy: "x" })).body.reason).toBe("workflow_dynasty_not_found");
    expect((await post({ workflowDynastySlug: "x", registeredBy: "x" })).body.reason).toBe("pipe_id_required");
  });

  it("serves an outbound entry pipe in its served spelling, from Lead found", async () => {
    const { fetchPublicWorkflows } = await import("../lib/public-stats-clients.js");
    vi.mocked(fetchPublicWorkflows).mockResolvedValueOnce([{ workflowSlug: "w", workflowDynastySlug: "sales-cold-email-outreach-vega", status: "active" } as any]);
    const res = await post({ pipeId: "sales-cold-email-outreach|lead_found_to_conversation", workflowDynastySlug: "sales-cold-email-outreach-vega", registeredBy: "workflow-service" });
    expect(res.status).toBe(201);
    expect(res.body.pipe).toMatchObject({ legKey: "lead_found_to_conversation", fromStep: "lead_found", toStep: "conversation" });
  });

  it("files a workflow on the NON-outbound pipe it names, never on its start_to_* twin (NEVER-NO-FOLLOWUP-1014)", async () => {
    // AI Follow-up Email performs both Lead found -> Positive reply (proactive) and Start -> Positive reply (reactive):
    // two pipes. The outbound spelling collapse filed the proactive workflow on the reactive pipe.
    const { CHANNEL_STEPS } = await import("../lib/acquisition-channels.js");
    const leg = (from: string | null, mode: string, triggerId: string | null) => ({
      legKey: `${from ?? "start"}_to_conversation`,
      from: from ? { key: from, label: (CHANNEL_STEPS as any)[from].label } : null,
      to: { key: "conversation", label: (CHANNEL_STEPS as any).conversation.label },
      mode,
      triggerId,
    });
    extraLegs.set("ai-follow-up-email", [leg(null, "reactive", "follow_up_date_reached"), leg("lead_found", "proactive", null)]);
    const { fetchPublicWorkflows } = await import("../lib/public-stats-clients.js");
    vi.mocked(fetchPublicWorkflows).mockResolvedValue([{ workflowSlug: "w", workflowDynastySlug: "ai-follow-up-email-alasia", status: "active" } as any]);
    const res = await post({ pipeId: "ai-follow-up-email|lead_found_to_conversation", workflowDynastySlug: "ai-follow-up-email-alasia", registeredBy: "workflow-service" });
    expect(res.status).toBe(201);
    expect(res.body.assignment.legKey).toBe("lead_found_to_conversation");
    expect(res.body.pipe).toMatchObject({ id: "ai-follow-up-email|lead_found_to_conversation", fromStep: "lead_found", mode: "proactive" });
    const reactive = await post({ pipeId: "ai-follow-up-email|start_to_conversation", workflowDynastySlug: "ai-follow-up-email-alasia", registeredBy: "workflow-service" });
    expect(reactive.body.assignment.legKey).toBe("start_to_conversation");
    expect(reactive.body.pipe).toMatchObject({ fromStep: null, mode: "reactive", triggerId: "follow_up_date_reached" });
    vi.mocked(fetchPublicWorkflows).mockResolvedValue([{ workflowSlug: "ai-meeting-booking-avior", workflowDynastySlug: "ai-meeting-booking-avior", status: "active" } as any]);
  });
});

describe("pipeLegKeyOf: the two outbound spellings are one leg on an outbound channel only", () => {
  it("collapses on an outbound channel, keeps a non-outbound channel's key verbatim", async () => {
    const { pipeLegKeyOf } = await import("../lib/funnel-legs.js");
    expect(pipeLegKeyOf("sales-cold-email-outreach", "lead_found_to_conversation")).toBe("start_to_conversation");
    expect(pipeLegKeyOf("ai-follow-up-email", "lead_found_to_conversation")).toBe("lead_found_to_conversation");
    expect(pipeLegKeyOf("ai-follow-up-email", "start_to_conversation")).toBe("start_to_conversation");
  });
});
