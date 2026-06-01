import { describe, it, expect } from "vitest";
import { SEED_FEATURES } from "./features.js";
import { VALID_STATS_KEYS, VALID_ENTITY_TYPES } from "../lib/stats-registry.js";

describe("SEED_FEATURES — pr-expert-quote-outreach", () => {
  const FEATURED_SLUG = "pr-expert-quote-outreach";

  const seed = SEED_FEATURES.find((f) => f.slug === FEATURED_SLUG);

  it("is registered in SEED_FEATURES", () => {
    expect(seed).toBeDefined();
  });

  it("plural-slug duplicate (pr-expert-quotes-outreach) is gone", () => {
    const plural = SEED_FEATURES.find((f) => f.slug === "pr-expert-quotes-outreach");
    expect(plural).toBeUndefined();
  });

  it("has the renamed name and Featured.com description", () => {
    expect(seed?.name).toBe("PR Expert Quote Outreach");
    expect(seed?.description).toMatch(/Featured\.com/i);
    expect(seed?.description).toMatch(/journalist quote requests/i);
  });

  it("has implemented=true and status=active", () => {
    expect(seed?.implemented).toBe(true);
    expect(seed?.status).toBe("active");
  });

  it("has a non-zero displayOrder distinct from existing features", () => {
    const orders = SEED_FEATURES.map((f) => f.displayOrder);
    const uniqueOrders = new Set(orders);
    expect(uniqueOrders.size).toBe(orders.length);
    expect(seed?.displayOrder).toBeGreaterThan(0);
  });

  it("has at least one input field with required keys", () => {
    expect(seed?.inputs.length).toBeGreaterThan(0);
    for (const input of seed?.inputs as Array<{ key: string; label: string; extractKey: string; description: string }>) {
      expect(input.key).toBeTruthy();
      expect(input.label).toBeTruthy();
      expect(input.extractKey).toBeTruthy();
      expect(input.description).toBeTruthy();
    }
  });

  it("declares the 4 person attribution inputs journalists need", () => {
    const keys = (seed?.inputs as Array<{ key: string }>).map((i) => i.key);
    expect(keys).toEqual([
      "expertName",
      "expertTitle",
      "expertPhotoUrl",
      "expertLinkedIn",
    ]);
  });

  it("all output keys are registered in STATS_REGISTRY", () => {
    const outputs = seed?.outputs as Array<{ key: string }>;
    for (const out of outputs) {
      expect(VALID_STATS_KEYS.has(out.key)).toBe(true);
    }
  });

  it("all entity names are registered in ENTITY_REGISTRY", () => {
    const entities = seed?.entities as Array<{ name: string }>;
    for (const ent of entities) {
      expect(VALID_ENTITY_TYPES.has(ent.name)).toBe(true);
    }
  });

  it("has a defaultSort output", () => {
    const outputs = seed?.outputs as Array<{ key: string; defaultSort?: boolean }>;
    const defaultSort = outputs.filter((o) => o.defaultSort);
    expect(defaultSort.length).toBe(1);
  });

  it("has at least one chart", () => {
    expect((seed?.charts as unknown[]).length).toBeGreaterThan(0);
  });

  it("declares the quote-outreach outputs from journalists-quotes-service", () => {
    const keys = (seed?.outputs as Array<{ key: string }>).map((o) => o.key);
    expect(keys).toEqual([
      "quoteRequestsFound",
      "quotePitchesSubmitted",
      "quotesSelected",
      "quotesPublished",
      "pitchSelectionRate",
      "pitchPublishRate",
      "costPerQuotePublishedCents",
    ]);
  });

  it("uses costPerQuotePublishedCents as the default sort (asc)", () => {
    const outputs = seed?.outputs as Array<{ key: string; defaultSort?: boolean; sortDirection?: string }>;
    const def = outputs.find((o) => o.defaultSort);
    expect(def?.key).toBe("costPerQuotePublishedCents");
    expect(def?.sortDirection).toBe("asc");
  });

  it("declares funnel-bar + breakdown-bar charts over quote keys", () => {
    const charts = seed?.charts as Array<{ type: string; steps?: Array<{ key: string }>; segments?: Array<{ key: string }> }>;
    const funnel = charts.find((c) => c.type === "funnel-bar");
    expect(funnel?.steps?.map((s) => s.key)).toEqual([
      "quoteRequestsFound",
      "quotePitchesSubmitted",
      "quotesSelected",
      "quotesPublished",
    ]);
    const bd = charts.find((c) => c.type === "breakdown-bar");
    expect(bd?.segments?.map((s) => s.key)).toEqual(["quotesPublished", "quotesSelected", "quotesNotSelected"]);
  });

  it("declares quote-requests + quote-pitches entities", () => {
    const names = (seed?.entities as Array<{ name: string }>).map((e) => e.name);
    expect(names).toEqual(["quote-requests", "quote-pitches"]);
  });
});

describe("SEED_FEATURES — ai-visibility-scoring", () => {
  const SLUG = "ai-visibility-scoring";

  const seed = SEED_FEATURES.find((f) => f.slug === SLUG);

  it("is registered in SEED_FEATURES", () => {
    expect(seed).toBeDefined();
  });

  it("has implemented=true (producer service ai-visibility-score-service is deployed)", () => {
    expect(seed?.implemented).toBe(true);
  });

  it("has status=active and a positive displayOrder", () => {
    expect(seed?.status).toBe("active");
    expect(seed?.displayOrder).toBeGreaterThan(0);
  });

  it("has at least one input with required keys", () => {
    expect(seed?.inputs.length).toBeGreaterThan(0);
    for (const input of seed?.inputs as Array<{ key: string; label: string; extractKey: string; description: string }>) {
      expect(input.key).toBeTruthy();
      expect(input.label).toBeTruthy();
      expect(input.extractKey).toBeTruthy();
      expect(input.description).toBeTruthy();
    }
  });

  it("declares brand-related inputs", () => {
    const keys = (seed?.inputs as Array<{ key: string }>).map((i) => i.key);
    expect(keys).toContain("brandName");
    expect(keys).toContain("competitors");
    expect(keys).toContain("topics");
  });

  it("declares the AI visibility score outputs from ai-visibility-score-service", () => {
    const keys = (seed?.outputs as Array<{ key: string }>).map((o) => o.key);
    expect(keys).toEqual([
      "visibilityScore",
      "shareOfVoice",
      "brandMentionRate",
      "citationRate",
      "netSentiment",
      "avgPosition",
    ]);
  });

  it("uses visibilityScore as the default sort (desc)", () => {
    const outputs = seed?.outputs as Array<{ key: string; defaultSort?: boolean; sortDirection?: string }>;
    const def = outputs.find((o) => o.defaultSort);
    expect(def?.key).toBe("visibilityScore");
    expect(def?.sortDirection).toBe("desc");
  });

  it("declares avgPosition with sortDirection asc (lower is better)", () => {
    const outputs = seed?.outputs as Array<{ key: string; sortDirection?: string }>;
    const ap = outputs.find((o) => o.key === "avgPosition");
    expect(ap?.sortDirection).toBe("asc");
  });

  it("declares a line-chart chart for time-series visibility", () => {
    const charts = seed?.charts as Array<{ type: string; series?: Array<{ key: string }> }>;
    const line = charts.find((c) => c.type === "line-chart");
    expect(line).toBeDefined();
    expect(line?.series?.map((s) => s.key)).toEqual([
      "visibilityScore",
      "shareOfVoice",
      "brandMentionRate",
      "citationRate",
    ]);
  });

  it("declares visibility-runs / prompts / competitors entities", () => {
    const names = (seed?.entities as Array<{ name: string }>).map((e) => e.name);
    expect(names).toEqual(["visibility-runs", "prompts", "competitors"]);
  });
});

describe("SEED_FEATURES — pr-expert-quote-opportunities", () => {
  const SLUG = "pr-expert-quote-opportunities";

  const seed = SEED_FEATURES.find((f) => f.slug === SLUG);

  it("is registered in SEED_FEATURES", () => {
    expect(seed).toBeDefined();
  });

  it("has the canonical name and description mentioning Featured.com + manual review", () => {
    expect(seed?.name).toBe("PR Expert Quote Opportunities");
    expect(seed?.description).toMatch(/Featured\.com/i);
    expect(seed?.description).toMatch(/(manual|review|curat)/i);
  });

  it("has implemented=true and status=active", () => {
    expect(seed?.implemented).toBe(true);
    expect(seed?.status).toBe("active");
  });

  it("has displayOrder = 10", () => {
    expect(seed?.displayOrder).toBe(10);
  });

  it("uses the inbox icon (HITL queue metaphor)", () => {
    expect(seed?.icon).toBe("inbox");
  });

  it("has 4 inputs with required keys", () => {
    expect(seed?.inputs.length).toBe(4);
    for (const input of seed?.inputs as Array<{ key: string; label: string; extractKey: string; description: string }>) {
      expect(input.key).toBeTruthy();
      expect(input.label).toBeTruthy();
      expect(input.extractKey).toBeTruthy();
      expect(input.description).toBeTruthy();
    }
  });

  it("declares the 4 person attribution inputs journalists need", () => {
    const keys = (seed?.inputs as Array<{ key: string }>).map((i) => i.key);
    expect(keys).toEqual([
      "expertName",
      "expertTitle",
      "expertPhotoUrl",
      "expertLinkedIn",
    ]);
  });

  it("declares the quote-outreach outputs (lean reuse)", () => {
    const keys = (seed?.outputs as Array<{ key: string }>).map((o) => o.key);
    expect(keys).toEqual([
      "quoteRequestsFound",
      "quotePitchesSubmitted",
      "quotesSelected",
      "quotesPublished",
      "pitchSelectionRate",
      "pitchPublishRate",
      "costPerQuotePublishedCents",
    ]);
  });

  it("uses costPerQuotePublishedCents as the default sort (asc)", () => {
    const outputs = seed?.outputs as Array<{ key: string; defaultSort?: boolean; sortDirection?: string }>;
    const def = outputs.find((o) => o.defaultSort);
    expect(def?.key).toBe("costPerQuotePublishedCents");
    expect(def?.sortDirection).toBe("asc");
  });

  it("declares funnel-bar chart over the 4 quote raw keys", () => {
    const charts = seed?.charts as Array<{ type: string; steps?: Array<{ key: string }> }>;
    const funnel = charts.find((c) => c.type === "funnel-bar");
    expect(funnel?.steps?.map((s) => s.key)).toEqual([
      "quoteRequestsFound",
      "quotePitchesSubmitted",
      "quotesSelected",
      "quotesPublished",
    ]);
  });

  it("declares quote-requests + quote-pitches entities", () => {
    const names = (seed?.entities as Array<{ name: string }>).map((e) => e.name);
    expect(names).toEqual(["quote-requests", "quote-pitches"]);
  });

  it("all output keys are registered in STATS_REGISTRY", () => {
    const outputs = seed?.outputs as Array<{ key: string }>;
    for (const out of outputs) {
      expect(VALID_STATS_KEYS.has(out.key)).toBe(true);
    }
  });

  it("all entity names are registered in ENTITY_REGISTRY", () => {
    const entities = seed?.entities as Array<{ name: string }>;
    for (const ent of entities) {
      expect(VALID_ENTITY_TYPES.has(ent.name)).toBe(true);
    }
  });
});

describe("SEED_FEATURES — cold-email % Clicks stat", () => {
  const COLD_EMAIL_SLUGS = [
    "sales-cold-email-outreach",
    "pr-cold-email-outreach",
    "hiring-cold-email-outreach",
    "vc-cold-email-outreach",
    "accelerators-cold-email-outreach",
  ];

  it("recipientClickRate is a registered stats key", () => {
    expect(VALID_STATS_KEYS.has("recipientClickRate")).toBe(true);
  });

  for (const slug of COLD_EMAIL_SLUGS) {
    describe(slug, () => {
      const seed = SEED_FEATURES.find((f) => f.slug === slug);
      const keys = () => (seed?.outputs as Array<{ key: string }>).map((o) => o.key);

      it("is registered", () => {
        expect(seed).toBeDefined();
      });

      it("declares recipientClickRate in outputs", () => {
        expect(keys()).toContain("recipientClickRate");
      });

      it("places recipientClickRate immediately after recipientOpenRate (between open and positive)", () => {
        const k = keys();
        const openIdx = k.indexOf("recipientOpenRate");
        const clickIdx = k.indexOf("recipientClickRate");
        const positiveIdx = k.indexOf("recipientPositiveReplyRate");
        expect(openIdx).toBeGreaterThanOrEqual(0);
        expect(clickIdx).toBe(openIdx + 1);
        expect(clickIdx).toBeLessThan(positiveIdx);
      });

      it("has contiguous displayOrder values 1..N", () => {
        const orders = (seed?.outputs as Array<{ displayOrder: number }>)
          .map((o) => o.displayOrder)
          .sort((a, b) => a - b);
        expect(orders).toEqual(orders.map((_, i) => i + 1));
      });

      it("keeps exactly one defaultSort output", () => {
        const def = (seed?.outputs as Array<{ defaultSort?: boolean }>).filter((o) => o.defaultSort);
        expect(def.length).toBe(1);
      });
    });
  }
});

describe("SEED_FEATURES — global invariants", () => {
  it("all slugs are unique", () => {
    const slugs = SEED_FEATURES.map((f) => f.slug);
    const uniqueSlugs = new Set(slugs);
    expect(uniqueSlugs.size).toBe(slugs.length);
  });

  it("all names are unique", () => {
    const names = SEED_FEATURES.map((f) => f.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it("all displayOrder values are unique", () => {
    const orders = SEED_FEATURES.map((f) => f.displayOrder);
    const uniqueOrders = new Set(orders);
    expect(uniqueOrders.size).toBe(orders.length);
  });
});
