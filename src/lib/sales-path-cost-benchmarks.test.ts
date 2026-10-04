import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import {
  acceptedCatalogueChannels,
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
        if (MANAGED_CHANNEL_SLUGS.has(c.slug) || c.operatedBy === "customer") continue;
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

/** The prod offer's ticked legs (Victory's offer, 2026-10-04): a conversation chain and a website chain. */
const TICKED_BOTH_ENTRIES = [
  "start_to_website_visit", "website_visit_to_meeting_booked", "meeting_booked_to_meeting_attended", "website_visit_to_signup",
  "signup_to_paid_client", "start_to_conversation", "conversation_to_meeting_booked", "meeting_attended_to_paid_client",
];

describe("?scope=catalogue", () => {
  const body = build({ legKeys: TICKED_BOTH_ENTRIES });

  it("lists the ticked chains × shortlisted channels, each row unique, every row priced", () => {
    expect(body.scope).toBe("catalogue");
    expect(body.status).toBe("ok");
    const keys = body.paths.map((p) => p.combinationKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(body.paths.length).toBeGreaterThanOrEqual(10);
    for (const p of body.paths) {
      expect(p.roi, p.combinationKey).not.toBeNull();
      for (const l of p.legs) {
        if (l.channel && l.channel.operatedBy === "platform") {
          expect(l.costPerOutcomeUsd, `${p.combinationKey} ${l.legKey}`).not.toBeNull();
          expect(l.costSource).not.toBeNull();
        }
        if (l.fromStep) expect(l.conversionRatePct).not.toBeNull();
      }
    }
    // ROI descending, full stop: a benchmark row is flagged, never moved (owner 2026-10-04).
    for (let i = 1; i < body.paths.length; i++) {
      expect(body.paths[i - 1].roi!).toBeGreaterThanOrEqual(body.paths[i].roi!);
    }
  });

  it("enters through every shortlisted entry channel, never through an agency or unlisted one", () => {
    const entries = new Set(body.paths.map((p) => p.entryChannelSlug));
    for (const s of ["sales-cold-email-outreach", "cold-linkedin-outreach", "cold-call-outreach", "google-ads", "linkedin-ads", "meta-ads"]) {
      expect(entries.has(s), s).toBe(true);
    }
    expect(SALES_PATH_CATALOGUE_CHANNEL_SLUGS.has("seo-content")).toBe(false);
    expect(body.paths.some((p) => p.legs.some((l) => l.channel?.slug === "seo-content"))).toBe(false);
    for (const p of body.paths) {
      for (const l of p.legs) if (l.channel) expect(SALES_PATH_CATALOGUE_CHANNEL_SLUGS.has(l.channel.slug!)).toBe(true);
    }
    expect(body.paths.some((p) => p.legs.some((l) => l.channel?.slug === "ai-meeting-booking"))).toBe(true);
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
    expect(team).toMatchObject({ workedBy: "human", costSource: null, costPerOutcomeUsd: null, costPerPayingClientUsd: null });
    expect(team.channel!).toMatchObject({ operatedBy: "customer", managed: false });
  });

  it("lists only the legs the offer ticked, and keys a default-read row exactly as the default read does", () => {
    for (const p of body.paths) {
      expect(p.ticked).toBe(true);
      for (const l of p.legs) {
        expect(l.ticked).toBe(true);
        expect(TICKED_BOTH_ENTRIES).toContain(l.legKey);
      }
    }
    const defaultRead = build({ scope: "ticked", legKeys: TICKED_BOTH_ENTRIES });
    expect(defaultRead.scope).toBe("ticked");
    const catalogueKeys = new Set(body.paths.map((p) => p.combinationKey));
    for (const p of defaultRead.paths) expect(catalogueKeys.has(p.combinationKey), p.combinationKey).toBe(true);
  });

  it("prefers the fleet's real spend over a benchmark", () => {
    const b = build({ legKeys: TICKED_BOTH_ENTRIES, fleetPrices: new Map([[priceKey("start_to_website_visit", "google-ads"), 3]]) });
    const leg = b.paths.find((p) => p.combinationKey.startsWith("start_to_website_visit@google-ads"))!.legs[0];
    expect(leg).toMatchObject({ costPerOutcomeUsd: 3, costSource: "fleet_measured" });
  });

  it("invents no row when the offer ticked nothing: the default read's status", () => {
    expect(build({ stated: false, legKeys: null })).toMatchObject({ status: "not_stated", paths: [] });
    expect(build({ legKeys: [] })).toMatchObject({ status: "no_legs_selected", paths: [] });
    expect(build({ legKeys: ["start_to_conversation"] })).toMatchObject({ status: "no_complete_path", paths: [] });
  });

  it("prices one combination ONCE whatever the scope (the customer's team costs nothing in both)", () => {
    const d = build({ scope: "ticked", legKeys: TICKED_BOTH_ENTRIES });
    const byKey = new Map(body.paths.map((p) => [p.combinationKey, p]));
    expect(d.paths.length).toBeGreaterThan(0);
    for (const p of d.paths) {
      const c = byKey.get(p.combinationKey)!;
      expect(c.costPerPayingClientUsd! - p.costPerPayingClientUsd!).toBe(0);
      expect(c.roi! - p.roi!).toBe(0);
    }
  });

  it("ranks a benchmark-priced row by its ROI like any other (the flag never moves it)", () => {
    const bench = body.paths.filter((p) => p.pricedOnBenchmark);
    const own = body.paths.filter((p) => !p.pricedOnBenchmark);
    expect(bench.length).toBeGreaterThan(0);
    expect(own.length).toBeGreaterThan(0);
    const bestBench = bench.reduce((a, b) => (a.roi! >= b.roi! ? a : b));
    const outranked = own.filter((p) => p.roi! < bestBench.roi!);
    for (const p of outranked) expect(bestBench.rank).toBeLessThan(p.rank);
  });

  it("lists the self-serve checkout leg only when the offer ticked it", () => {
    expect(body.paths.some((p) => p.legKeys.includes("website_visit_to_purchase"))).toBe(false);
    const withCheckout = build({ legKeys: ["start_to_website_visit", "website_visit_to_purchase", "purchase_to_paid_client"] });
    expect(withCheckout.paths.some((p) => p.legKeys.includes("website_visit_to_purchase"))).toBe(true);
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

describe("the channels an offer accepts (brand-service offer channels, owner 2026-10-04)", () => {
  it("never stated = the three we run; stated = the shortlist ∩ what the offer accepts", () => {
    expect([...acceptedCatalogueChannels({ stated: false, channelSlugs: null })].sort()).toEqual([...MANAGED_CHANNEL_SLUGS].sort());
    expect([...acceptedCatalogueChannels({ stated: true, channelSlugs: ["meta-ads", "seo-content", "agency-x"] })]).toEqual(["meta-ads"]);
    expect(acceptedCatalogueChannels({ stated: true, channelSlugs: [] }).size).toBe(0);
  });

  it("filters the catalogue rows on them: never stated reads the default read's rows at the same prices", () => {
    const legKeys = TICKED_BOTH_ENTRIES;
    const unstated = build({ legKeys, catalogueChannelSlugs: acceptedCatalogueChannels({ stated: false, channelSlugs: null }) });
    const d = build({ scope: "ticked", legKeys });
    expect(unstated.paths.map((p) => p.combinationKey).sort()).toEqual(d.paths.map((p) => p.combinationKey).sort());
    const withMeta = build({ legKeys, catalogueChannelSlugs: acceptedCatalogueChannels({ stated: true, channelSlugs: ["sales-cold-email-outreach", "meta-ads"] }) });
    const used = new Set(withMeta.paths.flatMap((p) => p.legs.map((l) => l.channel?.slug).filter(Boolean)));
    expect([...used].sort()).toEqual(["meta-ads", "sales-cold-email-outreach"]);
  });

  it("states per leg whether it is reactive and the item's minimum", () => {
    const b = build({ legKeys: TICKED_BOTH_ENTRIES });
    const email = b.paths.find((p) => p.entryChannelSlug === "sales-cold-email-outreach")!;
    expect(email.legs[0]).toMatchObject({ reactive: false, minimumMonthlyBudgetCents: 9_900 });
    const meta = b.paths.find((p) => p.entryChannelSlug === "meta-ads")!;
    expect(meta.legs[0]).toMatchObject({ reactive: false, minimumMonthlyBudgetCents: 150_000 });
    for (const p of b.paths) for (const l of p.legs.slice(1)) expect(l.reactive).toBe(true);
  });
});
