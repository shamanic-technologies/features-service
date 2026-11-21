import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

// HUMAN-BRIEF-1121: the onboarding asks, before any campaign exists, the brief a card would start with.

const mem = vi.hoisted(() => ({ model: null as any, inputs: [] as any[], held: true, offerKnown: true }));

vi.mock("../lib/brand-ownership.js", async () => {
  class BrandOwnershipError extends Error {}
  return { BrandOwnershipError, assertBrandHeld: vi.fn(async () => { if (!mem.held) throw new BrandOwnershipError("brand not held"); }) };
});
vi.mock("../lib/offer-lifetime-revenue.js", () => ({ offerLifetimeRevenue: vi.fn(async () => ({ usd: 3000, source: "fleet_median" })) }));
vi.mock("./agent-catalogue.js", () => ({ loadCatalogueModelForLifetimeRevenue: vi.fn(async () => mem.model) }));
vi.mock("../lib/human-brief-io.js", async () => {
  class OfferNotOfBrandError extends Error {}
  return {
    OfferNotOfBrandError,
    readOfferBriefContext: vi.fn(async () => {
      if (!mem.offerKnown) throw new OfferNotOfBrandError("offer not of brand");
      return { offer: { name: "Payroll audit", description: "We find payroll errors." }, audiences: ["HR leaders at mid-size companies"] };
    }),
    writeHumanBrief: vi.fn(async (input: any) => {
      mem.inputs.push(input);
      return { brief: "Book meetings with HR leaders at mid-size companies by cold email.", model: "claude-sonnet-test", stored: false };
    }),
  };
});

process.env.FEATURES_SERVICE_API_KEY = "test-key";

const { buildCatalogueModel } = await import("../lib/agent-catalogue.js");
const { buildChannelCatalogue } = await import("../lib/channel-catalogue.js");
const { SEED_FEATURES } = await import("../seed/features.js");
const { servedLegKeyOf } = await import("../lib/funnel-legs.js");
const { default: router } = await import("./campaign-brief.js");

const channels = buildChannelCatalogue(SEED_FEATURES.filter((f) => f.status === "active"));
mem.model = buildCatalogueModel({
  channels,
  publishedPipeIds: new Set(channels.flatMap((c) => c.stepTransitions.map((t) => `${c.slug}|${servedLegKeyOf(c.slug, t.legKey)}`))),
  declaredSteps: [],
  measurements: new Map(),
  lifetimeRevenueUsd: 3000,
});

const app = express().use(express.json()).use(router);
const ORG = { "x-api-key": "test-key", "x-org-id": "11111111-1111-4111-8111-111111111111", "x-user-id": "22222222-2222-4222-8222-222222222222", "x-run-id": "33333333-3333-4333-8333-333333333333" };
const FUNNEL = "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client";

describe("GET /offers/:offerId/campaign-brief", () => {
  it("answers one short human brief per funnel card, built from the offer and the funnel's channels", async () => {
    const res = await request(app).get(`/offers/offer-1/campaign-brief?brandId=brand-1&salesFunnelId=${encodeURIComponent(FUNNEL)}`).set(ORG);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ offerId: "offer-1", brandId: "brand-1", salesFunnelId: FUNNEL, target: null, brief: "Book meetings with HR leaders at mid-size companies by cold email.", model: "claude-sonnet-test" });
    expect(res.body.brief).not.toContain("Use only these channels");
    expect(res.body.brief).not.toContain("\n");
    const input = mem.inputs.at(-1);
    expect(input.offer.name).toBe("Payroll audit");
    expect(input.channels.map((c: any) => c.name)).toContain("Sales Cold Email Outreach");
    expect(input.replacing).toBeNull();
  });

  it("refuses what it cannot answer for, by name", async () => {
    expect((await request(app).get("/offers/offer-1/campaign-brief").set(ORG)).body.reason).toBe("brand_id_required");
    expect((await request(app).get("/offers/offer-1/campaign-brief?brandId=b&salesFunnelId=nope").set(ORG)).body.reason).toBe("sales_funnel_unknown");
    expect((await request(app).get("/offers/offer-1/campaign-brief?brandId=b&target=nope").set(ORG)).body.reason).toBe("target_unknown");
    mem.offerKnown = false;
    const r = await request(app).get("/offers/offer-x/campaign-brief?brandId=b").set(ORG);
    expect([r.status, r.body.reason]).toEqual([404, "offer_not_found"]);
    mem.offerKnown = true;
    mem.held = false;
    const h = await request(app).get("/offers/offer-1/campaign-brief?brandId=b").set(ORG);
    expect([h.status, h.body.reason]).toEqual([404, "brand_not_found"]);
    mem.held = true;
  });
});
