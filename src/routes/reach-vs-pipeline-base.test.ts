/**
 * REACH AND THE PIPELINE BASE ARE TWO DIFFERENT QUESTIONS — a bounced lead is REACHED and worth NOTHING.
 *
 * ONE downstream fixture, shaped like the campaign that reported this (features-service#862): every
 * person emailed exactly once, some of them bouncing, one unsubscribing, one replying positively. What
 * it pins, in the consumer's own words:
 *
 *   - the reach count equals the number of people emailed — bounces INCLUDED, because we sent those
 *     emails and we paid for them;
 *   - the pipeline / expected-value base is stated separately and is NOT inferred from reach;
 *   - no response reports a lead as bounced while implying it was never contacted — the contradiction
 *     that made a customer read 876-against-836 as a duplicate-contact bug;
 *   - the first funnel rung's conversion and the count it converts FROM come from here and agree;
 *   - a lead that BOTH bounced and unsubscribed leaves the base ONCE, which is why the base is served
 *     rather than subtracted in the browser;
 *   - the expected-value math is untouched: a lead that clicked and then bounced is still worth 0.
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
const WEBSITE = "sales_meetings_from_website";
const PURCHASES = "website_purchases";
const FORM = "form_magnet";

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
  declaredFunnel(WEBSITE, ["Website visit", "Meeting booked", "Meeting attended", "Paid client"]),
  declaredFunnel(PURCHASES, ["Website visit", "Signup", "Paid client"]),
  declaredFunnel(FORM, ["Website visit", "Form filled", "Paid client"]),
];

const emailOf = (leadId: string) => `${leadId}@x.com`;

function lead(campaignId: string, leadId: string, signal: "reply" | "click" | "none"): Record<string, unknown> {
  return {
    leadId,
    campaignId,
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
    lead: { firstName: "A", lastName: "B", photoUrl: null, organization: { id: leadId, name: leadId, logoUrl: null } },
  };
}

interface Fixture {
  campaigns: Record<string, { featureSlug: string; funnelKey: string | null; offerId: string | null }>;
  costByCampaign: Record<string, number>;
  leads: Array<Record<string, unknown>>;
  /** lead ids a HUMAN stated reached each priced rung. */
  stated?: Partial<Record<"meeting_booked" | "meeting_attended" | "sale", string[]>>;
  /** lead ids the LEGACY instantly qualifications carry a booked meeting / a close for. */
  legacy?: { booked?: string[]; closed?: string[] };
  /** lead ids the conversion tracker matched for each website conversion. */
  converted?: Partial<Record<"signup" | "form_submission", string[]>>;
  /** `null` = the statements read fails (a fail-soft producer gap). */
  statedReadable?: boolean;
  /** `null` = the legacy qualifications read fails. */
  legacyReadable?: boolean;
  /** `null` = the matched-lead email sets fail. */
  convertedReadable?: boolean;
  /** What the CUSTOMER states each leg they worked themselves cost them, per campaign. */
  stepCosts?: Array<{ campaignId: string | null; step: string; kind?: "outcome" | "never"; costCents: number | null }>;
  /** `false` = the statement read fails (fail-soft) — every rung's customer half reads null. */
  stepCostsReadable?: boolean;
  declared?: typeof ALL_DECLARED | null;
}

function mockFetch(fixture: Fixture): void {
  const inScope = (cid: string, q: URLSearchParams): boolean => {
    const row = fixture.campaigns[cid];
    if (!row) return false;
    const only = q.get("campaignId");
    if (only && only !== cid) return false;
    const slugs = (q.get("featureSlugs") ?? "").split(",").filter(Boolean);
    if (slugs.length > 0 && !slugs.includes(row.featureSlug)) return false;
    return true;
  };

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const url = new URL(raw);
    const path = url.pathname;
    const q = url.searchParams;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    if (path.endsWith("/campaigns")) {
      const narrowed = q.get("featureSlug");
      return json({
        campaigns: Object.entries(fixture.campaigns)
          .filter(([, row]) => !narrowed || row.featureSlug === narrowed)
          .map(([id, row]) => ({
            id,
            orgId: "org-1",
            brandId: BRAND,
            featureSlug: row.featureSlug,
            funnelKey: row.funnelKey,
            acquisitionChannel: row.featureSlug,
            offerId: row.offerId,
            status: "ongoing",
            createdAt: "2026-01-01T00:00:00.000Z",
          })),
      });
    }
    if (path.includes("/sales-funnels")) {
      const declared = fixture.declared === undefined ? ALL_DECLARED : fixture.declared;
      if (declared === null) return new Response("not found", { status: 404 });
      return json({ funnels: declared });
    }
    if (path.includes("/costs/timeseries")) {
      return json({
        buckets: Object.keys(fixture.costByCampaign)
          .filter((cid) => inScope(cid, q))
          .map((cid) => ({ period: "2026-01-02", totalCostInUsdCents: String(fixture.costByCampaign[cid]) })),
      });
    }
    if (path.includes("/public/workflows")) return json({ workflows: [] });
    if (path.includes("/public/costs")) return json({ groups: [] });
    if (path.includes("/public/stats")) return json({});

    if (path.includes("/stats/costs")) {
      const groupBy = q.get("groupBy") ?? "";
      const wantsAudience = groupBy.includes("audienceId");
      return json({
        groups: Object.keys(fixture.costByCampaign)
          .filter((cid) => inScope(cid, q))
          .map((cid) => ({
            dimensions: { campaignId: cid, workflowSlug: "dawn-v1", ...(wantsAudience ? { audienceId: "aud-1" } : {}) },
            totalCostInUsdCents: String(fixture.costByCampaign[cid]),
            actualCostInUsdCents: String(fixture.costByCampaign[cid]),
            runCount: 1,
            minStartedAt: null,
            maxStartedAt: null,
          })),
      });
    }

    if (path.includes("/sales-economics-effective")) return json({ economics: ECONOMICS, source: "user" });

    if (path.endsWith("/orgs/leads")) {
      const only = q.get("campaignId");
      return json({ leads: only ? fixture.leads.filter((l) => l.campaignId === only) : fixture.leads });
    }

    // WHAT A HUMAN STATED — the only evidence "Meeting attended" has anywhere in the fleet.
    if (path.includes("/converted-lead-emails")) {
      if (fixture.convertedReadable === false) return new Response("boom", { status: 502 });
      const event = q.get("event") as "signup" | "form_submission";
      return json({ event, emails: (fixture.converted?.[event] ?? []).map(emailOf) });
    }
    if (path.includes("/converted-leads")) {
      if (fixture.statedReadable === false) return new Response("boom", { status: 502 });
      const event = q.get("event") as "meeting_booked" | "meeting_attended" | "sale";
      return json({
        outcomes: (fixture.stated?.[event] ?? []).map((leadId) => ({
          leadId,
          email: emailOf(leadId),
          campaignId: null,
          occurredAt: "2026-01-03T00:00:00.000Z",
          valueCents: null,
          source: "manual",
        })),
      });
    }
    if (path.includes("/manual-qualifications")) {
      if (fixture.legacyReadable === false) return new Response("boom", { status: 502 });
      return json({
        qualifications: [
          ...(fixture.legacy?.booked ?? []).map((leadId) => ({
            email: emailOf(leadId),
            status: "lead_meeting_booked",
            qualifiedAt: "2026-01-03T00:00:00.000Z",
          })),
          ...(fixture.legacy?.closed ?? []).map((leadId) => ({
            email: emailOf(leadId),
            status: "lead_closed",
            qualifiedAt: "2026-01-04T00:00:00.000Z",
          })),
        ],
      });
    }
    if (path.includes("/step-costs")) {
      if (fixture.stepCostsReadable === false) return new Response("boom", { status: 502 });
      return json({
        brandId: BRAND,
        costs: (fixture.stepCosts ?? []).map((c) => ({ kind: "outcome", ...c })),
      });
    }
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

const withFeatures = () => {
  vi.mocked(db.query.features.findFirst).mockImplementation(
    (async (args: { where: unknown }) => FEATURE_ROW(String((args as never as { where: { right?: string } }).where?.right ?? PITCH))) as never,
  );
};


const REACH = 10; // people emailed
const BOUNCED = ["b1", "b2"]; // their mailbox refused it
const UNSUBSCRIBED = ["u1"]; // asked us to stop
const BOTH = "x1"; // bounced AND unsubscribed — counted once, removed once
const REPLIED = "r1"; // the one positive reply

type Outcomes = {
  recipientsContacted: number;
  recipientsConvertible: number;
  recipientsBounced: number;
  recipientsUnsubscribed: number;
  recipientsClicked: number;
  recipientsRepliesPositive: number;
};

/**
 * Ten contacted leads. Two bounced, one unsubscribed, one did both, one replied positively, and one of
 * the bounced leads CLICKED before it bounced — so a model that let a dead lead keep its conversion
 * legs would show up as pipeline, and one that erased its send would show up as a reach of 6.
 */
const FIXTURE: Fixture = {
  campaigns: { c1: { featureSlug: PITCH, funnelKey: CONVERSATION, offerId: OFFER } },
  costByCampaign: { c1: 12000 },
  leads: [
    { ...lead("c1", "b1", "click"), bounced: true },
    { ...lead("c1", "b2", "none"), bounced: true },
    { ...lead("c1", "u1", "none"), unsubscribed: true },
    { ...lead("c1", BOTH, "none"), bounced: true, unsubscribed: true },
    lead("c1", REPLIED, "reply"),
    lead("c1", "p1", "none"),
    lead("c1", "p2", "none"),
    lead("c1", "p3", "none"),
    lead("c1", "p4", "none"),
    lead("c1", "p5", "none"),
  ],
};

/** People we emailed and can never hear from again: b1, b2, u1 and the one that is both. */
const OUT_OF_FUNNEL = BOUNCED.length + UNSUBSCRIBED.length + 1;

const revenue = (query = "") =>
  request(app).get(`/features/${PITCH}/revenue?leads=full&brandId=${BRAND}${query}`).set(AUTH);

describe("reach and the pipeline base", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withFeatures();
    mockFetch(FIXTURE);
  });
  afterEach(() => vi.restoreAllMocks());

  it("states the number of people it emailed — bounces and unsubscribes INCLUDED", async () => {
    const res = await revenue();
    expect(res.status).toBe(200);
    const o: Outcomes = res.body.outcomes;
    // The whole point: 10 people were emailed, so the reach figure is 10 and not 6.
    expect(o.recipientsContacted).toBe(REACH);
    expect(o.recipientsBounced).toBe(BOUNCED.length + 1); // the two, plus the one that also unsubscribed
    expect(o.recipientsUnsubscribed).toBe(UNSUBSCRIBED.length + 1);
    // The series the Overview card renders says the same number as the block beside it.
    expect(res.body.recipientsContacted.total).toBe(REACH);
    // And so does the row set a customer can open — one row per person emailed, nobody dropped.
    expect(res.body.leads).toHaveLength(REACH);
  });

  it("states the pipeline base separately, without it having to be inferred", async () => {
    const o: Outcomes = (await revenue()).body.outcomes;
    expect(o.recipientsConvertible).toBe(REACH - OUT_OF_FUNNEL);
    // Not equal to reach — the two answer different questions and a consumer can tell them apart.
    expect(o.recipientsConvertible).not.toBe(o.recipientsContacted);
  });

  it("a lead that BOTH bounced and unsubscribed leaves the base ONCE — the base is a union, not a subtraction", async () => {
    const o: Outcomes = (await revenue()).body.outcomes;
    // The arithmetic a browser would do double-subtracts the person who is in both counts.
    expect(o.recipientsContacted - o.recipientsBounced - o.recipientsUnsubscribed).toBe(REACH - OUT_OF_FUNNEL - 1);
    // The served figure is right, which is the reason it is served.
    expect(o.recipientsConvertible).toBe(REACH - OUT_OF_FUNNEL);
  });

  it("never reports a lead as bounced while implying it was never contacted", async () => {
    const res = await revenue();
    const rows: Array<Record<string, unknown>> = res.body.leads;
    for (const row of rows) {
      if (row.bounced || row.unsubscribed) expect(row.contacted).toBe(true);
    }
    // The contradiction, stated as the customer read it: bounced can never exceed contacted.
    const o: Outcomes = res.body.outcomes;
    expect(o.recipientsBounced).toBeLessThanOrEqual(o.recipientsContacted);
    // Each dead lead says WHY it went nowhere, on its own row.
    const b1 = rows.find((r) => r.leadId === "b1");
    expect(b1).toMatchObject({ contacted: true, bounced: true, unsubscribed: false, expectedRevenueUsd: 0 });
    const both = rows.find((r) => r.leadId === BOTH);
    expect(both).toMatchObject({ contacted: true, bounced: true, unsubscribed: true });
  });

  it("the first funnel rung converts from the reach this service states, and the two agree", async () => {
    const res = await revenue(`&funnel=${CONVERSATION}`);
    const steps = res.body.funnelSteps;
    expect(steps.funnelKey).toBe(CONVERSATION);
    // The base is REACH — a bounce is a real loss at the very first rung, and it was paid for.
    expect(steps.contactedRecipients).toBe(REACH);
    expect(steps.convertibleRecipients).toBe(REACH - OUT_OF_FUNNEL);
    // Both halves of the block agree with the money block's own counts, by construction.
    expect(steps.contactedRecipients).toBe(res.body.outcomes.recipientsContacted);
    expect(steps.convertibleRecipients).toBe(res.body.outcomes.recipientsConvertible);

    const first = steps.steps[0];
    expect(first.step).toBe("Positive reply");
    expect(first.fromStep).toBe("Contacted");
    // The rate and the count it divides come from here, so they cannot disagree.
    expect(first.fromRecipientsReached).toBe(REACH);
    expect(first.recipientsReached).toBe(1); // r1 alone
    expect(first.conversionFromPreviousPct).toBeCloseTo(10, 6); // 1 of 10, not 1 of 6
  });

  it("the expected-value math is untouched — a lead that clicked and then bounced is worth 0", async () => {
    const res = await revenue();
    const o: Outcomes = res.body.outcomes;
    // b1 clicked before bouncing. It can never convert, so the click is not a conversion signal here.
    expect(o.recipientsClicked).toBe(0);
    expect(o.recipientsRepliesPositive).toBe(1); // r1, who is alive
    const b1 = res.body.leads.find((r: Record<string, unknown>) => r.leadId === "b1");
    expect(b1).toMatchObject({ clicked: false, expectedRevenueUsd: 0 });
    // Every dead lead contributes nothing to the pipeline, so the total is the live evidence alone.
    const live = res.body.leads.filter((r: Record<string, unknown>) => !r.bounced && !r.unsubscribed);
    const sum = live.reduce((n: number, r: Record<string, number>) => n + r.expectedRevenueUsd, 0);
    expect(res.body.headline.totalPipelineUsd).toBeCloseTo(sum, 6);
  });

  it("a campaign with nothing dead reads the SAME number for both — no change for a clean campaign", async () => {
    vi.restoreAllMocks();
    withFeatures();
    mockFetch({
      campaigns: { c1: { featureSlug: PITCH, funnelKey: CONVERSATION, offerId: OFFER } },
      costByCampaign: { c1: 12000 },
      leads: [lead("c1", "p1", "none"), lead("c1", "p2", "reply")],
    });
    const o: Outcomes = (await revenue()).body.outcomes;
    expect(o.recipientsContacted).toBe(2);
    expect(o.recipientsConvertible).toBe(2);
    expect(o.recipientsBounced).toBe(0);
    expect(o.recipientsUnsubscribed).toBe(0);
  });
});
