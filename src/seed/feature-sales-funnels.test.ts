/**
 * THE CATALOGUE ANSWERS, PER FEATURE, WHICH SALES FUNNELS IT MAY BE SOLD THROUGH.
 *
 * Two consumers read that answer — the dashboard, to offer only valid (funnel, feature) pairs, and
 * campaign-service, to refuse an invalid one — so the load-bearing property is not any single row but
 * that "sells through NONE" and "sells through ALL" are two written statements a consumer can tell
 * apart. A feature left unstated would be read as one or the other by accident, which is exactly the
 * pair of nonsense offers this exists to prevent.
 */
import { describe, it, expect, vi } from "vitest";

// `send-forecast-compute` reaches `db/index.js` transitively, which THROWS at import time without
// FEATURES_SERVICE_DATABASE_URL — green locally, red in CI. Nothing here touches the DB.
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { SEED_FEATURES } from "./features.js";
import { SALES_FUNNEL_KEYS, matchSalesFunnelKey } from "../lib/sales-funnels.js";
import { FUNNEL_REGISTRY } from "../lib/funnel-registry.js";
import { coldEmailOutreachSlugs } from "../lib/send-forecast-compute.js";

const FEEDBACK_SLUG = "feedback-request-cold-email-outreach";
const SALES_SLUG = "sales-cold-email-outreach";

const bySlug = (slug: string) => SEED_FEATURES.find((f) => f.slug === slug);

describe("per-feature sales funnels", () => {
  it("EVERY feature states an answer — none is left for a consumer to guess", () => {
    for (const feature of SEED_FEATURES) {
      expect(Array.isArray(feature.salesFunnels), feature.slug).toBe(true);
    }
  });

  it("states only funnels brand-service owns — no funnel is invented here", () => {
    for (const feature of SEED_FEATURES) {
      for (const key of feature.salesFunnels) {
        expect(SALES_FUNNEL_KEYS, `${feature.slug} → ${key}`).toContain(key);
        // The canonical spelling, resolving to itself: a legacy spelling must never be stored.
        expect(matchSalesFunnelKey(key)).toBe(key);
      }
    }
  });

  it("states no funnel twice", () => {
    for (const feature of SEED_FEATURES) {
      expect(new Set(feature.salesFunnels).size, feature.slug).toBe(feature.salesFunnels.length);
    }
  });

  it("'sells through NONE' and 'sells through ALL' are DISTINGUISHABLE — both are stated, neither is absent", () => {
    // Hiring outreach is the "none" side now: it is not an acquisition channel at all, so it sells
    // through nothing. Journalist outreach and expert quotes moved to the "some" side when they were
    // published as earned acquisition channels — they produce website visits, so they sell through
    // every click-driven chain.
    const none = bySlug("hiring-cold-email-outreach")!.salesFunnels;
    const all = bySlug(SALES_SLUG)!.salesFunnels;

    expect(none).toEqual([]);
    expect(all).toEqual([...SALES_FUNNEL_KEYS]);
    expect(none).not.toEqual(all);
    // The distinction a consumer actually makes: an empty list offers nothing, a full one offers
    // everything, and neither is expressed by leaving the field out.
    expect(none.length).toBe(0);
    expect(all.length).toBe(SALES_FUNNEL_KEYS.length);
  });

  it("every feature that is NOT an acquisition channel sells through no sales funnel", () => {
    // These acquire something other than a customer (a hire, an investor, a programme place) or are
    // internal tooling, so they are not channels and there is nothing to pair them with.
    const notChannels = [
      "hiring-cold-email-outreach",
      "vc-cold-email-outreach",
      "accelerators-cold-email-outreach",
      "outlet-database-discovery",
      "press-kit-page-generation",
      "ai-visibility-scoring",
    ];
    for (const slug of notChannels) {
      expect(bySlug(slug), slug).toBeDefined();
      expect(bySlug(slug)!.acquisitionChannel, slug).toBeNull();
      expect(bySlug(slug)!.salesFunnels, slug).toEqual([]);
    }
  });

  it("the earned PR channels ARE published channels now, and sell through every click-driven chain", () => {
    for (const slug of ["pr-cold-email-outreach", "pr-expert-quote-outreach", "pr-expert-quote-opportunities"]) {
      expect(bySlug(slug)!.acquisitionChannel, slug).not.toBeNull();
      expect(bySlug(slug)!.salesFunnels, slug).toEqual([
        "sales_meetings_from_website",
        "website_purchases",
        "form_magnet",
      ]);
    }
  });

  it("the feedback request sells through the reply-to-meeting chain ALONE", () => {
    expect(bySlug(FEEDBACK_SLUG)!.salesFunnels).toEqual(["sales_meetings_from_conversation"]);
  });

  it("a restriction is not a gap — the feedback request states FEWER funnels than the pitch, on purpose", () => {
    const feedback = bySlug(FEEDBACK_SLUG)!.salesFunnels;
    const pitch = bySlug(SALES_SLUG)!.salesFunnels;
    expect(feedback.length).toBeGreaterThan(0);
    expect(feedback.length).toBeLessThan(pitch.length);
    for (const key of feedback) expect(pitch).toContain(key);
  });

  it("no existing feature's answer changed the pitch's own: sales cold email still sells through all four", () => {
    expect(bySlug(SALES_SLUG)!.salesFunnels).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
      "website_purchases",
      "form_magnet",
    ]);
  });
});

describe("the feedback-request cold email feature", () => {
  const seed = bySlug(FEEDBACK_SLUG);
  const pitch = bySlug(SALES_SLUG);

  it("is in the catalogue, implemented and ACTIVE — not gated behind alpha/beta", () => {
    expect(seed).toBeDefined();
    expect(seed!.implemented).toBe(true);
    expect(seed!.status).toBe("active");
  });

  it("is a cold-email channel by its slug, so the fleet audits already count it", () => {
    expect(coldEmailOutreachSlugs([FEEDBACK_SLUG, "ai-visibility-scoring"])).toEqual([FEEDBACK_SLUG]);
  });

  it("carries ONE name — the pre-rename slug is gone from the catalogue and the registry, not aliased", () => {
    const dead = "sales-feedback-request-cold-email-outreach";
    expect(bySlug(dead)).toBeUndefined();
    expect(FUNNEL_REGISTRY[dead]).toBeUndefined();
    // The family membership was never bought by the `sales-` prefix: every fleet audit derives its
    // account universe from the `-cold-email-outreach` SUFFIX, which the rename keeps.
    expect(coldEmailOutreachSlugs([FEEDBACK_SLUG])).toEqual([FEEDBACK_SLUG]);
  });

  it("prices on the same funnel as the pitch — same medium, same measurement, different offer", () => {
    expect(FUNNEL_REGISTRY[FEEDBACK_SLUG]).toBe(FUNNEL_REGISTRY[SALES_SLUG]);
  });

  it("measures byte-identically to the pitch (outputs, charts, entities)", () => {
    expect(seed!.outputs).toEqual(pitch!.outputs);
    expect(seed!.charts).toEqual(pitch!.charts);
    expect(seed!.entities).toEqual(pitch!.entities);
  });

  /**
   * THE OFFER HAS TWO HALVES, AND THE PRICE IS THE FORM OF FEEDBACK.
   *
   * The channel gives a gift and asks for feedback in return, so the prospect pays in effort rather
   * than money. What is asked for IS the price tag (a public video testimonial and a Google Maps
   * rating are wildly different prices), which is why the eight inputs are the two halves of the
   * offer plus the four persuasion levers, and why the ones copied from the pitch are gone.
   */
  it("states the gift, its anchored value, the price and the effort — exactly eight inputs", () => {
    const keys = (seed!.inputs as Array<{ key: string }>).map((i) => i.key);
    expect(keys).toEqual([
      "gift",
      "giftValue",
      "feedbackForm",
      "feedbackEffort",
      "socialProof",
      "scarcity",
      "urgency",
      "riskReversal",
    ]);
  });

  it("no longer asks the four questions copied from the pitch", () => {
    const keys = (seed!.inputs as Array<{ key: string }>).map((i) => i.key);
    for (const dead of ["targetAudience", "problemToValidate", "targetOutcome", "valueForTarget"]) {
      expect(keys, dead).not.toContain(dead);
    }
  });

  /**
   * A decision was taken NOT to introduce a new input type for this. The form of feedback is plain
   * text whose PLACEHOLDER enumerates the options, so a select / multi-select must not appear here.
   */
  it("prices the offer in a plain text field whose placeholder names the options", () => {
    const form = (seed!.inputs as Array<{ key: string; type: string; placeholder?: string }>).find((i) => i.key === "feedbackForm")!;
    expect(form.type).toBe("text");
    for (const option of ["written", "video", "private", "public", "call", "G2", "Google Maps", "Trustpilot", "Capterra"]) {
      expect(form.placeholder?.toLowerCase(), option).toContain(option.toLowerCase());
    }
    const types = new Set(SEED_FEATURES.flatMap((f) => (f.inputs as Array<{ type: string }>).map((i) => i.type)));
    expect([...types].sort()).toEqual(["text", "textarea"]);
  });

  it("carries no em-dash in customer-facing copy", () => {
    const copy = [seed!.name, seed!.description, ...(seed!.inputs as Array<{ label: string; placeholder?: string; description: string }>).flatMap((i) => [i.label, i.placeholder ?? "", i.description])];
    for (const text of copy) expect(text).not.toContain("—");
  });
});

/**
 * A FREE-TEXT ICP CONTRADICTS THE AUDIENCE BANDIT — it is not a duplicate of it.
 *
 * A campaign points at saved audiences and a bandit picks ONE per run, so a static "who we target"
 * typed on the feature form describes a different set of people than the run is addressing. It is kept
 * on the two features where nothing else answers the question: ai-visibility-scoring contacts nobody
 * (its audience frames the questions put to the LLMs), and the PR channel takes its recipients from
 * journalists-service rather than from the audience entity.
 */
describe("free-text ICP vs the audience bandit", () => {
  const inputKeys = (slug: string) => (bySlug(slug)!.inputs as Array<{ key: string; label: string }>);

  it.each([
    ["sales-cold-email-outreach"],
    ["feedback-request-cold-email-outreach"],
    ["vc-cold-email-outreach"],
    ["accelerators-cold-email-outreach"],
    ["hiring-cold-email-outreach"],
  ])("%s takes its recipients from the bandit, so it asks for no ICP", (slug) => {
    for (const input of inputKeys(slug)) {
      expect(input.key, `${slug}.${input.key}`).not.toMatch(/^(targetAudience|targetProfile|targetInvestorProfile|targetAcceleratorProfile)$/);
      expect(input.label.toLowerCase(), `${slug}.${input.key}`).not.toContain("profile");
    }
  });

  it("ai-visibility-scoring keeps its audience — it contacts nobody, the field frames the LLM prompts", () => {
    const audience = inputKeys("ai-visibility-scoring").find((i) => i.key === "audienceProfile");
    expect(audience?.label).toBe("Audience Profile");
  });

  it("the PR channel is untouched — its recipients come from journalists-service", () => {
    expect(inputKeys("pr-cold-email-outreach").map((i) => i.key)).toEqual([
      "targetOutlets",
      "prAngle",
      "companyContext",
      "newsHook",
      "spokesperson",
    ]);
  });
});
