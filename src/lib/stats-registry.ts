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
  source: "email-gateway" | "runs" | "campaign" | "outlets" | "journalists";
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
  emailsReplied:       { kind: "raw", type: "count",    label: "Replies",          source: "email-gateway" },
  emailsBounced:       { kind: "raw", type: "count",    label: "Bounces",          source: "email-gateway" },
  recipients:          { kind: "raw", type: "count",    label: "Recipients",       source: "email-gateway" },

  // ── Reply breakdown: email-gateway ────────────────────────────────────────
  repliesWillingToMeet: { kind: "raw", type: "count",   label: "Willing to Meet",  source: "email-gateway" },
  repliesInterested:    { kind: "raw", type: "count",   label: "Interested",       source: "email-gateway" },
  repliesNotInterested: { kind: "raw", type: "count",   label: "Not Interested",   source: "email-gateway" },
  repliesOutOfOffice:   { kind: "raw", type: "count",   label: "Out of Office",    source: "email-gateway" },
  repliesUnsubscribe:   { kind: "raw", type: "count",   label: "Unsubscribe",      source: "email-gateway" },
  repliesMoreInfo:      { kind: "raw", type: "count",   label: "Wants More Info",  source: "email-gateway" },
  repliesWrongContact:  { kind: "raw", type: "count",   label: "Wrong Contact",    source: "email-gateway" },

  // ── Pipeline counts: runs-service (counted via per-task runCount) ─────────
  leadsServed:         { kind: "raw", type: "count",    label: "Leads Served",     source: "runs", runFilter: { serviceName: "lead-service", taskName: "lead-serve" } },
  emailsGenerated:     { kind: "raw", type: "count",    label: "Emails Generated", source: "runs", runFilter: { serviceName: "content-generation-service", taskName: "single-generation" } },

  // ── Journalists: journalists-service ────────────────────────────────────────
  journalistsFound:     { kind: "raw", type: "count",   label: "Journalists Found",     source: "journalists" },
  journalistsContacted: { kind: "raw", type: "count",   label: "Journalists Contacted", source: "journalists" },

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
  replyRate:           { kind: "derived", type: "rate",     label: "% Replies",     numerator: "emailsReplied",  denominator: "emailsSent" },
  positiveReplyRate:   { kind: "derived", type: "rate",     label: "% Positive",    numerator: "repliesWillingToMeet", denominator: "emailsSent" },
  coverageRate:        { kind: "derived", type: "rate",     label: "Coverage Rate", numerator: "repliesInterested",    denominator: "emailsSent" },

  // ── Derived cost-per ──────────────────────────────────────────────────────
  costPerOpenCents:    { kind: "derived", type: "currency", label: "$/Open",        numerator: "totalCostInUsdCents",  denominator: "emailsOpened" },
  costPerClickCents:   { kind: "derived", type: "currency", label: "$/Click",       numerator: "totalCostInUsdCents",  denominator: "emailsClicked" },
  costPerReplyCents:   { kind: "derived", type: "currency", label: "$/Reply",       numerator: "totalCostInUsdCents",  denominator: "emailsReplied" },
  costPerOutletCents:  { kind: "derived", type: "currency", label: "$/Outlet",      numerator: "totalCostInUsdCents",  denominator: "outletsDiscovered" },
};

/** All valid stats key names */
export const VALID_STATS_KEYS = new Set(Object.keys(STATS_REGISTRY));

/** Known entity types for feature.entities */
export const VALID_ENTITY_TYPES = new Set([
  "leads",
  "companies",
  "emails",
  "outlets",
  "journalists",
  "press-kits",
]);

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
