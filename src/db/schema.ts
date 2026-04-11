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
  /** Stats key from the registry, e.g. "repliesPositive", "positiveReplyRate" */
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

// ── Entity definition ────────────────────────────────────────────────────────

export interface FeatureEntity {
  /** Entity type name, e.g. "leads", "journalists" */
  name: string;
  /** Optional stats key whose value is the entity count for this campaign */
  countKey?: string;
}

// ── Table definition ────────────────────────────────────────────────────────

export const features = pgTable(
  "features",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // ── Dynasty identity (internal) ──────────────────────────────────────────

    /** Root concept name, shared across forked dynasties (e.g. "Sales Cold Email"). Internal only */
    baseName: text("base_name").notNull(),

    /** Auto-generated codename for forked dynasties (e.g. "Sophia"). NULL for the original */
    forkName: text("fork_name"),

    // ── Dynasty identity (exposed) ───────────────────────────────────────────

    /** Stable name across all versions: base_name + (fork_name ? " " + fork_name : "") */
    dynastyName: text("dynasty_name").notNull(),

    /** Stable slug across all versions: slugify(dynasty_name) */
    dynastySlug: text("dynasty_slug").notNull(),

    /** Version number within the dynasty (1-based). v1 = no suffix in name/slug */
    version: integer("version").notNull().default(1),

    // ── Versioned identity ───────────────────────────────────────────────────

    /** Globally unique versioned slug: dynasty_slug + (version > 1 ? "-v" + version : "") */
    slug: text("slug").notNull().unique(),

    /** Globally unique versioned name: dynasty_name + (version > 1 ? " v" + version : "") */
    name: text("name").notNull().unique(),

    // ── Definition ───────────────────────────────────────────────────────────

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
     * Globally unique — forces convergence when two dynasties produce the same definition.
     */
    signature: text("signature").notNull().unique(),

    /** Input fields for campaign creation form (pre-filled by LLM) */
    inputs: jsonb("inputs").notNull().$type<FeatureInput[]>(),

    /** Output metrics — stats keys from the registry with display config */
    outputs: jsonb("outputs").notNull().$type<FeatureOutput[]>(),

    /** Chart definitions (funnel, breakdown) */
    charts: jsonb("charts").notNull().$type<FeatureChart[]>(),

    /** Entity types shown in campaign detail sidebar, each with an optional countKey linking to a stats metric */
    entities: jsonb("entities").notNull().$type<FeatureEntity[]>(),

    /** If this feature was forked from another, the ID of the original */
    forkedFrom: uuid("forked_from"),

    /** If deprecated, the ID of the replacement feature */
    upgradedTo: uuid("upgraded_to"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_features_slug").on(table.slug),
    uniqueIndex("idx_features_signature").on(table.signature),
    uniqueIndex("idx_features_name").on(table.name),
    uniqueIndex("idx_features_dynasty_version").on(table.dynastySlug, table.version),
  ]
);

export type Feature = typeof features.$inferSelect;
export type NewFeature = typeof features.$inferInsert;
