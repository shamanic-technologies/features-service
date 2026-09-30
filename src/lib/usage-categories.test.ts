import { describe, it, expect } from "vitest";
import { buildUsageBreakdown, usageCategoryOf, USAGE_CATEGORY_KEYS } from "./usage-categories.js";

const g = (serviceName: string, taskName: string, campaignId: string | null, actual: string, prov = "0") => ({
  dimensions: { serviceName, taskName, campaignId },
  netActualCostInUsdCents: actual,
  netProvisionedCostInUsdCents: prov,
  actualCostInUsdCents: "999",
  provisionedCostInUsdCents: "999",
});

describe("usageCategoryOf", () => {
  it("files spend outside any campaign under setup", () => {
    expect(usageCategoryOf({ serviceName: "chat-service", taskName: "complete", campaignId: null })).toBe("setup");
    expect(usageCategoryOf({ serviceName: "apollo-service", taskName: "audience-companies" })).toBe("setup");
  });
  it("files notification mail under notifications whatever the campaign", () => {
    expect(usageCategoryOf({ serviceName: "postmark-service", taskName: "email-send", campaignId: "c" })).toBe("notifications");
    expect(usageCategoryOf({ serviceName: "postmark-service", taskName: "email-send", campaignId: null })).toBe("notifications");
  });
  it("splits campaign model spend between writing and reading replies", () => {
    expect(usageCategoryOf({ serviceName: "chat-service", taskName: "complete", campaignId: "c" })).toBe("writing_emails");
    expect(usageCategoryOf({ serviceName: "chat-service", taskName: "judgments", campaignId: "c" })).toBe("reading_replies");
  });
  it("files contact finding, sending, and anything unknown", () => {
    expect(usageCategoryOf({ serviceName: "apollo-service", taskName: "enrichment", campaignId: "c" })).toBe("finding_contacts");
    expect(usageCategoryOf({ serviceName: "instantly-service", taskName: "email-send-step-1", campaignId: "c" })).toBe("sending_emails");
    expect(usageCategoryOf({ serviceName: "brand-new-service", taskName: "x", campaignId: "c" })).toBe("other");
  });
});

describe("buildUsageBreakdown", () => {
  const groups = [
    g("apollo-service", "enrichment", "c", "1687.4"),
    g("chat-service", "complete", null, "695.455"),
    g("chat-service", "complete", "c", "535.161", "12.5"),
    g("chat-service", "judgments", "c", "59.461"),
    g("postmark-service", "email-send", null, "4.95"),
    g("mystery", "x", "c", "0.004"),
  ];
  const out = buildUsageBreakdown(groups);

  it("reads the NET billed figures, never the gross ones", () => {
    expect(out.totalBilledUsd).toBeCloseTo(29.82431, 8);
    expect(out.totalSetAsideUsd).toBeCloseTo(0.125, 8);
  });
  it("lists every category in a fixed order and the total is their sum", () => {
    expect(out.categories.map((c) => c.key)).toEqual([...USAGE_CATEGORY_KEYS]);
    const sum = out.categories.reduce((a, c) => a + c.billedUsd, 0);
    expect(sum).toBeCloseTo(out.totalBilledUsd, 8);
  });
  it("puts an unknown line in other rather than dropping it", () => {
    expect(out.categories.find((c) => c.key === "other")!.billedUsd).toBeCloseTo(0.00004, 10);
  });
  it("fails loud when a group carries no net figure", () => {
    expect(() => buildUsageBreakdown([{ dimensions: {}, actualCostInUsdCents: "1" }])).toThrow(/NET/);
  });
});
