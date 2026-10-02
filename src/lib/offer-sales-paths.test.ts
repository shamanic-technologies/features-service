import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import {
  buildOfferSalesPaths,
  DEFAULT_COST_PER_OUTCOME_USD,
  enumerateSalesPaths,
  MANAGED_CHANNEL_SLUGS,
  platformChannelsForLeg,
  priceKey,
  resolveLegChannelCost,
  type LegChannelPrice,
  type SalesPathChannelInput,
} from "./offer-sales-paths.js";
import type { EffectiveArrowRate } from "./effective-conversion-rates.js";
import { priceFromLadder } from "../routes/offer-sales-paths.js";

const arrow = (fromStep: string, toStep: string, pct: number, source: EffectiveArrowRate["source"] = "manual"): EffectiveArrowRate => ({
  fromStep,
  toStep,
  legKey: null,
  catalogueFromStep: null,
  catalogueToStep: null,
  effectiveRatePct: pct,
  source,
  unresolvedReason: null,
  measured: { basis: "our_leads", outcomesCounted: "all", fromReached: 3, toReached: 1, toReachedThroughOtherLegs: 0, ratePct: 33, sufficient: false, gap: "below_learning_bar" },
  manualRatePct: source === "manual" ? pct : null,
  median: { ratePct: null, brandCount: 0 },
  defaultRatePct: 10,
});

const RATES: EffectiveArrowRate[] = [
  arrow("Positive reply", "Meeting booked", 50),
  arrow("Meeting booked", "Meeting attended", 80, "default"),
  arrow("Meeting attended", "Paid client", 25, "median"),
  arrow("Positive reply", "Paid client", 5),
  arrow("Website visit", "Signup", 10),
  arrow("Signup", "Paid client", 20),
];

const CHANNELS: SalesPathChannelInput[] = [
  { slug: "cold-email", name: "Cold email", operatedBy: "platform", trigger: "daily_budget", legKeys: ["start_to_conversation"] },
  { slug: "cold-email-2", name: "Cold email 2", operatedBy: "platform", trigger: "daily_budget", legKeys: ["start_to_conversation"] },
  { slug: "visits", name: "Visits", operatedBy: "platform", trigger: "daily_budget", legKeys: ["start_to_website_visit"] },
  { slug: "pilot", name: "Pilot", operatedBy: "platform", trigger: "daily_budget", legKeys: ["conversation_to_meeting_booked"] },
];

const price = (cost: number | null): LegChannelPrice => ({
  costPerOutcomeUsd: cost,
  workflowDynastySlug: cost === null ? null : "wf",
  grain: cost === null ? null : "crossOrg",
  unpricedReason: cost === null ? "no_recommended_workflow" : null,
});

const PRICES = new Map<string, LegChannelPrice>([
  [priceKey("start_to_conversation", "cold-email"), price(20)],
  [priceKey("start_to_conversation", "cold-email-2"), price(10)],
  [priceKey("start_to_website_visit", "visits"), price(1)],
  [priceKey("conversation_to_meeting_booked", "pilot"), price(4)],
]);

const base = {
  offerId: "o",
  brandId: "b",
  stated: true,
  statedAt: "2026-09-29T00:00:00Z",
  lifetimeRevenueUsd: 2000,
  rates: RATES,
  channels: CHANNELS,
  prices: PRICES,
  // These fixtures use made-up slugs: manage them all, and state no default, so the formula is tested alone.
  managedChannelSlugs: new Set(CHANNELS.map((c) => c.slug)),
  defaultCosts: new Map<string, number>(),
};

describe("enumerateSalesPaths", () => {
  it("builds every chain from an entry leg to paid_client out of the ticked legs only", () => {
    const paths = enumerateSalesPaths([
      "start_to_conversation",
      "conversation_to_meeting_booked",
      "meeting_booked_to_meeting_attended",
      "meeting_attended_to_paid_client",
      "conversation_to_paid_client",
      "start_to_website_visit", // no way on from a visit is ticked
    ]);
    expect(paths.map((p) => p.join("+")).sort()).toEqual([
      "start_to_conversation+conversation_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client",
      "start_to_conversation+conversation_to_paid_client",
    ]);
  });
});

describe("buildOfferSalesPaths", () => {
  it("states the empty states explicitly and invents no path", () => {
    expect(buildOfferSalesPaths({ ...base, stated: false, legKeys: null }).status).toBe("not_stated");
    expect(buildOfferSalesPaths({ ...base, legKeys: [] }).status).toBe("no_legs_selected");
    const none = buildOfferSalesPaths({ ...base, legKeys: ["start_to_conversation", "conversation_to_meeting_booked", "bogus"] });
    expect(none.status).toBe("no_complete_path");
    expect(none.paths).toEqual([]);
    expect(none.unknownLegKeys).toEqual(["bogus"]);
  });

  it("ranks by ROI and the top path's ROI is its own breakdown", () => {
    const body = buildOfferSalesPaths({
      ...base,
      legKeys: [
        "start_to_conversation",
        "conversation_to_meeting_booked",
        "meeting_booked_to_meeting_attended",
        "meeting_attended_to_paid_client",
        "conversation_to_paid_client",
        "start_to_website_visit",
        "website_visit_to_signup",
        "signup_to_paid_client",
      ],
    });
    expect(body.status).toBe("ok");
    expect(body.paths).toHaveLength(3);
    const rois = body.paths.map((p) => p.roi!);
    expect([...rois].sort((a, b) => b - a)).toEqual(rois);
    for (const p of body.paths) {
      const sum = p.legs.reduce((s, l) => s + (l.costPerPayingClientUsd ?? 0), 0);
      expect(p.costPerPayingClientUsd).toBeCloseTo(sum, 9);
      expect(p.roi).toBeCloseTo(2000 / sum, 9);
    }
    // Meeting path: needed attended = 4, booked = 5, replies = 10 → 10 × $10 + 5 × $4 = $120.
    const meeting = body.paths.find((p) => p.legKeys.length === 4)!;
    expect(meeting.costPerPayingClientUsd).toBeCloseTo(120, 9);
    expect(meeting.entryChannelSlug).toBe("cold-email-2");
    expect(meeting.legs[0].channel!.choice).toBe("cheapest_cost_per_outcome");
    expect(meeting.legs[2].workedBy).toBe("human");
    expect(meeting.legs[2].costPerPayingClientUsd).toBeNull();
    expect(meeting.legs[2].rateSource).toBe("industry_default");
    expect(meeting.legs[3].rateSource).toBe("fleet_median");
    expect(meeting.entryToPayingClientPct).toBeCloseTo(10, 9);
    // Direct close: 20 replies × $10 = $200. Signup path: 50 visits × $1 = $50 → best.
    expect(body.paths[0].pathKey).toBe("start_to_website_visit+website_visit_to_signup+signup_to_paid_client");
    expect(body.paths[0].roi).toBeCloseTo(40, 9);
  });

  it("never prices an unpriced platform leg as free, and states no ROI without a lifetime revenue", () => {
    const unpriced = buildOfferSalesPaths({
      ...base,
      prices: new Map([[priceKey("start_to_conversation", "cold-email"), price(null)]]),
      legKeys: ["start_to_conversation", "conversation_to_paid_client"],
    });
    expect(unpriced.paths[0].roi).toBeNull();
    expect(unpriced.paths[0].roiUnavailableReason).toBe("leg_cost_unavailable");
    expect(unpriced.paths[0].legs[0].channel!.choice).toBe("no_priced_channel");

    const noLtr = buildOfferSalesPaths({ ...base, lifetimeRevenueUsd: null, legKeys: ["start_to_conversation", "conversation_to_paid_client"] });
    expect(noLtr.paths[0].costPerPayingClientUsd).toBeCloseTo(200, 9);
    expect(noLtr.paths[0].roiUnavailableReason).toBe("no_lifetime_revenue");
  });
});

describe("priceFromLadder", () => {
  it("reads the recommended workflow's brand row, and states why when there is none", () => {
    expect(
      priceFromLadder(200, {
        recommendedWorkflowDynastySlug: "alioth",
        rows: [
          { audienceId: "a", workflow: { workflowDynastySlug: "alioth" }, resolved: { grain: "audience", costPerOutcomeUsd: 1 } },
          { audienceId: null, workflow: { workflowDynastySlug: "alioth" }, resolved: { grain: "brand", costPerOutcomeUsd: 7 } },
        ],
      }),
    ).toEqual({ costPerOutcomeUsd: 7, workflowDynastySlug: "alioth", grain: "brand", unpricedReason: null });
    expect(priceFromLadder(404, { reason: "leg_not_declared" }).unpricedReason).toBe("leg_not_declared");
    expect(priceFromLadder(200, { recommendedWorkflowDynastySlug: null, unmeasuredReason: "no_active_workflows" }).unpricedReason).toBe(
      "no_active_workflows",
    );
  });
});

describe("the managed-channel rule (owner 2026-09-29)", () => {
  const REAL: SalesPathChannelInput[] = [
    { slug: "sales-cold-email-outreach", name: "Cold email", operatedBy: "platform", trigger: "daily_budget", legKeys: ["start_to_conversation"] },
    { slug: "cold-sms-outreach", name: "Cold SMS", operatedBy: "platform", trigger: "daily_budget", legKeys: ["start_to_conversation"] },
    { slug: "ai-meeting-booking", name: "AI booking", operatedBy: "platform", trigger: "step_reached", legKeys: ["conversation_to_meeting_booked"] },
    { slug: "agency-meeting-booking", name: "Agency booking", operatedBy: "platform", trigger: "step_reached", legKeys: ["conversation_to_meeting_booked"] },
    { slug: "ai-instant-call", name: "AI call", operatedBy: "platform", trigger: "step_reached", legKeys: ["conversation_to_booking_call"] },
    { slug: "agency-meeting-attendance", name: "Attendance", operatedBy: "platform", trigger: "daily_budget", legKeys: ["meeting_booked_to_meeting_attended"] },
    { slug: "agency-closing-calls", name: "Closing", operatedBy: "platform", trigger: "daily_budget", legKeys: ["meeting_attended_to_paid_client"] },
  ];

  it("is exactly the three channels we manage", () => {
    expect([...MANAGED_CHANNEL_SLUGS].sort()).toEqual(["ai-instant-call", "ai-meeting-booking", "sales-cold-email-outreach"]);
    expect(platformChannelsForLeg(REAL, "start_to_conversation").map((c) => c.slug)).toEqual(["sales-cold-email-outreach"]);
    expect(platformChannelsForLeg(REAL, "conversation_to_meeting_booked").map((c) => c.slug)).toEqual(["ai-meeting-booking"]);
    expect(platformChannelsForLeg(REAL, "meeting_attended_to_paid_client")).toEqual([]);
  });

  it("prices every path of the prod offer: unmanaged legs are the customer's team, missing workflows fall to fleet then default", () => {
    const body = buildOfferSalesPaths({
      offerId: "o",
      brandId: "b",
      stated: true,
      statedAt: null,
      lifetimeRevenueUsd: 5000,
      rates: [
        arrow("Positive reply", "Meeting booked", 30),
        arrow("Positive reply", "Booking call", 40),
        arrow("Booking call", "Meeting booked", 50),
        arrow("Meeting booked", "Meeting attended", 80),
        arrow("Meeting attended", "Paid client", 25),
      ],
      channels: REAL,
      prices: new Map<string, LegChannelPrice>([
        [priceKey("start_to_conversation", "sales-cold-email-outreach"), price(44.83)],
        [priceKey("conversation_to_meeting_booked", "ai-meeting-booking"), { ...price(null), unpricedReason: "no_eligible_workflow" }],
        [priceKey("conversation_to_booking_call", "ai-instant-call"), { ...price(null), unpricedReason: "leg_not_declared" }],
      ]),
      fleetPrices: new Map([[priceKey("conversation_to_meeting_booked", "ai-meeting-booking"), 7.5]]),
      legKeys: [
        "start_to_conversation",
        "conversation_to_meeting_booked",
        "conversation_to_booking_call",
        "booking_call_to_meeting_booked",
        "meeting_booked_to_meeting_attended",
        "meeting_attended_to_paid_client",
      ],
    });
    expect(body.paths.length).toBe(2);
    for (const p of body.paths) {
      expect(p.roi).not.toBeNull();
      expect(p.roiUnavailableReason).toBeNull();
      const byKey = new Map(p.legs.map((l) => [l.legKey, l]));
      expect(byKey.get("start_to_conversation")!.costSource).toBe("workflow");
      expect(byKey.get("meeting_booked_to_meeting_attended")!.workedBy).toBe("human");
      expect(byKey.get("meeting_attended_to_paid_client")!.workedBy).toBe("human");
    }
    const viaAi = body.paths.find((p) => p.legKeys.includes("conversation_to_meeting_booked"))!;
    const booking = viaAi.legs.find((l) => l.legKey === "conversation_to_meeting_booked")!;
    expect(booking.costSource).toBe("fleet_measured");
    expect(booking.costPerOutcomeUsd).toBe(7.5);
    expect(booking.channel!.candidates.map((c) => c.slug)).toEqual(["ai-meeting-booking"]);
    expect(booking.channel!.candidates[0].workflowUnpricedReason).toBe("no_eligible_workflow");
    const viaCall = body.paths.find((p) => p.legKeys.includes("conversation_to_booking_call"))!;
    const call = viaCall.legs.find((l) => l.legKey === "conversation_to_booking_call")!;
    expect(call.costSource).toBe("default");
    expect(call.costPerOutcomeUsd).toBe(DEFAULT_COST_PER_OUTCOME_USD.get(priceKey("conversation_to_booking_call", "ai-instant-call")));
    expect(viaCall.legs.find((l) => l.legKey === "booking_call_to_meeting_booked")!.workedBy).toBe("human");
  });
});

describe("resolveLegChannelCost", () => {
  it("workflow > fleet measured > default, and never a zero", () => {
    expect(resolveLegChannelCost(price(10), 7, 5)).toEqual({ costPerOutcomeUsd: 10, costSource: "workflow" });
    expect(resolveLegChannelCost(price(null), 7, 5)).toEqual({ costPerOutcomeUsd: 7, costSource: "fleet_measured" });
    expect(resolveLegChannelCost(undefined, undefined, 5)).toEqual({ costPerOutcomeUsd: 5, costSource: "default" });
    expect(resolveLegChannelCost(price(0), 0, undefined)).toEqual({ costPerOutcomeUsd: null, costSource: null });
  });

  it("seeds a default for every leg a managed channel publishes", () => {
    for (const k of DEFAULT_COST_PER_OUTCOME_USD.keys()) expect(MANAGED_CHANNEL_SLUGS.has(k.split("|")[1])).toBe(true);
    expect(DEFAULT_COST_PER_OUTCOME_USD.has(priceKey("conversation_to_booking_call", "ai-instant-call"))).toBe(true);
    expect(DEFAULT_COST_PER_OUTCOME_USD.has(priceKey("conversation_to_meeting_booked", "ai-meeting-booking"))).toBe(true);
    expect(DEFAULT_COST_PER_OUTCOME_USD.has(priceKey("start_to_conversation", "sales-cold-email-outreach"))).toBe(true);
  });
});
