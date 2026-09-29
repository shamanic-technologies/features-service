import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import {
  buildOfferSalesPaths,
  enumerateSalesPaths,
  priceKey,
  type LegChannelPrice,
  type SalesPathChannelInput,
} from "./offer-sales-paths.js";
import type { EffectiveArrowRate } from "./effective-conversion-rates.js";
import { priceFromLadder } from "../routes/offer-sales-paths.js";

const arrow = (fromStep: string, toStep: string, pct: number, source: EffectiveArrowRate["source"] = "manual"): EffectiveArrowRate => ({
  fromStep,
  toStep,
  effectiveRatePct: pct,
  source,
  unresolvedReason: null,
  measured: { basis: "our_leads", outcomesCounted: "all", fromReached: 3, toReached: 1, ratePct: 33, sufficient: false, gap: "below_learning_bar" },
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
