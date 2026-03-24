import { describe, it, expect } from "vitest";
import { upsertFeatureSchema, batchUpsertFeaturesSchema } from "../src/lib/schemas.js";

const validFeature = {
  slug: "sales-cold-email",
  name: "Sales Cold Email Outreach",
  description: "Automated cold email campaigns targeting prospects matching your ICP.",
  icon: "mail-check",
  status: "active" as const,
  inputs: [
    {
      key: "target_audience",
      label: "Target Audience",
      type: "textarea" as const,
      description:
        "The specific audience segment this campaign targets. Be precise about demographics, job titles, industry, and company size. Example: 'VP of Marketing at B2B SaaS companies with 50-200 employees in the US'.",
    },
    {
      key: "value_proposition",
      label: "Value Proposition",
      type: "textarea" as const,
      description:
        "The core value your product or service provides to the target audience. Focus on the outcome, not the features. Example: 'We help marketing teams generate 3x more qualified leads by automating personalized outreach'.",
    },
  ],
  outputs: [
    {
      key: "emails_sent",
      label: "Emails Sent",
      type: "count" as const,
    },
    {
      key: "positive_reply_rate",
      label: "Positive Reply Rate",
      type: "percentage" as const,
      description: "Percentage of replies classified as interested or positive",
    },
  ],
  defaultWorkflowName: "sales-cold-email-v1",
};

describe("upsertFeatureSchema", () => {
  it("accepts a valid feature", () => {
    const result = upsertFeatureSchema.safeParse(validFeature);
    expect(result.success).toBe(true);
  });

  it("rejects invalid slug format", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      slug: "Sales Cold Email",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty inputs", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      inputs: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty outputs", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      outputs: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid input type", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      inputs: [
        {
          key: "test",
          label: "Test",
          type: "invalid",
          description: "Test field",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid output type", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      outputs: [
        {
          key: "test",
          label: "Test",
          type: "invalid",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("defaults status to active when not provided", () => {
    const { status, ...withoutStatus } = validFeature;
    const result = upsertFeatureSchema.safeParse(withoutStatus);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("active");
    }
  });

  it("accepts select type with options", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      inputs: [
        {
          key: "tone",
          label: "Email Tone",
          type: "select",
          description: "The tone of the email outreach",
          options: ["professional", "casual", "friendly"],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("requires description on inputs", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      inputs: [
        {
          key: "test",
          label: "Test",
          type: "text",
          // missing description
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("batchUpsertFeaturesSchema", () => {
  it("accepts a batch of valid features", () => {
    const result = batchUpsertFeaturesSchema.safeParse({
      features: [validFeature],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty batch", () => {
    const result = batchUpsertFeaturesSchema.safeParse({
      features: [],
    });
    expect(result.success).toBe(false);
  });
});
