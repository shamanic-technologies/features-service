/**
 * Grain-scoped evidence fetchers for GET /features/:slug/workflow-projection.
 *
 * The endpoint serves a 3-grain projection ladder per (audienceId?, workflowDynasty):
 *   - crossOrg : fleet-wide per-workflow unit costs + outcomes (feature-scoped, no brand filter) —
 *                the EXISTING /public/stats/best data path (fetchPublicCosts / fetchPublicEmailStats).
 *   - brand    : the SAME path scoped to one brandId (runs groupBy=workflowSlug + brandId, email-gateway
 *                broadcast groupBy=workflowSlug + brandId) — this module (`fetchBrandWorkflowEvidence`).
 *   - audience : per-(audience × dynasty) SEND-TAG evidence — cost (runs groupBy=audienceId,workflowSlug)
 *                + outcomes (email-gateway /orgs/stats?audienceId&groupBy=workflowSlug), both mapped
 *                slug→dynasty. Every active audience is enumerated (`fetchAudienceGrainEvidence`).
 *
 * Both brand + audience reads are ORG-SCOPED (x-org-id) and fail loud (throw → handler 502). No silent
 * fallback, no synthesized data. The dynasty rollup reuses buildWorkflowDynasties / aggregateAcrossDynasties so
 * a workflow's evidence includes its predecessor versions', identical to crossOrg.
 */

import { campaignFamilyStatsParams } from "./email-gateway-family.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { buildWorkflowDynasties, aggregateAcrossDynasties } from "../routes/public.js";
import type { WorkflowMetadata } from "./public-stats-clients.js";
import { fetchActiveAudiences, fetchAudienceMemberEmails } from "./human-client.js";
import { setPersonRepliesOnSlugStats, type CrmOnlyReplier, type PositiveReplier } from "./crm-only-repliers.js";
import { mapWithConcurrency } from "./concurrency.js";
import { selectCostCents, selectCostCentsString, type Pricing } from "./pricing.js";
import { type CostBasis } from "./cost-basis.js";

/**
 * Workflow-ranking EVIDENCE (per-workflow / per-audience engagement) moves on the scale of minutes
 * and a campaign's views refresh every few seconds, so an interactive view reuses these reads for
 * 30s and re-reads them behind the answer (fetch-retry.ts `shareForMs`) — the freshness they had when
 * every view refreshed every ~30s (features-service#1045). Event figures (sends, replies, spend) are
 * NOT read here.
 */
const EVIDENCE_REUSE = { shareForMs: 30_000 };

export interface Identity {
  orgId: string;
  userId?: string;
  runId?: string;
  featureSlug?: string;
}

function runsHeaders(brandId: string, identity: Identity): Record<string, string> {
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!apiKey) throw new Error("RUNS_SERVICE_API_KEY not configured");
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-brand-id": brandId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;
  return headers;
}

function emailHeaders(brandId: string, identity: Identity): Record<string, string> {
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!apiKey) throw new Error("EMAIL_GATEWAY_SERVICE_API_KEY not configured");
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
    "x-brand-id": brandId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;
  return headers;
}

interface CostGroup {
  dimensions: Record<string, string | null>;
  totalCostInUsdCents: string;
  /** Frozen-NET twin (runs#179) — read via selectCostCents when pricing === "net". */
  netTotalCostInUsdCents?: string;
  runCount: number;
}

/** Brand-scoped runs cost groups (org-scoped, groupBy=workflowSlug, filtered by brandId + feature). */
async function fetchBrandCostGroups(
  brandId: string,
  featureSlug: string,
  groupBy: string,
  identity: Identity,
): Promise<CostGroup[]> {
  const baseUrl = process.env.RUNS_SERVICE_URL;
  if (!baseUrl) throw new Error("RUNS_SERVICE_URL not configured");
  const params = new URLSearchParams({ groupBy, brandId, featureSlugs: featureSlug });
  const response = await fetchWithRetry(`${baseUrl}/v1/stats/costs?${params}`, { headers: runsHeaders(brandId, identity) });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`runs-service /v1/stats/costs (groupBy=${groupBy}, brandId) failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as { groups?: CostGroup[] };
  if (!Array.isArray(data.groups)) {
    throw new Error(`runs-service /v1/stats/costs (groupBy=${groupBy}, brandId) returned no groups array`);
  }
  return data.groups;
}

/** Brand-scoped broadcast email stats (org-scoped, groupBy=workflowSlug, filtered by brandId + feature). */
async function fetchBrandEmailStats(
  brandId: string,
  featureSlug: string,
  identity: Identity,
): Promise<Map<string, Record<string, number>>> {
  const baseUrl = process.env.EMAIL_GATEWAY_SERVICE_URL;
  if (!baseUrl) throw new Error("EMAIL_GATEWAY_SERVICE_URL not configured");
  const params = new URLSearchParams({ type: "broadcast", groupBy: "workflowSlug", brandId, featureSlugs: featureSlug });
  const response = await fetchWithRetry(`${baseUrl}/orgs/stats?${params}`, { headers: emailHeaders(brandId, identity) }, EVIDENCE_REUSE);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`email-gateway /orgs/stats (groupBy=workflowSlug, brandId) failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as { groups?: Array<Record<string, unknown>> };
  const result = new Map<string, Record<string, number>>();
  if (Array.isArray(data.groups)) {
    for (const group of data.groups) {
      const key = String(group.key ?? "__total__");
      result.set(key, extractBroadcastRecipientStats(group));
    }
  }
  return result;
}

function extractBroadcastRecipientStats(group: Record<string, unknown>): Record<string, number> {
  const broadcast = group.broadcast as Record<string, unknown> | undefined;
  const recipientStats = broadcast?.recipientStats as Record<string, number> | undefined;
  if (!recipientStats) return {};
  return {
    recipientsContacted: recipientStats.contacted,
    recipientsClicked: recipientStats.clicked,
    recipientsRepliesPositive: recipientStats.repliesPositive,
  };
}

/** Per-workflow-dynasty aggregated evidence (cost + contacted/clicks/replies), rolled up over the upgrade funnel. */
export interface WorkflowGrainEvidence {
  totalCostInUsdCents: number;
  completedRuns: number;
  contacted: number;
  clicks: number;
  replies: number;
}

/**
 * The dynasty map a BRAND- or CAMPAIGN-grain rollup uses, split into the ACTIVE dynasties (keyed by the
 * active version's slug — the map `buildWorkflowDynasties` builds, which every ranked row is keyed on)
 * and the RETIRED ones (keyed by the dynasty slug — a lineage with no active version left).
 *
 * `buildWorkflowDynasties` walks `upgradedTo` from each ACTIVE workflow, so two things fall out of it:
 * a deprecated version of a still-active dynasty that the upgrade chain never reached, and a whole
 * dynasty nobody runs any more. Both carry real spend and real outcomes of this brand, and dropping them
 * made the per-workflow rows sum to less than the scope's own total (Doc Dinners 2026-09-25: 23 positive
 * replies across the rows against 26 on `/stats`, three of them under the retired arcadia, bronze-2 and
 * cirque). So an unreached version joins the ACTIVE dynasty sharing its `workflowDynastySlug`, a retired
 * lineage becomes its own group, and a slug the catalogue does not describe at all is a dynasty of one —
 * the rule `?groupBy=workflow` already applies.
 */
export function brandGrainDynasties(
  workflows: WorkflowMetadata[],
  observedSlugs: Iterable<string>,
): { active: Map<string, string[]>; retired: Map<string, string[]> } {
  const active = buildWorkflowDynasties(workflows);
  const covered = new Set<string>();
  for (const members of active.values()) for (const slug of members) covered.add(slug);
  const activeKeyByDynasty = new Map<string, string>();
  for (const w of workflows) {
    if (active.has(w.workflowSlug)) activeKeyByDynasty.set(w.workflowDynastySlug, w.workflowSlug);
  }
  const retired = new Map<string, string[]>();
  const place = (slug: string, dynastySlug: string) => {
    if (covered.has(slug)) return;
    covered.add(slug);
    const activeKey = activeKeyByDynasty.get(dynastySlug);
    if (activeKey) {
      active.set(activeKey, [...(active.get(activeKey) ?? []), slug]);
      return;
    }
    retired.set(dynastySlug, [...(retired.get(dynastySlug) ?? []), slug]);
  };
  for (const w of workflows) place(w.workflowSlug, w.workflowDynastySlug);
  for (const slug of observedSlugs) place(slug, slug);
  return { active, retired };
}

/** A brand- or campaign-grain rollup, active dynasties and retired lineages kept apart. */
export interface GrainEvidenceWithRetired {
  /** Keyed by each active dynasty's active slug — the rows every ranked surface is built from. */
  active: Map<string, WorkflowGrainEvidence>;
  /** Keyed by the retired dynasty's slug. Evidence only: a retired workflow can never be put forward. */
  retired: Map<string, WorkflowGrainEvidence>;
}

function rollUpGrain(
  workflows: WorkflowMetadata[],
  costGroups: Array<{ dimensions: Record<string, string | null>; totalCostInUsdCents: string; runCount: number }>,
  emailStats: Map<string, Record<string, number>>,
  repliers: readonly PositiveReplier[] | undefined,
): GrainEvidenceWithRetired {
  if (repliers) setPersonRepliesOnSlugStats(emailStats, repliers);
  const observed = costGroups.map((g) => g.dimensions.workflowSlug).filter((s): s is string => Boolean(s));
  const { active, retired } = brandGrainDynasties(workflows, observed);
  const toEvidence = (dynasties: Map<string, string[]>) => {
    const { costMap, aggregatedOutcomes } = aggregateAcrossDynasties(dynasties, costGroups, emailStats, "workflowSlug");
    const result = new Map<string, WorkflowGrainEvidence>();
    for (const [key, cost] of costMap) {
      const outcomes = aggregatedOutcomes.get(key) ?? {};
      result.set(key, {
        totalCostInUsdCents: cost.totalCostInUsdCents,
        completedRuns: cost.completedRuns,
        contacted: outcomes.recipientsContacted ?? 0,
        clicks: outcomes.recipientsClicked ?? 0,
        replies: outcomes.recipientsRepliesPositive ?? 0,
      });
    }
    return result;
  };
  return { active: toEvidence(active), retired: toEvidence(retired) };
}

/**
 * BRAND-grain evidence per active workflow dynasty for one (brand, feature): the SAME data path as
 * crossOrg (fetchPublicCosts/fetchPublicEmailStats + aggregateAcrossDynasties) but scoped to `brandId`.
 * Keyed by active workflow slug (the dynasty's active version). A dynasty the brand never ran is absent
 * from the map → the handler omits the brand grain for that dynasty (spentUsd = 0 rule).
 */
export async function fetchBrandWorkflowEvidence(
  brandId: string,
  featureSlug: string,
  workflows: WorkflowMetadata[],
  identity: Identity,
  // NET reads runs#179's frozen net twin per group; GROSS reads the gross field → byte-identical.
  pricing: Pricing = "gross",
  // CHARGED (the default) is the customer's own money — this grain is what `workflow-projection` and
  // `/audience-stats` display and floor against, so a comped cost must be absent from it. INCURRED is
  // taken by ONE caller: the brand-observed cost-per-outreach that floors the budget→sends PROJECTION,
  // which is compared against the fleet benchmark and therefore must be read on the fleet's basis.
  basis: CostBasis = "charged",
  // The brand's positive repliers, one per PERSON (`fetchPositiveRepliers`). They REPLACE
  // email-gateway's per-slug reply count, so the grain counts replies on the person set `/stats` counts —
  // CRM-evidenced ones included, nobody twice — and the rows sum to the brand's total. Omitted by a
  // caller that reads no reply off this grain (the budget→sends projection reads cost and contacted only).
  repliers?: readonly PositiveReplier[],
): Promise<Map<string, WorkflowGrainEvidence>> {
  return (await fetchBrandWorkflowEvidenceWithRetired(brandId, featureSlug, workflows, identity, pricing, basis, repliers)).active;
}

/** The brand grain with its retired lineages kept beside the active dynasties (see `brandGrainDynasties`). */
export async function fetchBrandWorkflowEvidenceWithRetired(
  brandId: string,
  featureSlug: string,
  workflows: WorkflowMetadata[],
  identity: Identity,
  pricing: Pricing = "gross",
  basis: CostBasis = "charged",
  repliers?: readonly PositiveReplier[],
): Promise<GrainEvidenceWithRetired> {
  const [costGroups, emailStats] = await Promise.all([
    fetchBrandCostGroups(brandId, featureSlug, "workflowSlug", identity),
    fetchBrandEmailStats(brandId, featureSlug, identity),
  ]);
  // Select gross vs frozen-net cost per group BEFORE the dynasty rollup, so the aggregated brand-grain
  // cost is net-or-gross end to end (no post-hoc multiply).
  return rollUpGrain(
    workflows,
    costGroups.map((g) => ({ dimensions: g.dimensions, totalCostInUsdCents: selectCostCentsString(g, "totalCostInUsdCents", pricing, basis), runCount: g.runCount })),
    emailStats,
    repliers,
  );
}

// ── AUDIENCE grain (send-tag, per (audience × dynasty)) ──────────────────────
//
// Per-(audience × workflow-dynasty) attributed evidence, all SEND-TAG:
//   cost    = runs groupBy=audienceId,workflowSlug (the audienceId + workflowSlug tags frozen on each
//             cost row) — post workflow-service#333 the loop-body send/gen cost carries audienceId.
//   outcome = email-gateway /orgs/stats?audienceId=<id>&groupBy=workflowSlug (the audienceId tag on each
//             broadcast send, split per workflow) — the ONLY basis that can split outcomes per workflow
//             (membership cannot; email-gateway#168/#170). Same send-tag basis as the brand grain
//             (/orgs/stats groupBy=workflowSlug) and as /audience-stats, so cost + outcome are one basis
//             end to end → cost-per-outcome coherent, and the per-dynasty rows SUM to the audience total.
// Both map the versioned workflowSlug → dynasty slug locally (slugToDynasty) and sum per dynasty, so the
// audience grain aligns with the dynasty-keyed crossOrg/brand rows. EVERY active audience is enumerated
// (an audience with no attributed couple still surfaces — the handler floors it to brand→crossOrg).

export interface AudienceGrainEvidence {
  audienceId: string;
  /**
   * Per active dynasty slug: the (audience × dynasty) send-tag cost + outcomes. A dynasty absent from the
   * map has no attributed data for this audience (the handler then floors that couple to brand→crossOrg).
   */
  byDynasty: Map<string, WorkflowGrainEvidence>;
}

function audienceIdFromDimensions(dimensions: Record<string, string | null> | undefined): string | null {
  const id = dimensions?.audienceId;
  return id && id !== "__total__" ? id : null;
}

interface DynastyCost {
  totalCostInUsdCents: number;
  completedRuns: number;
}

/**
 * Per-(audience × dynasty) cost from runs `groupBy=audienceId,workflowSlug`, mapped slug → dynasty and
 * summed per dynasty, restricted to the active-audience set.
 *
 * Deliberately groups by the RAW `workflowSlug` column (not the derived `workflowDynastySlug`): runs-service
 * resolves `workflowDynastySlug` by grouping on `workflow_slug` then merging rows with a merge key of
 * DYNASTY ALONE (`regroupByDynasty`), which DROPS the co-grouped `audienceId` dimension — every audience
 * that shares a dynasty collapses into the single highest-spend audience for that dynasty. Grouping on the
 * real `workflowSlug` column skips that lossy regroup entirely (correct per-(audience×workflow) split); we
 * map each slug → dynasty locally via the SAME workflow metadata the crossOrg/brand grains roll up through.
 * runs-service#174 tracks the producer-side regroupByDynasty secondary-dimension collapse.
 */
async function fetchAudienceDynastyCosts(
  brandId: string,
  featureSlug: string,
  activeIds: Set<string>,
  identity: Identity,
  pricing: Pricing,
  slugToDynasty: Map<string, string>,
): Promise<Map<string, Map<string, DynastyCost>>> {
  const groups = await fetchBrandCostGroups(brandId, featureSlug, "audienceId,workflowSlug", identity);
  const result = new Map<string, Map<string, DynastyCost>>();
  for (const g of groups) {
    const audienceId = audienceIdFromDimensions(g.dimensions);
    const workflowSlug = g.dimensions?.workflowSlug;
    if (!audienceId || !activeIds.has(audienceId)) continue;
    if (!workflowSlug || workflowSlug === "__total__") continue;
    const dynasty = slugToDynasty.get(workflowSlug) ?? workflowSlug;
    if (!result.has(audienceId)) result.set(audienceId, new Map());
    const byDynasty = result.get(audienceId)!;
    const prev = byDynasty.get(dynasty) ?? { totalCostInUsdCents: 0, completedRuns: 0 };
    byDynasty.set(dynasty, {
      totalCostInUsdCents: prev.totalCostInUsdCents + Math.round(selectCostCents(g, "totalCostInUsdCents", pricing)),
      completedRuns: prev.completedRuns + Number(g.runCount),
    });
  }
  return result;
}

interface DynastyOutcome {
  contacted: number;
  clicks: number;
  replies: number;
}

/**
 * Per-(audience × dynasty) SEND-TAG outcomes from email-gateway `/orgs/stats?audienceId=<id>&groupBy=
 * workflowSlug` (one call per audience, concurrency-capped), mapped slug → dynasty and summed per dynasty.
 * This is the send-tag basis (the audienceId + workflowSlug stamped on each broadcast send) — the only
 * attribution that can split an audience's engagement per workflow. Fails loud on any downstream error.
 */
async function fetchAudienceDynastyOutcomes(
  brandId: string,
  featureSlug: string,
  audienceIds: string[],
  identity: Identity,
  slugToDynasty: Map<string, string>,
): Promise<Map<string, Map<string, DynastyOutcome>>> {
  const baseUrl = process.env.EMAIL_GATEWAY_SERVICE_URL;
  if (!baseUrl) throw new Error("EMAIL_GATEWAY_SERVICE_URL not configured");
  const result = new Map<string, Map<string, DynastyOutcome>>();
  if (audienceIds.length === 0) return result;

  const perAudience = await mapWithConcurrency(audienceIds, 6, async (audienceId) => {
    const params = new URLSearchParams({
      type: "broadcast",
      groupBy: "workflowSlug",
      audienceId,
      brandId,
      featureSlugs: featureSlug,
    });
    const response = await fetchWithRetry(`${baseUrl}/orgs/stats?${params}`, { headers: emailHeaders(brandId, identity) }, EVIDENCE_REUSE);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`email-gateway /orgs/stats (audienceId, groupBy=workflowSlug) failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as { groups?: Array<Record<string, unknown>> };
    const byDynasty = new Map<string, DynastyOutcome>();
    if (Array.isArray(data.groups)) {
      for (const group of data.groups) {
        const workflowSlug = String(group.key ?? "__total__");
        if (workflowSlug === "__total__") continue;
        const dynasty = slugToDynasty.get(workflowSlug) ?? workflowSlug;
        const stats = extractBroadcastRecipientStats(group);
        const prev = byDynasty.get(dynasty) ?? { contacted: 0, clicks: 0, replies: 0 };
        byDynasty.set(dynasty, {
          contacted: prev.contacted + (stats.recipientsContacted ?? 0),
          clicks: prev.clicks + (stats.recipientsClicked ?? 0),
          replies: prev.replies + (stats.recipientsRepliesPositive ?? 0),
        });
      }
    }
    return { audienceId, byDynasty };
  });

  for (const { audienceId, byDynasty } of perAudience) result.set(audienceId, byDynasty);
  return result;
}

/**
 * Per (audience × dynasty), how many of the brand's CRM-only positive repliers are MEMBERS of the audience
 * (distinct leads). Fails loud like every other read of this grain.
 */
async function fetchAudienceCrmReplies(
  audienceIds: string[],
  repliers: readonly CrmOnlyReplier[],
  identity: Identity,
  slugToDynasty: Map<string, string>,
): Promise<Map<string, Map<string, number>>> {
  const perAudience = await mapWithConcurrency(audienceIds, 6, async (audienceId) => ({
    audienceId,
    emails: new Set((await fetchAudienceMemberEmails(audienceId, identity)).map((e) => e.trim().toLowerCase())),
  }));
  const result = new Map<string, Map<string, number>>();
  for (const { audienceId, emails } of perAudience) {
    const byDynasty = new Map<string, number>();
    for (const r of repliers) {
      if (!r.email || !r.workflowSlug || !emails.has(r.email)) continue;
      const dynasty = slugToDynasty.get(r.workflowSlug) ?? r.workflowSlug;
      byDynasty.set(dynasty, (byDynasty.get(dynasty) ?? 0) + 1);
    }
    if (byDynasty.size > 0) result.set(audienceId, byDynasty);
  }
  return result;
}

/**
 * Build the audience-grain evidence for a (brand, feature). One entry per ACTIVE human-service audience
 * (all of them — an audience with no attributed couple still surfaces with an empty `byDynasty`, and the
 * handler floors it to brand→crossOrg so every active audience appears under every active workflow). Both
 * cost and outcome are send-tag and keyed per dynasty, so the per-dynasty rows sum to the audience total
 * on the SAME basis as /audience-stats. Empty when the brand has no active audiences. Fails loud on any
 * downstream error.
 *
 * `slugToDynasty` maps each versioned `workflowSlug` → its dynasty slug — the SAME workflow metadata the
 * crossOrg/brand grains roll up through — so the audience's dynasty set aligns with the dynasty-keyed
 * crossOrg/brand rows. A slug absent from the map falls back to itself.
 *
 * `audienceIdsOverride` lets a caller that ALREADY holds the brand's audience list (e.g. /audience-stats,
 * which fetched them by requested status) supply it, skipping the duplicate human-service round-trip —
 * and, since that list may include paused/archived audiences, giving every row it will render its own
 * grain rather than the coarser brand fallback. Omitted → the active audiences are fetched here.
 */
export async function fetchAudienceGrainEvidence(
  brandId: string,
  featureSlug: string,
  identity: Identity,
  slugToDynasty: Map<string, string>,
  // NET reads runs#179's frozen net twin per audience group; GROSS reads the gross field → byte-identical.
  pricing: Pricing = "gross",
  audienceIdsOverride?: string[],
  // The brand's CRM-ONLY positive repliers. Attributed to an audience by MEMBERSHIP (human-service) —
  // the same join `/audience-stats` adds them through — and to the dynasty of the workflow the lead was
  // served under. Member lists are read only when there is somebody to place.
  crmRepliers?: readonly (CrmOnlyReplier & { crmOnly?: boolean })[],
): Promise<AudienceGrainEvidence[]> {
  const audienceIds = audienceIdsOverride ?? (await fetchActiveAudiences(brandId, identity)).map((a) => a.id);
  if (audienceIds.length === 0) return [];
  const activeIds = new Set(audienceIds);
  // Only the CRM-ONLY ones: email-gateway's per-audience count already holds every classified reply.
  const placeable = (crmRepliers ?? []).filter((r) => r.crmOnly !== false && r.email && r.workflowSlug);

  const [costByAudience, outcomeByAudience, crmByAudience] = await Promise.all([
    fetchAudienceDynastyCosts(brandId, featureSlug, activeIds, identity, pricing, slugToDynasty),
    fetchAudienceDynastyOutcomes(brandId, featureSlug, audienceIds, identity, slugToDynasty),
    placeable.length > 0
      ? fetchAudienceCrmReplies(audienceIds, placeable, identity, slugToDynasty)
      : Promise.resolve(new Map<string, Map<string, number>>()),
  ]);

  const result: AudienceGrainEvidence[] = [];
  for (const audienceId of audienceIds) {
    const costByDynasty = costByAudience.get(audienceId) ?? new Map<string, DynastyCost>();
    const outcomeByDynasty = outcomeByAudience.get(audienceId) ?? new Map<string, DynastyOutcome>();
    const dynasties = new Set<string>([
      ...costByDynasty.keys(),
      ...outcomeByDynasty.keys(),
      ...(crmByAudience.get(audienceId)?.keys() ?? []),
    ]);
    const byDynasty = new Map<string, WorkflowGrainEvidence>();
    for (const dynasty of dynasties) {
      const c = costByDynasty.get(dynasty) ?? { totalCostInUsdCents: 0, completedRuns: 0 };
      const o = outcomeByDynasty.get(dynasty) ?? { contacted: 0, clicks: 0, replies: 0 };
      byDynasty.set(dynasty, {
        totalCostInUsdCents: c.totalCostInUsdCents,
        completedRuns: c.completedRuns,
        contacted: o.contacted,
        clicks: o.clicks,
        replies: o.replies + (crmByAudience.get(audienceId)?.get(dynasty) ?? 0),
      });
    }
    result.push({ audienceId, byDynasty });
  }
  return result;
}

// ── CAMPAIGN grain (one campaign IDENTITY's own evidence, per dynasty) ───────────────────────────
//
// A campaign screen compares grains — THIS campaign, this brand, every client we run the channel for —
// and until this existed the ladder answered for the brand, the fleet and an audience, so the campaign
// half had to be stitched on from a second endpoint by whoever was rendering it. One read answers for
// every grain it compares, or the two halves can come to describe different moments.
//
// It answers for the campaign's whole IDENTITY (org × brand × sales funnel × acquisition channel — the
// same family `/revenue?campaignId=` and `/audience-stats` total over), because campaign-service mints a
// new row every time a campaign's workflow switches and keeps the ancestors: a figure scoped to the
// newest row would describe the last few days of a campaign that has been running for weeks.
//
// Both legs narrow through the producer that froze the attribution, exactly as the brand grain does:
//   cost    = runs `groupBy=workflowSlug` with `campaignId=` for a single-member identity, and a
//             co-grouped `workflowSlug,campaignId` for a FAMILY (runs-service takes no campaign LIST),
//             whose members are kept locally and summed per workflow slug.
//   outcome = email-gateway `/orgs/stats?groupBy=workflowSlug&campaignIds=` — ONE request that sums the
//             per-member answers server-side (email-gateway v0.27.2); a send carries ONE campaign, so
//             the sum counts nobody twice. The identical property that lets the offer grain do it.

/** Merge co-grouped `(workflowSlug, campaignId)` cost rows down to one row per workflow slug. */
function mergeCostGroupsByWorkflowSlug(
  groups: CostGroup[],
  members: Set<string> | null,
  pricing: Pricing,
  basis: CostBasis,
): Array<{ dimensions: Record<string, string | null>; totalCostInUsdCents: string; runCount: number }> {
  const bySlug = new Map<string, { cents: number; runs: number }>();
  for (const group of groups) {
    const slug = group.dimensions.workflowSlug;
    if (!slug) continue;
    if (members) {
      const campaignId = group.dimensions.campaignId;
      if (!campaignId || !members.has(campaignId)) continue;
    }
    const cents = selectCostCents(group, "totalCostInUsdCents", pricing, basis);
    const existing = bySlug.get(slug);
    if (existing) {
      existing.cents += cents;
      existing.runs += group.runCount;
    } else {
      bySlug.set(slug, { cents, runs: group.runCount });
    }
  }
  return [...bySlug.entries()].map(([slug, v]) => ({
    dimensions: { workflowSlug: slug },
    totalCostInUsdCents: String(v.cents),
    runCount: v.runs,
  }));
}

/** Campaign-scoped runs cost groups. A one-member identity uses the producer's own `campaignId` filter
 *  (the byte-same request shape the brand grain makes, one filter narrower); a FAMILY co-groups and is
 *  narrowed locally, because runs-service takes no campaign list. */
async function fetchCampaignCostGroups(
  brandId: string,
  featureSlug: string,
  campaignIds: string[],
  identity: Identity,
): Promise<{ groups: CostGroup[]; filteredLocally: boolean }> {
  const baseUrl = process.env.RUNS_SERVICE_URL;
  if (!baseUrl) throw new Error("RUNS_SERVICE_URL not configured");
  const single = campaignIds.length === 1 ? campaignIds[0] : undefined;
  const params = new URLSearchParams({
    groupBy: single ? "workflowSlug" : "workflowSlug,campaignId",
    brandId,
    featureSlugs: featureSlug,
  });
  if (single) params.set("campaignId", single);
  const response = await fetchWithRetry(`${baseUrl}/v1/stats/costs?${params}`, {
    headers: runsHeaders(brandId, identity),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`runs-service /v1/stats/costs (campaign grain) failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as { groups?: CostGroup[] };
  if (!Array.isArray(data.groups)) {
    throw new Error("runs-service /v1/stats/costs (campaign grain) returned no groups array");
  }
  return { groups: data.groups, filteredLocally: !single };
}

/** Campaign-scoped broadcast email stats for the identity's members, summed. */
async function fetchCampaignEmailStats(
  brandId: string,
  featureSlug: string,
  campaignIds: string[],
  identity: Identity,
): Promise<Map<string, Record<string, number>>> {
  const baseUrl = process.env.EMAIL_GATEWAY_SERVICE_URL;
  if (!baseUrl) throw new Error("EMAIL_GATEWAY_SERVICE_URL not configured");
  // One `campaignIds` request for the whole family (email-gateway v0.27.2, lib/email-gateway-family.ts),
  // chunked only above the producer's cap; the answers are summed exactly as the per-member ones were.
  const perMember = await mapWithConcurrency(campaignFamilyStatsParams(campaignIds), 6, async (scope) => {
    const params = new URLSearchParams({
      type: "broadcast",
      groupBy: "workflowSlug",
      brandId,
      featureSlugs: featureSlug,
      ...scope,
    });
    const response = await fetchWithRetry(
      `${baseUrl}/orgs/stats?${params}`,
      { headers: emailHeaders(brandId, identity) },
      EVIDENCE_REUSE,
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`email-gateway /orgs/stats (campaign grain) failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as { groups?: Array<Record<string, unknown>> };
    return Array.isArray(data.groups) ? data.groups : [];
  });

  const result = new Map<string, Record<string, number>>();
  for (const groups of perMember) {
    for (const group of groups) {
      const key = String(group.key ?? "__total__");
      const stats = extractBroadcastRecipientStats(group);
      const existing = result.get(key);
      if (!existing) {
        result.set(key, { ...stats });
        continue;
      }
      for (const [k, v] of Object.entries(stats)) existing[k] = (existing[k] ?? 0) + (v ?? 0);
    }
  }
  return result;
}

/**
 * CAMPAIGN-grain evidence per active workflow dynasty, for ONE campaign identity. Same shape and same
 * dynasty rollup as the brand grain — only the narrowing moved. A dynasty this campaign never ran is
 * absent from the map, so the handler omits the campaign grain for it (the spentUsd = 0 rule).
 */
export async function fetchCampaignWorkflowEvidence(
  brandId: string,
  featureSlug: string,
  campaignIds: string[],
  workflows: WorkflowMetadata[],
  identity: Identity,
  pricing: Pricing = "gross",
  basis: CostBasis = "charged",
  // The campaign identity's positive repliers, one per person — replacing email-gateway's per-slug
  // reply count exactly as on the brand grain.
  repliers?: readonly PositiveReplier[],
): Promise<Map<string, WorkflowGrainEvidence>> {
  return (await fetchCampaignWorkflowEvidenceWithRetired(brandId, featureSlug, campaignIds, workflows, identity, pricing, basis, repliers)).active;
}

/** The campaign grain with its retired lineages kept beside the active dynasties. */
export async function fetchCampaignWorkflowEvidenceWithRetired(
  brandId: string,
  featureSlug: string,
  campaignIds: string[],
  workflows: WorkflowMetadata[],
  identity: Identity,
  pricing: Pricing = "gross",
  basis: CostBasis = "charged",
  repliers?: readonly PositiveReplier[],
): Promise<GrainEvidenceWithRetired> {
  const [{ groups, filteredLocally }, emailStats] = await Promise.all([
    fetchCampaignCostGroups(brandId, featureSlug, campaignIds, identity),
    fetchCampaignEmailStats(brandId, featureSlug, campaignIds, identity),
  ]);
  return rollUpGrain(
    workflows,
    mergeCostGroupsByWorkflowSlug(groups, filteredLocally ? new Set(campaignIds) : null, pricing, basis),
    emailStats,
    repliers,
  );
}
