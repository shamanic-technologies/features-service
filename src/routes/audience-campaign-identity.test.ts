/**
 * A CAMPAIGN-SCOPED PER-AUDIENCE READ ANSWERS FOR THE CAMPAIGN'S IDENTITY, not for one stored row.
 *
 * A campaign as a customer knows it is (org, brand, sales funnel, acquisition channel) —
 * campaign-service's own key. It mints a NEW row every time the campaign's workflow switches and
 * keeps the ancestors, so one campaign arrives here as many ids. `/revenue?campaignId=` has totalled
 * the whole family since features-service#749; this read had not, so on one screen the stat card said
 * 20 positive replies for the campaign while the Audiences table under it said 0 — the table was
 * answering about the newest slice of a campaign that had been running for weeks.
 *
 * Every case here asserts the DIVERGENCE between the identity's answer and the single row's on ONE
 * fixture: a suite that only checked "a number came back" would pass on an implementation that never
 * resolved the family at all. The fixture is shaped like the campaign that reported it — a live row
 * that has reached one audience and produced NO reply, and stopped ancestors carrying the replies.
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
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";
process.env.RUNS_SERVICE_URL = "http://runs:3000";
process.env.RUNS_SERVICE_API_KEY = "runs-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.HUMAN_SERVICE_URL = "http://human:3000";
process.env.HUMAN_SERVICE_API_KEY = "human-key";
process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const FEATURE = {
  id: "feat-1", slug: "sales-cold-email-outreach", name: "Sales", description: "x",
  status: "active", createdAt: new Date(), updatedAt: new Date(),
};

const ECONOMICS = {
  lifetimeRevenueUsd: 1000, replyToMeetingPct: 30, visitToMeetingPct: 20, meetingToClosePct: 50,
  visitToClosePct: 10, visitToSignupPct: 20, signupToPaidClientPct: 40, visitToPaidClientPct: 20,
  replyToPaidClientPct: 50, visitToFormSubmissionPct: 25, formSubmissionToPaidClientPct: 20,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function urlOf(input: unknown): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
}
function workflow(slug: string): Record<string, unknown> {
  return {
    id: `id-${slug}`, workflowSlug: slug, workflowName: slug, workflowDynastySlug: slug, workflowDynastyName: slug,
    version: 1, status: "active", featureSlug: FEATURE.slug, createdForBrandId: null, upgradedTo: null,
  };
}
function costGroup(dimensions: Record<string, string>, cents: number, runCount = 1): Record<string, unknown> {
  return { dimensions, totalCostInUsdCents: String(cents), netTotalCostInUsdCents: String(cents), runCount, minStartedAt: null, maxStartedAt: null };
}
function emailGroup(key: string, contacted: number, clicked: number, repliesPositive: number): Record<string, unknown> {
  return { key, broadcast: { recipientStats: { contacted, sent: contacted, delivered: contacted, opened: contacted, clicked, bounced: 0, repliesPositive } } };
}

// ── THE FIXTURE ───────────────────────────────────────────────────────────────
//
// ONE campaign the customer sees, stored as THREE rows on one identity: the live one plus two
// stopped ancestors from earlier workflow switches. Its whole run reached two audiences and produced
// four positive replies — but the LIVE row alone reached one audience and produced NONE, which is
// exactly the shape that printed 0 under a campaign the card above said had replies.
//
// A SECOND campaign sits on a different funnel, so it is a different identity with ONE member — the
// case that must read byte-identically to the pre-identity behaviour.
const LIVE = "camp-live";
const OLD_1 = "camp-old-1";
const OLD_2 = "camp-old-2";
const SOLO = "camp-solo";

interface Leg { campaignId: string; audienceId: string; cents: number; contacted: number; clicks: number; replies: number }
const LEGS: Leg[] = [
  // The live row: one audience, real spend, real clicks, and NOT ONE reply.
  { campaignId: LIVE, audienceId: "audience-a", cents: 4000, contacted: 100, clicks: 6, replies: 0 },
  // The ancestors carry the weeks of history the live row cannot see.
  { campaignId: OLD_1, audienceId: "audience-a", cents: 6000, contacted: 500, clicks: 20, replies: 3 },
  { campaignId: OLD_2, audienceId: "audience-b", cents: 5000, contacted: 400, clicks: 15, replies: 1 },
  // A different identity entirely — never folded in.
  { campaignId: SOLO, audienceId: "audience-b", cents: 9000, contacted: 700, clicks: 40, replies: 9 },
];

const CAMPAIGN_ROWS = [
  { id: LIVE, orgId: "org-1", brandId: "brand-1", featureSlug: FEATURE.slug, funnelKey: "sales_meetings_from_conversation", acquisitionChannel: "cold_email", offerId: "offer-1", status: "ongoing", createdAt: "2026-09-01T00:00:00.000Z" },
  { id: OLD_1, orgId: "org-1", brandId: "brand-1", featureSlug: FEATURE.slug, funnelKey: "sales_meetings_from_conversation", acquisitionChannel: "cold_email", offerId: "offer-1", status: "stopped", createdAt: "2026-08-01T00:00:00.000Z" },
  { id: OLD_2, orgId: "org-1", brandId: "brand-1", featureSlug: FEATURE.slug, funnelKey: "sales_meetings_from_conversation", acquisitionChannel: "cold_email", offerId: "offer-1", status: "stopped", createdAt: "2026-07-01T00:00:00.000Z" },
  { id: SOLO, orgId: "org-1", brandId: "brand-1", featureSlug: FEATURE.slug, funnelKey: "website_purchases", acquisitionChannel: "cold_email", offerId: "offer-1", status: "ongoing", createdAt: "2026-08-15T00:00:00.000Z" },
];

const IDENTITY_MEMBERS = [LIVE, OLD_1, OLD_2].sort();

const AUDIENCES = [
  { id: "audience-a", name: "CFOs" },
  { id: "audience-b", name: "CTOs" },
];

/** What the identity, the single row, or the whole brand should add up to for one audience. */
function expected(scope: string[] | null, audienceId: string): { contacted: number; clicks: number; replies: number; cents: number } {
  const legs = LEGS.filter((l) => l.audienceId === audienceId && (scope === null || scope.includes(l.campaignId)));
  return {
    contacted: legs.reduce((t, l) => t + l.contacted, 0),
    clicks: legs.reduce((t, l) => t + l.clicks, 0),
    replies: legs.reduce((t, l) => t + l.replies, 0),
    cents: legs.reduce((t, l) => t + l.cents, 0),
  };
}

/** campaign-service refuses the identity read — the fail-soft path. */
let campaignServiceDown = false;
/** Every downstream URL the request touched, so the request SHAPE can be asserted. */
let calls: string[] = [];

function mockFetch(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = urlOf(input);
    calls.push(url);
    const params = new URL(url, "http://x").searchParams;

    if (url.includes("campaign:3000/campaigns")) {
      if (campaignServiceDown) return json({ error: "boom" }, 503);
      return json({ campaigns: CAMPAIGN_ROWS });
    }

    if (url.includes("workflow:3000/public/workflows")) return json({ workflows: [workflow("wf-a")] });
    if (url.includes("runs:3000/v1/stats/public/costs")) return json({ groups: [costGroup({ workflowSlug: "wf-a" }, 20000, 10)] });
    if (url.includes("email:3000/public/stats")) return json({ groups: [emailGroup("wf-a", 1000, 100, 200)] });
    if (url.includes("brand:3000/orgs/brands/brand-1/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("brand:3000/internal/brands/brand-1/sales-funnels")) {
      return json({
        funnels: ["sales_meetings_from_conversation", "website_purchases"].map((funnelKey) => ({
          funnelKey, active: true, name: funnelKey, steps: [], rates: {},
          lifetimeRevenueUsd: null, destinationUrl: null, bookingUrl: null, updatedAt: "2026-09-01T00:00:00.000Z",
        })),
      });
    }
    if (url.includes("lead:3000/internal/brands/brand-1/converted-lead-emails")) return json({ emails: [] });

    if (url.includes("runs:3000/v1/stats/costs")) {
      const groupBy = params.get("groupBy") ?? "";
      const filtered = params.get("campaignId");
      if (groupBy === "audienceId,campaignId") {
        // A multi-member scope co-groups the campaign and keeps the members locally.
        return json({ groups: LEGS.map((l) => costGroup({ audienceId: l.audienceId, campaignId: l.campaignId }, l.cents)) });
      }
      if (groupBy === "audienceId") {
        const legs = filtered ? LEGS.filter((l) => l.campaignId === filtered) : LEGS;
        const byAudience = new Map<string, number>();
        for (const l of legs) byAudience.set(l.audienceId, (byAudience.get(l.audienceId) ?? 0) + l.cents);
        return json({ groups: [...byAudience].map(([audienceId, cents]) => costGroup({ audienceId }, cents)) });
      }
      if (groupBy === "audienceId,workflowSlug") {
        return json({ groups: LEGS.map((l) => costGroup({ audienceId: l.audienceId, workflowSlug: "wf-a" }, l.cents)) });
      }
      return json({ groups: [] });
    }

    if (url.includes("email:3000/orgs/stats")) {
      const audienceId = params.get("audienceId");
      if (audienceId) {
        const legs = LEGS.filter((l) => l.audienceId === audienceId);
        return json({ groups: legs.map((l) => emailGroup("wf-a", l.contacted, l.clicks, l.replies)) });
      }
      const campaignId = params.get("campaignId");
      const legs = campaignId ? LEGS.filter((l) => l.campaignId === campaignId) : LEGS;
      const byAudience = new Map<string, Leg[]>();
      for (const l of legs) byAudience.set(l.audienceId, [...(byAudience.get(l.audienceId) ?? []), l]);
      return json({
        groups: [...byAudience].map(([id, ls]) =>
          emailGroup(
            id,
            ls.reduce((t, l) => t + l.contacted, 0),
            ls.reduce((t, l) => t + l.clicks, 0),
            ls.reduce((t, l) => t + l.replies, 0),
          ),
        ),
      });
    }

    const members = url.match(/human:3000\/orgs\/audiences\/([^/]+)\/members/);
    if (members) return json({ members: [{ emailNorm: `${members[1]}-1` }], total: 1, limit: 500, offset: 0 });
    if (url.includes("human:3000/orgs/audiences")) {
      return json({
        audiences: AUDIENCES.map((a) => ({ id: a.id, brandId: "brand-1", name: a.name, status: "active", filters: null })),
        total: AUDIENCES.length, limit: 200, offset: 0,
      });
    }
    if (url.includes("email:3000/orgs/status")) return json({ results: [] });
    return json({});
  });
}

const statsUrl = (query = ""): string =>
  `/features/${FEATURE.slug}/audience-stats?brandId=brand-1&goal=positiveReply${query}`;

async function read(query = ""): Promise<Record<string, any>> {
  calls = [];
  const res = await request(app).get(statsUrl(query)).set(AUTH);
  expect(res.status).toBe(200);
  return res.body;
}
const rowFor = (body: any, audienceId: string): any => body.audiences.find((r: any) => r.audienceId === audienceId);
const totalReplies = (body: any): number =>
  body.audiences.reduce((t: number, r: any) => t + (r.evidence?.positiveReplies ?? 0), 0);
const totalContacted = (body: any): number =>
  body.audiences.reduce((t: number, r: any) => t + (r.evidence?.contacted ?? 0), 0);

describe("a campaign-scoped /audience-stats read answers for the campaign IDENTITY", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(FEATURE as any);
    campaignServiceDown = false;
    fetchSpy = mockFetch();
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("totals every member of the identity — and DIVERGES from the live row it was asked about", async () => {
    const identity = await read(`&campaignId=${LIVE}`);

    // The whole campaign: 4 positive replies across two audiences, 1000 people reached.
    expect(totalReplies(identity)).toBe(4);
    expect(totalContacted(identity)).toBe(1000);
    expect(rowFor(identity, "audience-a").evidence.positiveReplies).toBe(3);
    expect(rowFor(identity, "audience-b").evidence.positiveReplies).toBe(1);

    // The live row ALONE — the answer this read used to give — has none of that. If the identity were
    // never resolved, the assertion above would read these numbers instead.
    const alone = expected([LIVE], "audience-a");
    expect(alone.replies).toBe(0);
    expect(alone.contacted).toBe(100);
    expect(totalReplies(identity)).not.toBe(0);
  });

  it("reconciles per audience with the members' own legs, to the cent", async () => {
    const body = await read(`&campaignId=${LIVE}`);
    for (const audience of AUDIENCES) {
      const want = expected(IDENTITY_MEMBERS, audience.id);
      const row = rowFor(body, audience.id);
      expect(row.evidence.contacted).toBe(want.contacted);
      expect(row.evidence.websiteClicks).toBe(want.clicks);
      expect(row.evidence.positiveReplies).toBe(want.replies);
      expect(row.evidence.totalCostInUsdCents).toBe(want.cents);
    }
  });

  it("answers identically for a STOPPED ancestor — any member names the same campaign", async () => {
    const fromLive = await read(`&campaignId=${LIVE}`);
    const fromAncestor = await read(`&campaignId=${OLD_2}`);
    expect(fromAncestor).toEqual(fromLive);
  });

  it("names the identity on the wire, so a consumer can SEE which subject it read", async () => {
    const body = await read(`&campaignId=${OLD_1}`);
    expect(body.campaignIdentity.campaignIds).toEqual(IDENTITY_MEMBERS);
    expect(body.campaignIdentity.liveCampaignIds).toEqual([LIVE]);
    expect(body.campaignIdentity.representativeId).toBe(LIVE);
    expect(body.campaignIdentity.funnelKey).toBe("sales_meetings_from_conversation");
    expect(body.campaignIdentity.acquisitionChannel).toBe("cold_email");
  });

  it("never folds in a campaign on another identity", async () => {
    const body = await read(`&campaignId=${LIVE}`);
    // camp-solo sells a different funnel, so its 9 replies belong to a different campaign entirely.
    expect(totalReplies(body)).toBe(4);
    expect(body.campaignIdentity.campaignIds).not.toContain(SOLO);
  });

  it("a campaign whose identity is a SINGLE stored row is unchanged — same body, same request shape", async () => {
    const body = await read(`&campaignId=${SOLO}`);
    expect(body.campaignIdentity.campaignIds).toEqual([SOLO]);
    expect(rowFor(body, "audience-b").evidence.positiveReplies).toBe(9);
    expect(rowFor(body, "audience-a").evidence.positiveReplies).toBe(0);

    // The one-member path takes the ORIGINAL downstream shape byte for byte: runs filtered on the
    // single campaign with no co-grouping, and exactly one email-gateway read.
    const runsCall = calls.find((u) => u.includes("runs:3000/v1/stats/costs") && u.includes("groupBy=audienceId&"));
    expect(runsCall).toContain(`campaignId=${SOLO}`);
    expect(calls.some((u) => u.includes("groupBy=audienceId%2CcampaignId"))).toBe(false);
    const emailScoped = calls.filter((u) => u.includes("email:3000/orgs/stats") && u.includes("campaignId="));
    expect(emailScoped).toHaveLength(1);
  });

  it("reads a MULTI-member identity with one co-grouped cost read and one engagement read per member", async () => {
    await read(`&campaignId=${LIVE}`);
    const coGrouped = calls.filter((u) => u.includes("runs:3000/v1/stats/costs") && u.includes("groupBy=audienceId%2CcampaignId"));
    expect(coGrouped).toHaveLength(1);
    // No `campaignId` filter on a co-grouped read — runs-service takes no campaign LIST, so the
    // members are kept locally instead.
    expect(coGrouped[0]).not.toContain("campaignId=");
    const emailScoped = calls.filter((u) => u.includes("email:3000/orgs/stats") && u.includes("campaignId="));
    expect(emailScoped).toHaveLength(IDENTITY_MEMBERS.length);
    for (const member of IDENTITY_MEMBERS) {
      expect(emailScoped.some((u) => u.includes(`campaignId=${member}`))).toBe(true);
    }
  });

  it("leaves the BRAND-WIDE read byte-identical, and asks campaign-service nothing for it", async () => {
    const body = await read();
    expect(body.campaignIdentity).toBeUndefined();
    expect(totalReplies(body)).toBe(13); // every campaign of the brand, this identity and the other
    expect(calls.some((u) => u.includes("campaign:3000/campaigns"))).toBe(false);
  });

  it("leaves an OFFER-scoped read on the offer's OWN campaign set — never widened by the identity", async () => {
    const body = await read("&offerId=offer-1");
    expect(body.campaignIdentity).toBeUndefined();
    // Every campaign of the brand sells offer-1, so the offer's answer is the brand's.
    expect(totalReplies(body)).toBe(13);
  });

  it("with campaign-service unreachable, degrades to the SINGLE row — never to the brand's numbers", async () => {
    campaignServiceDown = true;
    const body = await read(`&campaignId=${LIVE}`);

    // Today's (narrower) answer, which is a real answer about a real subset of the campaign.
    expect(totalReplies(body)).toBe(0);
    expect(rowFor(body, "audience-a").evidence.contacted).toBe(100);
    // And emphatically NOT the brand-wide one under this campaign's name.
    expect(totalContacted(body)).not.toBe(1700);
    expect(body.campaignIdentity.campaignIds).toEqual([LIVE]);
  });
});
