/**
 * THE CLIENTS OUR HOMEPAGE NAMES — picked here, ordered here, public and org-less.
 *
 * ONE downstream fixture drives every case, shaped like what the homepage actually states: clients
 * selling different funnels, one with a rung nobody has reached. What the cases pin:
 *
 *   - the PICK is the service's, ALREADY ORDERED: most meetings booked first, then most positive
 *     replies, whenever the client began (SHOWCASE-MAX-1107), never one qualified by website visits
 *     alone; the best-return group is deleted (ROI-CONSISTENCY-1103) and no field states a return;
 *   - a group with nobody SAYS WHICH SILENCE it is, and a SHORT group is a stated fact;
 *   - the route NAMES NO BRAND: a `?brandId=` on the request changes nothing;
 *   - the chain is the funnel's OWN steps in the funnel's OWN order, the outreach base first, and a
 *     rung nobody reached is SERVED at 0 rather than dropped;
 *   - a rung whose only producer degraded reads NULL — "we have no figure" — never a 0;
 *   - each brand walks the funnel its OWN campaigns state they sell, not the other brand's;
 *   - every rung states what reaching it cost at real vendor cost (the base priced on the identical
 *     formula), and no client's total spend is ever published.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

vi.mock("../db/index.js", () => ({
  db: {
    query: {
      features: { findFirst: vi.fn(), findMany: vi.fn() },
      // The picks are ranked off the PERSISTED fleet snapshot — the rows a background warm writes —
      // which is the whole reason this read answers in milliseconds instead of minutes.
      fleetReturnSnapshots: { findFirst: vi.fn() },
    },
  },
  sql: {},
}));
// The stored showcase (MON-PAGE-SPEED-2-1112), in memory; emptied before every test.
const cells = vi.hoisted(() => new Map<string, { text: string; computedAt: number }>());
vi.mock("../lib/fleet-cell-store.js", () => ({
  loadFleetCell: async (key: string) => cells.get(key) ?? null,
  claimFleetCellBuild: async () => true,
  storeFleetCell: async (key: string, text: string, computedAt: number) => void cells.set(key, { text, computedAt }),
}));
beforeEach(() => cells.clear());
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
process.env.CLIENT_SERVICE_URL = "http://client:3000";
process.env.CLIENT_SERVICE_API_KEY = "client-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;
const { __resetShowcaseFunnelsCache, foldFleetSnapshotRows, warmShowcaseFunnelsOnBoot } = await import("./public.js");
const { brandReadingFunnels } = await import("../lib/showcase-funnels.js");
const { offerEconomicsFromDeclared } = await import("../lib/leg-economics-fixture.js");
const { funnelLeg } = await import("../lib/funnel-legs.js");

const DOC = "75d7e3e8-6926-4f85-a557-976895400666";
const OPS = "6e21bb6c-67bc-45f3-8a6d-52230338d7e4";
const SHOCK = "a179bbd9-8eed-4dba-9338-78125922b0c6";
const VITAL = "f2408cfb-4f02-4910-acec-e61fc8edb9cf";
/**
 * THE SUB-FLOOR CLIENT — a 22x return sitting on $4 of spend and nothing produced. It is the shape
 * production's unfiltered ranking leads with (21.5x on $4.12, measured 2026-09-22), so it is what
 * both gates have to keep out: the spend floor from the return ranking, the outcome gate from the
 * recency one. It is also the brand a caller tries to name.
 */
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
  {
    ...declaredFunnel(FORM, ["Website visit", "Form submitted", "Paid client"]),
    rates: { visitToFormSubmissionPct: 25, formSubmissionToPaidClientPct: 20 },
  },
];

/** The entry leg a campaign selling each fixture path performs. */
const ENTRY_LEG: Record<string, string> = { [CONVERSATION]: "start_to_conversation", [FORM]: "start_to_website_visit" };

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
  /**
   * The path this brand sells through — its campaign performs that path's ENTRY leg and the brand
   * states the path's onward rates. `null` = its campaign performs no leg.
   */
  funnelKey: string | null;
  leads: Array<Record<string, unknown>>;
  /** lead ids a HUMAN stated reached each rung. */
  stated?: Partial<Record<"meeting_booked" | "meeting_attended" | "sale", string[]>>;
  /**
   * lead-service's stored "did our outreach cause it?" verdict per stated lead id. Absent = `true`
   * (our win), so a stated rung counts on the public card unless a case says otherwise.
   */
  causes?: Record<string, boolean | null>;
  /** lead ids the conversion tracker attributes a form submission to. */
  formSubmissions?: string[];
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
  /** COMMITTED cents runs-service reports for every brand. `0` = nothing was ever spent. */
  spendCents?: number;
  /**
   * The FROZEN NET committed cents runs-service reports beside the gross — what the brand actually
   * paid after its per-org usage discount. Defaults to the gross, which is what a brand carrying NO
   * discount genuinely reports. Set it lower to drive a DISCOUNTED brand: the showcase read is on the
   * NET basis, so the money half must move with THIS number and not with `spendCents`.
   */
  netSpendCents?: number;
  /**
   * The VENDOR cost of the same rows (what the vendors charged us, before our markup; PUBLIC-VENDOR-COST-1031): the
   * showcase money half moves with THIS number. Defaults to the gross so the other cases read unchanged.
   */
  vendorSpendCents?: number;
  /** Billed cents on rows with no known vendor cost. Default 0. */
  unpricedSpendCents?: number;
  /**
   * The stored fleet-snapshot rows the PICKS are ranked over. `null` = no snapshot exists at all,
   * which is a different silence from "a snapshot exists and nobody qualifies".
   */
  snapshot?: SnapshotRow[] | null;
  /** brand ids whose org has ONLY staff members (a staff test org). Every other org has a client. */
  staffOrgBrands?: string[];
}

/** One stored row of the persisted fleet snapshot — what the pick has to work with. */
interface SnapshotRow {
  brandId: string;
  outcomeCount?: number | null;
  meetingsBooked?: number | null;
  positiveReplies?: number | null;
}

function mockFetch(fixture: Fixture): void {
  const rows = fixture.snapshot === undefined ? SNAPSHOT : fixture.snapshot;
  vi.mocked(db.query.fleetReturnSnapshots.findFirst).mockImplementation((async () =>
    rows === null ? undefined : { featureSlug: PITCH, brands: rows, computedAt: new Date() }) as never);

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

    if (path.endsWith("/internal/users")) {
      const orgId = q.get("orgId") ?? "";
      const staff = (fixture.staffOrgBrands ?? []).some((b) => orgId === `org-${b}`);
      return json({
        users: staff
          ? [{ email: "kevin@distribute.you" }, { email: "kevin.lourd+e2e@gmail.com" }]
          : [{ email: "kevin@distribute.you" }, { email: "founder@client.com" }],
      });
    }
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
            legKey: row.funnelKey ? ENTRY_LEG[row.funnelKey] : null,
            acquisitionChannel: PITCH,
            offerId: null,
            status: "ongoing",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    }

    if (path.includes("/offer-economics")) {
      const brandId = path.split("/brands/")[1]?.split("/")[0] ?? "";
      const key = fixture.brands[brandId]?.funnelKey;
      return json(offerEconomicsFromDeclared(ALL_DECLARED.filter((f) => f.funnelKey === key)));
    }
    if (path.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });

    if (path.includes("/costs/timeseries")) return json({ buckets: [] });
    if (path.includes("/public/workflows")) return json({ workflows: [] });
    if (path.includes("/public/costs")) return json({ groups: [] });
    if (path.includes("/public/stats")) return json({});
    if (path.includes("/stats/costs")) {
      const cents = String(fixture.spendCents ?? 10000);
      const netCents = String(fixture.netSpendCents ?? fixture.spendCents ?? 10000);
      const vendorCents = String(fixture.vendorSpendCents ?? fixture.spendCents ?? 10000);
      const unpricedCents = String(fixture.unpricedSpendCents ?? 0);
      return json({
        groups: [
          {
            dimensions: { campaignId: `camp-${brandOf(q, headers)}`, workflowSlug: "dawn-v1" },
            totalCostInUsdCents: cents,
            actualCostInUsdCents: cents,
            netTotalCostInUsdCents: netCents,
            netActualCostInUsdCents: netCents,
            vendorTotalCostInUsdCents: vendorCents,
            vendorActualCostInUsdCents: vendorCents,
            vendorProvisionedCostInUsdCents: "0",
            vendorRefundedCostInUsdCents: "0",
            unpricedTotalCostInUsdCents: unpricedCents,
            unpricedActualCostInUsdCents: unpricedCents,
            unpricedProvisionedCostInUsdCents: "0",
            unpricedRefundedCostInUsdCents: "0",
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

    if (path.includes("/converted-lead-emails")) {
      const brandId = path.split("/brands/")[1]?.split("/")[0] ?? "";
      const ids = q.get("event") === "form_submission" ? (fixture.brands[brandId]?.formSubmissions ?? []) : [];
      return json({ event: q.get("event"), emails: ids.map((leadId) => emailOf(brandId, leadId)) });
    }
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
          causedByOutreach: (() => {
            const causes = fixture.brands[brandId]?.causes ?? {};
            return leadId in causes ? causes[leadId] : true;
          })(),
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
/**
 * THE SNAPSHOT THE PICK RANKS OVER: each client's meetings booked and positive replies. Docdinners leads
 * (1 meeting); opsfolio and shockwave tie on 1 positive reply; the outsider has produced nothing and is
 * never walked.
 */
const SNAPSHOT: SnapshotRow[] = [
  { brandId: DOC, outcomeCount: 2, meetingsBooked: 1, positiveReplies: 2 },
  { brandId: OPS, outcomeCount: 1, meetingsBooked: 0, positiveReplies: 1 },
  { brandId: SHOCK, outcomeCount: 1, meetingsBooked: 0, positiveReplies: 1 },
  { brandId: OUTSIDER, outcomeCount: 0, meetingsBooked: 0, positiveReplies: 0 },
];

const BASE: Fixture = {
  brands: {
    [DOC]: {
      funnelKey: CONVERSATION,
      leads: [lead(DOC, "l1", "reply"), lead(DOC, "l2", "reply"), lead(DOC, "l3", "none"), lead(DOC, "l4", "none")],
      stated: { meeting_booked: ["l1"], meeting_attended: ["l1"], sale: [] },
    },
    [OPS]: {
      funnelKey: FORM,
      // The visit alone never qualifies the hero row (SHOWCASE-NO-VISITS-1019): its positive reply does.
      leads: [lead(OPS, "l1", "click"), lead(OPS, "l2", "reply")],
      formSubmissions: ["l1"],
    },
    [SHOCK]: { funnelKey: CONVERSATION, leads: [] },
    [OUTSIDER]: { funnelKey: CONVERSATION, leads: [lead(OUTSIDER, "l1", "reply")] },
  },
  // shockwave is deliberately absent — its org cannot be resolved.
  memberships: [DOC, OPS, OUTSIDER],
};

/** The base fixture with Shockwave's chain readable: its org resolves and it has a positive reply. */
const READABLE_SHOCK: Fixture = {
  ...BASE,
  brands: { ...BASE.brands, [SHOCK]: { funnelKey: CONVERSATION, leads: [lead(SHOCK, "l1", "reply"), lead(SHOCK, "l2", "none")] } },
  memberships: [DOC, OPS, SHOCK, OUTSIDER],
};

/**
 * Living Vital's production shape: sells the REPLY funnel, clicked twice and replied never, so its own
 * chain shows nothing past `contacted`. Its snapshot row carries a STALE claim (5 positive replies),
 * which is exactly the state the route has to be robust to until the next warm rewrites it.
 */
const WITH_VITAL: Fixture = {
  ...READABLE_SHOCK,
  brands: {
    ...READABLE_SHOCK.brands,
    [VITAL]: {
      funnelKey: CONVERSATION,
      leads: [lead(VITAL, "l1", "click"), lead(VITAL, "l2", "click"), lead(VITAL, "l3", "none")],
    },
  },
  memberships: [...(READABLE_SHOCK.memberships ?? []), VITAL],
  snapshot: [
    ...SNAPSHOT,
    { brandId: VITAL, outcomeCount: 2, meetingsBooked: 0, positiveReplies: 5 },
  ],
};

const withFeatures = () => {
  vi.mocked(db.query.features.findFirst).mockImplementation((async () => FEATURE_ROW(PITCH)) as never);
  vi.mocked(db.query.features.findMany).mockImplementation((async () => [FEATURE_ROW(PITCH)]) as never);
};

type Group = {
  brands: Body["brands"];
  measured: boolean;
  unmeasuredReason: string | null;
  requestedCount: number;
  qualifyingCount: number;
};

type Body = {
  costBasis: "vendor";
  groups: { recentlyStarted: Group };
  brands: Array<{
    brand: { id: string; name: string | null; domain: string | null };
    funnels: Array<{
      funnelKey: string;
      funnelName: string;
      steps: Array<{ key: string; label: string; peopleReached: number | null; costPerReachUsd: number | null }>;
    }>;
    measured: boolean;
    unmeasuredReason: string | null;
    vendorCost?: { unpricedSharePct: number; moneyUnavailableReason: "vendor_cost_unknown" | null };
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
    cells.clear(); // recompute on the new fixture, never the stored build
    mockFetch(BASE);
    const asked = await get(`?brandId=${OUTSIDER}`);

    // Byte-identical: the parameter is not read, so it cannot select anything. WHICH clients are named
    // is a ranking this service computes; a caller cannot put a brand into it, or take one out.
    expect(asked).toEqual(plain);
    expect(plain.brands.map((b) => b.brand.id)).not.toContain(OUTSIDER);
  });

  it("serves ONE group, already ordered: most meetings booked first, then most positive replies, and no return", async () => {
    mockFetch(READABLE_SHOCK);
    const body = await get();

    // The hero row shows the BIGGEST figures (owner 2026-11-07, SHOWCASE-MAX-1107): docdinners booked one
    // meeting, so it leads; opsfolio and shockwave fill with 1 positive reply each (tie: brand id).
    expect(body.groups.recentlyStarted.brands.map((b) => b.brand.id)).toEqual([DOC, OPS, SHOCK]);
    expect(body.groups.recentlyStarted.measured).toBe(true);
    expect(body.groups.recentlyStarted.unmeasuredReason).toBeNull();
    // The best-return group and its floor are deleted (ROI-CONSISTENCY-1103).
    expect(Object.keys(body.groups)).toEqual(["recentlyStarted"]);
    expect(body).not.toHaveProperty("minSpendUsd");
    expect(JSON.stringify(body)).not.toMatch(/returnPerDollar|highestReturn/);
    // `brands` is the group's clients, in its order.
    expect(body.brands.map((b) => b.brand.id)).toEqual([DOC, OPS, SHOCK]);
    expect(brandOf(body, DOC).brand.domain).toBe(`${DOC}.com`);
    expect(body.groups.recentlyStarted.brands.find((b) => b.brand.id === DOC)).toEqual(brandOf(body, DOC));
  });

  it("never names a STAFF TEST client, even one that booked a meeting", async () => {
    mockFetch({ ...READABLE_SHOCK, staffOrgBrands: [DOC] });
    const body = await get();
    expect(body.groups.recentlyStarted.brands.map((b) => b.brand.id)).toEqual([OPS, SHOCK]);
    expect(body.brands.map((b) => b.brand.id)).not.toContain(DOC);
  });

  it("the OUTCOME gate keeps out the client that produced nothing", async () => {
    mockFetch(READABLE_SHOCK);
    const body = await get();

    // The outsider's snapshot counts 0 meetings and 0 positive replies: never walked, never named.
    expect(body.groups.recentlyStarted.brands.map((b) => b.brand.id)).not.toContain(OUTSIDER);
    expect(body.groups.recentlyStarted.brands[0].brand.id).toBe(DOC);
  });

  // ── AN OUTCOME IS A RUNG PAST THE BASE, READ ON THE CLIENT'S OWN CHAIN ─────────────────────────
  //
  // The production shape that shipped wrong (Living Vital, 2026-09-24): a client selling the REPLY
  // funnel, begun most recently of all, whose snapshot said it had produced something because the
  // warm counted clicks — a signal its funnel has no rung for. Its chain read `contacted` and then 0 on
  // every rung. The id below is deliberately a fresh one: nothing here excludes anybody by name.

  it("a client whose chain shows NOTHING past the outreach base is not named, whatever its snapshot said, and the next one fills its seat", async () => {
    mockFetch(WITH_VITAL);
    const body = await get();
    const recent = body.groups.recentlyStarted;

    expect(recent.brands.map((b) => b.brand.id)).not.toContain(VITAL);
    expect(body.brands.map((b) => b.brand.id)).not.toContain(VITAL);
    // Every client the row DOES name shows a measured, positive count on a rung past `contacted`.
    for (const entry of recent.brands) {
      const pastBase = entry.funnels.flatMap((f) => f.steps.filter((st) => st.key !== "contacted"));
      expect(pastBase.some((st) => st.peopleReached !== null && st.peopleReached > 0)).toBe(true);
    }
  });

  it("website visits never qualify the hero row: meetings first, then positive replies, refusals off qualifyingCount", async () => {
    mockFetch(WITH_VITAL);
    const recent = (await get()).groups.recentlyStarted;

    // Vital (clicks only, stale snapshot claim) is walked and refused; the walk goes on to fill the row.
    expect(recent.brands.map((b) => b.brand.id)).toEqual([DOC, OPS, SHOCK]);
    // Four passed the snapshot gate; one showed neither a meeting nor a positive reply on its own chain.
    expect(recent.qualifyingCount).toBe(3);
    expect(recent.requestedCount).toBe(3);
  });

  it("a row that cannot be honestly filled is SHORT, and says so, rather than padded", async () => {
    // Shockwave's org cannot be resolved in the base fixture, so its chain cannot be read: an
    // unmeasured client shows nothing past the base either, and is not named.
    mockFetch(BASE);
    const recent = (await get()).groups.recentlyStarted;

    expect(recent.brands.map((b) => b.brand.id)).toEqual([DOC, OPS]);
    expect(recent.measured).toBe(true);
    expect(recent.requestedCount).toBe(3);
    expect(recent.qualifyingCount).toBe(2);
  });

  it("a group with nobody NAMES WHICH SILENCE it is", async () => {
    // No snapshot at all: nothing to rank, which is not the same as "nobody qualified".
    mockFetch({ ...BASE, snapshot: null });
    const cold = await get();
    expect(cold.groups.recentlyStarted.measured).toBe(false);
    expect(cold.groups.recentlyStarted.unmeasuredReason).toBe("no_snapshot_yet");
    expect(cold.brands).toEqual([]);

    // A snapshot that holds only the client that produced nothing: something to say, and a different thing.
    __resetShowcaseFunnelsCache();
    cells.clear(); // recompute on the new fixture, never the stored build
    mockFetch({ ...BASE, snapshot: [SNAPSHOT[3]] });
    const thin = await get();
    expect(thin.groups.recentlyStarted.unmeasuredReason).toBe("no_qualifying_clients");
    expect(thin.groups.recentlyStarted.qualifyingCount).toBe(0);
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
      "Form submitted",
      "Paid client",
    ]);
    expect(ops.funnels[0].steps[1].peopleReached).toBe(1);
    // THE MIDDLE RUNG IS MEASURED, NOT NULL. The website-conversion attribution sets are fetched on
    // the same flag the spend block is, so a cheaper read would leave this rung permanently
    // unmeasurable — a gate excluding the very funnel this brand sells. The tracker attributes one
    // form fill here, a measured count, a different statement from "we have no figure".
    expect(ops.funnels[0].steps[2].label).toBe("Form submitted");
    expect(ops.funnels[0].steps[2].peopleReached).toBe(1);
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

  // A client whose chain could not be walked shows no outcome, so the group does not name it. Each silence
  // below is a refusal that never blanks the rest.
  const refusedEverywhere = (body: Body, id: string) => {
    expect(body.brands.map((b) => b.brand.id)).not.toContain(id);
    expect(body.groups.recentlyStarted.brands.map((b) => b.brand.id)).not.toContain(id);
    expect(brandOf(body, DOC).measured).toBe(true);
    expect(brandOf(body, OPS).measured).toBe(true);
  };

  it("a brand with no lead membership is never read under a guessed org, and is not named", async () => {
    mockFetch(BASE);
    refusedEverywhere(await get(), SHOCK);
  });

  it("a brand campaign-service lists no campaign for is not named", async () => {
    mockFetch({
      ...BASE,
      memberships: [DOC, OPS, SHOCK],
      brands: { ...BASE.brands, [SHOCK]: { funnelKey: CONVERSATION, leads: [], noCampaigns: true } },
    });
    refusedEverywhere(await get(), SHOCK);
  });

  it("a brand whose campaigns state no funnel is not named", async () => {
    mockFetch({
      ...BASE,
      memberships: [DOC, OPS, SHOCK],
      brands: { ...BASE.brands, [SHOCK]: { funnelKey: null, leads: [] } },
    });
    refusedEverywhere(await get(), SHOCK);
  });

  it("ONE brand's failed read never blanks the others", async () => {
    mockFetch({
      ...BASE,
      memberships: [DOC, OPS, SHOCK],
      brands: { ...BASE.brands, [SHOCK]: { funnelKey: CONVERSATION, leads: [], campaignsFail: true } },
    });
    refusedEverywhere(await get(), SHOCK);
  });

  // ── THE MONEY HALF ────────────────────────────────────────────────────────────────────────────
  //
  // Same fixture, same engine pass. $100 committed for docdinners against 4 contacted / 2 replies /
  // 1 booked / 1 attended / 0 closed, so every figure below is hand-checkable — which is the point:
  // a suite that only asserted "a number came back" would pass on an implementation that divided by
  // the wrong count, or that published a projection under the word the client's dashboard uses.

  it("prices EVERY rung, the outreach base included, on ONE formula the consumer never re-divides", async () => {
    mockFetch(BASE);
    const chain = brandOf(await get(), DOC).funnels[0];

    // $100 committed ÷ the people who reached each rung. The base is priced identically to the rungs
    // above it, so a consumer renders "cost per contact" and "cost per meeting booked" with no branch.
    expect(chain.steps.map((s) => [s.label, s.costPerReachUsd])).toEqual([
      ["Contacted", 25],
      ["Positive reply", 50],
      ["Meeting booked", 100],
      ["Meeting attended", 100],
      // Nobody closed: no denominator, so we have NO FIGURE. Never a $0, which on a marketing page
      // would read as this client's paying customers having been free.
      ["Paid client", null],
    ]);
    // And the rung it is null on is a MEASURED zero — the two statements sit side by side and say
    // different things, which is exactly what lets the page leave one blank and print the other.
    expect(chain.steps[4].peopleReached).toBe(0);
    // Dollars on the wire. A figure the page would have to scale is one it can scale wrongly.
    expect(chain.steps[0].costPerReachUsd).toBe(25);
  });

  it("every cost per reach rides the SAME committed spend: double the spend, double each cost, counts unchanged", async () => {
    mockFetch(BASE);
    const cheap = brandOf(await get(), DOC).funnels[0];
    __resetShowcaseFunnelsCache();
    cells.clear(); // recompute on the new fixture, never the stored build
    mockFetch({ ...BASE, spendCents: 20000 });
    const dear = brandOf(await get(), DOC).funnels[0];
    expect(dear.steps.map((s) => s.costPerReachUsd)).toEqual([50, 100, 200, 200, null]);
    expect(dear.steps.map((s) => s.peopleReached)).toEqual(cheap.steps.map((s) => s.peopleReached));
  });

  it("prices every money figure at REAL VENDOR COST, not on what the client paid (PUBLIC-VENDOR-COST-1031)", async () => {
    mockFetch(BASE);
    const billed = brandOf(await get(), DOC).funnels[0];

    __resetShowcaseFunnelsCache();
    cells.clear(); // recompute on the new fixture, never the stored build
    mockFetch({ ...BASE, spendCents: 10000, vendorSpendCents: 5000 });
    const vendor = brandOf(await get(), DOC).funnels[0];

    // The vendors charged us half: every rung cost half.
    expect(vendor.steps.map((s) => s.costPerReachUsd)).toEqual([12.5, 25, 50, 50, null]);
    expect(vendor.steps.map((s) => s.peopleReached)).toEqual(billed.steps.map((s) => s.peopleReached));
  });

  it("a client's discount moves nothing public: the money is vendor cost", async () => {
    mockFetch(BASE);
    const implicit = await get();

    __resetShowcaseFunnelsCache();
    cells.clear(); // recompute on the new fixture, never the stored build
    mockFetch({ ...BASE, spendCents: 10000, netSpendCents: 5000 });
    const discounted = await get();

    expect(brandOf(discounted, DOC).funnels[0]).toEqual(brandOf(implicit, DOC).funnels[0]);
    expect(discounted.costBasis).toBe("vendor");
  });

  it("a client whose billed spend lacks a vendor cost past 1% shows no money, says why, and keeps its counts", async () => {
    mockFetch({ ...BASE, unpricedSpendCents: 500 });
    const res = await get();
    const brand = brandOf(res, DOC);
    expect(brand.vendorCost).toMatchObject({ moneyUnavailableReason: "vendor_cost_unknown" });
    expect(brand.vendorCost!.unpricedSharePct).toBeGreaterThan(1);
    expect(brand.funnels[0].steps.map((s: { costPerReachUsd: number | null }) => s.costPerReachUsd)).toEqual([null, null, null, null, null]);
    expect(brand.funnels[0].steps.map((s: { peopleReached: number | null }) => s.peopleReached)).toEqual([4, 2, 1, 1, 0]);
  });

  it("a client whose spend we cannot read has NO money figure, while its counts still answer", async () => {
    mockFetch({ ...BASE, spendCents: 0 });
    const chain = brandOf(await get(), DOC).funnels[0];

    // Nothing to divide, so there is no cost — null everywhere, never 0.
    expect(chain.steps.map((s) => s.costPerReachUsd)).toEqual([null, null, null, null, null]);
    // The volume half is untouched: what we measured about people does not wait on what we know
    // about money, and the page can still state the funnel.
    expect(chain.steps.map((s) => s.peopleReached)).toEqual([4, 2, 1, 1, 0]);
  });

  it("a rung we could not COUNT carries no cost either — an unmeasured base is never priced", async () => {
    mockFetch({ ...BASE, statedReadable: false });
    const chain = brandOf(await get(), DOC).funnels[0];
    const attended = chain.steps.find((s) => s.label === "Meeting attended")!;

    expect(attended.peopleReached).toBeNull();
    expect(attended.costPerReachUsd).toBeNull();
    // The rungs the core lead read alone evidences keep both halves.
    expect(chain.steps[1].peopleReached).toBe(2);
    expect(chain.steps[1].costPerReachUsd).toBe(50);
  });

  it("each client's money is its OWN, and the total spend is never published", async () => {
    mockFetch(BASE);
    const body = await get();
    const ops = brandOf(body, OPS).funnels[0];

    // opsfolio: $100 over 2 contacted / 1 visit / 1 form fill — its own chain, its own denominators.
    expect(ops.steps.map((s) => [s.label, s.costPerReachUsd])).toEqual([
      ["Contacted", 50],
      ["Website visit", 100],
      ["Form submitted", 100],
      ["Paid client", null],
    ]);

    // A named client's total spend is not something this page asks for, so an unauthenticated read of
    // named clients does not state it. The keys are exactly the four the page renders.
    expect(Object.keys(ops.steps[0]).sort()).toEqual(["costPerReachUsd", "key", "label", "peopleReached"]);
    // No CLIENT entry carries a spend anywhere.
    expect(JSON.stringify(body.brands)).not.toContain("committedSpent");
    expect(JSON.stringify(body.brands)).not.toContain("SpendUsd");
  });
});

// ── THE HERO ROW ON A WIDER FLEET (owner 2026-11-07, SHOWCASE-MAX-1107) ─────────────────────────
describe("the stored showcase (MON-PAGE-SPEED-2-1112: a deploy never rebuilds a fresh one)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetShowcaseFunnelsCache();
    withFeatures();
  });
  afterEach(() => vi.restoreAllMocks());

  it("every build is stored; a fresh process serves it with no walk, and its boot step skips", async () => {
    mockFetch(READABLE_SHOCK);
    const built = await get();
    expect([...cells.keys()].some((k) => k.startsWith("showcase:"))).toBe(true);

    __resetShowcaseFunnelsCache(); // a new process: nothing in memory
    const fetchSpy = vi.fn(async () => {
      throw new Error("no fleet read may run");
    });
    vi.stubGlobal("fetch", fetchSpy);
    await expect(warmShowcaseFunnelsOnBoot()).resolves.toBe("skipped");
    expect(await get()).toEqual(built);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("a stored copy past its fresh window is rebuilt by the boot step", async () => {
    mockFetch(READABLE_SHOCK);
    await get();
    const [key, cell] = [...cells.entries()].find(([k]) => k.startsWith("showcase:"))!;
    cells.set(key, { ...cell, computedAt: Date.now() - 20 * 60_000 });
    __resetShowcaseFunnelsCache();
    mockFetch(READABLE_SHOCK);
    await expect(warmShowcaseFunnelsOnBoot()).resolves.toBe("built");
    expect(cells.get(key)!.computedAt).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe("the hero row on a wider fleet", () => {
  const ANECDOTE = "aaaaaaaa-0000-4000-8000-000000000001"; // 1 positive reply: the obra.cam shape
  const FOUR = "aaaaaaaa-0000-4000-8000-000000000002";
  const P5 = "aaaaaaaa-0000-4000-8000-000000000003";
  const P6 = "aaaaaaaa-0000-4000-8000-000000000004";
  const P7 = "aaaaaaaa-0000-4000-8000-000000000005";
  const OLDEST = "aaaaaaaa-0000-4000-8000-000000000006";
  const replies = (id: string, n: number) => [
    ...Array.from({ length: n }, (_, i) => lead(id, `r${i}`, "reply")),
    lead(id, "quiet", "none"),
  ];
  const brandsOf = (spec: Array<[string, number]>) =>
    Object.fromEntries(spec.map(([id, n]) => [id, { funnelKey: CONVERSATION, leads: replies(id, n) }]));
  const SPEC: Array<[string, number]> = [[ANECDOTE, 1], [FOUR, 4], [P5, 5], [P6, 6], [P7, 7], [OLDEST, 9]];
  const FIXTURE: Fixture = {
    brands: brandsOf(SPEC),
    memberships: SPEC.map(([id]) => id),
    snapshot: SPEC.map(([brandId, n]) => ({ brandId, outcomeCount: n, meetingsBooked: 0, positiveReplies: n })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetShowcaseFunnelsCache();
    withFeatures();
  });
  afterEach(() => vi.restoreAllMocks());

  it("names the BIGGEST figures, never the 1-positive-reply client while bigger ones exist", async () => {
    mockFetch(FIXTURE);
    const recent = (await get()).groups.recentlyStarted;
    expect(recent.brands.map((b) => b.brand.id)).toEqual([OLDEST, P7, P6]);
    expect(recent.brands.map((b) => b.brand.id)).not.toContain(ANECDOTE);
  });

  it("most meetings booked first, ties and fill by most positive replies", async () => {
    mockFetch({
      ...FIXTURE,
      brands: {
        ...FIXTURE.brands,
        [P6]: { funnelKey: CONVERSATION, leads: replies(P6, 6), stated: { meeting_booked: ["r0"] } },
        [P5]: { funnelKey: CONVERSATION, leads: replies(P5, 5), stated: { meeting_booked: ["r0", "r1"] } },
      },
      snapshot: [
        ...SPEC.filter(([id]) => id !== P5 && id !== P6).map(([brandId, n]) => ({ brandId, outcomeCount: n, meetingsBooked: 0, positiveReplies: n })),
        { brandId: P6, outcomeCount: 6, meetingsBooked: 1, positiveReplies: 6 },
        { brandId: P5, outcomeCount: 5, meetingsBooked: 2, positiveReplies: 5 },
      ],
    });
    const res = await request(app).get("/public/stats/showcase-outcomes");
    expect(res.status).toBe(200);
    const recent = res.body.groups.recentlyStarted.brands as Array<{
      brand: { id: string };
      outcomes: Array<{ key: string; peopleReached: number | null }>;
    }>;
    expect(recent.map((b) => b.brand.id)).toEqual([P5, P6, OLDEST]);
    const count = (b: (typeof recent)[number], key: string) => b.outcomes.find((o) => o.key === key)?.peopleReached;
    expect(recent.map((b) => [count(b, "meeting_booked"), count(b, "conversation")])).toEqual([[2, 5], [1, 6], [0, 9]]);
  });

  it("a client whose read fails is replaced by the next biggest: the row stays at 3", async () => {
    mockFetch({ ...FIXTURE, brands: { ...FIXTURE.brands, [OLDEST]: { funnelKey: CONVERSATION, leads: replies(OLDEST, 9), campaignsFail: true } } });
    const recent = (await get()).groups.recentlyStarted;
    expect(recent.brands.map((b) => b.brand.id)).toEqual([P7, P6, P5]);
  });
});

describe("foldFleetSnapshotRows (the snapshot warm)", () => {
  const pair = (brandId: string, meetingsBooked: number | null, positiveReplies: number | null) => ({ brandId, outcomeCount: 1, meetingsBooked, positiveReplies });

  it("sums a brand's counts across its orgs", () => {
    expect(foldFleetSnapshotRows([pair("a", 1, 4), pair("a", 2, 3), null], new Set(), null)).toEqual([
      { brandId: "a", outcomeCount: 2, meetingsBooked: 3, positiveReplies: 7 },
    ]);
  });

  it("a brand whose pass FAILED keeps its prior row, never a partial or missing one", () => {
    const prior = [{ brandId: "doc", outcomeCount: 64, meetingsBooked: 3, positiveReplies: 20 }];
    const rows = foldFleetSnapshotRows([pair("doc", 0, 0), pair("other", 0, 1)], new Set(["doc"]), prior);
    expect(rows).toEqual(expect.arrayContaining([prior[0], { brandId: "other", outcomeCount: 1, meetingsBooked: 0, positiveReplies: 1 }]));
    expect(rows).toHaveLength(2);
  });

  it("a failed brand with no prior row keeps whatever its other orgs counted", () => {
    expect(foldFleetSnapshotRows([pair("new", 0, 2)], new Set(["new"]), [])).toEqual([{ brandId: "new", outcomeCount: 1, meetingsBooked: 0, positiveReplies: 2 }]);
  });
});

describe("brandReadingFunnels", () => {
  it("takes the brand's reading paths, deduped, in catalogue order", () => {
    expect(
      brandReadingFunnels([{ funnelKey: FORM }, { funnelKey: CONVERSATION }, { funnelKey: CONVERSATION }]),
    ).toEqual([CONVERSATION, FORM]);
  });

  it("a brand whose campaigns perform no leg reads none — nothing is parked on a default", () => {
    expect(brandReadingFunnels([])).toEqual([]);
  });
});

// ── WAVE C4: the SAME showcase, per OUTCOME ─────────────────────────────────────────────────────────
//
// `/public/stats/showcase-outcomes` is the funnel-keyed read re-keyed on the fleet's own vocabulary,
// off the SAME cell. Every case asserts it RECONCILES with the funnel read on the same fixture — a
// client selling one path reads the byte-same counts, costs and return under both — and that nothing
// on it names a funnel.
describe("GET /public/stats/showcase-outcomes (wave C4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetShowcaseFunnelsCache();
    withFeatures();
  });
  afterEach(() => vi.restoreAllMocks());

  type OutcomesBody = {
    brands: Array<{
      brand: { id: string };
      outcomes: Array<{ key: string; label: string; legKeys: string[]; peopleReached: number | null; costPerReachUsd: number | null }>;
      measured: boolean;
      unmeasuredReason: string | null;
    }>;
    groups: { recentlyStarted: { brands: Array<{ brand: { id: string } }> } };
  };

  it("names the same clients in the same order, and a one-path client reads the byte-same figures", async () => {
    mockFetch(READABLE_SHOCK);
    const funnels = await get();
    const res = await request(app).get("/public/stats/showcase-outcomes");
    expect(res.status).toBe(200);
    const outcomes = res.body as OutcomesBody;

    const ids = (g: { brands: Array<{ brand: { id: string } }> }) => g.brands.map((b) => b.brand.id);
    expect(ids(outcomes.groups.recentlyStarted)).toEqual(ids(funnels.groups.recentlyStarted));
    expect(outcomes.brands.map((b) => b.brand.id)).toEqual(funnels.brands.map((b) => b.brand.id));
    expect(Object.keys(outcomes.groups)).toEqual(["recentlyStarted"]);

    let reconciled = 0;
    for (const entry of funnels.brands) {
      const twin = outcomes.brands.find((b) => b.brand.id === entry.brand.id)!;
      expect(twin.measured).toBe(entry.measured);
      if (entry.funnels.length !== 1) continue;
      const chain = entry.funnels[0];
      expect(twin).not.toHaveProperty("returnPerDollar");
      // Every walked client states positive replies and meetings booked, even when its path walks
      // neither (opsfolio's form path): those rows carry no leg.
      expect(twin.outcomes.map((o) => o.key)).toEqual(expect.arrayContaining(["conversation", "meeting_booked"]));
      const walked = twin.outcomes.filter((o) => o.key === "contacted" || o.legKeys.length > 0);
      expect(walked.map((o) => [o.key, o.peopleReached, o.costPerReachUsd])).toEqual(
        chain.steps.map((s) => [s.key === "contacted" ? "contacted" : funnelLeg(s.key)!.toStep.key, s.peopleReached, s.costPerReachUsd]),
      );
      // Each outcome names the leg that lands on it — the rung's own key on the funnel read.
      expect(walked.slice(1).map((o) => o.legKeys)).toEqual(chain.steps.slice(1).map((s) => [s.key]));
      reconciled += 1;
    }
    expect(reconciled).toBeGreaterThan(0);
    // Nothing on the per-outcome body names a funnel.
    expect(JSON.stringify(outcomes)).not.toMatch(/funnel/i);
  });

  // SHOWCASE-MAX-1107 (owner 2026-11-07, « enlève ce putain de filtre »): the public card counts EVERY
  // conversion, the same counts the client reads on its own dashboard, whatever caused it.
  it("counts every conversion: a CRM meeting not caused by our outreach (false) or undecided (null) still counts", async () => {
    mockFetch({
      ...BASE,
      brands: {
        ...BASE.brands,
        [DOC]: {
          ...BASE.brands[DOC],
          stated: { meeting_booked: ["l1", "l2", "l3"], meeting_attended: ["l1", "l2"], sale: [] },
          causes: { l1: true, l2: false, l3: null },
        },
      },
    });
    const res = await request(app).get("/public/stats/showcase-outcomes");
    const twin = (res.body as OutcomesBody).brands.find((b) => b.brand.id === DOC)!;
    expect(twin.outcomes.find((o) => o.key === "meeting_booked")?.peopleReached).toBe(3);
    expect(twin.outcomes.find((o) => o.key === "meeting_attended")?.peopleReached).toBe(2);
  });

  it("every walked client failing to read is a failure, never a cached empty row (lead-service down, 2026-10-29)", async () => {
    const down = Object.fromEntries(Object.entries(BASE.brands).map(([id, b]) => [id, { ...b, campaignsFail: true }]));
    mockFetch({ ...BASE, brands: down, memberships: Object.keys(BASE.brands) });
    const res = await request(app).get("/public/stats/showcase-outcomes");
    expect(res.status).toBe(500);
  });

  it("a client with nothing to walk keeps its NAMED reason, and a leg-less one says so in leg words", async () => {
    mockFetch(BASE);
    await get();
    const res = await request(app).get("/public/stats/showcase-outcomes");
    for (const b of (res.body as OutcomesBody).brands) {
      if (b.measured) continue;
      expect(b.outcomes).toEqual([]);
      expect(b.unmeasuredReason).not.toBe("no_funnel_sold");
      expect(b.unmeasuredReason).not.toBeNull();
    }
  });

  it("serving the outcome twin leaves the funnel-keyed body's SHAPE untouched", async () => {
    mockFetch(READABLE_SHOCK);
    const body = await get();
    expect(Object.keys(body).sort()).toEqual(["brands", "costBasis", "groups"]);
    for (const b of body.brands) {
      // `vendorCost` (PUBLIC-VENDOR-COST-1031) rides every walked brand.
      expect(Object.keys(b).filter((k) => k !== "vendorCost").sort()).toEqual(["brand", "funnels", "measured", "unmeasuredReason"]);
      for (const f of b.funnels) {
        expect(Object.keys(f).sort()).toEqual(["funnelKey", "funnelName", "steps"]);
        for (const s of f.steps) expect(Object.keys(s).sort()).toEqual(["costPerReachUsd", "key", "label", "peopleReached"]);
      }
    }
  });
});
