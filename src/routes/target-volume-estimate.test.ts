import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

// ONE-CAMPAIGN-VOLUME-1122: before the campaign exists, the signup asks a budget range and the timing for a volume.

const mem = vi.hoisted(() => ({ model: null as any, held: true, offerKnown: true, computes: 0 }));

vi.mock("../lib/brand-ownership.js", async () => {
  class BrandOwnershipError extends Error {}
  return { BrandOwnershipError, assertBrandHeld: vi.fn(async () => { if (!mem.held) throw new BrandOwnershipError("brand not held"); }) };
});
vi.mock("./agent-catalogue.js", async () => {
  const { DeclarationError } = await import("../lib/channel-declarations.js");
  return {
    loadCatalogueModelForOffer: vi.fn(async () => mem.model),
    offerContextFor: vi.fn(async (offerId: string, brandId: string) => {
      if (!mem.offerKnown) throw new DeclarationError(404, "offer_not_found", "offer not of brand");
      return { offerId, brandId, lifetimeRevenueUsd: 3000, lifetimeRevenueSource: "fleet_median", rates: new Map(), steps: { stated: false, steps: null, statedAt: null } };
    }),
  };
});
const delay = (medianHours: number, n: number) => {
  const cdf: Array<{ hours: number; share: number }> = [];
  for (let h = 24; h <= 24 * 200; h += 24) cdf.push({ hours: h, share: 1 - Math.pow(2, -h / medianHours) });
  cdf.push({ hours: 24 * 365, share: 1 });
  return { n, medianHours, cdf };
};
vi.mock("../lib/outcome-silver-io.js", () => ({
  readCurrentSilverSweep: vi.fn(async () => ({ sweptAt: "2026-11-22T05:00:00.000Z", rule: "x" })),
  readSilverStats: vi.fn(async (scope: string) =>
    scope !== "fleet"
      ? []
      : [
          { scope: "fleet", fromKey: "@entry", toKey: "lead_found", body: { kind: "entry_cost", stat: { campaigns: 40, units: 26199, spendUsd: 1902.53 } } },
          { scope: "fleet", fromKey: "lead_found", toKey: "conversation", body: { kind: "transition", stat: { fromUnits: 26199, toUnits: 70, linkedToUnits: 70, linkCoverage: 1, exposure: 19981.3, delay: delay(228, 68) } } },
          { scope: "fleet", fromKey: "conversation", toKey: "meeting_booked", body: { kind: "transition", stat: { fromUnits: 75, toUnits: 2, linkedToUnits: 2, linkCoverage: 1, exposure: 69.8, delay: delay(12, 8) } } },
        ],
  ),
}));
vi.mock("../lib/view-cache.js", () => ({
  buildScopeKey: (k: string) => k,
  servedCached: vi.fn(async (o: { compute: () => Promise<unknown> }) => {
    mem.computes++;
    return o.compute();
  }),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";

const { buildCatalogueModel } = await import("../lib/agent-catalogue.js");
const { buildChannelCatalogue } = await import("../lib/channel-catalogue.js");
const { SEED_FEATURES } = await import("../seed/features.js");
const { servedLegKeyOf } = await import("../lib/funnel-legs.js");
const { default: router, chainAndPlanOf } = await import("./target-volume-estimate.js");

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
const COLD = "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client";
const BOOKING = "conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
const IDS = encodeURIComponent(`${COLD},${BOOKING}`);

describe("chainAndPlanOf", () => {
  it("walks the campaign's funnels from Start to the Target, each transition with a plan rate", () => {
    const p = chainAndPlanOf(mem.model, { rates: new Map() }, [COLD, BOOKING], "meeting_booked");
    expect(p.milestones.map((m) => m.step)).toEqual(["lead_found", "conversation", "meeting_booked"]);
    expect(p.planRates.every((r) => r.ratePct !== null && r.ratePct > 0)).toBe(true);
  });
});

describe("GET /offers/:offerId/target-volume-estimate", () => {
  it("10 meetings booked per week: a range, its basis, the delay to the first meetings, the steady pace", async () => {
    const res = await request(app).get(`/offers/offer-1/target-volume-estimate?brandId=brand-1&salesFunnelIds=${IDS}&target=meeting_booked&volume=10&period=week`).set(ORG);
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.target).toEqual({ step: "meeting_booked", label: "Meeting booked" });
    expect(b.basis).toBe("fleet");
    expect(b.isExpected).toBe(true);
    expect(b.perUnit.lowUsd).toBeLessThan(b.perUnit.highUsd);
    expect(b.budget).toMatchObject({ period: "week", lowUsd: Math.floor(10 * b.perUnit.lowUsd), highUsd: Math.ceil(10 * b.perUnit.highUsd), maxUsd: Math.ceil(10 * b.perUnit.highUsd) });
    expect(b.timing.firstUnitsWeek).toBeGreaterThanOrEqual(1);
    expect(b.timing.steadyFromWeek).toBeGreaterThanOrEqual(b.timing.firstUnitsWeek);
    expect(b.timing.steadyPerPeriod).toBe(10);
    expect(b.hypotheses.entryCost).toMatchObject({ source: "fleet", units: 26199 });
  });

  it("without a volume: the per-Unit interval only (the dashboard multiplies as the visitor types)", async () => {
    const res = await request(app).get(`/offers/offer-1/target-volume-estimate?brandId=brand-1&salesFunnelIds=${IDS}&target=meeting_booked`).set(ORG);
    expect(res.status).toBe(200);
    expect(res.body.perUnit).not.toBeNull();
    expect([res.body.volume, res.body.budget, res.body.timing]).toEqual([null, null, null]);
  });

  it("refuses what it cannot answer for, by name", async () => {
    const base = `/offers/offer-1/target-volume-estimate`;
    expect((await request(app).get(`${base}?salesFunnelIds=${IDS}&target=meeting_booked`).set(ORG)).body.reason).toBe("brand_id_required");
    expect((await request(app).get(`${base}?brandId=b&salesFunnelIds=${IDS}`).set(ORG)).body.reason).toBe("target_required");
    expect((await request(app).get(`${base}?brandId=b&target=meeting_booked`).set(ORG)).body.reason).toBe("sales_funnel_ids_required");
    expect((await request(app).get(`${base}?brandId=b&salesFunnelIds=${IDS}&target=meeting_booked&volume=-1`).set(ORG)).body.reason).toBe("volume_unrecognised");
    expect((await request(app).get(`${base}?brandId=b&salesFunnelIds=${IDS}&target=meeting_booked&volume=3&period=year`).set(ORG)).body.reason).toBe("period_unrecognised");
    expect((await request(app).get(`${base}?brandId=b&salesFunnelIds=nope&target=meeting_booked`).set(ORG)).body.reason).toBe("sales_funnel_unknown");
    expect((await request(app).get(`${base}?brandId=b&salesFunnelIds=${IDS}&target=nope`).set(ORG)).body.reason).toBe("target_unknown");
    mem.offerKnown = false;
    const o = await request(app).get(`${base}?brandId=b&salesFunnelIds=${IDS}&target=meeting_booked`).set(ORG);
    expect([o.status, o.body.reason]).toEqual([404, "offer_not_found"]);
    mem.offerKnown = true;
    mem.held = false;
    const h = await request(app).get(`${base}?brandId=b&salesFunnelIds=${IDS}&target=meeting_booked`).set(ORG);
    expect([h.status, h.body.reason]).toEqual([404, "brand_not_found"]);
    mem.held = true;
  });
});
