/**
 * CAMPAIGN-TOTAL-POSREPLY-1106: a read of SEVERAL campaigns keeps every person each campaign reached, even when the
 * person's LATEST serve (the one row lead-service's brand-wide list keeps) belongs to a campaign outside the scope.
 * Prod 2026-11-06, brand 33211c62: funnel campaign b255706c (Lead Sourcing + Cold Email units) read 0 positive replies
 * while its own cold email unit read 2, both repliers having been handed later to an AI Meeting Booking unit of
 * ANOTHER funnel campaign.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign:3000";
process.env.CAMPAIGN_SERVICE_API_KEY = "campaign-key";

const { fetchLeadsForRevenue } = await import("./leads-client.js");

const HEADERS = { orgId: "org-1", userId: "u1", runId: "r1" };
const SOURCING = "c-sourcing";
const COLD_EMAIL = "c-cold-email";
const COLD_EMAIL_OLD = "c-cold-email-old"; // an older row of the cold email identity (a workflow switch)
const OTHER_FUNNEL_MEETING = "c-meeting-other-funnel";

function row(leadId: string, campaignId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `lc-${leadId}-${campaignId}`,
    leadId,
    campaignId,
    email: `${leadId}@acme.com`,
    lastServedAt: "2026-10-30T21:00:00.000Z",
    contacted: true,
    sent: true,
    delivered: true,
    replied: false,
    replyClassification: null,
    lead: { organization: null },
    ...over,
  };
}

const positive = { replied: true, replyClassification: "positive" };

/** lead-service as it answers: the brand list collapses a person to the LATEST serve; a campaign read widens to the identity. */
const BRAND_LIST = [
  row("mario", OTHER_FUNNEL_MEETING, { ...positive, lastServedAt: "2026-11-05T03:23:05.333Z" }),
  row("edmund", OTHER_FUNNEL_MEETING, { ...positive, lastServedAt: "2026-11-02T13:23:27.564Z" }),
  row("ada", COLD_EMAIL),
  row("bob", SOURCING),
];
const CAMPAIGN_READ: Record<string, Record<string, unknown>[]> = {
  [COLD_EMAIL]: [row("mario", COLD_EMAIL, positive), row("edmund", COLD_EMAIL_OLD, positive), row("ada", COLD_EMAIL)],
  [SOURCING]: [row("mario", SOURCING), row("edmund", SOURCING), row("ada", SOURCING), row("bob", SOURCING)],
};

const CAMPAIGN_ROWS = [
  { id: SOURCING, orgId: "org-1", brandId: "brand-1", offerId: "o1", legKey: "start_to_lead_found", acquisitionChannel: "lead-sourcing", status: "ongoing" },
  { id: COLD_EMAIL, orgId: "org-1", brandId: "brand-1", offerId: "o1", legKey: "start_to_conversation", acquisitionChannel: "sales-cold-email-outreach", status: "ongoing" },
  { id: COLD_EMAIL_OLD, orgId: "org-1", brandId: "brand-1", offerId: "o1", legKey: "start_to_conversation", acquisitionChannel: "sales-cold-email-outreach", status: "stopped" },
  { id: OTHER_FUNNEL_MEETING, orgId: "org-1", brandId: "brand-1", offerId: "o1", legKey: "conversation_to_meeting_booked", acquisitionChannel: "ai-meeting-booking", status: "ongoing" },
];

function mockServices(opts: { campaignRows: "ok" | "down" }): string[] {
  const leadReads: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.startsWith("http://campaign:3000/campaigns")) {
      return opts.campaignRows === "ok" ? json({ campaigns: CAMPAIGN_ROWS }) : json({ error: "down" }, 503);
    }
    if (url.startsWith("http://lead:3000/orgs/leads")) {
      const campaignId = new URL(url).searchParams.get("campaignId");
      leadReads.push(campaignId ?? "brand");
      return json({ leads: campaignId ? (CAMPAIGN_READ[campaignId] ?? []) : BRAND_LIST });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return leadReads;
}

describe("several campaigns' people (CAMPAIGN-TOTAL-POSREPLY-1106)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("counts the positive replies of a unit whose repliers were last served by another funnel campaign", async () => {
    const reads = mockServices({ campaignRows: "ok" });
    const persons = await fetchLeadsForRevenue("brand-1", [SOURCING, COLD_EMAIL], HEADERS);
    const single = await fetchLeadsForRevenue("brand-1", COLD_EMAIL, HEADERS);

    const repliers = (ps: typeof persons) => ps.filter((p) => p.signals.positiveReply).map((p) => p.leadId).sort();
    // The several-campaign total sees the same 2 positive replies as the cold email unit's own read.
    expect(repliers(persons)).toEqual(["edmund", "mario"]);
    expect(repliers(single)).toEqual(["edmund", "mario"]);
    // One person per lead, every person either unit reached.
    expect(persons.map((p) => p.leadId).sort()).toEqual(["ada", "bob", "edmund", "mario"]);
    // One walk per campaign identity, never the brand-wide list.
    expect(reads).not.toContain("brand");
  });

  it("reads an identity ONCE however many of its rows the scope names", async () => {
    const reads = mockServices({ campaignRows: "ok" });
    await fetchLeadsForRevenue("brand-1", [COLD_EMAIL, COLD_EMAIL_OLD], HEADERS);
    expect(reads).toEqual([COLD_EMAIL]);
  });

  it("campaign-service down: each campaign is read on its own, the replies still counted", async () => {
    const reads = mockServices({ campaignRows: "down" });
    const persons = await fetchLeadsForRevenue("brand-1", [SOURCING, COLD_EMAIL], HEADERS);
    expect(reads.sort()).toEqual([COLD_EMAIL, SOURCING].sort());
    expect(persons.filter((p) => p.signals.positiveReply).map((p) => p.leadId).sort()).toEqual(["edmund", "mario"]);
  });
});
