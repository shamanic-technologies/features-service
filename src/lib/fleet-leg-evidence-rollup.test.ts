import { describe, it, expect } from "vitest";
import { rollUpLegEvidenceByDynasty, buildFleetLegMaturity } from "./fleet-leg-maturity.js";

// LEG-SPEND-MISSING-1016: the conversation-leg ranking served lithium, ballad, permafrost... at $0 and 0
// positive replies while runs-service held $2.2k of lithium spend on the leg's own campaigns. The roll-up
// seeded dynasties from ACTIVE versions only, so a dynasty whose every version is deprecated vanished.
const workflows = [
  // lithium: every version deprecated (the dynasty can no longer run)
  { workflowSlug: "sales-cold-email-outreach-lithium", workflowDynastySlug: "sales-cold-email-outreach-lithium", status: "deprecated" },
  { workflowSlug: "sales-cold-email-outreach-lithium-v8", workflowDynastySlug: "sales-cold-email-outreach-lithium", status: "deprecated" },
  // azalea: an active head plus a deprecated ancestor
  { workflowSlug: "sales-cold-email-outreach-azalea-v6", workflowDynastySlug: "sales-cold-email-outreach-azalea", status: "deprecated" },
  { workflowSlug: "sales-cold-email-outreach-azalea-v7", workflowDynastySlug: "sales-cold-email-outreach-azalea", status: "active" },
];
const cost = (workflowSlug: string, cents: string) => ({ dimensions: { workflowSlug }, totalCostInUsdCents: cents, runCount: 3 });

describe("rollUpLegEvidenceByDynasty", () => {
  it("credits a fully deprecated dynasty with its spend and outcomes on the leg, like any other", () => {
    const { byDynasty, unmapped } = rollUpLegEvidenceByDynasty(
      workflows,
      [cost("sales-cold-email-outreach-lithium", "100000.5"), cost("sales-cold-email-outreach-lithium-v8", "20000.25"), cost("sales-cold-email-outreach-azalea-v7", "5000")],
      new Map<string, Record<string, number>>([
        ["sales-cold-email-outreach-lithium", { recipientsContacted: 900, recipientsRepliesPositive: 15, recipientsClicked: 2 }],
        ["sales-cold-email-outreach-lithium-v8", { recipientsContacted: 100, recipientsRepliesPositive: 6 }],
        ["sales-cold-email-outreach-azalea-v7", { recipientsContacted: 50, recipientsRepliesPositive: 1 }],
      ]),
    );
    expect(byDynasty.get("sales-cold-email-outreach-lithium")).toEqual({ spentCents: 120000.75, contacted: 1000, clicks: 2, replies: 21 });
    expect(byDynasty.get("sales-cold-email-outreach-azalea")).toEqual({ spentCents: 5000, contacted: 50, clicks: 0, replies: 1 });
    expect(unmapped).toEqual([]);
    // and the ranking's figures read it (positive reply = the conversation leg's outcome)
    const figures = buildFleetLegMaturity("start_to_conversation", ["sales-cold-email-outreach-lithium"], byDynasty, null);
    expect(figures.get("sales-cold-email-outreach-lithium")!.flash).toMatchObject({ spentUsd: 1200.0075, contacted: 1000, outcomes: 21 });
  });

  it("sums a deprecated ancestor into its dynasty, and the total spend equals the groups' total", () => {
    const groups = [cost("sales-cold-email-outreach-azalea-v6", "300"), cost("sales-cold-email-outreach-azalea-v7", "700"), cost("sales-cold-email-outreach-lithium", "50")];
    const { byDynasty } = rollUpLegEvidenceByDynasty(workflows, groups, new Map());
    expect(byDynasty.get("sales-cold-email-outreach-azalea")!.spentCents).toBe(1000);
    const total = [...byDynasty.values()].reduce((a, e) => a + e.spentCents, 0);
    expect(total).toBe(1050);
  });

  it("names a slug no workflow states instead of dropping it silently", () => {
    const { byDynasty, unmapped } = rollUpLegEvidenceByDynasty(workflows, [cost("ghost-slug", "42")], new Map([["ghost-slug", { recipientsContacted: 3 }]]));
    expect(byDynasty.size).toBe(0);
    expect(unmapped).toEqual([{ workflowSlug: "ghost-slug", spentCents: 42 }]);
  });

  it("a dynasty with outcomes but no cost group on the leg is absent (no spend, no figure)", () => {
    const { byDynasty } = rollUpLegEvidenceByDynasty(workflows, [], new Map([["sales-cold-email-outreach-lithium", { recipientsContacted: 3 }]]));
    expect(byDynasty.has("sales-cold-email-outreach-lithium")).toBe(false);
  });
});
