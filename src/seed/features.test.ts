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

  it("declares a spokesperson input (Featured.com requires expert)", () => {
    const keys = (seed?.inputs as Array<{ key: string }>).map((i) => i.key);
    expect(keys).toContain("spokesperson");
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

  it("has empty outputs/charts/entities until producer ships", () => {
    expect(seed?.outputs).toEqual([]);
    expect(seed?.charts).toEqual([]);
    expect(seed?.entities).toEqual([]);
  });
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
