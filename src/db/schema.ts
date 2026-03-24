import { pgTable, uuid, text, timestamp, uniqueIndex, jsonb } from "drizzle-orm/pg-core";

/**
 * Feature input field definition.
 * All inputs are required and will be pre-filled by LLM based on brand context.
 */
export interface FeatureInput {
  /** Machine-readable key, e.g. "target_audience" */
  key: string;
  /** Human-readable label for the form, e.g. "Target Audience" */
  label: string;
  /** Input type for the form: "text", "textarea", "number", "url", "select" */
  type: "text" | "textarea" | "number" | "url" | "select";
  /** Rich description explaining what this field means and what a good value looks like.
   *  Used by the LLM to pre-fill the field and by the UI as helper text. */
  description: string;
  /** For "select" type: the available options */
  options?: string[];
}

/**
 * Feature output metric definition.
 * Describes a KPI that the dashboard will display for campaigns using this feature.
 */
export interface FeatureOutput {
  /** Machine-readable key, e.g. "emails_sent" */
  key: string;
  /** Human-readable label, e.g. "Emails Sent" */
  label: string;
  /** Display type for formatting: "count", "percentage", "currency", "text" */
  type: "count" | "percentage" | "currency" | "text";
  /** Description for tooltip or context */
  description?: string;
}

export const features = pgTable(
  "features",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Unique machine-readable identifier, e.g. "sales-cold-email" */
    slug: text("slug").notNull().unique(),

    /** Display name, e.g. "Sales Cold Email Outreach" */
    name: text("name").notNull(),

    /** Short description of what this feature does */
    description: text("description").notNull(),

    /** Icon identifier for the dashboard (e.g. lucide-react icon name like "mail-check") */
    icon: text("icon").notNull(),

    /** Feature lifecycle status */
    status: text("status").notNull().default("active"),

    /** Input fields that the user fills (pre-filled by LLM from brand context) */
    inputs: jsonb("inputs").notNull().$type<FeatureInput[]>(),

    /** Output metrics displayed on the dashboard for campaigns using this feature */
    outputs: jsonb("outputs").notNull().$type<FeatureOutput[]>(),

    /** Default workflow name in workflow-service to execute for this feature */
    defaultWorkflowName: text("default_workflow_name"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_features_slug").on(table.slug),
  ]
);

export type Feature = typeof features.$inferSelect;
export type NewFeature = typeof features.$inferInsert;
