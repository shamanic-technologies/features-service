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
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;

const AUTH = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "run-1",
};

const SALES_FEATURE = {
  id: "feat-1",
  slug: "sales-cold-email-outreach",
  name: "Sales",
  description: "x",
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * ONE brand's economics for every case below, chosen so each rung is a DIFFERENT number and no two
 * can be confused: a lead that clicked is worth $34.70, one that replied $120, one that booked a
 * meeting $150, one that attended $300, one that closed $1,000.
 */
const ECONOMICS = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToSignupPct: 20,
  signupToPaidClientPct: 10,
  visitToClosePct: 2,
};

const PLATFORM_STATS = {
  broadcast: { recipientStats: { contacted: 100, sent: 100, delivered: 100, clicked: 10, repliesPositive: 10 } },
};

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

function leadRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    leadId: "l1",
    email: "l1@x.com",
    contacted: true,
    sent: true,
    delivered: true,
    clicked: false,
    bounced: false,
    unsubscribed: false,
    replied: false,
    replyClassification: null,
    lead: { firstName: "A", lastName: "B", photoUrl: null, organization: { id: "o1", name: "Org1", logoUrl: null } },
    ...over,
  };
}

/** The lead every case prices: it replied positively AND clicked. */
const ENGAGED = () =>
  leadRow({
    leadId: "lead-1",
    email: "jane@acme.com",
    clicked: true,
    replied: true,
    replyClassification: "positive",
    lead: { firstName: "Jane", lastName: "Doe", photoUrl: null, organization: { id: "acme", name: "Acme", logoUrl: null } },
  });

interface Outcome {
  email: string;
  occurredAt?: string | null;
  valueCents?: number | null;
}

interface Opts {
  /** The LEGACY instantly manual qualifications, email → the dates they carry. */
  legacy?: Record<string, { meetingBookedAt?: string; closedAt?: string }>;
  /** step → the outcomes a human stated for it. */
  outcomes?: Partial<Record<"meeting_booked" | "meeting_attended" | "sale", Outcome[]>>;
  /** step → the emails a human ruled out at it. */
  deadByStep?: Record<string, string[]>;
  /** The chains the brand declared. Absent ⇒ 404, i.e. declared nothing. */
  salesFunnels?: unknown[];
  outcomesFail?: boolean;
}

const declaredFunnel = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  funnelKey: "sales_meetings_from_conversation",
  active: true,
  name: "Meetings from conversations",
  steps: ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"],
  rates: {},
  lifetimeRevenueUsd: null,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-08-01T00:00:00Z",
  ...over,
});

function mockFetch(opts: Opts = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/converted-lead-emails")) return json({ event: "", emails: [] });
    if (url.includes("/manual-qualifications")) {
      const rows: unknown[] = [];
      for (const [email, q] of Object.entries(opts.legacy ?? {})) {
        if (q.meetingBookedAt) rows.push({ id: `q-${email}-m`, orgId: "org-1", campaignId: "c1", instantlyCampaignId: "ic1", email, status: "lead_meeting_booked", qualifiedBy: "u1", notes: null, qualifiedAt: q.meetingBookedAt });
        if (q.closedAt) rows.push({ id: `q-${email}-c`, orgId: "org-1", campaignId: "c1", instantlyCampaignId: "ic1", email, status: "lead_closed", qualifiedBy: "u1", notes: null, qualifiedAt: q.closedAt });
      }
      return json({ qualifications: rows });
    }
    if (url.includes("/converted-leads")) {
      if (opts.outcomesFail) return new Response("boom", { status: 502 });
      const event = (new URL(url, "http://x").searchParams.get("event") ?? "") as keyof NonNullable<Opts["outcomes"]>;
      const rows = (opts.outcomes?.[event] ?? []).map((o, i) => ({
        leadId: `lead-${event}-${i}`,
        email: o.email,
        campaignId: "c1",
        occurredAt: o.occurredAt === undefined ? daysAgo(2) : o.occurredAt,
        valueCents: o.valueCents ?? null,
        source: "manual",
      }));
      return json({ event, outcomes: rows });
    }
    if (url.includes("/step-disqualifications")) return json({ counts: {}, byStep: opts.deadByStep ?? {} });
    if (url.includes("/stats/costs")) {
      return json({
        groups: [
          {
            dimensions: {},
            totalCostInUsdCents: "0",
            actualCostInUsdCents: "0",
            runCount: 0,
            minStartedAt: null,
            maxStartedAt: null,
          },
        ],
      });
    }
    if (url.includes("/sales-funnels")) {
      if (!opts.salesFunnels) return new Response("no declaration", { status: 404 });
      return json({ funnels: opts.salesFunnels });
    }
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/public/stats")) return json(PLATFORM_STATS);
    if (url.includes("/orgs/leads")) return json({ leads: [ENGAGED()] });
    if (url.includes("/orgs/status")) {
      return json({
        results: [{ email: "jane@acme.com", firstClickedAt: daysAgo(20), firstRepliedAt: daysAgo(20) }],
      });
    }
    return json({});
  });
}

const pipeline = async (): Promise<number> => {
  const res = await request(app).get("/features/sales-cold-email-outreach/revenue?brandId=b1").set(AUTH);
  expect(res.status).toBe(200);
  return res.body.headline.totalPipelineUsd;
};

/**
 * WHAT A HUMAN OBSERVED IS WHAT THE LEAD IS WORTH.
 *
 * Every figure here used to be a forecast: a lead's value was its chance of one day becoming a paying
 * client, obtained by multiplying declared rates through whatever it last did. lead-service now
 * records what a human states about a funnel step, so for the steps somebody actually watched happen
 * there is nothing left to estimate.
 *
 * Three consequences, and each one is a different sentence about the same lead:
 *
 *   - a rung somebody OBSERVED replaces the forecast that was pointing at it, and the forecast is
 *     extinguished rather than added to it;
 *   - a rung somebody RULED OUT is worth nothing, along with the whole chain it sits on;
 *   - a deal somebody PRICED is worth what they said, not the brand's average.
 *
 * Every case below is driven from ONE lead and ONE set of economics, so the numbers are comparable
 * line by line: clicked $34.70, replied $120, booked $150, attended $300, closed $1,000.
 */
describe("a lead is worth what a human observed, not what we forecast", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── The baseline: nothing observed ────────────────────────────────────────

  it("prices the forecast when nobody has observed anything — unchanged", async () => {
    mockFetch();
    // The two engagement routes combine as independent shots at ONE close:
    // 1000 × orP(0.0347, 0.12) = 1000 × (1 − 0.9653 × 0.88) = 150.536.
    expect(await pipeline()).toBeCloseTo(150.536, 3);
  });

  // ── An observed rung replaces the forecast pointing at it ─────────────────

  it("a BOOKED meeting is worth the booked rung, and EXTINGUISHES the routes that forecast it", async () => {
    mockFetch({ outcomes: { meeting_booked: [{ email: "jane@acme.com" }] } });
    // 1000 × 30% — NOT that plus the click/reply forecast of the very meeting now sitting in the
    // calendar. The routes were predicting this; adding them would count the forecast and the fact.
    expect(await pipeline()).toBeCloseTo(300, 5);
  });

  it("an ATTENDED meeting is worth MORE than a booked one — the show-up rate is no longer free", async () => {
    const withShowUp = {
      // brand-service prices `meetingToClosePct` as ATTENDED→paid, with the show-up rate beside it.
      // Booked→paid therefore composes to 30% × 50% = 15%; attended→paid stays 30%.
      salesFunnels: [
        declaredFunnel({
          rates: { replyToMeetingPct: 40, meetingBookedToAttendedPct: 50, meetingToClosePct: 30 },
        }),
      ],
    };

    mockFetch({ ...withShowUp, outcomes: { meeting_booked: [{ email: "jane@acme.com" }] } });
    const booked = await pipeline();

    vi.restoreAllMocks();
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as never);
    mockFetch({
      ...withShowUp,
      outcomes: {
        meeting_booked: [{ email: "jane@acme.com" }],
        meeting_attended: [{ email: "jane@acme.com" }],
      },
    });
    const attended = await pipeline();

    expect(booked).toBeCloseTo(150, 5); // 1000 × 30% × 50% — they still have to turn up
    expect(attended).toBeCloseTo(300, 5); // 1000 × 30% — they did
    // The whole point: a no-show and a meeting somebody sat through are no longer the same number.
    expect(attended).toBeCloseTo(booked * 2, 5);
  });

  it("a WON deal is worth what somebody said it was worth, not the brand's average", async () => {
    mockFetch({ outcomes: { sale: [{ email: "jane@acme.com", valueCents: 4_900_000 }] } });
    // $49,000 stated — realized revenue is a fact, so it must not be routed through a $1,000 average.
    expect(await pipeline()).toBeCloseTo(49_000, 5);
  });

  it("a stated value scales the WHOLE ladder, not only the rung it was stated at", async () => {
    mockFetch({ outcomes: { meeting_booked: [{ email: "jane@acme.com", valueCents: 4_900_000 }] } });
    // A lead somebody priced at $49k is worth more at every rung than one priced on a $1k average:
    // 49_000 × 30%, not 1_000 × 30%.
    expect(await pipeline()).toBeCloseTo(14_700, 5);
  });

  it("a won deal with no stated amount still falls back to the brand's revenue", async () => {
    mockFetch({ outcomes: { sale: [{ email: "jane@acme.com" }] } });
    expect(await pipeline()).toBeCloseTo(1000, 5);
  });

  // ── A ruled-out step kills its chain ──────────────────────────────────────

  it("a LOST deal is worth nothing — every chain ends at a paying client", async () => {
    mockFetch({
      outcomes: { meeting_booked: [{ email: "jane@acme.com" }] },
      deadByStep: { sale: ["jane@acme.com"] },
    });
    // Not the meeting it once had, and not a lingering fraction of it. The forecast was pointing at a
    // close that has now been ruled out.
    expect(await pipeline()).toBe(0);
  });

  it("a lead that will NEVER book a meeting loses the chain that needs one, and keeps one that does not", async () => {
    const dead = { deadByStep: { meeting_booked: ["jane@acme.com"] } };

    // Sells ONLY through conversations → the reply was a forecast of the meeting now ruled out.
    mockFetch({
      ...dead,
      salesFunnels: [declaredFunnel({ rates: { replyToMeetingPct: 40, meetingToClosePct: 30 } })],
    });
    expect(await pipeline()).toBe(0);

    vi.restoreAllMocks();
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as never);
    // Also sells self-serve on the website → that chain never touches a meeting, so the click it
    // already made is still worth exactly what it was. They may still just buy the thing.
    mockFetch({
      ...dead,
      salesFunnels: [
        declaredFunnel({ rates: { replyToMeetingPct: 40, meetingToClosePct: 30 } }),
        declaredFunnel({
          funnelKey: "website_purchases",
          name: "Website purchases",
          steps: ["Website visit", "Signup", "Paid client"],
          rates: { visitToSignupPct: 20, signupToPaidClientPct: 10 },
        }),
      ],
    });
    // 1000 × orP(visitToClose 2%, visitToMeeting 5% × meetingToClose 30%) = 34.7 — the click alone.
    expect(await pipeline()).toBeCloseTo(34.7, 3);
  });

  it("a step nobody ruled out changes nothing — an empty disqualification set is the state today", async () => {
    mockFetch({ deadByStep: { sale: [], meeting_booked: [] } });
    expect(await pipeline()).toBeCloseTo(150.536, 3);
  });

  // ── The legacy source, and who wins ───────────────────────────────────────

  it("still reads the LEGACY manual qualifications — 4 booked meetings and 4 closed deals live only there", async () => {
    mockFetch({ legacy: { "jane@acme.com": { meetingBookedAt: daysAgo(5) } } });
    // Nobody has restated this meeting yet. Dropping the legacy read would erase it from a live
    // brand's pipeline, which is a worse answer than carrying a second source that empties itself.
    expect(await pipeline()).toBeCloseTo(300, 5);
  });

  it("a STATEMENT wins over the legacy source for the same lead — one truth, not two", async () => {
    mockFetch({
      legacy: { "jane@acme.com": { meetingBookedAt: daysAgo(5) } },
      // The same person, restated one rung further along.
      outcomes: { meeting_attended: [{ email: "jane@acme.com", valueCents: 4_900_000 }] },
    });
    // Priced on attending, at the amount somebody named: 49_000 × 30%. Not the legacy booked rung,
    // and not the two added together.
    expect(await pipeline()).toBeCloseTo(14_700, 5);
  });

  it("a lead ruled out is worth nothing even when the legacy source still shows its meeting", async () => {
    mockFetch({
      legacy: { "jane@acme.com": { meetingBookedAt: daysAgo(5), closedAt: daysAgo(1) } },
      deadByStep: { sale: ["jane@acme.com"] },
    });
    expect(await pipeline()).toBe(0);
  });

  // ── Degradation ───────────────────────────────────────────────────────────

  it("degrades to the forecast alone when the statements cannot be read — never 502s the Overview", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch({ outcomesFail: true });
    expect(await pipeline()).toBeCloseTo(150.536, 3);
    expect(warn.mock.calls.some(([m]) => typeof m === "string" && m.includes("observed step statements failed"))).toBe(true);
  });
});
