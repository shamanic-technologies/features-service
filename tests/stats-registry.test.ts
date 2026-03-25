import { describe, it, expect } from "vitest";
import {
  STATS_REGISTRY,
  VALID_STATS_KEYS,
  VALID_ENTITY_TYPES,
  getPublicRegistry,
  validateStatsKeys,
  validateEntityTypes,
} from "../src/lib/stats-registry.js";

describe("STATS_REGISTRY", () => {
  it("contains email stats keys", () => {
    expect(VALID_STATS_KEYS.has("emailsSent")).toBe(true);
    expect(VALID_STATS_KEYS.has("emailsReplied")).toBe(true);
    expect(VALID_STATS_KEYS.has("emailsOpened")).toBe(true);
    expect(VALID_STATS_KEYS.has("emailsClicked")).toBe(true);
  });

  it("contains reply breakdown keys", () => {
    expect(VALID_STATS_KEYS.has("repliesWillingToMeet")).toBe(true);
    expect(VALID_STATS_KEYS.has("repliesInterested")).toBe(true);
    expect(VALID_STATS_KEYS.has("repliesNotInterested")).toBe(true);
  });

  it("contains cost/runs keys", () => {
    expect(VALID_STATS_KEYS.has("totalCostInUsdCents")).toBe(true);
    expect(VALID_STATS_KEYS.has("completedRuns")).toBe(true);
  });

  it("contains outlets stats keys", () => {
    expect(VALID_STATS_KEYS.has("outletsDiscovered")).toBe(true);
    expect(VALID_STATS_KEYS.has("avgRelevanceScore")).toBe(true);
    expect(VALID_STATS_KEYS.has("searchQueriesUsed")).toBe(true);
  });

  it("outlets keys have source 'outlets'", () => {
    expect(STATS_REGISTRY.outletsDiscovered).toMatchObject({ kind: "raw", source: "outlets" });
    expect(STATS_REGISTRY.avgRelevanceScore).toMatchObject({ kind: "raw", source: "outlets" });
    expect(STATS_REGISTRY.searchQueriesUsed).toMatchObject({ kind: "raw", source: "outlets" });
  });

  it("contains derived rate keys", () => {
    expect(VALID_STATS_KEYS.has("openRate")).toBe(true);
    expect(VALID_STATS_KEYS.has("clickRate")).toBe(true);
    expect(VALID_STATS_KEYS.has("replyRate")).toBe(true);
  });

  it("contains derived cost-per keys", () => {
    expect(VALID_STATS_KEYS.has("costPerOpenCents")).toBe(true);
    expect(VALID_STATS_KEYS.has("costPerClickCents")).toBe(true);
    expect(VALID_STATS_KEYS.has("costPerReplyCents")).toBe(true);
    expect(VALID_STATS_KEYS.has("costPerOutletCents")).toBe(true);
  });

  it("derived keys reference valid raw keys", () => {
    for (const [key, def] of Object.entries(STATS_REGISTRY)) {
      if (def.kind === "derived") {
        expect(VALID_STATS_KEYS.has(def.numerator)).toBe(true);
        expect(VALID_STATS_KEYS.has(def.denominator)).toBe(true);
      }
    }
  });

  it("all raw keys have a source", () => {
    for (const [key, def] of Object.entries(STATS_REGISTRY)) {
      if (def.kind === "raw") {
        expect(def.source).toBeTruthy();
      }
    }
  });
});

describe("VALID_ENTITY_TYPES", () => {
  it("contains expected types", () => {
    expect(VALID_ENTITY_TYPES.has("leads")).toBe(true);
    expect(VALID_ENTITY_TYPES.has("companies")).toBe(true);
    expect(VALID_ENTITY_TYPES.has("emails")).toBe(true);
    expect(VALID_ENTITY_TYPES.has("outlets")).toBe(true);
    expect(VALID_ENTITY_TYPES.has("journalists")).toBe(true);
    expect(VALID_ENTITY_TYPES.has("press-kits")).toBe(true);
  });
});

describe("getPublicRegistry", () => {
  it("returns label and type for each key", () => {
    const pub = getPublicRegistry();
    expect(pub.emailsSent).toEqual({ type: "count", label: "Sent" });
    expect(pub.replyRate).toEqual({ type: "rate", label: "% Replies" });
    expect(pub.costPerReplyCents).toEqual({ type: "currency", label: "$/Reply" });
  });

  it("has same number of entries as STATS_REGISTRY", () => {
    const pub = getPublicRegistry();
    expect(Object.keys(pub).length).toBe(Object.keys(STATS_REGISTRY).length);
  });
});

describe("validateStatsKeys", () => {
  it("returns empty array for valid keys", () => {
    expect(validateStatsKeys(["emailsSent", "replyRate"])).toEqual([]);
  });

  it("returns invalid keys", () => {
    expect(validateStatsKeys(["emailsSent", "fakeKey"])).toEqual(["fakeKey"]);
  });
});

describe("validateEntityTypes", () => {
  it("returns empty array for valid types", () => {
    expect(validateEntityTypes(["leads", "emails"])).toEqual([]);
  });

  it("returns invalid types", () => {
    expect(validateEntityTypes(["leads", "fakeType"])).toEqual(["fakeType"]);
  });
});
