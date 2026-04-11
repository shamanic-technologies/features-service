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
    expect(VALID_STATS_KEYS.has("emailsDelivered")).toBe(true);
    expect(VALID_STATS_KEYS.has("emailsOpened")).toBe(true);
    expect(VALID_STATS_KEYS.has("emailsClicked")).toBe(true);
  });

  it("contains reply aggregate keys", () => {
    expect(VALID_STATS_KEYS.has("repliesPositive")).toBe(true);
    expect(VALID_STATS_KEYS.has("repliesNegative")).toBe(true);
    expect(VALID_STATS_KEYS.has("repliesNeutral")).toBe(true);
    expect(VALID_STATS_KEYS.has("repliesAutoReply")).toBe(true);
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
    expect(VALID_STATS_KEYS.has("positiveReplyRate")).toBe(true);
    expect(VALID_STATS_KEYS.has("negativeReplyRate")).toBe(true);
    expect(VALID_STATS_KEYS.has("neutralReplyRate")).toBe(true);
  });

  it("contains press-kits stats keys", () => {
    expect(VALID_STATS_KEYS.has("pressKitsGenerated")).toBe(true);
    expect(VALID_STATS_KEYS.has("pressKitViews")).toBe(true);
    expect(VALID_STATS_KEYS.has("pressKitUniqueVisitors")).toBe(true);
  });

  it("press-kits keys have source 'press-kits'", () => {
    expect(STATS_REGISTRY.pressKitsGenerated).toMatchObject({ kind: "raw", source: "press-kits" });
    expect(STATS_REGISTRY.pressKitViews).toMatchObject({ kind: "raw", source: "press-kits" });
    expect(STATS_REGISTRY.pressKitUniqueVisitors).toMatchObject({ kind: "raw", source: "press-kits" });
  });

  it("contains derived cost-per keys", () => {
    expect(VALID_STATS_KEYS.has("costPerOpenCents")).toBe(true);
    expect(VALID_STATS_KEYS.has("costPerClickCents")).toBe(true);
    expect(VALID_STATS_KEYS.has("costPerPositiveReplyCents")).toBe(true);
    expect(VALID_STATS_KEYS.has("costPerOutletCents")).toBe(true);
    expect(VALID_STATS_KEYS.has("costPerPressKitCents")).toBe(true);
    expect(VALID_STATS_KEYS.has("costPerPressKitViewCents")).toBe(true);
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
    expect(pub.positiveReplyRate).toEqual({ type: "rate", label: "% Positive" });
    expect(pub.costPerPositiveReplyCents).toEqual({ type: "currency", label: "$/Positive Reply" });
  });

  it("has same number of entries as STATS_REGISTRY", () => {
    const pub = getPublicRegistry();
    expect(Object.keys(pub).length).toBe(Object.keys(STATS_REGISTRY).length);
  });
});

describe("validateStatsKeys", () => {
  it("returns empty array for valid keys", () => {
    expect(validateStatsKeys(["emailsSent", "positiveReplyRate"])).toEqual([]);
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
