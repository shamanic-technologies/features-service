import { describe, it, expect } from "vitest";
import { parseAuthorizedGoals, UnknownAuthorizedGoalError } from "./authorized-goals.js";

describe("parseAuthorizedGoals", () => {
  it("returns null when the payload states NO authorized set (the caller must fail loud, not default)", () => {
    expect(parseAuthorizedGoals({ economics: { lifetimeRevenueUsd: 1000 }, source: "user" })).toBeNull();
    expect(parseAuthorizedGoals(null)).toBeNull();
    expect(parseAuthorizedGoals("nope")).toBeNull();
  });

  it("NEVER reads the brand's single optimizationGoal as the authorized set", () => {
    expect(parseAuthorizedGoals({ salesEconomics: { optimizationGoal: "positive_replies" } })).toBeNull();
  });

  it("NEVER reads funnelStages as the authorized set (different concept, different vocabulary)", () => {
    expect(parseAuthorizedGoals({ salesEconomics: { funnelStages: ["website_purchase", "sales_meeting"] } })).toBeNull();
  });

  it("an EMPTY stated set parses as [] — a real answer, distinct from 'no set stated'", () => {
    expect(parseAuthorizedGoals({ authorizedGoals: [] })).toEqual([]);
  });

  it("maps every stored spelling to the canonical goal", () => {
    const parsed = parseAuthorizedGoals({
      authorizedGoals: ["signups", "booked_meetings", "positive_replies", "form_submissions", "website_purchase", "sales", "whatsapp_conversations", "website_visits"],
    });
    expect(parsed?.map((e) => e.goal)).toEqual([
      "signup",
      "meetingBooked",
      "positiveReply",
      "formSubmission",
      "websitePurchase",
      "sales",
      "whatsappConversation",
      "websiteVisit",
    ]);
    expect(parsed?.every((e) => e.economics === null)).toBe(true);
  });

  it("accepts the producer's plural container under any of its plausible names, nested or top-level", () => {
    const names = ["authorizedGoals", "optimizationGoals", "funnels", "salesFunnels"];
    for (const name of names) {
      expect(parseAuthorizedGoals({ [name]: ["signups"] })?.map((e) => e.goal)).toEqual(["signup"]);
      expect(parseAuthorizedGoals({ salesEconomics: { [name]: ["signups"] } })?.map((e) => e.goal)).toEqual(["signup"]);
      expect(parseAuthorizedGoals({ economics: { [name]: ["signups"] } })?.map((e) => e.goal)).toEqual(["signup"]);
    }
  });

  it("reads PER-FUNNEL economics off an object entry, nested or flat", () => {
    const nested = parseAuthorizedGoals({
      funnels: [{ goal: "signups", economics: { lifetimeRevenueUsd: 200, signupToPaidClientPct: 10 } }],
    });
    expect(nested).toEqual([{ goal: "signup", economics: { lifetimeRevenueUsd: 200, signupToPaidClientPct: 10 } }]);

    const flat = parseAuthorizedGoals({ funnels: [{ optimizationGoal: "sales", lifetimeRevenueUsd: 20_000 }] });
    expect(flat).toEqual([{ goal: "sales", economics: { lifetimeRevenueUsd: 20_000 } }]);

    // Non-numeric / unknown fields never leak into the override.
    const noisy = parseAuthorizedGoals({ funnels: [{ goal: "signups", economics: { lifetimeRevenueUsd: "200", label: "x" } }] });
    expect(noisy).toEqual([{ goal: "signup", economics: null }]);
  });

  it("dedupes while preserving the producer's order", () => {
    const parsed = parseAuthorizedGoals({ authorizedGoals: ["positive_replies", "signups", "positiveReply"] });
    expect(parsed?.map((e) => e.goal)).toEqual(["positiveReply", "signup"]);
  });

  it("throws on a goal it cannot map — an authorized goal must never be silently dropped", () => {
    expect(() => parseAuthorizedGoals({ authorizedGoals: ["signups", "telepathy"] })).toThrow(UnknownAuthorizedGoalError);
    expect(() => parseAuthorizedGoals({ authorizedGoals: [{ label: "no goal here" }] })).toThrow(UnknownAuthorizedGoalError);
  });
});
