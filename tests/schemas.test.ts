import { describe, it, expect } from "vitest";
import { upsertFeatureSchema, batchUpsertFeaturesSchema } from "../src/lib/schemas.js";

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
  key: "leadsServed",
  label: "Leads",
  type: "count" as const,
  displayOrder: 1,
  showInCampaignRow: true,
  showInFunnel: true,
  funnelOrder: 1,
};

const validRateOutput = {
  key: "positiveReplyRate",
  label: "Positive Reply Rate",
  type: "rate" as const,
  displayOrder: 7,
  showInCampaignRow: false,
  showInFunnel: false,
  numeratorKey: "repliesWillingToMeet",
  denominatorKey: "emailsContacted",
};

const validWorkflowColumn = {
  key: "openRate",
  label: "% Opens",
  type: "rate" as const,
  numeratorKey: "opened",
  denominatorKey: "sent",
  sortDirection: "desc" as const,
  displayOrder: 1,
};

const validFunnelChart = {
  key: "funnel",
  type: "funnel-bar" as const,
  title: "Campaign Funnel",
  displayOrder: 1,
  steps: [
    { key: "leadsServed", label: "Leads", statsField: "leadsServed", rateBasedOn: null },
    { key: "emailsGenerated", label: "Generated", statsField: "emailsGenerated", rateBasedOn: "leadsServed" },
  ],
};

const validBreakdownChart = {
  key: "replyBreakdown",
  type: "breakdown-bar" as const,
  title: "Reply Breakdown",
  displayOrder: 2,
  segments: [
    { key: "willingToMeet", label: "Willing to meet", statsField: "repliesWillingToMeet", color: "green" as const, sentiment: "positive" as const },
    { key: "notInterested", label: "Not interested", statsField: "repliesNotInterested", color: "red" as const, sentiment: "negative" as const },
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
  outputs: [validOutput, validRateOutput],
  workflowColumns: [validWorkflowColumn],
  charts: [validFunnelChart, validBreakdownChart],
  resultComponent: null,
  defaultWorkflowName: "sales-cold-email-v1",
};

describe("upsertFeatureSchema", () => {
  it("accepts a valid feature with all 6 blocks", () => {
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

  it("rejects invalid output type", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      outputs: [{ ...validOutput, type: "invalid" }],
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

  it("accepts feature without optional workflowColumns and charts", () => {
    const { workflowColumns, charts, ...minimal } = validFeature;
    const result = upsertFeatureSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workflowColumns).toEqual([]);
      expect(result.data.charts).toEqual([]);
    }
  });

  it("rejects invalid chart type", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      charts: [{ key: "x", type: "pie", title: "X", displayOrder: 1 }],
    });
    expect(result.success).toBe(false);
  });

  it("validates funnel chart steps", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      charts: [{
        key: "funnel",
        type: "funnel-bar",
        title: "Funnel",
        displayOrder: 1,
        steps: [],
      }],
    });
    expect(result.success).toBe(false);
  });

  it("validates breakdown chart segments", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      charts: [{
        key: "breakdown",
        type: "breakdown-bar",
        title: "Breakdown",
        displayOrder: 1,
        segments: [],
      }],
    });
    expect(result.success).toBe(false);
  });

  it("requires category, channel, and audienceType", () => {
    const { category, channel, audienceType, ...missing } = validFeature;
    const result = upsertFeatureSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it("validates workflow column sortDirection", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      workflowColumns: [{ ...validWorkflowColumn, sortDirection: "invalid" }],
    });
    expect(result.success).toBe(false);
  });

  it("validates breakdown segment color", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      charts: [{
        ...validBreakdownChart,
        segments: [{ ...validBreakdownChart.segments[0], color: "purple" }],
      }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts resultComponent string", () => {
    const result = upsertFeatureSchema.safeParse({
      ...validFeature,
      resultComponent: "discovered-outlets",
    });
    expect(result.success).toBe(true);
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
