import { describe, it, expect } from "vitest";
import { upsertFeatureSchema, batchUpsertFeaturesSchema, createFeatureSchema, updateFeatureSchema, prefillRequestSchema } from "../src/lib/schemas.js";

const validInput = {
  key: "targetAudience",
  label: "Target Audience",
  type: "textarea" as const,
  placeholder: "CTOs at SaaS startups with 10-50 employees",
  description:
    "The specific audience segment this campaign targets. Be precise about demographics, job titles, industry, and company size.",
  extractKey: "targetAudience",
};

const validOutput = {
  key: "emailsSent",
  displayOrder: 1,
};

const validOutputWithSort = {
  key: "costPerReplyCents",
  displayOrder: 2,
  defaultSort: true,
  sortDirection: "asc" as const,
};

const validFunnelChart = {
  key: "funnel",
  type: "funnel-bar" as const,
  title: "Campaign Funnel",
  displayOrder: 1,
  steps: [
    { key: "leadsServed" },
    { key: "emailsSent" },
  ],
};

const validBreakdownChart = {
  key: "replyBreakdown",
  type: "breakdown-bar" as const,
  title: "Reply Breakdown",
  displayOrder: 2,
  segments: [
    { key: "repliesWillingToMeet", color: "green" as const, sentiment: "positive" as const },
    { key: "repliesNotInterested", color: "red" as const, sentiment: "negative" as const },
  ],
};

const validFeature = {
  name: "Sales Cold Email Outreach",
  description: "Automated cold email campaigns targeting prospects matching your ICP.",
  icon: "envelope",
  category: "sales",
  channel: "email",
  audienceType: "cold-outreach",
  implemented: true,
  displayOrder: 1,
  status: "active" as const,
  inputs: [validInput],
  outputs: [validOutput, validOutputWithSort],
  charts: [validFunnelChart, validBreakdownChart],
  entities: [
    { name: "leads", countKey: "leadsServed" },
    { name: "companies" },
    { name: "emails", countKey: "emailsGenerated" },
  ],
};

describe("upsertFeatureSchema", () => {
  it("accepts a valid feature", () => {
    const result = upsertFeatureSchema.safeParse(validFeature);
    expect(result.success).toBe(true);
  });

  it("rejects empty inputs", () => {
    const result = upsertFeatureSchema.safeParse({ ...validFeature, inputs: [] });
    expect(result.success).toBe(false);
  });

  it("rejects empty outputs", () => {
    const result = upsertFeatureSchema.safeParse({ ...validFeature, outputs: [] });
    expect(result.success).toBe(false);
  });

  it("rejects invalid input type", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      inputs: [{ ...validInput, type: "invalid" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown output stats key", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      outputs: [{ key: "nonExistentKey", displayOrder: 1 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown entity type", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      entities: [{ name: "leads" }, { name: "unknown-entity" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown countKey", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      entities: [{ name: "leads", countKey: "nonExistentKey" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts entity without countKey", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      entities: [{ name: "leads" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts entity with valid countKey", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      entities: [{ name: "leads", countKey: "leadsServed" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty entities", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      entities: [],
    });
    expect(result.success).toBe(false);
  });

  it("defaults status to active, implemented to true, displayOrder to 0", () => {
    const { status, implemented, displayOrder, ...minimal } = validFeature;
    const result = upsertFeatureSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("active");
      expect(result.data.implemented).toBe(true);
      expect(result.data.displayOrder).toBe(0);
    }
  });

  it("accepts select type with options", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      inputs: [{
        ...validInput,
        key: "tone",
        label: "Email Tone",
        type: "select",
        options: ["professional", "casual", "friendly"],
      }],
    });
    expect(result.success).toBe(true);
  });

  it("requires placeholder and description on inputs", () => {
    const { placeholder, description, ...missingFields } = validInput;
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      inputs: [missingFields],
    });
    expect(result.success).toBe(false);
  });

  it("requires extractKey on inputs", () => {
    const { extractKey, ...missingExtract } = validInput;
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      inputs: [missingExtract],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing charts", () => {
    const { charts, ...noCharts } = validFeature;
    const result = upsertFeatureSchema.safeParse(noCharts);
    expect(result.success).toBe(false);
  });

  it("rejects charts without funnel-bar", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      charts: [validBreakdownChart],
    });
    expect(result.success).toBe(false);
  });

  it("rejects charts without breakdown-bar", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      charts: [validFunnelChart],
    });
    expect(result.success).toBe(false);
  });

  it("rejects funnel with less than 2 steps", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      charts: [
        { ...validFunnelChart, steps: [{ key: "emailsSent" }] },
        validBreakdownChart,
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects breakdown with less than 2 segments", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      charts: [
        validFunnelChart,
        { ...validBreakdownChart, segments: [validBreakdownChart.segments[0]] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid chart type", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      charts: [{ key: "x", type: "pie", title: "X", displayOrder: 1 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown stats key in funnel step", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      charts: [
        { ...validFunnelChart, steps: [{ key: "emailsSent" }, { key: "unknownKey" }] },
        validBreakdownChart,
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown stats key in breakdown segment", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      charts: [
        validFunnelChart,
        {
          ...validBreakdownChart,
          segments: [
            { key: "unknownKey", color: "green", sentiment: "positive" },
            validBreakdownChart.segments[1],
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("validates breakdown segment color", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      charts: [
        validFunnelChart,
        {
          ...validBreakdownChart,
          segments: [{ ...validBreakdownChart.segments[0], color: "purple" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("requires category, channel, and audienceType", () => {
    const { category, channel, audienceType, ...missing } = validFeature;
    const result = upsertFeatureSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("does not require slug (auto-generated)", () => {
    const result = upsertFeatureSchema.safeParse(validFeature);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).slug).toBeUndefined();
    }
  });
});

describe("batchUpsertFeaturesSchema", () => {
  it("accepts a batch of valid features", () => {
    const result = batchUpsertFeaturesSchema.safeParse({ features: [validFeature] });
    expect(result.success).toBe(true);
  });

  it("rejects empty batch", () => {
    const result = batchUpsertFeaturesSchema.safeParse({ features: [] });
    expect(result.success).toBe(false);
  });
});

describe("createFeatureSchema", () => {
  it("accepts a valid feature without slug (auto-generated)", () => {
    const result = createFeatureSchema.safeParse(validFeature);
    expect(result.success).toBe(true);
  });

  it("accepts a valid feature with explicit slug", () => {
    const result = createFeatureSchema.safeParse({ ...validFeature, slug: "my-custom-slug" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.slug).toBe("my-custom-slug");
    }
  });

  it("rejects empty slug", () => {
    const result = createFeatureSchema.safeParse({ ...validFeature, slug: "" });
    expect(result.success).toBe(false);
  });

  it("inherits all upsertFeatureSchema validation (e.g. rejects empty inputs)", () => {
    const result = createFeatureSchema.safeParse({ ...validFeature, inputs: [] });
    expect(result.success).toBe(false);
  });
});

describe("updateFeatureSchema", () => {
  it("accepts a full update", () => {
    const result = updateFeatureSchema.safeParse(validFeature);
    expect(result.success).toBe(true);
  });

  it("accepts a partial update (name only)", () => {
    const result = updateFeatureSchema.safeParse({ name: "New Name" });
    expect(result.success).toBe(true);
  });

  it("accepts an empty body (no-op update)", () => {
    const result = updateFeatureSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects invalid status", () => {
    const result = updateFeatureSchema.safeParse({ status: "invalid" });
    expect(result.success).toBe(false);
  });

  it("rejects empty inputs array", () => {
    const result = updateFeatureSchema.safeParse({ inputs: [] });
    expect(result.success).toBe(false);
  });

  it("rejects empty outputs array", () => {
    const result = updateFeatureSchema.safeParse({ outputs: [] });
    expect(result.success).toBe(false);
  });

  it("accepts updating only category and channel", () => {
    const result = updateFeatureSchema.safeParse({ category: "pr", channel: "linkedin" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.category).toBe("pr");
      expect(result.data.channel).toBe("linkedin");
      expect(result.data.name).toBeUndefined();
    }
  });

  it("rejects unknown output key in partial update", () => {
    const result = updateFeatureSchema.safeParse({
      outputs: [{ key: "nonExistentKey", displayOrder: 1 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown entity type in partial update", () => {
    const result = updateFeatureSchema.safeParse({
      entities: [{ name: "unknown-entity" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("prefillRequestSchema", () => {
  it("accepts a valid brandId UUID", () => {
    const result = prefillRequestSchema.safeParse({ brandId: "550e8400-e29b-41d4-a716-446655440000" });
    expect(result.success).toBe(true);
  });

  it("rejects non-UUID brandId", () => {
    const result = prefillRequestSchema.safeParse({ brandId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects missing brandId", () => {
    const result = prefillRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
