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

beforeEach(() => {
  names.rows = new Map([
    // Stored under its Lead Sourcing spelling (the boot re-key moved it, lib/lead-sourcing-key-migration.ts).
    ["start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client", "Victory"],
    ["campaign:ai-meeting-booking|conversation_to_meeting_booked", "Prism"],
  ]);
  mem.legs = [];
  mem.steps = [];
  mem.rates = [];
  mem.chains = [];
  mem.paths = [];
  mem.triggers = [];
  mem.assignments = [];
  __setCatalogueMeasurementsForTest(
    new Map([
      [COLD, { basis: "mature", costPerOutcomeUsd: 40, conversionRatePct: 1, workflowDynastySlug: "orion" }],
      [MEET, { basis: "mature", costPerOutcomeUsd: 2, conversionRatePct: 30, workflowDynastySlug: "vega" }],
      // Lead Sourcing on its OWN cost per lead found (owner 2026-10-11): it adds 0.5 x the leads a funnel needs.
      ["lead-sourcing|start_to_lead_found", { basis: "mature", costPerOutcomeUsd: 0.5, conversionRatePct: 100, workflowDynastySlug: "lead-sourcing-scheat" }],
    ]),
  );
});

const tokens = (body: unknown) => JSON.stringify(body).length / 4;

describe("agent catalogue lists (context-window sized)", () => {
  it("is service-key only", async () => {
    expect((await request(app).get("/internal/catalogue/steps")).status).toBe(401);
  });

  it("lists steps with a value, cost and roi", async () => {
    const res = await request(app).get("/internal/catalogue/steps").set(KEY);
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("step");
    expect(res.body.rows[0]).toMatchObject({ id: "paid_client", name: "Paid client", valueUsd: 3000 });
    const booked = (await request(app).get("/internal/catalogue/steps/meeting_booked").set(KEY)).body;
    // Value added: ($450 meeting − $150 reply it took over) / $2 (`lib/value-added.ts`).
    expect(booked).toMatchObject({ valueUsd: 450, costUsd: 2, roi: 150, status: "measured" });
  });

  it("lists the sales paths containing a step, limited, each a river name, under ~2k tokens", async () => {
    const res = await request(app).get("/internal/catalogue/sales-paths").query({ containsSteps: "Meeting booked", limit: 10 }).set(KEY);
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeLessThanOrEqual(10);
    expect(res.body.rows.length).toBeGreaterThan(3);
    expect(tokens(res.body)).toBeLessThan(2000);
    for (const r of res.body.rows) {
      expect(Object.keys(r).sort()).toEqual(["color", "costPer", "costUsd", "icon", "id", "line", "name", "roi", "roiBasis", "runnable", "status", "trigger", "type"]);
      expect(r.line).toContain("Meeting booked");
      expect(r.icon).toBe("waves");
    }
    // The priced path ranks first (its cost per paying client rests on default rates: estimated; learning last).
    expect(res.body.rows[0]).toMatchObject({ status: "estimated", roiBasis: "estimated", line: "Start → Lead found → Positive reply → Meeting booked → Meeting attended → Paid client" });
    expect(res.body.rows[0].name).toBe("Danube");
  });

  it("an unknown step is a named 400", async () => {
    const res = await request(app).get("/internal/catalogue/sales-paths").query({ containsSteps: "Telepathy" }).set(KEY);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("step_not_found");
  });

  it("lists channels compatible with a path, pipes on it, and funnels on it containing a channel", async () => {
    const path = "lead_found_to_conversation+conversation_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
    const ch = await request(app).get("/internal/catalogue/channels").query({ forPaths: path }).set(KEY);
    expect(ch.status).toBe(200);
    expect(ch.body.rows.map((r: { id: string }) => r.id)).toContain("ai-meeting-booking");
    expect(tokens(ch.body)).toBeLessThan(2000);

    const pipes = await request(app).get("/internal/catalogue/pipes").query({ paths: path, channels: "ai-meeting-booking,sales-cold-email-outreach" }).set(KEY);
    expect(pipes.status).toBe(200);
    const ids = pipes.body.rows.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining([COLD, MEET]));
    // An existing pipe keeps its name; a new one gets a bird.
    expect(pipes.body.rows.find((r: { id: string }) => r.id === MEET).name).toBe("Prism");
    expect(pipes.body.rows.find((r: { id: string }) => r.id === COLD).name).toBe("Sparrow");

    // `+` sent unencoded arrives as a space: still the same path.
    const funnels = await request(app).get(`/internal/catalogue/sales-funnels?paths=${path}&containsChannels=ai-meeting-booking&limit=5`).set(KEY);
    expect(funnels.status).toBe(200);
    expect(funnels.body.rows[0]).toMatchObject({ name: "Victory", face: "/public/catalogue/faces/Victory.svg", status: "estimated", roiBasis: "estimated", type: "proactive" });
    expect(tokens(funnels.body)).toBeLessThan(2000);
  });

  it("prices a funnel PER OFFER: the offer's own client value and its brand's own rates, else the fleet's", async () => {
    const victory = "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
    const fleet = (await request(app).get(`/internal/catalogue/sales-funnels/${encodeURIComponent(victory)}`).set(KEY)).body;
    const offer = (
      await request(app)
        .get(`/internal/catalogue/sales-funnels/${encodeURIComponent(victory)}`)
        .query({ offerId: "offer-1", brandId: "b1" })
        .set({ ...KEY, "x-org-id": "o1" })
    ).body;
    expect(offer.offer).toMatchObject({ offerId: "offer-1", lifetimeRevenueUsd: 12000, lifetimeRevenueSource: "offer_stated", ownRateLegs: 2 });
    expect(offer.lifetimeRevenueSource).toBe("offer_stated");
    // Own measured rate (50%) and own stated rate (40%); the default show-up stays the fleet's (75%).
    expect(offer.legs.map((l: { ratePct: number | null; rateSource: string | null }) => [l.ratePct, l.rateSource])).toEqual([
      [null, null],
      [1, "measured_pipe"],
      [50, "offer_measured"],
      [75, "default"],
      [40, "offer_stated"],
    ]);
    // needed: paid 1, attended 2.5, booked 3.333, reply 6.667, lead 666.7 -> 2 x 3.333 + 40 x 6.667 + 0.5 x 666.7 = 606.67;
    // roi 12000 / 606.67.
    expect(offer.costUsd).toBeCloseTo(606.67, 1);
    expect(offer.roi).toBeCloseTo(19.78, 1);
    expect(offer.status).toBe("estimated");
    expect(offer.estimates).toEqual(["rate:meeting_booked_to_meeting_attended", "rate:meeting_attended_to_paid_client", "lifetime_revenue"]);
    expect(fleet.costUsd).not.toBeCloseTo(offer.costUsd, 0);
    expect(fleet.offer).toBeUndefined();

    const list = (await request(app).get("/internal/catalogue/sales-funnels").query({ offerId: "offer-1", brandId: "b1", limit: 3 }).set({ ...KEY, "x-org-id": "o1" })).body;
    expect(list.offer).toMatchObject({ offerId: "offer-1", lifetimeRevenueSource: "offer_stated" });
    expect((await request(app).get("/internal/catalogue/sales-funnels").query({ offerId: "offer-1" }).set(KEY)).body.reason).toBe("brand_required");
    expect((await request(app).get("/internal/catalogue/sales-funnels").query({ offerId: "offer-1", brandId: "b1" }).set(KEY)).body.reason).toBe("org_required");
    expect((await request(app).get("/internal/catalogue/sales-funnels").query({ offerId: "nope", brandId: "b1" }).set({ ...KEY, "x-org-id": "o1" })).status).toBe(404);
  });

  it("a funnel serves no customer sentence (withdrawn 2026-10-11); a reactive one names its trigger", async () => {
    const list = (await request(app).get("/internal/catalogue/sales-funnels").query({ limit: 25 }).set(KEY)).body;
    for (const r of list.rows) expect(r).not.toHaveProperty("description");
    const motivate = (await request(app).get(`/internal/catalogue/sales-funnels/${encodeURIComponent("conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client")}`).set(KEY)).body;
    expect(motivate).toMatchObject({ type: "reactive", triggerLabel: "Positive replies" });
    expect(motivate).not.toHaveProperty("description");
  });

  it("serves a detail read per id", async () => {
    const victory = "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
    const f = await request(app).get(`/internal/catalogue/sales-funnels/${encodeURIComponent(victory)}`).set(KEY);
    expect(f.status).toBe(200);
    expect(f.body.name).toBe("Victory");
    expect(f.body.type).toBe("proactive");
    expect(f.body.face).toMatchObject({ svgPath: "/public/catalogue/faces/Victory.svg" });
    // Its stored (legacy) id resolves to its Lead Sourcing funnel: Start -> Lead found named like every leg, ONE channel each.
    expect(f.body.id).toBe(`start_to_lead_found@lead-sourcing+${victory}`);
    expect(f.body.legs).toHaveLength(5);
    expect(f.body.salesPathId).toBe("start_to_lead_found+lead_found_to_conversation+conversation_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client");
    for (const l of f.body.legs) expect(l.channels.length, l.legKey).toBe(1);
    expect(f.body.legs[0]).toMatchObject({ legKey: "start_to_lead_found", fromStep: null, toStep: "lead_found", pipe: { id: "lead-sourcing|start_to_lead_found" } });
    expect(f.body.legs[0].channels).toEqual([{ id: "lead-sourcing", name: "Lead Sourcing", runByUs: true }]);
    expect(f.body.legs[4].channels).toEqual([{ id: "your-team-closing-calls", name: "Your Team Closing Calls", runByUs: false }]);
    // 902.22 of outreach + Lead Sourcing's own 0.5 x 2222.2 leads.
    expect(f.body.costUsd).toBeCloseTo(2013.33, 1);
    // What is measured vs estimated, per leg and in total (owner 2026-10-10: never "measured" on an estimate).
    expect(f.body).toMatchObject({ status: "estimated", roiBasis: "estimated", lifetimeRevenueSource: "fleet_median_stated" });
    expect(f.body.estimates).toContain("rate:conversation_to_meeting_booked");
    expect(f.body.legs[2]).toMatchObject({ rateSource: "default", rateMeasured: false, pipe: { status: "measured", roiBasis: "estimated" } });
    const pipe = await request(app).get(`/internal/catalogue/pipes/${encodeURIComponent(MEET)}`).set(KEY);
    expect(pipe.body).toMatchObject({ name: "Prism", costUsd: 2, roi: 150, toStepValueUsd: 450 });
    const channel = await request(app).get("/internal/catalogue/channels/ai-meeting-booking").set(KEY);
    expect(channel.body).toMatchObject({ id: "ai-meeting-booking", costUsd: 2, bestPipeId: MEET });
    expect((await request(app).get("/internal/catalogue/pipes/nope").set(KEY)).status).toBe(404);
  });

  it("runnable=true keeps only what we run today: no LinkedIn posting, no unmanaged pipe or funnel (owner 2026-10-10)", async () => {
    const all = await request(app).get("/internal/catalogue/channels").query({ q: "linkedin", limit: 25 }).set(KEY);
    expect(all.status).toBe(200);
    const posting = all.body.rows.find((r: { id: string }) => r.id === "organic-linkedin-publishing");
    expect(posting).toMatchObject({ runnable: false });

    const runnable = await request(app).get("/internal/catalogue/channels").query({ q: "linkedin", runnable: "true", limit: 25 }).set(KEY);
    expect(runnable.body.rows.map((r: { id: string }) => r.id)).not.toContain("organic-linkedin-publishing");
    expect(runnable.body.rows.every((r: { runnable: boolean }) => r.runnable)).toBe(true);

    const ch = await request(app).get("/internal/catalogue/channels").query({ runnable: "true", limit: 25 }).set(KEY);
    expect(ch.body.rows.map((r: { id: string }) => r.id)).toContain("sales-cold-email-outreach");

    const pipes = await request(app).get("/internal/catalogue/pipes").query({ channels: "organic-linkedin-publishing", runnable: "true" }).set(KEY);
    expect(pipes.body.rows).toEqual([]);
    const pipesAll = await request(app).get("/internal/catalogue/pipes").query({ channels: "organic-linkedin-publishing" }).set(KEY);
    expect(pipesAll.body.rows.length).toBeGreaterThan(0);
    expect(pipesAll.body.rows.every((r: { runnable: boolean }) => r.runnable === false)).toBe(true);

    const funnels = await request(app).get("/internal/catalogue/sales-funnels").query({ containsChannels: "organic-linkedin-publishing", runnable: "true" }).set(KEY);
    expect(funnels.body.rows).toEqual([]);
    const cold = await request(app).get("/internal/catalogue/sales-funnels").query({ containsChannels: "sales-cold-email-outreach", runnable: "true", limit: 25 }).set(KEY);
    expect(cold.body.rows.length).toBeGreaterThan(0);
    expect(cold.body.rows.every((r: { runnable: boolean }) => r.runnable)).toBe(true);

    const paths = await request(app).get("/internal/catalogue/sales-paths").query({ runnable: "true", limit: 25 }).set(KEY);
    expect(paths.body.rows.every((r: { runnable: boolean }) => r.runnable)).toBe(true);

    const detail = await request(app).get("/internal/catalogue/channels/organic-linkedin-publishing").set(KEY);
    expect(detail.body).toMatchObject({ managed: false, runnable: false });
    expect((await request(app).get("/internal/catalogue/channels").query({ runnable: "yes" }).set(KEY)).status).toBe(400);
  });

  it("every figure carries its own unit in words (prod 2026-10-10: a per-reply cost quoted per paying client)", async () => {
    const ch = await request(app).get("/internal/catalogue/channels").query({ q: "cold email", limit: 25 }).set(KEY);
    const cold = ch.body.rows.find((r: { id: string }) => r.id === "sales-cold-email-outreach");
    expect(cold).toMatchObject({ costUsd: 40, costPer: "per positive reply" });
    const pipe = await request(app).get(`/internal/catalogue/pipes/${encodeURIComponent(MEET)}`).set(KEY);
    expect(pipe.body).toMatchObject({ costUsd: 2, costPer: "per meeting booked" });
    const funnels = await request(app).get("/internal/catalogue/sales-funnels").query({ containsChannels: "ai-meeting-booking", limit: 5 }).set(KEY);
    const measured = funnels.body.rows.filter((r: { costUsd: number | null }) => r.costUsd !== null);
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.every((r: { costPer: string }) => r.costPer === "per paying client")).toBe(true);
    // No cost, no unit.
    const learning = funnels.body.rows.filter((r: { costUsd: number | null }) => r.costUsd === null);
    expect(learning.every((r: { costPer: string | null }) => r.costPer === null)).toBe(true);
    const steps = await request(app).get("/internal/catalogue/steps").query({ limit: 25 }).set(KEY);
    for (const r of steps.body.rows) if (r.costUsd !== null) expect(r.costPer).toBe(`per ${r.name.toLowerCase()}`);
  });

  it("a MIXED funnel (cold email + AI meeting booking) is served mixed and never runnable (owner 2026-10-10)", async () => {
    const victory = "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
    const f = await request(app).get(`/internal/catalogue/sales-funnels/${encodeURIComponent(victory)}`).set(KEY);
    expect(f.body).toMatchObject({ mixed: true, runnable: false, type: "proactive" });
    const list = await request(app).get("/internal/catalogue/sales-funnels").query({ containsChannels: "ai-meeting-booking", runnable: "true", limit: 25 }).set(KEY);
    expect(list.body.rows.map((r: { id: string }) => r.id)).not.toContain(`start_to_lead_found@lead-sourcing+${victory}`);
    expect(list.body.rows.every((r: { mixed: boolean }) => r.mixed === false)).toBe(true);
    const reactive = list.body.rows.filter((r: { type: string }) => r.type === "reactive");
    expect(reactive.length).toBeGreaterThan(0);
  });

  it("the PUBLIC sales funnel list needs no key and serves only runnable funnels, whatever the query says (owner 2026-10-10)", async () => {
    const pub = await request(app).get("/public/catalogue/sales-funnels").query({ containsChannels: "ai-meeting-booking", runnable: "false", limit: 25 });
    expect(pub.status).toBe(200);
    expect(pub.body.rows.length).toBeGreaterThan(0);
    expect(pub.body.rows.every((r: { runnable: boolean; mixed: boolean }) => r.runnable && !r.mixed)).toBe(true);
    const internal = await request(app).get("/internal/catalogue/sales-funnels").query({ containsChannels: "ai-meeting-booking", runnable: "true", limit: 25 }).set(KEY);
    expect(pub.body.rows.map((r: { id: string }) => r.id)).toEqual(internal.body.rows.map((r: { id: string }) => r.id));
    const all = await request(app).get("/internal/catalogue/sales-funnels").query({ containsChannels: "ai-meeting-booking", limit: 25 }).set(KEY);
    expect(all.body.rows.length).toBeGreaterThan(pub.body.rows.length);
    expect((await request(app).get("/public/catalogue/sales-funnels").query({ limit: "x" })).status).toBe(400);
  });

  it("the PUBLIC step vocabulary needs no key and serves every step's key, name and icon byte-equal to the staff read (owner 2026-10-11)", async () => {
    const pub = await request(app).get("/public/catalogue/steps");
    expect(pub.status).toBe(200);
    expect(pub.body.object).toBe("step");
    const internal = await request(app).get("/internal/catalogue/steps").query({ limit: 25 }).set(KEY);
    expect(internal.body.truncated).toBe(false);
    const staff = new Map(internal.body.rows.map((r: { id: string; name: string; icon: string }) => [r.id, { key: r.id, name: r.name, icon: r.icon }]));
    expect(pub.body.total).toBe(staff.size);
    expect(pub.body.rows).toHaveLength(staff.size);
    for (const r of pub.body.rows) expect(r).toEqual(staff.get(r.key));
    expect(pub.body.rows.find((r: { key: string }) => r.key === "conversation")).toMatchObject({ icon: "chat-circle-text" });
    expect(JSON.stringify(pub.body)).not.toMatch(/valueUsd|costUsd|roi/);
  });

  it("serves a face as an SVG image", async () => {
    const res = await request(app).get("/public/catalogue/faces/Victory.svg");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    expect(Buffer.from(res.body).toString("utf8")).toContain("<title>Victory</title>");
  });
});

describe("pipe stats on the pipe detail (owner 2026-10-12, the staff Pipe page)", () => {
  it("?stats=true serves the stats of the scope asked, priced on the value the pipe adds; plain detail unchanged", async () => {
    const calls: unknown[][] = [];
    pipeStats.get = async (...a: unknown[]) => {
      calls.push(a);
      return { scope: a[2], spendUsd: 10, costPerOutcomeUsd: 5, roi: 60, history: [] };
    };
    const plain = await request(app).get(`/internal/catalogue/pipes/${encodeURIComponent(MEET)}`).set(KEY);
    expect(plain.body.stats).toBeUndefined();
    expect(calls).toHaveLength(0);
    const fleet = await request(app).get(`/internal/catalogue/pipes/${encodeURIComponent(MEET)}`).query({ stats: "true" }).set(KEY);
    expect(fleet.status).toBe(200);
    expect(fleet.body).toMatchObject({ name: "Prism", costUsd: 2, stats: { scope: { kind: "fleet", brandId: null, offerId: null }, costPerOutcomeUsd: 5 } });
    // The pipe as the stats read needs it, and the value it ADDS per meeting (catalogue: roi 150 at $2).
    expect(calls[0]![1]).toMatchObject({ channelSlug: "ai-meeting-booking", fromStep: "conversation", toStep: "meeting_booked", toStepLabel: "Meeting booked" });
    expect(calls[0]![3]).toBe(300);
    const offer = await request(app).get(`/internal/catalogue/pipes/${encodeURIComponent(MEET)}`).query({ stats: "true", brandId: "b-1", offerId: "o-1" }).set(KEY);
    expect(offer.body.stats.scope).toEqual({ kind: "offer", brandId: "b-1", offerId: "o-1" });
    // A platform pipe has no leg neighbours; a customer-team pipe names the platform pipes bringing people to its
    // `from` step and those on its own leg (owner 2026-10-12: their team on the replies we brought them).
    expect(calls[0]![1]).toMatchObject({ legNeighbours: undefined });
    const team = await request(app).get(`/internal/catalogue/pipes/${encodeURIComponent("your-team-meeting-booking|conversation_to_meeting_booked")}`).query({ stats: "true" }).set(KEY);
    expect(team.status).toBe(200);
    const n = (calls.at(-1)![1] as { legNeighbours: { producingPipes: Array<{ channelSlug: string; computedLegKey: string }>; ourPipesOnLeg: Array<{ channelSlug: string }> } }).legNeighbours;
    expect(n.ourPipesOnLeg.map((q) => q.channelSlug)).toContain("ai-meeting-booking");
    expect(n.ourPipesOnLeg.map((q) => q.channelSlug)).not.toContain("your-team-meeting-booking");
    expect(n.producingPipes.length).toBeGreaterThan(0);
    expect(n.producingPipes.every((q) => q.computedLegKey.endsWith("_to_conversation"))).toBe(true);
    // A platform pipe sharing its leg with a customer team names the team channels and the leg's platform neighbours
    // (owner 2026-10-12: "team alone vs team + this pipe"); a customer-team pipe has none.
    const c = (calls[0]![1] as { teamCoLeg: { teamChannelSlugs: string[]; producingPipes: Array<{ computedLegKey: string }>; ourPipesOnLeg: Array<{ channelSlug: string }> } }).teamCoLeg;
    expect(c.teamChannelSlugs).toContain("your-team-meeting-booking");
    expect(c.ourPipesOnLeg.map((q) => q.channelSlug)).toContain("ai-meeting-booking");
    expect(c.ourPipesOnLeg.map((q) => q.channelSlug)).not.toContain("your-team-meeting-booking");
    expect(c.producingPipes.every((q) => q.computedLegKey.endsWith("_to_conversation"))).toBe(true);
    expect(calls.at(-1)![1]).toMatchObject({ teamCoLeg: undefined });
  });

  it("an offer without its brand is refused; an unreadable producer is a named 502", async () => {
    const bad = await request(app).get(`/internal/catalogue/pipes/${encodeURIComponent(MEET)}`).query({ stats: "true", offerId: "o-1" }).set(KEY);
    expect(bad.status).toBe(400);
    expect(bad.body.reason).toBe("brand_required");
    pipeStats.get = async () => {
      throw new Error("runs down");
    };
    const down = await request(app).get(`/internal/catalogue/pipes/${encodeURIComponent(MEET)}`).query({ stats: "true" }).set(KEY);
    expect(down.status).toBe(502);
    expect(down.body.reason).toBe("pipe_stats_unreadable");
  });
});

describe("agent catalogue creates (data, never a PR)", () => {
  it("a declared step + its pipes make a path; a new path is a river, a new funnel an uplifting word, a new pipe a bird", async () => {
    const step = await request(app)
      .post("/internal/catalogue/steps")
      .set(KEY)
      .send({ key: "linkedin_post", label: "LinkedIn post", description: "A post published on LinkedIn.", shortDescription: "Posts on LinkedIn", icon: "linkedin-logo", towardStep: "conversation", towardRatePct: 2, createdBy: "agent" });
    expect(step.status).toBe(201);
    expect(step.body).toMatchObject({ id: "linkedin_post", valueUsd: 3, declared: true });

    const p1 = await request(app).post("/internal/catalogue/pipes").set(KEY).send({ channelSlug: "organic-linkedin-publishing", fromStep: null, toStep: "linkedin_post", mode: "proactive", createdBy: "agent" });
    expect(p1.status).toBe(201);
    // Live the moment it is created (owner 2026-10-12): never a draft waiting on staff publish.
    expect(p1.body).toMatchObject({ id: "organic-linkedin-publishing|start_to_linkedin_post", draft: false, status: "learning", runnable: false });
    const p2 = await request(app).post("/internal/catalogue/pipes").set(KEY).send({ channelSlug: "organic-linkedin-publishing", fromStep: "linkedin_post", toStep: "conversation", mode: "proactive", createdBy: "agent" });
    expect(p2.status).toBe(201);

    const paths = await request(app).get("/internal/catalogue/sales-paths").query({ containsSteps: "LinkedIn post", limit: 10 }).set(KEY);
    expect(paths.status).toBe(200);
    expect(paths.body.rows.length).toBeGreaterThan(0);
    expect(tokens(paths.body)).toBeLessThan(2000);
    const pathId = paths.body.rows[0].id as string;
    expect(pathId.startsWith("start_to_linkedin_post+linkedin_post_to_conversation")).toBe(true);

    const created = await request(app).post("/internal/catalogue/sales-paths").set(KEY).send({ legKeys: pathId.split("+"), createdBy: "agent" });
    expect([200, 201]).toContain(created.status);
    expect(created.body.name).toBe(paths.body.rows[0].name);

    const detail = (await request(app).get(`/internal/catalogue/sales-paths/${encodeURIComponent(pathId)}`).set(KEY)).body;
    const pipeIds = detail.legs.map((l: { legKey: string; pipeIds: string[] }) => l.pipeIds[0] ?? l.legKey);
    const givenBefore = new Set(names.rows.values());
    const funnel = await request(app).post("/internal/catalogue/sales-funnels").set(KEY).send({ pipeIds, createdBy: "agent" });
    expect(funnel.status).toBe(201);
    expect(funnel.body.created).toBe(true);
    expect(funnel.body.face.svgPath).toBe(`/public/catalogue/faces/${encodeURIComponent(funnel.body.name)}.svg`);
    expect(givenBefore.has(funnel.body.name)).toBe(false);
    expect(FAMILY_WORDS.sales_funnel).toContain(funnel.body.name);
    expect(PIPE_BIRD_WORDS).toContain(p1.body.name);
    expect(PATH_RIVER_WORDS).toContain(created.body.name);
    expect(mem.paths).toHaveLength(1);

    // No name twice across every family.
    const all = [...names.rows.values()];
    expect(new Set(all).size).toBe(all.length);
  });

  it("a LEADS-ONLY funnel (owner 2026-10-12): Start -> Lead found (a source) -> Paid client (the customer's team) is created live, not mixed, runnable", async () => {
    const team = await request(app)
      .post("/internal/catalogue/pipes")
      .set(KEY)
      .send({ channelSlug: "your-team-closing-calls", fromStep: "lead_found", toStep: "paid_client", mode: "proactive", createdBy: "copilot" });
    expect(team.status).toBe(201);
    expect(team.body).toMatchObject({ id: "your-team-closing-calls|lead_found_to_paid_client", draft: false, runnable: true });
    const f = await request(app)
      .post("/internal/catalogue/sales-funnels")
      .set(KEY)
      .send({ pipeIds: ["sourcing-apollo-cold-filters|start_to_lead_found", "your-team-closing-calls|lead_found_to_paid_client"], createdBy: "copilot" });
    expect(f.status).toBe(201);
    expect(f.body).toMatchObject({ id: "start_to_lead_found@sourcing-apollo-cold-filters+lead_found_to_paid_client", mixed: false, runnable: true, draft: false });
  });

  it("a platform pipe with an ACTIVE workflow runs; without one it does not (owner 2026-10-12: facts, never a staff click)", async () => {
    const listed = await request(app).get("/internal/catalogue/pipes").query({ channels: "organic-linkedin-publishing" }).set(KEY);
    const id = listed.body.rows[0].id as string;
    expect(listed.body.rows[0].runnable).toBe(false);
    mem.assignments = [{ featureSlug: "organic-linkedin-publishing", legKey: id.split("|")[1], workflowDynastySlug: "x", state: "deprecated", decidedBy: "s", decidedAt: "", note: null }];
    expect((await request(app).get(`/internal/catalogue/pipes/${encodeURIComponent(id)}`).set(KEY)).body.runnable).toBe(false);
    mem.assignments = [{ ...mem.assignments[0], state: "active" }];
    expect((await request(app).get(`/internal/catalogue/pipes/${encodeURIComponent(id)}`).set(KEY)).body.runnable).toBe(true);
  });

  it("a REACTIVE-only funnel starts on a trigger step: the two campaign-service converts are creatable (owner 2026-10-10)", async () => {
    const paths = await request(app).get("/internal/catalogue/sales-paths").query({ containsSteps: "conversation", limit: 25 }).set(KEY);
    const reactive = paths.body.rows.filter((r: { type: string }) => r.type === "reactive");
    expect(reactive.map((r: { id: string }) => r.id)).toEqual(
      expect.arrayContaining([
        "conversation_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client",
        "conversation_to_booking_call+booking_call_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client",
      ]),
    );
    const meeting = reactive.find((r: { id: string }) => r.id.startsWith("conversation_to_meeting_booked"));
    // A reactive path starts with its TRIGGER, by name (owner 2026-10-11), in place of its trigger step.
    expect(meeting.line).toBe("Positive Reply → Meeting booked → Meeting attended → Paid client");
    expect(meeting.trigger).toEqual({ slug: "positive_reply_received", name: "Positive Reply" });
    expect(paths.body.rows.filter((r: { type: string }) => r.type === "proactive").every((r: { trigger: unknown }) => r.trigger === null)).toBe(true);

    for (const pipeIds of [
      ["ai-meeting-booking|conversation_to_meeting_booked", "your-team-meeting-attendance|meeting_booked_to_meeting_attended", "your-team-closing-calls|meeting_attended_to_paid_client"],
      ["ai-instant-call|conversation_to_booking_call", "your-team-booking-calls|booking_call_to_meeting_booked", "your-team-meeting-attendance|meeting_booked_to_meeting_attended", "your-team-closing-calls|meeting_attended_to_paid_client"],
    ]) {
      const f = await request(app).post("/internal/catalogue/sales-funnels").set(KEY).send({ pipeIds, createdBy: "campaign-service" });
      expect(f.status).toBe(201);
      expect(f.body).toMatchObject({ type: "reactive" });
      expect(FAMILY_WORDS.sales_funnel).toContain(f.body.name);
      expect(f.body.face.svgPath).toContain("/public/catalogue/faces/");
    }
    expect(mem.paths.map((p) => p.combinationKey)).toEqual([
      "conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client",
      "conversation_to_booking_call@ai-instant-call+booking_call_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client",
    ]);
  });

  it("refuses a funnel with a bare leg: every leg is worked by a channel (owner 2026-10-11)", async () => {
    const f = await request(app)
      .post("/internal/catalogue/sales-funnels")
      .set(KEY)
      .send({ pipeIds: ["ai-instant-call|conversation_to_booking_call", "booking_call_to_meeting_booked", "your-team-meeting-attendance|meeting_booked_to_meeting_attended", "your-team-closing-calls|meeting_attended_to_paid_client"], createdBy: "agent" });
    expect(f.status).toBe(400);
    expect(f.body.reason).toBe("bare_leg_refused");
    expect(f.body.error).toContain("pipeIds[1]");
  });

  it("ONE channel per leg (owner 2026-10-11): two sources, or no source, on Start -> Lead found is refused; one source or Lead Sourcing is created", async () => {
    const tail = ["sales-cold-email-outreach|lead_found_to_conversation", "your-team-meeting-booking|conversation_to_meeting_booked", "your-team-meeting-attendance|meeting_booked_to_meeting_attended", "your-team-closing-calls|meeting_attended_to_paid_client"];
    const two = await request(app).post("/internal/catalogue/sales-funnels").set(KEY).send({ pipeIds: ["sourcing-apollo-cold-filters|start_to_lead_found", "sourcing-apollo-buying-signals|start_to_lead_found", ...tail], createdBy: "agent" });
    expect(two.status).toBe(400);
    expect(two.body.reason).toBe("one_channel_per_leg");
    expect(two.body.error).toContain("lead-sourcing|start_to_lead_found");
    const none = await request(app).post("/internal/catalogue/sales-funnels").set(KEY).send({ pipeIds: tail, createdBy: "agent" });
    expect(none.status).toBe(400);
    expect(none.body.reason).toBe("leg_without_channel");
    expect(none.body.error).toContain("start_to_lead_found");
    const crmUnderCold = await request(app).post("/internal/catalogue/sales-funnels").set(KEY).send({ pipeIds: ["sourcing-crm-contacts|start_to_lead_found", ...tail], createdBy: "agent" });
    expect(crmUnderCold.status).toBe(400);
    expect(crmUnderCold.body.reason).toBe("funnel_invalid");
    expect(mem.paths).toHaveLength(0);

    const ls = await request(app).post("/internal/catalogue/sales-funnels").set(KEY).send({ pipeIds: ["lead-sourcing|start_to_lead_found", ...tail], createdBy: "agent" });
    expect(ls.status).toBe(201);
    expect(ls.body.id).toBe("start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client");
    expect(ls.body.legs.map((l: { pipe: { id: string } }) => l.pipe.id)).toEqual(["lead-sourcing|start_to_lead_found", ...tail]);
    expect(ls.body.runnable).toBe(true);
    const one = await request(app).post("/internal/catalogue/sales-funnels").set(KEY).send({ pipeIds: ["sourcing-apollo-cold-filters|start_to_lead_found", ...tail], createdBy: "agent" });
    expect(one.status).toBe(201);
    expect(one.body.id.startsWith("start_to_lead_found@sourcing-apollo-cold-filters+")).toBe(true);
    expect(one.body.name).not.toBe(ls.body.name);
    // The declared store holds every leg, the sourcing one first.
    expect(mem.paths.map((p) => (p.legs as Array<{ channelSlug: string }>)[0].channelSlug)).toEqual(["lead-sourcing", "sourcing-apollo-cold-filters"]);
  });

  it("a pipe on a leg nothing rates states its conversion rate", async () => {
    await request(app).post("/internal/catalogue/steps").set(KEY).send({ key: "email_found", label: "Email found", description: "A work email is found for a person.", shortDescription: "Finds a work email", icon: "envelope", towardStep: "lead_found", towardRatePct: 90, producedBy: "apollo-service POST /people/match", createdBy: "agent" });
    const refused = await request(app).post("/internal/catalogue/pipes").set(KEY).send({ channelSlug: "sales-cold-email-outreach", fromStep: "email_found", toStep: "website_visit", mode: "proactive", createdBy: "agent" });
    expect(refused.status).toBe(400);
    expect(refused.body.reason).toBe("conversion_rate_required");
    const step = (await request(app).get("/internal/catalogue/steps/email_found").set(KEY)).body;
    expect(step).toMatchObject({ producedBy: "apollo-service POST /people/match", declared: true });
    expect(step.valueUsd).toBeCloseTo(0.9 * 1.5, 5);
  });
});

describe("agent catalogue triggers (owner 2026-10-11, the staff Triggers section)", () => {
  const record = (t: (typeof CHANNEL_TRIGGER_TYPES)[number], i: number) => ({ ...t, origin: "code", kind: "event", params: null, displayOrder: i, createdBy: null, requestedByOrgId: null });
  beforeEach(() => {
    mem.triggers = CHANNEL_TRIGGER_TYPES.map(record);
  });

  it("is service-key only", async () => {
    expect((await request(app).get("/internal/catalogue/triggers")).status).toBe(401);
  });

  it("lists every trigger in catalogue order, lightning glyph, unique name, with the count of reactive pipes it starts", async () => {
    const r = await request(app).get("/internal/catalogue/triggers").query({ limit: 25 }).set(KEY);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ object: "trigger", order: "catalogue", total: CHANNEL_TRIGGER_TYPES.length });
    expect(r.body.rows.map((x: { id: string }) => x.id)).toEqual(CHANNEL_TRIGGER_TYPES.slice(0, 25).map((t) => t.id));
    const names = r.body.rows.map((x: { name: string }) => x.name);
    expect(new Set(names).size).toBe(names.length);
    const reply = r.body.rows.find((x: { id: string }) => x.id === "positive_reply_received");
    expect(reply).toMatchObject({ name: "Positive Reply", icon: "lightning", eventIcon: "thumbs-up", fromStep: "conversation", coded: true });
    expect(reply.color).toMatch(/^#[0-9A-F]{6}$/i);
    expect(reply.pipeCount).toBeGreaterThan(0);
  });

  it("searches and pages", async () => {
    const r = await request(app).get("/internal/catalogue/triggers").query({ q: "positive", limit: 1 }).set(KEY);
    expect(r.body.rows.map((x: { id: string }) => x.id)).toEqual(["positive_reply_received"]);
  });

  it("one trigger: the reactive pipes it starts, named", async () => {
    const r = await request(app).get("/internal/catalogue/triggers/positive_reply_received").set(KEY);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ object: "trigger", id: "positive_reply_received", name: "Positive Reply" });
    const ids = r.body.pipes.map((p: { id: string }) => p.id);
    expect(ids).toContain(MEET);
    expect(r.body.pipes.find((p: { id: string }) => p.id === MEET)).toMatchObject({ name: "Prism", mode: "reactive" });
    expect(r.body.pipeCount).toBe(ids.length);
  });

  it("404 on an unknown trigger", async () => {
    const r = await request(app).get("/internal/catalogue/triggers/nope").set(KEY);
    expect(r.status).toBe(404);
    expect(r.body.reason).toBe("trigger_not_found");
  });
});
