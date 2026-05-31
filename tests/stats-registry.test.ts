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

  it("contains lead-scoped raw outreach status keys", () => {
    expect(VALID_STATS_KEYS.has("leadsContacted")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsSent")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsDelivered")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsOpened")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsClicked")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsBounced")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsUnsubscribed")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsRepliesPositive")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsRepliesNegative")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsRepliesNeutral")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsRepliesAutoReply")).toBe(true);
  });

  it("contains lead reply detail keys", () => {
    expect(VALID_STATS_KEYS.has("leadsRepliesInterested")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsRepliesMeetingBooked")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsRepliesClosed")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsRepliesNotInterested")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsRepliesWrongPerson")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsRepliesUnsubscribeDetail")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsRepliesNeutralDetail")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsRepliesAutoReplyDetail")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsRepliesOutOfOffice")).toBe(true);
  });

  it("contains lead pipeline state keys", () => {
    expect(VALID_STATS_KEYS.has("leadsBuffered")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsSkipped")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadsClaimed")).toBe(true);
  });

  it("all leads* raw keys have source 'leads'", () => {
    const leadKeys = Object.entries(STATS_REGISTRY).filter(
      ([k, def]) => def.kind === "raw" && k.startsWith("leads"),
    );
    expect(leadKeys.length).toBeGreaterThanOrEqual(24);
    for (const [, def] of leadKeys) {
      expect(def).toMatchObject({ kind: "raw", source: "leads" });
    }
  });

  it("contains lead-scoped derived rate keys", () => {
    expect(VALID_STATS_KEYS.has("leadOpenRate")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadClickRate")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadPositiveReplyRate")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadNegativeReplyRate")).toBe(true);
    expect(VALID_STATS_KEYS.has("leadNeutralReplyRate")).toBe(true);
  });

  it("contains lead-scoped derived cost-per keys", () => {
    expect(VALID_STATS_KEYS.has("costPerLeadOpenCents")).toBe(true);
    expect(VALID_STATS_KEYS.has("costPerLeadClickCents")).toBe(true);
    expect(VALID_STATS_KEYS.has("costPerLeadPositiveReplyCents")).toBe(true);
  });

  it("lead derived rates use leadsDelivered as denominator", () => {
    expect(STATS_REGISTRY.leadOpenRate).toMatchObject({ kind: "derived", denominator: "leadsDelivered", numerator: "leadsOpened" });
    expect(STATS_REGISTRY.leadClickRate).toMatchObject({ kind: "derived", denominator: "leadsDelivered", numerator: "leadsClicked" });
    expect(STATS_REGISTRY.leadPositiveReplyRate).toMatchObject({ kind: "derived", denominator: "leadsDelivered", numerator: "leadsRepliesPositive" });
    expect(STATS_REGISTRY.leadNegativeReplyRate).toMatchObject({ kind: "derived", denominator: "leadsDelivered", numerator: "leadsRepliesNegative" });
    expect(STATS_REGISTRY.leadNeutralReplyRate).toMatchObject({ kind: "derived", denominator: "leadsDelivered", numerator: "leadsRepliesNeutral" });
  });

  it("lead cost-per keys use totalCostInUsdCents as numerator", () => {
    expect(STATS_REGISTRY.costPerLeadOpenCents).toMatchObject({ kind: "derived", numerator: "totalCostInUsdCents", denominator: "leadsOpened" });
    expect(STATS_REGISTRY.costPerLeadClickCents).toMatchObject({ kind: "derived", numerator: "totalCostInUsdCents", denominator: "leadsClicked" });
    expect(STATS_REGISTRY.costPerLeadPositiveReplyCents).toMatchObject({ kind: "derived", numerator: "totalCostInUsdCents", denominator: "leadsRepliesPositive" });
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

  it("contains quote-outreach raw count keys (source 'journalists-quotes')", () => {
    for (const k of ["quoteRequestsFound", "quotePitchesSubmitted", "quotesSelected", "quotesPublished", "quotesNotSelected"]) {
      expect(VALID_STATS_KEYS.has(k)).toBe(true);
      expect(STATS_REGISTRY[k]).toMatchObject({ kind: "raw", type: "count", source: "journalists-quotes" });
    }
  });

  it("contains quote-outreach derived rates + cost-per-published", () => {
    expect(STATS_REGISTRY.pitchSelectionRate).toMatchObject({ kind: "derived", type: "rate", numerator: "quotesSelected", denominator: "quotePitchesSubmitted" });
    expect(STATS_REGISTRY.pitchPublishRate).toMatchObject({ kind: "derived", type: "rate", numerator: "quotesPublished", denominator: "quotePitchesSubmitted" });
    expect(STATS_REGISTRY.costPerQuotePublishedCents).toMatchObject({ kind: "derived", type: "currency", numerator: "totalCostInUsdCents", denominator: "quotesPublished", sortDirection: "asc" });
  });

  it("contains AI visibility score keys (type 'score', source 'ai-visibility')", () => {
    for (const k of ["visibilityScore", "brandMentionRate", "shareOfVoice", "citationRate", "netSentiment"]) {
      expect(VALID_STATS_KEYS.has(k)).toBe(true);
      expect(STATS_REGISTRY[k]).toMatchObject({ kind: "raw", type: "score", source: "ai-visibility" });
    }
  });

  it("contains avgPosition raw count with sortDirection 'asc'", () => {
    expect(STATS_REGISTRY.avgPosition).toMatchObject({ kind: "raw", type: "count", source: "ai-visibility", sortDirection: "asc" });
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

  it("contains quote-outreach + ai-visibility entity types", () => {
    for (const t of ["quote-requests", "quote-pitches", "visibility-runs", "prompts", "competitors"]) {
      expect(VALID_ENTITY_TYPES.has(t)).toBe(true);
    }
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

describe("cold-email seed funnels are recipient-scoped (DIS-114)", () => {
  // sales/hiring/vc/accelerators cold-email features render the GLOBAL ranked
  // leaderboard (GET /public/stats/ranked, groupBy=workflow) via feature.outputs.
  // The leads*/companies* family is unpopulated per-workflow because lead-service
  // does not yet emit byOutreachStatus/byOutreachStatusCompanies in the ranked
  // aggregation (DIS-10, DIS-48). These features therefore surface the populated
  // recipients* family (email-gateway), mirroring pr-cold-email-outreach.
  const COLD_EMAIL = [
    "sales-cold-email-outreach",
    "hiring-cold-email-outreach",
    "vc-cold-email-outreach",
    "accelerators-cold-email-outreach",
  ];

  const isRecipientScoped = (key: string) =>
    key.startsWith("recipients") ||
    key.startsWith("recipient") ||
    key.startsWith("costPerRecipient") ||
    key === "emailsGenerated";

  for (const slug of COLD_EMAIL) {
    it(`${slug}: funnel chart steps are recipient-scoped (no leads*/companies*)`, () => {
      const feature = SEED_FEATURES.find((f) => f.slug === slug);
      expect(feature, `seed feature ${slug} missing`).toBeDefined();
      const charts = feature!.charts as { key: string; steps?: { key: string }[]; segments?: { key: string }[] }[];
      const funnel = charts.find((c) => c.key === "funnel");
      expect(funnel, `${slug}: funnel chart missing`).toBeDefined();
      for (const step of funnel!.steps ?? []) {
        expect(isRecipientScoped(step.key), `${slug} funnel step "${step.key}" not recipient-scoped`).toBe(true);
      }
    });

    it(`${slug}: outputs are recipient-scoped (no leads*/companies*/costPerLead*)`, () => {
      const feature = SEED_FEATURES.find((f) => f.slug === slug);
      const outputs = feature!.outputs as { key: string }[];
      for (const out of outputs) {
        expect(isRecipientScoped(out.key), `${slug} output "${out.key}" not recipient-scoped`).toBe(true);
      }
    });

    it(`${slug}: defaultSort metric is costPerRecipientPositiveReplyCents (asc)`, () => {
      const feature = SEED_FEATURES.find((f) => f.slug === slug);
      const outputs = feature!.outputs as { key: string; defaultSort?: boolean; sortDirection?: string }[];
      const sortKey = outputs.find((o) => o.defaultSort);
      expect(sortKey, `${slug}: no defaultSort output`).toBeDefined();
      expect(sortKey!.key).toBe("costPerRecipientPositiveReplyCents");
      expect(sortKey!.sortDirection).toBe("asc");
    });
  }

  // The leads*/companies* keys are NOT deleted from the registry — they remain
  // valid and the stats route still computes them. Only the cold-email features'
  // DISPLAYED outputs move to recipients*. This keeps the DIS-10 B2B-funnel
  // follow-up (populate leads*/companies* per-workflow) a pure seed change.
  it("leads*/companies* keys remain in the registry (preserved for DIS-10 follow-up)", () => {
    for (const k of ["leadsServed", "leadsRepliesPositive", "companiesServed", "costPerLeadPositiveReplyCents"]) {
      expect(VALID_STATS_KEYS.has(k), `registry key "${k}" must remain`).toBe(true);
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
