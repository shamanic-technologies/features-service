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
import {
  CHANNEL_FAMILIES,
  CHANNEL_STEP_KEYS,
  producibleStepsOf,
  sellableFunnelsFor,
} from "../lib/acquisition-channels.js";
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

  it("publishes roughly forty channels, across all four families", () => {
    expect(channels.length).toBeGreaterThanOrEqual(40);
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
      // Conversion — the legs a human performs once a lead is already on the chain, published twice
      // over: once run by a specialist of ours, once run by the customer themselves.
      "managed-meeting-booking",
      "in-house-meeting-booking",
      "managed-meeting-attendance",
      "in-house-meeting-attendance",
      "managed-closing-calls",
      "founder-led-closing",
      "managed-signup-conversion",
      "in-house-signup-conversion",
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
      expect(Object.keys(blob).sort(), channel.slug).toEqual(["family", "operatedBy", "stepTransitions", "terms"]);
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
  it("every channel performs at least one leg, each between steps it can name", () => {
    for (const channel of channels) {
      const legs = channel.acquisitionChannel!.stepTransitions;
      expect(legs.length, channel.slug).toBeGreaterThan(0);
      const keys = legs.map((t) => `${t.from ?? ""}>${t.to}`);
      expect(new Set(keys).size, channel.slug).toBe(keys.length);
      for (const leg of legs) {
        if (leg.from != null) expect(CHANNEL_STEP_KEYS, `${channel.slug} ← ${leg.from}`).toContain(leg.from);
        expect(CHANNEL_STEP_KEYS, `${channel.slug} → ${leg.to}`).toContain(leg.to);
        expect(leg.from, channel.slug).not.toBe(leg.to);
      }
    }
  });

  it("all four PRODUCED kinds are in play — including the two produced inside an ad unit", () => {
    const produced = new Set(channels.flatMap((c) => producibleStepsOf(c.acquisitionChannel!.stepTransitions)));
    for (const key of ["conversation", "website_visit", "in_ad_form_submission", "in_ad_booked_meeting"]) {
      expect([...produced], key).toContain(key);
    }
  });

  it("`salesFunnels` is DERIVED from the legs the channel performs — one fact, never two lists", () => {
    for (const feature of SEED_FEATURES) {
      const expected = feature.acquisitionChannel
        ? sellableFunnelsFor(feature.acquisitionChannel.stepTransitions)
        : [];
      expect(feature.salesFunnels, feature.slug).toEqual(expected);
    }
  });

  it("a cold call sells the conversation chain ALONE — there is no link in a phone call", () => {
    expect(bySlug("cold-call-outreach")!.acquisitionChannel!.stepTransitions).toEqual([
      { from: null, to: "conversation" },
    ]);
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

describe("A CHAIN IS SOLD LEG BY LEG — a channel states where it picks a lead up, not only what it makes", () => {
  const legStarters = channels.filter((c) =>
    c.acquisitionChannel!.stepTransitions.some((t) => t.from != null),
  );

  it("publishes channels whose starting step is NOT the beginning of a chain", () => {
    expect(legStarters.length).toBeGreaterThan(0);
    // And they are genuinely sellable — a leg that sold through nothing would be a page nobody can buy.
    for (const channel of legStarters) {
      expect(channel.salesFunnels.length, channel.slug).toBeGreaterThan(0);
    }
  });

  it("the three legs of a meeting chain are three separate things to buy", () => {
    // Booking it, getting it held, and closing it. Each has its own channel, its own budget and its own
    // stats, which is the entire reason the catalogue had to stop describing only entry steps.
    expect(bySlug("managed-meeting-booking")!.acquisitionChannel!.stepTransitions).toEqual([
      { from: "conversation", to: "meeting_booked" },
      { from: "website_visit", to: "meeting_booked" },
    ]);
    expect(bySlug("managed-meeting-attendance")!.acquisitionChannel!.stepTransitions).toEqual([
      { from: "meeting_booked", to: "meeting_attended" },
    ]);
    expect(bySlug("managed-closing-calls")!.acquisitionChannel!.stepTransitions).toEqual([
      { from: "meeting_attended", to: "paid_client" },
    ]);

    // Both meeting chains share every leg after the meeting is booked, so those two sell both.
    expect(bySlug("managed-meeting-attendance")!.salesFunnels).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
    ]);
    expect(bySlug("managed-closing-calls")!.salesFunnels).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
    ]);
  });

  it("closing a self-serve lead sells the two self-serve chains, and neither meeting chain", () => {
    expect(bySlug("managed-signup-conversion")!.salesFunnels).toEqual(["website_purchases", "form_magnet"]);
    expect(bySlug("in-house-signup-conversion")!.salesFunnels).toEqual(["website_purchases", "form_magnet"]);
  });

  it("a channel that performs only an internal leg produces NOTHING, and that is a real answer", () => {
    for (const slug of ["managed-closing-calls", "founder-led-closing", "managed-meeting-attendance"]) {
      expect(producibleStepsOf(bySlug(slug)!.acquisitionChannel!.stepTransitions), slug).toEqual([]);
    }
  });

  it("EVERY leg a channel states is a leg some deployed chain actually takes", () => {
    // Otherwise it would be a channel we sell that moves a lead somewhere no chain goes.
    for (const channel of channels) {
      const sellable = channel.salesFunnels;
      const internal = channel.acquisitionChannel!.stepTransitions.filter((t) => t.from != null);
      if (internal.length > 0) expect(sellable.length, channel.slug).toBeGreaterThan(0);
    }
  });
});

describe("WHO operates a channel, and why a zero daily cost is a statement rather than a blank", () => {
  it("every channel says who puts the hours in", () => {
    for (const channel of channels) {
      expect(["platform", "customer"], channel.slug).toContain(channel.acquisitionChannel!.operatedBy);
    }
  });

  it("a CUSTOMER-operated channel costs the platform nothing, and says exactly zero", () => {
    // We do not put anyone on it, so there is no day of ours to charge for. Inventing a flat figure to
    // make the family look uniform would publish a price nobody set. What the leg costs THEM is stated
    // per lead against lead-service, and is legitimately zero for plenty of customers.
    const customerRun = channels.filter((c) => c.acquisitionChannel!.operatedBy === "customer");
    expect(customerRun.length).toBeGreaterThan(0);
    for (const channel of customerRun) {
      expect(channel.acquisitionChannel!.terms.dailyOperatingCostCents, channel.slug).toBe(0);
    }
  });

  it("the SAME leg is sold both ways, and only the platform-run one carries a day of ours", () => {
    const pairs: Array<[string, string]> = [
      ["managed-meeting-booking", "in-house-meeting-booking"],
      ["managed-meeting-attendance", "in-house-meeting-attendance"],
      ["managed-closing-calls", "founder-led-closing"],
      ["managed-signup-conversion", "in-house-signup-conversion"],
    ];
    for (const [ours, theirs] of pairs) {
      const a = bySlug(ours)!;
      const b = bySlug(theirs)!;
      // Same leg, same sellable chains — the only difference is who does the work and what it costs.
      expect(a.acquisitionChannel!.stepTransitions, theirs).toEqual(b.acquisitionChannel!.stepTransitions);
      expect(a.salesFunnels, theirs).toEqual(b.salesFunnels);
      expect(a.acquisitionChannel!.operatedBy, ours).toBe("platform");
      expect(b.acquisitionChannel!.operatedBy, theirs).toBe("customer");
      expect(a.acquisitionChannel!.terms.dailyOperatingCostCents, ours).toBeGreaterThan(0);
      expect(b.acquisitionChannel!.terms.dailyOperatingCostCents, theirs).toBe(0);
    }
  });

  it("every channel that FINDS people is operated by the platform — a zero there would be a hole", () => {
    for (const channel of channels) {
      const findsPeople = channel.acquisitionChannel!.stepTransitions.some((t) => t.from == null);
      if (findsPeople) expect(channel.acquisitionChannel!.operatedBy, channel.slug).toBe("platform");
    }
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
