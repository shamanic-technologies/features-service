/**
 * THE PUBLISHED CATALOGUE — every acquisition channel a customer can book, with the commercial terms
 * they commit to before anything is measured.
 *
 * The load-bearing properties are not any single channel's numbers but that the catalogue can be READ
 * by a marketing site without interpretation: every channel is bookable (there is no availability flag
 * to consult), every channel states terms and what it produces, the slugs live campaigns and budgets
 * reference did not move, and which funnels a channel sells through is DERIVED rather than a second
 * list that can drift.
 */
import { describe, it, expect, vi } from "vitest";

// `send-forecast-compute` reaches `db/index.js` transitively, which THROWS at import time without
// FEATURES_SERVICE_DATABASE_URL — green locally, red in CI. Nothing here touches the DB.
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { SEED_FEATURES } from "./features.js";
import { CHANNEL_FAMILIES, PRODUCIBLE_STEP_KEYS, sellableFunnelsFor } from "../lib/acquisition-channels.js";
import { coldEmailOutreachSlugs } from "../lib/send-forecast-compute.js";

const bySlug = (slug: string) => SEED_FEATURES.find((f) => f.slug === slug);
/**
 * THE PUBLISHED channels — a channel whose slug is RETIRED (`supersededBySlug`) is still a feature row
 * and still measured, but it is not something a stranger can read or book, so the properties below are
 * asserted of the published set.
 */
const channels = SEED_FEATURES.filter((f) => f.acquisitionChannel != null && f.supersededBySlug == null);

/** The slugs live campaigns, live budgets and the cost ledger already reference. They must not move. */
const PRE_EXISTING_SLUGS = [
  "sales-cold-email-outreach",
  "sales-crm-email-outreach",
  "feedback-request-cold-email-outreach",
  "pr-cold-email-outreach",
  "pr-expert-quote-outreach",
  "pr-expert-quote-opportunities",
];

describe("the published acquisition-channel catalogue", () => {
  it("EVERY feature states whether it is an acquisition channel — none is left for a consumer to guess", () => {
    for (const feature of SEED_FEATURES) {
      expect(feature, feature.slug).toHaveProperty("acquisitionChannel");
      const stated = feature.acquisitionChannel === null || typeof feature.acquisitionChannel === "object";
      expect(stated, feature.slug).toBe(true);
    }
  });

  it("publishes roughly thirty channels, across all three families", () => {
    expect(channels.length).toBeGreaterThanOrEqual(30);
    const families = new Set(channels.map((c) => c.acquisitionChannel!.family));
    expect([...families].sort()).toEqual([...CHANNEL_FAMILIES].sort());
  });

  it("carries every channel the brief names, one slug each", () => {
    const expected = [
      // Outbound, one to one.
      "sales-cold-email-outreach",
      "sales-crm-email-outreach",
      "feedback-request-cold-email-outreach",
      "cold-call-outreach",
      "cold-sms-outreach",
      "cold-whatsapp-outreach",
      "cold-linkedin-outreach",
      "cold-x-outreach",
      "cold-instagram-outreach",
      "cold-reddit-outreach",
      // Paid reach.
      "google-ads",
      "meta-ads",
      "linkedin-ads",
      "tiktok-ads",
      "youtube-ads",
      "x-ads",
      "reddit-ads",
      "bing-ads",
      "quora-ads",
      "newsletter-sponsorships",
      "podcast-sponsorships",
      "creator-sponsorships",
      "paid-directory-listings",
      // Earned.
      "seo-content",
      "press-placements",
      "pr-cold-email-outreach",
      "pr-expert-quote-outreach",
      "podcast-guesting",
      "affiliate-programme",
      "organic-linkedin-publishing",
      "organic-x-publishing",
      "organic-reddit-publishing",
      "organic-youtube-publishing",
    ];
    for (const slug of expected) {
      expect(bySlug(slug), slug).toBeDefined();
      expect(bySlug(slug)!.acquisitionChannel, slug).not.toBeNull();
    }
  });

  it("KEEPS the slugs live campaigns, budgets and the cost ledger already reference", () => {
    for (const slug of PRE_EXISTING_SLUGS) expect(bySlug(slug), slug).toBeDefined();
    // The two live under the legacy `sales-` prefix keep it: renaming them would repoint live rows.
    expect(bySlug("sales-cold-email-outreach")!.slug).toBe("sales-cold-email-outreach");
    expect(bySlug("sales-crm-email-outreach")!.slug).toBe("sales-crm-email-outreach");
  });

  it("no slug is duplicated and no name is reused — `features.name` is UNIQUE in the schema", () => {
    expect(new Set(SEED_FEATURES.map((f) => f.slug)).size).toBe(SEED_FEATURES.length);
    expect(new Set(SEED_FEATURES.map((f) => f.name)).size).toBe(SEED_FEATURES.length);
  });

  it("does NOT widen the cold-email family — no new slug carries that suffix", () => {
    // The fleet audits derive their whole account universe from the `-cold-email-outreach` suffix, so a
    // new slug landing in it would silently enrol the channel in send-forecast / accounts / health.
    const cold = coldEmailOutreachSlugs(SEED_FEATURES.map((f) => f.slug)).sort();
    expect(cold).toEqual(
      [
        "accelerators-cold-email-outreach",
        "feedback-request-cold-email-outreach",
        "hiring-cold-email-outreach",
        "pr-cold-email-outreach",
        "sales-cold-email-outreach",
        "vc-cold-email-outreach",
      ].sort(),
    );
  });
});

describe("a RETIRED slug keeps working but is never published", () => {
  const retired = SEED_FEATURES.filter((f) => f.supersededBySlug != null);

  it("EVERY feature states whether its slug is retired — absence can never be mistaken for a retirement", () => {
    for (const feature of SEED_FEATURES) {
      expect(feature, feature.slug).toHaveProperty("supersededBySlug");
      const stated = feature.supersededBySlug === null || typeof feature.supersededBySlug === "string";
      expect(stated, feature.slug).toBe(true);
    }
  });

  it("the expert-quote offering is published EXACTLY ONCE, under the current spelling", () => {
    const published = channels.filter((c) => c.slug.includes("expert-quote"));
    expect(published.map((c) => c.slug)).toEqual(["pr-expert-quote-outreach"]);

    // The retired spelling keeps its row, its terms and its measurement — live campaigns, live budgets
    // and the cost ledger reference it, so nothing about it moves except that it is not published.
    const dead = bySlug("pr-expert-quote-opportunities")!;
    expect(dead.supersededBySlug).toBe("pr-expert-quote-outreach");
    expect(dead.acquisitionChannel).not.toBeNull();
    expect(dead.acquisitionChannel!.terms).toEqual(bySlug("pr-expert-quote-outreach")!.acquisitionChannel!.terms);
  });

  it("every retired slug names a successor that is itself PUBLISHED and current", () => {
    for (const feature of retired) {
      const successor = bySlug(feature.supersededBySlug!);
      expect(successor, `${feature.slug} → ${feature.supersededBySlug}`).toBeDefined();
      expect(successor!.supersededBySlug, successor!.slug).toBeNull();
      expect(channels.map((c) => c.slug)).toContain(successor!.slug);
    }
  });

  it("no slug is retired in favour of itself", () => {
    for (const feature of retired) expect(feature.supersededBySlug, feature.slug).not.toBe(feature.slug);
  });
});

describe("every published channel is BOOKABLE — no coming-soon state", () => {
  it("is implemented and active, whatever we still have to build behind it", () => {
    for (const channel of channels) {
      expect(channel.implemented, channel.slug).toBe(true);
      expect(channel.status, channel.slug).toBe("active");
    }
  });

  it("carries NO availability flag — slowness is expressed in the terms, never hidden behind a boolean", () => {
    for (const channel of channels) {
      const blob = channel.acquisitionChannel as unknown as Record<string, unknown>;
      expect(Object.keys(blob).sort(), channel.slug).toEqual(["family", "producibleSteps", "terms"]);
      for (const banned of ["available", "comingSoon", "beta", "enabled", "launched"]) {
        expect(blob, `${channel.slug} must not carry ${banned}`).not.toHaveProperty(banned);
      }
    }
  });

  it("a channel we are slower to deliver SAYS SO through its own terms", () => {
    // Cold calling puts a person on the line all day whatever the volume; cold email does not.
    const call = bySlug("cold-call-outreach")!.acquisitionChannel!.terms;
    const email = bySlug("sales-cold-email-outreach")!.acquisitionChannel!.terms;
    expect(call.dailyOperatingCostCents).toBeGreaterThan(email.dailyOperatingCostCents);

    // SEO has to be published and indexed before it produces anything, and is worth nothing by the week.
    const seo = bySlug("seo-content")!.acquisitionChannel!.terms;
    expect(seo.maxDaysToFirstProduction).toBeGreaterThan(email.maxDaysToFirstProduction);
    expect(seo.minimumCommitmentDays).toBeGreaterThan(email.minimumCommitmentDays);

    // LinkedIn imposes its own daily floor; the terms carry it rather than hiding it.
    const linkedinAds = bySlug("linkedin-ads")!.acquisitionChannel!.terms;
    expect(linkedinAds.dailyOperatingCostCents).toBeGreaterThan(bySlug("x-ads")!.acquisitionChannel!.terms.dailyOperatingCostCents);
  });

  it("Google Ads states the SAME daily floor the product accepts — $5/day, and nothing else moves", () => {
    // billing-service takes a new Google Ads brand from $5/day. A buyer reads the published operating cost
    // and the minimum they may state as one thing: what it takes to run this channel for a day. Publishing
    // two numbers for that is one channel contradicting itself, so this figure IS that floor.
    expect(bySlug("google-ads")!.acquisitionChannel!.terms.dailyOperatingCostCents).toBe(500);

    // And it is the LOW mark of paid reach BECAUSE Google imposes no floor of its own: a channel whose
    // figure encodes a real standing cost — a person on the line, a platform's own imposed minimum —
    // still stands above it. That is the ordering the figure carries, not a family-wide uniform price.
    const google = bySlug("google-ads")!.acquisitionChannel!.terms.dailyOperatingCostCents;
    expect(bySlug("cold-call-outreach")!.acquisitionChannel!.terms.dailyOperatingCostCents).toBeGreaterThan(google);
    expect(bySlug("linkedin-ads")!.acquisitionChannel!.terms.dailyOperatingCostCents).toBeGreaterThan(google);
  });
});

describe("the commercial terms a buyer commits to", () => {
  it("every channel states all three, as whole numbers", () => {
    for (const channel of channels) {
      const t = channel.acquisitionChannel!.terms;
      expect(Number.isInteger(t.dailyOperatingCostCents), channel.slug).toBe(true);
      expect(t.dailyOperatingCostCents, channel.slug).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(t.minimumCommitmentDays), channel.slug).toBe(true);
      // A booking of zero days is not a booking.
      expect(t.minimumCommitmentDays, channel.slug).toBeGreaterThan(0);
      expect(Number.isInteger(t.maxDaysToFirstProduction), channel.slug).toBe(true);
      expect(t.maxDaysToFirstProduction, channel.slug).toBeGreaterThanOrEqual(0);
    }
  });

  it("the promise fits inside the commitment — we never sell a booking that ends before it can produce", () => {
    for (const channel of channels) {
      const t = channel.acquisitionChannel!.terms;
      expect(t.maxDaysToFirstProduction, channel.slug).toBeLessThanOrEqual(t.minimumCommitmentDays);
    }
  });
});

describe("what each channel can produce, and what follows from it", () => {
  it("every channel produces at least one known step", () => {
    for (const channel of channels) {
      const steps = channel.acquisitionChannel!.producibleSteps;
      expect(steps.length, channel.slug).toBeGreaterThan(0);
      expect(new Set(steps).size, channel.slug).toBe(steps.length);
      for (const step of steps) expect(PRODUCIBLE_STEP_KEYS, `${channel.slug} → ${step}`).toContain(step);
    }
  });

  it("all four kinds are in play across the catalogue — including the two produced ON the platform", () => {
    const produced = new Set(channels.flatMap((c) => c.acquisitionChannel!.producibleSteps));
    for (const key of PRODUCIBLE_STEP_KEYS) expect([...produced], key).toContain(key);
  });

  it("`salesFunnels` is DERIVED from what the channel produces — one fact, never two lists", () => {
    for (const feature of SEED_FEATURES) {
      const expected = feature.acquisitionChannel
        ? sellableFunnelsFor(feature.acquisitionChannel.producibleSteps)
        : [];
      expect(feature.salesFunnels, feature.slug).toEqual(expected);
    }
  });

  it("a cold call sells the conversation chain ALONE — there is no link in a phone call", () => {
    expect(bySlug("cold-call-outreach")!.acquisitionChannel!.producibleSteps).toEqual(["conversation"]);
    expect(bySlug("cold-call-outreach")!.salesFunnels).toEqual(["sales_meetings_from_conversation"]);
  });

  it("the three live email channels keep the exact answer they shipped with", () => {
    expect(bySlug("sales-cold-email-outreach")!.salesFunnels).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
      "website_purchases",
      "form_magnet",
    ]);
    expect(bySlug("sales-crm-email-outreach")!.salesFunnels).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
      "website_purchases",
      "form_magnet",
    ]);
    expect(bySlug("feedback-request-cold-email-outreach")!.salesFunnels).toEqual([
      "sales_meetings_from_conversation",
    ]);
  });
});

describe("the catalogue reads as a price list a buyer can act on", () => {
  it("every channel carries a name, a description and the questions it needs answered", () => {
    for (const channel of channels) {
      expect(channel.name.length, channel.slug).toBeGreaterThan(0);
      expect(channel.description.length, channel.slug).toBeGreaterThan(0);
      expect((channel.inputs as unknown[]).length, channel.slug).toBeGreaterThan(0);
    }
  });

  it("carries no em-dash in buyer-facing copy", () => {
    for (const channel of channels) {
      expect(channel.name, channel.slug).not.toContain("—");
      expect(channel.description, channel.slug).not.toContain("—");
      for (const input of channel.inputs as Array<{ label: string; placeholder?: string }>) {
        expect(input.label, channel.slug).not.toContain("—");
        expect(input.placeholder ?? "", channel.slug).not.toContain("—");
      }
    }
  });
});
