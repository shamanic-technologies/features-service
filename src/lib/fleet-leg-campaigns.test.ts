import { describe, expect, it } from "vitest";
import { filterLegCampaigns } from "./fleet-leg-campaigns.js";

describe("filterLegCampaigns", () => {
  const rows = [
    { id: "a", orgId: "o1", brandIds: ["b1"], featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation", workflowSlug: "keel", offerId: "of1" },
    { id: "b", orgId: "o1", brandIds: ["b1"], featureSlug: "sales-cold-email-outreach", legKey: "start_to_website_visit" },
    { id: "c", orgId: "o2", brandIds: null, brandId: "b2", featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation" },
    { id: "d", orgId: "o2", brandIds: ["b2"], featureSlug: "sales-cold-email-outreach", legKey: null },
    { id: "e", orgId: "o2", brandIds: ["b2"], featureSlug: "pr-cold-email-outreach", legKey: "start_to_conversation" },
    { id: "f", orgId: "o3", featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation" },
    { orgId: "o3", featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation" },
    { id: "s", orgId: "o4", brandIds: ["b4"], featureSlug: "lead-sourcing", legKey: "start_to_lead_found", workflowSlug: "lead-sourcing-scheat" },
  ];

  it("keeps only the feature's campaigns stating THIS leg — a leg-less row is in no leg", () => {
    expect(filterLegCampaigns(rows, "sales-cold-email-outreach", "start_to_conversation")).toEqual([
      // The workflow it runs rides along (an on-demand pipe credits its leads to it, lib/on-demand-pipe-fleet.ts).
      { campaignId: "a", orgId: "o1", brandId: "b1", workflowSlug: "keel", offerId: "of1" },
      { campaignId: "c", orgId: "o2", brandId: "b2", workflowSlug: null, offerId: null },
      { campaignId: "f", orgId: "o3", brandId: null, workflowSlug: null, offerId: null },
    ]);
    expect(filterLegCampaigns(rows, "sales-cold-email-outreach", "start_to_website_visit").map((c) => c.campaignId)).toEqual(["b"]);
    // The sourcing leg is no row of the funnel-leg table: its units are matched on their stated key.
    expect(filterLegCampaigns(rows, "lead-sourcing", "start_to_lead_found")).toEqual([{ campaignId: "s", orgId: "o4", brandId: "b4", workflowSlug: "lead-sourcing-scheat", offerId: null }]);
  });
});
