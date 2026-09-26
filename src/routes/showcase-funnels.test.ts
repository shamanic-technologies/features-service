/**
 * THE CLIENTS OUR HOMEPAGE NAMES — picked here, ordered here, public and org-less.
 *
 * ONE downstream fixture drives every case, shaped like what the homepage actually states: clients
 * selling different funnels, one with a rung nobody has reached, and one whose 21.5x sits on $4 of
 * spend (the shape production's unfiltered ranking leads with). What the cases pin:
 *
 *   - the two PICKS are the service's, ALREADY ORDERED, and they DIVERGE: the recency order and the
 *     return order name the same clients in OPPOSITE sequences on one fixture, so a suite that only
 *     checked "a group came back" would pass on an implementation that served one list twice;
 *   - the SPEND FLOOR excludes the $4 client the unfiltered ranking would lead with, and the floor is
 *     STATED on the wire;
 *   - the OUTCOME gate excludes a client that began yesterday and has produced nothing — and it is
 *     decided on the RUNGS of the chain the page draws, never on the outreach base: a client selling
 *     the reply funnel whose only evidence is clicks (a signal that funnel has no step for) is not
 *     named, the next honest candidate takes its place, and the rejection comes off `qualifyingCount`;
 *   - a group with nobody SAYS WHICH SILENCE it is, and a SHORT group is a stated fact rather than a
 *     list somebody has to count;
 *   - the route NAMES NO BRAND: a `?brandId=` on the request changes nothing, which is the whole
 *     access control of an unauthenticated read of named clients' figures;
 *   - the chain is the funnel's OWN steps in the funnel's OWN order, the outreach base first, under
 *     the funnel's own names — and a rung nobody reached is SERVED at 0 rather than dropped, because
 *     the page draws the funnel in order and hides empty cells itself;
 *   - a rung whose only producer degraded reads NULL — "we have no figure" — never a 0;
 *   - each brand walks the funnel its OWN campaigns state they sell, not the other brand's;
 *   - a picked brand with nothing to walk carries `funnels: []` with a NAMED reason, and one brand's
 *     failed read never blanks the others;
 *   - the MONEY half rides the same pass: every rung states what reaching it cost (the base priced on
 *     the identical formula, so the consumer never branches), each chain states the client's own
 *     realized return, and both HALVE/DOUBLE with committed spend — which a forward projection would
 *     not, and which is why the divergence is asserted rather than "a number came back";
 *   - a figure we could not measure is NULL beside a measured 0, both for a rung nobody reached and
 *     for a client whose spend we cannot read — and no client's total spend is ever published.
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
const { brandReadingFunnels } = await import("../lib/showcase-funnels.js");
const { offerEconomicsFromDeclared } = await import("../lib/leg-economics-fixture.js");

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
   * The stored fleet-snapshot rows the PICKS are ranked over. `null` = no snapshot exists at all,
   * which is a different silence from "a snapshot exists and nobody qualifies".
   */
  snapshot?: SnapshotRow[] | null;
}

/** One stored row of the persisted fleet snapshot — what a ranking has to work with. */
interface SnapshotRow {
  brandId: string;
  committedSpendUsd: number;
  expectedPipelineUsd: number | null;
  startedOn?: string | null;
  outcomeCount?: number | null;
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
      return json({
        groups: [
          {
            dimensions: { campaignId: `camp-${brandOf(q, headers)}`, workflowSlug: "dawn-v1" },
            totalCostInUsdCents: cents,
            actualCostInUsdCents: cents,
            netTotalCostInUsdCents: netCents,
            netActualCostInUsdCents: netCents,
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
/**
 * THE SNAPSHOT THE PICKS RANK OVER, built so the TWO ORDERS DISAGREE.
 *
 * By return:  opsfolio 55.6x  >  shockwave 3.6x  >  docdinners 1.65x
 * By recency: shockwave (Aug) >  opsfolio (Jun) >  docdinners (Mar)
 *
 * So the first client of one group is the second of the other, and an implementation that served one
 * ranking under both names fails. The outsider carries the production shape both gates must reject:
 * a 22x on $4 of spend, and nothing produced.
 */
const SNAPSHOT: SnapshotRow[] = [
  { brandId: DOC, committedSpendUsd: 5046.42, expectedPipelineUsd: 8250, startedOn: "2026-03-01", outcomeCount: 2 },
  { brandId: OPS, committedSpendUsd: 354.96, expectedPipelineUsd: 19750, startedOn: "2026-06-01", outcomeCount: 1 },
  { brandId: SHOCK, committedSpendUsd: 497.65, expectedPipelineUsd: 1800, startedOn: "2026-08-01", outcomeCount: 1 },
  // 22x on $4.12, begun most recently of all, and nothing to show for it.
  { brandId: OUTSIDER, committedSpendUsd: 4.12, expectedPipelineUsd: 88.74, startedOn: "2026-09-01", outcomeCount: 0 },
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
      leads: [lead(OPS, "l1", "click"), lead(OPS, "l2", "none")],
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
 * Living Vital's production shape: sells the REPLY funnel, began most recently, clicked twice and
 * replied never — so a gate counting clicks lets it through while its own chain shows nothing past
 * `contacted`. Its snapshot row carries the count the OLD warm wrote, which is exactly the stale state
 * the route has to be robust to until the next warm rewrites it.
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
    { brandId: VITAL, committedSpendUsd: 97.38, expectedPipelineUsd: 0, startedOn: "2026-09-10", outcomeCount: 2 },
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
  groups: { recentlyStarted: Group; highestReturn: Group };
  minSpendUsd: number;
  brands: Array<{
    brand: { id: string; name: string | null; domain: string | null };
    funnels: Array<{
      funnelKey: string;
      funnelName: string;
      returnPerDollar: number | null;
      steps: Array<{ key: string; label: string; peopleReached: number | null; costPerReachUsd: number | null }>;
    }>;
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

    // Byte-identical: the parameter is not read, so it cannot select anything. WHICH clients are named
    // is a ranking this service computes; a caller cannot put a brand into it, or take one out.
    expect(asked).toEqual(plain);
    expect(plain.brands.map((b) => b.brand.id)).not.toContain(OUTSIDER);
  });

  it("serves TWO groups, each already ordered, and the two orders DISAGREE", async () => {
    mockFetch(READABLE_SHOCK);
    const body = await get();

    // Newest beginning first. Shockwave began in August, opsfolio in June, docdinners in March.
    expect(body.groups.recentlyStarted.brands.map((b) => b.brand.id)).toEqual([SHOCK, OPS, DOC]);
    // Best return first — the SAME three clients in a DIFFERENT order (55.6x / 3.6x / 1.65x). An
    // implementation that served one ranking under both names cannot pass both of these.
    expect(body.groups.highestReturn.brands.map((b) => b.brand.id)).toEqual([OPS, SHOCK, DOC]);

    expect(body.groups.recentlyStarted.measured).toBe(true);
    expect(body.groups.highestReturn.measured).toBe(true);
    expect(body.groups.recentlyStarted.unmeasuredReason).toBeNull();
  });

  it("names each client ONCE in the union, carrying the identical entry both groups carry", async () => {
    mockFetch(BASE);
    const body = await get();

    // The deduped union — the field the existing consumer reads, unchanged in shape. A client picked
    // by BOTH rankings is here once and in both groups.
    expect([...body.brands.map((b) => b.brand.id)].sort()).toEqual([DOC, OPS, SHOCK].sort());
    expect(brandOf(body, DOC).brand.domain).toBe(`${DOC}.com`);
    // Byte-identical entries: a client does not have two funnels because two rankings liked it.
    expect(body.groups.recentlyStarted.brands.find((b) => b.brand.id === DOC)).toEqual(brandOf(body, DOC));
    expect(body.groups.highestReturn.brands.find((b) => b.brand.id === DOC)).toEqual(brandOf(body, DOC));
  });

  it("the SPEND FLOOR keeps out the 22x that sits on $4, and the floor is STATED", async () => {
    mockFetch(BASE);
    const body = await get();

    // The outsider's 22x would take SECOND place unfiltered and push docdinners — whose 1.63x has
    // $5,046 of real money behind it — off the list. Below the floor a return is whatever that
    // client's first outcome happened to do, so it is not ranked at all.
    expect(body.groups.highestReturn.brands.map((b) => b.brand.id)).not.toContain(OUTSIDER);
    expect(body.groups.highestReturn.brands.map((b) => b.brand.id)).toContain(DOC);
    // A ranking whose population a reader cannot see is a ranking they cannot check.
    expect(body.minSpendUsd).toBe(100);
  });

  it("the OUTCOME gate keeps out the client that began most recently and produced nothing", async () => {
    mockFetch(READABLE_SHOCK);
    const body = await get();

    // The outsider began in September — later than every client named — and has moved nobody past
    // outreach, so the row of live cards does not lead with it.
    expect(body.groups.recentlyStarted.brands.map((b) => b.brand.id)).not.toContain(OUTSIDER);
    expect(body.groups.recentlyStarted.brands[0].brand.id).toBe(SHOCK);
  });

  // ── AN OUTCOME IS A RUNG PAST THE BASE, READ ON THE CLIENT'S OWN CHAIN ─────────────────────────
  //
  // The production shape that shipped wrong (Living Vital, 2026-09-24): a client selling the REPLY
  // funnel, begun most recently of all, whose snapshot said it had produced something because the
  // warm counted clicks — a signal its funnel has no rung for. Its chain read `contacted` and then 0 on
  // every rung. The id below is deliberately a fresh one: nothing here excludes anybody by name.

  it("a client whose chain shows NOTHING past the outreach base is not named, whatever its snapshot said", async () => {
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

  it("the next honest candidate takes the refused client's place, and the refusal comes off qualifyingCount", async () => {
    mockFetch(WITH_VITAL);
    const recent = (await get()).groups.recentlyStarted;

    // Vital began first (September) and is refused; the three that produced something fill the row in
    // their own recency order.
    expect(recent.brands.map((b) => b.brand.id)).toEqual([SHOCK, OPS, DOC]);
    // Four passed the snapshot prefilter; one showed nothing on its own chain.
    expect(recent.qualifyingCount).toBe(3);
    expect(recent.requestedCount).toBe(3);
  });

  it("a row that cannot be honestly filled is SHORT, and says so, rather than padded", async () => {
    // Shockwave's org cannot be resolved in the base fixture, so its chain cannot be read: an
    // unmeasured client shows nothing past the base either, and is not named.
    mockFetch(BASE);
    const recent = (await get()).groups.recentlyStarted;

    expect(recent.brands.map((b) => b.brand.id)).toEqual([OPS, DOC]);
    expect(recent.measured).toBe(true);
    expect(recent.requestedCount).toBe(3);
    expect(recent.qualifyingCount).toBe(2);
  });

  it("the return group is untouched by the recency check", async () => {
    mockFetch(WITH_VITAL);
    const body = await get();
    expect(body.groups.highestReturn.brands.map((b) => b.brand.id)).toEqual([OPS, SHOCK, DOC]);
  });

  it("a SHORT group is a stated fact, not a list somebody has to count", async () => {
    mockFetch({ ...BASE, snapshot: [SNAPSHOT[0], SNAPSHOT[3]] });
    const body = await get();

    expect(body.groups.highestReturn.brands.map((b) => b.brand.id)).toEqual([DOC]);
    expect(body.groups.highestReturn.measured).toBe(true);
    expect(body.groups.highestReturn.requestedCount).toBe(3);
    // One client passed the gate where three were asked for — visible on the wire.
    expect(body.groups.highestReturn.qualifyingCount).toBe(1);
  });

  it("a group with nobody NAMES WHICH SILENCE it is", async () => {
    // No snapshot at all: nothing to rank, which is not the same as "nobody qualified".
    mockFetch({ ...BASE, snapshot: null });
    const cold = await get();
    expect(cold.groups.recentlyStarted.measured).toBe(false);
    expect(cold.groups.recentlyStarted.unmeasuredReason).toBe("no_snapshot_yet");
    expect(cold.groups.highestReturn.unmeasuredReason).toBe("no_snapshot_yet");
    expect(cold.brands).toEqual([]);

    // A snapshot that holds only the sub-floor client: something to say, and a different thing.
    __resetShowcaseFunnelsCache();
    mockFetch({ ...BASE, snapshot: [SNAPSHOT[3]] });
    const thin = await get();
    expect(thin.groups.highestReturn.unmeasuredReason).toBe("no_qualifying_clients");
    expect(thin.groups.recentlyStarted.unmeasuredReason).toBe("no_qualifying_clients");
    expect(thin.groups.highestReturn.qualifyingCount).toBe(0);
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
    // unmeasurable — a gate excluding the very funnel this brand sells. The tracker answered with an
    // EMPTY set here, which is a measured 0 and a different statement from "we have no figure".
    expect(ops.funnels[0].steps[2].label).toBe("Form submitted");
    expect(ops.funnels[0].steps[2].peopleReached).toBe(0);
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

  it("states the client's OWN return, and both halves ride the SAME committed spend", async () => {
    mockFetch(BASE);
    const cheap = brandOf(await get(), DOC).funnels[0];
    expect(cheap.returnPerDollar).toBeGreaterThan(0);
    expect(Number.isFinite(cheap.returnPerDollar!)).toBe(true);

    // DOUBLE what the client paid, change nothing else. A realized return over committed spend HALVES
    // and every cost per reach DOUBLES. A forward projection — the figure /public/channel-funnel-
    // economics publishes under the same words, an order apart in production — would not move at all.
    __resetShowcaseFunnelsCache();
    mockFetch({ ...BASE, spendCents: 20000 });
    const dear = brandOf(await get(), DOC).funnels[0];

    expect(dear.returnPerDollar).toBeCloseTo(cheap.returnPerDollar! / 2, 10);
    expect(dear.steps.map((s) => s.costPerReachUsd)).toEqual([50, 100, 200, 200, null]);
    // The counts are a fact about people and did not move with the money.
    expect(dear.steps.map((s) => s.peopleReached)).toEqual(cheap.steps.map((s) => s.peopleReached));
  });

  it("prices a DISCOUNTED client on what they PAID, not on our list price", async () => {
    // The money half is READ ON THE NET BASIS — what the client actually paid after their per-org
    // usage discount — because the page claims each figure is the one the client reads on their own
    // dashboard, and every dashboard surface in the fleet reads net. Same gross as BASE, net HALVED:
    // a gross-basis implementation answers BASE's numbers here and this case is the only thing that
    // catches it.
    mockFetch(BASE);
    const listPrice = brandOf(await get(), DOC).funnels[0];

    __resetShowcaseFunnelsCache();
    mockFetch({ ...BASE, spendCents: 10000, netSpendCents: 5000 });
    const paid = brandOf(await get(), DOC).funnels[0];

    // They paid half, so their dollar came back as twice as much and every rung cost them half.
    expect(paid.returnPerDollar).toBeCloseTo(listPrice.returnPerDollar! * 2, 10);
    expect(paid.steps.map((s) => s.costPerReachUsd)).toEqual([12.5, 25, 50, 50, null]);
    // Counts are a fact about people and never move with a discount.
    expect(paid.steps.map((s) => s.peopleReached)).toEqual(listPrice.steps.map((s) => s.peopleReached));
  });

  it("a client carrying NO discount is byte-identical — the regression check that nothing else moved", async () => {
    // A brand with no discount has a frozen net EQUAL to its gross on every cost row, so the net basis
    // must leave it exactly where it was. That is what makes this a value correction for the
    // discounted clients rather than a change of statistic for everybody.
    mockFetch(BASE);
    const implicit = brandOf(await get(), DOC).funnels[0];

    __resetShowcaseFunnelsCache();
    mockFetch({ ...BASE, spendCents: 10000, netSpendCents: 10000 });
    const explicit = brandOf(await get(), DOC).funnels[0];

    expect(explicit).toEqual(implicit);
  });

  it("a client whose spend we cannot read has NO money figure, while its counts still answer", async () => {
    mockFetch({ ...BASE, spendCents: 0 });
    const chain = brandOf(await get(), DOC).funnels[0];

    // Nothing to divide, so there is no return and no cost — null everywhere, never 0.
    expect(chain.returnPerDollar).toBeNull();
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

    // opsfolio: $100 over 2 contacted / 1 visit / 0 form fills — its own chain, its own denominators.
    expect(ops.steps.map((s) => [s.label, s.costPerReachUsd])).toEqual([
      ["Contacted", 50],
      ["Website visit", 100],
      ["Form submitted", null],
      ["Paid client", null],
    ]);

    // A named client's total spend is not something this page asks for, so an unauthenticated read of
    // named clients does not state it. The keys are exactly the four the page renders.
    expect(Object.keys(ops.steps[0]).sort()).toEqual(["costPerReachUsd", "key", "label", "peopleReached"]);
    // No CLIENT entry carries a spend anywhere. (`minSpendUsd` at the payload root is the ranking's
    // FLOOR — a fact about the question, not about any client's money.)
    expect(JSON.stringify(body.brands)).not.toContain("committedSpent");
    expect(JSON.stringify(body.brands)).not.toContain("SpendUsd");
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
