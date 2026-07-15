/**
 * Assembly of the staff-gated `GET /internal/stats/customer-health` board — one ready-composed HEALTH
 * ROW per cold-email customer (org × brand), currently-active first, for the admin "Customer Success"
 * page. EVERY displayed metric is computed + owned HERE; the dashboard renders only (no browser math,
 * no per-row fan-out).
 *
 * GRAIN. One row per (org, brand) — the same account grain as `GET /internal/stats/accounts`. Economics,
 * goal, audiences, and workflows are all brand-scoped, so the brand is the natural row key. An org with
 * several cold-email brands yields several rows; each carries the org identity + the org's shared
 * recency/retention signal.
 *
 * UNIVERSE. The SAME source the accounts audit + active-users history use: lead-service feature-memberships
 * over the cold-email feature slugs. The accounts audit already deduped this to distinct (org, brand) with
 * identity + status + budget + balance, so we REUSE it wholesale (`buildAccountsAudit`) rather than
 * re-enumerating; likewise the per-org recency/retention comes from `buildActiveUsersByUser`. Then per
 * (org, brand) we enrich with the brand's economics + goal, observed conversions, realized ROI, audience
 * rollup + best audience, and best workflow — each single-sourced through the SAME compute the dashboard's
 * own pages use (computeFeatureRevenue / computeAudienceStats / computeWorkflowProjection), so a health-row
 * number never disagrees with the drill-down page it summarizes.
 *
 * ECONOMICS COHERENCE (owned formula). All value metrics derive from ONE set of realized numbers so they
 * cannot contradict each other:
 *   - breakevenCacUsd = ltrUsd = the brand's own lifetime revenue per customer (SalesEconomics.lifetimeRevenueUsd).
 *   - the revenue engine yields realized (billed) spend + expected pipeline; from its costEconomics:
 *       roiMultiple = pipeline / spend          (= LTR / CAC, by construction)
 *       cacPct      = spend / pipeline × 100     (= CAC / LTR × 100, by construction — pipeline = conversions × LTR)
 *   - currentCacUsd = (cacPct / 100) × ltrUsd     (the realized cost to acquire one paying customer)
 *   So GREEN's "ROI ≥ 1" ⟺ "CAC ≤ breakeven CAC" ⟺ "%CAC ≤ 100%" — one condition, three views, always coherent.
 *   These are surfaced ONLY when the brand has its OWN saved economics (source="user"); with no own economics
 *   the pipeline would fall back to a cross-brand AVERAGE (an estimate, not the brand's truth), so all
 *   economics-derived fields are explicit null instead — never an averaged ROI dressed as the brand's own.
 *
 * FAIL LOUD. No fabricated defaults, no silent fallback. Missing-by-design signals are explicit null (see
 * `notTrackedYet`). A stale feature-membership whose brand the forwarded org does not actually own
 * (BrandOwnershipError) is the ONE documented skip — its enrichment is nulled, the row still lists its
 * identity + status (mirrors handlePublicRevenue's stale-membership skip). Every other downstream error
 * propagates → the board 500s.
 */
import { fetchFeatureMemberships, type FeatureMembership } from "./feature-memberships-client.js";
import { buildAccountsAudit, type AccountsAudit, type AccountRow, type AccountStatus } from "./accounts-compute.js";
import { buildActiveUsersByUser, type ActiveUsersByUser, type ActiveUserRow } from "./active-users-by-user-compute.js";
import { fetchBrandSavedEconomicsWithGoal, BrandOwnershipError, type EffectiveEconomics } from "./sales-economics-client.js";
import { fetchConversionCounts, type ConversionCounts } from "./conversion-counts-client.js";
import { fetchDashboardReturnsByOrg, type DashboardReturnSignal } from "./posthog-client.js";
import { computeAudienceStats, type AudienceStatsEnvelope } from "./audience-stats-compute.js";
import { mapWithConcurrency } from "./concurrency.js";
import { getFunnel, type SalesEconomics } from "./funnel-registry.js";
import type { Goal } from "./goals.js";
import type { Request } from "express";
import { computeFeatureRevenue, type DownstreamHeaders } from "../routes/revenue.js";
import {
  computeWorkflowProjection,
  goalToProjectionInputs,
  type WorkflowProjectionResponse,
} from "../routes/workflow-projection.js";

/** Cap the per-customer enrichment fan-out so a cold-Neon sibling is not hit with N heavy composites at once. */
const CUSTOMER_FANOUT_CONCURRENCY = 4;

/** Audience is "near exhausted" (a yellow flag) once this % of its addressable members have been contacted. */
export const AUDIENCE_NEAR_EXHAUSTED_PCT = 80;

export type HealthBadge = "green" | "yellow" | "red";

/** The realized-economics slice of a row, computed from the revenue engine (own-economics only). */
interface CurrentEconomics {
  /** Realized (billed) acquisition spend in USD. null when not computed (no own economics). */
  realizedSpendUsd: number | null;
  /** Expected pipeline in USD (revenue engine EV total). null when incomputable. */
  expectedPipelineUsd: number | null;
  /** Realized cost to acquire ONE paying customer, USD = (cacPct/100) × LTR. null when incomputable. */
  currentCacUsd: number | null;
  /** LTR / CAC = pipeline / spend. ≥ 1 ⟺ CAC below breakeven. null when spend or pipeline is 0/unknown. */
  roiMultiple: number | null;
  /** CAC as a share of LTR, percent = spend / pipeline × 100. null when incomputable. */
  cacPct: number | null;
}

interface ConversionTracker {
  /** Whether the goal requires a client-site conversion tracker (signup / form / purchase → true; visit / reply → false). */
  needed: boolean;
  /** Observed attributed conversions of the goal's kind (lead-service tracker). null when the goal maps to no discrete conversion event (websiteVisit / positiveReply) or the goal is unknown. */
  observedConversions: number | null;
  /** INFERRED tracker health: observedConversions > 0. null when `needed` is false (n/a) or no count is available. A clean installed-and-verified boolean is a KNOWN GAP — this is the best-effort approximation, always `inferred:true`. */
  firing: boolean | null;
  /** Always true — `firing` is inferred from observed counts, not a real install/verify signal (see gap above). */
  inferred: true;
}

interface AudiencesRollup {
  /** Number of the brand's active audiences with evidence. */
  count: number;
  /** Total addressable members across the brand's audiences (Σ memberCount). */
  totalSize: number;
  /** Total remaining-to-contact across the brand's audiences (Σ max(memberCount − contacted, 0)). */
  totalRemaining: number;
  /** % of the addressable pool already contacted = Σcontacted / Σsize × 100. null when totalSize is 0. */
  pctUsed: number | null;
}

interface BestAudience {
  audienceId: string;
  name: string;
  /** The audience's CAC (cost per goal outcome) in USD — cpc for visit-driven goals, cppr for reply-driven. null when unmeasured. */
  cacUsd: number | null;
  /** Addressable member count. */
  size: number;
  /** Remaining-to-contact = max(size − contacted, 0). */
  remaining: number;
  /** % of the audience still un-contacted = remaining / size × 100. null when size is 0. */
  pctRemaining: number | null;
}

interface BestWorkflow {
  workflowDynastySlug: string;
  name: string | null;
  /** Best (lowest) projected cost per outcome in USD for the brand's goal. */
  cacUsd: number;
  /** Which grain the number comes from: crossOrg (fleet benchmark) | brand | audience. */
  grain: "crossOrg" | "brand" | "audience";
}

interface HealthInputs {
  active: boolean;
  hasBudget: boolean;
  roiMultiple: number | null;
  roiHealthy: boolean;
  audiencePctUsed: number | null;
  audienceNearExhausted: boolean;
  audienceNearExhaustedThresholdPct: number;
}

/**
 * Signals surfaced under `notTrackedYet` — explicit null so the front never fabricates them.
 * `dashboardReturnFrequency` IS now tracked (per-org PostHog return signal); it keeps its slot here for
 * response-path stability with the dashboard, and is null only when PostHog is unreachable/unconfigured
 * or the org has no dashboard activity. The other two remain genuine gaps.
 */
interface NotTrackedYet {
  /** Per-org dashboard-return frequency from PostHog (sessions 7d/30d + last-seen). null when PostHog has no data / is unreachable / is unconfigured. */
  dashboardReturnFrequency: DashboardReturnSignal | null;
  /** Daily-budget change history timeline — not persisted. */
  budgetChangeHistory: null;
  /** Pause on/off history timeline — not persisted. */
  pauseHistory: null;
}

export interface CustomerHealthRow {
  // ── Identity ──────────────────────────────────────────────────────────────
  orgId: string;
  orgExternalId: string | null;
  ownerEmail: string | null;
  brandId: string;
  brandName: string | null;
  brandDomain: string | null;
  /** The representative cold-email feature this row's economics / projection are computed for. null when the pair carries no membership slug (should not happen — it comes from the same universe as the accounts audit). */
  featureSlug: string | null;

  // ── Ordering + recency + retention (org-level, from the active-users history) ─
  /** Earliest UTC day (`YYYY-MM-DD`) the org billed cold-email spend. null when the org has never billed. */
  firstActiveDay: string | null;
  /** Latest UTC day (`YYYY-MM-DD`) the org billed cold-email spend. null when never active. */
  lastActiveDay: string | null;
  /** Retention window in ISO weeks (inclusive span between first and last active week). null when never active. */
  retentionWeeks: number | null;
  activeThisWeek: boolean;
  activeThisMonth: boolean;
  /** The de-facto active-day timeline from billed spend (cheap, already tracked). Distinct UTC days ascending. */
  activeDays: string[];

  // ── Current brand status (same composition as the accounts audit) ───────────
  status: AccountStatus;
  dailyBudgetUsd: number | null;
  orgBalanceUsd: number;
  orgActualBalanceUsd: number;
  autoTopupEnabled: boolean;

  // ── Goal + conversion tracker ───────────────────────────────────────────────
  /** The brand's "Maximising X" optimization goal (canonical camelCase). null when the brand saved no recognised goal. */
  optimizationGoal: Goal | null;
  conversionTracker: ConversionTracker;

  // ── Economics ────────────────────────────────────────────────────────────────
  /** Breakeven CAC (dollars) = the max acquisition cost before unprofitable = brand LTR. null with no own economics. */
  breakevenCacUsd: number | null;
  /** Lifetime revenue per customer (LTR / LTV), USD. Same value as breakevenCacUsd; named for clarity. */
  ltrUsd: number | null;
  /** Full conversion economics (all rates + LTR) — the brand's OWN saved set, or null. Passthrough. */
  economics: SalesEconomics | null;
  /** Realized CAC / ROI / %CAC from realized spend + outcomes (own-economics only). */
  currentEconomics: CurrentEconomics;

  // ── Audiences ──────────────────────────────────────────────────────────────
  audiences: AudiencesRollup;
  /** The single best-performing audience by CAC. null when there is no goal to rank on or no audiences. */
  bestAudience: BestAudience | null;

  // ── Best model / workflow ────────────────────────────────────────────────────
  /** The single best workflow/model by CAC + the grain the stat came from. null when no goal or no ranked workflow. */
  bestWorkflow: BestWorkflow | null;

  // ── Health badge (composed server-side) ──────────────────────────────────────
  health: {
    badge: HealthBadge;
    inputs: HealthInputs;
  };

  // ── Known gaps (explicit null — do NOT fabricate) ────────────────────────────
  notTrackedYet: NotTrackedYet;
}

export interface CustomerHealthStats {
  totalCustomers: number;
  activeCount: number;
  pausedCount: number;
  inactiveCount: number;
  greenCount: number;
  yellowCount: number;
  redCount: number;
}

export interface CustomerHealthBoard {
  customers: CustomerHealthRow[];
  stats: CustomerHealthStats;
  asOf: string;
}

/** Realized economics returned by the revenue-engine dep. */
interface BrandRevenueResult {
  actualCostUsd: number;
  expectedPipelineUsd: number | null;
  roiMultiple: number | null;
  cacPct: number | null;
}

/** Injectable client bundle (defaults to the real composites; overridden in tests). */
export interface CustomerHealthDeps {
  featureMemberships: (csv: string) => Promise<FeatureMembership[]>;
  accountsAudit: (csv: string, now: Date) => Promise<AccountsAudit>;
  activeUsersByUser: (csv: string, now: Date) => Promise<ActiveUsersByUser>;
  savedEconomicsWithGoal: (brandId: string) => Promise<{ economics: SalesEconomics | null; goal: Goal | null }>;
  conversionCounts: (brandId: string) => Promise<ConversionCounts>;
  /** Realized ROI/spend for one (org, brand) via the revenue engine. Called ONLY with own economics present. */
  brandRevenue: (featureSlug: string, brandId: string, orgId: string, economics: SalesEconomics) => Promise<BrandRevenueResult>;
  /** Ranked audience evidence for one (org, brand, goal). null when the feature is unknown (404). */
  audienceStats: (featureSlug: string, brandId: string, orgId: string, goal: Goal) => Promise<AudienceStatsEnvelope | null>;
  /** Workflow projection for one (org, brand, goal). */
  workflowProjection: (featureSlug: string, brandId: string, orgId: string, goal: Goal) => Promise<WorkflowProjectionResponse>;
  /** Per-org dashboard-return signal for the WHOLE fleet (PostHog), keyed on the Clerk org id (= orgExternalId). Fail-loud; the builder wraps it soft. */
  dashboardReturns: (now: Date) => Promise<Map<string, DashboardReturnSignal>>;
}

const REAL_DEPS: CustomerHealthDeps = {
  featureMemberships: fetchFeatureMemberships,
  accountsAudit: buildAccountsAudit,
  activeUsersByUser: buildActiveUsersByUser,
  savedEconomicsWithGoal: fetchBrandSavedEconomicsWithGoal,
  conversionCounts: fetchConversionCounts,
  dashboardReturns: fetchDashboardReturnsByOrg,
  brandRevenue: async (featureSlug, brandId, orgId, economics) => {
    const funnel = getFunnel(featureSlug);
    const headers: DownstreamHeaders = { orgId, featureSlug };
    // own economics present → source "user" (the engine skips its own effective fetch + never averages).
    const economicsOverride: EffectiveEconomics = { economics, source: "user" };
    const body = await computeFeatureRevenue(featureSlug, brandId, undefined, funnel, headers, undefined, economicsOverride);
    return {
      actualCostUsd: body.costEconomics.actualCostUsd,
      expectedPipelineUsd: body.headline.totalPipelineUsd,
      roiMultiple: body.costEconomics.roiMultiple,
      cacPct: body.costEconomics.costOfAcquisitionPct,
    };
  },
  audienceStats: async (featureSlug, brandId, orgId, goal) => {
    // computeAudienceStats reads its inputs off an Express Request; a synthetic org-only req (no user)
    // mirrors the cross-org public-revenue read pattern (service api-key + x-org-id, no faked user).
    const req = {
      params: { featureSlug },
      query: { brandId, goal },
      orgId,
    } as unknown as Request;
    const result = await computeAudienceStats(req, "gross");
    if (!result.ok) {
      // 404 (unknown feature) → no audience evidence for this pair; other statuses shouldn't occur here
      // (brandId + goal are always supplied). Treat non-ok as "no evidence" → null (row still lists the rest).
      return null;
    }
    return result.envelope;
  },
  workflowProjection: async (featureSlug, brandId, orgId, goal) => {
    const { objective, goalEcho, singleStepGoal, formSubmissionGoal } = goalToProjectionInputs(goal);
    return computeWorkflowProjection({
      featureSlug,
      brandId,
      objective,
      goal: goalEcho,
      singleStepGoal,
      formSubmissionGoal,
      identity: { orgId },
      pricing: "gross",
    });
  },
};

/** Goals that require a client-site conversion tracker (the micro/macro conversion happens off our platform). */
const TRACKER_NEEDED_GOALS: ReadonlySet<Goal> = new Set<Goal>(["signup", "formSubmission", "purchase"]);

/** Map a goal to its observed conversion-count from the lead-service tracker (null when the goal has no discrete event). */
function observedConversionsForGoal(goal: Goal | null, counts: ConversionCounts): number | null {
  switch (goal) {
    case "signup":
      return counts.signup;
    case "formSubmission":
      return counts.form_submission;
    case "purchase":
      return counts.purchase;
    case "meetingBooked":
      return counts.meeting_booked;
    default:
      // websiteVisit / positiveReply → the visit / reply IS the outcome (no discrete conversion event);
      // null goal → unknown. No tracker count applies.
      return null;
  }
}

/** Rollup a brand's audience rows into totals + best-audience pick (best = the goal-ranked audiences[0]). */
function summarizeAudiences(
  envelope: AudienceStatsEnvelope | null,
  goalPresent: boolean,
): { rollup: AudiencesRollup; best: BestAudience | null } {
  if (!envelope || envelope.audiences.length === 0) {
    return { rollup: { count: 0, totalSize: 0, totalRemaining: 0, pctUsed: null }, best: null };
  }
  let totalSize = 0;
  let totalContacted = 0;
  let totalRemaining = 0;
  for (const row of envelope.audiences) {
    const size = row.evidence.memberCount;
    const contacted = row.evidence.contacted;
    totalSize += size;
    totalContacted += contacted;
    totalRemaining += Math.max(size - contacted, 0);
  }
  const rollup: AudiencesRollup = {
    count: envelope.audiences.length,
    totalSize,
    totalRemaining,
    pctUsed: totalSize > 0 ? (totalContacted / totalSize) * 100 : null,
  };

  // Best = the first row (envelope.audiences is sorted ascending by the goal's sort metric). Only
  // meaningful with a real goal to rank on; a placeholder goal (used only to fetch the rollup) → no best.
  let best: BestAudience | null = null;
  if (goalPresent) {
    const top = envelope.audiences[0];
    const cents = envelope.sortMetric === "cpc" ? top.metrics.cpcCents : top.metrics.cpprCents;
    const size = top.evidence.memberCount;
    const remaining = Math.max(size - top.evidence.contacted, 0);
    best = {
      audienceId: top.audienceId,
      name: top.audience.name,
      cacUsd: cents != null ? cents / 100 : null,
      size,
      remaining,
      pctRemaining: size > 0 ? (remaining / size) * 100 : null,
    };
  }
  return { rollup, best };
}

/** Pick the single best workflow (lowest positive projected cost per outcome) + its name + grain. */
function pickBestWorkflow(projection: WorkflowProjectionResponse): BestWorkflow | null {
  let best: WorkflowProjectionResponse["rows"][number] | null = null;
  for (const row of projection.rows) {
    const metric = row.resolved.costPerOutcomeUsd;
    if (metric == null || metric <= 0) continue;
    const current = best?.resolved.costPerOutcomeUsd ?? null;
    if (current == null || metric < current) best = row;
  }
  if (!best || best.resolved.costPerOutcomeUsd == null) return null;
  return {
    workflowDynastySlug: best.workflow.workflowDynastySlug,
    name: best.workflow.workflowDynastyName,
    cacUsd: best.resolved.costPerOutcomeUsd,
    grain: best.resolved.grain,
  };
}

/**
 * Compose the health badge (owned thresholds):
 *   red    — not active (paused / inactive / no budget). Value can't be assessed while campaigns are held/stopped.
 *   green  — active AND ROI ≥ 1 (CAC below breakeven, known) AND audience NOT near-exhausted.
 *   yellow — active but ROI < 1 (or unknown) OR the audience is near-exhausted.
 */
function composeHealth(
  status: AccountStatus,
  hasBudget: boolean,
  roiMultiple: number | null,
  audiencePctUsed: number | null,
): { badge: HealthBadge; inputs: HealthInputs } {
  const active = status === "active";
  const roiHealthy = roiMultiple != null && roiMultiple >= 1;
  const audienceNearExhausted = audiencePctUsed != null && audiencePctUsed >= AUDIENCE_NEAR_EXHAUSTED_PCT;
  const badge: HealthBadge = !active ? "red" : roiHealthy && !audienceNearExhausted ? "green" : "yellow";
  return {
    badge,
    inputs: {
      active,
      hasBudget,
      roiMultiple,
      roiHealthy,
      audiencePctUsed,
      audienceNearExhausted,
      audienceNearExhaustedThresholdPct: AUDIENCE_NEAR_EXHAUSTED_PCT,
    },
  };
}

const STATUS_RANK: Record<AccountStatus, number> = { active: 0, paused: 1, inactive: 2 };

/**
 * Build the full customer-health board. Reuses the accounts audit (identity + status + budget + balance)
 * and the per-org active history (recency + retention), then enriches each (org, brand) with economics,
 * observed conversions, realized ROI, audience rollup + best audience, and best workflow — capped fan-out,
 * fail loud (BrandOwnershipError is the one documented per-pair skip → nulled enrichment, row still listed).
 */
export async function buildCustomerHealthBoard(
  coldEmailSlugsCsv: string,
  now: Date = new Date(),
  deps: CustomerHealthDeps = REAL_DEPS,
): Promise<CustomerHealthBoard> {
  // 1. Universe + reused fleet composites (accounts audit, per-org active history) + the EXACT feature per
  //    (org, brand). fetchFeatureMemberships returns {orgId, brandId, workflowSlug} WITHOUT the feature, so
  //    to know which cold feature a pair belongs to we enumerate ONE call per cold slug (there are ~5) and
  //    tag each pair with the slug it matched — the feature drives the funnel + the feature-scoped cost reads.
  const coldSlugs = coldEmailSlugsCsv ? coldEmailSlugsCsv.split(",").filter((s) => s.length > 0).sort() : [];
  const [audit, byUser, membershipsBySlug, dashboardReturns] = await Promise.all([
    deps.accountsAudit(coldEmailSlugsCsv, now),
    deps.activeUsersByUser(coldEmailSlugsCsv, now),
    mapWithConcurrency(coldSlugs, CUSTOMER_FANOUT_CONCURRENCY, async (slug): Promise<{ slug: string; memberships: FeatureMembership[] }> => ({
      slug,
      memberships: await deps.featureMemberships(slug),
    })),
    // Dashboard-return signal is DISPLAY ENRICHMENT — one fleet-wide PostHog read, fail-SOFT: a PostHog
    // blip / missing config degrades `dashboardReturnFrequency` to null on EVERY row (never a fabricated
    // count, never a 502), exactly like the /revenue conversion-count tiles + sequences series.
    deps.dashboardReturns(now).catch((error): Map<string, DashboardReturnSignal> | null => {
      console.warn(
        `[features-service] customer-health dashboard-return enrichment failed (degrading to null): ${(error as Error).message}`,
      );
      return null;
    }),
  ]);

  const recencyByOrg = new Map<string, ActiveUserRow>(byUser.users.map((u) => [u.orgId, u]));

  // Exact cold-email feature per (org, brand) — first sorted slug the pair appears under wins (deterministic).
  const pairFeature = new Map<string, string>();
  for (const { slug, memberships } of membershipsBySlug) {
    for (const m of memberships) {
      const key = `${m.orgId}::${m.brandId}`;
      if (!pairFeature.has(key)) pairFeature.set(key, slug);
    }
  }

  // 2. Enrich each account row (the (org, brand) universe) with capped concurrency.
  const rows = await mapWithConcurrency(audit.rows, CUSTOMER_FANOUT_CONCURRENCY, async (account): Promise<CustomerHealthRow> => {
    const pairKey = `${account.orgId}::${account.brandId}`;
    // Exact feature the pair belongs to (from the per-slug membership enumeration). Absent only for a pair
    // with no cold-email membership (should not happen — the accounts universe IS the membership universe).
    const featureSlug = pairFeature.get(pairKey) ?? null;
    const recency = recencyByOrg.get(account.orgId) ?? null;

    let economics: SalesEconomics | null = null;
    let goal: Goal | null = null;
    let conversionCounts: ConversionCounts = { signup: 0, meeting_booked: 0, form_submission: 0, purchase: 0 };
    let currentEconomics: CurrentEconomics = {
      realizedSpendUsd: null,
      expectedPipelineUsd: null,
      currentCacUsd: null,
      roiMultiple: null,
      cacPct: null,
    };
    let audienceEnvelope: AudienceStatsEnvelope | null = null;
    let workflowProjection: WorkflowProjectionResponse | null = null;
    let ownershipSkipped = false;

    try {
      // Light reads first: goal + economics (brand-scoped, org-less) and observed conversion counts.
      const [saved, counts] = await Promise.all([
        deps.savedEconomicsWithGoal(account.brandId),
        deps.conversionCounts(account.brandId),
      ]);
      economics = saved.economics;
      goal = saved.goal;
      conversionCounts = counts;

      if (featureSlug) {
        // Audience rollup is goal-independent (evidence is); a placeholder goal only sets the sort metric,
        // and best-audience is nulled when there is no real goal (see summarizeAudiences).
        const goalForAudience: Goal = goal ?? "websiteVisit";
        const [audienceRes, revenueRes, workflowRes] = await Promise.all([
          deps.audienceStats(featureSlug, account.brandId, account.orgId, goalForAudience),
          // Realized ROI only with the brand's OWN economics (else pipeline would be a cross-brand average).
          economics ? deps.brandRevenue(featureSlug, account.brandId, account.orgId, economics) : Promise.resolve<BrandRevenueResult | null>(null),
          // Best workflow needs a real goal (it selects the objective's cost).
          goal ? deps.workflowProjection(featureSlug, account.brandId, account.orgId, goal) : Promise.resolve<WorkflowProjectionResponse | null>(null),
        ]);
        audienceEnvelope = audienceRes;
        workflowProjection = workflowRes;

        if (revenueRes && economics) {
          const ltr = economics.lifetimeRevenueUsd;
          const currentCacUsd = revenueRes.cacPct != null ? (revenueRes.cacPct / 100) * ltr : null;
          currentEconomics = {
            realizedSpendUsd: revenueRes.actualCostUsd,
            expectedPipelineUsd: revenueRes.expectedPipelineUsd,
            currentCacUsd,
            roiMultiple: revenueRes.roiMultiple,
            cacPct: revenueRes.cacPct,
          };
        }
      }
    } catch (error) {
      if (error instanceof BrandOwnershipError) {
        // Stale feature-membership: the forwarded org does not actually own this brand. Skip enrichment,
        // still list the row's identity + status (mirrors handlePublicRevenue). Not a silent fallback.
        ownershipSkipped = true;
      } else {
        // Per-row FAIL-SOFT. A SINGLE customer's enrichment failing — a cold downstream composite that
        // exhausted its transient retries (the fetch-retry layer already backs off ECONNRESET / "timeout
        // exceeded when trying to connect"), a real downstream 5xx, or an audience/revenue/workflow
        // compute throw for one brand — MUST NOT 500 the WHOLE fleet board. Degrade THIS row to its
        // identity + status + whatever enrichment resolved before the throw (all other enrichment vars
        // stay at their null/default init above), loud in the logs. Mirrors the PostHog degrade-to-null
        // and the BrandOwnershipError skip already in this file, and PR #248 ("one upstream stat family
        // failure no longer zeros the others") applied at the ROW grain. The step-1 universe composites
        // (accounts audit, active history, memberships) stay OUTSIDE this loop and fail loud — a missing
        // universe is a real 500, not a degraded row.
        console.error(
          `[features-service] customer-health row degraded (org=${account.orgId} brand=${account.brandId}): ${(error as Error).message}`,
        );
      }
    }

    const ltrUsd = economics?.lifetimeRevenueUsd ?? null;
    const { rollup: audiencesRollup, best: bestAudience } = summarizeAudiences(audienceEnvelope, goal !== null);
    const bestWorkflow = workflowProjection ? pickBestWorkflow(workflowProjection) : null;

    const needed = goal != null && TRACKER_NEEDED_GOALS.has(goal);
    const observedConversions = observedConversionsForGoal(goal, conversionCounts);
    const conversionTracker: ConversionTracker = {
      needed,
      observedConversions,
      firing: needed ? (observedConversions != null ? observedConversions > 0 : null) : null,
      inferred: true,
    };

    const hasBudget = account.dailyBudgetUsd != null && account.dailyBudgetUsd > 0;
    const health = composeHealth(account.status, hasBudget, currentEconomics.roiMultiple, audiencesRollup.pctUsed);

    void ownershipSkipped; // enrichment already nulled above; retained for readability of the skip path

    return {
      orgId: account.orgId,
      orgExternalId: account.orgExternalId,
      ownerEmail: account.ownerEmail,
      brandId: account.brandId,
      brandName: account.brandName,
      brandDomain: account.brandDomain,
      featureSlug,
      firstActiveDay: recency?.firstActiveDay ?? null,
      lastActiveDay: recency?.lastActiveDay ?? null,
      retentionWeeks: recency?.retentionWeeks ?? null,
      activeThisWeek: recency?.activeThisWeek ?? false,
      activeThisMonth: recency?.activeThisMonth ?? false,
      activeDays: recency?.activeDays ?? [],
      status: account.status,
      dailyBudgetUsd: account.dailyBudgetUsd,
      orgBalanceUsd: account.orgBalanceUsd,
      orgActualBalanceUsd: account.orgActualBalanceUsd,
      autoTopupEnabled: account.autoTopupEnabled,
      optimizationGoal: goal,
      conversionTracker,
      breakevenCacUsd: ltrUsd,
      ltrUsd,
      economics,
      currentEconomics,
      audiences: audiencesRollup,
      bestAudience,
      bestWorkflow,
      health,
      notTrackedYet: {
        // Per-org signal, joined on the Clerk org id (orgExternalId). null when PostHog degraded (map is
        // null), the org has no external id, or the org had no dashboard activity in the window.
        dashboardReturnFrequency:
          (account.orgExternalId && dashboardReturns?.get(account.orgExternalId)) || null,
        budgetChangeHistory: null,
        pauseHistory: null,
      },
    };
  });

  // 3. Sort: currently-active first, then most-recently-active (null last), then longest retention, tiebreak brandId.
  rows.sort((a, b) => {
    if (a.status !== b.status) return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    const al = a.lastActiveDay ?? "";
    const bl = b.lastActiveDay ?? "";
    if (al !== bl) return al < bl ? 1 : -1; // desc, "" (never active) sorts last
    const ar = a.retentionWeeks ?? -1;
    const br = b.retentionWeeks ?? -1;
    if (ar !== br) return br - ar;
    return a.brandId.localeCompare(b.brandId);
  });

  // 4. Fleet stats.
  let activeCount = 0;
  let pausedCount = 0;
  let greenCount = 0;
  let yellowCount = 0;
  let redCount = 0;
  for (const row of rows) {
    if (row.status === "active") activeCount += 1;
    else if (row.status === "paused") pausedCount += 1;
    if (row.health.badge === "green") greenCount += 1;
    else if (row.health.badge === "yellow") yellowCount += 1;
    else redCount += 1;
  }

  return {
    customers: rows,
    stats: {
      totalCustomers: rows.length,
      activeCount,
      pausedCount,
      inactiveCount: rows.length - activeCount - pausedCount,
      greenCount,
      yellowCount,
      redCount,
    },
    asOf: now.toISOString(),
  };
}
