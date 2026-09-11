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
process.env.OUTLETS_SERVICE_URL = "http://outlets:3000";
process.env.OUTLETS_SERVICE_API_KEY = "outlets-key";
process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.JOURNALISTS_SERVICE_URL = "http://journalists:3000";
process.env.JOURNALISTS_SERVICE_API_KEY = "journalists-key";
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
 * ONE FIXTURE, shaped like the brand that reported it — prod 2026-09-11, brand `c992c378…` /
 * offer `622cb535…` / org `f74660b1…`.
 *
 * The brand-wide effective record is the one brand-service serves for that org: a 0.5% direct
 * self-serve close beside a 3% visit→meeting and a 25% booked→paid. Combined as two independent click
 * routes that is `orP(0.005, 0.03 × 0.25) = 1.24375%`, and on a $30 lifetime revenue a website visit
 * was therefore priced at **$0.373125** — through a BOOKED MEETING, on a funnel that has no meeting
 * step in it. Note 0.5% is exactly 5% × 10% (visit→signup × signup→paid), the composition
 * brand-service's brand-wide close rate already folds in for essentially every brand: that is why the
 * website-purchase funnel must NOT be re-derived from the signup chain, and why it does not move here.
 */
const ECONOMICS = {
  lifetimeRevenueUsd: 30,
  replyToMeetingPct: 40,
  visitToMeetingPct: 3,
  meetingToClosePct: 25,
  visitToSignupPct: 5,
  signupToPaidClientPct: 10,
  visitToClosePct: 0.5,
};

/** What a website visit was worth before this fix, on EVERY funnel: LTR × orP(v2c, v2m·m2c). */
const BRAND_WIDE_VISIT_USD = 30 * (1 - (1 - 0.005) * (1 - 0.03 * 0.25)); // 0.373125

/** The Form Magnet brand's own arrows: 25% visit→form, 20% form→paid ⇒ a visit is 5% of $30 = $1.50. */
const FORM_VISIT_USD = 30 * 0.25 * 0.2; // 1.50
const FORM_FILLED_USD = 30 * 0.2; // 6.00

/** 47 website visits, one organisation each — the count the reported brand's funnel page states. */
const VISIT_COUNT = 47;
const SPEND_CENTS = 5734; // $57.34 committed, the same read's spend

const arrow = (fromStep: string, toStep: string, ratePct: number | null): Record<string, unknown> => ({
  fromStep,
  toStep,
  ratePct,
  provenance: ratePct === null ? "unstated" : "stated_arrow",
  rateKey: null,
});

const declaredFunnel = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  funnelKey: "form_magnet",
  active: true,
  name: "Form Magnet",
  steps: ["Website visit", "Form filled", "Paid client"],
  rates: {},
  arrows: [arrow("Website visit", "Form filled", 25), arrow("Form filled", "Paid client", 20)],
  lifetimeRevenueUsd: 30,
  destinationUrl: null,
  bookingUrl: null,
  updatedAt: "2026-09-01T00:00:00Z",
  ...over,
});

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

/** One clicked lead per organisation — a website visit nobody has taken further. */
const visitors = (n: number): Array<Record<string, unknown>> =>
  Array.from({ length: n }, (_, i) =>
    leadRow({
      leadId: `l${i}`,
      email: `v${i}@x.com`,
      clicked: true,
      lead: { firstName: "V", lastName: `${i}`, photoUrl: null, organization: { id: `o${i}`, name: `Org${i}`, logoUrl: null } },
    }),
  );

function costGroups(cents: number): string {
  return JSON.stringify({
    groups: [
      {
        dimensions: {},
        totalCostInUsdCents: String(cents),
        actualCostInUsdCents: String(cents),
        runCount: 0,
        minStartedAt: null,
        maxStartedAt: null,
      },
    ],
  });
}

function mockFetch(opts: {
  economics?: unknown;
  leads?: unknown[];
  salesFunnels?: unknown[];
  costCents?: number;
  formSubmissionEmails?: string[];
} = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/converted-lead-emails")) {
      const event = url.includes("event=form_submission") ? "form_submission" : "signup";
      return json({ event, emails: event === "form_submission" ? (opts.formSubmissionEmails ?? []) : [] });
    }
    if (url.includes("/conversion-counts")) return new Response("not deployed", { status: 500 });
    if (url.includes("groupBy=day")) return json({ groups: [] });
    if (url.includes("/costs/timeseries")) return new Response("boom", { status: 500 });
    if (url.includes("/stats/costs")) {
      return new Response(costGroups(opts.costCents ?? SPEND_CENTS), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/sales-funnels")) {
      if (!opts.salesFunnels) return new Response("no declaration", { status: 404 });
      return json({ funnels: opts.salesFunnels });
    }
    if (url.includes("/sales-economics-effective")) {
      return json(opts.economics != null ? { economics: opts.economics, source: "user" } : { economics: null, source: null });
    }
    if (url.includes("/public/stats")) return json({ broadcast: { recipientStats: {} } });
    if (url.includes("/manual-qualifications")) return json({ qualifications: [] });
    if (url.includes("/converted-leads")) return json({ event: "", outcomes: [] });
    if (url.includes("/step-disqualifications")) return json({ counts: {}, byStep: {} });
    if (url.includes("/step-costs")) return new Response("boom", { status: 500 });
    if (url.includes("/orgs/leads")) return json({ leads: opts.leads ?? [] });
    if (url.includes("/orgs/status")) return json({ statuses: [] });
    return json({});
  });
}

const read = async (query = ""): Promise<request.Response> =>
  request(app).get(`/features/sales-cold-email-outreach/revenue?leads=full&brandId=b1${query}`).set(AUTH);

describe("a funnel is priced on the rates IT declares, not on a route it does not contain", () => {
  beforeEach(() => {
    (db.query.features.findFirst as any).mockResolvedValue(SALES_FEATURE);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prices a Form Magnet visit on the funnel's OWN two arrows — and DIVERGES from the meeting route it was priced through", async () => {
    mockFetch({ economics: ECONOMICS, leads: visitors(VISIT_COUNT), salesFunnels: [declaredFunnel()] });
    const res = await read();
    expect(res.status).toBe(200);

    // 47 visits × $1.50 = $70.50 — the brand's own 25% × 20% against its own $30.
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(VISIT_COUNT * FORM_VISIT_USD, 5);
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(70.5, 5);
    // The divergence: the same fixture priced through the brand-wide meeting route reads a QUARTER of
    // that. A suite asserting only "a number came back" would pass on the implementation this replaces.
    expect(res.body.headline.totalPipelineUsd).not.toBeCloseTo(VISIT_COUNT * BRAND_WIDE_VISIT_USD, 2);

    // $70.50 expected pipeline over $57.34 committed = 1.229x, and a paying client costs $24.40.
    expect(res.body.costEconomics.committedCostUsd).toBeCloseTo(SPEND_CENTS / 100, 5);
    expect(res.body.costEconomics.roiMultiple).toBeCloseTo(1.2295, 3);
    expect(res.body.costEconomics.costPerAcquisitionUsd).toBeCloseTo(24.4, 1);

    // Per lead, to the cent.
    expect(res.body.leads[0].expectedRevenueUsd).toBeCloseTo(FORM_VISIT_USD, 5);
  });

  it("the same fixture with NO declaration still reads the OLD number — the move is the funnel's, not the engine's", async () => {
    mockFetch({ economics: ECONOMICS, leads: visitors(VISIT_COUNT) });
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(VISIT_COUNT * BRAND_WIDE_VISIT_USD, 5);
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(17.572125, 5);
  });

  it("a lead that FILLED THE FORM is worth strictly more than one that only visited, and strictly less than one that paid", async () => {
    const leads = [
      leadRow({ leadId: "lv", email: "visit@x.com", clicked: true, lead: { firstName: "V", lastName: "V", photoUrl: null, organization: { id: "ov", name: "OrgV", logoUrl: null } } }),
      leadRow({ leadId: "lf", email: "form@x.com", clicked: true, lead: { firstName: "F", lastName: "F", photoUrl: null, organization: { id: "of", name: "OrgF", logoUrl: null } } }),
    ];
    mockFetch({
      economics: ECONOMICS,
      leads,
      salesFunnels: [declaredFunnel()],
      formSubmissionEmails: ["form@x.com"],
    });
    const res = await read();
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.leads.map((l: any) => [l.leadId, l]));

    expect(byId.lv.expectedRevenueUsd).toBeCloseTo(FORM_VISIT_USD, 5); // 1.50
    expect(byId.lf.expectedRevenueUsd).toBeCloseTo(FORM_FILLED_USD, 5); // 6.00 — the rung's own rate
    expect(byId.lf.expectedRevenueUsd).toBeGreaterThan(byId.lv.expectedRevenueUsd);
    expect(byId.lf.expectedRevenueUsd).toBeLessThan(ECONOMICS.lifetimeRevenueUsd);
    // The form is an OBSERVED POSITION: it EXTINGUISHES the click that was forecasting it, rather than
    // combining with it. 6.00, never orP(1.50, 6.00).
    expect(byId.lf.expectedRevenueUsd).toBeLessThan(FORM_VISIT_USD + FORM_FILLED_USD);
    expect(byId.lf.tags).toContain("formFilled");
  });

  it("a rate the brand never declared stays ABSENT — the rung prices at nothing, never at 0%-as-a-number and never a substitute", async () => {
    // No arrows, no named form rates, and the brand-wide record carries none either: there is nothing
    // this funnel can be priced from, so it prices at nothing rather than borrowing the meeting route.
    mockFetch({
      economics: ECONOMICS,
      leads: visitors(VISIT_COUNT),
      salesFunnels: [declaredFunnel({ arrows: [], rates: {} })],
    });
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBe(0);
    expect(res.body.headline.totalPipelineUsd).not.toBeCloseTo(VISIT_COUNT * BRAND_WIDE_VISIT_USD, 2);
  });

  it("a leg whose LAST arrow is unstated is unpriceable — half a chain is not a rate", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: visitors(1),
      salesFunnels: [
        declaredFunnel({ arrows: [arrow("Website visit", "Form filled", 25), arrow("Form filled", "Paid client", null)] }),
      ],
    });
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBe(0);
  });
});

describe("REGRESSION — the other three funnel keys are unchanged, to the cent", () => {
  beforeEach(() => {
    (db.query.features.findFirst as any).mockResolvedValue(SALES_FEATURE);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("website_purchases keeps the meeting route in its visit, even when its signup chain equals the brand-wide close rate", async () => {
    // The prod shape for 100 brands: visit→signup 5% × signup→paid 10% = 0.5% = the brand-wide
    // visitToClosePct, already folded in. Re-deriving the visit from that chain would DROP the meeting
    // route those brands genuinely sell through — so the visit stays orP(v2c, v2m·m2c).
    mockFetch({
      economics: ECONOMICS,
      leads: visitors(VISIT_COUNT),
      salesFunnels: [
        declaredFunnel({
          funnelKey: "website_purchases",
          name: "Website purchases",
          steps: ["Website visit", "Signup", "Paid client"],
          arrows: [arrow("Website visit", "Signup", 5), arrow("Signup", "Paid client", 10)],
          lifetimeRevenueUsd: null,
        }),
      ],
    });
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(VISIT_COUNT * BRAND_WIDE_VISIT_USD, 5);
    // NOT the signup chain alone (47 × 30 × 0.005 = $7.05), which is what dropping the route would give.
    expect(res.body.headline.totalPipelineUsd).not.toBeCloseTo(VISIT_COUNT * 30 * 0.005, 2);
    expect(res.body.leads[0].expectedRevenueUsd).toBeCloseTo(BRAND_WIDE_VISIT_USD, 5);
  });

  it("sales_meetings_from_website keeps its visit on the identical expression", async () => {
    mockFetch({
      economics: ECONOMICS,
      leads: visitors(VISIT_COUNT),
      salesFunnels: [
        declaredFunnel({
          funnelKey: "sales_meetings_from_website",
          name: "Meetings from the website",
          steps: ["Website visit", "Meeting booked", "Meeting attended", "Paid client"],
          arrows: [],
          lifetimeRevenueUsd: null,
        }),
      ],
    });
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(VISIT_COUNT * BRAND_WIDE_VISIT_USD, 5);
  });

  it("sales_meetings_from_conversation keeps reply / booked / attended on the identical expressions", async () => {
    const leads = [
      leadRow({ leadId: "lr", email: "r@x.com", replied: true, replyClassification: "positive", lead: { firstName: "R", lastName: "R", photoUrl: null, organization: { id: "or", name: "OrgR", logoUrl: null } } }),
    ];
    mockFetch({
      economics: ECONOMICS,
      leads,
      salesFunnels: [
        declaredFunnel({
          funnelKey: "sales_meetings_from_conversation",
          name: "Meetings from conversations",
          steps: ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"],
          arrows: [],
          lifetimeRevenueUsd: null,
        }),
      ],
    });
    const res = await read();
    expect(res.status).toBe(200);
    // replyToMeeting 40% × booked→paid 25% = 10% of $30 = $3.00, byte-identical to before.
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(30 * 0.4 * 0.25, 5);
  });

  it("a brand declaring form_magnet BESIDE a meeting funnel: `?funnel=` gives each its own terms, and the meeting funnel is unmoved", async () => {
    // A brand declaring SEVERAL funnels resolves ONE set of terms for the read — the funnel it NAMED,
    // else the first in catalogue order (here the meeting funnel). That is unchanged, deliberately: a
    // read is priced on the terms it resolved, and narrowing it with `?funnel=` is how a customer asks
    // for one funnel's own answer. The two reads below are the same fixture, two questions.
    const funnels = [
      declaredFunnel(),
      declaredFunnel({
        funnelKey: "sales_meetings_from_website",
        name: "Meetings from the website",
        steps: ["Website visit", "Meeting booked", "Meeting attended", "Paid client"],
        arrows: [],
        lifetimeRevenueUsd: null,
      }),
    ];
    mockFetch({ economics: ECONOMICS, leads: visitors(1), salesFunnels: funnels });
    const unqualified = await read();
    expect(unqualified.status).toBe(200);
    // The meeting funnel's own expression, to the cent — unmoved by the form funnel beside it.
    expect(unqualified.body.headline.totalPipelineUsd).toBeCloseTo(BRAND_WIDE_VISIT_USD, 5);

    mockFetch({ economics: ECONOMICS, leads: visitors(1), salesFunnels: funnels });
    const named = await read("&funnel=form_magnet");
    expect(named.status).toBe(200);
    expect(named.body.headline.totalPipelineUsd).toBeCloseTo(FORM_VISIT_USD, 5);
    expect(named.body.headline.totalPipelineUsd).not.toBeCloseTo(BRAND_WIDE_VISIT_USD, 2);
  });
});
