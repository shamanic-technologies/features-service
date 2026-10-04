import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import {
  buildOfferSalesPaths,
  enumerateSalesPaths,
  legChannelsForScope,
  MANAGED_CHANNEL_SLUGS,
  priceKey,
  type LegChannelPrice,
  type SalesPathChannelInput,
} from "./offer-sales-paths.js";
import { SALES_PATH_CATALOGUE_CHANNEL_SLUGS, SALES_PATH_COST_BENCHMARKS } from "./sales-path-cost-benchmarks.js";
import { FUNNEL_LEGS, FUNNEL_LEG_KEYS } from "./funnel-legs.js";
import { buildChannelCatalogue } from "./channel-catalogue.js";
import { SEED_FEATURES } from "../seed/features.js";
import type { EffectiveArrowRate } from "./effective-conversion-rates.js";
import { defaultLegRatePct } from "./default-leg-rates.js";
import type { ChannelStepKey } from "./acquisition-channels.js";

const CATALOGUE: SalesPathChannelInput[] = buildChannelCatalogue(SEED_FEATURES).map((c) => ({
  slug: c.slug,
  name: c.name,
  operatedBy: c.operatedBy,
  trigger: c.trigger,
  legKeys: c.stepTransitions.map((t) => t.legKey),
}));

/** Every non-entry catalogue leg at its industry default, the way `getBrandEffectiveRates` serves an unmeasured brand. */
const DEFAULT_RATES: EffectiveArrowRate[] = FUNNEL_LEGS.filter((l) => l.fromStep).map((l) => {
  const pct = defaultLegRatePct(l.fromStep!.key as ChannelStepKey, l.toStep.key as ChannelStepKey)!;
  return {
    fromStep: l.fromStep!.label,
    toStep: l.toStep.label,
    legKey: l.legKey,
    catalogueFromStep: l.fromStep!.key,
    catalogueToStep: l.toStep.key,
    effectiveRatePct: pct,
    source: "default",
    unresolvedReason: null,
    measured: { basis: "our_leads", outcomesCounted: "all", fromReached: 0, toReached: 0, toReachedThroughOtherLegs: 0, ratePct: null, sufficient: false, gap: "below_learning_bar" },
    manualRatePct: null,
    median: { ratePct: null, brandCount: 0 },
    defaultRatePct: pct,
  } as EffectiveArrowRate;
});

const build = (over: Partial<Parameters<typeof buildOfferSalesPaths>[0]> = {}) =>
  buildOfferSalesPaths({
    offerId: "o",
    brandId: "b",
    stated: true,
    statedAt: "2026-10-04T00:00:00Z",
    legKeys: ["start_to_conversation", "conversation_to_meeting_booked", "meeting_booked_to_meeting_attended", "meeting_attended_to_paid_client"],
    lifetimeRevenueUsd: 5000,
    rates: DEFAULT_RATES,
    channels: CATALOGUE,
    prices: new Map<string, LegChannelPrice>(),
    fleetPrices: new Map(),
    scope: "catalogue",
    ...over,
  });

describe("the catalogue shortlist", () => {
  it("names only channels the catalogue publishes, and no agency channel", () => {
    const slugs = new Set(CATALOGUE.map((c) => c.slug));
    for (const s of SALES_PATH_CATALOGUE_CHANNEL_SLUGS) {
      expect(slugs.has(s)).toBe(true);
      expect(s.startsWith("agency-")).toBe(false);
    }
    for (const s of MANAGED_CHANNEL_SLUGS) expect(SALES_PATH_CATALOGUE_CHANNEL_SLUGS.has(s)).toBe(true);
  });

  it("has a sourced benchmark for every (leg, channel we do not run) the shortlist publishes", () => {
    for (const legKey of FUNNEL_LEG_KEYS) {
      for (const c of legChannelsForScope(CATALOGUE, legKey, "catalogue")) {
        if (MANAGED_CHANNEL_SLUGS.has(c.slug)) continue;
        const b = SALES_PATH_COST_BENCHMARKS.get(priceKey(legKey, c.slug));
        expect(b, `${legKey}|${c.slug}`).toBeDefined();
        expect(b!.costPerOutcomeUsd).toBeGreaterThan(0);
        expect(b!.source.length).toBeGreaterThan(20);
      }
    }
  });

  it("has no customer-team leg with two shortlisted customer channels (a bare key would collide)", () => {
    for (const legKey of FUNNEL_LEG_KEYS) {
      const team = legChannelsForScope(CATALOGUE, legKey, "catalogue").filter((c) => c.operatedBy === "customer");
      expect(team.length, legKey).toBeLessThanOrEqual(1);
    }
  });
});

describe("?scope=catalogue", () => {
  const body = build();

  it("lists every catalogue chain × shortlisted channel, each row unique, every row priced", () => {
    expect(body.scope).toBe("catalogue");
    expect(body.status).toBe("ok");
    const keys = body.paths.map((p) => p.combinationKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(body.paths.length).toBeGreaterThanOrEqual(40);
    for (const p of body.paths) {
      expect(p.roi, p.combinationKey).not.toBeNull();
      for (const l of p.legs) {
        if (l.channel) {
          expect(l.costPerOutcomeUsd, `${p.combinationKey} ${l.legKey}`).not.toBeNull();
          expect(l.costSource).not.toBeNull();
        }
        if (l.fromStep) expect(l.conversionRatePct).not.toBeNull();
      }
    }
    // Ranked by ROI.
    for (let i = 1; i < body.paths.length; i++) expect(body.paths[i - 1].roi!).toBeGreaterThanOrEqual(body.paths[i].roi!);
  });

  it("enters through every shortlisted entry channel, never through an agency or unlisted one", () => {
    const entries = new Set(body.paths.map((p) => p.entryChannelSlug));
    for (const s of ["sales-cold-email-outreach", "cold-linkedin-outreach", "cold-call-outreach", "google-ads", "linkedin-ads", "meta-ads", "seo-content"]) {
      expect(entries.has(s), s).toBe(true);
    }
    for (const p of body.paths) {
      for (const l of p.legs) if (l.channel) expect(SALES_PATH_CATALOGUE_CHANNEL_SLUGS.has(l.channel.slug!)).toBe(true);
    }
    expect(body.paths.some((p) => p.legs.some((l) => l.channel?.slug === "ai-instant-call"))).toBe(true);
    expect(body.paths.some((p) => p.legs.some((l) => l.channel?.slug === "your-team-closing-calls"))).toBe(true);
  });

  it("says per leg whether we run the channel, and cites a benchmark where it priced one", () => {
    const google = body.paths.find((p) => p.entryChannelSlug === "google-ads")!;
    expect(google.legs[0].channel).toMatchObject({ managed: false, operatedBy: "platform", costSource: "benchmark" });
    expect(google.legs[0].channel!.costBenchmarkSource).toMatch(/WordStream/);
    expect(google.legs[0].workedBy).toBe("platform");
    const email = body.paths.find((p) => p.entryChannelSlug === "sales-cold-email-outreach")!;
    expect(email.legs[0].channel).toMatchObject({ managed: true, costSource: "default", costBenchmarkSource: null });
    const team = body.paths.flatMap((p) => p.legs).find((l) => l.channel?.slug === "your-team-closing-calls")!;
    expect(team).toMatchObject({ workedBy: "human", costSource: "benchmark" });
    expect(team.channel!.operatedBy).toBe("customer");
  });

  it("flags the chains the offer ticked, and keys a ticked row exactly as the default read does", () => {
    const ticked = body.paths.filter((p) => p.ticked);
    expect(ticked.length).toBeGreaterThan(0);
    expect(body.paths.some((p) => !p.ticked)).toBe(true);
    const defaultRead = build({ scope: "ticked" });
    expect(defaultRead.scope).toBe("ticked");
    const catalogueKeys = new Set(body.paths.map((p) => p.combinationKey));
    for (const p of defaultRead.paths) expect(catalogueKeys.has(p.combinationKey), p.combinationKey).toBe(true);
  });

  it("prefers the fleet's real spend over a benchmark", () => {
    const b = build({ fleetPrices: new Map([[priceKey("start_to_website_visit", "google-ads"), 3]]) });
    const leg = b.paths.find((p) => p.combinationKey.startsWith("start_to_website_visit@google-ads"))!.legs[0];
    expect(leg).toMatchObject({ costPerOutcomeUsd: 3, costSource: "fleet_measured" });
  });

  it("serves the combinatory even when the offer ticked nothing", () => {
    const b = build({ stated: false, legKeys: null });
    expect(b.status).toBe("ok");
    expect(b.paths.length).toBe(body.paths.length);
    expect(b.paths.every((p) => !p.ticked)).toBe(true);
  });

  it("leaves the default read's population alone: managed channels only", () => {
    const d = build({ scope: "ticked" });
    for (const p of d.paths) for (const l of p.legs) if (l.channel) expect(MANAGED_CHANNEL_SLUGS.has(l.channel.slug!)).toBe(true);
    expect(d.paths.every((p) => p.ticked)).toBe(true);
  });

  it("enumerates over the whole leg catalogue", () => {
    expect(enumerateSalesPaths(FUNNEL_LEG_KEYS).length).toBeGreaterThan(5);
  });
});
