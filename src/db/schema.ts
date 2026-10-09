import { pgTable, uuid, text, boolean, integer, jsonb, timestamp, uniqueIndex, index, primaryKey } from "drizzle-orm/pg-core";

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
     * no sales funnel states `[]`, and one that sells through every declared funnel states all of those
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
    /** `scope_key` without its fingerprint parts (`view-cache.familyKeyOf`) — finds the previous cell. */
    familyKey: text("family_key"),
    orgId: uuid("org_id").notNull(),
    /** The exact response body served for this scope. */
    body: jsonb("body").notNull(),
    /**
     * The same body as its exact JSON TEXT (`JSON.stringify` of the computed value). A hit serves this
     * text as the response bytes, with no jsonb decode, no parse and no re-stringify on the serving loop
     * (`view-cache.servedCachedJson`). Null on a row written before the column existed: `body` answers.
     */
    bodyText: text("body_text"),
    /** When `body` was computed — drives the TTL freshness check. */
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Single-flight guard: set while a background revalidate is in flight (claim cross-replica). */
    refreshingAt: timestamp("refreshing_at", { withTimezone: true }),
    /**
     * The GET that produced this cell (path + query), replayable against the refresher so the cell can
     * be precomputed for a sibling scope or re-verified without a customer asking (`lib/view-keeper.ts`).
     */
    replayUrl: text("replay_url"),
    /** That request's identity headers, WITHOUT the api key (the keeper injects this service's own). */
    replayHeaders: jsonb("replay_headers"),
    /** The brand the request named (header, query or path) — what the facts fingerprint is taken for. */
    brandId: text("brand_id"),
    /**
     * The brand's FACTS FINGERPRINT taken just BEFORE this body was computed (`lib/view-facts.ts`). A
     * stale cell whose brand still reads the same fingerprint is served without a recompute.
     */
    factsFingerprint: text("facts_fingerprint"),
    /** When a CUSTOMER last read this cell. Null = never (a precomputed cell). Drives retention. */
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_feature_view_snapshots_view_scope").on(table.view, table.scopeKey),
    index("idx_feature_view_snapshots_family").on(table.view, table.familyKey, table.computedAt),
    index("idx_feature_view_snapshots_brand_read").on(table.brandId, table.lastReadAt),
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
 * RECURRING MRR daily snapshots (`recurring_mrr_org_snapshots`) — one row per (UTC day, org): what
 * billing-service stated as that org's RECURRING MRR that day (`GET /internal/revenue/fleet`). From
 * 2026-09-29 this is the basis of every recorded MRR point (the committed series and the agency /
 * self-serve split); `committed_mrr_snapshots` (running budget × 30) is the legacy basis before it, kept
 * for history and no longer written. Per ORG rather than a fleet total so the split can be re-summed
 * over whichever orgs are agency. Not rebuildable: billing does not keep its verdict over time.
 */
export const recurringMrrOrgSnapshots = pgTable(
  "recurring_mrr_org_snapshots",
  {
    /** UTC calendar day (`YYYY-MM-DD`). */
    snapshotDate: text("snapshot_date").notNull(),
    orgId: uuid("org_id").notNull(),
    /** billing's class that day (`recurring` | `one_off` | `none`), or `unreadable` when billing could not read the org. */
    revenueClass: text("revenue_class").notNull(),
    /** billing's MRR in cents as decimal text; NULL = unknown that day (never a 0). */
    mrrCents: text("mrr_cents"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.snapshotDate, table.orgId] })]
);

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

/**
 * STATED MONTHLY AMOUNTS (`stated_monthly_amounts`) — what a HUMAN says a brand is worth per month,
 * over a date range. The whole reason this table exists: not every customer's monthly worth is
 * `daily budget × 30`.
 *
 * A SELF-SERVE (SaaS) customer pays through the product, so their committed run-rate IS their daily
 * budget × 30 and nothing needs stating. An AGENCY does not: it hands over cash at its own discretion
 * and somebody then DECIDES how that cash is split into daily budgets across its brands. For those
 * brands a daily budget is an ALLOCATION DECISION, so budget × 30 is simply the wrong number — the
 * only true figure is the one a person states here.
 *
 * WHICH ORGS ARE "AGENCY" IS DERIVED FROM THESE ROWS, never hardcoded: an org carrying at least one
 * stated amount is on the agency side; every other org is self-serve. A second agency later needs no
 * code change.
 *
 * KEYED ON THE (org, brand) PAIR, not on the brand alone — daily budgets are keyed that way and one
 * brand can legitimately be mapped under two orgs (one funding it, one at $0), so a brand-keyed row
 * could not say which of the two it describes.
 *
 * BOTH ENDS OF THE RANGE ARE OPTIONAL and each absence means something specific: no `startDate` = in
 * force since that brand's FIRST DAY OF BILLED SPEND (never "since the beginning of time"); no
 * `endDate` = still running. Both bounds are INCLUSIVE. A brand can carry SEVERAL rows over time (the
 * amount changes), but two rows that overlap on a single day for one pair are REFUSED at write time —
 * two answers for one brand on one day is exactly the bug this table exists to avoid, and no read
 * could pick between them honestly.
 */
export const statedMonthlyAmounts = pgTable(
  "stated_monthly_amounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The org that funds this brand — the pair's first half. An org with any row here is "agency". */
    orgId: uuid("org_id").notNull(),
    /** The brand the stated amount is about — the pair's second half. */
    brandId: uuid("brand_id").notNull(),
    /** What a person says this brand is worth PER MONTH, in whole cents (FP-safe). A stated 0 is a real answer. */
    amountCents: integer("amount_cents").notNull(),
    /** First UTC day the amount is in force (`YYYY-MM-DD`, inclusive). NULL = since the brand's first billed day. */
    startDate: text("start_date"),
    /** Last UTC day the amount is in force (`YYYY-MM-DD`, inclusive). NULL = still running. */
    endDate: text("end_date"),
    /** Free-text note from whoever stated it (why this figure) — never read by any computation. */
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export type StatedMonthlyAmount = typeof statedMonthlyAmounts.$inferSelect;

/**
 * WHICH WORKFLOWS MAY RUN ON A LEG — a STATED assignment per (acquisition channel, leg, workflow
 * dynasty), never derived from anything about the workflow (supersedes the model-tier rule).
 *
 * A dynasty runs on a leg only if the owner put it there: `active` = campaign-service may pick it on
 * this leg; `deprecated` = no new run picks it here, but every stats read keeps serving it with its
 * history. A dynasty with no row for the leg is NOT ASSIGNED and is never selectable on it — a new
 * workflow dynasty is on no leg until someone assigns it. workflow-service's own global dynasty status
 * is untouched and still wins (a globally deprecated dynasty is not enumerated at all).
 *
 * `feature_slug` IS the acquisition channel (this fleet has no other name for one). Seeded
 * (migration 0017) with every dynasty that had already served at least one lead on a campaign
 * performing that leg, all `active` — the owner's explicit decision.
 */
export const workflowLegAssignments = pgTable(
  "workflow_leg_assignments",
  {
    featureSlug: text("feature_slug").notNull(),
    legKey: text("leg_key").notNull(),
    workflowDynastySlug: text("workflow_dynasty_slug").notNull(),
    /** `active` | `deprecated`. Absence of a row is the third state: never assigned. */
    state: text("state").notNull(),
    /** Who decided the CURRENT state (a person, an assistant acting for them, or `seed:…`). */
    decidedBy: text("decided_by").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    /** Why — free text, never read by any computation. */
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_workflow_leg_assignments").on(t.featureSlug, t.legKey, t.workflowDynastySlug),
  ],
);

export type WorkflowLegAssignment = typeof workflowLegAssignments.$inferSelect;

/**
 * The append-only history of every assignment write — one row per decision, so "who deprecated this,
 * when, and what was it before" always has an answer. Written in the same transaction as the state.
 */
export const workflowLegAssignmentChanges = pgTable("workflow_leg_assignment_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  featureSlug: text("feature_slug").notNull(),
  legKey: text("leg_key").notNull(),
  workflowDynastySlug: text("workflow_dynasty_slug").notNull(),
  /** NULL = the dynasty was not assigned to this leg before this decision. */
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  decidedBy: text("decided_by").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  note: text("note"),
});

/**
 * The NAME of every sales path combination ever shown (`lib/sales-path-names.ts`): one poetic word,
 * shared across every client, written once and never updated or deleted — a name never moves to
 * another combination and is never given twice.
 */
export const salesPathCombinationNames = pgTable("sales_path_combination_names", {
  /** `combinationKeyOf` (`lib/offer-sales-paths.ts`): the legs in order, each managed leg `@<channel slug>`. */
  combinationKey: text("combination_key").primaryKey(),
  name: text("name").notNull().unique(),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * THE TRIGGER TYPES (`lib/channel-triggers.ts`, owner 2026-10-09): one row per KIND of event that runs a
 * reactive leg ("a positive reply was received", "a campaign asked for a lead"). Code-stated and upserted on
 * every boot (`registerChannelTriggerTypes`), so every trigger a leg names has a row here. `coded` says the
 * event is fired by a service today. The EVENTS themselves (one per occurrence, fired or skipped) and the
 * per-campaign On/Off live in campaign-service.
 */
export const channelTriggerTypes = pgTable("channel_trigger_types", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  description: text("description").notNull(),
  icon: text("icon").notNull(),
  /** The step a lead reached that fires it; null when it is not a step (a campaign asking for a lead). */
  fromStep: text("from_step"),
  /** The service that detects the event and rings campaign-service's door. */
  firedBy: text("fired_by").notNull(),
  coded: boolean("coded").notNull(),
  displayOrder: integer("display_order").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
