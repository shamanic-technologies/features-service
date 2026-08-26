/**
 * A CAMPAIGN ROW ANSWERS "IS THIS WORKING?" — and the answer is unreadable without its volume.
 *
 * The Campaigns list gives each row ROI, %CAC, expected pipeline and invested spend. All three
 * ratios are derived from however many outcomes the campaign has produced so far, so with one or two
 * behind them they are decided by whichever one happened to land: they swing by whole multiples on
 * the next reply while a customer reads them as a measurement. A consumer could not tell how much
 * evidence a row rested on — the group carried the money and nothing about volume, and there is no
 * per-campaign outcome count anywhere else on the wire.
 *
 * These drive `?groupBy=campaignId` from ONE downstream fixture and assert the volume half is
 * answered on the SAME terms as the money it sits beside: totalled over the campaign's IDENTITY,
 * deduped inside it, on the one COMMITTED spend basis, and honestly null rather than a fabricated 0.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } },
  sql: {},
}));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
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
process.env.LEAD_SERVICE_URL = "http://leads:3000";
process.env.LEAD_SERVICE_API_KEY = "leads-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };

const RECIPIENT_KEYS = [
  "recipientsContacted", "recipientsSent", "recipientsDelivered", "recipientsOpened", "recipientsClicked",
  "recipientsBounced", "recipientsRepliesPositive", "recipientsRepliesNegative", "recipientsRepliesNeutral",
];
function feature(slug: string): Record<string, unknown> {
  return {
    id: "feat-1", slug, name: slug, description: "x", status: "active",
    outputs: RECIPIENT_KEYS.map((key) => ({ key })),
    charts: [],
    createdAt: new Date(), updatedAt: new Date(),
  };
}
/** The measured channel. `press-kit-generation` declares no funnel — the honest-null case below. */
const SALES = "sales-cold-email-outreach";
const NO_FUNNEL = "press-kit-generation";

const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToSignupPct: 20,
  signupToPaidClientPct: 10,
  visitToClosePct: 2,
};

type LeadShape = { clicked?: boolean; positive?: boolean };

function lead(campaignId: string, leadId: string, shape: LeadShape = { positive: true }): Record<string, unknown> {
  return {
    leadId,
    campaignId,
    email: `${leadId}@x.com`,
    contacted: true,
    sent: true,
    delivered: true,
    clicked: Boolean(shape.clicked),
    bounced: false,
    unsubscribed: false,
    replied: Boolean(shape.positive),
    replyClassification: shape.positive ? "positive" : null,
    lead: { firstName: "A", lastName: "B", photoUrl: null, organization: { id: leadId, name: leadId, logoUrl: null } },
  };
}

interface Fixture {
  campaigns: Array<Record<string, unknown>>;
  /** Per-campaign COMMITTED cents (actual + holds) — the basis every figure here rides. */
  committedByCampaign: Record<string, number>;
  /** Per-campaign BILLED-only cents. Deliberately LOWER, so a committed/billed swap cannot pass. */
  actualByCampaign: Record<string, number>;
  leads: Array<Record<string, unknown>>;
}

function mockFetch(fixture: Fixture): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const cid = (init?.headers as Record<string, string> | undefined)?.["x-campaign-id"];
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (url.includes("/campaigns?")) return json({ campaigns: fixture.campaigns });
    // The brand declares nothing readable → the brand-wide economics price the pipeline, unchanged.
    if (url.includes("/sales-funnels")) return new Response("not found", { status: 404 });
    if (url.includes("/stats/costs")) {
      const ids = cid ? [cid] : Object.keys(fixture.committedByCampaign);
      return json({
        groups: ids.map((id) => ({
          dimensions: { campaignId: id, workflowSlug: "wf-1", costName: "email-send" },
          totalCostInUsdCents: String(fixture.committedByCampaign[id] ?? 0),
          actualCostInUsdCents: String(fixture.actualByCampaign[id] ?? 0),
          runCount: 1,
          minStartedAt: null,
          maxStartedAt: null,
        })),
      });
    }
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/orgs/leads")) {
      return json({ leads: cid ? fixture.leads.filter((l) => l.campaignId === cid) : fixture.leads });
    }
    if (url.includes("/manual-qualifications")) return json({ qualifications: [] });
    if (url.includes("/orgs/status")) return json({ results: [] });
    return json({});
  });
}

function campaign(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, orgId: "org-1", brandId: "b1", brandIds: ["b1"], featureSlug: SALES,
    funnelKey: null, acquisitionChannel: "cold_email", status: "ongoing",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

/** Two stopped ancestors + the live row, all ONE identity — the shape the grouping exists for. */
const FAMILY = [
  campaign("stopped-1", { status: "stopped", createdAt: "2026-06-01T00:00:00.000Z" }),
  campaign("stopped-2", { status: "stopped", createdAt: "2026-06-15T00:00:00.000Z" }),
  campaign("live"),
];

async function groups(slug = SALES): Promise<Record<string, any>> {
  const res = await request(app).get(`/features/${slug}/revenue?brandId=b1&groupBy=campaignId`).set(AUTH);
  expect(res.status).toBe(200);
  return Object.fromEntries(res.body.groups.map((g: { campaignId: string }) => [g.campaignId, g]));
}

describe("a campaign group states how much outcome evidence its money rests on", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockImplementation(
      (async (args: { where: unknown }) => feature(String((args as any)?.where?.value ?? SALES))) as never,
    );
    vi.mocked(db.query.features.findFirst).mockResolvedValue(feature(SALES) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("totals the volume over the IDENTITY, counts a shared lead once, and rides COMMITTED spend", async () => {
    mockFetch({
      campaigns: FAMILY,
      // Committed is deliberately ABOVE billed: a block that had silently kept the billed basis
      // would read 8000 here and fail, which is the whole point of splitting the two.
      committedByCampaign: { "stopped-1": 3000, "stopped-2": 2000, live: 5000 },
      actualByCampaign: { "stopped-1": 2000, "stopped-2": 1000, live: 5000 },
      leads: [
        // The SAME person, re-served by the live row after its ancestor stopped — ONE lead.
        lead("stopped-1", "shared", { positive: true, clicked: true }),
        lead("live", "shared", { positive: true, clicked: true }),
        lead("stopped-2", "replier"),
        lead("live", "quiet", {}),
      ],
    });

    const byId = await groups();
    expect(Object.keys(byId).sort()).toEqual(["live", "stopped-1", "stopped-2"]);

    for (const id of ["live", "stopped-1", "stopped-2"]) {
      const o = byId[id].outcomes;
      // Three distinct people across the family, not the four rows the producer served.
      expect(o.recipientsContacted).toBe(3);
      expect(o.recipientsClicked).toBe(1);
      expect(o.recipientsRepliesPositive).toBe(2);
      // The identity's whole spend, on both bases, each summed over the members.
      expect(o.committedSpentCents).toBe(10000);
      expect(o.actualSpentCents).toBe(8000);
      // Every rate is denominated in the COMMITTED cents beside it — one basis, so
      // cpprCents × recipientsRepliesPositive ≈ committedSpentCents by construction.
      expect(o.cpcCents).toBe(10000);
      expect(o.cpprCents).toBe(5000);
      expect(o.cpprCents * o.recipientsRepliesPositive).toBe(o.committedSpentCents);
      // ...and it is the SAME money the row's ROI divides by, so the two halves cannot describe
      // different dollars.
      expect(byId[id].costEconomics.committedCostUsd).toBeCloseTo(o.committedSpentCents / 100, 6);
    }

    // Every member of an identity carries the identical block, exactly as it carries the identical money.
    expect(byId.live.outcomes).toEqual(byId["stopped-1"].outcomes);
  });

  it("never reports more people than the brand — and the identities do not sum to it", async () => {
    mockFetch({
      campaigns: [
        ...FAMILY,
        // A second identity (different channel) that worked one of the SAME people.
        campaign("crm", { acquisitionChannel: "crm_email" }),
      ],
      committedByCampaign: { "stopped-1": 3000, "stopped-2": 2000, live: 5000, crm: 4000 },
      actualByCampaign: { "stopped-1": 3000, "stopped-2": 2000, live: 5000, crm: 4000 },
      leads: [
        lead("live", "shared"),
        lead("crm", "shared"),
        lead("live", "only-cold"),
      ],
    });

    const brand = await request(app).get(`/features/${SALES}/revenue?brandId=b1`).set(AUTH);
    expect(brand.status).toBe(200);
    expect(brand.body.recipientsContacted.total).toBe(2);

    const byId = await groups();
    expect(byId.live.outcomes.recipientsContacted).toBe(2);
    expect(byId.crm.outcomes.recipientsContacted).toBe(1);
    // A lead worked through two campaigns is ONE lead to the brand and belongs to BOTH rows, so the
    // rows over-count the brand when added. That is counting people, not an error to correct — and
    // no single row ever exceeds the brand.
    const summed = byId.live.outcomes.recipientsContacted + byId.crm.outcomes.recipientsContacted;
    expect(summed).toBe(3);
    expect(summed).toBeGreaterThan(brand.body.recipientsContacted.total);
    for (const id of Object.keys(byId)) {
      expect(byId[id].outcomes.recipientsContacted).toBeLessThanOrEqual(brand.body.recipientsContacted.total);
    }
  });

  it("a one-campaign identity reads the same block its own standalone ?campaignId= read reads", async () => {
    mockFetch({
      campaigns: [campaign("cold"), campaign("crm", { acquisitionChannel: "crm_email" })],
      committedByCampaign: { cold: 3000, crm: 5000 },
      actualByCampaign: { cold: 3000, crm: 5000 },
      leads: [lead("cold", "l1", { positive: true, clicked: true }), lead("crm", "l2")],
    });

    const byId = await groups();
    for (const id of ["cold", "crm"]) {
      const single = await request(app).get(`/features/${SALES}/revenue?brandId=b1&campaignId=${id}`).set(AUTH);
      expect(single.status).toBe(200);
      expect(byId[id].outcomes).toEqual(single.body.outcomes);
    }
    // And it is the campaign's OWN volume, never the brand's.
    expect(byId.cold.outcomes.recipientsContacted).toBe(1);
    expect(byId.cold.outcomes.recipientsClicked).toBe(1);
    expect(byId.crm.outcomes.recipientsClicked).toBe(0);
  });

  it("0 is a MEASURED count and an unbought outcome has a NULL rate — never a $0 that reads as free", async () => {
    mockFetch({
      campaigns: [campaign("cold")],
      committedByCampaign: { cold: 4000 },
      actualByCampaign: { cold: 4000 },
      leads: [lead("cold", "l1", {}), lead("cold", "l2", {})],
    });

    const o = (await groups()).cold.outcomes;
    expect(o.recipientsContacted).toBe(2);
    // It reached people and bought neither a visit nor a reply. The counts say so; the rates refuse to.
    expect(o.recipientsClicked).toBe(0);
    expect(o.recipientsRepliesPositive).toBe(0);
    expect(o.cpcCents).toBeNull();
    expect(o.cpprCents).toBeNull();
    expect(o.committedSpentCents).toBe(4000);
  });

  it("a campaign that reached nobody says 0, and a spent-nothing one nulls its rates", async () => {
    mockFetch({
      campaigns: [campaign("cold"), campaign("crm", { acquisitionChannel: "crm_email" })],
      committedByCampaign: { cold: 4000, crm: 0 },
      actualByCampaign: { cold: 0, crm: 0 },
      leads: [lead("crm", "l1", { positive: true, clicked: true })],
    });

    const byId = await groups();
    // Spent and reached nobody — the row a customer is hunting. Every count is a real 0.
    expect(byId.cold.outcomes).toEqual({
      recipientsContacted: 0,
      recipientsClicked: 0,
      recipientsRepliesPositive: 0,
      committedSpentCents: 4000,
      actualSpentCents: 0,
      cpcCents: null,
      cpprCents: null,
    });
    // Reached someone on no attributed spend — the rates are unmeasurable, not $0 each.
    expect(byId.crm.outcomes.recipientsClicked).toBe(1);
    expect(byId.crm.outcomes.cpcCents).toBeNull();
  });

  it("a feature with no funnel wired answers NULL — 'we could not count this', not 'it reached nobody'", async () => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(feature(NO_FUNNEL) as never);
    mockFetch({
      campaigns: [campaign("cold", { featureSlug: NO_FUNNEL })],
      committedByCampaign: { cold: 4000 },
      actualByCampaign: { cold: 4000 },
      leads: [lead("cold", "l1")],
    });

    const byId = await groups(NO_FUNNEL);
    // The leads were never read on this path, so counting them would be a fabrication — and the
    // money half is honestly null right beside it.
    expect(byId.cold.outcomes).toBeNull();
    expect(byId.cold.headline.totalPipelineUsd).toBeNull();
    // The spend is still real and still reported by the money half.
    expect(byId.cold.costEconomics.committedCostUsd).toBeCloseTo(40, 6);
  });

  it("the lensed read carries no volume block — a lens is a lead SUBSET beside the brand's whole spend", async () => {
    mockFetch({
      campaigns: [campaign("cold")],
      committedByCampaign: { cold: 4000 },
      actualByCampaign: { cold: 4000 },
      leads: [lead("cold", "l1", { positive: true, clicked: true })],
    });

    const lensed = await request(app).get(`/features/${SALES}/revenue?brandId=b1&lens=signups`).set(AUTH);
    expect(lensed.status).toBe(200);
    // Same gate, same reason, as `spend` and `roiHistory` on this response.
    expect(lensed.body.outcomes).toBeNull();
    expect(lensed.body.spend).toBeNull();
  });
});
