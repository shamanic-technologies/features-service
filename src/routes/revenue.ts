import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { getFunnel, orP, restrictPathsToDeclaredLegs, singleStepRateDecimal, combinedSaleProbability, type EconomicsSource, type SalesEconomics } from "../lib/funnel-registry.js";
import { matchSingleStepGoal, matchCombinedSalesGoal, matchWebsitePurchaseGoal } from "../lib/goals.js";
import {
  fetchEffectiveEconomics,
  economicsFingerprint,
  type EffectiveEconomics,
} from "../lib/sales-economics-client.js";
import {
  fetchBrandProjectedParents,
  type BrandProjectedParentsUsd,
} from "../lib/audience-stats-brand-projection.js";
import { fetchLeadsForRevenue } from "../lib/leads-client.js";
import { fetchRunsCostCents, fetchCampaignIdsWithRuns } from "../lib/runs-cost-client.js";
import { fetchSpendBreakdown, type SpendBreakdown, type SpendSource } from "../lib/spend-client.js";
import { fetchConversionCounts, type ConversionCounts } from "../lib/conversion-counts-client.js";
import { fetchConversionEmails } from "../lib/conversion-emails-client.js";
import { fetchEventTimestamps } from "../lib/email-status-client.js";
import { fetchSequencesByDay } from "../lib/sequences-client.js";
import { fetchQualifications } from "../lib/qualifications-client.js";
import { observedCostPerOutcome, flooredCostPerOutcome, derivedCostPerOutcome } from "../lib/cost-engine.js";
import {
  computeRevenue,
  dedupPersonsByLead,
  buildContactedSeries,
  buildSignalSeries,
  type EnginePerson,
  type OrganizationRow,
  type LeadRow,
  type TimeSeriesPoint,
  type EventRow,
  type SignalSeries,
} from "../lib/revenue-engine.js";
import { traceEvent } from "../lib/trace-event.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { parsePricing, type Pricing } from "../lib/pricing.js";
import { fetchDeclaredSalesFunnels, SalesFunnelsUnavailableError, type DeclaredSalesFunnel } from "../lib/sales-funnels-client.js";
import { declaredEconomicsForFunnel, mergeFunnelEconomics } from "../lib/declared-funnels.js";
import { primaryDeclaredFunnel } from "../lib/brand-funnels.js";
import { matchSalesFunnelKey, salesFunnelIndex, SALES_FUNNEL_KEYS, SALES_FUNNEL_GOAL_ECHO, type SalesFunnelKey } from "../lib/sales-funnels.js";
import { singleCampaignId, type CampaignFilter } from "../lib/campaign-scope.js";
import { fetchCampaignFamiliesSoft } from "../lib/campaign-identity-client.js";
import { describeIdentity } from "../lib/campaign-identity.js";

const router = Router();

/**
 * Derived cost economics for the brand(+campaign), feature-scoped. Always present.
 *
 * ROI / CAC are computed on REALIZED spend — `actualCostUsd` carries ACTUAL (billed) cost ONLY, NOT
 * the committed total (which includes provisioned holds). Naming follows the service-wide
 * total/actual/provisioned convention: a forward-looking "money reserved" figure (the `spend` block's
 * total…) must never inflate ROI/CAC, so the field is named `actualCostUsd` to make the realized basis
 * unambiguous and distinct from the committed `total…` figures. (Same source as /stats
 * systemStats.actualCostInUsdCents and the `spend` block's actualSpentCents.)
 *   - actualCostUsd:         ACTUAL (billed) run cost in dollars (excludes provisioned holds), >= 0.
 *   - costOfAcquisitionPct:  (actualCostUsd / totalPipelineUsd) * 100; null when pipeline is null OR 0.
 *   - roiMultiple:           totalPipelineUsd / actualCostUsd; null when cost is 0 OR pipeline is null.
 *   - expectedConversions:   LENS ONLY — sum of per-lead conversion probability (decimal) across the
 *                            lensed leads (totalPipelineUsd = expectedConversions × LTR). Absent off-lens.
 *   - costPerConversionUsd:  LENS ONLY — actualCostUsd / expectedConversions; null when expectedConversions
 *                            is 0. Absent off-lens.
 */
export interface CostEconomics {
  actualCostUsd: number;
  costOfAcquisitionPct: number | null;
  roiMultiple: number | null;
  expectedConversions?: number;
  costPerConversionUsd?: number | null;
}

export function buildCostEconomics(actualCostInUsdCents: number, totalPipelineUsd: number | null): CostEconomics {
  const actualCostUsd = actualCostInUsdCents / 100;
  const costOfAcquisitionPct =
    totalPipelineUsd === null || totalPipelineUsd === 0 ? null : (actualCostUsd / totalPipelineUsd) * 100;
  const roiMultiple =
    actualCostUsd === 0 || totalPipelineUsd === null ? null : totalPipelineUsd / actualCostUsd;
  return { actualCostUsd, costOfAcquisitionPct, roiMultiple };
}

/**
 * Canonical spend block for the Overview "Outreach & Conversions" card — every number the card shows
 * (Total spent, today's spend, top cost sources + %, CPC), pre-computed so the dashboard renders
 * verbatim (no client arithmetic).
 *
 * NAMING CONVENTION (product-owner mandated — total/actual/provisioned). Each spend/CPC figure ships
 * THREE variants so a name can never lie about which accounting it carries:
 *   - total…        = COMMITTED = ACTUAL + PROVISIONED (the money already reserved). This is what the
 *                     dashboard "Total spent" / "Budget spent today" / "CPC" now show — a customer
 *                     sees money RESERVED (incl. open holds for scheduled follow-ups), not only billed.
 *                     It legitimately DIPS when a hold releases (a follow-up sends → becomes actual,
 *                     net zero; or a hold cancels because a contact replied / can't be reached → drop).
 *   - actual…       = actualized / billed spend only (== the old single value pre-this-change).
 *   - provisioned…  = open provisioned holds only (= total − actual).
 *
 * RECONCILED BY CONSTRUCTION:
 *   - totalSpentCents (committed) == Σ sources[].totalSpentCents; same for actual / provisioned.
 *   - {total,actual,provisioned}CpcCents = the matching spend / clicks — each CPC reconciles with its
 *     own displayed spend (the bug #396 fixed: CPC off systemStats.totalCostInUsdCents while "Total
 *     spent" was a different accounting — now every CPC is derived from the SAME total it labels).
 * ZERO-OUTCOME SEMANTICS — the AGGREGATE twin of the per-audience `metrics.*Cents` engines (see
 * `buildSpend`). At 0 outcomes a cost-per-outcome is not measurable, so instead of null (which made the
 * dashboard fall back to printing the brand's own total spend, i.e. "Cost per positive reply $28.74"
 * directly above "Total spent $28.74") every column reports the fleet-backed expected cost of the
 * workflow the brand's GOAL crowns — byte-equal to what the Strategy page shows for that brand. A real
 * observed ratio still wins whenever the count is > 0; own spend still wins above the benchmark; null
 * survives only when there is neither an expected cost nor any spend to fall back on.
 */
export interface Spend {
  totalSpentCents: number;
  actualSpentCents: number;
  provisionedSpentCents: number;
  totalSpentTodayCents: number;
  actualSpentTodayCents: number;
  provisionedSpentTodayCents: number;
  sources: SpendSource[];
  totalCpcCents: number | null;
  actualCpcCents: number | null;
  provisionedCpcCents: number | null;
  // REAL tracked conversions from lead-service (features-service#461) — the Signups / Sales Meetings
  // tiles + their cost-per-conversion. Present when lead-service served the counts; ABSENT (undefined)
  // on a cold / pre-rollout payload (the endpoint unreachable → display tile degrades, never a fake 0).
  // These REPLACE the projected cps/cpsm dropped in features-service#406 with the REAL computation.
  signupsCount?: number;
  salesMeetingsCount?: number;
  // REAL tracked form submissions (lead-service conversion tracker, event="form_submission") — the
  // visit-driven micro-conversion, sibling of signups. The Form Submissions tile for a form_submissions
  // brand. 0 when none; ABSENT when lead-service didn't serve the counts (never a fabricated 0).
  formSubmissionsCount?: number;
  // Cost-per-conversion = COMMITTED spend (actual + provisioned, the same denominator the CPC card
  // uses) ÷ the real count; at a 0 count, the winning workflow's PROJECTED cost of that outcome (a
  // funnel column never reports a raw dollar total — that is a units error). null only when neither
  // exists. ABSENT when lead-service didn't serve the counts.
  cpsCents?: number | null;
  cpsmCents?: number | null;
  // REAL cost per form submission = committed spend ÷ formSubmissionsCount (same COMMITTED denominator
  // as cpsCents/totalCpcCents → cpfsCents × formSubmissionsCount ≈ committed spend). null when the count
  // is 0; ABSENT when the counts weren't served.
  cpfsCents?: number | null;
  // REAL attributed SALES — paying clients won (lead-service conversion tracker, event="sale", RENAMED
  // from "purchase") for the brand. The Sales tile's brand-level aggregate — the terminal outcome of
  // BOTH the website-purchase goal and the combined-sales goal. Equivalent to signupsCount /
  // salesMeetingsCount / formSubmissionsCount. 0 when none; ABSENT when lead-service didn't serve the
  // counts (never a fabricated 0). (Renamed from purchasesCount — features-service combined-sales slice.)
  salesCount?: number;
  // REAL cost per sale = committed spend ÷ salesCount (same COMMITTED denominator as the other
  // cost-per-conversion figures → cpSaleCents × salesCount ≈ committed spend). null when the count is
  // 0 (no denominator — never a false $0); ABSENT when the counts weren't served. (Renamed from cppCents.)
  cpSaleCents?: number | null;
  // REAL attributed positive replies for the brand — the single-step positive_replies goal's outcome,
  // the reply-goal sibling of signups/meetings/form-submissions. A positive reply is an email
  // engagement signal (NOT a lead-service conversion event), so it is sourced from the SAME deduped
  // leads[] snapshot as recipientsRepliesPositive.total (coherent by construction — same predicate the
  // Overview positive-replies actual series uses). ALWAYS present (leads are a fail-loud core input),
  // unlike the conversion-counts tiles which are ABSENT when that soft read fails. (features-service#482)
  positiveRepliesCount: number;
  // Cost per positive reply = COMMITTED spend ÷ positiveRepliesCount (same COMMITTED denominator as
  // totalCpcCents/cpsCents → cpprCents × positiveRepliesCount ≈ committed spend). At a 0 count it is
  // the RAW floor max(committed spend, the winning workflow's projected cost per positive reply) — the
  // same conservative bound the per-audience row applies. null only when there is neither.
  cpprCents: number | null;
}

/**
 * The AGGREGATE (brand / campaign grain) twin of /audience-stats' per-audience floor parents — the
 * fleet-backed projected cost-per-outcome of the workflow that the SALES FUNNEL being priced crowns, one
 * value per cost column, in USD. `null` for the whole block when the brand has declared no funnel (there
 * is no chain to be coherent with) or when the projection read degrades (below).
 */
type SpendCostParents = BrandProjectedParentsUsd | null;

/**
 * Resolve the aggregate floor parents for the OVERVIEW spend block.
 *
 * **PRICED ON A SALES FUNNEL, never on a goal.** This used to read the brand's `optimizationGoal` to
 * pick the winning workflow. That column carries a NOT NULL server default, so a brand that never chose
 * a goal was priced through the website-purchase chain nobody had said it sells through — and
 * brand-service is dropping the column. The chain now comes from what the brand DECLARED it sells
 * through (`GET /internal/brands/:brandId/sales-funnels`):
 *
 *   - the caller's `?funnel=` when it named one (the dashboard knows which chain the customer is
 *     looking at, and a brand selling through several has a different price for each), else
 *   - the brand's FIRST DECLARED funnel in catalogue order — a deterministic pick over the brand's OWN
 *     declarations, not a default and not an inference.
 *
 * The funnel's OWN declared terms ride with it (`declaredEconomicsForFunnel`), the same merge the
 * ranking applies, so these columns price on exactly the chain `/workflow-projection?funnel=` prices on.
 *
 * NO DECLARED FUNNEL → null (and the fetch is skipped): "what they sell through" does not exist yet, so
 * there is no expected cost to floor against and the columns stay OBSERVED (null at 0 outcomes) exactly
 * as they did for a brand with no goal. A funnel is NEVER substituted.
 *
 * `audienceIds: []` deliberately skips the per-audience grain entirely (the aggregate has no audience
 * column), so this adds ZERO human-service round-trips and none of the per-audience fan-out.
 *
 * Fail-SOFT with a loud log, mirroring the sequences / conversion-counts enrichment reads on this same
 * Overview path: a projection blip (or an unreadable declaration) degrades the cost columns to today's
 * OBSERVED behaviour ("-", i.e. "we could not estimate this") rather than 502-ing the customer's
 * Overview. It NEVER degrades to the raw-spend floor — that is the exact "cost per reply == total spent"
 * output this feature removes — and it never degrades to a guessed chain.
 */
function fetchSpendCostParentsSoft(
  brandId: string,
  featureSlug: string,
  headers: DownstreamHeaders,
  campaignId: string | undefined,
  pricing: Pricing,
  requestedFunnel: SalesFunnelKey | undefined,
): Promise<SpendCostParents> {
  // The caller's own org names whose configuration we want — a brand id alone is shared across every
  // org claiming the same domain, so what it sells through is the (org, brand) pair's data.
  return fetchDeclaredSalesFunnels(brandId, headers.orgId)
    .then((declared) => {
      const declaredKeys = declared.map((f) => f.funnelKey).sort((a, b) => salesFunnelIndex(a) - salesFunnelIndex(b));
      // An explicit `?funnel=` is honoured only when the brand actually declared it — pricing a brand on
      // a chain it never said it sells through would be the same fiction the goal default produced.
      const funnelKey =
        requestedFunnel && declaredKeys.includes(requestedFunnel)
          ? requestedFunnel
          : primaryDeclaredFunnel(declaredKeys);
      if (!funnelKey) return null;
      return fetchBrandProjectedParents(
        brandId,
        featureSlug,
        // The goal ECHO, derived FROM the funnel purely because the projection's internal routing still
        // speaks it. The funnel key below OVERRIDES it, so the two meeting chains stay priced apart.
        SALES_FUNNEL_GOAL_ECHO[funnelKey],
        { orgId: headers.orgId, userId: headers.userId, runId: headers.runId, campaignId, featureSlug: headers.featureSlug },
        pricing,
        [],
        funnelKey,
        declaredEconomicsForFunnel(declared, funnelKey),
      );
    })
    .catch((err) => {
      const what =
        err instanceof SalesFunnelsUnavailableError
          ? "this brand has declared no sales funnel we could read"
          : (err as Error).message;
      console.warn(
        `[features-service] spend cost-parent projection failed (degrading the aggregate cost columns to observed): ${what}`,
      );
      return null;
    });
}

/**
 * WHAT THE PIPELINE IS PRICED ON — the brand's DECLARED sales funnels: which LEGS carry expected value
 * at all, and whose TERMS those legs are priced on (merged OVER the brand-wide effective economics for
 * every term the funnel does not state).
 *
 * THE LEGS. The paths that carry value are exactly the legs of the funnels being priced — a signal
 * that is not a step of one contributes nothing (`restrictPathsToDeclaredLegs`). A brand that declared
 * several funnels is priced on ALL of their legs. A read NARROWED to one funnel is priced on that
 * chain's legs alone; two things narrow it, in this precedence:
 *
 *   - the caller's `?funnel=` when it named one the brand actually declared (the dashboard knows which
 *     chain the customer is looking at), else
 *   - the funnel the CAMPAIGN itself states, on a campaign-scoped read. A campaign sells one chain and
 *     campaign-service stores which (`campaignIdentity.funnelKey`), so a campaign's figures are that
 *     chain's figures — not the brand's first declared one.
 *
 * THE TERMS. The narrowed funnel when there is one, else the brand's FIRST DECLARED funnel in
 * catalogue order — a deterministic pick over the brand's OWN declarations, not a default and not an
 * inference.
 *
 * WHY: a brand-level conversion rate no longer carries meaning — rates exist PER FUNNEL, and the
 * brand-wide record survives only as the legacy fallthrough for a brand that declared none. The two
 * sibling surfaces (`/workflow-projection?funnel=` and the `/audience-stats` floor parent) already
 * price this way, and the spend block's cost-per-outcome columns right above do too. The pipeline EV
 * did not: it priced every reply off the brand-wide row, so one brand + one funnel + one moment
 * printed two different prices — a declared conversation funnel worth 35% reply→paid was valued at
 * the brand-wide 12.5%, i.e. $312.50 a reply where the brand had stated $875. Same precedence, same
 * merge helper (`declaredEconomicsForFunnel` + `mergeFunnelEconomics`) as the sibling surfaces, so
 * they cannot diverge again.
 *
 * A term the funnel does not state falls through to the brand-wide value (never to 0, which would
 * zero-collapse the chain). NO DECLARED FUNNEL → the brand-wide economics apply unchanged and every
 * conversion leg is priced, i.e. byte-identical to before on everything except the delivery
 * milestones, which are a step of no chain for anybody and are gone for everybody.
 */
export interface FunnelPricedEconomics {
  /** The brand-wide economics with the priced funnel's own declared terms merged over them. */
  economics: EffectiveEconomics;
  /**
   * The funnels whose LEGS carry expected value on this read. One key when a funnel was named (the
   * caller's `?funnel=`, or the funnel a campaign itself states); the brand's WHOLE declared set
   * otherwise; `[]` when the brand declared none / the declaration could not be read — in which case
   * every conversion leg is priced, exactly as before (there is no chain to narrow against, and
   * inventing one is the fiction this whole retirement removes).
   */
  pricedFunnelKeys: SalesFunnelKey[];
}

/**
 * Read the brand's declaration for this org, SOFT: `[]` when there is none or it cannot be read.
 *
 * An unreadable declaration degrades the pipeline to the brand-wide economics and to every conversion
 * leg — a real, if poorer, answer — rather than 502-ing the customer's Overview, the same
 * display-enrichment posture the spend cost-parents read on this path takes. An EMPTY declaration
 * THROWS at the client (a producer gap, not "sells through nothing") and lands here as that same
 * degrade, which IS the required no-declared-funnel behaviour.
 */
async function fetchDeclaredFunnelsSoft(brandId: string, orgId: string): Promise<DeclaredSalesFunnel[]> {
  try {
    // The caller's own org names whose configuration we want: a brand id alone is shared across every
    // org claiming the same domain, so what it sells through is the (org, brand) pair's data.
    return await fetchDeclaredSalesFunnels(brandId, orgId);
  } catch (err) {
    const what =
      err instanceof SalesFunnelsUnavailableError
        ? "this brand has declared no sales funnel we could read"
        : (err as Error).message;
    console.warn(
      `[features-service] declared-funnel pricing unavailable (pipeline EV falls through to the brand-wide economics and every conversion leg): ${what}`,
    );
    return [];
  }
}

/**
 * PURE: pick the chain this read is priced on, and merge its own declared terms over the brand-wide
 * economics. No IO — the declaration is read ONCE per request and every campaign group reuses it.
 */
export function priceOnDeclaredFunnel(
  declared: DeclaredSalesFunnel[],
  effective: EffectiveEconomics,
  requestedFunnel: SalesFunnelKey | undefined,
): FunnelPricedEconomics {
  const declaredKeys = declared.map((f) => f.funnelKey).sort((a, b) => salesFunnelIndex(a) - salesFunnelIndex(b));
  // A funnel the brand never declared is ignored rather than honoured: pricing a brand on a chain it
  // never said it sells through would be the same fiction the defaulted goal produced.
  const named = requestedFunnel && declaredKeys.includes(requestedFunnel) ? requestedFunnel : null;
  const pricedFunnelKeys = named ? [named] : declaredKeys;
  const funnelKey = named ?? primaryDeclaredFunnel(declaredKeys);
  if (!funnelKey || !effective.economics) return { economics: effective, pricedFunnelKeys };
  const merged = mergeFunnelEconomics(effective.economics, declaredEconomicsForFunnel(declared, funnelKey));
  return { economics: merged ? { ...effective, economics: merged } : effective, pricedFunnelKeys };
}

/** The request-path composition of the two above, for callers that hold no declaration of their own. */
export async function fetchFunnelPricedEconomics(
  brandId: string,
  headers: DownstreamHeaders,
  requestedFunnel: SalesFunnelKey | undefined,
  effective: EffectiveEconomics,
): Promise<FunnelPricedEconomics> {
  return priceOnDeclaredFunnel(await fetchDeclaredFunnelsSoft(brandId, headers.orgId), effective, requestedFunnel);
}

function buildSpend(
  breakdown: SpendBreakdown,
  leads: LeadRow[],
  counts: ConversionCounts | null = null,
  parents: SpendCostParents = null,
): Spend {
  // clicks use the SAME per-lead predicate as the clicked SignalSeries, so the CPC denominator equals
  // the card's displayed "clicks" (clicked.total) — coherent by construction.
  const clicks = leads.reduce((n, l) => n + (l.clicked ? 1 : 0), 0);
  // Positive replies use the SAME per-lead predicate as recipientsRepliesPositive (the Overview
  // positive-replies actual series), so cpprCents's denominator equals that card's displayed count —
  // coherent by construction. The single-step positive_replies goal's real outcome economics.
  const positiveReplies = leads.reduce((n, l) => n + (l.repliedPositive ? 1 : 0), 0);
  const committed = breakdown.totalSpentCents;
  const actual = breakdown.actualSpentCents;
  const provisioned = breakdown.provisionedSpentCents;

  // REAL cost-per-conversion (features-service#461): committed spend ÷ the real tracked count. The
  // denominator is the COMMITTED total — the SAME basis the CPC card uses (totalCpcCents) — so
  // cpsCents × signupsCount ≈ committed spend by construction. Via the shared OBSERVED cost engine:
  // null (never a false $0) when the count is 0 OR there is no committed spend. Absent entirely when
  // lead-service didn't serve the counts. (This block is ACCOUNTING → observed, not projected.)
  //
  // ZERO-OUTCOME FLOOR (the AGGREGATE twin of /audience-stats' per-audience engines). At 0 outcomes an
  // observed ratio does not exist, and returning null made the dashboard fall back to printing the
  // brand's own total spend — so "Cost per positive reply $28.74" sat directly above "Total spent
  // $28.74" while the Strategy page priced the same brand at $62.98. Every column below now runs the
  // SAME engine the per-audience row runs, floored against the SAME winning workflow's projected costs
  // (`parents`), so the two surfaces cannot print two prices for one benchmark.
  //   - RAW columns   (cost per click / positive reply — the driving outcome IS the outcome) →
  //     `flooredCostPerOutcome` = real ratio, else max(own spend, parent). SPEND-WINS ABOVE THE
  //     BENCHMARK IS INTENDED: a brand that already outspent the expected cost with nothing to show
  //     reports its own (higher) spend — the same conservative floor the audience grain applies.
  //   - FUNNEL columns (signup / sales meeting / form submission / sale — reached THROUGH a click or a
  //     reply at the brand's conversion rate) → `derivedCostPerOutcome`, which prefers the projection:
  //     answering "cost per signup" with a raw dollar total is a units error. The own-spend protection
  //     is NOT lost — the driving unit cost fed to that projection is itself max(own spend, fleet) at
  //     0 driving outcomes.
  // `parents === null` (brand declares no goal, or the projection read degraded) → every column falls
  // back to OBSERVED, byte-identical to the pre-floor behaviour: null means "we could not estimate
  // this", never a fabricated value and never the raw spend total.
  const usdToCents = (usd: number | null | undefined): number | null => (usd != null ? usd * 100 : null);
  const raw = (spentCents: number, observed: number, parentUsd: number | null | undefined): number | null =>
    parents ? flooredCostPerOutcome(spentCents, observed, usdToCents(parentUsd)) : observedCostPerOutcome(spentCents, observed);
  // A funnel column needs its OWN projection to exist (the goal's winning workflow only resolves the
  // rates the brand actually declares — e.g. no visit→form-submission rate ⇒ no cost per form
  // submission). Without it there is no expected cost, and the raw-total fallback would be the units
  // error, so the column stays OBSERVED → null. "We could not estimate this", never a dollar total.
  const funnel = (observed: number, parentUsd: number | null | undefined): number | null =>
    parents && parentUsd != null
      ? derivedCostPerOutcome(committed, observed, usdToCents(parentUsd))
      : observedCostPerOutcome(committed, observed);

  const conversion: Partial<Spend> = counts
    ? {
        signupsCount: counts.signup,
        salesMeetingsCount: counts.meeting_booked,
        formSubmissionsCount: counts.form_submission,
        salesCount: counts.sale,
        cpsCents: funnel(counts.signup, parents?.cpsUsd),
        cpsmCents: funnel(counts.meeting_booked, parents?.cpsmUsd),
        cpfsCents: funnel(counts.form_submission, parents?.cpfsUsd),
        cpSaleCents: funnel(counts.sale, parents?.cpsaleUsd),
      }
    : {};

  return {
    totalSpentCents: committed,
    actualSpentCents: actual,
    provisionedSpentCents: provisioned,
    totalSpentTodayCents: breakdown.totalSpentTodayCents,
    actualSpentTodayCents: breakdown.actualSpentTodayCents,
    provisionedSpentTodayCents: breakdown.provisionedSpentTodayCents,
    sources: breakdown.sources,
    // Each CPC keeps its OWN spend basis (the block never claims total == actual + provisioned for a
    // RATIO) and floors against the SAME fleet-backed cost per website visit — at 0 clicks none of the
    // three is measurable, so all three legitimately report the same lower bound.
    totalCpcCents: raw(committed, clicks, parents?.cpcUsd),
    actualCpcCents: raw(actual, clicks, parents?.cpcUsd),
    provisionedCpcCents: raw(provisioned, clicks, parents?.cpcUsd),
    // Positive-reply outcome economics: committed spend ÷ the real count from the leads snapshot, floored
    // at the winning workflow's projected cost per positive reply when the count is 0. Always present
    // (leads always fetched); null only when there is no benchmark AND no spend to fall back on.
    positiveRepliesCount: positiveReplies,
    cpprCents: raw(committed, positiveReplies, parents?.cpprUsd),
    ...conversion,
  };
}

interface RevenueResponse {
  featureSlug: string;
  /**
   * totalPipelineUsd is null when no funnel is wired, or the brand has no saved economics AND no
   * cross-brand average exists yet (cold start). economicsSource tags the provenance of the economics
   * used: "sales-economics" = the brand's own saved set; "cross-brand-average" = the brand-service
   * fallback average (revenue is an ESTIMATE, not user-confirmed). Null when the pipeline is null.
   */
  headline: { totalPipelineUsd: number | null; economicsSource: EconomicsSource | null };
  costEconomics: CostEconomics;
  timeSeries: TimeSeriesPoint[];
  organizations: OrganizationRow[];
  leads: LeadRow[];
  events: EventRow[];
  /**
   * Server-computed "contacted" aggregates for the Overview's Outreach surfaces — the stat-card
   * total + the daily-graph actual series, both derived from the SAME `leads[]` above so all three
   * Outreach surfaces (card, graph, table) agree from one snapshot (features-service#371/#372).
   * Coherent by construction: total === sum(daily counts) + undatedCount === count(leads contacted).
   */
  recipientsContacted: SignalSeries;
  /**
   * The Opens / Clicks / goal-outcome ACTUAL series for the Overview daily graph, each
   * server-computed from the SAME `leads[]` above — exactly like `recipientsContacted` — so all four
   * actual series and the conversions table move together from one snapshot (features-service#377).
   * This replaces the old pipeline-activity / instantly event-day source, which bucketed raw events
   * (re-opens by already-advanced leads) decoupled from the contacted snapshot and produced
   * impossible states ("3 opens today while 0 outreach today"). Coherent by construction with
   * `recipientsContacted` + the table: each series' total = sum(daily counts) + undatedCount =
   * count(leads carrying the signal), and no series can exceed the contacted snapshot.
   *   - opened         → Opens series   (email-gateway firstOpenedAt).
   *   - clicked        → Clicks series  (website-visit; ALSO the signup-goal outcome — a self-serve
   *     signup is downstream of the visit on the client's own site and is NOT tracked here, so the
   *     observed website visit is the coherent signup-funnel actual; the dashboard scales it by
   *     visitToSignupPct for the projected signups line, which stays a forecast).
   *   - repliedPositive→ Positive-replies series (email-gateway firstRepliedAt). The booked-meetings
   *     lens's engagement signal (P=replyToMeeting) — the meeting-goal Outcome line on the Overview
   *     graph; distinct from meetingsBooked (the reply is the signal, the booked meeting the outcome).
   *   - meetingsBooked → the meeting-goal outcome (instantly manual-qualification meetingBookedAt).
   *   - purchased      → the purchase-goal outcome (instantly manual-qualification closedAt).
   *   - signups / formSubmissions → the signup / form-submission conversion outcomes (lead-service
   *     conversion tracker, attributed per lead by matched-email). These carry a REAL total (leads we
   *     can confirm converted) but an EMPTY `daily` with `undatedCount === total`, because lead-service
   *     exposes WHICH lead converted, not WHEN — the per-day trend populates once lead-service surfaces
   *     the conversion date (features-service#476). Distinct from recipientsClicked (the visit PROXY).
   */
  recipientsOpened: SignalSeries;
  recipientsClicked: SignalSeries;
  recipientsRepliesPositive: SignalSeries;
  meetingsBooked: SignalSeries;
  purchased: SignalSeries;
  signups: SignalSeries;
  formSubmissions: SignalSeries;
  /**
   * OUTREACH ACTIVITY daily series for the Overview graph — instantly campaigns-created per day (via
   * email-gateway groupBy=day), NOT the lead snapshot (features-service#415). Answers "how much outreach
   * happened each day" (re-contacts count each day, matches "budget spent today"), whereas
   * `recipientsContacted` answers "how many distinct leads have I reached" (funnel view, deduped by
   * first-ever contact). The two grains DIFFER by design and are NOT reconciled — the card renders
   * `recipientsContacted.total` (unique leads), the graph's Outreach ACTUAL bars render
   * `sequences.daily` (per-day actions). undatedCount is always 0 (instantly buckets every
   * campaign by created_at). Present on the OVERVIEW response only (same gate as `spend`); null on the
   * lensed (?lens=) response and absent on grouped (?groupBy=campaignId) groups. Fail-soft: null when the
   * email-gateway read fails (the graph degrades to no outreach bars, the rest of the response stays intact).
   */
  sequences: SignalSeries | null;
  /**
   * Canonical spend block for the Overview card — Total spent / today's spend / top cost sources /
   * CPC, each in committed/actual/provisioned variants (see {@link Spend}). Present on the OVERVIEW
   * response only; null on the lensed (?lens=) response (the lens pages render their own
   * costPerConversionUsd), and absent on the grouped (?groupBy=campaignId) per-campaign groups.
   */
  spend: Spend | null;
}

/**
 * The Opens / Clicks / meeting / purchase ACTUAL series, each built from the SAME `leads[]` snapshot
 * (mirrors `buildContactedSeries`). Coherent-by-construction with `recipientsContacted` + the table.
 */
function buildOutcomeSeries(leads: LeadRow[]): Pick<RevenueBody, "recipientsOpened" | "recipientsClicked" | "recipientsRepliesPositive" | "meetingsBooked" | "purchased" | "signups" | "formSubmissions"> {
  return {
    recipientsOpened: buildSignalSeries(leads, (l) => l.opened, (l) => l.openedAt),
    recipientsClicked: buildSignalSeries(leads, (l) => l.clicked, (l) => l.clickedAt),
    recipientsRepliesPositive: buildSignalSeries(leads, (l) => l.repliedPositive, (l) => l.repliedPositiveAt),
    meetingsBooked: buildSignalSeries(leads, (l) => l.meetingBooked, (l) => l.meetingBookedAt),
    purchased: buildSignalSeries(leads, (l) => l.purchased, (l) => l.purchasedAt),
    // signup / formSubmission dates are always null today (lead-service exposes the matched lead but
    // not the conversion date) → every attributed lead lands in undatedCount, daily is empty, total is
    // the real attributed count. Populates the per-day trend automatically once the producer date lands.
    signups: buildSignalSeries(leads, (l) => l.signup, (l) => l.signupAt),
    formSubmissions: buildSignalSeries(leads, (l) => l.formSubmission, (l) => l.formSubmissionAt),
  };
}

/** The revenue response body for one (brand, campaign?) scope — everything but the featureSlug. */
export type RevenueBody = Omit<RevenueResponse, "featureSlug">;

export type DownstreamHeaders = { orgId: string; userId?: string; runId?: string; featureSlug?: string };

function emptyBody(
  totalPipelineUsd: number | null,
  actualCostInUsdCents: number,
  spend: Spend | null,
  sequences: SignalSeries | null = null,
): RevenueBody {
  return {
    headline: { totalPipelineUsd, economicsSource: null },
    costEconomics: buildCostEconomics(actualCostInUsdCents, totalPipelineUsd),
    timeSeries: [],
    organizations: [],
    leads: [],
    events: [],
    recipientsContacted: buildContactedSeries([]),
    ...buildOutcomeSeries([]),
    sequences,
    spend,
  };
}

/**
 * Fetch the OUTREACH ACTIVITY day series (email-gateway groupBy=day) for the OVERVIEW path only.
 * Fail-soft — a failure degrades to null (the graph drops its Outreach bars) rather than 502-ing the
 * whole /revenue response, mirroring the other email-gateway enrichment reads.
 */
function fetchSequencesSoft(
  brandId: string,
  campaignScope: CampaignFilter,
  featureSlug: string,
  headers: DownstreamHeaders,
): Promise<SignalSeries | null> {
  return fetchSequencesByDay(brandId, campaignScope, featureSlug, headers).catch((err) => {
    console.warn(
      `[features-service] sequences enrichment failed (degrading to null): ${(err as Error).message}`,
    );
    return null;
  });
}

/**
 * Fetch the brand's REAL attributed conversion counts (lead-service) for the OVERVIEW spend block —
 * the Signups / Sales Meetings tiles + their real cost-per-conversion (features-service#461).
 * Fail-soft: a failure degrades to null (the tiles render "-" / the counts are ABSENT) rather than
 * 502-ing the whole /revenue response — these are display enrichment, not the pipeline total, exactly
 * like the sequences series above. Absent ≠ 0: a fake 0 would fabricate a count / a false CPS; null
 * carries "unknown". Loud log, never a silent swallow. On the pre-rollout window (lead-service's
 * endpoint not yet deployed) this degrades cleanly to absent instead of blocking the Overview.
 */
function fetchConversionCountsSoft(brandId: string): Promise<ConversionCounts | null> {
  return fetchConversionCounts(brandId).catch((err) => {
    console.warn(
      `[features-service] conversion-counts enrichment failed (degrading to absent): ${(err as Error).message}`,
    );
    return null;
  });
}

/**
 * The DISTINCT matched-lead email sets for the two per-lead website conversions (signup +
 * form_submission) from the lead-service conversion tracker, used to flag which leads[] reached each
 * outcome (real producer-side attribution — the SAME email-membership join audience-stats uses).
 *
 * Fetched only on the OVERVIEW path (where leads[] is surfaced); brand-scoped (identical across the
 * brand's campaigns). Each read is fail-SOFT per event → a failure degrades that outcome's per-lead
 * flags to `false` (the column reads "not converted") rather than 502-ing the whole /revenue response
 * — these are per-lead display enrichment, exactly like the conversion-counts tiles + the sequences
 * series. Loud log, never a silent swallow. NOTE: lead-service exposes the matched lead (email) but
 * not the conversion timestamp, so this yields WHICH leads converted, not WHEN — the daily trend for
 * these outcomes populates only once lead-service surfaces the conversion date (features-service#476).
 */
interface ConversionOutcomeEmails {
  signup: Set<string> | null;
  formSubmission: Set<string> | null;
}

function fetchConversionOutcomeEmailsSoft(brandId: string): Promise<ConversionOutcomeEmails> {
  const soft = (event: "signup" | "form_submission") =>
    fetchConversionEmails(brandId, event).catch((err) => {
      console.warn(
        `[features-service] converted-lead-emails (${event}) enrichment failed (degrading to no per-lead ${event} flags): ${(err as Error).message}`,
      );
      return null;
    });
  return Promise.all([soft("signup"), soft("form_submission")]).then(([signup, formSubmission]) => ({
    signup,
    formSubmission,
  }));
}

const EMPTY_CONVERSION_OUTCOME_EMAILS: ConversionOutcomeEmails = { signup: null, formSubmission: null };

// ── Outcome lenses (dashboard Signups / Booked Meetings / Sales tabs) ─────────
//
// A lens segments the revenue overview to ONE outcome and attaches a per-lead conversion
// probability. The probability is a FIXED per-signal rate from the brand's sales economics — NOT
// the furthest-stage EV engine (no decay, no platform funnel rates). It reuses the SAME orP channel
// model as `salesFunnel`: the sales-lens pClick/pReply below are byte-identical to its
// pCloseClick/pCloseReply, just expressed as probabilities instead of dollars.
// website_visits / positive_replies are SINGLE-STEP lenses: per-lead EV = one paid-client rate × LTR
// (visit→paid / reply→paid), NOT the multi-step sales close.
// website_purchase = the RENAMED former `sales` lens (multi-step self-serve / meeting close funnel).
// sales = the NEW COMBINED goal (a paying client won via EITHER visit→paid OR reply→paid); per-LEAD
// probability combines the two paths as a probabilistic OR (a lead converts at most once) — see
// lensProbability + combinedSaleProbability. Do NOT confuse it with the best-channel-MIN cost-per-sale
// (costPerSaleUsd) used by the projection surface.
export type Lens = "signups" | "booked-meetings" | "website_purchase" | "sales" | "website_visits" | "positive_replies";
export const LENS_VALUES: readonly Lens[] = ["signups", "booked-meetings", "website_purchase", "sales", "website_visits", "positive_replies"];

const pct = (n: number): number => n / 100;

/**
 * The lead's conversion probability (decimal 0–1) for the lens, or null when the lead does not
 * match the lens's engagement signal (filtered out of the lensed leads).
 *   - signups         → website CLICK; P = visitToSignup
 *   - booked-meetings → positive REPLY; P = replyToMeeting
 *   - sales           → click and/or positive reply (union); per-lead combined-OR paid-close:
 *       pClick = orP(visitToClose, visitToMeeting · meetingToClose)   (self-serve OR via meeting)
 *       pReply = replyToMeeting · meetingToClose                       (reply → meeting → close)
 *       clicked only → pClick ; reply only → pReply ; both → orP(pClick, pReply)
 *   - website_visits  → website CLICK; P = visitToPaidClient  (SINGLE STEP: visit→paid, one rate)
 *   - positive_replies→ positive REPLY; P = replyToPaidClient (SINGLE STEP: reply→paid, one rate)
 * The two single-step lenses fail loud when their rate field is absent (singleStepRateDecimal).
 */
function lensProbability(lens: Lens, signals: Record<string, boolean>, e: SalesEconomics): number | null {
  const clicked = Boolean(signals.clicked);
  const positiveReply = Boolean(signals.positiveReply);
  switch (lens) {
    case "signups":
      return clicked ? pct(e.visitToSignupPct) : null;
    case "booked-meetings":
      return positiveReply ? pct(e.replyToMeetingPct) : null;
    case "website_purchase": {
      // RENAMED former `sales` lens — the multi-step self-serve / meeting close funnel (unchanged math).
      if (!clicked && !positiveReply) return null;
      const pClick = orP(pct(e.visitToClosePct), pct(e.visitToMeetingPct) * pct(e.meetingToClosePct));
      const pReply = pct(e.replyToMeetingPct) * pct(e.meetingToClosePct);
      if (clicked && positiveReply) return orP(pClick, pReply);
      return clicked ? pClick : pReply;
    }
    case "sales": {
      // COMBINED-sales goal — per-LEAD probability of becoming a SALE (paying client, valued at CLTV)
      // via EITHER the visit→paid (v2pc) OR the reply→paid (r2pc) single-step path. A lead converts at
      // most once → the two paths combine as a probabilistic OR (orP), NEVER a sum (which could exceed 1
      // and double-counts a both-paths lead). This is the per-lead twin of the projection's ADDITIVE
      // population expected-count. Fails loud when a rate field is absent (singleStepRateDecimal).
      if (!clicked && !positiveReply) return null;
      const v2pc = singleStepRateDecimal(e, "websiteVisit");
      const r2pc = singleStepRateDecimal(e, "positiveReply");
      return combinedSaleProbability(v2pc, r2pc, clicked, positiveReply);
    }
    case "website_visits":
      // SINGLE STEP: a visiting (clicked) lead converts to a paid client at visitToPaidClientPct.
      return clicked ? singleStepRateDecimal(e, "websiteVisit") : null;
    case "positive_replies":
      // SINGLE STEP: a positively-replying lead converts to a paid client at replyToPaidClientPct.
      return positiveReply ? singleStepRateDecimal(e, "positiveReply") : null;
  }
}

/** Tags reflecting the engagement signals the lead actually holds, for the lensed lead row. */
function lensTags(signals: Record<string, boolean>): string[] {
  const tags: string[] = [];
  if (signals.clicked) tags.push("visit");
  if (signals.positiveReply) tags.push("reply");
  return tags;
}

/**
 * Lensed overview body: leads filtered to the lens signal, each carrying conversionProbabilityPct +
 * lens expectedRevenueUsd (probability × LTR); headline.totalPipelineUsd = sum across those leads.
 * organizations / timeSeries / events are empty (not consumed by the dashboard lens pages); date is
 * null (Wave B per-event dates are skipped — the lens uses only clicked / positiveReply from Wave A).
 */
function buildLensBody(
  lens: Lens,
  rawPersons: EnginePerson[],
  economics: SalesEconomics,
  economicsSource: EconomicsSource,
  actualCostInUsdCents: number,
): RevenueBody {
  const ltr = economics.lifetimeRevenueUsd;
  const leads: LeadRow[] = [];
  for (const person of dedupPersonsByLead(rawPersons)) {
    const p = lensProbability(lens, person.signals, economics);
    if (p === null) continue; // lead does not match this lens's engagement signal
    leads.push({
      leadId: person.leadId,
      firstName: person.firstName,
      lastName: person.lastName,
      photoUrl: person.photoUrl,
      orgName: person.orgName,
      orgLogoUrl: person.orgLogoUrl,
      orgDomain: person.orgDomain,
      title: person.title,
      seniority: person.seniority,
      orgIndustry: person.orgIndustry,
      orgEmployeeCount: person.orgEmployeeCount,
      orgCity: person.orgCity,
      orgCountry: person.orgCountry,
      tags: lensTags(person.signals),
      expectedRevenueUsd: p * ltr,
      date: null,
      contacted: Boolean(person.signals.contacted),
      contactedAt: person.signalDates?.contacted ?? null,
      opened: Boolean(person.signals.open),
      openedAt: person.signalDates?.open ?? null,
      clicked: Boolean(person.signals.clicked),
      clickedAt: person.signalDates?.clicked ?? null,
      repliedPositive: Boolean(person.signals.positiveReply),
      // Gate the timestamp on the positive classification, NOT email-gateway's sentiment-agnostic
      // `firstRepliedAt` — a negative/neutral-only replier must carry a null date (matches the boolean).
      repliedPositiveAt: person.signals.positiveReply ? (person.signalDates?.positiveReply ?? null) : null,
      meetingBooked: Boolean(person.signals.meeting),
      meetingBookedAt: person.signalDates?.meeting ?? null,
      purchased: Boolean(person.signals.closeWin),
      purchasedAt: person.signalDates?.closeWin ?? null,
      // Lens short-circuits before the Wave B conversion-email merge (a brand-total concept), so these
      // stay false/null on a lensed row — same as meetingBooked/purchased, which the lens also omits.
      signup: Boolean(person.signals.signup),
      signupAt: person.signalDates?.signup ?? null,
      formSubmission: Boolean(person.signals.formSubmission),
      formSubmissionAt: person.signalDates?.formSubmission ?? null,
      conversionProbabilityPct: p * 100,
    });
  }
  // Deterministic: highest expected revenue first, leadId tiebreak.
  leads.sort(
    (a, b) =>
      b.expectedRevenueUsd - a.expectedRevenueUsd ||
      (a.leadId < b.leadId ? -1 : a.leadId > b.leadId ? 1 : 0),
  );
  const totalPipelineUsd = leads.reduce((sum, l) => sum + l.expectedRevenueUsd, 0);
  // LENS ONLY: expected conversion COUNT = sum of per-lead probability (decimal). totalPipelineUsd =
  // expectedConversions × LTR. costPerConversionUsd = actualCostUsd / expectedConversions (null at 0).
  const expectedConversions = leads.reduce((sum, l) => sum + (l.conversionProbabilityPct ?? 0) / 100, 0);
  const costEconomics = buildCostEconomics(actualCostInUsdCents, totalPipelineUsd);
  return {
    headline: { totalPipelineUsd, economicsSource },
    costEconomics: {
      ...costEconomics,
      expectedConversions,
      costPerConversionUsd: expectedConversions === 0 ? null : costEconomics.actualCostUsd / expectedConversions,
    },
    timeSeries: [],
    organizations: [],
    leads,
    events: [],
    recipientsContacted: buildContactedSeries(leads),
    ...buildOutcomeSeries(leads),
    // The lens response omits the brand-total spend block AND the sequences series (both describe
    // the brand, not the lensed subset). The dashboard reads them from the unlensed Overview call; lens
    // pages use costPerConversionUsd.
    sequences: null,
    spend: null,
  };
}

/**
 * Compute the full expected-pipeline revenue body for ONE (brand, campaign?) scope.
 *
 * Single source of truth for both the overview (no groupBy) and the per-campaign groups
 * (groupBy=campaignId) — calling it per enumerated campaign makes each group byte-equal to the
 * standalone ?campaignId= call. `funnel` is resolved once by the caller (same for every campaign).
 *
 * Economics + leads + cost are fail-loud (the pipeline total must be exact). Per-event timestamps
 * (email-gateway) and manual-qualification dates (instantly-service) are SECONDARY enrichment used
 * for dates / time-series / events / meeting-booked / close-win: if a call fails we log and
 * degrade (the pipeline total, orgs and leads stay correct) rather than failing the whole endpoint.
 */
export async function computeFeatureRevenue(
  featureSlug: string,
  brandId: string,
  // One campaign, or the FAMILY of campaigns sharing one identity — (org, brand, sales funnel,
  // acquisition channel), campaign-service's own key. A family totals as ONE campaign: its stopped
  // ancestors carry real runs and real costs, and the customer reads them as the campaign that is
  // still running. A single-campaign scope keeps every downstream read byte-identical.
  campaignScope: CampaignFilter,
  funnel: ReturnType<typeof getFunnel>,
  headers: DownstreamHeaders,
  lens?: Lens,
  // The brand's DECLARED-funnel pricing — the merged economics AND which funnels' legs carry value.
  // Both are brand-scoped (brand-service serves them per brand, not per campaign), so the route
  // resolves them ONCE and passes the result here: N campaign groups don't each re-hit brand-service,
  // and each group can still narrow to its OWN campaign's chain off that one read. Omitted → resolved
  // in Wave A as before.
  economicsOverride?: FunnelPricedEconomics,
  // When true (the unlensed Overview path), fetch the canonical spend breakdown (per-source actual +
  // today) and emit the `spend` block. The grouped per-campaign path and the lens path pass false:
  // groups discard spend, and lens omits it (a brand-total concept). When false we use the cheaper
  // single-total fetchRunsCostCents; both read the SAME runs ACTUAL spend, so costEconomics agrees.
  includeSpend = false,
  // NET pricing: read runs#179's FROZEN net cost cents (no read-time multiply). Passed straight to the
  // cost reads (fetchRunsCostCents / fetchSpendBreakdown) so the engine derives net CAC/ROI/spend. GROSS
  // (the default) is byte-identical; the CROSS-ORG public revenue caller (staff) never sets it → gross.
  pricing: Pricing = "gross",
  // The SALES FUNNEL the caller asked the spend block's cost-per-outcome columns to be priced on
  // (`?funnel=`). Omitted → the brand's first declared funnel. A funnel the brand never declared is
  // ignored rather than honoured: see fetchSpendCostParentsSoft.
  requestedFunnel?: SalesFunnelKey,
): Promise<RevenueBody> {
  // The single campaign id the campaign-SCOPED downstream reads still take: the requested campaign
  // for a single scope, `undefined` for a family (no producer accepts a campaign list). The reads
  // that must be family-EXACT — cost, spend, leads, the outreach series — take `campaignScope`
  // itself. The rest (economics, the per-email date + qualification overlays, the projected cost
  // parents) answer about the BRAND and a campaign only narrows them, so a family reads the brand's
  // answer — its own superset, and the same one the brand Overview reads.
  const campaignId = singleCampaignId(campaignScope);

  // No funnel wired for this feature yet → null pipeline (not an error). `funnel` is known up
  // front (caller param), so short-circuit BEFORE Wave A and fetch ONLY the cost the empty body
  // needs — never over-fetching economics/rates/leads on the no-funnel path. Fail-loud: a
  // swallowed cost error must not fake $0 cost / infinite ROI.
  if (!funnel) {
    if (includeSpend) {
      // Overview: fetch spend (fail-loud) + sequences (fail-soft) in parallel. Outreach activity
      // is independent of the funnel — a no-funnel feature still launches campaigns worth graphing.
      const [breakdown, sequences, counts, parents] = await Promise.all([
        fetchSpendBreakdown(brandId, campaignScope, featureSlug, headers, new Date(), pricing),
        fetchSequencesSoft(brandId, campaignScope, featureSlug, headers),
        fetchConversionCountsSoft(brandId),
        fetchSpendCostParentsSoft(brandId, featureSlug, headers, campaignId, pricing, requestedFunnel),
      ]);
      // ROI/CAC ride ACTUAL spend; the `spend` block carries the committed total separately.
      return emptyBody(null, breakdown.actualSpentCents, buildSpend(breakdown, [], counts, parents), sequences);
    }
    const actualCostInUsdCents = await fetchRunsCostCents(brandId, campaignScope, featureSlug, headers, pricing);
    return emptyBody(null, actualCostInUsdCents, null);
  }

  // ── Wave A: the downstream reads with NO data dependency on each other, in parallel.
  //   - fetchRunsCostCents     (runs-service)   — total feature-scoped cost, on every body.
  //   - fetchEffectiveEconomics(brand-service)  — rates + terminal LTR; brand-service OWNS the
  //     null→cross-brand-average defaulting + provenance ("user" = saved "sales-economics";
  //     else "cross-brand-average", an ESTIMATE). economics is null only at cold start → null pipeline.
  //   - fetchLeadsForRevenue   (lead-service)   — the per-lead overlay (persons).
  // The cost / economics / leads reads are fail-loud (Promise.all rejects → the endpoint 502s): each
  // is a core input to the pipeline total / cost / ROI; a swallowed error would fake a number. The
  // economics===null cold-start path below over-fetches leads — accepted for the common-path win.
  const [costResult, priced, persons, sequences, counts, conversionEmails, parents] = await Promise.all([
    includeSpend
      ? fetchSpendBreakdown(brandId, campaignScope, featureSlug, headers, new Date(), pricing)
      : fetchRunsCostCents(brandId, campaignScope, featureSlug, headers, pricing),
    // Priced on the brand's DECLARED funnel, falling through to the brand-wide record for every term
    // the funnel does not state (the route resolves this once and passes it as the override).
    economicsOverride ??
      fetchEffectiveEconomics(brandId, { ...headers, campaignId }).then((effective) =>
        fetchFunnelPricedEconomics(brandId, headers, requestedFunnel, effective),
      ),
    fetchLeadsForRevenue(brandId, campaignScope, headers),
    // Overview-only sequences day series (email-gateway groupBy=day). Pre-caught → resolves to
    // null on failure, so it never rejects fail-loud Wave A. Off-overview it's null (not fetched).
    includeSpend
      ? fetchSequencesSoft(brandId, campaignScope, featureSlug, headers)
      : Promise.resolve<SignalSeries | null>(null),
    // Overview-only REAL conversion counts (lead-service) for the Signups / Sales Meetings tiles +
    // cost-per-conversion. Pre-caught → null on failure (never rejects fail-loud Wave A). Off-overview null.
    includeSpend ? fetchConversionCountsSoft(brandId) : Promise.resolve<ConversionCounts | null>(null),
    // Overview-only per-lead SIGNUP / FORM-SUBMISSION attribution email sets (lead-service conversion
    // tracker). Fail-soft per event → never rejects fail-loud Wave A; brand-scoped. Off-overview null.
    includeSpend ? fetchConversionOutcomeEmailsSoft(brandId) : Promise.resolve<ConversionOutcomeEmails>(EMPTY_CONVERSION_OUTCOME_EMAILS),
    // Overview-only AGGREGATE floor parents for the spend block's cost-per-outcome columns — the
    // fleet-backed projected cost of the workflow the brand's goal crowns, the SAME parent
    // /audience-stats floors each audience against. Pre-caught → null on failure (never rejects
    // fail-loud Wave A; the columns then degrade to observed). Off-overview null (no spend block).
    includeSpend
      ? fetchSpendCostParentsSoft(brandId, featureSlug, headers, campaignId, pricing, requestedFunnel)
      : Promise.resolve<SpendCostParents>(null),
  ]);
  const { economics, source } = priced.economics;
  const breakdown: SpendBreakdown | null = typeof costResult === "number" ? null : costResult;
  // ROI/CAC + costEconomics ride ACTUAL (billed) spend; the `spend` block (buildSpend) carries the
  // committed total + provisioned separately. fetchRunsCostCents already returns actual.
  const actualCostInUsdCents = typeof costResult === "number" ? costResult : costResult.actualSpentCents;

  if (economics === null) {
    return emptyBody(null, actualCostInUsdCents, breakdown ? buildSpend(breakdown, [], counts, parents) : null, sequences);
  }
  const economicsSource: EconomicsSource = source === "user" ? "sales-economics" : "cross-brand-average";

  // Lensed overview: a fixed per-signal probability from sales economics. Uses ONLY Wave A
  // (economics + persons' clicked / positiveReply) — short-circuit BEFORE Wave B + the engine.
  if (lens) {
    return buildLensBody(lens, persons, economics, economicsSource, actualCostInUsdCents);
  }

  // ONLY THE LEGS OF THE FUNNELS BEING PRICED. A signal that is not a step of one of the brand's
  // declared chains contributes nothing — it is not decayed and not discounted, it is simply not a
  // priced path. The delivery milestones never enter here at all (they are a step of no chain, for
  // anybody) and reach the engine as `funnel.milestones`, which carry no revenue field to price.
  const paths = restrictPathsToDeclaredLegs(funnel.resolvePaths({ economics }), priced.pricedFunnelKeys);

  // ── Wave B: the two SECONDARY enrichment reads, in parallel — both need persons' emails
  // (from Wave A) but are independent of each other. Each is best-effort PER CALL (own catch →
  // warn + null): a failure degrades that overlay (dateless / no meeting-close dates) but does
  // NOT fail the endpoint (pipeline, orgs, leads stay correct). The two mutation loops below run
  // AFTER both settle, in the SAME order as before — concurrency only moves fetch timing, the
  // merge into persons is unchanged, so the response body is byte-identical.
  //   - fetchEventTimestamps  (email-gateway) — per-event dates for dates / time-series / events.
  //   - fetchQualifications   (instantly)     — meeting-booked / closed dates → the post-engagement
  //     stages (meeting, close-win as realized revenue). A known timestamp IS the signal.
  const emails = [...new Set(persons.map((p) => p.email).filter((e): e is string => Boolean(e)))];
  const [timestamps, quals] = await Promise.all([
    fetchEventTimestamps(brandId, campaignId, emails, headers).catch((err) => {
      console.warn(`[features-service] event-timestamp enrichment failed (degrading to dateless): ${(err as Error).message}`);
      return null;
    }),
    fetchQualifications(brandId, campaignId, emails, headers).catch((err) => {
      console.warn(`[features-service] qualification enrichment failed (degrading to no meeting/close dates): ${(err as Error).message}`);
      return null;
    }),
  ]);

  if (timestamps) {
    for (const person of persons) {
      const dates = person.email ? timestamps.get(person.email) : undefined;
      if (dates) {
        person.signalDates = {
          contacted: dates.contacted,
          sent: dates.sent,
          delivered: dates.delivered,
          open: dates.open,
          clicked: dates.clicked,
          positiveReply: dates.positiveReply,
        };
        // `open` has no boolean in the leads overlay — a known open timestamp IS the signal.
        if (dates.open) person.signals.open = true;
      }
    }
  }

  if (quals) {
    for (const person of persons) {
      const q = person.email ? quals.get(person.email) : undefined;
      if (!q) continue;
      person.signalDates = person.signalDates ?? {};
      if (q.meetingBookedAt) {
        person.signals.meeting = true;
        person.signalDates.meeting = q.meetingBookedAt;
      }
      if (q.closedAt) {
        person.signals.closeWin = true;
        person.signalDates.closeWin = q.closedAt;
      }
    }
  }

  // Per-lead SIGNUP / FORM-SUBMISSION outcome attribution (lead-service conversion tracker). The
  // producer matches each website conversion back to a lead we emailed and exposes the DISTINCT
  // matched-lead email set per event; a person whose (lowercased) email is in that set reached the
  // outcome — the SAME email-membership join audience-stats uses (real producer attribution, not a
  // split of the brand total). These signals do NOT feed the EV funnel (no funnel path triggers on
  // them) — pure per-lead display outcomes, like meetingBooked/purchased. NO date is set: lead-service
  // exposes the matched lead but not the conversion timestamp, so signalDates.signup/formSubmission
  // stay null (borrowing the outreach date would be the wrong signal) → the daily series reports these
  // leads as undated. Set BEFORE computeRevenue so the engine maps them onto leads[] (features-service#476).
  for (const person of persons) {
    const email = person.email?.trim().toLowerCase();
    if (!email) continue;
    if (conversionEmails.signup?.has(email)) person.signals.signup = true;
    if (conversionEmails.formSubmission?.has(email)) person.signals.formSubmission = true;
  }

  // closeValueUsd = LTR — the per-lead cap for combining independent engagement routes (click +
  // reply) as independent probabilities of one close (`undefined` keeps the wall-clock `now`).
  const result = computeRevenue(paths, persons, economics.lifetimeRevenueUsd, funnel.milestones);

  return {
    headline: { ...result.headline, economicsSource },
    costEconomics: buildCostEconomics(actualCostInUsdCents, result.headline.totalPipelineUsd),
    timeSeries: result.timeSeries,
    organizations: result.organizations,
    leads: result.leads,
    events: result.events,
    recipientsContacted: buildContactedSeries(result.leads),
    ...buildOutcomeSeries(result.leads),
    sequences,
    spend: breakdown ? buildSpend(breakdown, result.leads, counts, parents) : null,
  };
}

// ── GET /features/:featureSlug/revenue ───────────────────────────────────────
//
// Expected pipeline revenue for a feature, scoped to a brand (optionally one campaign).
// features-service is the single source: headline pipeline, organizations + leads tables,
// the cumulative time-series and the per-event ledger.
//
// With ?groupBy=campaignId the response collapses to one LEAN group per campaign that has runs
// for the brand+feature — { campaignId, campaignIdentity, headline.totalPipelineUsd, costEconomics }
// — so the dashboard campaigns list gets every campaign's revenue + ROI in ONE call instead of N.
// Each group's values are byte-equal to the standalone ?campaignId= call.
//
// BOTH forms report a campaign's IDENTITY total, not its row's: every campaign sharing (org, brand,
// sales funnel, acquisition channel) — campaign-service's own key — totals as ONE campaign, because
// that is what it is. campaign-service used to create a new campaign row every time workflow
// selection switched workflows, so one brand's two real campaigns arrived here as ~130 rows: dozens
// reading 0.0x / $0.00 beside the one row holding six weeks of history. The stopped rows are not
// rewritten, repointed or hidden — their runs and costs stay theirs in runs-service, and every id
// still answers, now with its identity's total. A brand with one campaign per identity is unchanged.
//
// `campaignIdentity` on each group names the family — its funnel (NULL when the campaign states
// none, which is a real state and stays distinguishable from a stated funnel), its channel, its
// members and the LIVE one a consumer renders the line on.

router.get("/features/:featureSlug/revenue", apiKeyAuth, async (req, res) => {
  const { featureSlug } = req.params;
  const { orgId, userId, runId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;
  const brandId = req.query.brandId as string | undefined;
  const campaignId = req.query.campaignId as string | undefined;
  const groupBy = req.query.groupBy as string | undefined;
  const lensParam = req.query.lens as string | undefined;
  const funnelParam = req.query.funnel as string | undefined;

  if (!brandId) {
    return res.status(400).json({ error: "brandId query parameter is required" });
  }

  // `?funnel=` names the SALES FUNNEL the spend block's cost-per-outcome columns are priced on — the
  // vocabulary a brand actually declares, and the only one that tells a meeting bought with a reply from
  // one bought with a click. Omitted → the brand's first declared funnel (never a default chain).
  // An unknown value 400s: a silent fall-back would answer about a chain the caller did not ask for.
  let requestedFunnel: SalesFunnelKey | undefined;
  if (funnelParam != null && funnelParam !== "") {
    const matched = matchSalesFunnelKey(funnelParam);
    if (!matched) {
      return res.status(400).json({ error: `funnel must be one of: ${SALES_FUNNEL_KEYS.join(", ")}` });
    }
    requestedFunnel = matched;
  }

  // Normalise every lens's fleet spellings (camel/kebab/legacy → canonical) before validating.
  //   single-step: websiteVisit → website_visits, positiveReply → positive_replies
  //   COMBINED sales: sales / combinedSales → sales
  //   website purchase (RENAMED former `sales` close funnel): websitePurchase / website_purchase /
  //     legacy `purchase` → website_purchase
  const singleStepLens = lensParam ? matchSingleStepGoal(lensParam) : null;
  const normalizedLens =
    singleStepLens === "websiteVisit" ? "website_visits"
      : singleStepLens === "positiveReply" ? "positive_replies"
      : lensParam && matchCombinedSalesGoal(lensParam) ? "sales"
      : lensParam && matchWebsitePurchaseGoal(lensParam) ? "website_purchase"
      : lensParam;
  if (normalizedLens !== undefined && !LENS_VALUES.includes(normalizedLens as Lens)) {
    return res.status(400).json({ error: `lens must be one of: ${LENS_VALUES.join(", ")}` });
  }
  const lens = normalizedLens as Lens | undefined;

  // GROSS (default) vs NET pricing. Omitted → gross → byte-identical to today.
  const pricing = parsePricing(req.query.pricing);
  if (pricing === null) {
    return res.status(400).json({ error: "pricing must be one of: gross, net" });
  }

  try {
    const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
    if (!feature) {
      return res.status(404).json({ error: "Feature not found" });
    }

    // NET reads runs#179's frozen net cost fields (no billing call, no read-time multiply); GROSS is
    // byte-identical. The selector is threaded straight into computeFeatureRevenue's cost reads.

    const headers: DownstreamHeaders = { orgId, userId, runId, featureSlug: headerFeatureSlug };
    // Resolved once and shared across every campaign — null when no funnel is wired for the feature.
    const funnel = getFunnel(featureSlug);

    // ROI / CAC / the whole EV pipeline are derived from the brand's economics, so the economics are read
    // LIVE on the request path and folded into the cache key. Without this, an onboarding write ("save my
    // sales economics") would keep replaying the PRE-write snapshot for up to the hard-stale cap, which is
    // the exact 25x-wrong-ROI bug #659 fixed for workflow-projection by reading economics live. Here the
    // key carries the fingerprint instead: different economics ⇒ different cell ⇒ guaranteed fresh compute.
    // The value is threaded into the compute as `economicsOverride`, so it costs ONE brand-service read.
    // Skipped entirely when no funnel is wired (computeFeatureRevenue short-circuits before Wave A and
    // ignores the override) — a feature with no funnel has no economics-derived output to go stale.
    // Priced on the DECLARED funnel (brand-wide only for the terms it does not state), so the
    // fingerprint below covers the funnel's own rates too — a funnel re-declaration lands on a new
    // cell instead of replaying a price the brand no longer states. The DECLARATION itself is read
    // once here and reused by every campaign group, so a group can narrow to its OWN campaign's chain
    // without a second brand-service call.
    const [declaredFunnels, brandEconomics] = funnel
      ? await Promise.all([fetchDeclaredFunnelsSoft(brandId, orgId), fetchEffectiveEconomics(brandId, headers)])
      : [[] as DeclaredSalesFunnel[], null];
    const brandPriced = brandEconomics ? priceOnDeclaredFunnel(declaredFunnels, brandEconomics, requestedFunnel) : undefined;
    const econ = brandPriced ? economicsFingerprint(brandPriced.economics) : undefined;
    // WHICH legs carry value is decided by the declared SET, which is not derivable from the economics
    // fingerprint (two brands can share rates and declare different chains), so it rides the key too.
    const decl = funnel ? declaredFunnels.map((f) => f.funnelKey).sort().join("+") || "none" : undefined;

    /**
     * The pricing for one campaign identity. A campaign states the chain it sells, so a campaign-scoped
     * read is priced on THAT chain — not on the brand's first declared one. An explicit `?funnel=`
     * still wins (the caller asked for a specific chain); a campaign that states none, or one the brand
     * no longer declares, falls back to the brand-level pick. Pure — reuses the one declaration read.
     */
    const pricingForIdentity = (identityFunnelKey: string | null | undefined): FunnelPricedEconomics | undefined => {
      if (!brandEconomics || !brandPriced) return undefined;
      if (requestedFunnel) return brandPriced;
      const stated = identityFunnelKey ? matchSalesFunnelKey(identityFunnelKey) : null;
      return stated ? priceOnDeclaredFunnel(declaredFunnels, brandEconomics, stated) : brandPriced;
    };

    // ── Grouped: one lean group per campaign (dashboard campaigns list) ──────────
    // Served through the Gold snapshot cache (O(1) read; the fan-out recomputes off-path ~per TTL).
    if (groupBy === "campaignId") {
      const payload = await servedCached({
        view: "revenue-grouped",
        scopeKey: buildScopeKey(featureSlug, { orgId, brandId, groupBy: "campaignId", pricing, econ, decl }),
        orgId,
        compute: async () => {
          const [campaignIds, families] = await Promise.all([
            fetchCampaignIdsWithRuns(brandId, featureSlug, headers),
            fetchCampaignFamiliesSoft(brandId, featureSlug, headers),
          ]);

          traceEvent(runId, { service: "features-service", event: "feature-revenue-grouped-start", detail: `featureSlug=${featureSlug}, brandId=${brandId}, campaigns=${campaignIds.length}` }, req.headers).catch(() => {});

          // ONE compute per IDENTITY, not per campaign row: the members of a family answer to the
          // same campaign, so recomputing per row would be the same figure N times. Every member id
          // still gets a group carrying it, so a consumer keyed on any campaign id keeps resolving.
          // Economics are brand-scoped (identical across campaigns) — resolved ONCE above and shared.
          const byIdentity = new Map<string, string[]>();
          for (const cid of campaignIds) {
            const key = families.identityOf(cid)?.key ?? `campaign:${cid}`;
            const bucket = byIdentity.get(key);
            if (bucket) bucket.push(cid);
            else byIdentity.set(key, [cid]);
          }

          const groups = (
            await Promise.all(
              [...byIdentity.values()].map(async (idsWithRuns) => {
                // The family's WHOLE membership scopes the compute — a member with no runs of its
                // own still belongs to the campaign, and dropping it would drop its leads.
                const identity = families.identityOf(idsWithRuns[0]);
                const scope = identity?.campaignIds ?? idsWithRuns;
                const body = await computeFeatureRevenue(featureSlug, brandId, scope, funnel, headers, undefined, pricingForIdentity(identity?.funnelKey), false, pricing, requestedFunnel);
                return idsWithRuns.map((cid) => ({
                  campaignId: cid,
                  campaignIdentity: describeIdentity(identity, cid),
                  headline: body.headline,
                  costEconomics: body.costEconomics,
                }));
              }),
            )
          ).flat();

          traceEvent(runId, { service: "features-service", event: "feature-revenue-grouped-done", detail: `featureSlug=${featureSlug}, groupCount=${groups.length}, identities=${byIdentity.size}` }, req.headers).catch(() => {});

          return { featureSlug, groupBy: "campaignId", groups };
        },
      });

      return res.json(payload);
    }

    // ── Overview / lens: single brand-scoped (optionally one-campaign) response ──
    //
    // A campaign-scoped read answers for the campaign's whole IDENTITY, so asking about any member
    // — the live row or one of its stopped ancestors — returns the same, complete campaign. Every
    // member therefore lands on ONE cache cell (keyed by the identity), instead of the dashboard
    // firing a separate full compute per rendered row.
    const identity = campaignId
      ? (await fetchCampaignFamiliesSoft(brandId, featureSlug, headers)).identityOf(campaignId)
      : null;
    const campaignScope: CampaignFilter = identity?.campaignIds ?? campaignId;

    const payload = await servedCached({
      view: lens ? "revenue-lens" : "revenue",
      scopeKey: buildScopeKey(featureSlug, {
        orgId,
        brandId,
        campaignId: identity?.key ?? campaignId,
        lens,
        // The funnel changes the cost basis of every cost-per-outcome column in the spend block, so it
        // MUST be in the key — keyed on the CANONICAL value the validator resolved, so a legacy spelling
        // shares one cell instead of fragmenting it. Absent → dropped → byte-identical to today's key.
        funnel: requestedFunnel,
        // WHICH legs carry value comes from the brand's declared SET, which no other key part encodes
        // (the identity key above carries the CAMPAIGN's funnel, and `econ` only the priced one's rates).
        decl,
        pricing,
        econ,
      }),
      orgId,
      compute: async () => {
        traceEvent(runId, { service: "features-service", event: "feature-revenue-start", detail: `featureSlug=${featureSlug}, brandId=${brandId}, campaignId=${campaignId ?? "none"}` }, req.headers).catch(() => {});

        // Overview (no lens) emits the canonical spend block; the lens path omits it (brand-total concept).
        const body = await computeFeatureRevenue(featureSlug, brandId, campaignScope, funnel, headers, lens, pricingForIdentity(campaignId ? identity?.funnelKey : null), !lens, pricing, requestedFunnel);

        traceEvent(runId, { service: "features-service", event: "feature-revenue-done", detail: `featureSlug=${featureSlug}, orgs=${body.organizations.length}, pipelineUsd=${body.headline.totalPipelineUsd}` }, req.headers).catch(() => {});

        return { featureSlug, ...body, campaignIdentity: campaignId ? describeIdentity(identity, campaignId) : undefined };
      },
    });

    res.json(payload);
  } catch (error) {
    console.error("[features-service] Feature revenue error:", error);
    if (runId) {
      traceEvent(runId, { service: "features-service", event: "feature-revenue-error", detail: error instanceof Error ? error.message : "Unknown error", level: "error" }, req.headers).catch(() => {});
    }
    res.status(502).json({ error: "Failed to compute feature revenue" });
  }
});

export default router;
