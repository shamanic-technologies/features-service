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

/** Nothing observed, so the lead is worth the plain forecast: 1000 × orP(0.0347, 0.12) = 150.536. */
const FORECAST_USD = 150.536;
/** What every stated deal below is worth: $5,000, five times what the brand's average would forecast. */
const DEAL_USD = 5000;

/**
 * FOUR PEOPLE, EACH IN THEIR OWN ORGANISATION so nothing combines, and each one a different sentence
 * about whose win it was:
 *
 *   - `ours`   — a $5,000 deal the customer states OUR outreach caused.
 *   - `theirs` — a $5,000 deal they state something else of theirs caused. A REAL deal.
 *   - `unasked`— a $5,000 deal NOBODY WAS ASKED about, which is almost every deal in the system.
 *   - `legacy` — a closed deal from the LEGACY instantly qualifications, which carries no cause and
 *                never can, so it is `unstated` too.
 *
 * All four also clicked and replied, so every one of them has the same $150.536 forecast to fall back
 * to — which is what makes "the rung AND its value were both left out" checkable to the cent.
 */
const PEOPLE = [
  { email: "ours@a.com", org: "org-a" },
  { email: "theirs@b.com", org: "org-b" },
  { email: "unasked@c.com", org: "org-c" },
  { email: "legacy@d.com", org: "org-d" },
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

function mockFetch(opts: Opts = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/converted-lead-emails")) return json({ event: "", emails: [] });
    if (url.includes("/manual-qualifications")) {
      // The LEGACY half: one closed deal, carrying no cause and never able to carry one.
      return json({
        qualifications: [
          {
            id: "q-legacy",
            orgId: "org-1",
            campaignId: "c1",
            instantlyCampaignId: "ic1",
            email: "legacy@d.com",
            status: "lead_closed",
            qualifiedBy: "u1",
            notes: null,
            qualifiedAt: LEGACY_AT,
          },
        ],
      });
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
        results: PEOPLE.map((p) => ({ email: p.email, firstClickedAt: ENGAGED_AT, firstRepliedAt: ENGAGED_AT })),
      });
    }
    return json({});
  });
}

const read = async (query = ""): Promise<any> => {
  const res = await request(app)
    .get(`/features/sales-cold-email-outreach/revenue?brandId=b1${query}`)
    .set(AUTH);
  expect(res.status).toBe(200);
  return res.body;
};

/**
 * A RETURN ON OUR OUTREACH LEAVES OUT A DEAL THE CUSTOMER SAYS WE DID NOT CAUSE.
 *
 * A brand contacts people through us AND through everything else it already does, so some of the
 * people we email buy for reasons that have nothing to do with us. Until the customer could say so,
 * the value of those deals landed in the same place as the value of the deals we produced and every
 * return reported on our own outreach was too good by however much of it we did not cause.
 *
 * Every case below asserts the DIVERGENCE between two cause sets on the SAME fixture — a suite that
 * only checked "a number came back" would pass on an implementation that ignored the parameter.
 */
describe("a return on our outreach counts the deals the customer says we caused", () => {
  beforeEach(() => {
    vi.mocked(db.query.features.findFirst).mockResolvedValue(SALES_FEATURE as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── The default is every state, and it is today's answer ──────────────────

  it("counts every state when the caller names none — three stated deals plus the legacy one", async () => {
    mockFetch();
    const body = await read();
    // Three $5,000 deals + the legacy close priced at the brand's LTR ($1,000).
    expect(body.headline.totalPipelineUsd).toBeCloseTo(3 * DEAL_USD + 1000, 3);
    expect(body.outcomeCauses.counted).toEqual(["outreach", "other", "unstated"]);
  });

  it("is byte-identical whether the caller omits the parameter or names all three states", async () => {
    mockFetch();
    const silent = await read();
    mockFetch();
    const explicit = await read("&cause=unstated,other,outreach");
    expect(explicit).toEqual(silent);
  });

  // ── Leaving out what the customer says we did not cause ───────────────────

  it("drops a not-ours deal's RUNG AND ITS VALUE, so that lead falls back to exactly the forecast", async () => {
    mockFetch();
    const all = await read();
    mockFetch();
    const narrowed = await read("&cause=outreach,unstated");
    // `theirs` loses its $5,000 and is worth the plain forecast — to the cent, which is what proves
    // the stated amount did not survive to scale the ladder underneath it.
    expect(narrowed.headline.totalPipelineUsd).toBeCloseTo(
      all.headline.totalPipelineUsd - DEAL_USD + FORECAST_USD,
      3,
    );
    expect(narrowed.outcomeCauses.counted).toEqual(["outreach", "unstated"]);
  });

  it("moves the RETURN and the COST OF ACQUISITION with the pipeline, not only the pipeline", async () => {
    mockFetch();
    const all = await read();
    mockFetch();
    const narrowed = await read("&cause=outreach,unstated");
    // $1,000 of committed spend on both reads — the same money, a smaller return.
    expect(narrowed.costEconomics.committedCostUsd).toBe(all.costEconomics.committedCostUsd);
    expect(narrowed.costEconomics.roiMultiple).toBeLessThan(all.costEconomics.roiMultiple);
    expect(narrowed.costEconomics.costOfAcquisitionPct).toBeGreaterThan(all.costEconomics.costOfAcquisitionPct);
    expect(narrowed.costEconomics.costPerAcquisitionUsd).toBeGreaterThan(all.costEconomics.costPerAcquisitionUsd);
  });

  it("counts ONLY what the customer said we caused when asked for that alone", async () => {
    mockFetch();
    const body = await read("&cause=outreach");
    // `ours` keeps its deal; the other three fall back to the forecast — the legacy close with them,
    // because nobody was ever asked about a manual qualification either.
    expect(body.headline.totalPipelineUsd).toBeCloseTo(DEAL_USD + 3 * FORECAST_USD, 3);
  });

  it("counts a NOBODY-WAS-ASKED deal apart from both answers", async () => {
    mockFetch();
    const oursOnly = await read("&cause=outreach");
    mockFetch();
    const oursAndUnasked = await read("&cause=outreach,unstated");
    // Adding `unstated` brings back BOTH the unasked deal and the legacy close, and nothing else.
    expect(oursAndUnasked.headline.totalPipelineUsd).toBeCloseTo(
      oursOnly.headline.totalPipelineUsd - 2 * FORECAST_USD + DEAL_USD + 1000,
      3,
    );
  });

  it("takes the LEGACY qualifications with `unstated`, never with an answer nobody gave", async () => {
    mockFetch();
    const withUnstated = await read("&cause=unstated");
    mockFetch();
    const withoutUnstated = await read("&cause=outreach,other");
    // The legacy close is worth the brand's LTR under `unstated` and the plain forecast without it.
    // `unasked` keeps its $5,000 and the legacy close its $1,000; `ours` and `theirs` fall back.
    expect(withUnstated.headline.totalPipelineUsd).toBeCloseTo(DEAL_USD + 1000 + 2 * FORECAST_USD, 3);
    expect(withoutUnstated.headline.totalPipelineUsd).toBeCloseTo(2 * DEAL_USD + 2 * FORECAST_USD, 3);
  });

  // ── The three states are visible, whatever the read counted ───────────────

  it("states how many outcomes sit in each state, UNFILTERED by what it counted", async () => {
    mockFetch();
    const narrowed = await read("&cause=outreach");
    expect(narrowed.outcomeCauses.counts.outreach.sale).toBe(1);
    // The states this read left OUT are exactly the ones a surface has to be able to explain.
    expect(narrowed.outcomeCauses.counts.other.sale).toBe(1);
    expect(narrowed.outcomeCauses.counts.unstated.sale).toBe(1);
    // A step nobody stated is a measured zero, not a gap.
    expect(narrowed.outcomeCauses.counts.outreach.meeting_booked).toBe(0);
  });

  it("nulls the counts when the statements could not be read, and still states what it counted", async () => {
    mockFetch({ outcomesFail: true });
    const body = await read("&cause=outreach");
    // Null is "we could not count this" — a 0 would say the brand has no outcomes at all.
    expect(body.outcomeCauses.counts).toBeNull();
    expect(body.outcomeCauses.counted).toEqual(["outreach"]);
  });

  it("reads a producer that predates the field as NOBODY WAS ASKED, never as not-ours", async () => {
    mockFetch({ producerPredatesCause: true });
    const body = await read();
    expect(body.outcomeCauses.counts.unstated.sale).toBe(3);
    expect(body.outcomeCauses.counts.other.sale).toBe(0);
    mockFetch({ producerPredatesCause: true });
    // Counting only what the customer stated as ours therefore keeps none of them — which is honest,
    // and the reason the DEFAULT is every state rather than this.
    const oursOnly = await read("&cause=outreach");
    expect(oursOnly.headline.totalPipelineUsd).toBeCloseTo(4 * FORECAST_USD, 3);
  });

  // ── Nothing else on the body moves ────────────────────────────────────────

  it("leaves the volume half and the spend untouched — a deal we did not cause was still outreach we paid for", async () => {
    mockFetch();
    const all = await read();
    mockFetch();
    const narrowed = await read("&cause=outreach");
    expect(narrowed.outcomes).toEqual(all.outcomes);
    expect(narrowed.spend.totalSpentCents).toBe(all.spend.totalSpentCents);
    expect(narrowed.recipientsContacted).toEqual(all.recipientsContacted);
  });

  // ── An unrecognised word is a refusal ─────────────────────────────────────

  it("REFUSES a word it does not know rather than counting some other set", async () => {
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

  // ── Every money grain moved at once ───────────────────────────────────────

  it("states what it counted on the lensed read too, where no figure moves with it", async () => {
    mockFetch();
    const body = await read("&lens=booked-meetings&cause=outreach");
    // A lens prices engagement through declared rates and reads no stated outcome, so a consumer has
    // to be able to SEE that rather than infer it from a missing key.
    expect(body.outcomeCauses.counted).toEqual(["outreach"]);
    expect(body.outcomeCauses.counts).toBeNull();
  });
});
