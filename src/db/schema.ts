import { pgTable, uuid, text, timestamp, uniqueIndex, jsonb, boolean, integer } from "drizzle-orm/pg-core";

// ── Input field definition ──────────────────────────────────────────────────

export interface FeatureInput {
  /** Machine-readable key, e.g. "targetAudience" */
  key: string;
  /** Human-readable label for the form, e.g. "Target Audience" */
  label: string;
  /** Input type for the form */
  type: "text" | "textarea" | "number" | "select";
  /** Placeholder text shown in the form field */
  placeholder: string;
  /** Rich description for LLM pre-fill context — explains what this field means and what a good value looks like */
  description: string;
  /** Mapping key to brand-extract for auto pre-fill from brand data */
  extractKey: string;
  /** For "select" type: the available options */
  options?: string[];
}

// ── Output metric definition ────────────────────────────────────────────────

export interface FeatureOutput {
  /** Machine-readable key, e.g. "leadsServed" */
  key: string;
  /** Human-readable label, e.g. "Leads" */
  label: string;
  /** Display type for formatting */
  type: "count" | "rate" | "currency" | "percentage";
  /** Display order in the metrics row */
  displayOrder: number;
  /** Show in the campaign row on the campaign list page */
  showInCampaignRow: boolean;
  /** Show in the funnel chart at the top of the feature page */
  showInFunnel: boolean;
  /** Position in the funnel (only when showInFunnel is true) */
  funnelOrder?: number;
  /** For "rate" type: numerator stats field key */
  numeratorKey?: string;
  /** For "rate" type: denominator stats field key */
  denominatorKey?: string;
}

// ── Workflow column definition ──────────────────────────────────────────────

export interface WorkflowColumn {
  /** Column key, e.g. "openRate" */
  key: string;
  /** Column header label, e.g. "% Opens" */
  label: string;
  /** Value type */
  type: "rate" | "currency" | "count";
  /** For computed columns: numerator stats field */
  numeratorKey?: string;
  /** For computed columns: denominator stats field */
  denominatorKey?: string;
  /** Sort direction: desc = higher is better, asc = lower is better */
  sortDirection: "asc" | "desc";
  /** Column display order */
  displayOrder: number;
  /** Whether this column is sorted by default */
  defaultSort?: boolean;
}

// ── Chart definition ────────────────────────────────────────────────────────

export interface FunnelStep {
  key: string;
  label: string;
  /** Field name in the CampaignStats object */
  statsField: string;
  /** Key of the step to compute conversion rate against (null for first step) */
  rateBasedOn: string | null;
}

export interface BreakdownSegment {
  key: string;
  label: string;
  /** Field name in the CampaignStats object */
  statsField: string;
  color: "green" | "blue" | "red" | "gray" | "orange";
  sentiment: "positive" | "neutral" | "negative";
}

export interface FunnelBarChart {
  key: string;
  type: "funnel-bar";
  title: string;
  displayOrder: number;
  steps: FunnelStep[];
}

export interface BreakdownBarChart {
  key: string;
  type: "breakdown-bar";
  title: string;
  displayOrder: number;
  segments: BreakdownSegment[];
}

export type FeatureChart = FunnelBarChart | BreakdownBarChart;

// ── Table definition ────────────────────────────────────────────────────────

export const features = pgTable(
  "features",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Unique machine-readable identifier, auto-generated from name (e.g. "sales-cold-email-v2") */
    slug: text("slug").notNull().unique(),

    /** Display name, e.g. "Sales Cold Email v2" — must be unique */
    name: text("name").notNull().unique(),

    /** Short description of what this feature does */
    description: text("description").notNull(),

    /** Icon identifier for the dashboard (e.g. "envelope") */
    icon: text("icon").notNull(),

    /** Feature category for grouping (e.g. "sales", "pr", "discovery") */
    category: text("category").notNull(),

    /** Communication channel (e.g. "email", "phone", "linkedin") */
    channel: text("channel").notNull(),

    /** Determines which form layout to use (e.g. "cold-outreach", "discovery") */
    audienceType: text("audience_type").notNull(),

    /** Whether this feature is implemented or "coming soon" */
    implemented: boolean("implemented").notNull().default(true),

    /** Display order in sidebar and listings */
    displayOrder: integer("display_order").notNull().default(0),

    /** Feature lifecycle status */
    status: text("status").notNull().default("active"),

    /**
     * Signature = deterministic hash of sorted(input keys) + sorted(output keys).
     * Two features with the same signature are the same feature (upsert).
     * Two features with different signatures but the same name get auto-suffixed (v2, v3…).
     */
    signature: text("signature").notNull().unique(),

    /** Input fields for campaign creation form (pre-filled by LLM) */
    inputs: jsonb("inputs").notNull().$type<FeatureInput[]>(),

    /** Output metrics displayed on dashboard for campaigns */
    outputs: jsonb("outputs").notNull().$type<FeatureOutput[]>(),

    /** Column definitions for the workflow performance table */
    workflowColumns: jsonb("workflow_columns").notNull().$type<WorkflowColumn[]>().default([]),

    /** Chart definitions (funnel, breakdown, etc.) */
    charts: jsonb("charts").notNull().$type<FeatureChart[]>().default([]),

    /** Specialized result component for discovery/press-kit features (null for standard features) */
    resultComponent: text("result_component"),

    /** Default workflow name in workflow-service */
    defaultWorkflowName: text("default_workflow_name"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_features_slug").on(table.slug),
    uniqueIndex("idx_features_signature").on(table.signature),
    uniqueIndex("idx_features_name").on(table.name),
  ]
);

export type Feature = typeof features.$inferSelect;
export type NewFeature = typeof features.$inferInsert;
