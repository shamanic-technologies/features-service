/**
 * A `/revenue` READ ANSWERS ABOUT MONEY — `?leads=` decides how much of a person rides along.
 *
 * ONE downstream fixture shaped like the campaign that reported this (features-service#873): ten
 * contacted leads, of which exactly THREE reached something (a click, a positive reply, a stated
 * booked meeting) and seven reached nothing at all. Every case asserts the DIVERGENCE between the two
 * answers — a suite that only checked "an array came back" would pass on an implementation that
 * ignored the parameter entirely.
 *
 * What it pins:
 *   - the DEFAULT read carries only the twelve fields a browser can read, on the rows that reached
 *     something — and its body is dominated by the money rather than by the people;
 *   - `?leads=full` still carries every contacted lead, fully hydrated: the digest's read is unchanged
 *     by this parameter existing, which is what makes the default flip safe to sequence;
 *   - a row that reached NOTHING is dropped rather than narrowed (a `false` flag is "measured, did not
 *     happen", which no consumer acts on);
 *   - `attributedOutcomes` answers "is this outcome attributed at all" WITHOUT the array — so a brand
 *     whose tracker is live and whose signups are still zero keeps its surface;
 *   - and it tells that apart from a DEGRADED producer, which drops the outcome from the list;
 *   - every money grain — the brand, the offer, the offer × funnel and the channel — narrows the same
 *     way, because a grain left behind reproduces the bug one click away;
 *   - an unrecognised word is a 400, never a silent pick.
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

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" };
const PITCH = "sales-cold-email-outreach";
const BRAND = "b1";
const OFFER = "offer-a";
const CONVERSATION = "sales_meetings_from_conversation";

const FEATURE_ROW = (slug: string) => ({
  id: `feat-${slug}`, slug, name: slug, description: "x", status: "active",
  outputs: [], charts: [], entities: [],
  createdAt: new Date(), updatedAt: new Date(),
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

const DECLARED = [
  {
    funnelKey: CONVERSATION,
    name: CONVERSATION,
    steps: ["Positive reply", "Meeting booked", "Meeting attended", "Paid client"],
    rates: { replyToMeetingPct: 40, meetingBookedToAttendedPct: 50, meetingToClosePct: 60 },
    lifetimeRevenueUsd: 1000,
    destinationUrl: null,
    bookingUrl: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

const emailOf = (leadId: string) => `${leadId}@x.com`;

function lead(leadId: string, signal: "reply" | "click" | "none"): Record<string, unknown> {
  return {
    leadId,
    campaignId: "c1",
    workflowSlug: "dawn-v1",
    email: emailOf(leadId),
    contacted: true,
    sent: true,
    delivered: true,
    clicked: signal === "click",
    bounced: false,
    unsubscribed: false,
    replied: signal === "reply",
    replyClassification: signal === "reply" ? "positive" : null,
    lead: {
      firstName: "Ada",
      lastName: "Lovelace",
      photoUrl: "https://photo/x.png",
      title: "CTO",
      seniority: "c_suite",
      organization: {
        id: `org-${leadId}`,
        name: `Org ${leadId}`,
        logoUrl: "https://logo/x.png",
        primaryDomain: "acme.com",
        industry: "software",
        estimatedNumEmployees: 42,
        city: "Paris",
        country: "France",
      },
    },
  };
}

/** The three people who reached something, and the seven who did not. */
const CLICKED = "reached-click";
const REPLIED = "reached-reply";
const BOOKED = "reached-booked";
const REACHED_NOTHING = ["q1", "q2", "q3", "q4", "q5", "q6", "q7"];

const LEADS = [
  lead(CLICKED, "click"),
  lead(REPLIED, "reply"),
  lead(BOOKED, "reply"),
  ...REACHED_NOTHING.map((id) => lead(id, "none")),
];

interface Degraded {
  /** the human's step statements are unreadable */
  stated?: boolean;
  /** the legacy instantly qualifications are unreadable */
  legacy?: boolean;
  /** the matched-lead email sets are unreadable */
  converted?: boolean;
}

function mockFetch(degraded: Degraded = {}): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const url = new URL(raw);
    const path = url.pathname;
    const q = url.searchParams;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (path.endsWith("/campaigns")) {
      return json({
        campaigns: [{
          id: "c1", orgId: "org-1", brandId: BRAND, featureSlug: PITCH,
          funnelKey: CONVERSATION, acquisitionChannel: PITCH, offerId: OFFER,
          status: "ongoing", createdAt: "2026-01-01T00:00:00.000Z",
        }],
      });
    }
    if (path.includes("/sales-funnels")) return json({ funnels: DECLARED });
    if (path.includes("/costs/timeseries")) {
      return json({ buckets: [{ period: "2026-01-02", totalCostInUsdCents: "12000" }] });
    }
    if (path.includes("/public/workflows")) return json({ workflows: [] });
    if (path.includes("/public/costs")) return json({ groups: [] });
    if (path.includes("/public/stats")) return json({});
    if (path.includes("/stats/costs")) {
      return json({
        groups: [{
          dimensions: { campaignId: "c1", workflowSlug: "dawn-v1" },
          totalCostInUsdCents: "12000", actualCostInUsdCents: "12000",
          runCount: 1, minStartedAt: null, maxStartedAt: null,
        }],
      });
    }
    if (path.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });
    if (path.endsWith("/orgs/leads")) return json({ leads: LEADS });

    if (path.includes("/converted-lead-emails")) {
      if (degraded.converted) return new Response("boom", { status: 502 });
      // NOBODY has signed up — the tracker is live and its answer is an empty set. That is precisely
      // the case a consumer must not read as "signup is not attributed".
      return json({ event: q.get("event"), emails: [] });
    }
    if (path.includes("/converted-leads")) {
      if (degraded.stated) return new Response("boom", { status: 502 });
      const event = q.get("event");
      return json({
        outcomes: event === "meeting_booked"
          ? [{ leadId: BOOKED, email: emailOf(BOOKED), campaignId: null, occurredAt: "2026-01-03T00:00:00.000Z", valueCents: null, source: "manual" }]
          : [],
      });
    }
    if (path.includes("/manual-qualifications")) {
      if (degraded.legacy) return new Response("boom", { status: 502 });
      return json({ qualifications: [] });
    }
    if (path.includes("/step-costs")) return json({ brandId: BRAND, costs: [] });
    if (path.includes("/step-disqualifications")) return json({ byStep: {} });
    if (path.includes("/conversion-counts")) return json({ counts: { signup: 0, meeting_booked: 0, form_submission: 0, sale: 0 } });
    if (path.endsWith("/orgs/status")) return json({ results: [] });
    if (path.includes("/members")) return json({ members: [] });
    if (path.includes("/audiences")) return json({ audiences: [] });
    if (path.includes("/conversions")) return json({ conversions: [], counts: {} });
    if (path.includes("daily-budget")) return json({ dailyBudgetCents: 5000 });
    if (path.endsWith("/orgs/stats")) return json({ groups: [] });
    return json({});
  });
}

const withFeatures = () => {
  vi.mocked(db.query.features.findFirst).mockImplementation(
    (async (args: { where: unknown }) => FEATURE_ROW(String((args as never as { where: { right?: string } }).where?.right ?? PITCH))) as never,
  );
};

/** The twelve fields — and NOTHING else — a narrowed row carries. */
const NARROW_KEYS = [
  "leadId",
  "clicked", "repliedPositive", "meetingBooked", "meetingAttended", "signup", "formSubmission", "purchased",
  "signupAt", "meetingBookedAt", "formSubmissionAt", "purchasedAt",
].sort();

const feature = (query = "") => request(app).get(`/features/${PITCH}/revenue?brandId=${BRAND}${query}`).set(AUTH);
const brand = (query = "") => request(app).get(`/brands/${BRAND}/revenue${query}`).set(AUTH);
const offer = (query = "") => request(app).get(`/offers/${OFFER}/revenue?brandId=${BRAND}${query}`).set(AUTH);
const offerFunnel = (query = "") =>
  request(app).get(`/offers/${OFFER}/funnels/${CONVERSATION}/revenue?brandId=${BRAND}${query}`).set(AUTH);

describe("a revenue read answers about money — ?leads= decides how much of a person rides along", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withFeatures();
    mockFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("DEFAULT: carries only the people who reached something, with only the twelve fields", async () => {
    const res = await feature();
    expect(res.status).toBe(200);

    const ids = res.body.leads.map((l: { leadId: string }) => l.leadId).sort();
    expect(ids).toEqual([BOOKED, CLICKED, REPLIED].sort());
    for (const row of res.body.leads) {
      expect(Object.keys(row).sort()).toEqual(NARROW_KEYS);
    }
    // The seven who reached nothing are DROPPED, not narrowed: a false flag is "measured, did not
    // happen", which both browser consumers look up and find absent either way.
    for (const id of REACHED_NOTHING) expect(ids).not.toContain(id);
  });

  it("DEFAULT: the body is dominated by the MONEY, not by the people — and `full` is not", async () => {
    const lean = await feature();
    const full = await feature("&leads=full");
    expect(full.status).toBe(200);

    const bytes = (body: unknown) => Buffer.byteLength(JSON.stringify(body));
    const leanLeads = bytes(lean.body.leads);
    const fullLeads = bytes(full.body.leads);

    // The whole point, stated as an inequality rather than a fixed number: on the default read the
    // people are a MINORITY of the payload, and on the hydrated one they are the payload.
    expect(leanLeads).toBeLessThan(bytes(lean.body) / 2);
    expect(fullLeads).toBeGreaterThan(bytes(full.body) / 2);
    expect(leanLeads).toBeLessThan(fullLeads / 5);
  });

  it("`full` still carries every contacted lead, fully hydrated — the digest's read is unchanged", async () => {
    const res = await feature("&leads=full");
    expect(res.body.leads).toHaveLength(LEADS.length);
    const row = res.body.leads.find((l: { leadId: string }) => l.leadId === BOOKED);
    // The fields the digest NAMES a person with. Absent on a narrowed row, which is why an
    // unconverted digest fails its own schema loudly instead of reporting "nothing landed".
    for (const key of ["firstName", "lastName", "photoUrl", "orgName", "orgLogoUrl", "orgDomain", "tags", "expectedRevenueUsd", "date"]) {
      expect(row).toHaveProperty(key);
    }
    // …and the same money above it, either way.
    const lean = await feature();
    expect(lean.body.headline).toEqual(res.body.headline);
    expect(lean.body.costEconomics).toEqual(res.body.costEconomics);
    expect(lean.body.outcomes).toEqual(res.body.outcomes);
    expect(lean.body.funnelSteps).toEqual(res.body.funnelSteps);
    expect(lean.body.recipientsContacted).toEqual(res.body.recipientsContacted);
  });

  it("states WHICH outcomes it attributes — including one nobody has reached yet", async () => {
    const res = await feature();
    // The tracker answered with an EMPTY set: signups are attributed, nobody has signed up. A
    // consumer deriving this from the array would read the empty answer as "not attributed".
    expect(res.body.attributedOutcomes).toEqual([
      "clicked", "repliedPositive", "meetingBooked", "meetingAttended", "signup", "formSubmission", "purchased",
    ]);
    expect(res.body.leads.some((l: { signup: boolean }) => l.signup)).toBe(false);
    // Same statement whichever detail was asked for — it is a fact about the READ.
    const full = await feature("&leads=full");
    expect(full.body.attributedOutcomes).toEqual(res.body.attributedOutcomes);
  });

  it("a DEGRADED producer drops its outcomes from the list — distinguishable from zero reached", async () => {
    vi.restoreAllMocks();
    withFeatures();
    mockFetch({ stated: true, legacy: true, converted: true });

    const res = await feature();
    expect(res.status).toBe(200);
    // Only the two the fail-loud core lead read evidences survive.
    expect(res.body.attributedOutcomes).toEqual(["clicked", "repliedPositive"]);
  });

  it("only the STATEMENTS evidence an attended meeting; booked and closed have two producers", async () => {
    vi.restoreAllMocks();
    withFeatures();
    mockFetch({ stated: true }); // the legacy qualifications still answer

    const res = await feature();
    expect(res.body.attributedOutcomes).toContain("meetingBooked");
    expect(res.body.attributedOutcomes).toContain("purchased");
    expect(res.body.attributedOutcomes).not.toContain("meetingAttended");
  });

  it("EVERY money grain narrows the same way — a grain left behind reproduces the bug one click away", async () => {
    for (const read of [feature, brand, offer, offerFunnel]) {
      const lean = await read();
      expect(lean.status).toBe(200);
      expect(lean.body.leads.length).toBe(3);
      for (const row of lean.body.leads) expect(Object.keys(row).sort()).toEqual(NARROW_KEYS);
      expect(lean.body.attributedOutcomes).toContain("signup");

      const full = await read(read === feature || read === offer || read === offerFunnel ? "&leads=full" : "?leads=full");
      expect(full.status).toBe(200);
      expect(full.body.leads.length).toBe(LEADS.length);
      expect(full.body.leads[0]).toHaveProperty("firstName");
    }
  });

  it("a LENSED read narrows too, and keeps the figure that read exists for", async () => {
    const res = await feature("&lens=booked-meetings");
    expect(res.status).toBe(200);
    // The lens filters to positive-reply leads and prices each one, so every row it serves reached
    // something and every row keeps its probability.
    expect(res.body.leads.length).toBeGreaterThan(0);
    for (const row of res.body.leads) {
      expect(Object.keys(row).sort()).toEqual([...NARROW_KEYS, "conversionProbabilityPct"].sort());
      expect(typeof row.conversionProbabilityPct).toBe("number");
    }
  });

  it("an unrecognised word is a 400, never a silent pick", async () => {
    for (const read of [feature, offer, offerFunnel]) {
      const res = await read("&leads=everything");
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain("leads must be one of");
    }
    const b = await brand("?leads=everything");
    expect(b.status).toBe(400);
  });
});
