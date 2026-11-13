import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/** SCRIPT-VALUE-RATING-1113-RATES: the real route, the producers mocked, the Gold cache off. */
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
process.env.FEATURES_SERVICE_API_KEY = "k";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";

let held = true;
let runsDown = false;
vi.mock("../lib/brand-ownership.js", async (orig) => {
  const real = await orig<typeof import("../lib/brand-ownership.js")>();
  return { ...real, assertBrandHeld: async (brandId: string, h: { orgId: string }) => { if (!held) throw new real.BrandOwnershipError(brandId, h.orgId, "not yours"); } };
});
vi.mock("../lib/brand-leg-economics-client.js", () => ({
  fetchBrandLegEconomics: async () => ({
    legRates: [
      { fromStep: "Positive reply", toStep: "Meeting booked", ratePct: 25, stated: true },
      { fromStep: "Meeting attended", toStep: "Paid client", ratePct: 65, stated: true },
      { fromStep: "Website visit", toStep: "Signup", ratePct: null, stated: false },
    ],
    offers: [],
  }),
}));
vi.mock("../lib/meeting-reporting-client.js", () => ({ getMeetingReporting: async () => ({ reports: (b: string) => b === "brand-1", reportingBrandIds: ["brand-1"] }) }));
vi.mock("../lib/script-value-rating-io.js", () => ({
  readStepRateBook: async (brandId: string | null) => {
    if (runsDown) throw new Error("runs-service 503");
    const steps = brandId === null
      ? [{ fromOutcome: "conversation", toOutcome: "meeting_booked", consumedUnits: 45, ledUnits: 8 }]
      : [{ fromOutcome: "conversation", toOutcome: "meeting_booked", consumedUnits: 12, ledUnits: 3 }, { fromOutcome: "meeting_attended", toOutcome: "paid_client", consumedUnits: 1, ledUnits: 1 }];
    return { builtAt: "2026-11-13T17:00:00.000Z", consumed: new Map(steps.map((s) => [s.fromOutcome, s.consumedUnits])), steps };
  },
}));

const { default: routes } = await import("./rate-sources.js");
const app = express().use(routes);
const identity = { "x-api-key": "k", "x-org-id": "11111111-1111-4111-8111-111111111111", "x-user-id": "22222222-2222-4222-8222-222222222222", "x-run-id": "33333333-3333-4333-8333-333333333333" };

beforeEach(() => {
  held = true;
  runsDown = false;
});

describe("GET /brands/:brandId/rate-sources", () => {
  it("measured legs are shown, the others asked with their default", async () => {
    const res = await request(app).get("/brands/brand-1/rate-sources").set(identity);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ brandId: "brand-1", minConsumedUnits: 10, reportsMeetings: true });
    const [reply, attended, visit] = res.body.legs;
    expect(reply).toMatchObject({ ask: false, source: "measured", ratePct: 25, ledger: { consumedUnits: 12, ledUnits: 3 } });
    expect(attended).toMatchObject({ ask: true, source: "stated", ratePct: 65, unmeasuredReason: "too_few_units" });
    expect(visit).toMatchObject({ ask: true, source: "default", unmeasuredReason: "too_few_units", defaultSource: "leg_default" });
  });

  it("a brand that reports no meeting is asked every meeting leg", async () => {
    const res = await request(app).get("/brands/brand-2/rate-sources").set(identity);
    expect(res.body.legs[0]).toMatchObject({ ask: true, unmeasuredReason: "brand_reports_no_meetings", source: "stated" });
  });

  it("a brand the org does not hold is a 404; a producer down a 502, never a guess", async () => {
    held = false;
    expect((await request(app).get("/brands/brand-1/rate-sources").set(identity)).status).toBe(404);
    held = true;
    runsDown = true;
    const res = await request(app).get("/brands/brand-1/rate-sources").set(identity);
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("rate_sources_unreadable");
  });
});
