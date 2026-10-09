import { describe, expect, it } from "vitest";
import { buildChannelCatalogue } from "./channel-catalogue.js";
import { SEED_FEATURES } from "../seed/features.js";

const CATALOGUE = buildChannelCatalogue(SEED_FEATURES);
const minimumOf = (slug: string, legKey: string) =>
  CATALOGUE.find((c) => c.slug === slug)!.stepTransitions.find((t) => t.legKey === legKey)!.minimumMonthlyBudgetCents;

describe("per (channel × leg) minimums on /public/channels (owner 2026-10-04)", () => {
  it("cold email: $99/month on both entry legs", () => {
    expect(minimumOf("sales-cold-email-outreach", "start_to_website_visit")).toBe(9_900);
    expect(minimumOf("sales-cold-email-outreach", "start_to_conversation")).toBe(9_900);
  });

  it("every channel we do not run yet: $1,500/month on every leg", () => {
    for (const slug of ["meta-ads", "google-ads", "linkedin-ads", "cold-linkedin-outreach", "cold-call-outreach"]) {
      const c = CATALOGUE.find((x) => x.slug === slug)!;
      expect(c.managed, slug).toBe(false);
      for (const t of c.stepTransitions) expect(t.minimumMonthlyBudgetCents, `${slug} ${t.legKey}`).toBe(150_000);
    }
  });

  it("our reactive legs and the customer's team: no minimum", () => {
    for (const c of CATALOGUE) {
      for (const t of c.stepTransitions) {
        if (c.operatedBy === "customer") expect(t.minimumMonthlyBudgetCents, c.slug).toBe(0);
        if (c.managed && t.reactive) expect(t.minimumMonthlyBudgetCents, `${c.slug} ${t.legKey}`).toBe(0);
      }
    }
    expect(CATALOGUE.find((c) => c.slug === "ai-meeting-booking")!.managed).toBe(true);
  });

  it("reactive ⟺ the leg STATES reactive (owner 2026-10-09: a sourcing leg from nothing is reactive, on demand)", () => {
    for (const c of CATALOGUE) for (const t of c.stepTransitions) expect(t.reactive).toBe(t.mode === "reactive");
    const sourcing = CATALOGUE.find((c) => c.slug === "sourcing-apollo-cold-filters")!.stepTransitions[0];
    expect([sourcing.from, sourcing.reactive, sourcing.triggerId]).toEqual([null, true, "lead_requested"]);
  });

  it("publishes which channels a sales path can use: the shortlist, seo-content out", () => {
    const eligible = CATALOGUE.filter((c) => c.salesPathEligible).map((c) => c.slug);
    expect(eligible).toContain("sales-cold-email-outreach");
    expect(eligible).toContain("meta-ads");
    expect(eligible).not.toContain("seo-content");
    expect(eligible.some((s) => s.startsWith("agency-"))).toBe(false);
  });
});
