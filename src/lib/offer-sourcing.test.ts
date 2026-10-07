import { describe, it, expect, vi } from "vitest";
import { computeOfferSourcing, type ServeCost, type SourcedLead } from "./offer-sourcing.js";
import { originOfServe, withSourcingSlugs, SOURCING_ORIGIN_SLUGS, SOURCING_ORIGINS } from "./sourcing-origins.js";
import { SEED_FEATURES } from "../seed/features.js";

const AUD_COLD = "aud-cold";
const AUD_SIGNAL = "aud-signal";
const lists = new Map<string, string | null>([
  [AUD_COLD, "apollo_search"],
  [AUD_SIGNAL, "linkedin_engagement"],
]);
const campaigns = [
  { id: "c1", featureSlug: "sales-cold-email-outreach", channelName: "Sales Cold Email Outreach", legKey: "start_to_conversation", status: "ongoing" },
  { id: "c2", featureSlug: "sales-cold-email-outreach", channelName: "Sales Cold Email Outreach", legKey: "start_to_conversation", status: "stopped" },
];

describe("sourcing origins", () => {
  it("every origin is a seeded feature that is not an acquisition channel", () => {
    for (const o of SOURCING_ORIGINS) {
      const f = SEED_FEATURES.find((s) => s.slug === o.slug);
      expect(f, o.slug).toBeDefined();
      expect(f!.acquisitionChannel).toBeNull();
      expect(f!.salesFunnels).toEqual([]);
    }
  });

  it("a serve's origin is its own slug when it carries one (new runs), else its audience's list kind (old runs)", () => {
    expect(originOfServe({ runFeatureSlug: "sourcing-apollo-buying-signals", audienceId: AUD_COLD, listOfAudience: lists })?.slug).toBe(
      "sourcing-apollo-buying-signals",
    );
    expect(originOfServe({ runFeatureSlug: "sales-cold-email-outreach", audienceId: AUD_COLD, listOfAudience: lists })?.slug).toBe(
      "sourcing-apollo-cold-filters",
    );
    expect(originOfServe({ runFeatureSlug: "sales-cold-email-outreach", audienceId: null, listOfAudience: lists })).toBeNull();
    expect(originOfServe({ runFeatureSlug: "sales-cold-email-outreach", audienceId: "unknown", listOfAudience: lists })).toBeNull();
  });

  it("a spend read about a sourcing channel also counts every origin slug; any other scope is unchanged", () => {
    expect(withSourcingSlugs(["sales-cold-email-outreach"])).toEqual(["sales-cold-email-outreach", ...SOURCING_ORIGIN_SLUGS].sort());
    expect(withSourcingSlugs(["ai-meeting-booking"])).toEqual(["ai-meeting-booking"]);
  });
});

describe("computeOfferSourcing", () => {
  const serves: ServeCost[] = [
    // c1: two cold serves, one signal serve (new state: carries its origin slug), one with no audience.
    { runId: "s1", campaignId: "c1", audienceId: AUD_COLD, featureSlug: "sales-cold-email-outreach", cents: "100.5000000000" },
    { runId: "s2", campaignId: "c1", audienceId: AUD_COLD, featureSlug: "sales-cold-email-outreach", cents: "99.5000000000" },
    { runId: "s3", campaignId: "c1", audienceId: AUD_SIGNAL, featureSlug: "sourcing-linkedin-engagement-signals", cents: "50.0000000000" },
    { runId: "s4", campaignId: "c2", audienceId: null, featureSlug: "sales-cold-email-outreach", cents: "10.0000000000" },
    // a serve of a campaign outside the offer is ignored
    { runId: "s5", campaignId: "other", audienceId: AUD_COLD, featureSlug: "sales-cold-email-outreach", cents: "999" },
  ];
  const leads: SourcedLead[] = [
    { leadId: "l1", campaignId: "c1", audienceId: AUD_COLD, positiveReply: true },
    { leadId: "l2", campaignId: "c1", audienceId: AUD_COLD, positiveReply: false },
    { leadId: "l3", campaignId: "c1", audienceId: AUD_SIGNAL, positiveReply: true },
    { leadId: "l4", campaignId: "c2", audienceId: null, positiveReply: false },
  ];
  const totals = new Map([
    ["c1", "650.0000000000"],
    ["c2", "40.0000000000"],
  ]);

  const r = computeOfferSourcing({ campaigns, serves, totalCentsByCampaign: totals, listOfAudience: lists, leads, valuePerPositiveReplyUsd: 10 });

  it("sourcing + outreach = the campaign total to the cent, per campaign and overall", () => {
    const c1 = r.campaigns.find((c) => c.campaignId === "c1")!;
    expect(c1.sourcingCostUsd).toBe(2.5);
    expect(c1.outreachCostUsd).toBe(4);
    expect(c1.totalCostUsd).toBe(6.5);
    const c2 = r.campaigns.find((c) => c.campaignId === "c2")!;
    expect(c2.sourcingCostUsd + c2.outreachCostUsd!).toBe(c2.totalCostUsd);
    expect(r.totals).toEqual({ sourcingCostUsd: 2.6, outreachCostUsd: 4.3, totalCostUsd: 6.9 });
  });

  it("lists every origin, used or not, with leads, cost per lead, positive replies and cost per positive reply", () => {
    expect(r.origins.map((o) => o.slug)).toEqual(SOURCING_ORIGINS.map((o) => o.slug));
    const cold = r.origins.find((o) => o.slug === "sourcing-apollo-cold-filters")!;
    expect(cold).toMatchObject({ used: true, serveCount: 2, leadsServed: 2, sourcingCostUsd: 2, costPerLeadUsd: 1, positiveReplies: 1, sourcingCostPerPositiveReplyUsd: 2 });
    // c1 outreach $4 over 3 leads: 2/3 to cold.
    expect(cold.outreachCostUsd).toBeCloseTo(8 / 3, 10);
    expect(cold.endToEndCostUsd).toBeCloseTo(2 + 8 / 3, 10);
    expect(cold.roi).toBeCloseTo(10 / (2 + 8 / 3), 10);
    const signal = r.origins.find((o) => o.slug === "sourcing-linkedin-engagement-signals")!;
    expect(signal).toMatchObject({ used: true, serveCount: 1, leadsServed: 1, sourcingCostUsd: 0.5, positiveReplies: 1 });
    const crm = r.origins.find((o) => o.slug === "sourcing-crm-contacts")!;
    expect(crm).toMatchObject({ used: false, serveCount: 0, leadsServed: 0, costPerLeadUsd: null, roi: null, roiUnavailableReason: "nothing_spent" });
  });

  it("a serve or lead of unknown origin is unattributed, never spread", () => {
    expect(r.unattributed).toMatchObject({ slug: null, serveCount: 1, leadsServed: 1, sourcingCostUsd: 0.1 });
    // c2's outreach ($0.30) belongs to its only lead, which is unattributed.
    expect(r.unattributed.outreachCostUsd).toBeCloseTo(0.3, 10);
    // Σ origins end-to-end + unattributed = the offer total.
    const sum = r.origins.reduce((s, o) => s + o.endToEndCostUsd, 0) + r.unattributed.endToEndCostUsd;
    expect(sum).toBeCloseTo(r.totals.totalCostUsd, 10);
  });

  it("per campaign: its sources, and a cost per positive reply for each half and the total", () => {
    const c1 = r.campaigns.find((c) => c.campaignId === "c1")!;
    expect(c1.sources.map((s) => s.slug)).toEqual(["sourcing-apollo-cold-filters", "sourcing-linkedin-engagement-signals"]);
    expect(c1.positiveReplies).toBe(2);
    expect(c1.costPerPositiveReply).toEqual({ sourcingUsd: 1.25, outreachUsd: 2, totalUsd: 3.25 });
  });

  it("a sourcing figure above the campaign total withholds the outreach share loudly, never a negative", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = computeOfferSourcing({
      campaigns: [campaigns[0]!],
      serves: serves.slice(0, 1),
      totalCentsByCampaign: new Map([["c1", "50"]]),
      listOfAudience: lists,
      leads: [],
      valuePerPositiveReplyUsd: null,
    });
    expect(bad.campaigns[0]).toMatchObject({ outreachCostUsd: null, outreachUnavailableReason: "sourcing_exceeds_campaign_total" });
    expect(bad.totals.outreachCostUsd).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("no value for a positive reply = no ROI, named", () => {
    const none = computeOfferSourcing({ campaigns, serves, totalCentsByCampaign: totals, listOfAudience: lists, leads, valuePerPositiveReplyUsd: null });
    expect(none.origins[0]).toMatchObject({ roi: null, roiUnavailableReason: "no_positive_reply_value" });
  });
});
