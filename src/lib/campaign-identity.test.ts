import { describe, it, expect } from "vitest";
import {
  buildCampaignFamilies,
  describeIdentity,
  identityKeyOf,
  type CampaignIdentityRow,
} from "./campaign-identity.js";

const ORG = "org-1";
const BRAND = "brand-1";

function row(over: Partial<CampaignIdentityRow> & { id: string }): CampaignIdentityRow {
  return {
    orgId: ORG,
    brandId: BRAND,
    featureSlug: "sales-cold-email-outreach",
    acquisitionChannel: "cold_email",
    funnelKey: null,
    status: "stopped",
    createdAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

describe("campaign identity", () => {
  it("pools every campaign sharing (org, brand, funnel, channel) — the workflow is NOT part of it", () => {
    // The exact shape of the reported prod case: one brand, one identity, dozens of stopped rows
    // left behind by workflow switches, and one live campaign.
    const rows = [
      ...Array.from({ length: 54 }, (_, i) => row({ id: `stopped-${i}` })),
      row({ id: "live", status: "ongoing", createdAt: "2026-07-20T00:00:00.000Z" }),
    ];

    const families = buildCampaignFamilies(rows);

    expect(families.familyOf("live")).toHaveLength(55);
    expect(families.familyOf("stopped-0")).toEqual(families.familyOf("live"));
    expect(families.identityOf("stopped-0")?.representativeId).toBe("live");
    expect(families.identityOf("live")?.liveCampaignIds).toEqual(["live"]);
  });

  it("keeps two funnels on one brand+channel apart, and neither is inferred from a goal", () => {
    const families = buildCampaignFamilies([
      row({ id: "a", funnelKey: "sales_meetings_from_conversation" }),
      row({ id: "b", funnelKey: "sales_meetings_from_website" }),
    ]);

    // Both funnels answer to the goal `meetingBooked`; only the stated funnel separates them.
    expect(families.familyOf("a")).toEqual(["a"]);
    expect(families.familyOf("b")).toEqual(["b"]);
  });

  it("keeps an UNSTATED funnel distinguishable from a stated one", () => {
    const families = buildCampaignFamilies([
      row({ id: "unstated-1", funnelKey: null }),
      row({ id: "unstated-2", funnelKey: null }),
      row({ id: "stated", funnelKey: "website_purchases" }),
    ]);

    // The unstated ones pool together (campaign-service's own `coalesce(funnel_key,'')` key)…
    expect(families.familyOf("unstated-1")).toEqual(["unstated-1", "unstated-2"]);
    // …and never fold onto a campaign that DID state a funnel.
    expect(families.familyOf("stated")).toEqual(["stated"]);
    expect(families.identityOf("unstated-1")?.funnelKey).toBeNull();
    expect(families.identityOf("stated")?.funnelKey).toBe("website_purchases");
  });

  it("separates channels, brands and orgs", () => {
    const families = buildCampaignFamilies([
      row({ id: "cold" }),
      row({ id: "crm", acquisitionChannel: "crm_email" }),
      row({ id: "other-brand", brandId: "brand-2" }),
      row({ id: "other-org", orgId: "org-2" }),
    ]);

    for (const id of ["cold", "crm", "other-brand", "other-org"]) {
      expect(families.familyOf(id)).toEqual([id]);
    }
  });

  it("never pools a row that does not state the identity — it is its own family of one", () => {
    // A row predating campaign-service migration 0044 states no channel (and possibly no brand).
    expect(identityKeyOf(row({ id: "old", acquisitionChannel: null }))).toBeNull();
    const families = buildCampaignFamilies([
      row({ id: "old-a", acquisitionChannel: null }),
      row({ id: "old-b", acquisitionChannel: null }),
    ]);
    expect(families.familyOf("old-a")).toEqual(["old-a"]);
    expect(families.familyOf("old-b")).toEqual(["old-b"]);
  });

  it("falls back to the legacy brand_ids array for the brand", () => {
    const families = buildCampaignFamilies([
      row({ id: "a", brandId: null, brandIds: [BRAND] }),
      row({ id: "b" }),
    ]);
    expect(families.familyOf("a")).toEqual(["a", "b"]);
  });

  it("with no live member, names the most recently created one — deterministically", () => {
    const families = buildCampaignFamilies([
      row({ id: "old", createdAt: "2026-05-01T00:00:00.000Z" }),
      row({ id: "new", createdAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    expect(families.identityOf("old")?.representativeId).toBe("new");
    expect(families.identityOf("old")?.liveCampaignIds).toEqual([]);
  });

  it("an unknown campaign describes as its own identity, never folded onto another", () => {
    const view = describeIdentity(null, "unknown-1");
    expect(view).toEqual({
      key: "campaign:unknown-1",
      funnelKey: null,
      acquisitionChannel: null,
      campaignIds: ["unknown-1"],
      liveCampaignIds: [],
      representativeId: "unknown-1",
    });
  });
});
