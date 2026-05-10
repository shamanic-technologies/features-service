import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

vi.stubEnv("FEATURES_SERVICE_API_KEY", "test-key");
vi.stubEnv("RUNS_SERVICE_URL", "http://runs-service");
vi.stubEnv("RUNS_SERVICE_API_KEY", "runs-key");
vi.stubEnv("EMAIL_GATEWAY_SERVICE_URL", "http://email-gateway");
vi.stubEnv("EMAIL_GATEWAY_SERVICE_API_KEY", "email-gw-key");
vi.stubEnv("OUTLETS_SERVICE_URL", "http://outlets-service");
vi.stubEnv("OUTLETS_SERVICE_API_KEY", "outlets-key");
vi.stubEnv("JOURNALISTS_SERVICE_URL", "http://journalists-service");
vi.stubEnv("JOURNALISTS_SERVICE_API_KEY", "journalists-key");
vi.stubEnv("LEAD_SERVICE_URL", "http://lead-service");
vi.stubEnv("LEAD_SERVICE_API_KEY", "lead-key");
vi.stubEnv("CAMPAIGN_SERVICE_URL", "http://campaign-service");
vi.stubEnv("CAMPAIGN_SERVICE_API_KEY", "campaign-key");
vi.stubEnv("JOURNALISTS_QUOTES_SERVICE_URL", "http://journalists-quotes-service");
vi.stubEnv("JOURNALISTS_QUOTES_SERVICE_API_KEY", "jq-key");
vi.stubEnv("AI_VISIBILITY_SERVICE_URL", "http://ai-visibility-service");
vi.stubEnv("AI_VISIBILITY_SERVICE_API_KEY", "av-key");

vi.mock("../src/db/index.js", () => ({
  db: {
    query: {
      features: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
    },
  },
}));

import statsRoutes from "../src/routes/stats.js";
import { db } from "../src/db/index.js";

const QUOTES_FEATURE = {
  id: "feat-1",
  slug: "pr-expert-quote-outreach",
  name: "PR Expert Quote Outreach",
  status: "active",
  forkedFrom: null,
  upgradedTo: null,
  inputs: [],
  outputs: [],
  charts: [],
  entityTypes: [],
  workflows: [],
};

const VISIBILITY_FEATURE = {
  id: "feat-2",
  slug: "ai-visibility-scoring",
  name: "AI Visibility Scoring",
  status: "active",
  forkedFrom: null,
  upgradedTo: null,
  inputs: [],
  outputs: [],
  charts: [],
  entityTypes: [],
  workflows: [],
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(statsRoutes);
  return app;
}

const AUTH = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "run-1",
};

describe("stats fan-out: journalists-quotes-service", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.mocked(db.query.features.findFirst).mockResolvedValue(QUOTES_FEATURE as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function defaultFetch(urlStr: string): Promise<{ ok: boolean; json: () => Promise<unknown> }> {
    if (urlStr.includes("journalists-quotes-service/orgs/quote-requests/stats")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          totalRequests: 42,
          totalPitched: 30,
          totalSelected: 8,
          totalPublished: 5,
          totalNotSelected: 22,
        }),
      });
    }
    if (urlStr.includes("campaign-service")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ stats: { byStatus: { active: 0 } } }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ groups: [] }) });
  }

  it("calls /orgs/quote-requests/stats with campaign_id when campaignId filter present", async () => {
    fetchSpy.mockImplementation((url: string) => defaultFetch(url));
    const app = createApp();

    await request(app)
      .get("/features/pr-expert-quote-outreach/stats?campaignId=camp-uuid-1")
      .set(AUTH)
      .expect(200);

    const calls = fetchSpy.mock.calls.filter(
      ([url]: [string]) => url.includes("journalists-quotes-service/orgs/quote-requests/stats"),
    );
    expect(calls.length).toBe(1);
    const url = new URL(calls[0][0]);
    expect(url.searchParams.get("campaign_id")).toBe("camp-uuid-1");
  });

  it("does NOT call quote-requests/stats when campaignId is missing", async () => {
    fetchSpy.mockImplementation((url: string) => defaultFetch(url));
    const app = createApp();

    await request(app)
      .get("/features/pr-expert-quote-outreach/stats")
      .set(AUTH)
      .expect(200);

    const calls = fetchSpy.mock.calls.filter(
      ([url]: [string]) => url.includes("journalists-quotes-service/orgs/quote-requests/stats"),
    );
    expect(calls.length).toBe(0);
  });

  it("maps the 5 totals into stats keys", async () => {
    fetchSpy.mockImplementation((url: string) => defaultFetch(url));
    const app = createApp();

    const res = await request(app)
      .get("/features/pr-expert-quote-outreach/stats?campaignId=camp-uuid-1")
      .set(AUTH)
      .expect(200);

    expect(res.body.stats.quoteRequestsFound).toBe(42);
    expect(res.body.stats.quotePitchesSubmitted).toBe(30);
    expect(res.body.stats.quotesSelected).toBe(8);
    expect(res.body.stats.quotesPublished).toBe(5);
    expect(res.body.stats.quotesNotSelected).toBe(22);
    // derived
    expect(res.body.stats.pitchSelectionRate).toBeCloseTo(8 / 30);
    expect(res.body.stats.pitchPublishRate).toBeCloseTo(5 / 30);
  });

  it("forwards identity headers downstream (x-api-key, x-org-id, x-run-id, x-campaign-id)", async () => {
    fetchSpy.mockImplementation((url: string) => defaultFetch(url));
    const app = createApp();

    await request(app)
      .get("/features/pr-expert-quote-outreach/stats?campaignId=camp-uuid-1")
      .set(AUTH)
      .set("x-campaign-id", "camp-uuid-1")
      .expect(200);

    const calls = fetchSpy.mock.calls.filter(
      ([url]: [string]) => url.includes("journalists-quotes-service/orgs/quote-requests/stats"),
    );
    expect(calls.length).toBe(1);
    const init = calls[0][1] as { headers: Record<string, string> };
    expect(init.headers["x-api-key"]).toBe("jq-key");
    expect(init.headers["x-org-id"]).toBe("org-1");
    expect(init.headers["x-run-id"]).toBe("run-1");
    expect(init.headers["x-campaign-id"]).toBe("camp-uuid-1");
  });
});

describe("stats fan-out: ai-visibility-score-service", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.mocked(db.query.features.findFirst).mockResolvedValue(VISIBILITY_FEATURE as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const VISIBILITY_RUN = {
    runs: [{
      id: "run-uuid",
      visibilityScore: "0.7321",
      brandMentionRate: "0.4500",
      shareOfVoice: "0.3200",
      netSentiment: "0.6500",
      citationRate: "0.1800",
      avgPosition: "2.4",
    }],
    limit: 1,
    offset: 0,
  };

  function makeFetch(brandIdLookup?: { campaignId: string; brandIds: string[] | null }) {
    return (urlStr: string) => {
      if (urlStr.includes("ai-visibility-service/orgs/visibility-score-runs")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(VISIBILITY_RUN) });
      }
      if (brandIdLookup && urlStr.includes(`campaign-service/campaigns/${brandIdLookup.campaignId}`)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ campaign: { brandIds: brandIdLookup.brandIds } }),
        });
      }
      if (urlStr.includes("campaign-service")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ stats: { byStatus: { active: 0 } } }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ groups: [] }) });
    };
  }

  it("uses brandId from query and calls /orgs/visibility-score-runs?brandId=...&limit=1", async () => {
    fetchSpy.mockImplementation((url: string) => makeFetch()(url));
    const app = createApp();

    await request(app)
      .get("/features/ai-visibility-scoring/stats?brandId=brand-uuid-1")
      .set(AUTH)
      .expect(200);

    const calls = fetchSpy.mock.calls.filter(
      ([url]: [string]) => url.includes("ai-visibility-service/orgs/visibility-score-runs"),
    );
    expect(calls.length).toBe(1);
    const url = new URL(calls[0][0]);
    expect(url.searchParams.get("brandId")).toBe("brand-uuid-1");
    expect(url.searchParams.get("limit")).toBe("1");
  });

  it("resolves brandId from campaignId when no direct brandId is provided", async () => {
    fetchSpy.mockImplementation((url: string) =>
      makeFetch({ campaignId: "camp-uuid-1", brandIds: ["brand-from-campaign"] })(url),
    );
    const app = createApp();

    await request(app)
      .get("/features/ai-visibility-scoring/stats?campaignId=camp-uuid-1")
      .set(AUTH)
      .expect(200);

    const lookup = fetchSpy.mock.calls.filter(
      ([url]: [string]) => url.includes("campaign-service/campaigns/camp-uuid-1"),
    );
    expect(lookup.length).toBe(1);

    const visibility = fetchSpy.mock.calls.filter(
      ([url]: [string]) => url.includes("ai-visibility-service/orgs/visibility-score-runs"),
    );
    expect(visibility.length).toBe(1);
    expect(new URL(visibility[0][0]).searchParams.get("brandId")).toBe("brand-from-campaign");
  });

  it("skips ai-visibility call when neither brandId nor campaignId is available", async () => {
    fetchSpy.mockImplementation((url: string) => makeFetch()(url));
    const app = createApp();

    await request(app)
      .get("/features/ai-visibility-scoring/stats")
      .set(AUTH)
      .expect(200);

    const calls = fetchSpy.mock.calls.filter(
      ([url]: [string]) => url.includes("ai-visibility-service/orgs/visibility-score-runs"),
    );
    expect(calls.length).toBe(0);
  });

  it("parses decimal-string fields into numbers in the stats response", async () => {
    fetchSpy.mockImplementation((url: string) => makeFetch()(url));
    const app = createApp();

    const res = await request(app)
      .get("/features/ai-visibility-scoring/stats?brandId=brand-uuid-1")
      .set(AUTH)
      .expect(200);

    expect(res.body.stats.visibilityScore).toBeCloseTo(0.7321);
    expect(res.body.stats.brandMentionRate).toBeCloseTo(0.45);
    expect(res.body.stats.shareOfVoice).toBeCloseTo(0.32);
    expect(res.body.stats.netSentiment).toBeCloseTo(0.65);
    expect(res.body.stats.citationRate).toBeCloseTo(0.18);
    expect(res.body.stats.avgPosition).toBeCloseTo(2.4);
  });

  it("returns nulls when there are no runs yet", async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("ai-visibility-service/orgs/visibility-score-runs")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ runs: [], limit: 1, offset: 0 }) });
      }
      if (url.includes("campaign-service")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ stats: { byStatus: { active: 0 } } }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ groups: [] }) });
    });
    const app = createApp();

    const res = await request(app)
      .get("/features/ai-visibility-scoring/stats?brandId=brand-uuid-1")
      .set(AUTH)
      .expect(200);

    expect(res.body.stats.visibilityScore).toBeNull();
    expect(res.body.stats.shareOfVoice).toBeNull();
  });
});
