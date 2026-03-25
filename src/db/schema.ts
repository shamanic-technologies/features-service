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
  /** Stats key from the registry, e.g. "emailsReplied", "replyRate" */
  key: string;
  /** Display order in tables */
  displayOrder: number;
  /** Whether this column is sorted by default in the workflow ranking table */
  defaultSort?: boolean;
  /** Sort direction when this is the active sort column */
  sortDirection?: "asc" | "desc";
}

// ── Chart definition ────────────────────────────────────────────────────────

export interface FunnelStep {
  /** Stats key from the registry */
  key: string;
}

export interface BreakdownSegment {
  /** Stats key from the registry */
  key: string;
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

    /** Output metrics — stats keys from the registry with display config */
    outputs: jsonb("outputs").notNull().$type<FeatureOutput[]>(),

    /** Chart definitions (funnel, breakdown) */
    charts: jsonb("charts").notNull().$type<FeatureChart[]>(),

    /** Entity types shown in campaign detail sidebar (e.g. ["leads", "companies", "emails"]) */
    entities: jsonb("entities").notNull().$type<string[]>(),

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
