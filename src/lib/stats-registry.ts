/**
 * Stats Registry — the finite universe of output keys that features can reference.
 *
 * Features-service owns this registry. When a feature is created/updated,
 * all output keys and chart step/segment keys are validated against it.
 * Features-service also owns the computation logic for each key.
 */

export interface RunFilter {
  serviceName: string;
  taskName: string;
}

export interface RawStatsKeyDef {
  kind: "raw";
  type: "count" | "currency";
  label: string;
  source: "email-gateway" | "runs" | "campaign" | "outlets" | "journalists" | "leads" | "press-kits";
  /** For pipeline count keys: count runs matching this service+task filter */
  runFilter?: RunFilter;
}

export interface DerivedStatsKeyDef {
  kind: "derived";
  type: "rate" | "currency";
  label: string;
  numerator: string;
  denominator: string;
}

export type StatsKeyDef = RawStatsKeyDef | DerivedStatsKeyDef;

export const STATS_REGISTRY: Record<string, StatsKeyDef> = {
  // ── Raw counts: email-gateway ─────────────────────────────────────────────
  emailsContacted:     { kind: "raw", type: "count",    label: "Contacted",        source: "email-gateway" },
  emailsSent:          { kind: "raw", type: "count",    label: "Sent",             source: "email-gateway" },
  emailsDelivered:     { kind: "raw", type: "count",    label: "Delivered",        source: "email-gateway" },
  emailsOpened:        { kind: "raw", type: "count",    label: "Opens",            source: "email-gateway" },
  emailsClicked:       { kind: "raw", type: "count",    label: "Clicks",           source: "email-gateway" },
  emailsBounced:       { kind: "raw", type: "count",    label: "Bounces",          source: "email-gateway" },
  recipients:          { kind: "raw", type: "count",    label: "Recipients",       source: "email-gateway" },

  // ── Reply aggregates: email-gateway ───────────────────────────────────────
  repliesPositive:      { kind: "raw", type: "count",   label: "Positive",         source: "email-gateway" },
  repliesNegative:      { kind: "raw", type: "count",   label: "Negative",         source: "email-gateway" },
  repliesNeutral:       { kind: "raw", type: "count",   label: "Neutral",          source: "email-gateway" },
  repliesAutoReply:     { kind: "raw", type: "count",   label: "Auto-Reply",       source: "email-gateway" },

  // ── Pipeline counts: runs-service (counted via per-task runCount) ─────────
  leadsServed:         { kind: "raw", type: "count",    label: "Leads Served",     source: "leads" },
  emailsGenerated:     { kind: "raw", type: "count",    label: "Emails Generated", source: "runs", runFilter: { serviceName: "content-generation-service", taskName: "single-generation" } },

  // ── Journalists: journalists-service ────────────────────────────────────────
  journalistsFound:     { kind: "raw", type: "count",   label: "Journalists Found",     source: "journalists" },
  journalistsContacted: { kind: "raw", type: "count",   label: "Journalists Contacted", source: "journalists" },

  // ── Press kits: press-kits-service ──────────────────────────────────────────
  pressKitsGenerated:      { kind: "raw", type: "count", label: "Kits Generated",     source: "press-kits" },
  pressKitViews:           { kind: "raw", type: "count", label: "Page Views",         source: "press-kits" },
  pressKitUniqueVisitors:  { kind: "raw", type: "count", label: "Unique Visitors",    source: "press-kits" },

  // ── Cost & runs: runs-service ─────────────────────────────────────────────
  totalCostInUsdCents: { kind: "raw", type: "currency", label: "Total Cost",       source: "runs" },
  completedRuns:       { kind: "raw", type: "count",    label: "Runs",             source: "runs" },

  // ── Outlets: outlets-service ──────────────────────────────────────────────
  outletsDiscovered:   { kind: "raw", type: "count",    label: "Outlets",          source: "outlets" },
  avgRelevanceScore:   { kind: "raw", type: "count",    label: "Avg Relevance",    source: "outlets" },
  searchQueriesUsed:   { kind: "raw", type: "count",    label: "Searches",         source: "outlets" },

  // ── Campaigns: campaign-service ───────────────────────────────────────────
  activeCampaigns:     { kind: "raw", type: "count",    label: "Active Campaigns", source: "campaign" },

  // ── Derived rates ─────────────────────────────────────────────────────────
  openRate:            { kind: "derived", type: "rate",     label: "% Opens",       numerator: "emailsOpened",   denominator: "emailsSent" },
  clickRate:           { kind: "derived", type: "rate",     label: "% Clicks",      numerator: "emailsClicked",  denominator: "emailsSent" },
  positiveReplyRate:   { kind: "derived", type: "rate",     label: "% Positive",    numerator: "repliesPositive",  denominator: "emailsDelivered" },
  negativeReplyRate:   { kind: "derived", type: "rate",     label: "% Negative",    numerator: "repliesNegative",  denominator: "emailsDelivered" },
  neutralReplyRate:    { kind: "derived", type: "rate",     label: "% Neutral",     numerator: "repliesNeutral",   denominator: "emailsDelivered" },

  // ── Derived cost-per ──────────────────────────────────────────────────────
  costPerOpenCents:       { kind: "derived", type: "currency", label: "$/Open",        numerator: "totalCostInUsdCents",  denominator: "emailsOpened" },
  costPerClickCents:      { kind: "derived", type: "currency", label: "$/Click",       numerator: "totalCostInUsdCents",  denominator: "emailsClicked" },
  costPerPositiveReplyCents: { kind: "derived", type: "currency", label: "$/Positive Reply", numerator: "totalCostInUsdCents", denominator: "repliesPositive" },
  costPerOutletCents:     { kind: "derived", type: "currency", label: "$/Outlet",      numerator: "totalCostInUsdCents",  denominator: "outletsDiscovered" },
  costPerPressKitCents:   { kind: "derived", type: "currency", label: "$/Kit",         numerator: "totalCostInUsdCents",  denominator: "pressKitsGenerated" },
  costPerPressKitViewCents: { kind: "derived", type: "currency", label: "$/View",      numerator: "totalCostInUsdCents",  denominator: "pressKitViews" },
};

/** All valid stats key names */
export const VALID_STATS_KEYS = new Set(Object.keys(STATS_REGISTRY));

/** Entity type definition — metadata for each entity shown in campaign sidebar */
export interface EntityTypeDef {
  /** Human-readable label for the sidebar button */
  label: string;
  /** Lucide icon name (lucide.dev/icons) */
  icon: string;
  /** URL path suffix appended to /campaigns/{id}/ */
  pathSuffix: string;
  /** Brief description of what this entity represents */
  description: string;
}

/**
 * Entity Registry — the finite set of entity types that features can reference.
 *
 * Each entry defines how a campaign sidebar tab is rendered:
 * - `label`:       Button text in the sidebar
 * - `icon`:        Lucide icon name (e.g. "users", "building-2")
 * - `pathSuffix`:  URL segment for the campaign detail page
 * - `description`: What this entity type represents
 *
 * When a feature declares `entities: [{ name: "outlets" }]`, the dashboard
 * looks up "outlets" in this registry to render the sidebar button and route.
 *
 * To add a new entity type:
 * 1. Add an entry here
 * 2. Implement the corresponding campaign detail page in the dashboard
 * 3. The sidebar will pick it up automatically via GET /entities/registry
 */
export const ENTITY_REGISTRY: Record<string, EntityTypeDef> = {
  leads:        { label: "Leads",       icon: "users",        pathSuffix: "leads",       description: "Sales leads discovered or imported for outreach" },
  companies:    { label: "Companies",   icon: "building-2",   pathSuffix: "companies",   description: "Target companies identified for the campaign" },
  emails:       { label: "Emails",      icon: "mail",         pathSuffix: "emails",      description: "Email messages generated and sent by the campaign" },
  outlets:      { label: "Outlets",     icon: "newspaper",    pathSuffix: "outlets",      description: "Media outlets discovered for PR outreach" },
  journalists:  { label: "Journalists", icon: "pen-tool",     pathSuffix: "journalists", description: "Journalists found at discovered outlets" },
  "press-kits": { label: "Press Kits",  icon: "file-text",    pathSuffix: "press-kits",  description: "Press kits generated for media pitching" },
  articles:     { label: "Articles",    icon: "scroll-text",  pathSuffix: "articles",    description: "Published articles resulting from PR campaigns" },
};

/** Known entity types for feature.entities */
export const VALID_ENTITY_TYPES = new Set(Object.keys(ENTITY_REGISTRY));

/** System stats — always present in stats responses, not declared by features */
export const SYSTEM_STATS_KEYS = [
  "totalCostInUsdCents",
  "completedRuns",
  "activeCampaigns",
  "firstRunAt",
  "lastRunAt",
] as const;

/**
 * Get the public registry (label + type for each key).
 * Exposed via GET /stats/registry for the front-end.
 */
export function getPublicRegistry(): Record<string, { type: string; label: string }> {
  const result: Record<string, { type: string; label: string }> = {};
  for (const [key, def] of Object.entries(STATS_REGISTRY)) {
    result[key] = { type: def.type, label: def.label };
  }
  return result;
}

/**
 * Get the entity registry (label, icon, pathSuffix, description for each entity type).
 * Exposed via GET /entities/registry for the front-end.
 */
export function getEntityRegistry(): Record<string, EntityTypeDef> {
  return { ...ENTITY_REGISTRY };
}

/**
 * Validate that all keys are known stats keys.
 * Returns an array of invalid keys (empty = all valid).
 */
export function validateStatsKeys(keys: string[]): string[] {
  return keys.filter((k) => !VALID_STATS_KEYS.has(k));
}

/**
 * Validate that all entity types are known.
 * Returns an array of invalid types (empty = all valid).
 */
export function validateEntityTypes(types: string[]): string[] {
  return types.filter((t) => !VALID_ENTITY_TYPES.has(t));
}
