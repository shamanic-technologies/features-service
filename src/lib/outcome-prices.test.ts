import { describe, expect, it } from "vitest";
import { legMaturityFigures, outcomeFigures, type LegMaturityFigures } from "./maturity.js";
import { meetingBookedPrice, pickLegPrice, websiteVisitPrice } from "./outcome-prices.js";
import { buildMeetingLegFleet, MEETING_BOOKING_LEG_KEY } from "./meeting-leg-fleet.js";
import type { WorkflowMetadata } from "./public-stats-clients.js";

const REPLY = "start_to_conversation";
const VISIT = "start_to_website_visit";

/** A workflow's figures on a leg: flash $/outcomes, and a mature half (null = the cut holds nothing). */
function wf(legKey: string, flash: [number, number, number], mature: [number, number, number] | null): LegMaturityFigures {
  return legMaturityFigures(legKey, outcomeFigures(...flash), mature ? outcomeFigures(...mature) : null);
}

describe("pickLegPrice", () => {
  it("prices on the cheapest MATURE workflow even when a young one reads cheaper on flash", () => {
    const byDynasty = new Map([
      // mature: 2 mature replies on $100 → $50
      ["leader", wf(REPLY, [140, 1000, 3], [100, 800, 2])],
      // young: 1 reply on $10 flash, nothing mature
      ["young", wf(REPLY, [10, 50, 1], [0, 0, 0])],
    ]);
    const leg = pickLegPrice({ legKey: REPLY, featureSlug: "sales-cold-email-outreach", byDynasty, excluded: new Set(), campaignCount: 4 });
    expect(leg).toMatchObject({ basis: "mature", workflowDynastySlug: "leader", costPerOutcomeUsd: 50, matureWorkflowCount: 1 });
  });

  it("falls back to the best FLASH figure when no workflow is mature", () => {
    const byDynasty = new Map([
      ["a", wf(VISIT, [30, 500, 3], [5, 50, 1])], // 1 mature visit < 10 → not mature
      ["b", wf(VISIT, [20, 400, 4], null)],
    ]);
    const leg = pickLegPrice({ legKey: VISIT, featureSlug: "sales-cold-email-outreach", byDynasty, excluded: new Set(), campaignCount: 2 });
    expect(leg).toMatchObject({ basis: "flash", workflowDynastySlug: "b", costPerOutcomeUsd: 5, matureWorkflowCount: 0 });
  });

  it("a deprecated workflow never competes", () => {
    const byDynasty = new Map([
      ["dead", wf(REPLY, [10, 100, 5], [10, 100, 5])],
      ["live", wf(REPLY, [300, 1000, 3], [300, 1000, 3])],
    ]);
    const leg = pickLegPrice({ legKey: REPLY, featureSlug: "x", byDynasty, excluded: new Set(["dead"]), campaignCount: 2 });
    expect(leg.workflowDynastySlug).toBe("live");
    expect(leg.costPerOutcomeUsd).toBe(100);
  });

  it("unmeasured with a named reason, never a price, when nothing produced an outcome", () => {
    const zero = new Map([["a", wf(REPLY, [50, 200, 0], [40, 150, 0])]]);
    expect(pickLegPrice({ legKey: REPLY, featureSlug: "x", byDynasty: zero, excluded: new Set(), campaignCount: 3 })).toMatchObject({
      costPerOutcomeUsd: null,
      basis: null,
      unmeasuredReason: "no_workflow_with_outcomes",
    });
    expect(pickLegPrice({ legKey: REPLY, featureSlug: "x", byDynasty: new Map(), excluded: new Set(), campaignCount: 0 })).toMatchObject({
      unmeasuredReason: "no_campaigns_on_leg",
    });
  });
});

describe("the two outcome prices", () => {
  const replyLeg = pickLegPrice({
    legKey: REPLY,
    featureSlug: "sales-cold-email-outreach",
    byDynasty: new Map([["r", wf(REPLY, [120, 1000, 2], [120, 1000, 2])]]), // $60 per reply, mature
    excluded: new Set(),
    campaignCount: 1,
  });
  const meetingFigures = outcomeFigures(8, 40, 10); // 10 meetings of 40 conversations = 25%, $0.80 each
  const meetingLeg = pickLegPrice({
    legKey: MEETING_BOOKING_LEG_KEY,
    featureSlug: "ai-meeting-booking",
    byDynasty: new Map([["m", legMaturityFigures(MEETING_BOOKING_LEG_KEY, meetingFigures, meetingFigures)]]),
    excluded: new Set(),
    campaignCount: 1,
  });

  it("meetings = reply cost ÷ meeting rate + the meeting leg's own cost per meeting", () => {
    const price = meetingBookedPrice(replyLeg, meetingLeg);
    // $60 / 0.25 = $240 of replies per meeting, + $0.80
    expect(price.arithmetic).toEqual({ replyCostUsd: 60, meetingRatePct: 25, repliesCostPerMeetingUsd: 240, meetingLegCostUsd: 0.8 });
    expect(price.priceUsd).toBeCloseTo(240.8, 10);
    expect(price.maturity).toBe("mature"); // 10 meetings meets the leg's bar of 10
  });

  it("is early as soon as ONE leg is priced on flash", () => {
    const young = outcomeFigures(8, 40, 9);
    const youngLeg = pickLegPrice({
      legKey: MEETING_BOOKING_LEG_KEY,
      featureSlug: "ai-meeting-booking",
      byDynasty: new Map([["m", legMaturityFigures(MEETING_BOOKING_LEG_KEY, young, young)]]),
      excluded: new Set(),
      campaignCount: 1,
    });
    expect(youngLeg.basis).toBe("flash");
    expect(meetingBookedPrice(replyLeg, youngLeg).maturity).toBe("early");
  });

  it("an unmeasured leg makes the meetings price unmeasured, never a partial sum", () => {
    const none = pickLegPrice({ legKey: MEETING_BOOKING_LEG_KEY, featureSlug: "x", byDynasty: new Map(), excluded: new Set(), campaignCount: 0 });
    expect(meetingBookedPrice(replyLeg, none)).toMatchObject({ priceUsd: null, maturity: null, unmeasuredReason: "leg_unmeasured", arithmetic: null });
  });

  it("website visits read the visit leg verbatim", () => {
    const visitLeg = pickLegPrice({
      legKey: VISIT,
      featureSlug: "sales-cold-email-outreach",
      byDynasty: new Map([["v", wf(VISIT, [30, 500, 12], [24, 400, 12])]]),
      excluded: new Set(),
      campaignCount: 1,
    });
    expect(websiteVisitPrice(visitLeg)).toEqual({ maturity: "mature", priceUsd: 2, unmeasuredReason: null });
  });
});

describe("buildMeetingLegFleet", () => {
  const workflows = [
    { workflowSlug: "rhodium", workflowDynastySlug: "rhodium" },
    { workflowSlug: "rhodium-v2", workflowDynastySlug: "rhodium" },
    { workflowSlug: "osmium", workflowDynastySlug: "osmium" },
  ] as WorkflowMetadata[];
  const cost = (campaignId: string, workflowSlug: string, cents: number) => ({
    dimensions: { campaignId, workflowSlug },
    totalCostInUsdCents: String(cents),
    runCount: 1,
    minStartedAt: null,
    maxStartedAt: null,
  });

  it("attributes each campaign's answered leads and meetings to its dynasty, counts a person once, and leaves a mixed campaign out", () => {
    const fleet = buildMeetingLegFleet({
      campaigns: [
        { campaignId: "c1", orgId: "o1", brandId: "b1" },
        { campaignId: "c2", orgId: "o1", brandId: "b1" },
        { campaignId: "c3", orgId: "o2", brandId: "b2" },
      ],
      workflows,
      costGroups: [cost("c1", "rhodium", 300), cost("c1", "rhodium-v2", 100), cost("c2", "rhodium", 100), cost("c3", "rhodium", 50), cost("c3", "osmium", 50)],
      pairs: new Map([
        ["b1", { actedByCampaign: new Map([["c1", new Set(["l1", "l2"])], ["c2", new Set(["l2", "l3"])]]), meetingLeadIds: new Set(["l2"]) }],
        ["b2", { actedByCampaign: new Map([["c3", new Set(["x"])]]), meetingLeadIds: new Set(["x"]) }],
      ]),
    });
    expect(fleet.unattributableCampaignIds).toEqual(["c3"]);
    const rhodium = new Map(fleet.byDynasty).get("rhodium")!;
    // $5 spent, 3 distinct leads answered (l2 once), 1 meeting
    expect(rhodium.flash).toEqual({ spentUsd: 5, contacted: 3, outcomes: 1, costPerOutcomeUsd: 5, conversionRatePct: 100 / 3 });
    expect(rhodium.mature).toEqual(rhodium.flash);
    expect(rhodium.isMature).toBe(false);
    expect(new Map(fleet.byDynasty).has("osmium")).toBe(false);
  });
});
