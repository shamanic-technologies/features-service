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
    // The route states the entry leg's rate: it is read, not the fleet's.
    expect(expectedTargetFigures(route, PAID, FLEET, null).conversionRatePct).toBeCloseTo(0.05, 9);
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
  it("a group: the Target most campaigns state, ties to the most recent", () => {
    expect(groupChartTarget([{ target: PAID, createdAt: "2026-10-01" }, { target: REPLY, createdAt: "2026-11-01" }])?.step).toBe("conversation");
    expect(groupChartTarget([{ target: PAID, createdAt: "2026-10-01" }, { target: PAID, createdAt: "2026-10-02" }, { target: REPLY, createdAt: "2026-11-01" }])?.step).toBe("paid_client");
    expect(groupChartTarget([{ target: null, createdAt: "2026-10-01" }])).toBeNull();
  });
});
