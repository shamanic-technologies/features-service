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
}));

const mem = vi.hoisted(() => ({ legs: [] as any[], steps: [] as any[], rates: [] as any[], chains: [] as any[], paths: [] as any[] }));
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
    listTriggerTypes: async () => [],
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
      const row = { channelSlug, ...input, published: false, createdBy, requestedByOrgId: null, createdAt: "", updatedAt: "" };
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

const KEY = { "x-api-key": "test-key" };
const COLD = "sales-cold-email-outreach|lead_found_to_conversation";
const MEET = "ai-meeting-booking|conversation_to_meeting_booked";

beforeEach(() => {
  names.rows = new Map([
    ["lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client", "Victory"],
    ["campaign:ai-meeting-booking|conversation_to_meeting_booked", "Prism"],
  ]);
  mem.legs = [];
  mem.steps = [];
  mem.rates = [];
  mem.chains = [];
  mem.paths = [];
  __setCatalogueMeasurementsForTest(
    new Map([
      [COLD, { basis: "mature", costPerOutcomeUsd: 40, conversionRatePct: 1, workflowDynastySlug: "orion" }],
      [MEET, { basis: "mature", costPerOutcomeUsd: 2, conversionRatePct: 30, workflowDynastySlug: "vega" }],
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
    expect(booked).toMatchObject({ valueUsd: 450, costUsd: 2, roi: 225, status: "measured" });
  });

  it("lists the sales paths containing a step, limited, each a river name, under ~2k tokens", async () => {
    const res = await request(app).get("/internal/catalogue/sales-paths").query({ containsSteps: "Meeting booked", limit: 10 }).set(KEY);
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeLessThanOrEqual(10);
    expect(res.body.rows.length).toBeGreaterThan(3);
    expect(tokens(res.body)).toBeLessThan(2000);
    for (const r of res.body.rows) {
      expect(Object.keys(r).sort()).toEqual(["color", "costPer", "costUsd", "icon", "id", "line", "name", "roi", "roiBasis", "runnable", "status"]);
      expect(r.line).toContain("Meeting booked");
      expect(r.icon).toBe("waves");
    }
    // The priced path ranks first (its cost per paying client rests on default rates: estimated; learning last).
    expect(res.body.rows[0]).toMatchObject({ status: "estimated", roiBasis: "estimated", line: "Lead found → Positive reply → Meeting booked → Meeting attended → Paid client" });
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

  it("serves a detail read per id", async () => {
    const victory = "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
    const f = await request(app).get(`/internal/catalogue/sales-funnels/${encodeURIComponent(victory)}`).set(KEY);
    expect(f.status).toBe(200);
    expect(f.body.name).toBe("Victory");
    expect(f.body.type).toBe("proactive");
    expect(f.body.face).toMatchObject({ svgPath: "/public/catalogue/faces/Victory.svg" });
    expect(f.body.legs).toHaveLength(4);
    expect(f.body.costUsd).toBeCloseTo(902.22, 1);
    // What is measured vs estimated, per leg and in total (owner 2026-10-10: never "measured" on an estimate).
    expect(f.body).toMatchObject({ status: "estimated", roiBasis: "estimated", lifetimeRevenueSource: "fleet_median_stated" });
    expect(f.body.estimates).toContain("rate:conversation_to_meeting_booked");
    expect(f.body.legs[1]).toMatchObject({ rateSource: "default", rateMeasured: false, pipe: { status: "measured", roiBasis: "estimated" } });
    const pipe = await request(app).get(`/internal/catalogue/pipes/${encodeURIComponent(MEET)}`).set(KEY);
    expect(pipe.body).toMatchObject({ name: "Prism", costUsd: 2, roi: 225, toStepValueUsd: 450 });
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

  it("serves a face as an SVG image", async () => {
    const res = await request(app).get("/public/catalogue/faces/Victory.svg");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    expect(Buffer.from(res.body).toString("utf8")).toContain("<title>Victory</title>");
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
    expect(p1.body).toMatchObject({ id: "organic-linkedin-publishing|start_to_linkedin_post", draft: true, status: "learning" });
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
