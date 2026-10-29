import { pgTable, doublePrecision, uuid, text, boolean, integer, bigint, jsonb, timestamp, uniqueIndex, index, primaryKey, numeric } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
/**
 * A NAME TAKEN BACK (owner GO 2026-10-10: the ~20 pipes named before the families split are renamed to birds).
 * A retired name is never given again, to any object of any family: `lib/sales-path-names.ts` counts these
 * rows as used. `replaced_by` = the name the object carries now.
 */
export const retiredNames = pgTable("retired_names", {
  name: text("name").primaryKey(),
  combinationKey: text("combination_key").notNull(),
  replacedBy: text("replaced_by").notNull(),
  reason: text("reason").notNull(),
  retiredAt: timestamp("retired_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * THE MARK of a workflow dynasty or a template dynasty (MARKS-1022, `lib/catalogue-marks.ts`): its own icon + colour,
 * written once on first sight, never updated nor deleted, unique per family.
 */
export const catalogueMarks = pgTable(
  "catalogue_marks",
  {
    family: text("family").notNull(),
    objectKey: text("object_key").notNull(),
    icon: text("icon").notNull(),
    color: text("color").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "catalogue_marks_pk", columns: [t.family, t.objectKey] }), uniqueIndex("catalogue_marks_family_mark_unique").on(t.family, t.icon, t.color)],
);

export const salesPathCombinationNames = pgTable("sales_path_combination_names", {
  /** `combinationKeyOf` (`lib/offer-sales-paths.ts`): the legs in order, each managed leg `@<channel slug>`. */
  combinationKey: text("combination_key").primaryKey(),
  /** Unique per pipe (`campaign:`) and path (`path:`) only: two sales funnels may share one (migration 0050,
   *  FUNNEL-NAMES-NO-NUMBERS-1027: a funnel name never carries a number). */
  name: text("name").notNull(),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  /** WITHDRAWN 2026-10-11 (owner): the one-sentence funnel description, written once by v0.179.134. Kept, unread. */
  description: text("description"),
}, (t) => [uniqueIndex("sales_path_combination_names_catalogue_name_unique").on(t.name).where(sql`${t.combinationKey} LIKE 'campaign:%' OR ${t.combinationKey} LIKE 'path:%'`)]);

/**
 * THE TRIGGER TYPES (`lib/channel-triggers.ts`, owner 2026-10-09): one row per KIND of event that runs a
 * reactive leg ("a positive reply was received", "a campaign asked for a lead"). Code-stated and upserted on
 * every boot (`registerChannelTriggerTypes`), so every trigger a leg names has a row here. `coded` says the
 * event is fired by a service today. The EVENTS themselves (one per occurrence, fired or skipped) and the
 * per-campaign On/Off live in campaign-service.
 */
export const channelTriggerTypes = pgTable("channel_trigger_types", {
  /** The trigger's SLUG, unique. */
  id: text("id").primaryKey(),
  /** The trigger's NAME, unique case-insensitive among live triggers (index `channel_trigger_types_label_lower_unique`, migration 0026, partial on `retired_at IS NULL` since 0035). */
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
  /** `code` = stated in `lib/channel-triggers.ts` (upserted and pruned on boot); `declared` = created at run
   *  time through `/internal/declarations/trigger-types` (never pruned, never `coded` until a detector fires
   *  its kind, `lib/channel-declarations.ts`). */
  origin: text("origin").notNull().default("code"),
  /** `event` (a service detects it), `delay` (N days after a step, if nothing happened), `poll` (a new item at a source). */
  kind: text("kind").notNull().default("event"),
  /** The kind's parameters (`delay`: `{afterStep, days | minutes, unlessStep?}`; `poll`: `{source, everyMinutes}`); null on an event. */
  params: jsonb("params"),
  createdBy: text("created_by"),
  requestedByOrgId: text("requested_by_org_id"),
  // RETIRED (CATALOGUE-RETIRE-1016): a DECLARED trigger created by mistake that no pipe, sales funnel or campaign uses,
  // out of every catalogue read; the row stays (who created it, who retired it, why). Declaring the id again revives it.
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  retiredBy: text("retired_by"),
  retireNote: text("retire_note"),
});

/**
 * CHANNELS DECLARED AT RUN TIME (`lib/channel-declarations.ts`, owner 2026-10-09: a declaration is DATA,
 * never a PR). Same statement a seeded feature's acquisition-channel blob makes; merged into the catalogue
 * builder beside the feature rows. Created `published` (live, owner 2026-10-12); hidden from client reads only if staff unpublishes it. The slug shares the
 * feature-slug namespace (a declared slug never equals a feature's).
 */
export const declaredChannels = pgTable("declared_channels", {
  slug: text("slug").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  shortDescription: text("short_description").notNull(),
  icon: text("icon").notNull(),
  channelType: text("channel_type").notNull(),
  operatedBy: text("operated_by").notNull(),
  performedBy: text("performed_by").notNull(),
  dailyOperatingCostCents: integer("daily_operating_cost_cents").notNull(),
  minimumCommitmentDays: integer("minimum_commitment_days").notNull(),
  maxDaysToFirstProduction: integer("max_days_to_first_production").notNull(),
  displayOrder: integer("display_order").notNull(),
  published: boolean("published").notNull().default(false),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  publishedBy: text("published_by"),
  createdBy: text("created_by").notNull(),
  requestedByOrgId: text("requested_by_org_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A leg declared at run time on ANY channel (seeded or declared). Public only when `published` AND its channel is. */
export const declaredChannelLegs = pgTable(
  "declared_channel_legs",
  {
    channelSlug: text("channel_slug").notNull(),
    legKey: text("leg_key").notNull(),
    fromStep: text("from_step"),
    toStep: text("to_step").notNull(),
    mode: text("mode").notNull(),
    triggerId: text("trigger_id"),
    published: boolean("published").notNull().default(false),
    createdBy: text("created_by").notNull(),
    requestedByOrgId: text("requested_by_org_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // RETIRED (MCP-PIPE-GAPS-1015): a pipe created by mistake that no campaign uses, out of every catalogue read.
    // The row stays (who created it, who retired it, why); declaring the same leg again revives it.
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredBy: text("retired_by"),
    retireNote: text("retire_note"),
  },
  (t) => [primaryKey({ columns: [t.channelSlug, t.legKey] })],
);

/** A sales path declared at run time: an ordered chain of existing (channel x leg) pairs, start to paid client. */
export const declaredSalesPaths = pgTable("declared_sales_paths", {
  /** `combinationKeyOf` (`lib/offer-sales-paths.ts`), the same identity (and name) the offer listing serves. */
  combinationKey: text("combination_key").primaryKey(),
  legs: jsonb("legs").notNull(),
  createdBy: text("created_by").notNull(),
  requestedByOrgId: text("requested_by_org_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // RETIRED (CATALOGUE-RETIRE-1016): a sales funnel declared by mistake that no campaign of any org runs or ran, out of
  // every catalogue read; the row stays. Declaring the same funnel again revives it.
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  retiredBy: text("retired_by"),
  retireNote: text("retire_note"),
});

/**
 * STEPS DECLARED AT RUN TIME (owner 2026-10-10, "chat first"): a stage the agent names on the fly ("LinkedIn
 * post", "Email found"), usable like a coded step by declared legs (`lib/catalogue-declarations.ts`). Every
 * step has a VALUE on the way to a paid client, so a declared one states where it leads: `towardStep` (an
 * existing step) reached at `towardRatePct`; its value = that share of the toward step's value.
 */
export const declaredSteps = pgTable("declared_steps", {
  key: text("key").primaryKey(),
  label: text("label").notNull().unique(),
  description: text("description").notNull(),
  shortDescription: text("short_description").notNull(),
  icon: text("icon").notNull(),
  /** Null = a step reached only after Paid client (CLIENT-SATISFIED-1027): it leads nowhere, so it has no value. */
  towardStep: text("toward_step"),
  towardRatePct: doublePrecision("toward_rate_pct"),
  /** What produces it, free text (an endpoint, a service): provenance for "ROI per API output". */
  producedBy: text("produced_by"),
  /** Its rung on the ONE lifecycle ladder (`lib/lifecycle-ladder.ts`) or `none`; null = never stated. */
  lifecycleRung: text("lifecycle_rung"),
  /** What one occurrence is about, `person` | `object` (`lib/outcome-subject.ts`); null = never stated. */
  subjectKind: text("subject_kind"),
  createdBy: text("created_by").notNull(),
  requestedByOrgId: text("requested_by_org_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The stated conversion rate of a leg nothing else rates (no industry default, no fleet median): declared with its first pipe or step. */
export const declaredLegRates = pgTable(
  "declared_leg_rates",
  {
    fromStep: text("from_step").notNull(),
    toStep: text("to_step").notNull(),
    ratePct: doublePrecision("rate_pct").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "declared_leg_rates_pk", columns: [t.fromStep, t.toStep] })],
);

/** SALES PATHS (chains of legs, no channel) created explicitly through `/internal/catalogue/sales-paths`. */
export const declaredSalesPathChains = pgTable("declared_sales_path_chains", {
  /** The chain's served leg keys joined by `+` (`lib/agent-catalogue.ts` `pathIdOf`). */
  pathId: text("path_id").primaryKey(),
  legKeys: jsonb("leg_keys").notNull(),
  createdBy: text("created_by").notNull(),
  requestedByOrgId: text("requested_by_org_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * TACTICS, STRATEGIES, PLAYS (owner 2026-10-13, migration 0028; `lib/plays.ts`). A TACTIC is a yes/no tag on a
 * workflow VERSION; Jev judges every version against every tactic once, on the tactic's description
 * (`lib/tactic-judgments.ts`). A STRATEGY requires and excludes tactics. A PLAY is a pipe x a strategy, catalogued per
 * pipe (never per campaign); `is_default` = the play a campaign runs when its sales funnel names no strategy. Name and
 * description are unique case-insensitive in both families (indexes in the migration). Not the dashboard's
 * "Strategy page" (audience/workflow ranking): a different word for a different thing.
 */
export const tactics = pgTable("tactics", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Who last edited the description, and when (migration 0030); null = never edited. */
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
  /**
   * The plain line a CLIENT reads about this tactic (migration 0041, WRITTEN-BY-1019): `description` is what Jev judges
   * (service paths, field names), never client copy. Null = the tactic is not shown to clients.
   */
  clientLine: text("client_line"),
  /**
   * What the tactic tags (migration 0044, BEST-TPL-LLM-1022): `workflow` (a workflow VERSION, judged on its DAG),
   * `template` (a template DYNASTY, judged on its head's text) or `llm` (a writer model alias, judged on the model).
   */
  appliesTo: text("applies_to").notNull().default("workflow"),
});

export const strategies = pgTable("strategies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  requiresTacticIds: text("requires_tactic_ids").array().notNull().default([]),
  excludesTacticIds: text("excludes_tactic_ids").array().notNull().default([]),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Who last edited requires / excludes / description, and when (migration 0032); null = never edited. */
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

export const plays = pgTable(
  "plays",
  {
    /** The pipe's served id (`<channel slug>|<served leg key>`). */
    pipeId: text("pipe_id").notNull(),
    strategyId: text("strategy_id").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** PLAY-RETIRE-1022: set = taken off the pipe by staff; a funnel naming it runs the pipe's default play. */
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredBy: text("retired_by"),
    retiredNote: text("retired_note"),
  },
  (t) => [primaryKey({ columns: [t.pipeId, t.strategyId] })],
);

/**
 * The LAST full Jev sweep, per tactic (migration 0031): how many workflow versions it covered, how many stand judged on
 * the description it read, how many Jev could not judge and why. Served as the tactic's `judging` state, so an agent
 * tells "Jev is still working" from "Jev keeps failing" (owner 2026-10-14: a failing judge looked pending forever).
 * One row per tactic, overwritten by every full sweep (a register kick narrowed to a few dynasties writes none).
 */
export const tacticJudgingSweeps = pgTable("tactic_judging_sweeps", {
  tacticId: text("tactic_id").primaryKey(),
  /** The description that sweep judged on (a later edit means the row describes older words). */
  judgedDescription: text("judged_description").notNull(),
  sweptAt: timestamp("swept_at", { withTimezone: true }).notNull(),
  versions: integer("versions").notNull(),
  judged: integer("judged").notNull(),
  failed: integer("failed").notNull(),
  lastFailure: text("last_failure"),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
});

/**
 * One Jev verdict per (workflow VERSION, tactic), judged once per tactic DESCRIPTION (`judged_description`, migration
 * 0030): an edited description re-judges the row in place; `version_active` is refreshed on every sweep.
 */
export const workflowTacticVerdicts = pgTable(
  "workflow_tactic_verdicts",
  {
    workflowSlug: text("workflow_slug").notNull(),
    tacticId: text("tactic_id").notNull(),
    workflowDynastySlug: text("workflow_dynasty_slug").notNull(),
    featureSlug: text("feature_slug").notNull(),
    version: integer("version").notNull(),
    versionActive: boolean("version_active").notNull(),
    verdict: boolean("verdict").notNull(),
    probability: doublePrecision("probability").notNull(),
    model: text("model").notNull(),
    judgedDescription: text("judged_description").notNull(),
    /** How Jev read the workflow (migration 0033): `whole-in-parts` reads every step; `truncated-60k` (before 2026-10-14) cut a big DAG at 60,000 characters. */
    judgeRule: text("judge_rule").notNull().default("truncated-60k"),
    judgedAt: timestamp("judged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workflowSlug, t.tacticId] })],
);

/**
 * One Jev verdict per (template dynasty | LLM alias, tactic) (migration 0044, BEST-TPL-LLM-1022): the writer twin of
 * `workflow_tactic_verdicts`. Judged once per tactic DESCRIPTION and subject VERSION (a template dynasty's head, an
 * alias's concrete model): either moving re-judges the row in place.
 */
export const writerTacticVerdicts = pgTable(
  "writer_tactic_verdicts",
  {
    subjectKind: text("subject_kind").notNull(),
    subjectKey: text("subject_key").notNull(),
    tacticId: text("tactic_id").notNull(),
    subjectVersion: text("subject_version").notNull(),
    verdict: boolean("verdict").notNull(),
    probability: doublePrecision("probability").notNull(),
    model: text("model").notNull(),
    judgedDescription: text("judged_description").notNull(),
    judgedAt: timestamp("judged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.subjectKind, t.subjectKey, t.tacticId] })],
);

/**
 * PUBLIC FLEET INDEX POINTS (`fleet_index_points`, owner 2026-10-18; `lib/fleet-indexes.ts`): one row per (index,
 * UTC day) = that index's value as recorded that day. TODAY's row is rewritten by every recorder tick (the day is
 * still open); a past day is never touched again, so the series is what we published, day after day.
 * `basis` = `recorded` (written live that day) or `recomputed` (a day before the recorder, rebuilt as of that day by
 * `scripts/backfill-fleet-indexes.ts`, never written over a recorded day).
 */
export const fleetIndexPoints = pgTable(
  "fleet_index_points",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    indexSlug: text("index_slug").notNull(),
    /** UTC calendar day (`YYYY-MM-DD`). */
    day: text("day").notNull(),
    /** null = could not be stated that day (`unavailable_reason`), never a 0 for unknown. */
    value: doublePrecision("value"),
    status: text("status").notNull(),
    outcomes: integer("outcomes").notNull(),
    contacted: integer("contacted"),
    workflowDynastySlug: text("workflow_dynasty_slug"),
    workflowDynastyName: text("workflow_dynasty_name"),
    unavailableReason: text("unavailable_reason"),
    inputs: jsonb("inputs").notNull(),
    basis: text("basis").notNull().default("recorded"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("idx_fleet_index_points_slug_day").on(table.indexSlug, table.day)],
);

export type FleetIndexPointRow = typeof fleetIndexPoints.$inferSelect;

/**
 * OUR COPY OF INSTANTLY-SERVICE'S OUTREACH FACTS (`outreach_fact_copy`, LIVE-RESEARCH-1018; `lib/outreach-facts-copy.ts`):
 * one row per SUBJECT (`subjectKey`: a send, a click, a reply...), holding its LATEST statement (a correction replaces it,
 * a withdrawal marks it). Followed incrementally from the feed's cursor; read by the Research studies only.
 */
export const outreachFactCopy = pgTable(
  "outreach_fact_copy",
  {
    subjectKey: text("subject_key").primaryKey(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    orgId: text("org_id"),
    campaignId: text("campaign_id"),
    instantlyCampaignId: text("instantly_campaign_id").notNull(),
    leadEmail: text("lead_email").notNull(),
    transport: text("transport"),
    step: integer("step"),
    localSentAt: text("local_sent_at"),
    localWeekday: text("local_weekday"),
    timezone: text("timezone"),
    openTracking: text("open_tracking"),
    replyKind: text("reply_kind"),
    replyClassification: text("reply_classification"),
    replyAutomated: boolean("reply_automated"),
    withdrawn: boolean("withdrawn").notNull().default(false),
    copiedAt: timestamp("copied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_outreach_fact_copy_campaign_type").on(t.campaignId, t.type), index("idx_outreach_fact_copy_thread").on(t.instantlyCampaignId, t.leadEmail)],
);

/**
 * OUR COPY OF CONTENT-GENERATION-SERVICE'S SEQUENCE FEED (`generation_sequence_copy`, LIVE-RESEARCH-1018;
 * `lib/generation-sequences-copy.ts`): one row per generated sequence (campaign x lead): the concrete model and the
 * template that wrote it, and three classes of its first email's text. Followed incrementally; read by the fleet person
 * cell to file each person under what wrote their emails.
 */
export const generationSequenceCopy = pgTable(
  "generation_sequence_copy",
  {
    generationId: text("generation_id").primaryKey(),
    orgId: text("org_id").notNull(),
    campaignId: text("campaign_id").notNull(),
    leadId: text("lead_id").notNull(),
    model: text("model").notNull(),
    promptType: text("prompt_type"),
    workflowSlug: text("workflow_slug"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    layout: text("layout"),
    opening: text("opening"),
    dash: text("dash"),
    copiedAt: timestamp("copied_at", { withTimezone: true }).notNull().defaultNow(),
    // MODEL-RUN-COST-1024 (migration 0047): the completion run(s) content-generation states wrote it (null + reason when it
    // cannot tell), its recorded tokens, and that run's own LLM cost read from runs-service (billed gross, committed).
    completionRunIds: text("completion_run_ids").array(),
    completionUnknownReason: text("completion_unknown_reason"),
    tokensInput: integer("tokens_input"),
    tokensOutput: integer("tokens_output"),
    llmInputCostCents: numeric("llm_input_cost_cents"),
    llmOutputCostCents: numeric("llm_output_cost_cents"),
    /** `read` | `held` (a provisioned hold still open: re-read) | `run_not_found`. Null = not read yet. */
    llmCostStatus: text("llm_cost_status"),
    llmCostReadAt: timestamp("llm_cost_read_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_generation_sequence_copy_campaign_lead").on(t.campaignId, t.leadId),
    // One person's messages, org-scoped (the client's "who wrote this" read, migration 0041).
    index("idx_generation_sequence_copy_org_lead").on(t.orgId, t.leadId),
  ],
);

/**
 * RESEARCH-NICHE-1021: how specific each client's B2B niche is, per (org, brand, offer) (`offerId` '' = a campaign stating
 * no offer). Judged once by Jev on what the client sells and who its audiences target (`judgedState`), re-judged only
 * when that text changes (`stateHash`). Read by the Research niche study (`lib/research/niche-grades.ts`).
 */
export const nicheGrades = pgTable(
  "niche_grades",
  {
    orgId: text("org_id").notNull(),
    brandId: text("brand_id").notNull(),
    offerId: text("offer_id").notNull().default(""),
    grade: text("grade").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    probabilities: jsonb("probabilities").notNull(),
    model: text("model").notNull(),
    judgedState: jsonb("judged_state").notNull(),
    stateHash: text("state_hash").notNull(),
    judgedAt: timestamp("judged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "niche_grades_pk", columns: [t.orgId, t.brandId, t.offerId] })],
);

/**
 * SECURITY ADVISORIES (`security_advisory_reports`, SEC-ADVISORIES-SERIES-1025; `lib/security-advisories.ts`): one row per
 * (UTC day, prod repo) = that repo's open npm/pnpm audit findings as the owner's daily audit job reported them. Re-sending a
 * day REPLACES that day's rows (a repo absent from the new report is gone from that day). Counts are null only when the audit
 * could not run (`error` says why), never a 0 for unknown.
 */
export const securityAdvisoryReports = pgTable(
  "security_advisory_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** UTC calendar day (`YYYY-MM-DD`). */
    day: text("day").notNull(),
    repo: text("repo").notNull(),
    critical: integer("critical"),
    high: integer("high"),
    moderate: integer("moderate"),
    low: integer("low"),
    /** Package names carrying a high or critical finding. */
    packages: text("packages").array().notNull().default([]),
    error: text("error"),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("idx_security_advisory_reports_day_repo").on(table.day, table.repo)],
);

export type SecurityAdvisoryReportRow = typeof securityAdvisoryReports.$inferSelect;

/**
 * BOX HEALTH (`box_health_samples`, BOX-OVERLOAD-1026-SERIES; `lib/box-health.ts`): one row per sample of the production
 * Hetzner box (load, memory, swap, OOM kills, per-container CPU/memory), keyed on the instant it was taken: re-sending the
 * same `sampled_at` REPLACES the row. `containers` is null for sysstat-backfilled history; `oom_kills` null = unknown. Rows
 * older than 90 days are pruned on ingest.
 */
export const boxHealthSamples = pgTable(
  "box_health_samples",
  {
    sampledAt: timestamp("sampled_at", { withTimezone: true }).primaryKey(),
    /** `agent` (live 5-minute cron) or `sysstat` (history backfill). */
    source: text("source").notNull(),
    load1: doublePrecision("load1").notNull(),
    load5: doublePrecision("load5").notNull(),
    load15: doublePrecision("load15").notNull(),
    cores: integer("cores").notNull(),
    memTotalMb: doublePrecision("mem_total_mb").notNull(),
    memAvailableMb: doublePrecision("mem_available_mb").notNull(),
    swapTotalMb: doublePrecision("swap_total_mb").notNull(),
    swapUsedMb: doublePrecision("swap_used_mb").notNull(),
    oomKills: integer("oom_kills"),
    /** `[{ name, cpuCores, memMb }]`, null when the sample carried no per-container list. */
    containers: jsonb("containers").$type<Array<{ name: string; cpuCores: number; memMb: number }>>(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export type BoxHealthSampleRow = typeof boxHealthSamples.$inferSelect;

/**
 * GTM FACTORY STEP 1 (FACTORY-P1-BRIEF-JUDGE-SHADOW-PLAN, `lib/factory-shadow.ts`). SHADOW ONLY: nothing reads these to
 * decide what a campaign runs.
 * - `factory_brief_judgments`: per funnel campaign x pipe, the play Jev picked from the campaign's brief (or the default play
 *   with no Jev call: empty brief, one play), with the brief (hash) and the plays (signature) it chose among: re-judged
 *   when either moves.
 * - `factory_shadow_plans`: per funnel campaign, its last shadow plan (running funnel vs best-ROI line to its Target).
 * - `factory_shadow_daily`: per UTC day x client org, the campaigns whose plan or pick differs from what runs, and the
 *   ones whose judge or plan failed (dashboard v2 Monitoring). A pass rewrites TODAY's rows only.
 */
export const factoryBriefJudgments = pgTable(
  "factory_brief_judgments",
  {
    campaignId: text("campaign_id").notNull(),
    basePipeId: text("base_pipe_id").notNull(),
    orgId: text("org_id").notNull(),
    briefHash: text("brief_hash"),
    briefUpdatedAt: timestamp("brief_updated_at", { withTimezone: true }),
    playsSignature: text("plays_signature").notNull(),
    chosenPipeId: text("chosen_pipe_id").notNull(),
    defaultPipeId: text("default_pipe_id").notNull(),
    confidence: doublePrecision("confidence"),
    probabilities: jsonb("probabilities").$type<Record<string, number>>(),
    model: text("model"),
    /** `jev` | `empty_brief` | `single_play`. */
    source: text("source").notNull(),
    judgedAt: timestamp("judged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.campaignId, table.basePipeId] })],
);

export const factoryShadowPlans = pgTable("factory_shadow_plans", {
  campaignId: text("campaign_id").primaryKey(),
  orgId: text("org_id").notNull(),
  brandId: text("brand_id").notNull(),
  offerId: text("offer_id").notNull(),
  /** `ok` | `judge_failed` | `plan_failed`. */
  status: text("status").notNull(),
  failure: text("failure"),
  body: jsonb("body").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const factoryShadowDaily = pgTable(
  "factory_shadow_daily",
  {
    day: text("day").notNull(),
    orgId: text("org_id").notNull(),
    campaigns: integer("campaigns").notNull(),
    planDiffers: integer("plan_differs").notNull(),
    pickDiffers: integer("pick_differs").notNull(),
    differs: integer("differs").notNull(),
    judgeFailed: integer("judge_failed").notNull(),
    planFailed: integer("plan_failed").notNull(),
    /** FACTORY-P2 (owner 2026-10-29): campaigns waiting on a first price or a catalogue line, never counted as failed. */
    notYet: integer("not_yet").notNull().default(0),
    sweptAt: timestamp("swept_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.day, table.orgId] })],
);

/**
 * FACTORY-P1-BRIEF-PREFILL (owner 2026-10-28): every brief this service PREFILLED on a funnel campaign (what it runs today,
 * written through campaign-service's own PATCH as `system-features-service`). One row per campaign, written once: a brief
 * someone later clears or edits is never prefilled again.
 */
export const factoryBriefPrefills = pgTable("factory_brief_prefills", {
  campaignId: text("campaign_id").primaryKey(),
  orgId: text("org_id").notNull(),
  brief: text("brief").notNull(),
  writtenAt: timestamp("written_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * FACTORY-P1 pipe judge (2026-10-29, GTM Factory v10: a channel is a tactic): per funnel campaign x pipe WE run on a leg its
 * plan may walk, whether its brief rules the pipe out (Jev `noul`, p >= 0.5), with the brief (hash) and the pipe's words
 * (signature) judged: re-judged when either moves. Shadow only.
 */
export const factoryPipeVerdicts = pgTable(
  "factory_pipe_verdicts",
  {
    campaignId: text("campaign_id").notNull(),
    pipeId: text("pipe_id").notNull(),
    orgId: text("org_id").notNull(),
    briefHash: text("brief_hash").notNull(),
    pipeSignature: text("pipe_signature").notNull(),
    excluded: boolean("excluded").notNull(),
    probability: doublePrecision("probability").notNull(),
    model: text("model").notNull(),
    judgedAt: timestamp("judged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.campaignId, table.pipeId] })],
);
