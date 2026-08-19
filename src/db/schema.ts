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
    /**
     * WHICH SALES FUNNELS THIS FEATURE MAY BE SOLD THROUGH — a product statement about the feature,
     * owned here, read by the dashboard (to offer only valid pairs) and by campaign-service (to refuse
     * an invalid one). Values are brand-service's own funnel keys; no funnel is invented here.
     *
     * ALWAYS STATED, so absence can never be mistaken for "all of them": a feature that sells through
     * no sales funnel states `[]`, and one that sells through every declared funnel states all four
     * keys explicitly. A consumer reading a shorter list than the catalogue's is reading a real
     * restriction, not a gap. NOT NULL with a `[]` default, so an unseeded row reads "none" — the safe
     * side of that distinction, since offering nothing is recoverable and offering nonsense is not.
     */
    salesFunnels: jsonb("sales_funnels").notNull().default([]),
    /**
     * THE ACQUISITION CHANNEL THIS FEATURE IS — its commercial terms (what operating it costs for a
     * day whatever the volume, the minimum commitment in days, the upper bound on how long after
     * booking it starts producing) and the kinds of step it can PRODUCE. Read publicly, with no
     * customer identity, because the marketing site is generated from it and must never be able to
     * drift from what we actually charge.
     *
     * NULL is a written statement, not a gap: this feature is not an acquisition channel (hiring,
     * investor and accelerator outreach, outlet discovery, press-kit generation, AI visibility). The
     * seed states it on every row, and a row the seed has not reached reads NULL — the restrictive
     * side, since publishing nothing is recoverable and publishing terms nobody set is not.
     *
     * There is deliberately NO availability / "coming soon" flag in here. Every published channel is
     * bookable; a channel we are slower to deliver says so through these very terms.
     */
    acquisitionChannel: jsonb("acquisition_channel"),
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

/**
 * COMMITTED-MRR daily snapshot store (point-in-time run-rate history).
 *
 * Committed MRR = the fleet's currently-active brands' daily budget × 30 — what we are CONTRACTED to
 * bill, NOT what we actually billed (that is the realized-revenue series, reconstructed from spend).
 * It is a POINT-IN-TIME SNAPSHOT that CANNOT be reconstructed from realized spend (spend ≠ budget, and
 * the fleet grows over time), so it is PERSISTED here — one row per UTC day, recorded going forward
 * whenever the fleet committed budget is computed (accounts audit / revenue history handler). No
 * historical backfill is possible: the series legitimately starts at the first recorded snapshot and
 * lengthens each day. Idempotent: upsert on `snapshot_date` (one row/day; today's row reflects the
 * latest committed budget seen that day). Derived + rebuildable is FALSE here — unlike the Gold view
 * cache, these rows are the ONLY record of past committed run-rate, so they are never dropped.
 */
export const committedMrrSnapshots = pgTable(
  "committed_mrr_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** UTC calendar day of the snapshot (`YYYY-MM-DD`), unique — one row per day. */
    snapshotDate: text("snapshot_date").notNull(),
    /** Σ active brands' daily budget for the day, in whole cents (FP-safe). MRR = ×30, ARR = MRR ×12. */
    committedDailyBudgetCents: integer("committed_daily_budget_cents").notNull(),
    /** Count of ACTIVE (org, brand) accounts contributing to the committed budget that day. */
    activeCount: integer("active_count").notNull(),
    /** When this row was last written (drifts through the day as the upsert refreshes it). */
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_committed_mrr_snapshots_date").on(table.snapshotDate),
  ]
);

export type CommittedMrrSnapshot = typeof committedMrrSnapshots.$inferSelect;
