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
  /** "score" = 0-1 normalized scalar (rendered as %). "count" = integer. "currency" = USD cents. */
  type: "count" | "currency" | "score";
  label: string;
  source:
    | "email-gateway"
    | "runs"
    | "campaign"
    | "outlets"
    | "journalists"
    | "journalists-quotes"
    | "leads"
    | "press-kits"
    | "ai-visibility";
  /** For pipeline count keys: count runs matching this service+task filter */
  runFilter?: RunFilter;
  /** Sort direction hint for ranking. "asc" = lower is better (e.g. avgPosition, $/published). "desc" = higher is better. */
  sortDirection?: "asc" | "desc";
}

export interface DerivedStatsKeyDef {
  kind: "derived";
  type: "rate" | "currency";
  label: string;
  numerator: string;
  denominator: string;
  /** Sort direction hint for ranking. */
  sortDirection?: "asc" | "desc";
}

export type StatsKeyDef = RawStatsKeyDef | DerivedStatsKeyDef;

/** The upstream stat SOURCE a raw key is served from. */
export type RawStatsSource = RawStatsKeyDef["source"];

export const STATS_REGISTRY: Record<string, StatsKeyDef> = {
  // ── Raw counts: email-gateway (recipient-level) ──────────────────────────
  recipientsContacted:      { kind: "raw", type: "count",    label: "Contacted",        source: "email-gateway" },
  recipientsSent:           { kind: "raw", type: "count",    label: "Sent",             source: "email-gateway" },
  recipientsDelivered:      { kind: "raw", type: "count",    label: "Delivered",        source: "email-gateway" },
  recipientsOpened:         { kind: "raw", type: "count",    label: "Opens",            source: "email-gateway" },
  recipientsClicked:        { kind: "raw", type: "count",    label: "Link Clicks",      source: "email-gateway" },
  recipientsBounced:        { kind: "raw", type: "count",    label: "Bounces",          source: "email-gateway" },

  // ── Reply aggregates: email-gateway (recipient-level) ───────────────────
  recipientsRepliesPositive:  { kind: "raw", type: "count",   label: "Positive replies", source: "email-gateway" },
  recipientsRepliesNegative:  { kind: "raw", type: "count",   label: "Negative",         source: "email-gateway" },
  recipientsRepliesNeutral:   { kind: "raw", type: "count",   label: "Neutral",          source: "email-gateway" },
  recipientsRepliesAutoReply: { kind: "raw", type: "count",   label: "Auto-Reply",       source: "email-gateway" },

  // ── Pipeline counts: runs-service (counted via per-task runCount) ─────────
  leadsServed:         { kind: "raw", type: "count",    label: "Leads Served",     source: "leads" },
  emailsGenerated:     { kind: "raw", type: "count",    label: "Emails Generated", source: "runs", runFilter: { serviceName: "content-generation-service", taskName: "single-generation" } },

  // ── Lead-scoped outreach funnel: lead-service /orgs/stats byOutreachStatus ──
  leadsContacted:           { kind: "raw", type: "count", label: "Leads Contacted",      source: "leads" },
  leadsSent:                { kind: "raw", type: "count", label: "Leads Sent",           source: "leads" },
  leadsDelivered:           { kind: "raw", type: "count", label: "Leads Delivered",      source: "leads" },
  leadsOpened:              { kind: "raw", type: "count", label: "Leads Opened",         source: "leads" },
  leadsClicked:             { kind: "raw", type: "count", label: "Leads Clicked",        source: "leads" },
  leadsBounced:             { kind: "raw", type: "count", label: "Leads Bounced",        source: "leads" },
  leadsUnsubscribed:        { kind: "raw", type: "count", label: "Leads Unsubscribed",   source: "leads" },
  leadsRepliesPositive:     { kind: "raw", type: "count", label: "Leads Positive",       source: "leads" },
  leadsRepliesNegative:     { kind: "raw", type: "count", label: "Leads Negative",       source: "leads" },
  leadsRepliesNeutral:      { kind: "raw", type: "count", label: "Leads Neutral",        source: "leads" },
  leadsRepliesAutoReply:    { kind: "raw", type: "count", label: "Leads Auto-Reply",     source: "leads" },

  // ── Lead reply detail: lead-service /orgs/stats repliesDetail ─────────────
  leadsRepliesInterested:        { kind: "raw", type: "count", label: "Interested",       source: "leads" },
  leadsRepliesMeetingBooked:     { kind: "raw", type: "count", label: "Meeting Booked",   source: "leads" },
  leadsRepliesClosed:            { kind: "raw", type: "count", label: "Closed",           source: "leads" },
  leadsRepliesNotInterested:     { kind: "raw", type: "count", label: "Not Interested",   source: "leads" },
  leadsRepliesWrongPerson:       { kind: "raw", type: "count", label: "Wrong Person",     source: "leads" },
  leadsRepliesUnsubscribeDetail: { kind: "raw", type: "count", label: "Unsubscribe",      source: "leads" },
  leadsRepliesNeutralDetail:     { kind: "raw", type: "count", label: "Neutral Reply",    source: "leads" },
  leadsRepliesAutoReplyDetail:   { kind: "raw", type: "count", label: "Auto-Reply Detail",source: "leads" },
  leadsRepliesOutOfOffice:       { kind: "raw", type: "count", label: "Out of Office",    source: "leads" },

  // ── Lead pipeline state: lead-service /orgs/stats top-level ───────────────
  leadsBuffered:       { kind: "raw", type: "count", label: "Leads Buffered", source: "leads" },
  leadsSkipped:        { kind: "raw", type: "count", label: "Leads Skipped",  source: "leads" },
  leadsClaimed:        { kind: "raw", type: "count", label: "Leads Claimed",  source: "leads" },

  // ── Company-scoped outreach funnel (distinct organizations): lead-service byOutreachStatusCompanies ──
  companiesServed:           { kind: "raw", type: "count", label: "Companies",           source: "leads" },
  companiesContacted:        { kind: "raw", type: "count", label: "Companies Contacted", source: "leads" },
  companiesSent:             { kind: "raw", type: "count", label: "Companies Sent",      source: "leads" },
  companiesDelivered:        { kind: "raw", type: "count", label: "Companies Delivered", source: "leads" },
  companiesOpened:           { kind: "raw", type: "count", label: "Companies Opened",    source: "leads" },
  companiesClicked:          { kind: "raw", type: "count", label: "Companies Clicked",   source: "leads" },
  companiesBounced:          { kind: "raw", type: "count", label: "Companies Bounced",   source: "leads" },
  companiesRepliesPositive:  { kind: "raw", type: "count", label: "Companies Positive",  source: "leads" },
  companiesRepliesNegative:  { kind: "raw", type: "count", label: "Companies Negative",  source: "leads" },
  companiesRepliesNeutral:   { kind: "raw", type: "count", label: "Companies Neutral",   source: "leads" },

  // ── Journalists: journalists-service ────────────────────────────────────────
  journalistsFound:     { kind: "raw", type: "count",   label: "Journalists Found",     source: "journalists" },
  journalistsContacted: { kind: "raw", type: "count",   label: "Journalists Contacted", source: "journalists" },

  // ── Quote outreach: journalists-quotes-service (Featured.com) ──────────────
  quoteRequestsFound:     { kind: "raw", type: "count", label: "Quote Requests",   source: "journalists-quotes" },
  quotePitchesSubmitted:  { kind: "raw", type: "count", label: "Pitches Submitted", source: "journalists-quotes" },
  quotesSelected:         { kind: "raw", type: "count", label: "Selected",         source: "journalists-quotes" },
  quotesPublished:        { kind: "raw", type: "count", label: "Published",        source: "journalists-quotes" },
  quotesNotSelected:      { kind: "raw", type: "count", label: "Not Selected",     source: "journalists-quotes" },

  // ── AI visibility: ai-visibility-score-service ─────────────────────────────
  visibilityScore:    { kind: "raw", type: "score", label: "Visibility Score",  source: "ai-visibility", sortDirection: "desc" },
  brandMentionRate:   { kind: "raw", type: "score", label: "Mention Rate",      source: "ai-visibility", sortDirection: "desc" },
  shareOfVoice:       { kind: "raw", type: "score", label: "Share of Voice",    source: "ai-visibility", sortDirection: "desc" },
  citationRate:       { kind: "raw", type: "score", label: "Citation Rate",     source: "ai-visibility", sortDirection: "desc" },
  netSentiment:       { kind: "raw", type: "score", label: "Net Sentiment",     source: "ai-visibility", sortDirection: "desc" },
  avgPosition:        { kind: "raw", type: "count", label: "Avg Position",      source: "ai-visibility", sortDirection: "asc" },

  // ── Press kits: press-kits-service ──────────────────────────────────────────
  pressKitsGenerated:      { kind: "raw", type: "count", label: "Kits Generated",     source: "press-kits" },
  pressKitViews:           { kind: "raw", type: "count", label: "Page Views",         source: "press-kits" },
  pressKitUniqueVisitors:  { kind: "raw", type: "count", label: "Unique Visitors",    source: "press-kits" },

  // ── Cost & runs: runs-service ─────────────────────────────────────────────
  // COMMITTED run spend (billed `actual` + open `provisioned` holds). THE single spend basis of this
  // service and the numerator behind every cost-per-X below, so each cost-per metric reconciles with
  // the same total /revenue reports as "Total spent" and rides the same money its ROI does. Do NOT
  // repoint these numerators at the billed-only field: a second basis is what made one brand read
  // $202 on its Overview and $191 on its campaigns table. (features-service#396, single basis #779)
  totalCostInUsdCents:  { kind: "raw", type: "currency", label: "Total Spent",       source: "runs" },
  // Billed-only run spend. REPORTED for the consumer transition, divided by nowhere.
  actualCostInUsdCents: { kind: "raw", type: "currency", label: "Billed Spend",      source: "runs" },
  completedRuns:        { kind: "raw", type: "count",    label: "Runs",              source: "runs" },

  // ── Outlets: outlets-service ──────────────────────────────────────────────
  outletsDiscovered:   { kind: "raw", type: "count",    label: "Outlets Found",    source: "outlets" },
  avgRelevanceScore:   { kind: "raw", type: "count",    label: "Avg Relevance",    source: "outlets" },
  searchQueriesUsed:   { kind: "raw", type: "count",    label: "Searches",         source: "outlets" },

  // ── Campaigns: campaign-service ───────────────────────────────────────────
  activeCampaigns:     { kind: "raw", type: "count",    label: "Active Campaigns", source: "campaign" },

  // ── Derived rates (recipient-level) ───────────────────────────────────────
  recipientOpenRate:            { kind: "derived", type: "rate",     label: "% Opens",       numerator: "recipientsOpened",          denominator: "recipientsDelivered" },
  recipientClickRate:           { kind: "derived", type: "rate",     label: "% Link Clicks", numerator: "recipientsClicked",         denominator: "recipientsDelivered" },
  recipientPositiveReplyRate:   { kind: "derived", type: "rate",     label: "% Positive",    numerator: "recipientsRepliesPositive",  denominator: "recipientsDelivered" },
  recipientNegativeReplyRate:   { kind: "derived", type: "rate",     label: "% Negative",    numerator: "recipientsRepliesNegative",  denominator: "recipientsDelivered" },
  recipientNeutralReplyRate:    { kind: "derived", type: "rate",     label: "% Neutral",     numerator: "recipientsRepliesNeutral",   denominator: "recipientsDelivered" },

  // ── Derived cost-per (recipient-level) ──────────────────────────────────
  costPerRecipientOpenCents:          { kind: "derived", type: "currency", label: "$/Open",           numerator: "totalCostInUsdCents",  denominator: "recipientsOpened" },
  costPerRecipientClickCents:         { kind: "derived", type: "currency", label: "$/Link Click",     numerator: "totalCostInUsdCents",  denominator: "recipientsClicked" },
  costPerRecipientPositiveReplyCents: { kind: "derived", type: "currency", label: "$/Positive Reply", numerator: "totalCostInUsdCents",  denominator: "recipientsRepliesPositive" },
  // ── Derived rates (lead-scoped) ──────────────────────────────────────────
  leadOpenRate:                 { kind: "derived", type: "rate",     label: "% Lead Opens",     numerator: "leadsOpened",          denominator: "leadsDelivered" },
  leadClickRate:                { kind: "derived", type: "rate",     label: "% Lead Clicks",    numerator: "leadsClicked",         denominator: "leadsDelivered" },
  leadPositiveReplyRate:        { kind: "derived", type: "rate",     label: "% Lead Positive",  numerator: "leadsRepliesPositive", denominator: "leadsDelivered" },
  leadNegativeReplyRate:        { kind: "derived", type: "rate",     label: "% Lead Negative",  numerator: "leadsRepliesNegative", denominator: "leadsDelivered" },
  leadNeutralReplyRate:         { kind: "derived", type: "rate",     label: "% Lead Neutral",   numerator: "leadsRepliesNeutral",  denominator: "leadsDelivered" },

  // ── Derived cost-per (lead-scoped) ───────────────────────────────────────
  costPerLeadOpenCents:           { kind: "derived", type: "currency", label: "$/Lead Open",           numerator: "totalCostInUsdCents", denominator: "leadsOpened" },
  costPerLeadClickCents:          { kind: "derived", type: "currency", label: "$/Lead Click",          numerator: "totalCostInUsdCents", denominator: "leadsClicked" },
  costPerLeadPositiveReplyCents:  { kind: "derived", type: "currency", label: "$/Lead Positive Reply", numerator: "totalCostInUsdCents", denominator: "leadsRepliesPositive" },

  costPerOutletCents:     { kind: "derived", type: "currency", label: "$/Outlet",      numerator: "totalCostInUsdCents",  denominator: "outletsDiscovered" },
  costPerPressKitCents:   { kind: "derived", type: "currency", label: "$/Kit",         numerator: "totalCostInUsdCents",  denominator: "pressKitsGenerated" },
  costPerPressKitViewCents: { kind: "derived", type: "currency", label: "$/View",      numerator: "totalCostInUsdCents",  denominator: "pressKitViews" },

  // ── Derived (quote outreach) ────────────────────────────────────────────
  pitchSelectionRate:        { kind: "derived", type: "rate",     label: "% Selected",   numerator: "quotesSelected",      denominator: "quotePitchesSubmitted" },
  pitchPublishRate:          { kind: "derived", type: "rate",     label: "% Published",  numerator: "quotesPublished",     denominator: "quotePitchesSubmitted" },
  costPerQuotePublishedCents:{ kind: "derived", type: "currency", label: "$/Published",  numerator: "totalCostInUsdCents", denominator: "quotesPublished", sortDirection: "asc" },
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
  companies:    { label: "Companies",   icon: "building",     pathSuffix: "companies",   description: "Target companies identified for the campaign" },
  emails:       { label: "Emails",      icon: "envelope",     pathSuffix: "emails",      description: "Email messages generated and sent by the campaign" },
  outlets:      { label: "Outlets",     icon: "newspaper",    pathSuffix: "outlets",      description: "Media outlets discovered for PR outreach" },
  journalists:  { label: "Journalists", icon: "pen-tool",     pathSuffix: "journalists", description: "Journalists found at discovered outlets" },
  "press-kits": { label: "Press Kits",  icon: "document",     pathSuffix: "press-kits",  description: "Press kits generated for media pitching" },
  articles:     { label: "Articles",    icon: "scroll-text",  pathSuffix: "articles",    description: "Published articles resulting from PR campaigns" },
  "quote-requests":  { label: "Quote Requests",  icon: "help-circle",     pathSuffix: "quote-requests",  description: "Featured.com journalist quote requests synced for the campaign" },
  "quote-pitches":   { label: "Pitches",         icon: "quote",           pathSuffix: "quote-pitches",   description: "Quote pitches drafted and submitted to journalists" },
  "visibility-runs": { label: "Visibility Runs", icon: "sparkles",        pathSuffix: "visibility-runs", description: "AI visibility audit runs over time" },
  prompts:           { label: "Prompts",         icon: "message-square",  pathSuffix: "prompts",         description: "LLM prompts tested in visibility audits" },
  competitors:       { label: "Competitors",     icon: "swords",          pathSuffix: "competitors",     description: "Competitor brands tracked in visibility audits" },
};

/** Known entity types for feature.entities */
export const VALID_ENTITY_TYPES = new Set(Object.keys(ENTITY_REGISTRY));

/** System stats — always present in stats responses, not declared by features */
export const SYSTEM_STATS_KEYS = [
  "totalCostInUsdCents",
  "actualCostInUsdCents",
  "completedRuns",
  "activeCampaigns",
  "firstRunAt",
  "lastRunAt",
] as const;

/**
 * Get the public registry (label + type + optional sortDirection for each key).
 * Exposed via GET /stats/registry for the front-end.
 */
export function getPublicRegistry(): Record<string, { type: string; label: string; sortDirection?: "asc" | "desc" }> {
  const result: Record<string, { type: string; label: string; sortDirection?: "asc" | "desc" }> = {};
  for (const [key, def] of Object.entries(STATS_REGISTRY)) {
    const entry: { type: string; label: string; sortDirection?: "asc" | "desc" } = { type: def.type, label: def.label };
    if (def.sortDirection) entry.sortDirection = def.sortDirection;
    result[key] = entry;
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
 * Resolve the MINIMAL set of upstream stat SOURCES a feature actually renders, given the
 * stat keys it declares (its `outputs` + `charts`). Derived keys are resolved to the sources
 * of their numerator + denominator (transitively). Unknown keys (chart ids like "funnel",
 * non-stat props) are ignored. `needsRunFilter` is true when any declared raw key carries a
 * `runFilter` (the pipeline/run-count family, served by a SEPARATE runs-service call).
 *
 * Used by GET /features/:slug/stats to skip fan-out HTTP calls to sources the feature never
 * renders — a lead-gen feature need not wait on outlets / journalists / press-kits / etc.
 */
export function requiredStatsSources(keys: string[]): {
  sources: Set<RawStatsSource>;
  needsRunFilter: boolean;
} {
  const sources = new Set<RawStatsSource>();
  let needsRunFilter = false;
  const seen = new Set<string>();

  const visit = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const def = STATS_REGISTRY[key];
    if (!def) return; // chart id / non-stat prop → ignore
    if (def.kind === "raw") {
      sources.add(def.source);
      if (def.runFilter) needsRunFilter = true;
    } else {
      visit(def.numerator);
      visit(def.denominator);
    }
  };

  for (const key of keys) visit(key);
  return { sources, needsRunFilter };
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
