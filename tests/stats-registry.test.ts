import { describe, it, expect } from "vitest";
import {
  STATS_REGISTRY,
  VALID_STATS_KEYS,
  VALID_ENTITY_TYPES,
  getPublicRegistry,
  validateStatsKeys,
  validateEntityTypes,
} from "../src/lib/stats-registry.js";
import { SEED_FEATURES } from "../src/seed/features.js";

describe("STATS_REGISTRY", () => {
  it("contains recipient-level email stats keys", () => {
    expect(VALID_STATS_KEYS.has("recipientsSent")).toBe(true);
    expect(VALID_STATS_KEYS.has("recipientsDelivered")).toBe(true);
    expect(VALID_STATS_KEYS.has("recipientsOpened")).toBe(true);
    expect(VALID_STATS_KEYS.has("recipientsClicked")).toBe(true);
  });

  it("contains recipient-level reply aggregate keys", () => {
    expect(VALID_STATS_KEYS.has("recipientsRepliesPositive")).toBe(true);
    expect(VALID_STATS_KEYS.has("recipientsRepliesNegative")).toBe(true);
    expect(VALID_STATS_KEYS.has("recipientsRepliesNeutral")).toBe(true);
    expect(VALID_STATS_KEYS.has("recipientsRepliesAutoReply")).toBe(true);
  });

  it("does not contain old email-level key names", () => {
    expect(VALID_STATS_KEYS.has("emailsSent")).toBe(false);
    expect(VALID_STATS_KEYS.has("emailsOpened")).toBe(false);
    expect(VALID_STATS_KEYS.has("emailsClicked")).toBe(false);
    expect(VALID_STATS_KEYS.has("recipients")).toBe(false);
    expect(VALID_STATS_KEYS.has("repliesPositive")).toBe(false);
    expect(VALID_STATS_KEYS.has("openRate")).toBe(false);
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

  it("contains recipient-level derived rate keys", () => {
    expect(VALID_STATS_KEYS.has("recipientOpenRate")).toBe(true);
    expect(VALID_STATS_KEYS.has("recipientClickRate")).toBe(true);
    expect(VALID_STATS_KEYS.has("recipientPositiveReplyRate")).toBe(true);
    expect(VALID_STATS_KEYS.has("recipientNegativeReplyRate")).toBe(true);
    expect(VALID_STATS_KEYS.has("recipientNeutralReplyRate")).toBe(true);
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

  it("contains recipient-level derived cost-per keys", () => {
    expect(VALID_STATS_KEYS.has("costPerRecipientOpenCents")).toBe(true);
    expect(VALID_STATS_KEYS.has("costPerRecipientClickCents")).toBe(true);
    expect(VALID_STATS_KEYS.has("costPerRecipientPositiveReplyCents")).toBe(true);
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
    expect(pub.recipientsSent).toEqual({ type: "count", label: "Sent" });
    expect(pub.recipientPositiveReplyRate).toEqual({ type: "rate", label: "% Positive" });
    expect(pub.costPerRecipientPositiveReplyCents).toEqual({ type: "currency", label: "$/Positive Reply" });
  });

  it("has same number of entries as STATS_REGISTRY", () => {
    const pub = getPublicRegistry();
    expect(Object.keys(pub).length).toBe(Object.keys(STATS_REGISTRY).length);
  });
});

describe("validateStatsKeys", () => {
  it("returns empty array for valid keys", () => {
    expect(validateStatsKeys(["recipientsSent", "recipientPositiveReplyRate"])).toEqual([]);
  });

  it("returns invalid keys", () => {
    expect(validateStatsKeys(["recipientsSent", "fakeKey"])).toEqual(["fakeKey"]);
  });
});

describe("seed features use only valid registry keys", () => {
  // Regression: seed features once used old key names (emailsSent, repliesPositive, etc.)
  // that didn't exist in the stats registry, causing the frontend to show raw camelCase labels.
  it("all output keys exist in STATS_REGISTRY", () => {
    for (const feature of SEED_FEATURES) {
      for (const output of feature.outputs as { key: string }[]) {
        expect(VALID_STATS_KEYS.has(output.key), `${feature.slug}: output key "${output.key}" not in registry`).toBe(true);
      }
    }
  });

  it("all chart step/segment keys exist in STATS_REGISTRY", () => {
    for (const feature of SEED_FEATURES) {
      for (const chart of feature.charts as { key: string; steps?: { key: string }[]; segments?: { key: string }[] }[]) {
        for (const step of chart.steps ?? []) {
          expect(VALID_STATS_KEYS.has(step.key), `${feature.slug} chart "${chart.key}": step key "${step.key}" not in registry`).toBe(true);
        }
        for (const seg of chart.segments ?? []) {
          expect(VALID_STATS_KEYS.has(seg.key), `${feature.slug} chart "${chart.key}": segment key "${seg.key}" not in registry`).toBe(true);
        }
      }
    }
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
