import { pgTable, uuid, text, boolean, integer, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const features = pgTable(
  "features",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull().unique(),
    description: text("description").notNull(),
    icon: text("icon").notNull(),
    implemented: boolean("implemented").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    status: text("status").notNull().default("active"),
    inputs: jsonb("inputs").notNull(),
    outputs: jsonb("outputs").notNull(),
    charts: jsonb("charts").notNull(),
    entities: jsonb("entities").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_features_slug").on(table.slug),
    uniqueIndex("idx_features_name").on(table.name),
  ]
);

export type Feature = typeof features.$inferSelect;

/**
 * Gold serving layer (CQRS read model). A denormalized snapshot of an expensive feature view
 * response (revenue / stats), keyed by its full query scope. The authed dashboard endpoints read
 * this O(1) instead of live-fanning-out to N cold-starting siblings on every request; a background
 * stale-while-revalidate refresh recomputes a viewed cell ~once per TTL, OFF the request path.
 *
 * Derived + rebuildable — the owning siblings stay source-of-truth (Kleppmann); dropping every row
 * is safe (next read recomputes). NOT written directly by any external API.
 */
export const featureViewSnapshots = pgTable(
  "feature_view_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Logical view family: "revenue" | "revenue-grouped" | "revenue-lens" | "stats". */
    view: text("view").notNull(),
    /** Canonical key over ALL inputs that change the body (featureSlug + sorted query string). */
    scopeKey: text("scope_key").notNull(),
    orgId: uuid("org_id").notNull(),
    /** The exact response body served for this scope. */
    body: jsonb("body").notNull(),
    /** When `body` was computed — drives the TTL freshness check. */
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Single-flight guard: set while a background revalidate is in flight (claim cross-replica). */
    refreshingAt: timestamp("refreshing_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_feature_view_snapshots_view_scope").on(table.view, table.scopeKey),
  ]
);

export type FeatureViewSnapshot = typeof featureViewSnapshots.$inferSelect;
