import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockExtractBrandFields = vi.fn();

vi.mock("../db/index.js", () => ({
  db: {
    query: {
      features: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
  },
  sql: {},
}));

vi.mock("../lib/brand-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  extractBrandFields: (...args: unknown[]) => mockExtractBrandFields(...args),
}));

vi.mock("../lib/env.js", () => ({
  validateRequiredEnv: vi.fn(),
  REQUIRED_ENV: [],
}));

vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({
  default: { setupExpressErrorHandler: vi.fn() },
  setupExpressErrorHandler: vi.fn(),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";
process.env.OUTLETS_SERVICE_URL = "http://outlets:3000";
process.env.OUTLETS_SERVICE_API_KEY = "outlets-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const app = (await import("../index.js")).default;
const { BrandFieldExtractionError } = await import("../lib/brand-client.js");

const AUTH_HEADERS = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "run-1",
};

describe("GET /features", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns active features by default", async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: "1", slug: "sales-cold-email-outreach", name: "Sales Cold Email Outreach", description: "test", icon: "mail", implemented: true, displayOrder: 0, status: "active", inputs: [], outputs: [], charts: [], entities: [] },
    ]);

    const res = await request(app).get("/features").set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.features).toHaveLength(1);
    expect(res.body.features[0].slug).toBe("sales-cold-email-outreach");
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/features");
    expect(res.status).toBe(401);
  });
});

describe("GET /features/:slug", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns feature by exact slug", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: "1",
      slug: "sales-cold-email-outreach",
      name: "Sales Cold Email Outreach",
      description: "test",
      icon: "mail",
      implemented: true,
      displayOrder: 0,
      status: "active",
      inputs: [],
      outputs: [],
      charts: [],
      entities: [],
    });

    const res = await request(app).get("/features/sales-cold-email-outreach").set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.feature.slug).toBe("sales-cold-email-outreach");
  });

  it("returns 404 when slug not found", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const res = await request(app).get("/features/nonexistent").set(AUTH_HEADERS);

    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/features/sales-cold-email-outreach");
    expect(res.status).toBe(401);
  });
});

describe("GET /features/:featureSlug/inputs", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns inputs for a feature", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: "1",
      slug: "pr-cold-email-outreach",
      name: "PR Cold Email Outreach",
      inputs: [
        { key: "prAngle", extractKey: "suggestedAngles", description: "The editorial hook" },
      ],
    });

    const res = await request(app).get("/features/pr-cold-email-outreach/inputs").set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("pr-cold-email-outreach");
    expect(res.body.name).toBe("PR Cold Email Outreach");
    expect(res.body.inputs).toHaveLength(1);
    expect(res.body.inputs[0].key).toBe("prAngle");
  });

  it("returns 404 when feature not found", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const res = await request(app).get("/features/nonexistent/inputs").set(AUTH_HEADERS);

    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/features/pr-cold-email-outreach/inputs");
    expect(res.status).toBe(401);
  });
});

describe("POST /features/:featureSlug/prefill", () => {
  const PREFILL_HEADERS = {
    ...AUTH_HEADERS,
    "x-brand-id": "brand-1",
  };

  const FEATURE_WITH_INPUTS = {
    id: "1",
    slug: "pr-cold-email-outreach",
    name: "PR Cold Email Outreach",
    description: "test",
    icon: "mail",
    implemented: true,
    displayOrder: 0,
    status: "active",
    inputs: [
      { key: "prAngle", extractKey: "suggestedAngles", description: "The editorial hook" },
      { key: "spokesperson", extractKey: "spokesperson", description: "Who is available for interviews" },
    ],
    outputs: [],
    charts: [],
    entities: [],
  };

  beforeEach(() => { vi.clearAllMocks(); });

  it("returns prefilled values in text format", async () => {
    mockFindFirst.mockResolvedValueOnce(FEATURE_WITH_INPUTS);
    mockExtractBrandFields.mockResolvedValueOnce({
      suggestedAngles: { value: "Series B funding announcement", byBrand: {} },
      spokesperson: { value: "Jane Doe, CEO", byBrand: {} },
    });

    const res = await request(app)
      .post("/features/pr-cold-email-outreach/prefill?format=text")
      .set(PREFILL_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("pr-cold-email-outreach");
    expect(res.body.format).toBe("text");
    expect(res.body.prefilled.prAngle).toBe("Series B funding announcement");
    expect(res.body.prefilled.spokesperson).toBe("Jane Doe, CEO");
  });

  it("returns prefilled values in full format by default", async () => {
    mockFindFirst.mockResolvedValueOnce(FEATURE_WITH_INPUTS);
    mockExtractBrandFields.mockResolvedValueOnce({
      suggestedAngles: { value: "Series B", byBrand: { "brand-1": { value: "Series B", cached: true, extractedAt: "2026-01-01", expiresAt: null, sourceUrls: null } } },
      spokesperson: { value: null, byBrand: {} },
    });

    const res = await request(app)
      .post("/features/pr-cold-email-outreach/prefill")
      .set(PREFILL_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.format).toBe("full");
    expect(res.body.prefilled.prAngle.value).toBe("Series B");
    expect(res.body.prefilled.prAngle.byBrand).toBeDefined();
    expect(res.body.prefilled.spokesperson.value).toBeNull();
  });

  it("returns 400 when x-brand-id is missing", async () => {
    const res = await request(app)
      .post("/features/pr-cold-email-outreach/prefill")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/brand/i);
  });

  it("returns 404 when feature not found", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/features/nonexistent/prefill")
      .set(PREFILL_HEADERS);

    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid format", async () => {
    const res = await request(app)
      .post("/features/pr-cold-email-outreach/prefill?format=xml")
      .set(PREFILL_HEADERS);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/format/);
  });

  it("returns 502 when brand-service fails", async () => {
    mockFindFirst.mockResolvedValueOnce(FEATURE_WITH_INPUTS);
    mockExtractBrandFields.mockRejectedValueOnce(new Error("brand-service extract-fields failed (500): Internal error"));

    const res = await request(app)
      .post("/features/pr-cold-email-outreach/prefill?format=text")
      .set(PREFILL_HEADERS);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/brand-service/);
  });

  it("requires authentication", async () => {
    const res = await request(app).post("/features/pr-cold-email-outreach/prefill");
    expect(res.status).toBe(401);
  });

  // ── WHICH OFFER the channel is being started for ──────────────────────────────
  //
  // A brand selling two offers could not start a channel at all: the prefill asked brand-service for
  // fields describing ONE proposition, brand-service refused (409 SEVERAL_OFFERS) rather than guess,
  // and the refusal reached the dashboard as a bare 502. Every case below asserts the DIVERGENCE
  // between naming an offer and naming none — a suite that only checked "a 200 came back" would pass
  // on an implementation that ignored the parameter entirely.
  describe("offerId", () => {
    const OFFER_ID = "832126f3-0000-4000-8000-000000000001";

    it("forwards the named offer to brand-service, and a several-offer brand answers 200", async () => {
      mockFindFirst.mockResolvedValueOnce(FEATURE_WITH_INPUTS);
      mockExtractBrandFields.mockResolvedValueOnce({
        suggestedAngles: { value: "Product-led angle", byBrand: {} },
        spokesperson: { value: "Jane Doe, CEO", byBrand: {} },
      });

      const res = await request(app)
        .post("/features/pr-cold-email-outreach/prefill?format=text")
        .set(PREFILL_HEADERS)
        .send({ offerId: OFFER_ID });

      expect(res.status).toBe(200);
      expect(res.body.prefilled.prAngle).toBe("Product-led angle");
      // Third argument, so the identity headers are byte-unchanged.
      expect(mockExtractBrandFields.mock.calls[0][2]).toBe(OFFER_ID);
    });

    it("names NOTHING downstream when the caller named none — the single-offer path is unchanged", async () => {
      mockFindFirst.mockResolvedValueOnce(FEATURE_WITH_INPUTS);
      mockExtractBrandFields.mockResolvedValueOnce({
        suggestedAngles: { value: "Series B", byBrand: {} },
        spokesperson: { value: null, byBrand: {} },
      });

      const res = await request(app)
        .post("/features/pr-cold-email-outreach/prefill?format=text")
        .set(PREFILL_HEADERS);

      expect(res.status).toBe(200);
      expect(mockExtractBrandFields.mock.calls[0][2]).toBeUndefined();
    });

    it("an empty body is the same as no body — still no offer named", async () => {
      mockFindFirst.mockResolvedValueOnce(FEATURE_WITH_INPUTS);
      mockExtractBrandFields.mockResolvedValueOnce({ suggestedAngles: { value: "x", byBrand: {} } });

      const res = await request(app)
        .post("/features/pr-cold-email-outreach/prefill?format=text")
        .set(PREFILL_HEADERS)
        .send({});

      expect(res.status).toBe(200);
      expect(mockExtractBrandFields.mock.calls[0][2]).toBeUndefined();
    });

    it("serves the several-offers refusal as a 409 carrying the offers, never a 502 and never a guess", async () => {
      mockFindFirst.mockResolvedValueOnce(FEATURE_WITH_INPUTS);
      const offers = [
        { offerId: "832126f3-0000-4000-8000-000000000001", name: "Product-led" },
        { offerId: "5a2868bb-0000-4000-8000-000000000002", name: "Sales-led" },
      ];
      mockExtractBrandFields.mockRejectedValueOnce(
        new BrandFieldExtractionError("This brand sells several offers; name one.", 409, "SEVERAL_OFFERS", offers),
      );

      const res = await request(app)
        .post("/features/pr-cold-email-outreach/prefill?format=text")
        .set(PREFILL_HEADERS);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("several_offers");
      expect(res.body.error).toBe("This brand sells several offers; name one.");
      expect(res.body.offers).toEqual(offers);
    });

    it("serves an unknown offer as a 404 with brand-service's own sentence", async () => {
      mockFindFirst.mockResolvedValueOnce(FEATURE_WITH_INPUTS);
      mockExtractBrandFields.mockRejectedValueOnce(
        new BrandFieldExtractionError("Offer not found for this brand", 404, "OFFER_NOT_FOUND", []),
      );

      const res = await request(app)
        .post("/features/pr-cold-email-outreach/prefill?format=text")
        .set(PREFILL_HEADERS)
        .send({ offerId: OFFER_ID });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Offer not found for this brand");
      expect(res.body.code).toBe("offer_not_found");
    });

    it("every other brand-service failure is still a 502", async () => {
      mockFindFirst.mockResolvedValueOnce(FEATURE_WITH_INPUTS);
      mockExtractBrandFields.mockRejectedValueOnce(
        new BrandFieldExtractionError("brand-service extract-fields failed (500): boom", 500, null, []),
      );

      const res = await request(app)
        .post("/features/pr-cold-email-outreach/prefill?format=text")
        .set(PREFILL_HEADERS);

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/brand-service/);
    });

    it("refuses a malformed offerId rather than dropping it — a dropped value re-enters the 409 silently", async () => {
      mockFindFirst.mockResolvedValue(FEATURE_WITH_INPUTS);

      for (const bad of ["not-a-uuid", 42, { id: OFFER_ID }]) {
        const res = await request(app)
          .post("/features/pr-cold-email-outreach/prefill?format=text")
          .set(PREFILL_HEADERS)
          .send({ offerId: bad });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("offer_id_unrecognised");
      }
      expect(mockExtractBrandFields).not.toHaveBeenCalled();
    });
  });
});
