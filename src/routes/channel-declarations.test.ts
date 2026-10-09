import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } }, sql: {} }));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({
  default: { setupExpressErrorHandler: vi.fn() },
  setupExpressErrorHandler: vi.fn(),
}));
// Names are a DB-backed pool; any stable word per key is enough here (the pool is guarded in its own suite).
vi.mock("../lib/sales-path-names.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  salesPathNamesFor: async (keys: readonly string[]) => new Map(keys.map((k) => [k, `name-of-${k.length}`])),
  withCampaignNames: async (channels: unknown[]) => channels,
}));

// An in-memory store with the REAL merge + catalogue build, so the route, the publish rule and the public
// catalogue read are exercised end to end on the seeded features.
const mem = vi.hoisted(() => ({ channels: [] as any[], legs: [] as any[], triggers: [] as any[], paths: [] as any[] }));
vi.mock("../lib/channel-declarations-store.js", async () => {
  const { mergeDeclarations } = await import("../lib/channel-declarations.js");
  const { buildChannelCatalogue } = await import("../lib/channel-catalogue.js");
  const { channelShortDescription } = await import("../lib/channel-short-descriptions.js");
  const { channelTypeOf } = await import("../lib/channel-types.js");
  const { SEED_FEATURES } = await import("../seed/features.js");
  const NOW = "2026-10-09T00:00:00.000Z";
  const seeded = SEED_FEATURES.filter((f) => f.status === "active");
  return {
    listTriggerTypes: async () => mem.triggers,
    listDeclaredChannels: async () => mem.channels,
    listDeclaredLegs: async () => mem.legs,
    listDeclaredSalesPaths: async () => mem.paths,
    loadChannelCatalogue: async (opts: { publishedOnly: boolean }) => {
      const declared = { channels: mem.channels, legs: mem.legs, triggers: mem.triggers };
      const m = mergeDeclarations(seeded, declared, opts, { shortDescriptionOf: channelShortDescription, channelTypeOfSlug: channelTypeOf });
      return { channels: buildChannelCatalogue(m.rows, m.shortDescriptionOf, m.channelTypeOfSlug, m.triggerOf), declared };
    },
    takenChannelIdentities: async () => ({
      slugs: new Set([...SEED_FEATURES.map((f) => f.slug), ...mem.channels.map((c) => c.slug)]),
      names: new Set([...SEED_FEATURES.map((f) => f.name.toLowerCase()), ...mem.channels.map((c) => c.name.toLowerCase())]),
    }),
    insertChannel: async (input: any, createdBy: string, requestedByOrgId: string | null) => {
      const row = { ...input, displayOrder: 10_000 + mem.channels.length, published: false, publishedAt: null, publishedBy: null, createdBy, requestedByOrgId, createdAt: NOW, updatedAt: NOW };
      mem.channels.push(row);
      return row;
    },
    updateChannel: async (slug: string, patch: any, updatedBy: string) => {
      const row = mem.channels.find((c) => c.slug === slug);
      Object.assign(row, patch, patch.published ? { publishedAt: NOW, publishedBy: updatedBy } : {});
      return row;
    },
    insertLeg: async (channelSlug: string, input: any, createdBy: string, requestedByOrgId: string | null) => {
      const row = { channelSlug, ...input, published: false, createdBy, requestedByOrgId, createdAt: NOW, updatedAt: NOW };
      mem.legs.push(row);
      return row;
    },
    updateLeg: async (channelSlug: string, legKey: string, patch: any) => {
      const row = mem.legs.find((l) => l.channelSlug === channelSlug && l.legKey === legKey);
      Object.assign(row, patch);
      return row;
    },
    insertTrigger: async (input: any, createdBy: string, requestedByOrgId: string | null) => {
      const row = { ...input, coded: false, origin: "declared", displayOrder: mem.triggers.length, createdBy, requestedByOrgId };
      mem.triggers.push(row);
      return row;
    },
    updateTrigger: async (id: string, patch: any) => Object.assign(mem.triggers.find((t) => t.id === id), patch),
    insertSalesPath: async (combinationKey: string, legs: any[], createdBy: string, requestedByOrgId: string | null) => {
      const row = { combinationKey, legs, createdBy, requestedByOrgId, createdAt: NOW };
      mem.paths.push(row);
      return row;
    },
  };
});

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";

const app = (await import("../index.js")).default;
const { __resetChannelCatalogueCache } = await import("./public.js");
const { CHANNEL_TRIGGER_TYPES } = await import("../lib/channel-triggers.js");

const KEY = { "x-api-key": "test-key" };
const SLUG = "whatsapp-concierge";

const channelBody = {
  slug: SLUG,
  name: "WhatsApp Concierge",
  description: "A person answers every interested buyer on WhatsApp.",
  shortDescription: "Answers buyers on WhatsApp",
  icon: "whatsapp-logo",
  channelType: "conversion",
  operatedBy: "platform",
  performedBy: "person",
  dailyOperatingCostCents: 0,
  minimumCommitmentDays: 30,
  maxDaysToFirstProduction: 3,
  createdBy: "kevin@distribute.you",
};

const publicSlugs = async () => {
  __resetChannelCatalogueCache();
  const res = await request(app).get("/public/channels");
  expect(res.status).toBe(200);
  return (res.body.channels as Array<{ slug: string }>).map((c) => c.slug);
};

beforeEach(() => {
  mem.channels.length = 0;
  mem.legs.length = 0;
  mem.paths.length = 0;
  mem.triggers.splice(0, mem.triggers.length, ...CHANNEL_TRIGGER_TYPES.map((t, i) => ({ ...t, origin: "code", kind: "event", params: null, displayOrder: i, createdBy: null, requestedByOrgId: null })));
});

describe("/internal/declarations: a staff caller declares a channel, a reactive leg and a sales path live", () => {
  it("is service-key only", async () => {
    expect((await request(app).get("/internal/declarations/channels")).status).toBe(401);
    expect((await request(app).post("/internal/declarations/channels").send(channelBody)).status).toBe(401);
  });

  it("creates, reads back, and publishes to the client catalogue only when published", async () => {
    const created = await request(app).post("/internal/declarations/channels").set(KEY).send(channelBody);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ slug: SLUG, declared: true, published: false, visibleToClients: false, channel: null, legs: [] });

    const leg = await request(app)
      .post(`/internal/declarations/channels/${SLUG}/legs`)
      .set(KEY)
      .send({ fromStep: "conversation", toStep: "meeting_booked", mode: "reactive", triggerId: "positive_reply_received", createdBy: "kevin@distribute.you" });
    expect(leg.status).toBe(201);
    expect(leg.body.leg).toMatchObject({ legKey: "conversation_to_meeting_booked", mode: "reactive", triggerId: "positive_reply_received", declared: true, published: false, pricing: { source: "learning", costPerOutcomeUsd: null } });

    const path = await request(app)
      .post("/internal/declarations/sales-paths")
      .set(KEY)
      .send({
        legs: [
          { channelSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation" },
          { channelSlug: SLUG, legKey: "conversation_to_meeting_booked" },
          { channelSlug: "your-team-meeting-attendance", legKey: "meeting_booked_to_meeting_attended" },
          { channelSlug: "your-team-closing-calls", legKey: "meeting_attended_to_paid_client" },
        ],
        createdBy: "kevin@distribute.you",
      });
    expect(path.status).toBe(201);
    expect(path.body.visibleToClients).toBe(false);
    expect(path.body.name).toEqual(expect.any(String));

    // Read back: one channel, its legs, the path.
    const got = await request(app).get(`/internal/declarations/channels/${SLUG}`).set(KEY);
    expect(got.status).toBe(200);
    expect(got.body.channel.stepTransitions).toHaveLength(1);
    const paths = await request(app).get("/internal/declarations/sales-paths").set(KEY);
    expect(paths.body.salesPaths).toHaveLength(1);
    const one = await request(app).get(`/internal/declarations/sales-paths/${encodeURIComponent(path.body.combinationKey)}`).set(KEY);
    expect(one.status).toBe(200);

    // Unpublished: no client sees it.
    expect(await publicSlugs()).not.toContain(SLUG);
    await request(app).patch(`/internal/declarations/channels/${SLUG}`).set(KEY).send({ published: true, updatedBy: "kevin@distribute.you" }).expect(200);
    // The channel alone is not enough: its leg is still unpublished.
    expect(await publicSlugs()).not.toContain(SLUG);
    const pubLeg = await request(app)
      .patch(`/internal/declarations/channels/${SLUG}/legs/conversation_to_meeting_booked`)
      .set(KEY)
      .send({ published: true, updatedBy: "kevin@distribute.you" });
    expect(pubLeg.status).toBe(200);
    expect(pubLeg.body.leg.visibleToClients).toBe(true);
    expect(await publicSlugs()).toContain(SLUG);
    const after = await request(app).get("/internal/declarations/sales-paths").set(KEY);
    expect(after.body.salesPaths[0].visibleToClients).toBe(true);
  });

  it("refuses a leg on a trigger nothing fires; a declared delay trigger is fired, malformed params refused", async () => {
    await request(app).post("/internal/declarations/channels").set(KEY).send(channelBody).expect(201);
    const res = await request(app)
      .post(`/internal/declarations/channels/${SLUG}/legs`)
      .set(KEY)
      .send({ fromStep: "meeting_booked", toStep: "meeting_attended", mode: "reactive", triggerId: "meeting_booked", createdBy: "kevin@distribute.you" });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("trigger_not_fired");
    expect(mem.legs).toHaveLength(0);

    // A declared time-based trigger is fired by campaign-service's generic delay detector (#601): a leg may name it.
    const t = await request(app)
      .post("/internal/declarations/trigger-types")
      .set(KEY)
      .send({ id: "no_reply_after_3_days", label: "No reply in 3 days", description: "Nobody replied within 3 days.", icon: "clock", kind: "delay", params: { afterStep: "lead_found", days: 3 }, createdBy: "kevin@distribute.you" });
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ origin: "declared", kind: "delay", coded: true, firedBy: "campaign-service" });
    const onDelay = await request(app)
      .post(`/internal/declarations/channels/${SLUG}/legs`)
      .set(KEY)
      .send({ fromStep: "lead_found", toStep: "conversation", mode: "reactive", triggerId: "no_reply_after_3_days", createdBy: "kevin@distribute.you" });
    expect(onDelay.status).toBe(201);
    expect(onDelay.body.leg).toMatchObject({ legKey: "lead_found_to_conversation", mode: "reactive", triggerId: "no_reply_after_3_days" });

    // Malformed params never reach a detector.
    const bad = await request(app)
      .post("/internal/declarations/trigger-types")
      .set(KEY)
      .send({ id: "broken_delay", label: "Broken", description: "x", icon: "clock", kind: "delay", params: { afterStep: "lead_found", days: 0 }, createdBy: "kevin@distribute.you" });
    expect(bad.status).toBe(400);
    expect(bad.body.reason).toBe("delay_days_invalid");
    expect(mem.triggers.some((x) => x.id === "broken_delay")).toBe(false);
  });

  it("a channel stated in code is read-only here", async () => {
    const res = await request(app).patch("/internal/declarations/channels/sales-cold-email-outreach").set(KEY).send({ name: "x", updatedBy: "kevin" });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("channel_coded");
    const list = await request(app).get("/internal/declarations/channels").set(KEY);
    expect(list.body.channels.find((c: { slug: string }) => c.slug === "sales-cold-email-outreach")).toMatchObject({ declared: false, published: true, visibleToClients: true });
  });
});
