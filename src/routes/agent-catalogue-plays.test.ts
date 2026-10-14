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
const { __setCatalogueMeasurementsForTest, __awaitCatalogueMeasurementsForTest, funnelCopiesFor } = await import("./agent-catalogue.js");
const { FAMILY_WORDS } = await import("../lib/sales-path-names.js");
const { PIPE_BIRD_WORDS, PATH_RIVER_WORDS } = await import("../lib/catalogue-names.js");

const { CHANNEL_TRIGGER_TYPES } = await import("../lib/channel-triggers.js");
const KEY = { "x-api-key": "test-key" };
const COLD = "sales-cold-email-outreach|lead_found_to_conversation";
const MEET = "ai-meeting-booking|conversation_to_meeting_booked";


// Tactics, strategies and plays (owner 2026-10-13): the cold email pipe catalogues Valid only (default) and
// Valid + Catch-all; Jev judged orion "no" and nova (a catch-all copy) "yes".
const seedPlays = () => [
  { pipeId: "sales-cold-email-outreach|lead_found_to_conversation", strategyId: "valid-only", isDefault: true },
  { pipeId: "sales-cold-email-outreach|lead_found_to_conversation", strategyId: "valid-catch-all", isDefault: false },
];
const playState = vi.hoisted(() => ({ verdicts: [] as any[], added: [] as any[], seeded: [] as any[], sweeps: [] as any[], strategyEdits: new Map<string, any>() }));
vi.mock("../lib/plays-store.js", async () => {
  const { buildPlayCatalogue } = await import("../lib/plays.js");
  const tactics = [
    { id: "catch-all", name: "Catch-all", description: "Sends to addresses whose mail server accepts every address, so the mailbox cannot be confirmed.", createdBy: "t", createdAt: "" },
    { id: "unknown-email", name: "Unknown email", description: "Keeps addresses the verifier could not judge.", createdBy: "t", createdAt: "" },
  ];
  const strategies = [
    { id: "valid-only", name: "Valid only", description: "only confirmed", requiresTacticIds: [], excludesTacticIds: ["catch-all"], createdBy: "t", createdAt: "" },
    { id: "valid-catch-all", name: "Valid + Catch-all", description: "confirmed and catch-all", requiresTacticIds: ["catch-all"], excludesTacticIds: [], createdBy: "t", createdAt: "" },
  ];
  const plays = playState.seeded;
  const strategiesNow = () => strategies.map((st) => playState.strategyEdits.get(st.id) ?? st);
  return {
    loadPlayCatalogue: async () => buildPlayCatalogue({ tactics, strategies: strategiesNow(), plays: [...plays, ...playState.added], verdicts: playState.verdicts, sweeps: playState.sweeps }),
    // The store's own rules are covered in lib/plays-store-strategy-edit.test.ts; here only the route's.
    proposeStrategyEdit: vi.fn(async (input: any) => {
      const { DeclarationError } = await import("../lib/channel-declarations.js");
      const current = strategiesNow().find((x) => x.id === input.id);
      if (!current) throw new DeclarationError(404, "strategy_not_found", `no strategy ${input.id}`);
      const next = { ...current, description: input.description ?? current.description, requiresTacticIds: [...(input.requiresTacticIds ?? current.requiresTacticIds)].sort(), excludesTacticIds: [...(input.excludesTacticIds ?? current.excludesTacticIds)].sort() };
      const changed = JSON.stringify(next) !== JSON.stringify(current);
      return { current, next: changed ? next : current, changed };
    }),
    storeStrategyEdit: vi.fn(async (next: any, updatedBy: string) => {
      const stored = { ...next, updatedBy, updatedAt: "2026-10-14T10:00:00.000Z" };
      playState.strategyEdits.set(next.id, stored);
      return stored;
    }),
    invalidatePlayCatalogue: () => {},
    listVerdicts: async () => playState.verdicts,
    insertTactic: vi.fn(),
    updateTacticDescription: vi.fn(async (input: { id: string; description: string; updatedBy: string }) => {
      const { DeclarationError } = await import("../lib/channel-declarations.js");
      const t = tactics.find((x) => x.id === input.id);
      if (!t) throw new DeclarationError(404, "tactic_not_found", `no tactic ${input.id}`);
      if (input.description.toLowerCase() === "taken elsewhere.") throw new DeclarationError(409, "tactic_description_taken", "the tactic other already has this description");
      const previousDescription = t.description;
      if (previousDescription === input.description) return { tactic: t, changed: false, previousDescription };
      return { tactic: { ...t, description: input.description, updatedBy: input.updatedBy, updatedAt: "2026-10-14T08:00:00.000Z" }, changed: true, previousDescription };
    }),
    insertStrategy: vi.fn(),
    insertPlay: vi.fn(async (input: { pipeId: string; strategyId: string; isDefault?: boolean }) => {
      const all = [...plays, ...playState.added];
      let defaultChanged = false;
      if (input.isDefault) {
        defaultChanged = !all.some((p) => p.pipeId === input.pipeId && p.isDefault && p.strategyId === input.strategyId);
        if (defaultChanged) for (const p of all) if (p.pipeId === input.pipeId) p.isDefault = p.strategyId === input.strategyId;
      }
      if (all.some((p) => p.pipeId === input.pipeId && p.strategyId === input.strategyId)) return { created: false, defaultChanged };
      playState.added.push({ pipeId: input.pipeId, strategyId: input.strategyId, isDefault: input.isDefault === true });
      return { created: true, defaultChanged };
    }),
    insertVerdict: vi.fn(),
    refreshVersionActive: vi.fn(),
  };
});

// The figures build prices each play on its first ALLOWED dynasty among nova (a catch-all copy) then orion.
vi.mock("./public.js", async (importOriginal) => {
  const price = (w: string | null) => ({ basis: "mature", costPerOutcomeUsd: 1, conversionRatePct: 1, workflowDynastySlug: w });
  const order = ["nova", "orion"];
  return {
    ...(await importOriginal<typeof import("./public.js")>()),
    fleetLegPrice: vi.fn(async () => price(order[0])),
    fleetPlayPrices: vi.fn(async (_s: string, _l: string, exclusions: (d: readonly string[]) => ReadonlyArray<ReadonlySet<string>>) =>
      exclusions(order).map((ex) => price(order.find((d) => !ex.has(d)) ?? null)),
    ),
  };
});

const CATCH = `${COLD}~valid-catch-all`;
const verdict = (slug: string, dynasty: string, follows: boolean, tacticId = "catch-all") => ({ workflowSlug: slug, tacticId, workflowDynastySlug: dynasty, version: 1, versionActive: true, verdict: follows, probability: follows ? 0.9 : 0.05, model: "m", judgedAt: "" });

beforeEach(async () => {
  // A play write rebuilds the figures behind the request: the previous test's rebuild lands before this one seeds.
  await __awaitCatalogueMeasurementsForTest();
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
  playState.added = [];
  playState.sweeps = [];
  playState.strategyEdits = new Map();
  playState.seeded.splice(0, playState.seeded.length, ...seedPlays());
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
    expect(t.body.rows).toEqual([
      expect.objectContaining({ id: "catch-all", name: "Catch-all", workflowsJudged: 1, workflowsFollowing: 0 }),
      expect.objectContaining({ id: "unknown-email", name: "Unknown email", workflowsJudged: 0 }),
    ]);
    const s = await request(app).get("/internal/catalogue/strategies").set(KEY);
    expect(s.body.rows.map((r: any) => [r.id, r.requires.map((x: any) => x.id), r.excludes.map((x: any) => x.id)])).toEqual([
      ["valid-catch-all", ["catch-all"], []],
      ["valid-only", [], ["catch-all"]],
    ]);
  });

  it("the pipe lists its plays; the DEFAULT play is the pipe itself, figure for figure", async () => {
    const pipe = (await request(app).get(`/internal/catalogue/pipes/${encodeURIComponent(COLD)}`).set(KEY)).body;
    expect(pipe.play).toMatchObject({ strategyId: "valid-only", strategyDescription: "only confirmed", default: true, allowedActiveWorkflowCount: 1 });
    const [def, catchAll] = pipe.plays;
    expect(def).toMatchObject({ id: COLD, strategyId: "valid-only", strategyDescription: "only confirmed", default: true, costUsd: pipe.costUsd, roi: pipe.roi, status: pipe.status, runnable: true });
    // Nothing judged Catch-all yet: the play has no workflow to run, so it is learning and never runnable.
    expect(catchAll).toMatchObject({ id: CATCH, strategyId: "valid-catch-all", strategyDescription: "confirmed and catch-all", default: false, status: "learning", costUsd: null, allowedActiveWorkflowCount: 0, runnable: false });
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

  it("a funnel through a non-default play has its customer COPY (type, path), as a running funnel campaign reads it", async () => {
    const pipeIds = ["lead-sourcing|start_to_lead_found", CATCH, MEET, "your-team-meeting-attendance|meeting_booked_to_meeting_attended", "your-team-closing-calls|meeting_attended_to_paid_client"];
    const created = await request(app).post("/internal/catalogue/sales-funnels").set(KEY).send({ pipeIds, createdBy: "test" });
    expect(created.status).toBe(201);
    expect(created.body.id).toContain("~valid-catch-all");
    const { copies, pathOf } = await funnelCopiesFor([created.body.id]);
    const copy = copies.get(created.body.id);
    expect(copy).toMatchObject({ name: created.body.name, type: "proactive" });
    const path = pathOf(created.body.id);
    expect(path).not.toBeNull();
    expect(path!.items.filter((i) => i.kind === "channel").map((i) => (i as { slug: string }).slug)).toEqual(
      expect.arrayContaining(["lead-sourcing", "sales-cold-email-outreach", "ai-meeting-booking"]),
    );
    expect(path!.legs[1]).toMatchObject({ legKey: "lead_found_to_conversation", channelSlug: "sales-cold-email-outreach" });
  });

  it("once a catch-all workflow is judged and assigned, the play runs it and only it", async () => {
    mem.assignments.push({ featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", workflowDynastySlug: "nova", state: "active", decidedBy: "t", decidedAt: "", note: null });
    playState.verdicts.push(verdict("nova-v1", "nova", true));
    const plays = (await request(app).get("/internal/catalogue/plays").query({ pipe: COLD }).set(KEY)).body.rows;
    expect(plays.map((p: any) => [p.id, p.allowedActiveWorkflowCount, p.runnable])).toEqual([
      [COLD, 1, true],
      [CATCH, 1, true],
    ]);
    // WHICH workflows each play may run, on every row (owner ask 2026-10-14).
    expect(plays.map((p: any) => [p.id, p.allowedWorkflowDynastySlugs])).toEqual([
      [COLD, ["orion"]],
      [CATCH, ["nova"]],
    ]);
    const detail = (await request(app).get(`/internal/catalogue/plays/${encodeURIComponent(CATCH)}`).set(KEY)).body;
    expect(detail.excludedWorkflowDynastySlugs).toEqual(["orion"]);
    // Each allowed workflow with its fleet figure, beside what the pipe's default play runs today.
    expect(detail.allowedWorkflows.map((w: any) => [w.id, typeof w.status, w.isDefaultPlayPick])).toEqual([["nova", "string", false]]);
    expect(detail.defaultPlayPick).toMatchObject({ playId: COLD, bestWorkflowSlug: "orion" });
  });

  it("a play running nothing says why (judging failing / pending / judged out), and its detail lists the funnels carrying it (owner 2026-10-14)", async () => {
    const catchRow = async () => (await request(app).get("/internal/catalogue/plays").query({ pipe: COLD }).set(KEY)).body.rows.find((r: any) => r.id === CATCH);
    // orion is judged NOT catch-all: nothing can ever fit Valid + Catch-all until a workflow following it is built.
    expect(await catchRow()).toMatchObject({ runnable: false, notRunnableReason: "no_workflow_follows_strategy" });
    // orion not judged at all, and the last sweep failed: Jev is down, judging resumes by itself.
    playState.verdicts = [];
    playState.sweeps = [{ tacticId: "catch-all", judgedDescription: "Sends to addresses whose mail server accepts every address, so the mailbox cannot be confirmed.", sweptAt: "2026-10-14T09:00:00.000Z", versions: 1, judged: 0, failed: 1, lastFailure: "chat-service platform-judgments 502", lastFailureAt: "2026-10-14T09:00:00.000Z" }];
    const failing = await catchRow();
    expect(failing).toMatchObject({ runnable: false, notRunnableReason: "judging_failing" });
    expect(failing.notRunnableDetail).toContain("chat-service platform-judgments 502");
    const tactic = (await request(app).get("/internal/catalogue/tactics/catch-all").set(KEY)).body;
    expect(tactic.judging).toMatchObject({ status: "failing", versionsFailed: 1, nextSweepAt: "2026-10-14T09:15:00.000Z" });
    // Never swept on these words yet: still judging.
    playState.sweeps = [];
    expect(await catchRow()).toMatchObject({ notRunnableReason: "judging_pending" });
    expect((await request(app).get("/internal/catalogue/tactics/catch-all").set(KEY)).body.judging.status).toBe("judging");
    // The play's detail names the funnels carrying it, runnable or not: an agent never hand-builds a funnel id.
    const detail = (await request(app).get(`/internal/catalogue/plays/${encodeURIComponent(CATCH)}`).set(KEY)).body;
    expect(detail.salesFunnels.total).toBeGreaterThan(0);
    expect(detail.salesFunnels.rows[0].id).toContain("@sales-cold-email-outreach~valid-catch-all");
    // Mixed funnels are left out (never runnable); each row says why it waits.
    expect(detail.salesFunnels.rows.every((r: any) => r.runnable === false && r.notRunnableReason === "judging_pending")).toBe(true);
    const read = await request(app).get(`/internal/catalogue/sales-funnels/${encodeURIComponent(detail.salesFunnels.rows[0].id)}`).set(KEY);
    expect(read.status).toBe(200);
  });

  it("a play is added to a pipe that catalogues none yet: its default stays every assigned workflow, the play narrows it", async () => {
    const VISIT = "sales-cold-email-outreach|lead_found_to_website_visit";
    mem.assignments.push(
      { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_website_visit", workflowDynastySlug: "orion", state: "active", decidedBy: "t", decidedAt: "", note: null },
      { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_website_visit", workflowDynastySlug: "nova", state: "active", decidedBy: "t", decidedAt: "", note: null },
    );
    playState.verdicts.push(verdict("nova-v1", "nova", true));
    const created = await request(app).post("/internal/catalogue/plays").set(KEY).send({ pipeId: VISIT, strategyId: "valid-catch-all", createdBy: "test" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ created: true, id: `${VISIT}~valid-catch-all`, strategyId: "valid-catch-all", default: false, allowedActiveWorkflowCount: 1 });
    const plays = (await request(app).get("/internal/catalogue/plays").query({ pipe: VISIT }).set(KEY)).body.rows;
    expect(plays.map((p: any) => [p.id, p.strategyId, p.default])).toEqual([
      [VISIT, null, true],
      [`${VISIT}~valid-catch-all`, "valid-catch-all", false],
    ]);
    // Re-adding the same play is idempotent.
    const again = await request(app).post("/internal/catalogue/plays").set(KEY).send({ pipeId: VISIT, strategyId: "valid-catch-all", createdBy: "test" });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
  });

  it("staff make a strategy a pipe's DEFAULT play only while it runs one of the pipe's active workflows", async () => {
    const VISIT = "sales-cold-email-outreach|lead_found_to_website_visit";
    const url = `/internal/catalogue/pipes/${encodeURIComponent(VISIT)}/default-play`;
    mem.assignments.push(
      { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_website_visit", workflowDynastySlug: "orion", state: "active", decidedBy: "t", decidedAt: "", note: null },
      { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_website_visit", workflowDynastySlug: "nova", state: "active", decidedBy: "t", decidedAt: "", note: null },
    );
    // nova not judged yet: Valid + Catch-all allows nothing, so it cannot be the default.
    const refused = await request(app).put(url).set(KEY).send({ strategyId: "valid-catch-all", decidedBy: "test" });
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toBe("default_play_runs_nothing");
    expect(playState.added).toEqual([]);

    // Valid only allows orion (judged no on catch-all): it becomes the default, the bare pipe id names it.
    const made = await request(app).put(url).set(KEY).send({ strategyId: "valid-only", decidedBy: "test" });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ created: true, defaultChanged: true, id: VISIT, strategyId: "valid-only", default: true, allowedActiveWorkflowCount: 1 });
    playState.verdicts.push(verdict("nova-v1", "nova", true));
    const added = await request(app).post("/internal/catalogue/plays").set(KEY).send({ pipeId: VISIT, strategyId: "valid-catch-all", createdBy: "test" });
    expect(added.status).toBe(201);
    const plays = (await request(app).get("/internal/catalogue/plays").query({ pipe: VISIT }).set(KEY)).body.rows;
    expect(plays.map((p: any) => [p.id, p.strategyId, p.default, p.allowedActiveWorkflowCount])).toEqual([
      [VISIT, "valid-only", true, 1],
      [`${VISIT}~valid-catch-all`, "valid-catch-all", false, 1],
    ]);
    // Re-stating the same default changes nothing.
    const again = await request(app).put(url).set(KEY).send({ strategyId: "valid-only", decidedBy: "test" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, defaultChanged: false });
  });

  // RANKING-SOURCE-LEG-1014: Lead Sourcing's default was set to Valid only, yet its row kept `bestWorkflowSlug: samaya`
  // (the catch-all copy) for up to 15 min, the figures having been priced before the default existed.
  it("setting a default rebuilds the pipe's figures at once: its best workflow is one the strategy allows", async () => {
    const VISIT = "sales-cold-email-outreach|lead_found_to_website_visit";
    mem.assignments.push(
      { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_website_visit", workflowDynastySlug: "orion", state: "active", decidedBy: "t", decidedAt: "", note: null },
      { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_website_visit", workflowDynastySlug: "nova", state: "active", decidedBy: "t", decidedAt: "", note: null },
    );
    playState.verdicts.push(verdict("nova-v1", "nova", true));
    __setCatalogueMeasurementsForTest(new Map([[VISIT, { basis: "mature", costPerOutcomeUsd: 1, conversionRatePct: 1, workflowDynastySlug: "nova" }]]), new Map());
    const before = (await request(app).get("/internal/catalogue/plays").query({ pipe: VISIT }).set(KEY)).body.rows;
    expect(before[0].bestWorkflowSlug).toBe("nova");

    const made = await request(app).put(`/internal/catalogue/pipes/${encodeURIComponent(VISIT)}/default-play`).set(KEY).send({ strategyId: "valid-only", decidedBy: "test" });
    expect(made.status).toBe(200);
    await __awaitCatalogueMeasurementsForTest();
    const after = (await request(app).get("/internal/catalogue/plays").query({ pipe: VISIT }).set(KEY)).body.rows;
    expect(after.map((p: any) => [p.id, p.strategyId, p.bestWorkflowSlug])).toEqual([[VISIT, "valid-only", "orion"]]);

    // The catch-all play, catalogued next, is priced on nova at once too.
    await request(app).post("/internal/catalogue/plays").set(KEY).send({ pipeId: VISIT, strategyId: "valid-catch-all", createdBy: "test" });
    await __awaitCatalogueMeasurementsForTest();
    const plays = (await request(app).get("/internal/catalogue/plays").query({ pipe: VISIT }).set(KEY)).body.rows;
    expect(plays.map((p: any) => [p.strategyId, p.bestWorkflowSlug])).toEqual([["valid-only", "orion"], ["valid-catch-all", "nova"]]);
  });

  it("the public play create never touches the default", async () => {
    const res = await request(app).post("/internal/catalogue/plays").set(KEY).send({ pipeId: COLD, strategyId: "valid-catch-all", default: true, createdBy: "test" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: false, default: false });
    const plays = (await request(app).get("/internal/catalogue/plays").query({ pipe: COLD }).set(KEY)).body.rows;
    expect(plays.map((p: any) => [p.strategyId, p.default])).toEqual([["valid-only", true], ["valid-catch-all", false]]);
  });

  it("a tactic's description is edited (owner 2026-10-14): unique, and every workflow version is re-judged on the new words", async () => {
    const { kickTacticJudgments } = await import("../lib/tactic-judgments.js");
    const kick = vi.mocked(kickTacticJudgments);
    kick.mockClear();
    const url = "/internal/catalogue/tactics/catch-all";
    const words = "Keeps or sends to people whose email is catch-all.";
    const edited = await request(app).patch(url).set(KEY).send({ description: words, updatedBy: "user:u1" });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ id: "catch-all", name: "Catch-all", description: words, changed: true, updatedBy: "user:u1" });
    expect(edited.body.previousDescription).toContain("Sends to addresses");
    // Kicked, then once more (a sweep in flight read the old text), then the pipe figures rebuild.
    await vi.waitFor(() => expect(kick).toHaveBeenCalledTimes(2));

    // The stored text again: nothing to re-judge.
    const same = await request(app).patch(url).set(KEY).send({ description: "Sends to addresses whose mail server accepts every address, so the mailbox cannot be confirmed.", updatedBy: "user:u1" });
    expect(same.status).toBe(200);
    expect(same.body.changed).toBe(false);
    expect(kick).toHaveBeenCalledTimes(2);

    const taken = await request(app).patch(url).set(KEY).send({ description: "Taken elsewhere.", updatedBy: "user:u1" });
    expect(taken.status).toBe(409);
    expect(taken.body.reason).toBe("tactic_description_taken");
    expect((await request(app).patch("/internal/catalogue/tactics/nope").set(KEY).send({ description: words, updatedBy: "u" })).status).toBe(404);
    expect((await request(app).patch(url).set(KEY).send({ description: "  ", updatedBy: "u" })).body.reason).toBe("description_required");
    expect((await request(app).patch(url).set(KEY).send({ description: words })).body.reason).toBe("updatedBy_required");
  });

  it("an unknown pipe is 404", async () => {
    const res = await request(app).put(`/internal/catalogue/pipes/${encodeURIComponent("nope|start_to_lead_found")}/default-play`).set(KEY).send({ strategyId: "valid-only", decidedBy: "test" });
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("pipe_not_found");
  });
});

// STRATEGY-EDIT-PUBLIC-1014: a new tactic (unknown-email) leaked into older strategies naming nothing about it.
describe("a strategy's rule is edited (staff), and its plays narrow at once", () => {
  const assign = (dynasty: string) => ({ featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", workflowDynastySlug: dynasty, state: "active", decidedBy: "t", decidedAt: "", note: null });
  beforeEach(() => {
    // orion: confirmed only; nova: catch-all; nebula: catch-all AND unknown emails. Every one judged on both tactics.
    mem.assignments = [assign("orion"), assign("nova"), assign("nebula")];
    playState.verdicts = [
      verdict("orion-v1", "orion", false),
      verdict("orion-v1", "orion", false, "unknown-email"),
      verdict("nova-v1", "nova", true),
      verdict("nova-v1", "nova", false, "unknown-email"),
      verdict("nebula-v1", "nebula", true),
      verdict("nebula-v1", "nebula", true, "unknown-email"),
    ];
  });
  const allowed = async () =>
    (await request(app).get("/internal/catalogue/plays").query({ pipe: COLD }).set(KEY)).body.rows.map((p: any) => [p.strategyId, p.allowedActiveWorkflowCount]);

  it("Valid + Catch-all excludes unknown-email: its play runs the catch-all workflow only", async () => {
    expect(await allowed()).toEqual([["valid-only", 1], ["valid-catch-all", 2]]);
    const res = await request(app).patch("/internal/catalogue/strategies/valid-catch-all").set(KEY).send({ excludes: ["unknown-email"], updatedBy: "staff@distribute.you" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "valid-catch-all",
      changed: true,
      requires: [{ id: "catch-all", name: "Catch-all" }],
      excludes: [{ id: "unknown-email", name: "Unknown email" }],
      previous: { requires: [{ id: "catch-all" }], excludes: [] },
      updatedBy: "staff@distribute.you",
    });
    expect(await allowed()).toEqual([["valid-only", 1], ["valid-catch-all", 1]]);
    const detail = (await request(app).get(`/internal/catalogue/plays/${encodeURIComponent(CATCH)}`).set(KEY)).body;
    expect(detail.excludedWorkflowDynastySlugs.sort()).toEqual(["nebula", "orion"]);

    // The same rule again: nothing stored.
    const same = await request(app).patch("/internal/catalogue/strategies/valid-catch-all").set(KEY).send({ excludes: ["unknown-email"], updatedBy: "staff@distribute.you" });
    expect(same.body.changed).toBe(false);
  });

  it("the DEFAULT play keeps running: an edit leaving it no active workflow is refused, nothing stored", async () => {
    const ok = await request(app).patch("/internal/catalogue/strategies/valid-only").set(KEY).send({ excludes: ["catch-all", "unknown-email"], updatedBy: "staff@distribute.you" });
    expect(ok.status).toBe(200);
    expect(ok.body.excludes.map((t: any) => t.id)).toEqual(["catch-all", "unknown-email"]);
    expect(await allowed()).toEqual([["valid-only", 1], ["valid-catch-all", 2]]);

    const refused = await request(app).patch("/internal/catalogue/strategies/valid-only").set(KEY).send({ requires: ["unknown-email"], excludes: ["catch-all"], updatedBy: "staff@distribute.you" });
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toBe("default_play_runs_nothing");
    expect(playState.strategyEdits.get("valid-only").requiresTacticIds).toEqual([]);
  });

  it("refuses an empty edit and a missing author", async () => {
    const empty = await request(app).patch("/internal/catalogue/strategies/valid-only").set(KEY).send({ updatedBy: "x" });
    expect(empty.status).toBe(400);
    expect(empty.body.reason).toBe("edit_empty");
    const noAuthor = await request(app).patch("/internal/catalogue/strategies/valid-only").set(KEY).send({ excludes: ["catch-all"] });
    expect(noAuthor.status).toBe(400);
    const missing = await request(app).patch("/internal/catalogue/strategies/nope").set(KEY).send({ excludes: ["catch-all"], updatedBy: "x" });
    expect(missing.status).toBe(404);
  });
});
