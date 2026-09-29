import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  __resetRecurringRevenueShare,
  fetchFleetRecurringRevenue,
  parseFleetRecurringRevenue,
  sumRecurringMrr,
} from "./recurring-revenue-client.js";

/** billing's deployed `/internal/revenue/fleet` shape (billing v0.81.23), trimmed to what is read. */
const BODY = {
  asOf: "2026-09-29T10:00:00.000Z",
  orgs: [
    { orgId: "a", paymentMode: "postpaid", revenueClass: "recurring", classReason: "postpaid_chargeable_card", mrrCents: "60000.0000000000", proactiveDailyBudgetUnknownReason: null },
    { orgId: "b", paymentMode: "postpaid", revenueClass: "recurring", classReason: "postpaid_chargeable_card", mrrCents: "0.3333333333", proactiveDailyBudgetUnknownReason: null },
    { orgId: "c", paymentMode: "postpaid", revenueClass: "recurring", classReason: "postpaid_chargeable_card", mrrCents: "0.3333333334", proactiveDailyBudgetUnknownReason: null },
    { orgId: "d", paymentMode: "prepaid", revenueClass: "one_off", classReason: "prepaid_no_auto_topup", mrrCents: "0.0000000000", proactiveDailyBudgetUnknownReason: null },
    { orgId: "e", paymentMode: "postpaid", revenueClass: "recurring", classReason: "postpaid_chargeable_card", mrrCents: null, proactiveDailyBudgetUnknownReason: "campaign_recurrence_unknown" },
  ],
  unreadableOrgs: [{ orgId: "z", error: "boom" }],
};

describe("billing's recurring revenue, read and summed — never re-derived", () => {
  beforeEach(() => __resetRecurringRevenueShare());

  it("parses the deployed shape; null stays null", () => {
    const f = parseFleetRecurringRevenue(BODY);
    expect(f.orgs.map((o) => [o.orgId, o.revenueClass, o.mrrCents])).toEqual([
      ["a", "recurring", "60000.0000000000"],
      ["b", "recurring", "0.3333333333"],
      ["c", "recurring", "0.3333333334"],
      ["d", "one_off", "0.0000000000"],
      ["e", "recurring", null],
    ]);
    expect(f.orgs[4].unknownReason).toBe("campaign_recurrence_unknown");
    expect(f.unreadableOrgIds).toEqual(["z"]);
  });

  it("fails loud on a body it does not recognise", () => {
    expect(() => parseFleetRecurringRevenue({ totals: {} })).toThrow(/orgs/);
    expect(() => parseFleetRecurringRevenue({ ...BODY, orgs: [{ ...BODY.orgs[0], mrrCents: 12 }] })).toThrow(/mrrCents/);
  });

  it("sums EXACTLY on billing's decimal text, lists the unknown, and scopes by org", () => {
    const f = parseFleetRecurringRevenue(BODY);
    const all = sumRecurringMrr(f);
    expect(all.mrrUsd).toBe(600.01); // 60000 + 0.3333333333 + 0.3333333334 cents
    expect(all.unknownOrgIds).toEqual(["e", "z"]);
    expect(all.contributingOrgCount).toBe(3);
    const notA = sumRecurringMrr(f, (id) => id !== "a");
    expect(notA.mrrUsd).toBe(0.01);
  });

  it("concurrent callers share ONE fetch of the ~15 s fleet read", async () => {
    process.env.BILLING_SERVICE_URL = "http://billing";
    process.env.BILLING_SERVICE_API_KEY = "k";
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(BODY), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const [x, y] = await Promise.all([fetchFleetRecurringRevenue(), fetchFleetRecurringRevenue()]);
    await fetchFleetRecurringRevenue();
    expect(x).toBe(y);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://billing/internal/revenue/fleet");
    vi.unstubAllGlobals();
  });
});
