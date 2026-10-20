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

const NONE = { absorbed: { billedCents: "0", setAsideCents: "0" }, billing: null };

describe("buildUsageBreakdown", () => {
  const groups = [
    g("apollo-service", "enrichment", "c", "1687.4"),
    g("chat-service", "complete", null, "695.455"),
    g("chat-service", "complete", "c", "535.161", "12.5"),
    g("chat-service", "judgments", "c", "59.461"),
    g("postmark-service", "email-send", null, "4.95"),
    g("mystery", "x", "c", "0.004"),
  ];
  const out = buildUsageBreakdown(groups, NONE).breakdown;

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
    expect(() => buildUsageBreakdown([{ dimensions: {}, actualCostInUsdCents: "1" }], NONE)).toThrow(/NET/);
  });
});

// USAGE-MATCHES-BILLED-1021: LBVisible prod 2026-10-21, $2.97 of setup spend after the cutover was the
// platform's, yet the breakdown printed it as billed ($10.03 vs billing's $7.26).
describe("buildUsageBreakdown closes on billing's figures", () => {
  const cat = (b: ReturnType<typeof buildUsageBreakdown>["breakdown"], key: string) => b.categories.find((c) => c.key === key)!;
  const groups = [
    g("brand-service", "extract", null, "297.1056832"), // no campaign, after the cutover: absorbed
    g("apollo-service", "enrichment", "c", "454.570344"),
    g("chat-service", "complete", "c", "268.1975"),
    g("instantly-service", "email-send-step-1", "c", "0", "528.2958"),
  ];

  it("a no-campaign row after the cutover is excluded from billed and served as coveredByUs", () => {
    const { breakdown } = buildUsageBreakdown(groups, {
      absorbed: { billedCents: "297.1056832", setAsideCents: "0" },
      billing: { billedCents: "722.767844", setAsideCents: "528.2958" },
    });
    expect(cat(breakdown, "setup").billedUsd).toBe(0);
    expect(breakdown.coveredByUs).toEqual({ billedUsd: 2.971056832, setAsideUsd: 0, sinceIso: "2026-10-13T00:00:00.000Z" });
    expect(breakdown.totalBilledUsd).toBe(7.22767844);
    expect(cat(breakdown, "account_adjustments").billedUsd).toBe(0);
    expect(breakdown.totalSetAsideUsd).toBe(5.282958);
    expect(breakdown.totalsSource).toBe("billing");
  });

  it("keeps no-campaign spend from before the cutover as billed setup", () => {
    const { breakdown } = buildUsageBreakdown(groups, {
      absorbed: { billedCents: "100", setAsideCents: "0" },
      billing: { billedCents: "919.8735272", setAsideCents: "528.2958" },
    });
    expect(cat(breakdown, "setup").billedUsd).toBeCloseTo(1.971056832, 12);
    expect(cat(breakdown, "account_adjustments").billedUsd).toBe(0);
  });

  it("serves what billing bills beyond the classified spend (a staff debit) as account_adjustments, totals = billing", () => {
    const { breakdown } = buildUsageBreakdown(groups, {
      absorbed: { billedCents: "297.1056832", setAsideCents: "0" },
      billing: { billedCents: "1222.767844", setAsideCents: "528.2958" },
    });
    expect(breakdown.totalBilledUsd).toBe(12.22767844);
    expect(cat(breakdown, "account_adjustments").billedUsd).toBe(5);
    const sum = breakdown.categories.reduce((a, c) => a + Math.round(c.billedUsd * 1e8), 0);
    expect(sum).toBe(Math.round(breakdown.totalBilledUsd * 1e8));
  });

  it("takes absorbed spend out of setup first, then other no-campaign lines, and reports what it could not place", () => {
    const { breakdown, unplacedAbsorbedCents } = buildUsageBreakdown(
      [g("brand-service", "extract", null, "10"), g("postmark-service", "email-send", null, "4"), g("apollo-service", "e", "c", "50")],
      { absorbed: { billedCents: "16", setAsideCents: "0" }, billing: null },
    );
    expect(cat(breakdown, "setup").billedUsd).toBe(0);
    expect(cat(breakdown, "notifications").billedUsd).toBe(0);
    expect(cat(breakdown, "finding_contacts").billedUsd).toBe(0.5);
    expect(unplacedAbsorbedCents.billed).toBe("2");
    expect(breakdown.totalsSource).toBe("no_billing_account");
  });
});
