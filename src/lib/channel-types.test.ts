import { describe, expect, it } from "vitest";
import { CHANNEL_TYPED_SLUGS, channelTypeOf, OUTBOUND_CHANNEL_SLUGS, UntypedFeatureError, withChannelType } from "./channel-types.js";
import { SEED_FEATURES } from "../seed/features.js";
import { buildChannelCatalogue, type CatalogueFeatureRow } from "./channel-catalogue.js";
import { SOURCING_ORIGIN_SLUGS } from "./sourcing-origins.js";

describe("channelType: one typology, stated on every feature (owner 2026-10-09)", () => {
  it("every seeded feature (active and deprecated) has exactly one type, and every typed slug is a seeded feature", () => {
    const seeded = SEED_FEATURES.map((f) => f.slug).sort();
    expect([...CHANNEL_TYPED_SLUGS].sort()).toEqual(seeded);
    for (const f of SEED_FEATURES) expect(f.channelType).toBe(channelTypeOf(f.slug));
  });

  it("states the owner's membership", () => {
    expect(channelTypeOf("sourcing-apollo-cold-filters")).toBe("sourcing");
    expect(channelTypeOf("sourcing-apify-search")).toBe("sourcing");
    expect(channelTypeOf("sales-crm-email-outreach")).toBe("outbound");
    expect(channelTypeOf("ai-instant-call")).toBe("conversion");
    expect(channelTypeOf("your-team-closing-calls")).toBe("conversion");
    expect(channelTypeOf("meta-ads")).toBe("paid");
    expect(channelTypeOf("newsletter-sponsorships")).toBe("paid");
    expect(channelTypeOf("podcast-guesting")).toBe("earned");
    expect(channelTypeOf("press-placements")).toBe("pr");
    expect(channelTypeOf("pr-expert-quote-outreach")).toBe("pr");
    expect(channelTypeOf("vc-cold-email-outreach")).toBe("fundraising");
    expect(channelTypeOf("hiring-cold-email-outreach")).toBe("hiring");
    expect(channelTypeOf("outlet-database-discovery")).toBe("tool");
  });

  it("the outbound set is exactly the LOCKED ten", () => {
    expect([...OUTBOUND_CHANNEL_SLUGS].sort()).toEqual(
      [
        "sales-cold-email-outreach",
        "feedback-request-cold-email-outreach",
        "sales-crm-email-outreach",
        "cold-call-outreach",
        "cold-instagram-outreach",
        "cold-linkedin-outreach",
        "cold-reddit-outreach",
        "cold-sms-outreach",
        "cold-whatsapp-outreach",
        "cold-x-outreach",
      ].sort(),
    );
  });

  it("paid and earned keep exactly the former paid_reach / earned families, PR moved to its own type", () => {
    for (const f of SEED_FEATURES) {
      const family = f.acquisitionChannel?.family;
      if (family === "paid_reach") expect(f.channelType).toBe("paid");
      if (family === "earned") expect(["earned", "pr"]).toContain(f.channelType);
      if (family === "conversion") expect(f.channelType).toBe("conversion");
      if (family === "outbound_one_to_one") expect(f.channelType).toBe("outbound");
    }
  });

  it("an untyped feature fails loud", () => {
    expect(() => channelTypeOf("nope")).toThrow(UntypedFeatureError);
    expect(withChannelType({ slug: "meta-ads", x: 1 })).toEqual({ slug: "meta-ads", x: 1, channelType: "paid" });
  });
});

describe("the sourcing features are channels like any other", () => {
  const rows: CatalogueFeatureRow[] = SEED_FEATURES.filter((f) => f.status === "active").map((f) => ({
    slug: f.slug,
    name: f.name,
    description: f.description,
    icon: f.icon,
    displayOrder: f.displayOrder,
    acquisitionChannel: f.acquisitionChannel,
    supersededBySlug: f.supersededBySlug,
  }));
  const catalogue = buildChannelCatalogue(rows, () => "x");

  it("each live origin states Start -> Lead found, proactive, daily budget, no floor, managed", () => {
    const live = catalogue.filter((c) => c.channelType === "sourcing");
    expect(live.map((c) => c.slug).sort()).toEqual(
      ["sourcing-apollo-buying-signals", "sourcing-apollo-cold-filters", "sourcing-crm-contacts", "sourcing-linkedin-engagement-signals"].sort(),
    );
    for (const c of live) {
      expect(c.stepTransitions).toHaveLength(1);
      const [t] = c.stepTransitions;
      expect(t.legKey).toBe("start_to_lead_found");
      expect(t.from).toBeNull();
      expect(t.to.key).toBe("lead_found");
      expect(t.to.label).toBe("Lead found");
      expect(t.reactive).toBe(false);
      expect(t.minimumMonthlyBudgetCents).toBe(0);
      expect(c.trigger).toBe("daily_budget");
      expect(c.managed).toBe(true);
      expect(c.salesPathEligible).toBe(false);
      expect(c.salesFunnels).toEqual([]);
      expect(c.terms.dailyOperatingCostCents).toBe(0);
    }
  });

  it("the deprecated origin carries the same statement on its feature row", () => {
    const apify = SEED_FEATURES.find((f) => f.slug === "sourcing-apify-search")!;
    expect(apify.status).toBe("deprecated");
    expect(apify.acquisitionChannel?.stepTransitions).toEqual([{ from: null, to: "lead_found" }]);
    expect(SOURCING_ORIGIN_SLUGS.every((s) => SEED_FEATURES.find((f) => f.slug === s)?.acquisitionChannel != null)).toBe(true);
  });

  it("every other channel's catalogue entry is unchanged by the sourcing additions (only channelType added)", () => {
    const cold = catalogue.find((c) => c.slug === "sales-cold-email-outreach")!;
    expect(cold.channelType).toBe("outbound");
    expect(cold.family).toBe("outbound_one_to_one");
    expect(cold.stepTransitions.map((t) => [t.legKey, t.reactive, t.minimumMonthlyBudgetCents])).toEqual([
      ["start_to_conversation", false, 9900],
      ["start_to_website_visit", false, 9900],
    ]);
    const booking = catalogue.find((c) => c.slug === "ai-meeting-booking")!;
    expect(booking.stepTransitions.every((t) => t.reactive && t.minimumMonthlyBudgetCents === 0)).toBe(true);
  });
});
