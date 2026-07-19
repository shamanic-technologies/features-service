import type { Request } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { fetchCurrentBrandProfile } from "./brand-client.js";
import { fetchAudiencesByStatuses, fetchAudienceMemberEmails, type Audience, type AudienceFilters, type AudienceStatus } from "./human-client.js";
import { fetchEmailOutcomes } from "./email-status-client.js";
import { observedCostPerOutcome, projectedCostPerOutcome } from "./cost-engine.js";
import { fetchConversionEmails } from "./conversion-emails-client.js";
import { isExtendedGoal, matchSingleStepGoal, matchFormSubmissionGoal, matchWhatsappGoal, matchCombinedSalesGoal, matchWebsitePurchaseGoal, type ExtendedGoal } from "./goals.js";
import { selectCostCents, type Pricing } from "./pricing.js";

export type SortMetric = "cpc" | "cppr";

interface AudienceCostEvidence {
  totalCostInUsdCents: number;
  completedRuns: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
}

interface AudienceOutcomeEvidence {
  // Distinct MEMBER count of the audience (people served under it — human-service membership provenance).
  // The audience's addressable pool size; `contacted` ⊆ this. Lets a consumer derive remaining-to-contact
  // (memberCount − contacted) + %used (contacted / memberCount) without a second human-service fetch — the
  // member emails are ALREADY fetched here for the outcome join, so this is free. 0 when the audience has
  // no members.
  memberCount: number;
  contacted: number;
  opened: number;
  websiteClicks: number;
  positiveReplies: number;
  // REAL per-audience form-submission conversions (lead-service conversion tracker), attributed by
  // intersecting the audience's member emails with the brand's matched-lead conversion emails — the
  // SAME membership join used for clicks/replies. Present ONLY for the form_submissions goal (the only
  // surface that renders it); ABSENT (undefined) otherwise, and absent when lead-service didn't serve
  // the conversion emails (a fake 0 would fabricate a false cost-per-form-submission). Never scoped by
  // brand-profile; a conversion is attributed to whichever audience produced the matched lead.
  formSubmissions?: number;
  // REAL per-audience signup conversions — the exact form-submission mechanism above, for event=signup,
  // gated to the signup goal. Attributed by member-email ∩ matched-lead signup-converted emails
  // (lead-service conversion tracker), never a split of a brand total. Present ONLY for the signup goal;
  // ABSENT otherwise and when lead-service didn't serve the signup emails (never a fabricated 0).
  signups?: number;
  // REAL per-audience SALES — paying clients won (lead-service conversion tracker, event="sale", RENAMED
  // from "purchase") — the exact form-submission/signup mechanism, attributed by member-email ∩
  // matched-lead sale-converted emails (never a split of the brand total). Present ONLY for the
  // website-purchase OR combined-sales goals (both terminate in a `sale`); ABSENT otherwise and when
  // lead-service didn't serve the sale emails (never a fabricated 0).
  sales?: number;
}

/**
 * Row shape for the audience-stats endpoint: ranked human-service audiences with their
 * attributed cost + outcome evidence and the derived CPC/CPPR metrics.
 */
export interface AudienceStatsRow {
  audienceId: string;
  brandProfileId: string | null;
  audience: {
    id: string;
    name: string;
    status: Audience["status"];
    filters: AudienceFilters | null;
  };
  evidence: AudienceCostEvidence & AudienceOutcomeEvidence;
  metrics: {
    cpcCents: number | null;
    cpprCents: number | null;
    // REAL cost per form submission = audience-scoped spend / formSubmissions. OBSERVED (accounting —
    // real spend ÷ real tracked conversions): null when 0 form submissions OR 0 attributed spend (never
    // a false $0.00), and null (not present) for any goal other than form_submissions or when the
    // conversion emails weren't served. Not part of the ranking (form_submissions ranks on cpc).
    cpfsCents: number | null;
    // REAL cost per signup = audience-scoped spend / signups. OBSERVED (accounting — real spend ÷ real
    // tracked conversions): null when 0 signups OR 0 attributed spend (never a false $0.00), and null for
    // any goal other than signup or when the signup conversion emails weren't served. Not part of the
    // ranking (signup ranks on cpc, visit-driven).
    cpsCents: number | null;
    // REAL cost per sale = audience-scoped spend / sales. OBSERVED (accounting): null when 0 sales OR 0
    // attributed spend (never a false $0.00), and null for any goal other than websitePurchase / sales or
    // when the sale conversion emails weren't served. Not part of the ranking (both goals rank on cppr).
    cpsaleCents: number | null;
  };
}

export interface AudienceStatsEnvelope {
  featureSlug: string;
  brandId: string;
  goal: ExtendedGoal;
  brandProfileId: string | null;
  sortMetric: SortMetric;
  audiences: AudienceStatsRow[];
}

export type ComputeResult =
  | { ok: false; status: number; error: string }
  | { ok: true; envelope: AudienceStatsEnvelope };

function buildHeaders(
  apiKey: string,
  orgId: string,
  identity: { userId?: string; runId?: string; brandId?: string; campaignId?: string; featureSlug?: string },
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": orgId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;
  return headers;
}

function audienceIdFromDimensions(dimensions: Record<string, string | null> | undefined): string | null {
  const id = dimensions?.audienceId;
  return id && id !== "__total__" ? id : null;
}

function emptyCost(): AudienceCostEvidence {
  return { totalCostInUsdCents: 0, completedRuns: 0, firstRunAt: null, lastRunAt: null };
}

function emptyOutcomes(): AudienceOutcomeEvidence {
  return { memberCount: 0, contacted: 0, opened: 0, websiteClicks: 0, positiveReplies: 0 };
}

/**
 * Fetch the brand's matched-lead form-submission conversion emails, degrading to null (per-audience
 * form-submission column ABSENT) on any failure — display enrichment, like the /revenue conversion-count
 * tiles, so a pre-rollout / down lead-service never 502s the ranking. The client itself is fail-loud;
 * this wrapper decides the degradation. Absent ≠ 0: a fake 0 would fabricate a false cost-per-form-submission.
 */
function fetchFormSubmissionEmailsSoft(brandId: string): Promise<Set<string> | null> {
  return fetchConversionEmails(brandId, "form_submission").catch((err) => {
    console.warn(
      `[features-service] conversion-emails enrichment failed (degrading per-audience form submissions to absent): ${(err as Error).message}`,
    );
    return null;
  });
}

/**
 * Fetch the brand's matched-lead SIGNUP conversion emails — the exact fetchFormSubmissionEmailsSoft
 * mechanism, for event=signup — degrading to null (per-audience signup column ABSENT) on any failure.
 * Display enrichment (like the /revenue conversion-count tiles) so a pre-rollout / down lead-service
 * never 502s the ranking. Absent ≠ 0: a fake 0 would fabricate a false cost-per-signup.
 */
function fetchSignupEmailsSoft(brandId: string): Promise<Set<string> | null> {
  return fetchConversionEmails(brandId, "signup").catch((err) => {
    console.warn(
      `[features-service] conversion-emails enrichment failed (degrading per-audience signups to absent): ${(err as Error).message}`,
    );
    return null;
  });
}

/**
 * Fetch the brand's matched-lead SALE conversion emails (event="sale", RENAMED from "purchase") — the
 * exact fetchSignupEmailsSoft mechanism — degrading to null (per-audience sale column ABSENT) on any
 * failure. Display enrichment, so a pre-rollout / down lead-service never 502s the ranking. Absent ≠ 0:
 * a fake 0 would fabricate a false cost-per-sale. Serves BOTH the website-purchase and combined-sales
 * goals (both terminate in a `sale`).
 */
function fetchSaleEmailsSoft(brandId: string): Promise<Set<string> | null> {
  return fetchConversionEmails(brandId, "sale").catch((err) => {
    console.warn(
      `[features-service] conversion-emails enrichment failed (degrading per-audience sales to absent): ${(err as Error).message}`,
    );
    return null;
  });
}

function readFiniteNumber(value: unknown, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw new Error(`Invalid audience stats number: ${field}`);
  }
  return parsed;
}

function sortMetricForGoal(goal: ExtendedGoal): SortMetric {
  // signup + websiteVisit + formSubmission + whatsappConversation rank on cost-per-click/visit (the
  // click IS the outcome — all four are click-driven; for whatsappConversation the click on the
  // WhatsApp link IS a started conversation); meetingBooked / purchase / positiveReply / websitePurchase /
  // sales rank on cost-per-positive-reply (reply-inclusive close/combined goals).
  return goal === "signup" || goal === "websiteVisit" || goal === "formSubmission" || goal === "whatsappConversation"
    ? "cpc"
    : "cppr";
}

const VALID_STATUSES: readonly AudienceStatus[] = ["active", "paused", "archived"];

/**
 * Parse the optional `statuses` query param (comma-separated subset of
 * active,paused,archived). Absent → ["active"] (preserves the historical active-only
 * behavior for every existing caller, incl. the brand-overview Top-audiences card).
 * Any token outside the valid set (e.g. suggested/deprecated) → 400.
 */
function parseStatuses(raw: string | undefined): { ok: true; statuses: AudienceStatus[] } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, statuses: ["active"] };
  }
  const tokens = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (tokens.length === 0) {
    return { ok: false, error: "statuses query parameter must be a non-empty comma-separated subset of: active, paused, archived" };
  }
  const seen = new Set<AudienceStatus>();
  for (const token of tokens) {
    if (!VALID_STATUSES.includes(token as AudienceStatus)) {
      return { ok: false, error: "statuses query parameter must be a comma-separated subset of: active, paused, archived" };
    }
    seen.add(token as AudienceStatus);
  }
  return { ok: true, statuses: [...seen] };
}

function compareByMetric(metric: SortMetric, a: AudienceStatsRow, b: AudienceStatsRow): number {
  const av = metric === "cpc" ? a.metrics.cpcCents : a.metrics.cpprCents;
  const bv = metric === "cpc" ? b.metrics.cpcCents : b.metrics.cpprCents;
  if (av === null && bv === null) return a.audienceId.localeCompare(b.audienceId);
  if (av === null) return 1;
  if (bv === null) return -1;
  if (av !== bv) return av - bv;
  return a.audienceId.localeCompare(b.audienceId);
}

async function fetchAudienceCosts(
  brandId: string,
  featureSlug: string,
  identity: { orgId: string; userId?: string; runId?: string; campaignId?: string; featureSlug?: string },
  // NET pricing: read runs#179's FROZEN per-audience net cost cents (netTotalCostInUsdCents) instead of
  // the gross field (no read-time multiply). GROSS (the default) reads the gross field → byte-identical.
  // Every per-audience cpc/cppr/cpfs + the brand-parent cascade derives from these cents, so the whole
  // ranking comes out net + coherent by construction.
  pricing: Pricing = "gross",
  // Optional CAMPAIGN scope: when present, add a runs `campaignId` filter so the cost numerator counts
  // only spend tagged to that campaign (still grouped by audienceId). Omitted → brand-wide (byte-identical).
  scopeCampaignId?: string,
): Promise<Map<string, AudienceCostEvidence>> {
  const baseUrl = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  }

  // Cost is EXACT via the audienceId write-tag (one workflow execution = one priority audience).
  // We do NOT filter the cost NUMERATOR by goal/brandProfileId: a campaign's spend to reach an
  // audience is not partitioned by goal (goal only selects the DENOMINATOR/sort-metric — clicks vs
  // replies), and runs/cost rows are not tagged with goal/brandProfileId today, so filtering on
  // them would drop every real cost row → false $0.00 CPC.
  const params = new URLSearchParams({
    groupBy: "audienceId",
    brandId,
    featureSlugs: featureSlug,
  });
  // Campaign scope narrows the numerator to spend tagged to this campaign (runs supports a campaignId
  // filter alongside groupBy=audienceId). brandId stays so the query remains brand-bounded.
  if (scopeCampaignId) params.set("campaignId", scopeCampaignId);

  const response = await fetchWithRetry(`${baseUrl}/v1/stats/costs?${params}`, {
    headers: buildHeaders(apiKey, identity.orgId, { ...identity, brandId }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`runs-service audience costs failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    groups?: Array<{
      dimensions?: Record<string, string | null>;
      totalCostInUsdCents: string;
      // Frozen-NET twin (runs#179) — read via selectCostCents when pricing === "net".
      netTotalCostInUsdCents?: string;
      runCount: number;
      minStartedAt: string | null;
      maxStartedAt: string | null;
    }>;
  };
  if (!Array.isArray(data.groups)) {
    throw new Error("runs-service audience costs returned no groups array");
  }

  const result = new Map<string, AudienceCostEvidence>();
  for (const group of data.groups) {
    const audienceId = audienceIdFromDimensions(group.dimensions);
    if (!audienceId) continue;
    result.set(audienceId, {
      totalCostInUsdCents: Math.round(selectCostCents(group, "totalCostInUsdCents", pricing)),
      completedRuns: readFiniteNumber(group.runCount, "runCount"),
      firstRunAt: group.minStartedAt ?? null,
      lastRunAt: group.maxStartedAt ?? null,
    });
  }
  return result;
}

/**
 * Per-audience outcome evidence, resolved READ-TIME from explicit membership (no send-tagging).
 *
 * For each active audience: human-service gives its canonical member emails (people served under
 * it — provenance, human-service#42); email-gateway gives each email's brand-scoped broadcast
 * outcome flags. We aggregate per audience: contacted / opened / clicked / positiveReply member counts.
 * An email in multiple audiences contributes to each (audiences overlap; the per-audience numbers
 * rank candidates, they do NOT partition the brand total). Outcomes are recipient engagement, so
 * they are NOT scoped by goal / brand-profile (only the COST is — via runs attribution).
 */
async function fetchAudienceOutcomes(
  brandId: string,
  audiences: Audience[],
  identity: { orgId: string; userId?: string; runId?: string; campaignId?: string; featureSlug?: string },
  // The brand's matched-lead form-submission conversion emails (lowercased), for the per-audience
  // form-submission count via membership intersection. null when NOT the form_submissions goal, or when
  // lead-service didn't serve them → each audience's formSubmissions stays ABSENT (never a false 0).
  formSubmissionEmails: Set<string> | null = null,
  // The brand's matched-lead SIGNUP conversion emails (lowercased), for the per-audience signup count —
  // same intersection as form submissions. null when NOT the signup goal, or when lead-service didn't
  // serve them → each audience's signups stays ABSENT (never a false 0).
  signupEmails: Set<string> | null = null,
  // The brand's matched-lead SALE conversion emails (lowercased), for the per-audience sale count — same
  // intersection as signups/form submissions. null when NOT a sale-terminating goal (website-purchase /
  // combined-sales), or when lead-service didn't serve them → each audience's sales stays ABSENT.
  saleEmails: Set<string> | null = null,
  // Optional CAMPAIGN scope: when present, the email-gateway outcome flags are read from the campaign
  // scope (only this campaign's contacted/opened/clicked/replied), not the brand aggregate. Audience
  // MEMBERSHIP stays brand-wide (audiences are brand-scoped); only the OUTCOME numerator narrows.
  // Omitted → brand-wide (byte-identical).
  scopeCampaignId?: string,
): Promise<{ perAudience: Map<string, AudienceOutcomeEvidence>; brandGrain: AudienceOutcomeEvidence }> {
  const perAudience = await Promise.all(
    audiences.map(async (a) => ({ audienceId: a.id, emails: await fetchAudienceMemberEmails(a.id, identity) })),
  );

  const allEmails = [...new Set(perAudience.flatMap((p) => p.emails))];
  const outcomesByEmail = await fetchEmailOutcomes(brandId, allEmails, identity, scopeCampaignId);

  const result = new Map<string, AudienceOutcomeEvidence>();
  for (const { audienceId, emails } of perAudience) {
    const agg = emptyOutcomes();
    // Addressable pool size = distinct member emails served under the audience (contacted ⊆ this).
    agg.memberCount = new Set(emails).size;
    // DISTINCT-member conversion tally: count each member email at most once (mirrors the
    // clicked/replied member-grain counts). Only when we have the conversion-email set.
    let formSubmissions = formSubmissionEmails ? 0 : undefined;
    let signups = signupEmails ? 0 : undefined;
    let sales = saleEmails ? 0 : undefined;
    const seenSubmitters = new Set<string>();
    const seenSignups = new Set<string>();
    const seenSales = new Set<string>();
    for (const email of emails) {
      const o = outcomesByEmail.get(email);
      if (o) {
        if (o.contacted) agg.contacted += 1;
        if (o.opened) agg.opened += 1;
        if (o.clicked) agg.websiteClicks += 1;
        if (o.positiveReply) agg.positiveReplies += 1;
      }
      const key = email.trim().toLowerCase();
      if (formSubmissionEmails) {
        if (formSubmissionEmails.has(key) && !seenSubmitters.has(key)) {
          seenSubmitters.add(key);
          formSubmissions = (formSubmissions ?? 0) + 1;
        }
      }
      if (signupEmails) {
        if (signupEmails.has(key) && !seenSignups.has(key)) {
          seenSignups.add(key);
          signups = (signups ?? 0) + 1;
        }
      }
      if (saleEmails) {
        if (saleEmails.has(key) && !seenSales.has(key)) {
          seenSales.add(key);
          sales = (sales ?? 0) + 1;
        }
      }
    }
    if (formSubmissions !== undefined) agg.formSubmissions = formSubmissions;
    if (signups !== undefined) agg.signups = signups;
    if (sales !== undefined) agg.sales = sales;
    result.set(audienceId, agg);
  }

  // Brand-grain aggregate = DISTINCT union members (allEmails is already deduped), SAME membership-based
  // definition as the per-audience counts (no grain mix). Serves as the PARENT for the projected cascade:
  // an audience with 0 observed outcomes floors to the brand's cost-per-outcome (audience → brand).
  const brandGrain = emptyOutcomes();
  for (const email of allEmails) {
    const o = outcomesByEmail.get(email);
    if (!o) continue;
    if (o.contacted) brandGrain.contacted += 1;
    if (o.opened) brandGrain.opened += 1;
    if (o.clicked) brandGrain.websiteClicks += 1;
    if (o.positiveReply) brandGrain.positiveReplies += 1;
  }

  return { perAudience: result, brandGrain };
}

/**
 * Compute for the audience-stats endpoint.
 * Validates the request (400s as `ok:false`), looks up the feature (404 as `ok:false`), and
 * fans out to runs-service (cost) + human-service/email-gateway (outcomes) to build ranked rows.
 * Downstream failures THROW — the route maps them to 502.
 */
export async function computeAudienceStats(req: Request, pricing: Pricing = "gross"): Promise<ComputeResult> {
  const { featureSlug } = req.params;
  const { orgId, userId, runId, campaignId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;
  const brandId = req.query.brandId as string | undefined;
  const goalParam = req.query.goal as string | undefined;
  const explicitBrandProfileId = req.query.brandProfileId as string | undefined;
  const limitParam = req.query.limit as string | undefined;
  const statusesParam = req.query.statuses as string | undefined;
  // Optional single-campaign scope for the STATS (audiences themselves stay brand-wide). Absent →
  // brand-wide numbers, byte-identical to today. Present → cost + outcome numerators narrow to this
  // campaign (runs campaignId filter + email-gateway campaign scope).
  const scopeCampaignId = (req.query.campaignId as string | undefined)?.trim() || undefined;

  if (!brandId) {
    return { ok: false, status: 400, error: "brandId query parameter is required" };
  }
  // Normalise the single-step + form-submission + whatsapp goal fleet spellings (snake/kebab/display →
  // canonical camel) before validating.
  const normalizedGoal = goalParam
    ? (matchSingleStepGoal(goalParam) ??
       matchFormSubmissionGoal(goalParam) ??
       matchWhatsappGoal(goalParam) ??
       matchCombinedSalesGoal(goalParam) ??
       matchWebsitePurchaseGoal(goalParam) ??
       goalParam)
    : undefined;
  if (!isExtendedGoal(normalizedGoal)) {
    return { ok: false, status: 400, error: "goal query parameter is required and must be one of: signup, meetingBooked, websitePurchase, sales, websiteVisit, positiveReply, formSubmission, whatsappConversation" };
  }

  const parsedStatuses = parseStatuses(statusesParam);
  if (!parsedStatuses.ok) {
    return { ok: false, status: 400, error: parsedStatuses.error };
  }

  let parsedLimit: number | undefined;
  if (limitParam) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { ok: false, status: 400, error: "limit query parameter must be a positive integer" };
    }
    parsedLimit = parsed;
  }

  const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
  if (!feature) {
    return { ok: false, status: 404, error: "Feature not found" };
  }

  const identity = { orgId, userId, runId, campaignId, featureSlug: headerFeatureSlug };
  const [audiences, currentProfile] = await Promise.all([
    fetchAudiencesByStatuses(brandId, parsedStatuses.statuses, identity),
    explicitBrandProfileId ? Promise.resolve(null) : fetchCurrentBrandProfile(brandId, identity),
  ]);
  const brandProfileId = explicitBrandProfileId ?? currentProfile?.id ?? null;

  // Per-audience form-submission attribution is fetched ONLY for the form_submissions goal (the only
  // surface that renders it), so the hot ranking path for every other goal keeps its exact fan-out and
  // never depends on the conversion tracker. Fail-soft → null → the column is absent, never a false 0.
  const formSubmissionEmails =
    normalizedGoal === "formSubmission" ? await fetchFormSubmissionEmailsSoft(brandId) : null;
  // Per-audience signup attribution — the SAME conversion-tracker mechanism as form submissions, fetched
  // ONLY for the signup goal, so every other goal's hot path is untouched. Fail-soft → null → the signup
  // column is absent, never a false 0.
  const signupEmails = normalizedGoal === "signup" ? await fetchSignupEmailsSoft(brandId) : null;
  // Per-audience SALE attribution — the SAME conversion-tracker mechanism, fetched ONLY for the two
  // sale-terminating goals (website-purchase = multi-step close, sales = combined). Fail-soft → null →
  // the sale column is absent, never a false 0. Every other goal's hot path is untouched.
  const saleEmails =
    normalizedGoal === "websitePurchase" || normalizedGoal === "sales" ? await fetchSaleEmailsSoft(brandId) : null;

  const [costs, outcomesResult] = await Promise.all([
    fetchAudienceCosts(brandId, featureSlug, identity, pricing, scopeCampaignId),
    fetchAudienceOutcomes(brandId, audiences, identity, formSubmissionEmails, signupEmails, saleEmails, scopeCampaignId),
  ]);
  const outcomes = outcomesResult.perAudience;

  // Brand-grain PARENT cost-per-outcome for the projected cascade (audience → brand). Numerator = the
  // brand's total audience-tagged cost (runs are tagged to ONE audience, so summing does not double-count);
  // denominator = the brand-grain DISTINCT-union outcome counts. observed (real ratio, null when the brand
  // has no clicks/replies → then the audience metric falls back to observed null, never a false $0).
  const brandTotalCostCents = [...costs.values()].reduce((sum, c) => sum + c.totalCostInUsdCents, 0);
  const brandParentCpc = observedCostPerOutcome(brandTotalCostCents, outcomesResult.brandGrain.websiteClicks);
  const brandParentCppr = observedCostPerOutcome(brandTotalCostCents, outcomesResult.brandGrain.positiveReplies);

  const audienceMap = new Map(audiences.map((audience) => [audience.id, audience]));
  const ids = new Set([...costs.keys(), ...outcomes.keys()]);
  const rows: AudienceStatsRow[] = [];

  for (const audienceId of ids) {
    const audience = audienceMap.get(audienceId);
    if (!audience) continue;

    const cost = costs.get(audienceId) ?? emptyCost();
    const outcome = outcomes.get(audienceId) ?? emptyOutcomes();
    rows.push({
      audienceId,
      brandProfileId,
      audience: {
        id: audienceId,
        name: audience.name,
        status: audience.status,
        filters: audience.filters,
      },
      evidence: {
        ...cost,
        ...outcome,
      },
      // PROJECTED engine (default): a real ratio when the audience has outcomes; else the cascade floor
      // max(audience cost, brand parent). When the brand has no parent (0 brand clicks/replies) → observed
      // (null, sorts last) rather than a false $0. An audience with outcomes is unchanged (parent ignored).
      metrics: {
        cpcCents:
          brandParentCpc != null
            ? projectedCostPerOutcome(cost.totalCostInUsdCents, outcome.websiteClicks, brandParentCpc)
            : observedCostPerOutcome(cost.totalCostInUsdCents, outcome.websiteClicks),
        cpprCents:
          brandParentCppr != null
            ? projectedCostPerOutcome(cost.totalCostInUsdCents, outcome.positiveReplies, brandParentCppr)
            : observedCostPerOutcome(cost.totalCostInUsdCents, outcome.positiveReplies),
        // OBSERVED (accounting): audience spend ÷ its real form submissions. null when the count is
        // absent (not the form_submissions goal / emails not served) OR 0 (no denominator / no attributed
        // spend) — never a false $0.00. Not used in ranking (form_submissions sorts on cpc).
        cpfsCents:
          outcome.formSubmissions !== undefined
            ? observedCostPerOutcome(cost.totalCostInUsdCents, outcome.formSubmissions)
            : null,
        // OBSERVED (accounting): audience spend ÷ its real signups. null when the count is absent (not the
        // signup goal / emails not served) OR 0 (no denominator / no attributed spend) — never a false
        // $0.00. Not used in ranking (signup sorts on cpc).
        cpsCents:
          outcome.signups !== undefined
            ? observedCostPerOutcome(cost.totalCostInUsdCents, outcome.signups)
            : null,
        // OBSERVED (accounting): audience spend ÷ its real sales (paying clients). null when the count is
        // absent (not a sale-terminating goal / emails not served) OR 0 (no denominator / no attributed
        // spend) — never a false $0.00. Serves both website-purchase and combined-sales goals.
        cpsaleCents:
          outcome.sales !== undefined
            ? observedCostPerOutcome(cost.totalCostInUsdCents, outcome.sales)
            : null,
      },
    });
  }

  const sortMetric = sortMetricForGoal(normalizedGoal);
  rows.sort((a, b) => compareByMetric(sortMetric, a, b));
  const audiencesOut = parsedLimit !== undefined ? rows.slice(0, parsedLimit) : rows;

  return {
    ok: true,
    envelope: {
      featureSlug,
      brandId,
      goal: normalizedGoal,
      brandProfileId,
      sortMetric,
      audiences: audiencesOut,
    },
  };
}
