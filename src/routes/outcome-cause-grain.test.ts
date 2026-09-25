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

/** The same economics the observed-step suite prices with, so a forecast lead is worth $150.536. */
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
/** Frozen at module load: two reads of the SAME fixture must be comparable byte for byte. */
const CLOSED_AT = daysAgo(2);
const LEGACY_AT = daysAgo(3);
const ENGAGED_AT = daysAgo(20);
/** Our first email reached every person here 30 days ago. */
const DELIVERED_AT = daysAgo(30);
/** A legacy close that happened BEFORE our first email reached that person. */
const EARLY_LEGACY_AT = daysAgo(40);

/** Nothing observed, so the lead is worth the plain forecast: 1000 × orP(0.0347, 0.12) = 150.536. */
const FORECAST_USD = 150.536;
/** What every stated deal below is worth: $5,000, five times what the brand's average would forecast. */
const DEAL_USD = 5000;

/**
 * FIVE PEOPLE, EACH IN THEIR OWN ORGANISATION so nothing combines, and each one a different answer to
 * whose win it was:
 *
 *   - `ours`    — a $5,000 deal the customer (or lead-service's date rule) says OUR outreach caused.
 *   - `theirs`  — a $5,000 deal that was not ours. A REAL deal.
 *   - `unasked` — a $5,000 deal nobody could decide (undated / unmatched / never delivered).
 *   - `legacy`  — a LEGACY instantly close dated AFTER our first email reached them → ours by the rule.
 *   - `early`   — a LEGACY instantly close dated BEFORE our first email reached them → not ours.
 *
 * All five also clicked and replied, so every one of them has the same $150.536 forecast to fall back
 * to — which is what makes "the value was left out while the deal is still counted" checkable to the cent.
 */
const PEOPLE = [
  { email: "ours@a.com", org: "org-a" },
  { email: "theirs@b.com", org: "org-b" },
  { email: "unasked@c.com", org: "org-c" },
  { email: "legacy@d.com", org: "org-d" },
  { email: "early@e.com", org: "org-e" },
];

function leadRow(email: string, org: string): Record<string, unknown> {
  return {
    leadId: `lead-${email}`,
    email,
    contacted: true,
    sent: true,
    delivered: true,
    clicked: true,
    bounced: false,
    unsubscribed: false,
    replied: true,
    replyClassification: "positive",
    lead: { firstName: "A", lastName: "B", photoUrl: null, organization: { id: org, name: org, logoUrl: null } },
  };
}

interface Opts {
  /** Omit the `causedByOutreach` key entirely — a producer that predates lead-service#511. */
  producerPredatesCause?: boolean;
  /** The statements read degrades, so the read cannot say what exists. */
  outcomesFail?: boolean;
}

const legacyClose = (email: string, at: string) => ({
  id: `q-${email}`,
  orgId: "org-1",
  campaignId: "c1",
  instantlyCampaignId: "ic1",
  email,
  status: "lead_closed",
  qualifiedBy: "u1",
  notes: null,
  qualifiedAt: at,
});

function mockFetch(opts: Opts = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/converted-lead-emails")) return json({ event: "", emails: [] });
    if (url.includes("/manual-qualifications")) {
      // The LEGACY half: two closes carrying no cause, judged by the same date rule lead-service uses.
      return json({ qualifications: [legacyClose("legacy@d.com", LEGACY_AT), legacyClose("early@e.com", EARLY_LEGACY_AT)] });
    }
    if (url.includes("/converted-leads")) {
      if (opts.outcomesFail) return new Response("boom", { status: 502 });
      const event = new URL(url, "http://x").searchParams.get("event") ?? "";
      if (event !== "sale") return json({ event, outcomes: [] });
      const rows = [
        { email: "ours@a.com", cause: true },
        { email: "theirs@b.com", cause: false },
        { email: "unasked@c.com", cause: null },
      ].map((o, i) => {
        const row: Record<string, unknown> = {
          leadId: `sale-${i}`,
          email: o.email,
          campaignId: "c1",
          occurredAt: CLOSED_AT,
          valueCents: DEAL_USD * 100,
          source: "manual",
        };
        if (!opts.producerPredatesCause) row.causedByOutreach = o.cause;
        return row;
      });
      return json({ event, outcomes: rows });
    }
    if (url.includes("/step-disqualifications")) return json({ counts: {}, byStep: {} });
    if (url.includes("/conversion-counts")) {
      return json({ counts: { signup: 0, meeting_booked: 0, form_submission: 0, sale: 3 } });
    }
    if (url.includes("/stats/costs")) {
      return json({
        groups: [
          {
            dimensions: {},
            totalCostInUsdCents: "100000",
            actualCostInUsdCents: "100000",
            runCount: 1,
            minStartedAt: null,
            maxStartedAt: null,
          },
        ],
      });
    }
    // The brand declares nothing, so every leg is priced — the same baseline the sibling suite uses.
    if (url.includes("/sales-funnels")) return new Response("no declaration", { status: 404 });
    if (url.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (url.includes("/public/stats")) return json(PLATFORM_STATS);
    if (url.includes("/orgs/leads")) return json({ leads: PEOPLE.map((p) => leadRow(p.email, p.org)) });
    if (url.includes("/orgs/status")) {
      return json({
        results: PEOPLE.map((p) => ({
          email: p.email,
          broadcast: { brand: { firstDeliveredAt: DELIVERED_AT, firstClickedAt: ENGAGED_AT, firstRepliedAt: ENGAGED_AT } },
        })),
      });
    }
    return json({});
  });
}

const read = async (query = ""): Promise<any> => {
  const res = await request(app)
    .get(`/features/sales-cold-email-outreach/revenue?brandId=b1&leads=full${query}`)
    .set(AUTH);
  expect(res.status).toBe(200);
  return res.body;
};

const purchasedCount = (body: any): number => body.leads.filter((l: any) => l.purchased).length;

/**
 * THE ROI OF OUR SERVICE COUNTS WHAT WE GENERATED; THE CONVERSIONS COUNT EVERYTHING.
 *
 * A brand contacts people through us AND through everything else it already does, so some of the
 * people we email buy for reasons that have nothing to do with us — and their CRM, merged into our
 * lead statuses, reports those deals too. Owner, 2026-09-25: every deal is a conversion the brand sees,
 * but only a deal we caused is value on OUR outreach. `?cause=` therefore names what is PRICED
 * (default `outreach`, what the lead panel calls "Ours"), and every state is always COUNTED.
 *
 * Every case asserts a DIVERGENCE on the SAME fixture — a suite that only checked "a number came back"
 * would pass on the implementation this replaces, which priced every state by default.
 */
describe("the return on our outreach prices only our wins, and every deal is still counted", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── The default prices what the lead panel calls "Ours" ───────────────────

  it("prices only OUR wins when the caller names none — the stated one and the legacy one after our email", async () => {
    mockFetch();
    const body = await read();
    // ours $5,000 + legacy close after our email at the brand's LTR ($1,000); the other three fall
    // back to the forecast their clicks and replies earn.
    expect(body.headline.totalPipelineUsd).toBeCloseTo(DEAL_USD + 1000 + 3 * FORECAST_USD, 3);
    expect(body.outcomeCauses.priced).toEqual(["outreach"]);
  });

  it("still COUNTS every deal, whether or not it was ours", async () => {
    mockFetch();
    const body = await read();
    // Five closed deals on the brand's leads: none of them disappears from what the brand sees.
    expect(purchasedCount(body)).toBe(5);
    const theirs = body.leads.find((l: any) => l.leadId === "lead-theirs@b.com");
    expect(theirs.purchased).toBe(true);
    // …and it is worth exactly the forecast, to the cent: its $5,000 did not survive to scale the
    // ladder underneath it.
    expect(theirs.expectedRevenueUsd).toBeCloseTo(FORECAST_USD, 3);
  });

  it("is byte-identical whether the caller omits the parameter or names outreach alone", async () => {
    mockFetch();
    const silent = await read();
    mockFetch();
    const explicit = await read("&cause=outreach");
    expect(explicit).toEqual(silent);
  });

  it("judges a LEGACY close by the delivery date rule — before our first email is not ours", async () => {
    mockFetch();
    const body = await read();
    const legacy = body.leads.find((l: any) => l.leadId === "lead-legacy@d.com");
    const early = body.leads.find((l: any) => l.leadId === "lead-early@e.com");
    expect(legacy.purchased).toBe(true);
    expect(early.purchased).toBe(true);
    expect(legacy.expectedRevenueUsd).toBeCloseTo(1000, 3);
    expect(early.expectedRevenueUsd).toBeCloseTo(FORECAST_USD, 3);
  });

  // ── Naming more states prices more ─────────────────────────────────────────

  it("prices every state when the caller names all three — the old default, still reachable", async () => {
    mockFetch();
    const all = await read("&cause=outreach,other,unstated");
    expect(all.headline.totalPipelineUsd).toBeCloseTo(3 * DEAL_USD + 2 * 1000, 3);
    expect(all.outcomeCauses.priced).toEqual(["outreach", "other", "unstated"]);
    // Pricing more never counts more: the conversions were already all there.
    mockFetch();
    expect(purchasedCount(all)).toBe(purchasedCount(await read()));
  });

  it("moves the RETURN and the COST OF ACQUISITION with the pipeline, never the spend", async () => {
    mockFetch();
    const all = await read("&cause=outreach,other,unstated");
    mockFetch();
    const ours = await read();
    expect(ours.costEconomics.committedCostUsd).toBe(all.costEconomics.committedCostUsd);
    expect(ours.costEconomics.roiMultiple).toBeLessThan(all.costEconomics.roiMultiple);
    expect(ours.costEconomics.costOfAcquisitionPct).toBeGreaterThan(all.costEconomics.costOfAcquisitionPct);
    expect(ours.costEconomics.costPerAcquisitionUsd).toBeGreaterThan(all.costEconomics.costPerAcquisitionUsd);
  });

  it("prices an UNDECIDED deal only when the caller names `unstated`", async () => {
    mockFetch();
    const ours = await read();
    mockFetch();
    const withUndecided = await read("&cause=outreach,unstated");
    expect(withUndecided.headline.totalPipelineUsd).toBeCloseTo(
      ours.headline.totalPipelineUsd - FORECAST_USD + DEAL_USD,
      3,
    );
  });

  // ── The three states are visible, whatever the read priced ─────────────────

  it("states how many outcomes sit in each state, UNFILTERED by what it priced", async () => {
    mockFetch();
    const body = await read();
    expect(body.outcomeCauses.counts.outreach.sale).toBe(1);
    expect(body.outcomeCauses.counts.other.sale).toBe(1);
    expect(body.outcomeCauses.counts.unstated.sale).toBe(1);
    expect(body.outcomeCauses.counts.outreach.meeting_booked).toBe(0);
  });

  it("nulls the counts when the statements could not be read, and still states what it priced", async () => {
    mockFetch({ outcomesFail: true });
    const body = await read();
    expect(body.outcomeCauses.counts).toBeNull();
    expect(body.outcomeCauses.priced).toEqual(["outreach"]);
  });

  it("reads a producer that predates the field as UNDECIDED, never as ours", async () => {
    mockFetch({ producerPredatesCause: true });
    const body = await read();
    expect(body.outcomeCauses.counts.unstated.sale).toBe(3);
    expect(body.outcomeCauses.counts.other.sale).toBe(0);
    // None of the three stated deals is priced; the legacy close after our email still is.
    expect(body.headline.totalPipelineUsd).toBeCloseTo(1000 + 4 * FORECAST_USD, 3);
    expect(purchasedCount(body)).toBe(5);
  });

  // ── Nothing else on the body moves ────────────────────────────────────────

  it("leaves the volume half and the spend untouched — a deal we did not cause was still outreach we paid for", async () => {
    mockFetch();
    const all = await read("&cause=outreach,other,unstated");
    mockFetch();
    const ours = await read();
    expect(ours.outcomes).toEqual(all.outcomes);
    expect(ours.spend.totalSpentCents).toBe(all.spend.totalSpentCents);
    expect(ours.recipientsContacted).toEqual(all.recipientsContacted);
  });

  // ── An unrecognised word is a refusal ─────────────────────────────────────

  it("REFUSES a word it does not know rather than pricing some other set", async () => {
    mockFetch();
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&cause=ours")
      .set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("cause_unrecognised");
  });

  it("REFUSES the tracker's vocabulary, which answers a different question", async () => {
    mockFetch();
    const res = await request(app)
      .get("/features/sales-cold-email-outreach/revenue?brandId=b1&cause=attributed")
      .set(AUTH);
    expect(res.status).toBe(400);
  });

  it("states what it priced on the lensed read too, where no figure moves with it", async () => {
    mockFetch();
    const body = await read("&lens=booked-meetings&cause=outreach");
    expect(body.outcomeCauses.priced).toEqual(["outreach"]);
    expect(body.outcomeCauses.counts).toBeNull();
  });
});
