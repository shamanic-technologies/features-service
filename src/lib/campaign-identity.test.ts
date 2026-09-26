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
    offerId: "offer-1",
    legKey: "start_to_conversation",
    status: "stopped",
    createdAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

describe("campaign identity", () => {
  it("pools every campaign sharing (org, brand, offer, leg, channel) — the workflow is NOT part of it", () => {
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

  it("keeps two legs, and two offers, on one brand+channel apart", () => {
    const families = buildCampaignFamilies([
      row({ id: "a", legKey: "start_to_conversation" }),
      row({ id: "b", legKey: "start_to_website_visit" }),
      row({ id: "c", offerId: "offer-2" }),
    ]);
    expect(families.familyOf("a")).toEqual(["a"]);
    expect(families.familyOf("b")).toEqual(["b"]);
    expect(families.familyOf("c")).toEqual(["c"]);
    expect(families.identityOf("c")?.offerId).toBe("offer-2");
  });

  it("pools the rows stating NO leg together, never onto a leg-stating campaign (the producer's coalesce)", () => {
    // The prod shape wave C3 meets: a stopped pre-leg ancestor beside the live leg-stating campaign of
    // the same (org, brand, offer, channel). No leg is ever inferred for it.
    const families = buildCampaignFamilies([
      row({ id: "legless-1", legKey: null }),
      row({ id: "legless-2", legKey: null }),
      row({ id: "stated", status: "ongoing" }),
    ]);
    expect(families.familyOf("legless-1")).toEqual(["legless-1", "legless-2"]);
    expect(families.familyOf("stated")).toEqual(["stated"]);
    expect(families.identityOf("legless-1")?.legKeys).toEqual([]);
    expect(families.identityOf("stated")?.legKeys).toEqual(["start_to_conversation"]);
  });

  it("the key is the producer's own index — a campaign row's retired funnel is not part of it", () => {
    const withRetired = { ...row({ id: "a" }), funnelKey: "form_magnet" } as CampaignIdentityRow;
    expect(identityKeyOf(withRetired)).toBe(identityKeyOf(row({ id: "a" })));
    expect(identityKeyOf(row({ id: "a" }))).toBe("org-1|brand-1|offer-1|start_to_conversation|cold_email");
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
      acquisitionChannel: null,
      campaignIds: ["unknown-1"],
      liveCampaignIds: [],
      representativeId: "unknown-1",
    });
  });
});
