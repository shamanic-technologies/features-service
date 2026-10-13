import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } }, sql: {} }));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({
  default: { setupExpressErrorHandler: vi.fn() },
  setupExpressErrorHandler: vi.fn(),
}));

// The names table, in memory, with the REAL family assignment (`nextNamesForKeys`).
const names = vi.hoisted(() => ({ rows: new Map<string, string>() }));
vi.mock("../lib/sales-path-names.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/sales-path-names.js")>();
  return {
    ...real,
    allNamesByKey: async () => new Map(names.rows),
    salesPathNamesFor: async (keys: readonly string[]) => {
      const missing = keys.filter((k) => !names.rows.has(k));
      const words = real.nextNamesForKeys(missing, new Set(names.rows.values()));
      missing.forEach((k, i) => names.rows.set(k, words[i]));
      return new Map(keys.map((k) => [k, names.rows.get(k)!]));
    },
    withCampaignNames: async (channels: unknown[]) => channels,
  };
});

vi.mock("../lib/effective-conversion-rates.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFleetArrowMedians: async () => new Map(),
  getFleetLifetimeRevenueMedian: async () => ({ usd: 3000, offerCount: 12 }),
  peekFleetStatedMedians: () => null,
  // One brand's own rates: conversation -> meeting booked MEASURED at 50%, meeting attended -> paid STATED at 40%.
  getBrandEffectiveRates: async () => ({
    legs: [
      { fromStep: "Positive reply", toStep: "Meeting booked", effectiveRatePct: 50, source: "measured" },
      { fromStep: "Meeting attended", toStep: "Paid client", effectiveRatePct: 40, source: "manual" },
      { fromStep: "Meeting booked", toStep: "Meeting attended", effectiveRatePct: 75, source: "default" },
    ],
  }),
}));
vi.mock("../lib/brand-leg-economics-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchBrandLegEconomics: async () => ({ legRates: [], offers: [{ offerId: "offer-1", lifetimeRevenueUsd: 12000 }] }),
}));

// The steps the offer's business has (brand-service): never stated by default, so every per-offer read keeps today's list.
const offerSteps = vi.hoisted(() => ({ value: { stated: false, steps: null as string[] | null, statedAt: null as string | null }, fail: false }));
vi.mock("../lib/offer-steps-client.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/offer-steps-client.js")>();
  return {
    ...real,
    fetchOfferSteps: async (_b: string, offerId: string) => {
      if (offerSteps.fail) throw new real.OfferStepsUnreadableError("brand-service offer steps read failed (503): down");
      return { offerId, ...offerSteps.value };
    },
  };
});

const pipeStats = vi.hoisted(() => ({ get: null as null | ((...a: unknown[]) => Promise<unknown>) }));
vi.mock("../lib/pipe-stats.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPipeStats: (...a: unknown[]) => pipeStats.get!(...a),
}));

const mem = vi.hoisted(() => ({ legs: [] as any[], steps: [] as any[], rates: [] as any[], chains: [] as any[], paths: [] as any[], triggers: [] as any[], assignments: [] as any[] }));
vi.mock("../lib/workflow-leg-assignments.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listLegAssignments: async () => mem.assignments,
}));
vi.mock("../lib/channel-declarations-store.js", async () => {
  const { mergeDeclarations } = await import("../lib/channel-declarations.js");
  const { buildChannelCatalogue } = await import("../lib/channel-catalogue.js");
  const { channelShortDescription } = await import("../lib/channel-short-descriptions.js");
  const { channelTypeOf } = await import("../lib/channel-types.js");
  const { registerDeclaredSteps } = await import("../lib/acquisition-channels.js");
  const { registerDeclaredLegRates } = await import("../lib/default-leg-rates.js");
  const { SEED_FEATURES } = await import("../seed/features.js");
  const seeded = SEED_FEATURES.filter((f) => f.status === "active");
  const register = async () => {
    registerDeclaredSteps(mem.steps);
    registerDeclaredLegRates([...mem.steps.map((s) => ({ fromStep: s.key, toStep: s.towardStep, ratePct: s.towardRatePct })), ...mem.rates]);
    return { steps: mem.steps, rates: mem.rates };
  };
  return {
    listTriggerTypes: async () => mem.triggers,
    listDeclaredChannels: async () => [],
    listDeclaredLegs: async () => mem.legs,
    listDeclaredSalesPaths: async () => mem.paths,
    listDeclaredSteps: async () => mem.steps,
    listDeclaredSalesPathChains: async () => mem.chains,
    registerStepDeclarations: register,
    loadChannelCatalogue: async (opts: { publishedOnly: boolean }) => {
      await register();
      const declared = { channels: [], legs: mem.legs, triggers: [] };
      const m = mergeDeclarations(seeded, declared, opts, { shortDescriptionOf: channelShortDescription, channelTypeOfSlug: channelTypeOf });
      return { channels: buildChannelCatalogue(m.rows, m.shortDescriptionOf, m.channelTypeOfSlug, m.triggerOf), declared };
    },
    insertLeg: async (channelSlug: string, input: any, createdBy: string) => {
      // Live at creation (owner 2026-10-12), as the store writes it.
      const row = { channelSlug, ...input, published: true, createdBy, requestedByOrgId: null, createdAt: "", updatedAt: "" };
      mem.legs.push(row);
      return row;
    },
    insertLegRate: async (rate: any) => void mem.rates.push(rate),
    insertStep: async (input: any) => {
      const row = { ...input, createdAt: "" };
      mem.steps.push(row);
      return row;
    },
    insertSalesPathChain: async (pathId: string, legKeys: string[], createdBy: string) => {
      const row = { pathId, legKeys, createdBy, requestedByOrgId: null, createdAt: "" };
      mem.chains.push(row);
      return row;
    },
    insertSalesPath: async (combinationKey: string, legs: any[], createdBy: string) => {
      const row = { combinationKey, legs, createdBy, requestedByOrgId: null, createdAt: "" };
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
const { __setCatalogueMeasurementsForTest } = await import("./agent-catalogue.js");
const { FAMILY_WORDS } = await import("../lib/sales-path-names.js");
const { PIPE_BIRD_WORDS, PATH_RIVER_WORDS } = await import("../lib/catalogue-names.js");

const { CHANNEL_TRIGGER_TYPES } = await import("../lib/channel-triggers.js");
const KEY = { "x-api-key": "test-key" };
const COLD = "sales-cold-email-outreach|lead_found_to_conversation";
const MEET = "ai-meeting-booking|conversation_to_meeting_booked";


// Tactics, strategies and plays (owner 2026-10-13): the cold email pipe catalogues Valid only (default) and
// Valid + Catch-all; Jev judged orion "no" and nova (a catch-all copy) "yes".
const playState = vi.hoisted(() => ({ verdicts: [] as any[] }));
vi.mock("../lib/plays-store.js", async () => {
  const { buildPlayCatalogue } = await import("../lib/plays.js");
  const tactics = [{ id: "catch-all", name: "Catch-all", description: "Sends to addresses whose mail server accepts every address, so the mailbox cannot be confirmed.", createdBy: "t", createdAt: "" }];
  const strategies = [
    { id: "valid-only", name: "Valid only", description: "only confirmed", requiresTacticIds: [], excludesTacticIds: ["catch-all"], createdBy: "t", createdAt: "" },
    { id: "valid-catch-all", name: "Valid + Catch-all", description: "confirmed and catch-all", requiresTacticIds: ["catch-all"], excludesTacticIds: [], createdBy: "t", createdAt: "" },
  ];
  const plays = [
    { pipeId: "sales-cold-email-outreach|lead_found_to_conversation", strategyId: "valid-only", isDefault: true },
    { pipeId: "sales-cold-email-outreach|lead_found_to_conversation", strategyId: "valid-catch-all", isDefault: false },
  ];
  return {
    loadPlayCatalogue: async () => buildPlayCatalogue({ tactics, strategies, plays, verdicts: playState.verdicts }),
    invalidatePlayCatalogue: () => {},
    listVerdicts: async () => playState.verdicts,
    insertTactic: vi.fn(),
    insertStrategy: vi.fn(),
    insertPlay: vi.fn(async () => ({ created: false })),
    insertVerdict: vi.fn(),
    refreshVersionActive: vi.fn(),
  };
});

const CATCH = `${COLD}~valid-catch-all`;
const verdict = (slug: string, dynasty: string, follows: boolean) => ({ workflowSlug: slug, tacticId: "catch-all", workflowDynastySlug: dynasty, version: 1, versionActive: true, verdict: follows, probability: follows ? 0.9 : 0.05, model: "m", judgedAt: "" });

beforeEach(() => {
  names.rows = new Map();
  mem.legs = [];
  mem.steps = [];
  mem.rates = [];
  mem.chains = [];
  mem.paths = [];
  mem.triggers = [];
  mem.assignments = [
    { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", workflowDynastySlug: "orion", state: "active", decidedBy: "t", decidedAt: "", note: null },
  ];
  playState.verdicts = [verdict("orion-v1", "orion", false)];
  __setCatalogueMeasurementsForTest(
    new Map([
      [COLD, { basis: "mature", costPerOutcomeUsd: 40, conversionRatePct: 1, workflowDynastySlug: "orion" }],
      [MEET, { basis: "mature", costPerOutcomeUsd: 2, conversionRatePct: 30, workflowDynastySlug: "vega" }],
      ["lead-sourcing|start_to_lead_found", { basis: "mature", costPerOutcomeUsd: 0.5, conversionRatePct: 100, workflowDynastySlug: "lead-sourcing-scheat" }],
    ]),
    new Map(),
  );
});

describe("plays (owner 2026-10-13): a pipe x a strategy, ROI per play", () => {
  it("serves tactics and strategies with their unique names and descriptions", async () => {
    const t = await request(app).get("/internal/catalogue/tactics").set(KEY);
    expect(t.status).toBe(200);
    expect(t.body.rows).toEqual([expect.objectContaining({ id: "catch-all", name: "Catch-all", workflowsJudged: 1, workflowsFollowing: 0 })]);
    const s = await request(app).get("/internal/catalogue/strategies").set(KEY);
    expect(s.body.rows.map((r: any) => [r.id, r.requires.map((x: any) => x.id), r.excludes.map((x: any) => x.id)])).toEqual([
      ["valid-catch-all", ["catch-all"], []],
      ["valid-only", [], ["catch-all"]],
    ]);
  });

  it("the pipe lists its plays; the DEFAULT play is the pipe itself, figure for figure", async () => {
    const pipe = (await request(app).get(`/internal/catalogue/pipes/${encodeURIComponent(COLD)}`).set(KEY)).body;
    expect(pipe.play).toMatchObject({ strategyId: "valid-only", default: true, allowedActiveWorkflowCount: 1 });
    const [def, catchAll] = pipe.plays;
    expect(def).toMatchObject({ id: COLD, strategyId: "valid-only", default: true, costUsd: pipe.costUsd, roi: pipe.roi, status: pipe.status, runnable: true });
    // Nothing judged Catch-all yet: the play has no workflow to run, so it is learning and never runnable.
    expect(catchAll).toMatchObject({ id: CATCH, strategyId: "valid-catch-all", default: false, status: "learning", costUsd: null, allowedActiveWorkflowCount: 0, runnable: false });
  });

  it("a play id answers like its pipe (campaign-service reads a funnel's legs through it); an unknown strategy is a 404", async () => {
    const res = await request(app).get(`/internal/catalogue/pipes/${encodeURIComponent(CATCH)}`).set(KEY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: CATCH, channelSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", mode: "proactive", play: { strategyId: "valid-catch-all", default: false } });
    expect((await request(app).get(`/internal/catalogue/pipes/${encodeURIComponent(`${COLD}~telepathy`)}`).set(KEY)).status).toBe(404);
    // Naming the default strategy explicitly is the pipe itself.
    expect((await request(app).get(`/internal/catalogue/pipes/${encodeURIComponent(`${COLD}~valid-only`)}`).set(KEY)).body.id).toBe(COLD);
  });

  it("a funnel through a non-default play is its OWN funnel, its own id and name; the default play keeps the bare id", async () => {
    const pipeIds = ["lead-sourcing|start_to_lead_found", CATCH, MEET, "your-team-meeting-attendance|meeting_booked_to_meeting_attended", "your-team-closing-calls|meeting_attended_to_paid_client"];
    const created = await request(app).post("/internal/catalogue/sales-funnels").set(KEY).send({ pipeIds, createdBy: "test" });
    expect(created.status).toBe(201);
    expect(created.body.id).toBe("start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach~valid-catch-all+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client");
    expect(created.body.legs[1].pipe.id).toBe(CATCH);
    const plain = await request(app).post("/internal/catalogue/sales-funnels").set(KEY).send({ pipeIds: pipeIds.map((p) => (p === CATCH ? COLD : p)), createdBy: "test" });
    expect(plain.body.id).toBe(created.body.id.replace("~valid-catch-all", ""));
    expect(plain.body.name).not.toBe(created.body.name);
    // The funnel id read back (encoded, as campaign-service and billing read it) is the same funnel.
    const read = await request(app).get(`/internal/catalogue/sales-funnels/${encodeURIComponent(created.body.id)}`).set(KEY);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: created.body.id, name: created.body.name, runnable: false });
    // `~valid-only` spelled out is the bare funnel.
    const explicit = await request(app).get(`/internal/catalogue/sales-funnels/${encodeURIComponent(plain.body.id.replace("@sales-cold-email-outreach", "@sales-cold-email-outreach~valid-only"))}`).set(KEY);
    expect(explicit.body.id).toBe(plain.body.id);
  });

  it("once a catch-all workflow is judged and assigned, the play runs it and only it", async () => {
    mem.assignments.push({ featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", workflowDynastySlug: "nova", state: "active", decidedBy: "t", decidedAt: "", note: null });
    playState.verdicts.push(verdict("nova-v1", "nova", true));
    const plays = (await request(app).get("/internal/catalogue/plays").query({ pipe: COLD }).set(KEY)).body.rows;
    expect(plays.map((p: any) => [p.id, p.allowedActiveWorkflowCount, p.runnable])).toEqual([
      [COLD, 1, true],
      [CATCH, 1, true],
    ]);
    const detail = (await request(app).get(`/internal/catalogue/plays/${encodeURIComponent(CATCH)}`).set(KEY)).body;
    expect(detail.excludedWorkflowDynastySlugs).toEqual(["orion"]);
  });
});
