import { describe, expect, it } from "vitest";
import {
  expectedForBrand,
  expectedForCampaign,
  expectedForCombination,
  expectedForOffer,
  withAudienceExpectedReturns,
  withMeasuredReturn,
  type OfferExpectedModel,
} from "./expected-return.js";
import type { OfferSalesPathsBody, SalesPath } from "./offer-sales-paths.js";
import type { AudienceStatsEnvelope } from "./audience-stats-compute.js";

type LegIn = { legKey: string; to: string; slug: string | null; cost: number | null; costSource: "workflow" | "fleet_measured" | "default" | null; rateSource: "fleet_median" | "industry_default" | "customer_stated" | "measured_on_our_leads"; reactive?: boolean };

const path = (combinationKey: string, roi: number | null, legs: LegIn[]): SalesPath =>
  ({
    rank: 0,
    combinationKey,
    roi,
    roiUnavailableReason: roi === null ? "leg_cost_unavailable" : null,
    legs: legs.map((l) => ({
      legKey: l.legKey,
      reactive: l.reactive ?? false,
      toStep: { key: l.to },
      rateSource: l.rateSource,
      costSource: l.costSource,
      costPerOutcomeUsd: l.cost,
      workedBy: l.slug ? "platform" : "human",
      channel: l.slug ? { slug: l.slug } : null,
    })),
  }) as unknown as SalesPath;

const COLD = "sales-cold-email-outreach";
const reply = path("start_to_conversation@cold+conversation_to_paid_client", 6, [
  { legKey: "start_to_conversation", to: "conversation", slug: COLD, cost: 50, costSource: "default", rateSource: "industry_default" },
  { legKey: "conversation_to_paid_client", to: "paid_client", slug: null, cost: null, costSource: null, rateSource: "fleet_median" },
]);
const visit = path("start_to_website_visit@cold+website_visit_to_purchase+purchase_to_paid_client", 9, [
  { legKey: "start_to_website_visit", to: "website_visit", slug: COLD, cost: 1.4, costSource: "fleet_measured", rateSource: "industry_default" },
  { legKey: "website_visit_to_purchase", to: "purchase", slug: null, cost: null, costSource: null, rateSource: "customer_stated" },
  { legKey: "purchase_to_paid_client", to: "paid_client", slug: null, cost: null, costSource: null, rateSource: "measured_on_our_leads" },
]);
const reactive = path("conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_paid_client", 40, [
  { legKey: "conversation_to_meeting_booked", to: "meeting_booked", slug: "ai-meeting-booking", cost: 5, costSource: "workflow", rateSource: "fleet_median", reactive: true },
  { legKey: "meeting_booked_to_paid_client", to: "paid_client", slug: null, cost: null, costSource: null, rateSource: "fleet_median" },
]);
const unpriced = path("start_to_conversation@x+conversation_to_paid_client", null, []);

const model = (paths: SalesPath[], selected: string[], over: Partial<OfferExpectedModel> = {}): OfferExpectedModel => ({
  offerId: "o1",
  body: { paths, status: "ok" } as unknown as OfferSalesPathsBody,
  selected,
  lifetimeRevenueSource: "offer_stated",
  notRunning: false,
  ...over,
});

describe("expected return: which path a scope reads", () => {
  it("an offer reads its best SELECTED proactive path, never an unselected better one", () => {
    const e = expectedForOffer(model([visit, reply, reactive], [reply.combinationKey, reactive.combinationKey]));
    expect(e.roiMultiple).toBe(6);
    expect(e.combinationKey).toBe(reply.combinationKey);
  });

  it("nothing selected: the best proactive path; a reactive one only when no proactive prices", () => {
    expect(expectedForOffer(model([reply, visit, reactive], [])).combinationKey).toBe(visit.combinationKey);
    expect(expectedForOffer(model([reactive, unpriced], [])).combinationKey).toBe(reactive.combinationKey);
  });

  it("a funnel campaign reads its own path (legacy lead_found spelling resolves), else the offer's", () => {
    expect(expectedForCombination(model([reply, visit, reactive], []), reactive.combinationKey).roiMultiple).toBe(40);
    expect(expectedForCombination(model([reply, visit], [reply.combinationKey]), "unknown@x").combinationKey).toBe(reply.combinationKey);
  });

  it("a campaign reads the best path running its channel on its leg, with ITS leg's cost per outcome", () => {
    const e = expectedForCampaign(model([reply, visit], []), COLD, ["start_to_website_visit"]);
    expect(e.roiMultiple).toBe(9);
    expect(e.costPerOutcome).toEqual({ costPerOutcomeUsd: 1.4, legKey: "start_to_website_visit", stepKey: "website_visit", basis: "fleet", source: "fleet_measured" });
  });

  it("a brand reads its best offer among those running a funnel campaign", () => {
    const running = model([reply], [reply.combinationKey]);
    const idle = model([reactive], [], { offerId: "o2", notRunning: true });
    expect(expectedForBrand([running, idle]).roiMultiple).toBe(6);
    expect(expectedForBrand([idle]).roiMultiple).toBe(40);
    expect(expectedForBrand([]).unavailableReason).toBe("no_priced_sales_path");
  });
});

describe("expected return: what it rests on (no fake precision)", () => {
  it("basis = the WEAKEST input; every input listed with its source; the entry rate prices nothing", () => {
    const e = expectedForOffer(model([visit], [visit.combinationKey]));
    // The entry leg's default rate prices nothing, so the weakest input is the fleet-measured cost.
    expect(e.basis).toBe("fleet");
    expect(e.assumptions).toEqual([
      { input: "lifetime_revenue", legKey: null, basis: "stated", source: "offer_stated" },
      { input: "cost", legKey: "start_to_website_visit", basis: "fleet", source: "fleet_measured" },
      { input: "rate", legKey: "website_visit_to_purchase", basis: "stated", source: "customer_stated" },
      { input: "rate", legKey: "purchase_to_paid_client", basis: "measured", source: "measured_on_our_leads" },
    ]);
  });

  it("an offer running nothing says so", () => {
    const e = expectedForOffer(model([reactive], [], { notRunning: true, lifetimeRevenueSource: "fleet_median" }));
    expect(e.assumptions[0]).toEqual({ input: "sales_path", legKey: null, basis: "default", source: "not_running" });
    expect(e.basis).toBe("default");
  });

  it("the scope's own MATURE return wins (basis measured); an immature one never does", () => {
    const m = expectedForOffer(model([reply], [reply.combinationKey]));
    const mature = withMeasuredReturn(m, { isMature: true, mature: { roiMultiple: 2.5 } });
    expect(mature).toMatchObject({ roiMultiple: 2.5, basis: "measured", assumptions: [], combinationKey: null });
    expect(mature.costPerOutcome).toEqual(m.costPerOutcome);
    expect(withMeasuredReturn(m, { isMature: false, mature: { roiMultiple: 2.5 } })).toBe(m);
    expect(withMeasuredReturn(m, { isMature: true, mature: { roiMultiple: null } })).toBe(m);
    expect(withMeasuredReturn(m, null)).toBe(m);
  });

  it("audience rows: each row's own mature return, else the scope's model; the envelope the scope's", () => {
    const m = expectedForOffer(model([reply], [reply.combinationKey]));
    const env = {
      brandProjection: { maturity: { isMature: false, flash: null, mature: null } },
      audiences: [
        { audienceId: "a", projection: { maturity: { isMature: true, flash: null, mature: { returnPerDollar: 3 } } } },
        { audienceId: "b", projection: { maturity: { isMature: false, flash: null, mature: { returnPerDollar: 9 } } } },
      ],
    } as unknown as AudienceStatsEnvelope;
    const out = withAudienceExpectedReturns(env, m) as unknown as { expectedReturn: { roiMultiple: number }; audiences: Array<{ expectedReturn: { roiMultiple: number; basis: string } }> };
    expect(out.expectedReturn.roiMultiple).toBe(6);
    expect(out.audiences.map((a) => [a.expectedReturn.roiMultiple, a.expectedReturn.basis])).toEqual([
      [3, "measured"],
      [6, "default"],
    ]);
  });
});
