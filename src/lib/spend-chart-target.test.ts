import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { campaignChartTarget, expectedTargetFigures, groupChartTarget, type ChartTarget } from "./spend-chart-target.js";
import { expectedForCombination, expectedRouteOf, withMeasuredReturn, type ExpectedRouteLeg, type OfferExpectedModel } from "./expected-return.js";
import type { OfferSalesPathsBody } from "./offer-sales-paths.js";

// SPEND-CHART-TARGET-1108 (owner 2026-11-08): a campaign's "Spend, day by day" counts its TARGET.
const COLD = "sales-cold-email-outreach";
const leg = (over: Partial<ExpectedRouteLeg> & Pick<ExpectedRouteLeg, "legKey" | "fromStep" | "toStep">): ExpectedRouteLeg => ({
  channelSlug: null,
  ratePct: null,
  rateBasis: null,
  costPerOutcomeUsd: 0,
  costBasis: null,
  ...over,
});
// Wide Email's shape: cold email $50 a positive reply, the client's team closes 5% of them.
const ROUTE: ExpectedRouteLeg[] = [
  leg({ legKey: "lead_found_to_conversation", channelSlug: COLD, fromStep: "lead_found", toStep: "conversation", costPerOutcomeUsd: 50, costBasis: "fleet" }),
  leg({ legKey: "conversation_to_paid_client", fromStep: "conversation", toStep: "paid_client", ratePct: 5, rateBasis: "stated" }),
];
const PAID: ChartTarget = { step: "paid_client", fromStep: "lead_found", source: "campaign_target" };
const REPLY: ChartTarget = { step: "conversation", fromStep: "lead_found", source: "campaign_target" };
const FLEET = new Map([["start_to_conversation|sales-cold-email-outreach", 0.8]]);

describe("expected Target figures off the model's route", () => {
  it("Target Paid client: $50 / 5% = $1,000 a paying client; 0.8% x 5% = 0.04% of leads found", () => {
    const e = expectedTargetFigures(ROUTE, PAID, FLEET, null);
    expect(e.costPerOutcomeUsd).toBeCloseTo(1000, 9);
    // The weakest input: the fleet's cost beside a stated rate.
    expect(e.costPerOutcomeBasis).toBe("fleet");
    expect(e.conversionRatePct).toBeCloseTo(0.04, 9);
    expect(e.conversionBasis).toBe("fleet");
    expect(e.conversionSource).toBe("expected_route_fleet_entry");
  });

  it("Target Positive reply (regression): the leg's own $50 and the fleet's entry conversion", () => {
    const e = expectedTargetFigures(ROUTE, REPLY, FLEET, null);
    expect(e.costPerOutcomeUsd).toBe(50);
    expect(e.conversionRatePct).toBe(0.8);
  });

  it("no fleet conversion: the seeded entry default (1% to a positive reply)", () => {
    const e = expectedTargetFigures(ROUTE, PAID, new Map(), null);
    expect(e.conversionRatePct).toBeCloseTo(0.05, 9);
    expect(e.conversionBasis).toBe("default");
  });

  it("a route from Start with sourcing: C(to) = C(from) / rate + leg cost (full absorption)", () => {
    const route = [
      leg({ legKey: "start_to_lead_found", channelSlug: "lead-sourcing", fromStep: null, toStep: "lead_found", costPerOutcomeUsd: 0.02, costBasis: "default" }),
      leg({ ...ROUTE[0]!, ratePct: 1, rateBasis: "default" }),
      ROUTE[1]!,
    ];
    expect(expectedTargetFigures(route, REPLY, FLEET, null).costPerOutcomeUsd).toBeCloseTo(0.02 / 0.01 + 50, 9);
    expect(expectedTargetFigures(route, PAID, FLEET, null).costPerOutcomeUsd).toBeCloseTo(52 / 0.05, 9);
    // FLEET-ENTRY-ROUTE-1116: the route's entry rate is only a default (Wide Email: industry 1 %): the fleet's measured
    // 0.8 % wins, 0.8 % x 5 % = 0.04 %. A measured fleet rate never loses to a default.
    expect(expectedTargetFigures(route, PAID, FLEET, null)).toMatchObject({ conversionBasis: "fleet", conversionSource: "expected_route_fleet_entry" });
    expect(expectedTargetFigures(route, PAID, FLEET, null).conversionRatePct).toBeCloseTo(0.04, 9);
    // No fleet rate: the route's default is kept.
    expect(expectedTargetFigures(route, PAID, new Map(), null).conversionRatePct).toBeCloseTo(0.05, 9);
    // The brand's own measured (or stated) entry rate is better than the fleet's: it is read.
    const own = [route[0]!, { ...route[1]!, ratePct: 2, rateBasis: "measured" as const }, route[2]!];
    expect(expectedTargetFigures(own, PAID, FLEET, null).conversionRatePct).toBeCloseTo(0.1, 9);
  });

  it("never a figure off another step: no route, a Target off the route, an unpriced leg each say why", () => {
    expect(expectedTargetFigures(null, PAID, FLEET, "expected_model_computing")).toMatchObject({ costPerOutcomeUsd: null, costPerOutcomeUnavailableReason: "expected_model_computing", conversionRatePct: null });
    expect(expectedTargetFigures(ROUTE, { ...PAID, step: "meeting_booked" }, FLEET, null)).toMatchObject({ costPerOutcomeUsd: null, costPerOutcomeUnavailableReason: "target_not_on_expected_route" });
    const unpriced = [{ ...ROUTE[0]!, costPerOutcomeUsd: null }, ROUTE[1]!];
    expect(expectedTargetFigures(unpriced, PAID, FLEET, null)).toMatchObject({ costPerOutcomeUsd: null, costPerOutcomeUnavailableReason: "route_leg_unpriced" });
    expect(expectedTargetFigures(ROUTE, { step: "paid_client", fromStep: null, source: "campaign_target" }, FLEET, null).conversionUnavailableReason).toBe("no_entry_population");
  });
});

describe("the model's route rides its expected figure (off the wire)", () => {
  const model: OfferExpectedModel = {
    offerId: "o1",
    body: { paths: [], status: "ok" } as unknown as OfferSalesPathsBody,
    selected: [],
    lifetimeRevenueSource: "offer_stated",
    notRunning: false,
    inputs: {
      lifetimeRevenueUsd: 1000,
      rates: [{ legKey: "conversation_to_paid_client", effectiveRatePct: 5, source: "manual", measured: { basis: "our_leads" } }] as never,
      prices: new Map(),
      fleetPrices: new Map([["start_to_conversation|sales-cold-email-outreach", 40]]),
      fleetRates: new Map(),
    },
  };

  it("a funnel priced on its own legs: the Paid client Target costs its cost per paying client (ROI = LTR / it)", () => {
    const e = expectedForCombination(model, "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client");
    const route = expectedRouteOf(e);
    expect(route?.map((l) => [l.fromStep, l.toStep, l.costPerOutcomeUsd, l.ratePct])).toEqual([
      [null, "conversation", 40, null],
      ["conversation", "paid_client", 0, 5],
    ]);
    const t = expectedTargetFigures(route, PAID, FLEET, null);
    expect(t.costPerOutcomeUsd).toBeCloseTo(800, 9);
    expect(1000 / t.costPerOutcomeUsd!).toBeCloseTo(e.roiMultiple!, 9);
    // A measured return keeps the model's route (its cost per outcome is the model's too).
    expect(expectedRouteOf(withMeasuredReturn(e, { isMature: true, mature: { roiMultiple: 2 } }))).toBe(route);
  });
});

describe("which Target a chart counts", () => {
  const units = [
    { campaignId: "src", fromStep: null, toStep: "lead_found" },
    { campaignId: "ce", fromStep: "lead_found", toStep: "conversation" },
    { campaignId: "team", fromStep: "conversation", toStep: "paid_client" },
  ];
  it("stated Target first, else the funnel's last step; entry = the chain's first milestone", () => {
    expect(campaignChartTarget("paid_client", "paid_client", units)).toEqual(PAID);
    expect(campaignChartTarget(null, "paid_client", units)).toEqual({ ...PAID, source: "funnel_last_step" });
    expect(campaignChartTarget("conversation", "paid_client", units)).toEqual(REPLY);
    expect(campaignChartTarget(null, null, units)).toBeNull();
  });
  // CAMPAIGN-CONVERSION-1116 (prod 2026-11-16, Wide Email): a proactive campaign whose Target is Paid client also runs a
  // follow-up writer on `start_to_paid_client`. The shortest chain was that one unit, so the chart served "no entry
  // population" over 4,157 leads found. Its people taken in are its Lead found Units.
  it("a proactive campaign with a Start -> Target unit beside its chain counts from Lead found", () => {
    const withFollowUp = [...units, { campaignId: "fu", fromStep: null, toStep: "paid_client" }];
    expect(campaignChartTarget("paid_client", "paid_client", withFollowUp)).toEqual(PAID);
    // Same with the stored "start" spelling, and whatever order the units come in.
    expect(campaignChartTarget("paid_client", null, [{ campaignId: "fu", fromStep: "start", toStep: "paid_client" }, ...units].reverse())).toEqual({ ...PAID, source: "campaign_target" });
    // Its chain to the Target missing a link still counts from its first milestone.
    expect(campaignChartTarget("paid_client", null, [units[0]!, { campaignId: "fu", fromStep: null, toStep: "paid_client" }])?.fromStep).toBe("lead_found");
    // Only a Start -> Target unit: nobody taken in.
    expect(campaignChartTarget("paid_client", null, [{ campaignId: "fu", fromStep: null, toStep: "paid_client" }])?.fromStep).toBeNull();
  });
  it("a reactive campaign keeps its own entry (Reply Booking: from Meeting booked)", () => {
    const reactive = [
      { campaignId: "book", fromStep: "conversation", toStep: "meeting_booked" },
      { campaignId: "attend", fromStep: "meeting_booked", toStep: "meeting_attended" },
      { campaignId: "close", fromStep: "meeting_attended", toStep: "paid_client" },
    ];
    expect(campaignChartTarget("paid_client", null, reactive)?.fromStep).toBe("meeting_booked");
    // A reactive unit landing on the Target from its trigger step: counted from that step (unchanged).
    expect(campaignChartTarget("paid_client", null, [{ campaignId: "x", fromStep: "conversation", toStep: "paid_client" }])?.fromStep).toBe("conversation");
  });
  it("a group: a member with nobody to convert never voids the group's entry", () => {
    const none: ChartTarget = { ...PAID, fromStep: null };
    expect(groupChartTarget([{ target: PAID, createdAt: "2026-10-01" }, { target: none, createdAt: "2026-11-01" }])?.fromStep).toBe("lead_found");
    expect(groupChartTarget([{ target: none, createdAt: "2026-11-01" }])?.fromStep).toBeNull();
  });
  it("a group: the Target most campaigns state, ties to the most recent", () => {
    expect(groupChartTarget([{ target: PAID, createdAt: "2026-10-01" }, { target: REPLY, createdAt: "2026-11-01" }])?.step).toBe("conversation");
    expect(groupChartTarget([{ target: PAID, createdAt: "2026-10-01" }, { target: PAID, createdAt: "2026-10-02" }, { target: REPLY, createdAt: "2026-11-01" }])?.step).toBe("paid_client");
    expect(groupChartTarget([{ target: null, createdAt: "2026-10-01" }])).toBeNull();
  });
});
