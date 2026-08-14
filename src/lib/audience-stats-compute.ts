import type { Request } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { fetchAudiencesByStatuses, fetchAudienceMemberEmails, type Audience, type AudienceFilters, type AudienceStatus } from "./human-client.js";
import { flooredCostPerOutcome, derivedCostPerOutcome } from "./cost-engine.js";
import {
  fetchBrandProjectedParents,
  fetchBrandProjectionEvidence,
  projectBrandParents,
  returnPerDollar,
  costOfAcquisitionPct,
  type BrandProjectedParentsUsd,
  type FunnelPricingReason,
} from "./audience-stats-brand-projection.js";
import { fetchConversionEmails } from "./conversion-emails-client.js";
import { isGoal, matchSingleStepGoal, matchFormSubmissionGoal, matchWhatsappGoal, matchCombinedSalesGoal, matchWebsitePurchaseGoal, type Goal } from "./goals.js";
import { matchSalesFunnelKey, salesFunnelIndex, SALES_FUNNEL_KEYS, SALES_FUNNEL_GOAL_ECHO, type SalesFunnelKey } from "./sales-funnels.js";
import { fetchDeclaredSalesFunnels } from "./sales-funnels-client.js";
import { declaredEconomicsForFunnel, declaredFunnelsToRank } from "./declared-funnels.js";
import { selectCostCents, type Pricing } from "./pricing.js";

/**
 * How the rows were ordered.
 *
 * `cpc` / `cppr` are the SINGLE-FUNNEL orders: the caller named the chain, so the rows sort on the cost
 * of that chain's driving outcome. `returnPerDollar` is the BRAND-LEVEL order, and it is the only honest
 * one there: at brand level there is no goal — the brand sells through every funnel it declared at once —
 * so the question the page asks is what each audience RETURNS, and cost per outcome cannot answer it
 * (it ranks by cheapness, so an audience that converts to nothing outranks an expensive one that pays).
 */
export type SortMetric = "cpc" | "cppr" | "returnPerDollar";

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
  // Every per-audience cost-per-outcome is a real observed ratio (spend / outcomes) when the audience has
  // that outcome, and null ONLY when the cell is truly empty (0 spend AND 0 outcomes). At 0 outcomes the
  // two column families differ by what their outcome IS:
  //   • RAW (cpc / cppr) — the click or the reply IS the outcome, so a raw dollar total is a sound lower
  //     bound: FLOORED (`flooredCostPerOutcome`, audience → brand) = max(audience spend, the FLEET-BACKED
  //     projected cost for this brand+goal — the cross-org → brand cascade `workflow-projection.resolved`
  //     produces, NOT a brand-own raw-spend aggregate).
  //   • DERIVED / funnel (cpfs / cps / cpsale) — the outcome is reached THROUGH an observed website visit
  //     at the brand's conversion rate. Once the audience HAS observed clicks, a raw dollar total would be
  //     a units error AND would discard those clicks: DERIVED (`derivedCostPerOutcome`) = this audience's
  //     own send-tag unit costs on the workflow the Strategy page renders it under (its lowest-click-cost
  //     MEASURED audience grain), pushed through the funnel — the same number that page shows. An audience
  //     that observed NO click anywhere has no such grain, and there the raw total IS the legitimate
  //     answer, so it falls back to the plain `max(own spend, parent)` floor.
  // The dashboard renders the server value directly (no client-side spend fallback). NET floors on the
  // frozen net basis (the fleet cost is read net too).
  metrics: {
    cpcCents: number | null;
    cpprCents: number | null;
    // Cost per form submission — DERIVED (funnel projection of this audience's own click cost). null (not
    // present) for any goal other than form_submissions or when the conversion emails weren't served. Not
    // part of the ranking (ranks on cpc).
    cpfsCents: number | null;
    // Cost per signup — DERIVED. null for any goal other than signup or when the signup conversion emails
    // weren't served. Not part of the ranking (signup ranks on cpc, visit-driven).
    cpsCents: number | null;
    // Cost per sale — DERIVED. null for any goal other than websitePurchase / sales or when the sale
    // conversion emails weren't served. Not part of the ranking (both goals rank on cppr).
    cpsaleCents: number | null;
  };
  /**
   * WHAT THIS AUDIENCE RETURNS PER DOLLAR — the figure the brand Overview's Top-audiences card leads
   * with, because cost per outcome alone ranks audiences by CHEAPNESS: an audience that converts to
   * nothing outranks an expensive one that pays.
   *
   * PROJECTED, not realized, and the field names say so. It prices THIS audience's own observed unit
   * costs (its send-tag spend against its send-tag clicks/replies, on the workflow the Strategy page
   * renders it under) through the brand's OWN declared economics — the same economics behind the
   * brand-level figure, resolved once for the whole payload. `returnPerDollar = lifetimeRevenueUsd /
   * costPerPaidClientUsd`, the identical definition `/funnel-ranking` ranks a brand's declared
   * funnels on, so an audience's return and the brand's return are one statistic at two grains.
   *
   * COHERENT WITH THE BRAND BY CONSTRUCTION: an audience with no MEASURED grain of its own carries no
   * evidence to price and inherits `envelope.brandProjection` verbatim — the same brand-level
   * fallback every derived cost column already takes — rather than being blanked or invented.
   *
   * All three fields are null (never 0) when the brand states no lifetime revenue, when the chain has
   * no path to a paying client, or at cold start. A consumer renders a dash and says it could not be
   * measured; a 0 would read as "this audience returns nothing" / "winning a customer costs nothing",
   * which are different claims.
   */
  projection: {
    /**
     * WHICH declared funnel this row's return was priced through, on the BRAND-LEVEL (funnel-less) read:
     * the audience's own best-returning chain, so an audience that pays best through a different funnel
     * than the brand's headline says so rather than being silently priced on the brand's. `null` on a
     * single-funnel read (the caller named the chain) and when nothing could be priced.
     */
    basisFunnelKey?: SalesFunnelKey | null;
    /**
     * The lifetime revenue this row's return was divided by — the NUMERATOR of `returnPerDollar`,
     * carried per row because on the brand-level read two audiences can legitimately be priced through
     * two chains the brand values differently (a $200 self-serve plan and a $20k contract). A consumer
     * can therefore never pair a return with an LTR this projection did not use.
     */
    lifetimeRevenueUsd?: number | null;
    /** Projected cost to win ONE paying client from this audience. Denominator of the return. */
    costPerPaidClientUsd: number | null;
    /** Dollars of lifetime revenue per dollar spent. Higher is better; > 1 means it pays for itself. */
    returnPerDollar: number | null;
    /**
     * That same cost as a SHARE of what the customer is worth, percent = 100 × costPerPaidClientUsd /
     * lifetimeRevenueUsd = 100 / returnPerDollar. Below 100 means the audience pays for itself. Served
     * rather than left to the consumer precisely BECAUSE it is the reciprocal: a browser dividing one
     * of our fields into another is how two surfaces come to print two numbers for one statistic.
     */
    costOfAcquisitionPct: number | null;
  };
}

/**
 * WHICH FUNNELS THE MONEY FIGURES ON THIS PAYLOAD COVER — served on the BRAND-LEVEL (funnel-less) read,
 * because a reader who cannot tell what was included cannot trust the number.
 *
 * At brand level there is no goal: a brand runs several sales funnels at once, and the only thing that
 * matters is what came back per dollar. So a brand-level return is combined over the brand's DECLARED
 * funnels as the BEST-RETURNING one — the same combination doctrine as the combined-`sales` cost (a sale
 * is won through the chain that converts it best, never a blend), and the reason it reconciles with
 * `/funnel-ranking` by construction: its rank-1 funnel IS this maximum, on the identical
 * `returnPerDollar` definition and the identical evidence.
 */
export interface AudienceStatsFunnelCoverage {
  /** The combination rule, named so it can never be guessed at from the numbers. */
  basis: "best_returning_declared_funnel";
  /** EVERY funnel the brand declared, and whether it could be priced into the figures. Never short. */
  funnels: Array<{
    funnelKey: SalesFunnelKey;
    name: string;
    /** True ⟺ this funnel produced a defined, positive return that competed for the best. */
    priced: boolean;
    /** Why it did not, when `priced` is false. Never a substituted number. */
    reason: FunnelPricingReason | null;
  }>;
  /**
   * The funnel whose chain every cost-per-outcome COLUMN on this payload is denominated in — the brand's
   * best-returning declared funnel, falling back to its first declared funnel in catalogue order when
   * none could be priced. A cost per outcome is denominated in a chain's OWN outcome, so it cannot be
   * combined across chains the way a return can; naming the one it was priced on is the honest answer.
   */
  pricingBasisFunnelKey: SalesFunnelKey | null;
}

export interface AudienceStatsEnvelope {
  featureSlug: string;
  brandId: string;
  /**
   * The chain's goal ECHO on a single-funnel read. **null on the BRAND-LEVEL read** — a brand has no
   * goal, and echoing one of its funnels' goals there would be exactly the arbitrary pick this read
   * exists to remove.
   */
  goal: Goal | null;
  /** Present ONLY on the brand-level (funnel-less) read; absent when the caller named a funnel/goal. */
  funnelCoverage?: AudienceStatsFunnelCoverage;
  brandProfileId: string | null;
  sortMetric: SortMetric;
  audiences: AudienceStatsRow[];
  /**
   * The BRAND-level twin of every row's `projection`, on the goal's winning workflow — the same
   * `returnPerDollar` definition, one grain coarser. Serves two purposes: it is the number an
   * audience with no measured grain inherits (so a consumer can see the inheritance rather than
   * guess at it), and it is what a rows' return is read AGAINST ("this audience beats the brand").
   *
   * `lifetimeRevenueUsd` is the numerator behind every return on this payload, surfaced so a
   * consumer can never pair a return with an LTR this projection did not use. All four null at cold
   * start / no economics — never 0.
   */
  brandProjection: {
    /**
     * The declared funnel the BRAND's own return was priced through on the brand-level read — the
     * head of `/funnel-ranking`'s ranking for the same brand at the same moment. `null` on a
     * single-funnel read and when nothing could be priced.
     */
    basisFunnelKey?: SalesFunnelKey | null;
    lifetimeRevenueUsd: number | null;
    costPerPaidClientUsd: number | null;
    returnPerDollar: number | null;
    /** 100 / returnPerDollar — the brand-level twin of a row's `costOfAcquisitionPct`. */
    costOfAcquisitionPct: number | null;
  };
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
 * Brand-grain distinct conversion counts (union of converting members across the brand's audiences) — the
 * coarser-grain OUTCOME denominator the per-audience conversion cost floors against (audience → brand).
 * A field is `undefined` when its conversion-email set was not fetched (not that goal / lead-service
 * didn't serve it) → the corresponding brand parent is absent and the floor degrades to own spend.
 */
interface BrandConversionTotals {
  formSubmissions?: number;
  signups?: number;
  sales?: number;
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

function sortMetricForGoal(goal: Goal): SortMetric {
  // signup + websiteVisit + formSubmission + whatsappConversation rank on cost-per-click/visit (the
  // click IS the outcome — all four are click-driven; for whatsappConversation the click on the
  // WhatsApp link IS a started conversation); meetingBooked / purchase / positiveReply / websitePurchase /
  // sales rank on cost-per-positive-reply (reply-inclusive close/combined goals).
  return goal === "signup" || goal === "websiteVisit" || goal === "formSubmission" || goal === "whatsappConversation"
    ? "cpc"
    : "cppr";
}

/** One chain's return for one grain, in the three units of one statement. */
interface ResolvedProjection {
  basisFunnelKey?: SalesFunnelKey | null;
  /** The LTR this grain's return was divided by — carried per grain because on the brand-level read two
   * audiences can legitimately be priced through two chains with two different lifetime revenues. */
  lifetimeRevenueUsd: number | null;
  costPerPaidClientUsd: number | null;
  returnPerDollar: number | null;
  costOfAcquisitionPct: number | null;
}

/**
 * ONE chain's projection for a grain: the audience's own measured evidence when it has some, else the
 * brand-level figure — the SAME inheritance the derived cost columns take, so the two families can never
 * disagree about which evidence priced the row. `audienceId: null` asks for the brand grain itself.
 */
function projectionForGrain(parents: BrandProjectedParentsUsd, audienceId: string | null): ResolvedProjection {
  const costPerPaidClientUsd =
    (audienceId != null ? parents.byAudience.get(audienceId)?.costPerPaidClientUsd : null) ??
    parents.costPerPaidClientUsd;
  return {
    lifetimeRevenueUsd: parents.lifetimeRevenueUsd,
    costPerPaidClientUsd,
    returnPerDollar: returnPerDollar(parents.lifetimeRevenueUsd, costPerPaidClientUsd),
    costOfAcquisitionPct: costOfAcquisitionPct(parents.lifetimeRevenueUsd, costPerPaidClientUsd),
  };
}

/** One declared funnel, priced. */
interface PricedFunnel {
  funnelKey: SalesFunnelKey;
  name: string;
  parents: BrandProjectedParentsUsd;
}

/**
 * COMBINE the brand's declared funnels into ONE return for a grain: the BEST-RETURNING chain.
 *
 * A dollar spent on this audience buys a customer through whichever of the brand's chains converts it
 * best, so the brand-level return is the maximum, never a blend and never a sum — the same doctrine as
 * the combined-`sales` cost (`min` over channels, i.e. `max` over returns), and the reason no combined
 * figure can read better than the honest single-chain one. Ties break on the canonical funnel-catalogue
 * order, so the same evidence always yields the same answer.
 *
 * When NO chain has a defined return, the grain still reports the CHEAPEST defined path to a paying
 * client (with a null return) rather than blanking everything: "we know what a customer costs, we do not
 * know what they are worth" is a different statement from "we know nothing", and neither is a zero.
 */
function combineDeclaredFunnels(priced: PricedFunnel[], audienceId: string | null): ResolvedProjection {
  let best: { key: SalesFunnelKey; p: ResolvedProjection } | null = null;
  let cheapest: { key: SalesFunnelKey; p: ResolvedProjection } | null = null;
  for (const { funnelKey, parents } of priced) {
    const p = projectionForGrain(parents, audienceId);
    if (p.returnPerDollar != null) {
      const incumbent = best?.p.returnPerDollar ?? null;
      if (
        incumbent == null ||
        p.returnPerDollar > incumbent ||
        (p.returnPerDollar === incumbent && salesFunnelIndex(funnelKey) < salesFunnelIndex(best!.key))
      ) {
        best = { key: funnelKey, p };
      }
      continue;
    }
    if (p.costPerPaidClientUsd != null && p.costPerPaidClientUsd > 0) {
      const incumbent = cheapest?.p.costPerPaidClientUsd ?? null;
      if (
        incumbent == null ||
        p.costPerPaidClientUsd < incumbent ||
        (p.costPerPaidClientUsd === incumbent && salesFunnelIndex(funnelKey) < salesFunnelIndex(cheapest!.key))
      ) {
        cheapest = { key: funnelKey, p };
      }
    }
  }
  const won = best ?? cheapest;
  return won
    ? { basisFunnelKey: won.key, ...won.p }
    : {
        basisFunnelKey: null,
        lifetimeRevenueUsd: null,
        costPerPaidClientUsd: null,
        returnPerDollar: null,
        costOfAcquisitionPct: null,
      };
}

/** What a brand-level (or single-funnel) projection pass yields for the rest of the compute. */
interface DeclaredFunnelProjection {
  /** The parents every COST column floors against — one chain's, always. */
  parents: BrandProjectedParentsUsd;
  /** Every declared funnel priced, on the brand-level read; `null` on a single-funnel read. */
  priced: PricedFunnel[] | null;
  coverage?: AudienceStatsFunnelCoverage;
}

/**
 * THE BRAND-LEVEL PROJECTION — price the brand through EVERY funnel it declared, off ONE evidence set.
 *
 * The declared set is read from brand-service and never accepted from the caller or inferred; an empty
 * or unreadable declaration THROWS (`SalesFunnelsUnavailableError` → the route's 502), because "this org
 * never stated what it sells through" is a producer gap, not an answer, and a brand that has declared
 * nothing must be distinguishable from one whose chains return nothing.
 *
 * The COST columns cannot be combined the way a return can — a cost per outcome is denominated in each
 * chain's own outcome — so they are priced on ONE chain and the response names it: the best-returning
 * declared funnel, else (nothing priced) the first declared funnel in catalogue order, which is the same
 * deterministic pick `/revenue` makes over a brand's own declarations. Never an inference, never a
 * default nobody stated.
 */
async function projectDeclaredFunnels(
  brandId: string,
  featureSlug: string,
  orgId: string,
  identity: { orgId: string; userId?: string; runId?: string; campaignId?: string; featureSlug?: string },
  pricing: Pricing,
  audienceIds: string[],
): Promise<DeclaredFunnelProjection> {
  const [declared, evidence] = await Promise.all([
    fetchDeclaredSalesFunnels(brandId, orgId),
    fetchBrandProjectionEvidence(brandId, featureSlug, identity, pricing, audienceIds),
  ]);
  const rankable = declaredFunnelsToRank(declared).sort(
    (a, b) => salesFunnelIndex(a.funnelKey) - salesFunnelIndex(b.funnelKey),
  );
  const priced: PricedFunnel[] = rankable.map((funnel) => ({
    funnelKey: funnel.funnelKey,
    name: funnel.name,
    // Each chain on its OWN terms — the funnel's declared economics merged over the brand's effective
    // set, and its own channel (`meetingChannel` inside `projectBrandParents`), which is the whole
    // difference between a meeting bought with a reply and one bought with a click.
    parents: projectBrandParents(
      evidence,
      SALES_FUNNEL_GOAL_ECHO[funnel.funnelKey],
      funnel.funnelKey,
      funnel.economics,
    ),
  }));

  const brandBest = combineDeclaredFunnels(priced, null);
  const basisKey = brandBest.basisFunnelKey ?? priced[0]?.funnelKey ?? null;
  const parents = priced.find((p) => p.funnelKey === basisKey)?.parents;

  return {
    // With no priced chain at all there is nothing to floor against — the cost columns then degrade to
    // each audience's own spend, exactly as they do at cold start. Never a fabricated parent.
    parents: parents ?? {
      cpcUsd: null, cpprUsd: null, cpfsUsd: null, cpsUsd: null, cpsaleUsd: null, cpsmUsd: null,
      byAudience: new Map(), costPerPaidClientUsd: null, lifetimeRevenueUsd: null,
      pricingReason: "no_workflow_evidence",
    },
    priced,
    coverage: {
      basis: "best_returning_declared_funnel",
      funnels: priced.map((p) => ({
        funnelKey: p.funnelKey,
        name: p.name,
        priced: p.parents.pricingReason == null,
        reason: p.parents.pricingReason,
      })),
      pricingBasisFunnelKey: basisKey,
    },
  };
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
  // BRAND LEVEL: best RETURN first (descending), unmeasurable rows last. Ascending cost would rank an
  // audience that converts to nothing above an expensive one that pays — the whole reason the brand-level
  // read leads with return.
  if (metric === "returnPerDollar") {
    const ar = a.projection.returnPerDollar;
    const br = b.projection.returnPerDollar;
    if (ar === null && br === null) return a.audienceId.localeCompare(b.audienceId);
    if (ar === null) return 1;
    if (br === null) return -1;
    if (ar !== br) return br - ar;
    return a.audienceId.localeCompare(b.audienceId);
  }
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

interface SendTagEngagement {
  contacted: number;
  opened: number;
  websiteClicks: number;
  positiveReplies: number;
}

function emptyEngagement(): SendTagEngagement {
  return { contacted: 0, opened: 0, websiteClicks: 0, positiveReplies: 0 };
}

/**
 * Per-audience SEND-TAG engagement from email-gateway `/orgs/stats?type=broadcast&groupBy=audienceId`
 * (the audienceId stamped on each broadcast send — email-gateway#168/#170). This is the SAME send-tag
 * basis as the per-audience COST (runs `groupBy=audienceId`), so cost-per-outcome is one basis end to end
 * — it SUPERSEDES the membership join, whose click basis (member ∩ any brand click) mismatched the
 * send-tag cost. Returns per-audience counts + the brand-grain total (Σ over audiences — a send is tagged
 * to ONE audience, so the sum does not double-count, unlike overlapping memberships). A campaign scope
 * narrows via the `campaignId` filter. Fails loud on any downstream error.
 */
async function fetchAudienceSendTagEngagement(
  brandId: string,
  featureSlug: string,
  identity: { orgId: string; userId?: string; runId?: string; campaignId?: string; featureSlug?: string },
  scopeCampaignId?: string,
): Promise<{ perAudience: Map<string, SendTagEngagement>; brandGrain: SendTagEngagement }> {
  const baseUrl = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("EMAIL_GATEWAY_SERVICE_URL or EMAIL_GATEWAY_SERVICE_API_KEY not configured");
  }
  const params = new URLSearchParams({ type: "broadcast", groupBy: "audienceId", brandId, featureSlugs: featureSlug });
  if (scopeCampaignId) params.set("campaignId", scopeCampaignId);
  const response = await fetchWithRetry(`${baseUrl}/orgs/stats?${params}`, {
    headers: buildHeaders(apiKey, identity.orgId, { ...identity, brandId }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`email-gateway audience engagement failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as { groups?: Array<Record<string, unknown>> };
  const perAudience = new Map<string, SendTagEngagement>();
  const brandGrain = emptyEngagement();
  if (Array.isArray(data.groups)) {
    for (const group of data.groups) {
      const audienceId = String(group.key ?? "__total__");
      if (audienceId === "__total__") continue;
      const broadcast = group.broadcast as Record<string, unknown> | undefined;
      const rs = (broadcast?.recipientStats as Record<string, number> | undefined) ?? {};
      const engagement: SendTagEngagement = {
        contacted: rs.contacted ?? 0,
        opened: rs.opened ?? 0,
        websiteClicks: rs.clicked ?? 0,
        positiveReplies: rs.repliesPositive ?? 0,
      };
      perAudience.set(audienceId, engagement);
      brandGrain.contacted += engagement.contacted;
      brandGrain.opened += engagement.opened;
      brandGrain.websiteClicks += engagement.websiteClicks;
      brandGrain.positiveReplies += engagement.positiveReplies;
    }
  }
  return { perAudience, brandGrain };
}

/**
 * Per-audience MEMBERSHIP evidence: the audience's addressable pool size (distinct member emails —
 * human-service provenance, human-service#42) + REAL per-audience conversions (form-submission / signup /
 * sale), attributed by intersecting the audience's member emails with the brand's matched-lead conversion
 * emails (lead-service conversion tracker).
 *
 * Engagement (contacted / opened / clicked / positiveReply) is NO LONGER computed here — it comes from the
 * SEND-TAG path (`fetchAudienceSendTagEngagement`), the SAME basis as the cost, so cost-per-outcome is one
 * basis end to end. This fetch stays membership-based only for the two things membership genuinely owns:
 * memberCount (the audience size) and conversion attribution (a conversion belongs to whichever audience
 * produced the matched lead). Brand-wide, no campaign scope. Fails loud on any downstream error.
 */
async function fetchAudienceMembership(
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
): Promise<{ perAudience: Map<string, AudienceOutcomeEvidence>; brand: BrandConversionTotals }> {
  const perAudience = await Promise.all(
    audiences.map(async (a) => ({ audienceId: a.id, emails: await fetchAudienceMemberEmails(a.id, identity) })),
  );

  const result = new Map<string, AudienceOutcomeEvidence>();
  // Brand-grain PARENT denominators: distinct converting MEMBER emails across the brand (union — a member
  // in two audiences counts once), the coarser-grain outcome count the per-audience conversion cost floors
  // against (audience → brand). Only tallied when the corresponding conversion-email set is present.
  const brandSubmitters = new Set<string>();
  const brandSignups = new Set<string>();
  const brandSales = new Set<string>();
  for (const { audienceId, emails } of perAudience) {
    const agg = emptyOutcomes();
    // Addressable pool size = distinct member emails served under the audience (contacted ⊆ this).
    agg.memberCount = new Set(emails).size;
    // DISTINCT-member conversion tally: count each member email at most once. Only when we have the set.
    let formSubmissions = formSubmissionEmails ? 0 : undefined;
    let signups = signupEmails ? 0 : undefined;
    let sales = saleEmails ? 0 : undefined;
    const seenSubmitters = new Set<string>();
    const seenSignups = new Set<string>();
    const seenSales = new Set<string>();
    for (const email of emails) {
      const key = email.trim().toLowerCase();
      if (formSubmissionEmails && formSubmissionEmails.has(key) && !seenSubmitters.has(key)) {
        seenSubmitters.add(key);
        formSubmissions = (formSubmissions ?? 0) + 1;
        brandSubmitters.add(key);
      }
      if (signupEmails && signupEmails.has(key) && !seenSignups.has(key)) {
        seenSignups.add(key);
        signups = (signups ?? 0) + 1;
        brandSignups.add(key);
      }
      if (saleEmails && saleEmails.has(key) && !seenSales.has(key)) {
        seenSales.add(key);
        sales = (sales ?? 0) + 1;
        brandSales.add(key);
      }
    }
    if (formSubmissions !== undefined) agg.formSubmissions = formSubmissions;
    if (signups !== undefined) agg.signups = signups;
    if (sales !== undefined) agg.sales = sales;
    result.set(audienceId, agg);
  }
  const brand: BrandConversionTotals = {
    formSubmissions: formSubmissionEmails ? brandSubmitters.size : undefined,
    signups: signupEmails ? brandSignups.size : undefined,
    sales: saleEmails ? brandSales.size : undefined,
  };
  return { perAudience: result, brand };
}

/**
 * Compute for the audience-stats endpoint.
 * Validates the request (400s as `ok:false`), looks up the feature (404 as `ok:false`), and
 * fans out to runs-service (cost) + human-service/email-gateway (outcomes) to build ranked rows.
 * Downstream failures THROW — the route maps them to 502.
 */
/**
 * PURE, synchronous parameter validation for `/audience-stats` — no IO, no network, no DB.
 *
 * Extracted so the ROUTE can reject a bad request BEFORE it makes any downstream call. The route now
 * reads the brand's economics ahead of the Gold cache lookup (its fingerprint is part of the
 * `scope_key`), and that read must never run for a request that is going to 400 anyway: with an
 * unreachable BRAND_SERVICE_URL the retrying client burns seconds before failing, which turned two
 * validation tests into 5s timeouts in CI while passing locally.
 *
 * `computeAudienceStats` calls this too, so there is ONE definition of "valid" — the lib stays
 * independently correct for its other caller (customer-health), and the route cannot drift from it.
 */
export function validateAudienceStatsQuery(req: Request):
  | { ok: true; brandId: string; goal: Goal | null; funnelKey?: SalesFunnelKey; statuses: AudienceStatus[]; limit?: number }
  | { ok: false; status: number; error: string } {
  const brandId = req.query.brandId as string | undefined;
  const goalParam = req.query.goal as string | undefined;
  const funnelParam = req.query.funnel as string | undefined;
  const limitParam = req.query.limit as string | undefined;
  const statusesParam = req.query.statuses as string | undefined;

  if (!brandId) {
    return { ok: false, status: 400, error: "brandId query parameter is required" };
  }
  // `?funnel=` names the SALES FUNNEL to price on — the vocabulary a brand actually declares, and the
  // only one that separates a meeting bought with a reply from one bought with a click. It is the
  // CANONICAL parameter: a caller should send it and nothing else. Unknown value → 400; never a silent
  // fall back to the goal, which would answer a finer question with a coarser number and look right.
  let funnelKey: SalesFunnelKey | undefined;
  if (funnelParam != null && funnelParam !== "") {
    const matched = matchSalesFunnelKey(funnelParam);
    if (!matched) {
      return { ok: false, status: 400, error: `funnel query parameter must be one of: ${SALES_FUNNEL_KEYS.join(", ")}` };
    }
    funnelKey = matched;
  }

  // `?goal=` is DEPRECATED and kept only until the dashboard migrates to `?funnel=`. It is accepted in
  // every fleet spelling (snake/kebab/display → canonical camel), and a named funnel WINS over it.
  // When only a funnel is named the goal is DERIVED from it (`SALES_FUNNEL_GOAL_ECHO`) — an echo the
  // internal column routing still speaks, never a goal→funnel translation in the other direction.
  const normalizedGoal = goalParam
    ? (matchSingleStepGoal(goalParam) ??
       matchFormSubmissionGoal(goalParam) ??
       matchWhatsappGoal(goalParam) ??
       matchCombinedSalesGoal(goalParam) ??
       matchWebsitePurchaseGoal(goalParam) ??
       goalParam)
    : funnelKey
      ? SALES_FUNNEL_GOAL_ECHO[funnelKey]
      : undefined;
  // NAMING NEITHER is the BRAND-LEVEL read, and it is a first-class request, not a missing parameter:
  // at brand level there is no goal, because the brand sells through every funnel it declared at once.
  // The money is then combined over the brand's DECLARED set (read from brand-service, never from the
  // caller) and the response says which funnels went into it. Only a NAMED-but-unrecognised goal is an
  // error here — the funnel param already 400'd above on an unrecognised value.
  if (goalParam != null && goalParam !== "" && !isGoal(normalizedGoal)) {
    return {
      ok: false,
      status: 400,
      error: `goal query parameter must be one of: signup, meetingBooked, websitePurchase, sales, websiteVisit, positiveReply, formSubmission, whatsappConversation (or send funnel instead: ${SALES_FUNNEL_KEYS.join(", ")}; sending neither prices the brand across every funnel it declared)`,
    };
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

  return {
    ok: true,
    brandId,
    goal: isGoal(normalizedGoal) ? normalizedGoal : null,
    ...(funnelKey ? { funnelKey } : {}),
    statuses: parsedStatuses.statuses,
    limit: parsedLimit,
  };
}

export async function computeAudienceStats(req: Request, pricing: Pricing = "gross"): Promise<ComputeResult> {
  const { featureSlug } = req.params;
  const { orgId, userId, runId, campaignId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;
  const explicitBrandProfileId = req.query.brandProfileId as string | undefined;
  // Optional single-campaign scope for the STATS (audiences themselves stay brand-wide). Absent →
  // brand-wide numbers, byte-identical to today. Present → cost + outcome numerators narrow to this
  // campaign (runs campaignId filter + email-gateway campaign scope).
  const scopeCampaignId = (req.query.campaignId as string | undefined)?.trim() || undefined;

  const validated = validateAudienceStatsQuery(req);
  if (!validated.ok) return validated;
  const { brandId, goal: normalizedGoal, funnelKey, limit: parsedLimit } = validated;
  const parsedStatuses = { ok: true as const, statuses: validated.statuses };

  const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
  if (!feature) {
    return { ok: false, status: 404, error: "Feature not found" };
  }

  const identity = { orgId, userId, runId, campaignId, featureSlug: headerFeatureSlug };
  const audiences = await fetchAudiencesByStatuses(brandId, parsedStatuses.statuses, identity);
  // brand-service retired its versioned brand-profile storage, so brandProfileId is sourced solely
  // from the explicit query param (null when absent) — no brand-profile network round-trip.
  const brandProfileId = explicitBrandProfileId ?? null;

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

  // A funnel-keyed request prices on the funnel's OWN declared terms, exactly as the ranking does — read
  // from the same declared list, and only on the funnel path so no goal-keyed request pays for it.
  const funnelEconomics = funnelKey
    ? declaredEconomicsForFunnel(await fetchDeclaredSalesFunnels(brandId, orgId), funnelKey)
    : null;

  const audienceIds = audiences.map((audience) => audience.id);

  const [costs, membershipResult, engagementResult, projected] = await Promise.all([
    fetchAudienceCosts(brandId, featureSlug, identity, pricing, scopeCampaignId),
    fetchAudienceMembership(brandId, audiences, identity, formSubmissionEmails, signupEmails, saleEmails),
    fetchAudienceSendTagEngagement(brandId, featureSlug, identity, scopeCampaignId),
    // FLEET-BACKED brand parent for the FLOOR cascade (audience → brand): the SAME cross-org → brand
    // projected cost-per-outcome that workflow-projection.resolved produces (fleet benchmark cascaded with
    // the brand's effective economics), NOT a brand-own raw-spend aggregate. So a 0-outcome audience's
    // floor bottoms out at the identical number the Strategy page shows. Brand-wide (NOT campaign-scoped —
    // the fleet benchmark is campaign-agnostic); same gross/net basis as the rest of the payload.
    //
    // BRAND LEVEL (no funnel, no goal): the SAME evidence, priced once per DECLARED funnel and combined
    // as the best-returning chain. The fan-out is paid ONCE (`fetchBrandProjectionEvidence`) and the N
    // projections are pure — exactly how /funnel-ranking ranks N funnels off one evidence set — so
    // answering the brand-level question costs no more IO than answering a single-funnel one.
    normalizedGoal === null
      ? projectDeclaredFunnels(brandId, featureSlug, orgId, identity, pricing, audienceIds)
      : fetchBrandProjectedParents(
          brandId,
          featureSlug,
          normalizedGoal,
          identity,
          pricing,
          audienceIds,
          // When the caller named a funnel, the floor parent is priced on THAT chain AND on that funnel's
          // own declared terms — same overrides the per-row projection takes, so the two can never disagree
          // for one audience.
          funnelKey,
          funnelEconomics,
        ).then((parents) => ({ parents, priced: null, coverage: undefined }) as DeclaredFunnelProjection),
  ]);
  const membership = membershipResult.perAudience;
  const engagement = engagementResult.perAudience;
  const brandProjected = projected.parents;
  const coverage = projected.coverage;
  /**
   * The return for one grain: on a single-funnel read, that funnel's own figure (byte-identical to
   * before); on the brand-level read, the best-returning of the brand's declared chains.
   */
  const resolveProjection = (audienceId: string | null): ResolvedProjection =>
    projected.priced
      ? combineDeclaredFunnels(projected.priced, audienceId)
      : projectionForGrain(brandProjected, audienceId);

  // Brand PARENT cost-per-outcome for the FLOOR cascade (audience → brand), per column — the fleet-backed
  // projected cost (USD) from the shared projection engine, converted to CENTS to match the cost basis.
  // A 0-outcome audience with spend floors to max(audience spend, this parent), so it never reads below
  // the fleet benchmark and is coherent with workflow-projection.resolved by construction. An audience
  // WITH the outcome ignores the parent (real observed ratio). null parent (cold start) → the floor
  // degrades to own spend, never a fabricated value.
  const usdToCents = (usd: number | null): number | null => (usd != null ? usd * 100 : null);
  const brandParentCpc = usdToCents(brandProjected.cpcUsd);
  const brandParentCppr = usdToCents(brandProjected.cpprUsd);
  const brandParentCpfs = usdToCents(brandProjected.cpfsUsd);
  const brandParentCps = usdToCents(brandProjected.cpsUsd);
  const brandParentCpsale = usdToCents(brandProjected.cpsaleUsd);

  const audienceMap = new Map(audiences.map((audience) => [audience.id, audience]));
  const ids = new Set([...costs.keys(), ...membership.keys(), ...engagement.keys()]);
  const rows: AudienceStatsRow[] = [];

  for (const audienceId of ids) {
    const audience = audienceMap.get(audienceId);
    if (!audience) continue;

    const cost = costs.get(audienceId) ?? emptyCost();
    // This audience's FUNNEL projection under the goal's winning workflow (absent when it has no send-tag
    // evidence there → the derived columns inherit the brand-level projection).
    const audienceProjected = brandProjected.byAudience.get(audienceId) ?? null;
    // Merge: memberCount + conversions (membership) with contacted/opened/clicks/replies (send-tag), so the
    // engagement counts share the cost's send-tag basis while memberCount/conversions keep membership.
    const member = membership.get(audienceId) ?? emptyOutcomes();
    const eng = engagement.get(audienceId) ?? emptyEngagement();
    const outcome: AudienceOutcomeEvidence = {
      ...member,
      contacted: eng.contacted,
      opened: eng.opened,
      websiteClicks: eng.websiteClicks,
      positiveReplies: eng.positiveReplies,
    };
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
      // TWO display engines, split by what the column's outcome IS.
      //
      // RAW columns (cost per website visit / positive reply) — the driving outcome IS the outcome, so a
      // raw dollar total is a sound lower bound: FLOORED engine. A real observed ratio when the audience
      // has that outcome; else the cascade floor max(audience cost, brand parent) — never below the
      // brand-level cost, never a raw tiny-spend value; NULL only when the cell is truly empty.
      //
      // DERIVED funnel columns (form submission / signup / sale) — the outcome is reached THROUGH an
      // observed website visit at the brand's conversion rate, so flooring them on a raw dollar total is a
      // units error that also DISCARDS the clicks the audience did observe: DERIVED engine. At 0 outcomes
      // they take this audience's funnel projection on the workflow the Strategy page renders it under
      // (its lowest-click-cost MEASURED audience grain, workflow-agnostic — see the projection module), so
      // the Audiences table and the Strategy page never disagree. An audience that observed NO click
      // anywhere has no such grain → `null` projection → the engine falls back to the raw
      // `max(own spend, parent)` floor, which is the legitimate answer in exactly that regime.
      //
      // Both engines keep the same net/gross basis as the whole payload (cost cents were already selected
      // per `pricing`), so net floors on net by construction.
      metrics: {
        cpcCents: flooredCostPerOutcome(cost.totalCostInUsdCents, outcome.websiteClicks, brandParentCpc),
        cpprCents: flooredCostPerOutcome(cost.totalCostInUsdCents, outcome.positiveReplies, brandParentCppr),
        // Present ONLY for the form_submissions goal (absent → null). null when the cell is truly empty
        // (0 spend AND 0 form submissions) — never a false $0.
        cpfsCents:
          outcome.formSubmissions !== undefined
            ? derivedCostPerOutcome(
                cost.totalCostInUsdCents,
                outcome.formSubmissions,
                usdToCents(audienceProjected?.cpfsUsd ?? null),
                brandParentCpfs,
              )
            : null,
        // Present ONLY for the signup goal. null when truly empty (0 spend AND 0 signups).
        cpsCents:
          outcome.signups !== undefined
            ? derivedCostPerOutcome(
                cost.totalCostInUsdCents,
                outcome.signups,
                usdToCents(audienceProjected?.cpsUsd ?? null),
                brandParentCps,
              )
            : null,
        // Present ONLY for the website-purchase / combined-sales goals. null when truly empty (0 spend
        // AND 0 sales).
        cpsaleCents:
          outcome.sales !== undefined
            ? derivedCostPerOutcome(
                cost.totalCostInUsdCents,
                outcome.sales,
                usdToCents(audienceProjected?.cpsaleUsd ?? null),
                brandParentCpsale,
              )
            : null,
      },
      // This audience's own measured grain when it has one, else the brand-level projection — the
      // SAME inheritance the derived cost columns take, so the two families can never disagree about
      // which evidence priced the row.
      projection: resolveProjection(audienceId),
    });
  }

  // A brand has no goal, so the brand-level read ranks on the only thing that matters at that grain:
  // what each audience RETURNS per dollar. A single-funnel read keeps its chain's cost order verbatim.
  const sortMetric: SortMetric = normalizedGoal === null ? "returnPerDollar" : sortMetricForGoal(normalizedGoal);
  rows.sort((a, b) => compareByMetric(sortMetric, a, b));
  const audiencesOut = parsedLimit !== undefined ? rows.slice(0, parsedLimit) : rows;

  const brandCombined = resolveProjection(null);

  return {
    ok: true,
    envelope: {
      featureSlug,
      brandId,
      goal: normalizedGoal,
      ...(coverage ? { funnelCoverage: coverage } : {}),
      brandProfileId,
      sortMetric,
      audiences: audiencesOut,
      brandProjection: brandCombined,
    },
  };
}
