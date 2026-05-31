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
import { SEED_FEATURES } from "../src/seed/features.js";
import { STATS_REGISTRY, VALID_STATS_KEYS } from "../src/lib/stats-registry.js";

const SALES_FEATURE = {
  id: "feat-sales",
  slug: "sales-cold-email-outreach",
  name: "Sales Cold Email Outreach",
  status: "active",
  forkedFrom: null,
  upgradedTo: null,
  inputs: [],
  outputs: [
    { key: "leadsServed", displayOrder: 1 },
    { key: "companiesServed", displayOrder: 2 },
  ],
  charts: [],
  entityTypes: [],
  workflows: [],
};

const EMPTY_REPLIES_DETAIL = {
  interested: 0,
  meetingBooked: 0,
  closed: 0,
  notInterested: 0,
  wrongPerson: 0,
  unsubscribe: 0,
  neutral: 0,
  autoReply: 0,
  outOfOffice: 0,
};

const EMPTY_OUTREACH_STATUS = {
  contacted: 0,
  sent: 0,
  delivered: 0,
  opened: 0,
  bounced: 0,
  clicked: 0,
  unsubscribed: 0,
  repliesPositive: 0,
  repliesNegative: 0,
  repliesNeutral: 0,
  repliesAutoReply: 0,
};

const COMPANIES_BLOCK = {
  served: 7,
  contacted: 6,
  sent: 5,
  delivered: 4,
  opened: 3,
  clicked: 2,
  bounced: 1,
  repliesPositive: 2,
  repliesNegative: 1,
  repliesNeutral: 0,
};

const COMPANIES_KEYS = [
  "companiesServed",
  "companiesContacted",
  "companiesSent",
  "companiesDelivered",
  "companiesOpened",
  "companiesClicked",
  "companiesBounced",
  "companiesRepliesPositive",
  "companiesRepliesNegative",
  "companiesRepliesNeutral",
] as const;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(statsRoutes);
  return app;
}

describe("companies* stat keys: registry", () => {
  it("STATS_REGISTRY contains all 10 companies* keys", () => {
    for (const k of COMPANIES_KEYS) {
      expect(VALID_STATS_KEYS.has(k), `missing ${k}`).toBe(true);
    }
  });

  it("all companies* keys are raw count with source 'leads'", () => {
    for (const k of COMPANIES_KEYS) {
      expect(STATS_REGISTRY[k]).toMatchObject({ kind: "raw", type: "count", source: "leads" });
    }
  });
});

describe("companies* stat keys: endpoint mapping", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mockLeadStats(leadResponse: unknown) {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("lead-service/orgs/stats")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(leadResponse) });
      }
      if (url.includes("campaign-service")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ stats: { byStatus: { active: 0 } } }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ groups: [] }) });
    });
  }

  it("maps byOutreachStatusCompanies block fields to companies* stat keys", async () => {
    mockLeadStats({
      totalLeads: 50,
      byOutreachStatus: EMPTY_OUTREACH_STATUS,
      byOutreachStatusCompanies: COMPANIES_BLOCK,
      repliesDetail: EMPTY_REPLIES_DETAIL,
      buffered: 0,
      skipped: 0,
      claimed: 0,
    });

    const res = await request(createApp())
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    expect(res.body.stats.companiesServed).toBe(7);
    expect(res.body.stats.companiesContacted).toBe(6);
    expect(res.body.stats.companiesSent).toBe(5);
    expect(res.body.stats.companiesDelivered).toBe(4);
    expect(res.body.stats.companiesOpened).toBe(3);
    expect(res.body.stats.companiesClicked).toBe(2);
    expect(res.body.stats.companiesBounced).toBe(1);
    expect(res.body.stats.companiesRepliesPositive).toBe(2);
    expect(res.body.stats.companiesRepliesNegative).toBe(1);
    expect(res.body.stats.companiesRepliesNeutral).toBe(0);
  });

  it("returns 0 for all companies* keys when byOutreachStatusCompanies missing (rollout-window safety)", async () => {
    mockLeadStats({
      totalLeads: 50,
      byOutreachStatus: EMPTY_OUTREACH_STATUS,
      // byOutreachStatusCompanies intentionally omitted — pre-rollout shape
      repliesDetail: EMPTY_REPLIES_DETAIL,
      buffered: 0,
      skipped: 0,
      claimed: 0,
    });

    const res = await request(createApp())
      .get("/features/sales-cold-email-outreach/stats")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    for (const k of COMPANIES_KEYS) {
      expect(res.body.stats[k], `${k} expected 0`).toBe(0);
    }
  });

  it("forwards companies* per group when groupBy=campaignId", async () => {
    mockLeadStats({
      groups: [
        {
          key: "camp-a",
          totalLeads: 10,
          byOutreachStatus: EMPTY_OUTREACH_STATUS,
          byOutreachStatusCompanies: { ...COMPANIES_BLOCK, served: 3 },
          repliesDetail: EMPTY_REPLIES_DETAIL,
          buffered: 0,
          skipped: 0,
          claimed: 0,
        },
        {
          key: "camp-b",
          totalLeads: 20,
          byOutreachStatus: EMPTY_OUTREACH_STATUS,
          byOutreachStatusCompanies: { ...COMPANIES_BLOCK, served: 8 },
          repliesDetail: EMPTY_REPLIES_DETAIL,
          buffered: 0,
          skipped: 0,
          claimed: 0,
        },
      ],
    });

    const res = await request(createApp())
      .get("/features/sales-cold-email-outreach/stats?groupBy=campaignId")
      .set("x-api-key", "test-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .set("x-run-id", "run-1")
      .expect(200);

    expect(res.body.groups).toHaveLength(2);
    const groupA = res.body.groups.find((g: { campaignId: string }) => g.campaignId === "camp-a");
    const groupB = res.body.groups.find((g: { campaignId: string }) => g.campaignId === "camp-b");
    expect(groupA.stats.companiesServed).toBe(3);
    expect(groupB.stats.companiesServed).toBe(8);
  });
});

// DIS-114: cold-email features no longer DISPLAY the companies*/leads* family on
// the ranked leaderboard — that family is unpopulated per-workflow until lead-service
// ships byOutreachStatusCompanies (DIS-10). The keys remain in STATS_REGISTRY and the
// stats route still maps them (see "endpoint mapping" tests above), so the B2B-funnel
// follow-up stays a pure seed change. Cold-email outputs now use recipients* (email-gateway).
describe("companies* stat keys: cold-email features do not display them (DIS-114)", () => {
  const COLD_EMAIL_SLUGS = [
    "sales-cold-email-outreach",
    "vc-cold-email-outreach",
    "accelerators-cold-email-outreach",
    "hiring-cold-email-outreach",
  ];

  for (const slug of COLD_EMAIL_SLUGS) {
    it(`${slug}: outputs contain no leads*/companies*/costPerLead* keys`, () => {
      const feature = SEED_FEATURES.find((f) => f.slug === slug);
      expect(feature, `seed feature ${slug} missing`).toBeDefined();
      const outputKeys = (feature!.outputs as { key: string }[]).map((o) => o.key);
      for (const k of outputKeys) {
        const isLeadOrCompany =
          k.startsWith("leads") ||
          k.startsWith("lead") ||
          k.startsWith("companies") ||
          k.startsWith("costPerLead");
        expect(isLeadOrCompany, `${slug} output "${k}" still lead/company-scoped`).toBe(false);
      }
    });
  }
});
