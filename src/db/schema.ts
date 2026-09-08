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
    /**
     * THE SLUG THAT REPLACED THIS ONE — set when this feature's slug is RETIRED and the same offering
     * is now sold under a different spelling. NULL means "this slug is current", which is every row
     * but the retired ones.
     *
     * It exists because a retired slug cannot simply be deleted: live campaigns, live budgets and the
     * cost ledger reference it, so its row, its stats and everything attributing spend or outcomes to
     * it must keep working exactly as before. What retirement changes is one thing only — whether the
     * slug is PUBLISHED. A row that names a successor is skipped by the public acquisition-channel
     * catalogue (and therefore by the per-pair economics built from it), so an anonymous reader sees
     * the offering exactly once, under the spelling that is current, and cannot book the dead one.
     *
     * This is deliberately a general marker rather than an exclusion list: the next retirement states
     * its own successor here and needs no code change. Naming the successor rather than carrying a
     * bare boolean is what lets a consumer send a reader to where the offering actually lives.
     */
    supersededBySlug: text("superseded_by_slug"),
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

/**
 * FLEET RETURN-ON-SPEND snapshot store (`fleet_return_snapshots`) — one row per acquisition channel.
 *
 * WHY IT IS PERSISTED AND NOT MERELY CACHED. The public landing states, beside two live figures it
 * already reads, the MEDIAN return on spend our clients get. That figure rests on the SAME per-brand
 * expected-pipeline compute the customer's own dashboard runs (`computeFeatureRevenue`, one engine pass
 * per (org, brand)), which takes MINUTES across the fleet and reads a brand's whole lead population —
 * so it can never sit on a landing request, whose budget is 8 seconds and whose fallback is to drop the
 * stat entirely. An in-memory SWR cache does not solve it: a process restart or a quiet night empties
 * it and the very next reader pays the full minutes-long build synchronously.
 *
 * So the heavy compute runs OFF the request path and writes its per-brand rows here; the public read is
 * one indexed SELECT plus arithmetic. The rows stored are the INGREDIENTS (each brand's committed spend
 * and its expected pipeline), never a finished median — so the SPEND FLOOR stays a parameter of the
 * QUESTION (`?minSpendUsd=`), answerable at any value from one snapshot, rather than being frozen into
 * the write. A brand appears here only under its id; no name, no domain, nothing a public response
 * echoes back.
 *
 * DERIVED + REBUILDABLE, unlike `committed_mrr_snapshots`: every row can be recomputed from the
 * siblings at any time, so dropping the table is safe (the next warm refills it). Idempotent: upsert on
 * `feature_slug`, one row per channel, overwritten whole by each warm.
 */
export const fleetReturnSnapshots = pgTable(
  "fleet_return_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Acquisition-channel slug the snapshot is for, unique — one row per channel. */
    featureSlug: text("feature_slug").notNull(),
    /**
     * The per-brand INGREDIENTS, as an array of
     * `{ brandId, committedSpendUsd, expectedPipelineUsd | null }`. `expectedPipelineUsd` is null when
     * the brand has no usable economics — "we could not price this", never a 0 that would say the
     * brand's outreach returned nothing.
     */
    brands: jsonb("brands").notNull(),
    /** When the warm that wrote this row finished — drives the staleness check on read. */
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_fleet_return_snapshots_feature").on(table.featureSlug),
  ]
);

export type FleetReturnSnapshot = typeof fleetReturnSnapshots.$inferSelect;

/**
 * FLEET (CHANNEL × SALES FUNNEL) RETURN-ON-SPEND snapshot store — one row per acquisition channel,
 * holding that channel's per-(brand, funnel) ingredients.
 *
 * The sibling `fleet_return_snapshots` answers "what has a dollar through this CHANNEL come back as".
 * This one answers the narrower question the offer page asks — what a dollar through one SALES FUNNEL
 * came back as, for the clients who sell that funnel through that channel — and it is written by the
 * SAME warm, because both answers are read off the same per-(org, brand) engine passes and running two
 * fan-outs to ask one brand two questions would double the load on lead-service for nothing.
 *
 * WHY IT IS PERSISTED AND NOT MERELY CACHED is the sibling table's reason verbatim: the underlying work
 * is one `computeFeatureRevenue` pass per (org, brand, declared funnel), each reading that brand's
 * whole lead population — minutes across the fleet, on a 384 MB heap — and the consumer is a dashboard
 * page that polls. An in-memory SWR cache does not survive a deploy or a quiet night, and the next
 * reader would pay the full build synchronously.
 *
 * The rows stored are INGREDIENTS (each brand's committed spend, its expected pipeline through the
 * funnel, and how many paying clients that pipeline is), never a finished median — so the SPEND FLOOR
 * stays a parameter of the QUESTION (`?minSpendUsd=`), answerable at any value from one snapshot. A
 * brand appears only under its id; no name, no domain, nothing a public response echoes back.
 *
 * DERIVED + REBUILDABLE: every row can be recomputed from the siblings, so dropping the table is safe
 * (the next warm refills it). Idempotent: upsert on `feature_slug`, overwritten WHOLE by each warm — a
 * brand that stopped selling a funnel must leave the population, and merging would keep it forever.
 */
export const fleetFunnelReturnSnapshots = pgTable(
  "fleet_funnel_return_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Acquisition-channel slug the snapshot is for, unique — one row per channel. */
    featureSlug: text("feature_slug").notNull(),
    /**
     * The per-(brand, funnel) INGREDIENTS, as an array of
     * `{ brandId, funnelKey, committedSpendUsd, expectedPipelineUsd | null, expectedPaidClients | null }`.
     * Both nullable figures are null when the brand has no usable economics — "we could not price
     * this", never a 0 that would say the outreach returned nothing.
     */
    rows: jsonb("rows").notNull(),
    /** When the warm that wrote this row finished — drives the staleness check on read. */
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_fleet_funnel_return_snapshots_feature").on(table.featureSlug),
  ]
);

export type FleetFunnelReturnSnapshot = typeof fleetFunnelReturnSnapshots.$inferSelect;
