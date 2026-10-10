import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } }, sql: {} }));
// The fleet build never ends here: a read must be served from the stored copy, never wait on it.
vi.mock("./public.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fleetLegPrice: () => (fleet.fails ? Promise.reject(new Error("fleet read timed out")) : new Promise(() => {})),
}));
const fleet = vi.hoisted(() => ({ fails: false }));
const cells = vi.hoisted(() => new Map<string, { text: string; computedAt: number }>());
vi.mock("../lib/fleet-cell-store.js", () => ({
  loadFleetCell: async (key: string) => cells.get(key) ?? null,
  claimFleetCellBuild: async () => true,
  storeFleetCell: async (key: string, text: string, computedAt: number) => void cells.set(key, { text, computedAt }),
}));
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
const { __resetCatalogueMeasurements, serializeFigures, parseFigures, warmCatalogueMeasurements } = await import("./agent-catalogue.js");

const KEY = { "x-api-key": "test-key" };
const COLD = "sales-cold-email-outreach|lead_found_to_conversation";

beforeEach(() => {
  names.rows = new Map();
  __resetCatalogueMeasurements();
  cells.clear();
  fleet.fails = false;
});

describe("a fresh process (every deploy) serves the stored catalogue figures, never waits on the rebuild", () => {
  it("round-trips the stored copy", () => {
    const v = {
      byPipe: new Map([[COLD, { basis: "mature" as const, costPerOutcomeUsd: 40, conversionRatePct: 1, workflowDynastySlug: "orion" }]]),
      unreadable: new Set(["x|y"]),
      computedAt: "2026-10-10T10:00:00.000Z",
      fleet: { arrows: new Map([["conversation>paid_client", { ratePct: 5, brandCount: 7 }]]), lifetimeRevenue: { usd: 2500, offerCount: 9 } },
    };
    expect(parseFigures(serializeFigures(v))).toEqual(v);
  });

  it("answers at once from the stored copy while the fleet build hangs", async () => {
    cells.set("agent-catalogue-figures", {
      computedAt: Date.now() - 60 * 60_000,
      text: serializeFigures({
        byPipe: new Map([[COLD, { basis: "mature", costPerOutcomeUsd: 40, conversionRatePct: 1, workflowDynastySlug: "orion" }]]),
        unreadable: new Set(),
        computedAt: "2026-10-10T10:00:00.000Z",
        fleet: { arrows: new Map(), lifetimeRevenue: { usd: 3000, offerCount: 12 } },
      }),
    });
    const started = Date.now();
    const res = await request(app).get("/internal/catalogue/pipes?limit=25").set(KEY);
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.body.rows.find((r: { id: string }) => r.id === COLD)).toMatchObject({ costUsd: 40, status: "measured" });
  });

  it("a rebuild whose read of a pipe fails keeps that pipe's last measurement (never stores it unreadable)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    cells.set("agent-catalogue-figures", {
      computedAt: Date.now() - 60 * 60_000,
      text: serializeFigures({
        byPipe: new Map([[COLD, { basis: "mature", costPerOutcomeUsd: 40, conversionRatePct: 1, workflowDynastySlug: "orion" }]]),
        unreadable: new Set(),
        computedAt: "2026-10-10T10:00:00.000Z",
        fleet: { arrows: new Map(), lifetimeRevenue: { usd: 3000, offerCount: 12 } },
      }),
    });
    fleet.fails = true;
    await request(app).get("/internal/catalogue/pipes?limit=1").set(KEY); // installs the stored copy, kicks the rebuild
    await warmCatalogueMeasurements();
    const stored = parseFigures(cells.get("agent-catalogue-figures")!.text);
    expect(stored.computedAt).not.toBe("2026-10-10T10:00:00.000Z"); // the rebuild ran and was stored
    expect(stored.byPipe.get(COLD)).toMatchObject({ costPerOutcomeUsd: 40, basis: "mature" });
    expect(stored.unreadable.has(COLD)).toBe(false);
    const res = await request(app).get("/internal/catalogue/pipes?limit=25").set(KEY);
    expect(res.body.rows.find((r: { id: string }) => r.id === COLD)).toMatchObject({ costUsd: 40, status: "measured" });
  });
});
