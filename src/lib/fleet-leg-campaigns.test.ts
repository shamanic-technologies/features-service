import { describe, expect, it } from "vitest";
import { filterLegCampaigns } from "./fleet-leg-campaigns.js";

describe("filterLegCampaigns", () => {
  const rows = [
    { id: "a", orgId: "o1", brandIds: ["b1"], featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation" },
    { id: "b", orgId: "o1", brandIds: ["b1"], featureSlug: "sales-cold-email-outreach", legKey: "start_to_website_visit" },
    { id: "c", orgId: "o2", brandIds: null, brandId: "b2", featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation" },
    { id: "d", orgId: "o2", brandIds: ["b2"], featureSlug: "sales-cold-email-outreach", legKey: null },
    { id: "e", orgId: "o2", brandIds: ["b2"], featureSlug: "pr-cold-email-outreach", legKey: "start_to_conversation" },
    { id: "f", orgId: "o3", featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation" },
    { orgId: "o3", featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation" },
  ];

  it("keeps only the feature's campaigns stating THIS leg — a leg-less row is in no leg", () => {
    expect(filterLegCampaigns(rows, "sales-cold-email-outreach", "start_to_conversation")).toEqual([
      { campaignId: "a", orgId: "o1", brandId: "b1" },
      { campaignId: "c", orgId: "o2", brandId: "b2" },
      { campaignId: "f", orgId: "o3", brandId: null },
    ]);
    expect(filterLegCampaigns(rows, "sales-cold-email-outreach", "start_to_website_visit").map((c) => c.campaignId)).toEqual(["b"]);
  });
});
