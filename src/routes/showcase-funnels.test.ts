/**
 * THE SHOWCASE BRANDS' FUNNEL COUNTS — public, org-less, allowlisted.
 *
 * ONE downstream fixture drives every case, shaped like what the homepage actually states: three
 * named clients, two of them selling different funnels, one of them with a rung nobody has reached.
 * What the cases pin:
 *
 *   - the route NAMES NO BRAND: a `?brandId=` on the request changes nothing, and a brand that is not
 *     on the allowlist is absent from the body however it is asked for. That is the whole access
 *     control of an unauthenticated read of named clients' figures;
 *   - the chain is the funnel's OWN steps in the funnel's OWN order, the outreach base first, under
 *     the funnel's own names — and a rung nobody reached is SERVED at 0 rather than dropped, because
 *     the page draws the funnel in order and hides empty cells itself;
 *   - a rung whose only producer degraded reads NULL — "we have no figure" — never a 0;
 *   - each brand walks the funnel its OWN campaigns state they sell, not the other brand's;
 *   - every allowlisted brand is always in the body, in the allowlist's order, and a brand with
 *     nothing to walk carries `funnels: []` with a NAMED reason rather than an empty shrug;
 *   - one brand's failed read never blanks the others.
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
process.env.HUMAN_SERVICE_URL = "http://human:3000";
process.env.HUMAN_SERVICE_API_KEY = "human-key";
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.BILLING_SERVICE_URL = "http://billing:3000";
process.env.BILLING_SERVICE_API_KEY = "billing-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;
const { __resetShowcaseFunnelsCache } = await import("./public.js");
const { SHOWCASE_BRAND_IDS, brandSoldFunnels } = await import("../lib/showcase-funnels.js");

const [DOC, OPS, SHOCK] = SHOWCASE_BRAND_IDS;
/** A brand that is NOT on the allowlist — nothing a caller does may make it appear. */
const OUTSIDER = "11111111-2222-3333-4444-555555555555";

const PITCH = "sales-cold-email-outreach";
const CONVERSATION = "sales_meetings_from_conversation";
const FORM = "form_magnet";

const FEATURE_ROW = (slug: string) => ({
  id: `feat-${slug}`,
  slug,
  name: slug,
  description: "x",
  status: "active",
  outputs: [],
  charts: [],
  entities: [],
  createdAt: new Date(),
  updatedAt: new Date(),
});

const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 10,
  visitToMeetingPct: 10,
  meetingToClosePct: 10,
  visitToSignupPct: 10,
  signupToPaidClientPct: 10,
  visitToClosePct: 1,
  replyToPaidClientPct: 1,
  visitToPaidClientPct: 1,
  visitToFormSubmissionPct: 10,
  formSubmissionToPaidClientPct: 10,
};

const declaredFunnel = (funnelKey: string, steps: string[]) => ({
  funnelKey,
  name: funnelKey,
  steps,
  rates: { replyToMeetingPct: 40, visitToMeetingPct: 20, meetingBookedToAttendedPct: 50, meetingToClosePct: 60 },
  lifetimeRevenueUsd: 1000,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const ALL_DECLARED = [
  declaredFunnel(CONVERSATION, ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"]),
  declaredFunnel(FORM, ["Website visit", "Form filled", "Paid client"]),
];

const emailOf = (brandId: string, leadId: string) => `${brandId}-${leadId}@x.com`;

function lead(brandId: string, leadId: string, signal: "reply" | "click" | "none"): Record<string, unknown> {
  return {
    leadId: `${brandId}-${leadId}`,
    campaignId: `camp-${brandId}`,
    workflowSlug: "dawn-v1",
    email: emailOf(brandId, leadId),
    contacted: true,
    sent: true,
    delivered: true,
    clicked: signal === "click",
    bounced: false,
    unsubscribed: false,
    replied: signal === "reply",
    replyClassification: signal === "reply" ? "positive" : null,
    lead: {
      firstName: "A",
      lastName: "B",
      photoUrl: null,
      organization: { id: `${brandId}-${leadId}`, name: leadId, logoUrl: null },
    },
  };
}

interface BrandFixture {
  /** The funnel this brand's campaigns state they sell. `null` = it states none. */
  funnelKey: string | null;
  leads: Array<Record<string, unknown>>;
  /** lead ids a HUMAN stated reached each rung. */
  stated?: Partial<Record<"meeting_booked" | "meeting_attended" | "sale", string[]>>;
  /** campaign-service lists NO campaign for this brand. */
  noCampaigns?: boolean;
  /** the campaign read for this brand THROWS — one brand's failure. */
  campaignsFail?: boolean;
}

interface Fixture {
  brands: Record<string, BrandFixture>;
  /** brand ids lead-service holds a membership for (i.e. whose org we can resolve). */
  memberships?: string[];
  /** `false` = the human statements read fails, fail-soft. */
  statedReadable?: boolean;
}

function mockFetch(fixture: Fixture): void {
  const brandOf = (q: URLSearchParams, headers: Headers | undefined): string =>
    q.get("brandId") ?? headers?.get("x-brand-id") ?? "";

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const url = new URL(raw);
    const path = url.pathname;
    const q = url.searchParams;
    const headers = new Headers((init as RequestInit | undefined)?.headers as HeadersInit | undefined);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (path.includes("/internal/feature-memberships")) {
      const ids = fixture.memberships ?? Object.keys(fixture.brands);
      return json({
        memberships: ids.map((brandId) => ({ orgId: `org-${brandId}`, brandId, workflowSlug: "dawn-v1" })),
      });
    }

    // The BATCH read only — the per-brand `/internal/brands/:id/*` reads are matched further down.
    if (path.endsWith("/internal/brands")) {
      return json({
        brands: (q.get("ids") ?? "")
          .split(",")
          .filter(Boolean)
          .map((id) => ({ id, name: `name-${id}`, domain: `${id}.com` })),
      });
    }

    if (path.endsWith("/campaigns")) {
      const brandId = brandOf(q, headers);
      const row = fixture.brands[brandId];
      if (!row || row.noCampaigns) return json({ campaigns: [] });
      if (row.campaignsFail) return new Response("boom", { status: 502 });
      return json({
        campaigns: [
          {
            id: `camp-${brandId}`,
            orgId: `org-${brandId}`,
            brandId,
            featureSlug: PITCH,
            funnelKey: row.funnelKey,
            acquisitionChannel: PITCH,
            offerId: null,
            status: "ongoing",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    }

    if (path.includes("/sales-funnels")) return json({ funnels: ALL_DECLARED });
    if (path.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });

    if (path.includes("/costs/timeseries")) return json({ buckets: [] });
    if (path.includes("/public/workflows")) return json({ workflows: [] });
    if (path.includes("/public/costs")) return json({ groups: [] });
    if (path.includes("/public/stats")) return json({});
    if (path.includes("/stats/costs")) {
      return json({
        groups: [
          {
            dimensions: { campaignId: `camp-${brandOf(q, headers)}`, workflowSlug: "dawn-v1" },
            totalCostInUsdCents: "10000",
            actualCostInUsdCents: "10000",
            runCount: 1,
            minStartedAt: null,
            maxStartedAt: null,
          },
        ],
      });
    }

    if (path.endsWith("/orgs/leads")) {
      const brandId = brandOf(q, headers);
      return json({ leads: fixture.brands[brandId]?.leads ?? [] });
    }

    if (path.includes("/converted-lead-emails")) return json({ event: q.get("event"), emails: [] });
    if (path.includes("/converted-leads")) {
      if (fixture.statedReadable === false) return new Response("boom", { status: 502 });
      const brandId = path.split("/brands/")[1]?.split("/")[0] ?? "";
      const event = q.get("event") as "meeting_booked" | "meeting_attended" | "sale";
      return json({
        outcomes: (fixture.brands[brandId]?.stated?.[event] ?? []).map((leadId) => ({
          leadId: `${brandId}-${leadId}`,
          email: emailOf(brandId, leadId),
          campaignId: null,
          occurredAt: "2026-01-03T00:00:00.000Z",
          valueCents: null,
          source: "manual",
          causedByOutreach: null,
        })),
      });
    }
    if (path.includes("/manual-qualifications")) return json({ qualifications: [] });
    if (path.includes("/step-costs")) return json({ brandId: brandOf(q, headers), costs: [] });
    if (path.includes("/step-disqualifications")) return json({ byStep: {} });
    if (path.includes("/conversion-counts")) {
      return json({ counts: { signup: 0, meeting_booked: 0, form_submission: 0, sale: 0 } });
    }
    if (path.endsWith("/orgs/status")) return json({ results: [] });
    if (path.includes("/members")) return json({ members: [] });
    if (path.includes("/audiences")) return json({ audiences: [] });
    if (path.includes("/conversions")) return json({ conversions: [], counts: {} });
    if (path.includes("daily-budget")) return json({ dailyBudgetCents: 5000 });
    if (path.endsWith("/orgs/stats")) return json({ groups: [] });
    return json({});
  });
}

/**
 * THE FIXTURE, shaped like the page.
 *
 *   docdinners     — the conversation funnel: 4 contacted, 2 positive replies, 1 booked meeting,
 *                    1 attended, and NOBODY closed (the rung that must still be served, at 0).
 *   opsfolio       — a DIFFERENT funnel (form magnet), so a brand walking the other's chain fails.
 *   shockwave      — no lead membership at all: we cannot resolve whose org to read it under.
 */
const BASE: Fixture = {
  brands: {
    [DOC]: {
      funnelKey: CONVERSATION,
      leads: [lead(DOC, "l1", "reply"), lead(DOC, "l2", "reply"), lead(DOC, "l3", "none"), lead(DOC, "l4", "none")],
      stated: { meeting_booked: ["l1"], meeting_attended: ["l1"], sale: [] },
    },
    [OPS]: {
      funnelKey: FORM,
      leads: [lead(OPS, "l1", "click"), lead(OPS, "l2", "none")],
    },
    [SHOCK]: { funnelKey: CONVERSATION, leads: [] },
    [OUTSIDER]: { funnelKey: CONVERSATION, leads: [lead(OUTSIDER, "l1", "reply")] },
  },
  // shockwave is deliberately absent — its org cannot be resolved.
  memberships: [DOC, OPS, OUTSIDER],
};

const withFeatures = () => {
  vi.mocked(db.query.features.findFirst).mockImplementation((async () => FEATURE_ROW(PITCH)) as never);
  vi.mocked(db.query.features.findMany).mockImplementation((async () => [FEATURE_ROW(PITCH)]) as never);
};

type Body = {
  brands: Array<{
    brand: { id: string; name: string | null; domain: string | null };
    funnels: Array<{ funnelKey: string; funnelName: string; steps: Array<{ key: string; label: string; peopleReached: number | null }> }>;
    measured: boolean;
    unmeasuredReason: string | null;
  }>;
};

const get = async (query = ""): Promise<Body> => {
  const res = await request(app).get(`/public/stats/showcase-funnels${query}`);
  expect(res.status).toBe(200);
  return res.body as Body;
};

const brandOf = (body: Body, id: string) => body.brands.find((b) => b.brand.id === id)!;

describe("GET /public/stats/showcase-funnels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetShowcaseFunnelsCache();
    withFeatures();
  });
  afterEach(() => vi.restoreAllMocks());

  it("needs NO auth and NO brand parameter — and a caller-supplied brand cannot widen it", async () => {
    mockFetch(BASE);
    const plain = await get();
    __resetShowcaseFunnelsCache();
    mockFetch(BASE);
    const asked = await get(`?brandId=${OUTSIDER}`);

    // Byte-identical: the parameter is not read, so it cannot select anything.
    expect(asked).toEqual(plain);
    // And the brand that is not on the allowlist is nowhere in the body, however it was asked for.
    expect(plain.brands.map((b) => b.brand.id)).not.toContain(OUTSIDER);
  });

  it("answers EVERY allowlisted brand, in the allowlist's own order", async () => {
    mockFetch(BASE);
    const body = await get();
    expect(body.brands.map((b) => b.brand.id)).toEqual([...SHOWCASE_BRAND_IDS]);
    expect(brandOf(body, DOC).brand.domain).toBe(`${DOC}.com`);
  });

  it("walks the funnel's OWN steps in order, outreach first, and serves a rung nobody reached at 0", async () => {
    mockFetch(BASE);
    const doc = brandOf(await get(), DOC);

    expect(doc.measured).toBe(true);
    expect(doc.unmeasuredReason).toBeNull();
    expect(doc.funnels).toHaveLength(1);
    expect(doc.funnels[0].funnelKey).toBe(CONVERSATION);
    expect(doc.funnels[0].steps.map((s) => [s.label, s.peopleReached])).toEqual([
      ["Contacted", 4],
      ["Positive reply", 2],
      ["Meeting booked", 1],
      ["Meeting attended", 1],
      // MEASURED zero: nobody closed. The rung is still a rung — the page hides the cell, we do not.
      ["Paid client", 0],
    ]);
    // Machine keys, so a consumer never keys off buyer-facing wording.
    expect(doc.funnels[0].steps[0].key).toBe("contacted");
    expect(doc.funnels[0].steps[1].key).toBe("start_to_conversation");
  });

  it("walks each brand's OWN funnel — not the other brand's", async () => {
    mockFetch(BASE);
    const body = await get();
    const ops = brandOf(body, OPS);
    expect(ops.funnels[0].funnelKey).toBe(FORM);
    expect(ops.funnels[0].steps.map((s) => s.label)).toEqual([
      "Contacted",
      "Website visit",
      "Form filled",
      "Paid client",
    ]);
    expect(ops.funnels[0].steps[1].peopleReached).toBe(1);
    // The other brand's chain is a different shape entirely.
    expect(brandOf(body, DOC).funnels[0].steps).toHaveLength(5);
  });

  it("a rung whose ONLY producer degraded reads NULL — never a 0", async () => {
    mockFetch({ ...BASE, statedReadable: false });
    const doc = brandOf(await get(), DOC);
    const byLabel = Object.fromEntries(doc.funnels[0].steps.map((s) => [s.label, s.peopleReached]));

    // "Meeting attended" has no producer but the human statements, so it is unmeasurable here.
    expect(byLabel["Meeting attended"]).toBeNull();
    // The two rungs the core lead read alone evidences are still real, measured numbers.
    expect(byLabel["Contacted"]).toBe(4);
    expect(byLabel["Positive reply"]).toBe(2);
  });

  it("a brand with no lead membership says so, and never guesses an org", async () => {
    mockFetch(BASE);
    const shock = brandOf(await get(), SHOCK);
    expect(shock.funnels).toEqual([]);
    expect(shock.measured).toBe(false);
    expect(shock.unmeasuredReason).toBe("no_lead_membership");
  });

  it("a brand campaign-service lists no campaign for says so", async () => {
    mockFetch({
      ...BASE,
      memberships: [DOC, OPS, SHOCK],
      brands: { ...BASE.brands, [SHOCK]: { funnelKey: CONVERSATION, leads: [], noCampaigns: true } },
    });
    const shock = brandOf(await get(), SHOCK);
    expect(shock.unmeasuredReason).toBe("brand_has_no_channels");
  });

  it("a brand whose campaigns state no funnel says so", async () => {
    mockFetch({
      ...BASE,
      memberships: [DOC, OPS, SHOCK],
      brands: { ...BASE.brands, [SHOCK]: { funnelKey: null, leads: [] } },
    });
    const shock = brandOf(await get(), SHOCK);
    expect(shock.unmeasuredReason).toBe("no_funnel_sold");
  });

  it("ONE brand's failed read never blanks the others", async () => {
    mockFetch({
      ...BASE,
      memberships: [DOC, OPS, SHOCK],
      brands: { ...BASE.brands, [SHOCK]: { funnelKey: CONVERSATION, leads: [], campaignsFail: true } },
    });
    const body = await get();
    expect(brandOf(body, SHOCK).unmeasuredReason).toBe("read_failed");
    expect(brandOf(body, SHOCK).funnels).toEqual([]);
    expect(brandOf(body, DOC).measured).toBe(true);
    expect(brandOf(body, OPS).measured).toBe(true);
  });
});

describe("brandSoldFunnels", () => {
  it("takes the funnels the campaigns THEMSELVES state, deduped, in catalogue order", () => {
    expect(
      brandSoldFunnels([
        { id: "a", funnelKey: FORM },
        { id: "b", funnelKey: CONVERSATION },
        { id: "c", funnelKey: CONVERSATION },
      ]),
    ).toEqual([CONVERSATION, FORM]);
  });

  it("parks nothing on a default — a campaign stating no funnel, or an unknown word, contributes nothing", () => {
    expect(brandSoldFunnels([{ id: "a", funnelKey: null }, { id: "b" }, { id: "c", funnelKey: "not_a_funnel" }])).toEqual(
      [],
    );
  });

  it("accepts a pre-retirement spelling, because the catalogue does", () => {
    expect(brandSoldFunnels([{ id: "a", funnelKey: "reply_meeting" }])).toEqual([CONVERSATION]);
  });
});
