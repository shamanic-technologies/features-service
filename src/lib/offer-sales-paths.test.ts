import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import {
  buildOfferSalesPaths,
  campaignNameKeyOf,
  combinationKeyOf,
  DEFAULT_COST_PER_OUTCOME_USD,
  enumerateSalesPaths,
  MANAGED_CHANNEL_SLUGS,
  platformChannelsForLeg,
  priceKey,
  resolveLegChannelCost,
  type LegChannelPrice,
  type SalesPathChannelInput,
  withCampaignRois,
  outcomesForCreditOn,
  withSalesPathNames,
} from "./offer-sales-paths.js";
import type { EffectiveArrowRate } from "./effective-conversion-rates.js";
import { priceFromLadder } from "../routes/offer-sales-paths.js";
import type { LadderBody } from "./leg-ladder.js";

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
  candidates: [],
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
    // 3 chains; the two conversation chains run on either cold-email channel → 2 + 2 + 1 combinations.
    expect(body.paths).toHaveLength(5);
    const rois = body.paths.map((p) => p.roi!);
    expect([...rois].sort((a, b) => b - a)).toEqual(rois);
    for (const p of body.paths) {
      const sum = p.legs.reduce((s, l) => s + (l.costPerPayingClientUsd ?? 0), 0);
      expect(p.costPerPayingClientUsd).toBeCloseTo(sum, 9);
      expect(p.roi).toBeCloseTo(2000 / sum, 9);
    }
    // Meeting path: needed attended = 4, booked = 5, replies = 10 → 10 × $10 + 5 × $4 = $120.
    const meeting = body.paths.find((p) => p.legKeys.length === 4 && p.entryChannelSlug === "cold-email-2")!;
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

  it("one row per combination: each candidate channel ranked on its own, uniquely keyed, the leg's channel stated", () => {
    const body = buildOfferSalesPaths({
      ...base,
      legKeys: ["start_to_conversation", "conversation_to_meeting_booked", "meeting_booked_to_meeting_attended", "meeting_attended_to_paid_client"],
    });
    expect(body.paths.map((p) => [p.rank, p.combinationKey, p.costPerPayingClientUsd])).toEqual([
      [
        1,
        "start_to_conversation@cold-email-2+conversation_to_meeting_booked@pilot+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client",
        120,
      ],
      // Same chain, the costlier entry channel: 10 replies × $20 + 5 bookings × $4 = $220.
      [
        2,
        "start_to_conversation@cold-email+conversation_to_meeting_booked@pilot+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client",
        220,
      ],
    ]);
    // Both rows share the CHAIN, never the identity; the name is the route's (null out of the pure build).
    expect(new Set(body.paths.map((p) => p.pathKey)).size).toBe(1);
    expect(body.paths.every((p) => p.name === null)).toBe(true);
    const [best, alt] = body.paths;
    expect(best.entryChannelSlug).toBe("cold-email-2");
    expect(best.legs[0].channel!.choice).toBe("cheapest_cost_per_outcome");
    expect(alt.entryChannelSlug).toBe("cold-email");
    expect(alt.legs[0].channel!).toMatchObject({ slug: "cold-email", choice: "alternative_channel" });
    expect(alt.legs[0].channel!.candidates.map((c) => c.slug)).toEqual(["cold-email", "cold-email-2"]);
    expect(alt.legs[1].channel!).toMatchObject({ slug: "pilot", choice: "only_priced_channel" });
    expect(alt.legs[2].channel).toBeNull();
    expect(alt.roi).toBeCloseTo(2000 / 220, 9);
  });

  it("names every row from the shared name map, and refuses to serve a row left unnamed", () => {
    const body = buildOfferSalesPaths({ ...base, legKeys: ["start_to_conversation", "conversation_to_paid_client"] });
    const names = new Map(body.paths.map((p, i) => [p.combinationKey, ["Victory", "Sol"][i]]));
    expect(withSalesPathNames(body, names, new Map()).paths.map((p) => [p.rank, p.name])).toEqual([
      [1, "Victory"],
      [2, "Sol"],
    ]);
    expect(() => withSalesPathNames(body, new Map([[body.paths[0].combinationKey, "Victory"]]), new Map())).toThrow(/has no name/);
  });

  it("names each leg's campaign (channel × leg) from the campaign map; a channel not in it reads null", () => {
    const body = buildOfferSalesPaths({ ...base, legKeys: ["start_to_conversation", "conversation_to_paid_client"] });
    expect(body.paths[0].legs[0].channel!.campaignName).toBeNull(); // the pure build names nothing
    const names = new Map(body.paths.map((p, i) => [p.combinationKey, ["Victory", "Sol"][i]]));
    const entry = body.paths[0].legs[0];
    const campaigns = new Map([[campaignNameKeyOf(entry.channel!.slug!, entry.legKey), "Nova"]]);
    const named = withSalesPathNames(body, names, campaigns);
    expect(named.paths[0].legs[0].channel!.campaignName).toBe("Nova");
    for (const p of named.paths) for (const l of p.legs) {
      if (l.channel && !(l.channel.slug === entry.channel!.slug && l.legKey === entry.legKey)) expect(l.channel.campaignName).toBeNull();
    }
  });

  it("keys a campaign in its own namespace, never equal to any combination key", () => {
    expect(campaignNameKeyOf("meta-ads", "start_to_form_submitted")).toBe("campaign:meta-ads|start_to_form_submitted");
    expect(campaignNameKeyOf("meta-ads", "start_to_form_submitted")).not.toBe(
      combinationKeyOf([{ legKey: "start_to_form_submitted", channelSlug: "meta-ads" }]),
    );
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

describe("priceFromLadder — the best MATURE workflow prices the expected ROI (owner 2026-10-05, #1360)", () => {
  const mature = (cost: number) => ({ isMature: true, mature: { costPerOutcomeUsd: cost } });
  const learning = { isMature: false, mature: { costPerOutcomeUsd: null } };
  type Row = NonNullable<LadderBody["rows"]>[number];
  const row = (slug: string, flash: number, grains: Row["estimatesByGrain"], extra: Partial<Row> = {}): Row => ({
    audienceId: null,
    workflow: { workflowDynastySlug: slug },
    resolved: { grain: "crossOrg", costPerOutcomeUsd: flash },
    estimatesByGrain: grains,
    legAssignment: { selectable: true },
    ...extra,
  });

  it("a cheaper LEARNING workflow stays the recommendation, the leg is priced on the best mature one (prod 2026-10-05: keel $4.53 flash vs nobelium $44.83 mature)", () => {
    const body = {
      recommendedWorkflowDynastySlug: "keel",
      rows: [
        row("keel", 4.53, { crossOrg: learning }),
        row("nobelium", 44.83, { crossOrg: mature(44.83) }),
        row("azalea", 73, { brand: learning, crossOrg: mature(73) }),
        // Mature but not assigned to the leg, or retired: never "our best workflow".
        row("osprey", 36.3, { crossOrg: mature(36.3) }, { legAssignment: { selectable: false } }),
        row("old", 30, { crossOrg: mature(30) }, { retired: true }),
        // An audience row never prices the leg.
        { ...row("cheap-cell", 1, { crossOrg: mature(1) }), audienceId: "a" },
      ],
    };
    expect(priceFromLadder(200, body)).toEqual({ costPerOutcomeUsd: 44.83, workflowDynastySlug: "nobelium", grain: "crossOrg", unpricedReason: null });
    // The ladder answer itself is untouched: the recommendation is still the learning workflow.
    expect(body.recommendedWorkflowDynastySlug).toBe("keel");
  });

  it("finest grain holding a mature price first (offer > brand > crossOrg), cheapest within it", () => {
    expect(
      priceFromLadder(200, {
        recommendedWorkflowDynastySlug: "a",
        rows: [
          row("a", 5, { crossOrg: mature(5) }),
          row("b", 20, { brand: mature(20), crossOrg: mature(4) }),
          row("c", 15, { brand: mature(15) }),
        ],
      }),
    ).toEqual({ costPerOutcomeUsd: 15, workflowDynastySlug: "c", grain: "brand", unpricedReason: null });
  });

  it("no mature workflow = no workflow price (the leg falls to fleet / default), with the reason", () => {
    expect(priceFromLadder(200, { recommendedWorkflowDynastySlug: "keel", rows: [row("keel", 4.53, { crossOrg: learning })] })).toEqual({
      costPerOutcomeUsd: null,
      workflowDynastySlug: null,
      grain: null,
      unpricedReason: "no_mature_workflow",
    });
    expect(priceFromLadder(404, { reason: "leg_not_declared" }).unpricedReason).toBe("leg_not_declared");
    expect(priceFromLadder(200, { recommendedWorkflowDynastySlug: null, unmeasuredReason: "no_active_workflows" }).unpricedReason).toBe(
      "no_active_workflows",
    );
    // A cold-start pick names a workflow to run, never a leg price: its explore-allowance floor is ignored.
    expect(
      priceFromLadder(200, {
        recommendedWorkflowDynastySlug: "rhodium",
        recommendationBasis: "cold_start",
        unmeasuredReason: "no_evidence",
        rows: [{ audienceId: null, workflow: { workflowDynastySlug: "rhodium" }, resolved: { grain: null, costPerOutcomeUsd: 3 } }],
      }),
    ).toEqual({ costPerOutcomeUsd: null, workflowDynastySlug: null, grain: null, unpricedReason: "no_evidence" });
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

describe("withCampaignRois", () => {
  const ALL = [
    "start_to_conversation",
    "conversation_to_meeting_booked",
    "meeting_booked_to_meeting_attended",
    "meeting_attended_to_paid_client",
    "conversation_to_paid_client",
    "start_to_website_visit",
    "website_visit_to_signup",
    "signup_to_paid_client",
  ];
  const body = buildOfferSalesPaths({ ...base, legKeys: ALL });
  const byKey = (b: ReturnType<typeof withCampaignRois>) => new Map(b.campaigns!.map((c) => [c.campaignKey, c]));
  const pathsUsing = (slug: string, legKey: string) =>
    body.paths.filter((p) => p.legs.some((l) => l.legKey === legKey && l.channel?.slug === slug));

  it("a campaign's ROI is the BEST roi among the selected paths that run it, naming that path", () => {
    const selected = body.paths.map((p) => p.combinationKey);
    const out = withCampaignRois(body, { stated: true, combinationKeys: selected, statedAt: "2026-10-05T00:00:00Z" });
    expect(out.selectedSalesPaths!.basis).toBe("customer_selected");
    const pilot = byKey(out).get(campaignNameKeyOf("pilot", "conversation_to_meeting_booked"))!;
    const using = pathsUsing("pilot", "conversation_to_meeting_booked");
    expect(pilot.pathCount).toBe(using.length);
    expect(pilot.selectedPathCount).toBe(using.length);
    expect(pilot.roi).toBe(Math.max(...using.map((p) => p.roi!)));
    expect(using.find((p) => p.combinationKey === pilot.roiCombinationKey)!.roi).toBe(pilot.roi);
    expect(pilot.reactive).toBe(true);
    expect(pilot.roiUnavailableReason).toBeNull();
  });

  it("reads ONLY the selected paths: an unselected path never lends its ROI", () => {
    const pilotPaths = pathsUsing("pilot", "conversation_to_meeting_booked");
    const worst = pilotPaths[pilotPaths.length - 1];
    const out = withCampaignRois(body, { stated: true, combinationKeys: [worst.combinationKey, "gone@x"], statedAt: null });
    const rows = byKey(out);
    const pilot = rows.get(campaignNameKeyOf("pilot", "conversation_to_meeting_booked"))!;
    expect(pilot.roi).toBe(worst.roi);
    expect(pilot.selectedPathCount).toBe(1);
    const visits = rows.get(campaignNameKeyOf("visits", "start_to_website_visit"))!;
    expect(visits.roi).toBeNull();
    expect(visits.roiUnavailableReason).toBe("not_on_a_selected_path");
    expect(out.selectedSalesPaths!.unlistedCombinationKeys).toEqual(["gone@x"]);
  });

  it("never stated = the paths returning more than they cost (roi > 1)", () => {
    const cheap = buildOfferSalesPaths({ ...base, legKeys: ALL, lifetimeRevenueUsd: 150 });
    const out = withCampaignRois(cheap, { stated: false, combinationKeys: null, statedAt: null });
    expect(out.selectedSalesPaths!.basis).toBe("default_roi_above_1");
    expect(out.selectedSalesPaths!.combinationKeys).toEqual(cheap.paths.filter((p) => p.roi! > 1).map((p) => p.combinationKey));
    expect(out.selectedSalesPaths!.combinationKeys.length).toBeLessThan(cheap.paths.length);
  });

  it("an unreadable selection states it on every campaign, never a guessed ROI", () => {
    const out = withCampaignRois(body, null);
    expect(out.selectedSalesPaths!.basis).toBe("unavailable");
    expect(out.campaigns!.every((c) => c.roi === null && c.roiUnavailableReason === "selected_paths_unavailable")).toBe(true);
  });

  it("a selected path with no ROI passes its own reason on", () => {
    const noLtr = buildOfferSalesPaths({ ...base, legKeys: ALL, lifetimeRevenueUsd: null });
    const out = withCampaignRois(noLtr, { stated: true, combinationKeys: noLtr.paths.map((p) => p.combinationKey), statedAt: null });
    expect(out.campaigns!.every((c) => c.roiUnavailableReason === "no_lifetime_revenue")).toBe(true);
  });

  it("outcomesForCredit = floor(credit ÷ the leg's cost) on the SAME path as the roi", () => {
    const out = withCampaignRois(body, { stated: true, combinationKeys: body.paths.map((p) => p.combinationKey), statedAt: null }, 100);
    for (const c of out.campaigns!) {
      const o = c.outcomesForCredit;
      expect(o.creditUsd).toBe(100);
      expect(o.combinationKey).toBe(c.roiCombinationKey);
      const leg = body.paths.find((p) => p.combinationKey === o.combinationKey)!.legs.find((l) => l.legKey === c.legKey)!;
      if (leg.workedBy === "human") {
        expect(o.unavailableReason).toBe("no_platform_cost");
        continue;
      }
      expect(o.costPerOutcomeUsd).toBe(leg.costPerOutcomeUsd);
      expect(o.outcomes).toBe(Math.floor(100 / leg.costPerOutcomeUsd! + 1e-9));
      expect(o.unavailableReason).toBeNull();
    }
    const visits = byKey(out).get(campaignNameKeyOf("visits", "start_to_website_visit"))!;
    expect(visits.outcomesForCredit.outcomes).toBeGreaterThan(0);
  });

  it("outcomesForCredit follows the credit asked, and states why it is missing", () => {
    const selected = { stated: true, combinationKeys: body.paths.map((p) => p.combinationKey), statedAt: null };
    const at100 = byKey(withCampaignRois(body, selected)).get(campaignNameKeyOf("visits", "start_to_website_visit"))!;
    const at250 = byKey(withCampaignRois(body, selected, 250)).get(campaignNameKeyOf("visits", "start_to_website_visit"))!;
    expect(at100.outcomesForCredit.creditUsd).toBe(100);
    expect(at250.outcomesForCredit.outcomes).toBe(Math.floor(250 / at250.outcomesForCredit.costPerOutcomeUsd! + 1e-9));
    expect(at250.roi).toBe(at100.roi);
    const none = withCampaignRois(body, null);
    expect(none.campaigns!.every((c) => c.outcomesForCredit.outcomes === null && c.outcomesForCredit.unavailableReason === "selected_paths_unavailable")).toBe(true);
    const unselected = byKey(withCampaignRois(body, { stated: true, combinationKeys: [], statedAt: null })).get(campaignNameKeyOf("visits", "start_to_website_visit"))!;
    expect(unselected.outcomesForCredit.unavailableReason).toBe("not_on_a_selected_path");
  });

  it("outcomesForCreditOn: exact multiples do not floor down; unpriced leg is named", () => {
    const p = body.paths.find((x) => x.legs.some((l) => l.workedBy === "platform"))!;
    const leg = p.legs.find((l) => l.workedBy === "platform")!;
    const at = (cost: number | null) => outcomesForCreditOn({ ...p, legs: p.legs.map((l) => (l === leg ? { ...l, costPerOutcomeUsd: cost } : l)) }, leg.legKey, 100, "not_on_a_selected_path");
    expect(at(2.5).outcomes).toBe(40);
    expect(at(0.1).outcomes).toBe(1000);
    expect(at(2.4).outcomes).toBe(41);
    expect(at(150).outcomes).toBe(0);
    expect(at(null)).toMatchObject({ outcomes: null, unavailableReason: "leg_cost_unavailable" });
  });

  it("orders proactive before reactive, then ROI descending, a null ROI last", () => {
    const out = withCampaignRois(body, { stated: true, combinationKeys: body.paths.slice(0, 2).map((p) => p.combinationKey), statedAt: null });
    const c = out.campaigns!;
    const firstReactive = c.findIndex((x) => x.reactive);
    expect(c.slice(firstReactive).every((x) => x.reactive)).toBe(true);
    for (const group of [c.slice(0, firstReactive), c.slice(firstReactive)]) {
      const rois = group.map((x) => x.roi);
      const firstNull = rois.indexOf(null);
      const priced = (firstNull === -1 ? rois : rois.slice(0, firstNull)) as number[];
      expect([...priced].sort((a, b) => b - a)).toEqual(priced);
      if (firstNull !== -1) expect(rois.slice(firstNull).every((r) => r === null)).toBe(true);
    }
    expect(new Set(c.map((x) => x.campaignKey)).size).toBe(c.length);
  });
});
