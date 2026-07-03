import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { getFunnel, orP, type EconomicsSource, type SalesEconomics } from "../lib/funnel-registry.js";
import { fetchEffectiveEconomics, type EffectiveEconomics } from "../lib/sales-economics-client.js";
import { fetchLeadsForRevenue } from "../lib/leads-client.js";
import { fetchRunsCostCents, fetchCampaignIdsWithRuns } from "../lib/runs-cost-client.js";
import { fetchSpendBreakdown, type SpendBreakdown, type SpendSource } from "../lib/spend-client.js";
import { fetchEventTimestamps } from "../lib/email-status-client.js";
import { fetchSequencesByDay } from "../lib/sequences-client.js";
import { fetchQualifications } from "../lib/qualifications-client.js";
import { fetchPlatformEmailRates } from "../lib/platform-rates-client.js";
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
 * Null-safe (mirrors the per-audience metrics.cpcCents convention): a ratio is null (renders "-"), never
 * a false $0.00, when its denominator OR the attributed spend is 0.
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
}

function buildSpend(breakdown: SpendBreakdown, leads: LeadRow[]): Spend {
  // clicks use the SAME per-lead predicate as the clicked SignalSeries, so the CPC denominator equals
  // the card's displayed "clicks" (clicked.total) — coherent by construction.
  const clicks = leads.reduce((n, l) => n + (l.clicked ? 1 : 0), 0);
  const committed = breakdown.totalSpentCents;
  const actual = breakdown.actualSpentCents;
  const provisioned = breakdown.provisionedSpentCents;

  const ratioCents = (cents: number): number | null => (cents > 0 && clicks > 0 ? cents / clicks : null);

  return {
    totalSpentCents: committed,
    actualSpentCents: actual,
    provisionedSpentCents: provisioned,
    totalSpentTodayCents: breakdown.totalSpentTodayCents,
    actualSpentTodayCents: breakdown.actualSpentTodayCents,
    provisionedSpentTodayCents: breakdown.provisionedSpentTodayCents,
    sources: breakdown.sources,
    totalCpcCents: ratioCents(committed),
    actualCpcCents: ratioCents(actual),
    provisionedCpcCents: ratioCents(provisioned),
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
   */
  recipientsOpened: SignalSeries;
  recipientsClicked: SignalSeries;
  recipientsRepliesPositive: SignalSeries;
  meetingsBooked: SignalSeries;
  purchased: SignalSeries;
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
function buildOutcomeSeries(leads: LeadRow[]): Pick<RevenueBody, "recipientsOpened" | "recipientsClicked" | "recipientsRepliesPositive" | "meetingsBooked" | "purchased"> {
  return {
    recipientsOpened: buildSignalSeries(leads, (l) => l.opened, (l) => l.openedAt),
    recipientsClicked: buildSignalSeries(leads, (l) => l.clicked, (l) => l.clickedAt),
    recipientsRepliesPositive: buildSignalSeries(leads, (l) => l.repliedPositive, (l) => l.repliedPositiveAt),
    meetingsBooked: buildSignalSeries(leads, (l) => l.meetingBooked, (l) => l.meetingBookedAt),
    purchased: buildSignalSeries(leads, (l) => l.purchased, (l) => l.purchasedAt),
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
  campaignId: string | undefined,
  featureSlug: string,
  headers: DownstreamHeaders,
): Promise<SignalSeries | null> {
  return fetchSequencesByDay(brandId, campaignId, featureSlug, headers).catch((err) => {
    console.warn(
      `[features-service] sequences enrichment failed (degrading to null): ${(err as Error).message}`,
    );
    return null;
  });
}

// ── Outcome lenses (dashboard Signups / Booked Meetings / Sales tabs) ─────────
//
// A lens segments the revenue overview to ONE outcome and attaches a per-lead conversion
// probability. The probability is a FIXED per-signal rate from the brand's sales economics — NOT
// the furthest-stage EV engine (no decay, no platform funnel rates). It reuses the SAME orP channel
// model as `salesFunnel`: the sales-lens pClick/pReply below are byte-identical to its
// pCloseClick/pCloseReply, just expressed as probabilities instead of dollars.
export type Lens = "signups" | "booked-meetings" | "sales";
export const LENS_VALUES: readonly Lens[] = ["signups", "booked-meetings", "sales"];

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
 */
function lensProbability(lens: Lens, signals: Record<string, boolean>, e: SalesEconomics): number | null {
  const clicked = Boolean(signals.clicked);
  const positiveReply = Boolean(signals.positiveReply);
  switch (lens) {
    case "signups":
      return clicked ? pct(e.visitToSignupPct) : null;
    case "booked-meetings":
      return positiveReply ? pct(e.replyToMeetingPct) : null;
    case "sales": {
      if (!clicked && !positiveReply) return null;
      const pClick = orP(pct(e.visitToClosePct), pct(e.visitToMeetingPct) * pct(e.meetingToClosePct));
      const pReply = pct(e.replyToMeetingPct) * pct(e.meetingToClosePct);
      if (clicked && positiveReply) return orP(pClick, pReply);
      return clicked ? pClick : pReply;
    }
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
      repliedPositiveAt: person.signalDates?.positiveReply ?? null,
      meetingBooked: Boolean(person.signals.meeting),
      meetingBookedAt: person.signalDates?.meeting ?? null,
      purchased: Boolean(person.signals.closeWin),
      purchasedAt: person.signalDates?.closeWin ?? null,
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
 * for dates / time-series / events / post-engagement decay / close-win: if a call fails we log and
 * degrade (the pipeline total, orgs and leads stay correct) rather than failing the whole endpoint.
 */
export async function computeFeatureRevenue(
  featureSlug: string,
  brandId: string,
  campaignId: string | undefined,
  funnel: ReturnType<typeof getFunnel>,
  headers: DownstreamHeaders,
  lens?: Lens,
  // Brand-scoped economics are identical across a brand's campaigns (brand-service serves them
  // per brand, not per campaign). The grouped path fetches them ONCE and passes the result here
  // so N campaigns don't each re-hit brand-service. Omitted → fetched in Wave A as before.
  economicsOverride?: EffectiveEconomics,
  // When true (the unlensed Overview path), fetch the canonical spend breakdown (per-source actual +
  // today) and emit the `spend` block. The grouped per-campaign path and the lens path pass false:
  // groups discard spend, and lens omits it (a brand-total concept). When false we use the cheaper
  // single-total fetchRunsCostCents; both read the SAME runs ACTUAL spend, so costEconomics agrees.
  includeSpend = false,
): Promise<RevenueBody> {
  // No funnel wired for this feature yet → null pipeline (not an error). `funnel` is known up
  // front (caller param), so short-circuit BEFORE Wave A and fetch ONLY the cost the empty body
  // needs — never over-fetching economics/rates/leads on the no-funnel path. Fail-loud: a
  // swallowed cost error must not fake $0 cost / infinite ROI.
  if (!funnel) {
    if (includeSpend) {
      // Overview: fetch spend (fail-loud) + sequences (fail-soft) in parallel. Outreach activity
      // is independent of the funnel — a no-funnel feature still launches campaigns worth graphing.
      const [breakdown, sequences] = await Promise.all([
        fetchSpendBreakdown(brandId, campaignId, featureSlug, headers),
        fetchSequencesSoft(brandId, campaignId, featureSlug, headers),
      ]);
      // ROI/CAC ride ACTUAL spend; the `spend` block carries the committed total separately.
      return emptyBody(null, breakdown.actualSpentCents, buildSpend(breakdown, []), sequences);
    }
    const actualCostInUsdCents = await fetchRunsCostCents(brandId, campaignId, featureSlug, headers);
    return emptyBody(null, actualCostInUsdCents, null);
  }

  // ── Wave A: the four downstream reads with NO data dependency on each other, in parallel.
  //   - fetchRunsCostCents     (runs-service)   — total feature-scoped cost, on every body.
  //   - fetchEffectiveEconomics(brand-service)  — rates + terminal LTR; brand-service OWNS the
  //     null→cross-brand-average defaulting + provenance ("user" = saved "sales-economics";
  //     else "cross-brand-average", an ESTIMATE). economics is null only at cold start → null pipeline.
  //   - fetchPlatformEmailRates(cached)         — platform-global funnel rates; lets a lead earn
  //     from its furthest reached stage (Contacted onward), not only a click / positive reply.
  //   - fetchLeadsForRevenue   (lead-service)   — the per-lead overlay (persons).
  // All four are fail-loud (Promise.all rejects → the endpoint 502s): each is a core input to the
  // pipeline total / cost / ROI; a swallowed error would fake a number. The economics===null
  // cold-start path below over-fetches rates+leads — accepted for the common-path win.
  const [costResult, { economics, source }, platformRates, persons, sequences] = await Promise.all([
    includeSpend
      ? fetchSpendBreakdown(brandId, campaignId, featureSlug, headers)
      : fetchRunsCostCents(brandId, campaignId, featureSlug, headers),
    economicsOverride ?? fetchEffectiveEconomics(brandId, { ...headers, campaignId }),
    fetchPlatformEmailRates(),
    fetchLeadsForRevenue(brandId, campaignId, headers),
    // Overview-only sequences day series (email-gateway groupBy=day). Pre-caught → resolves to
    // null on failure, so it never rejects fail-loud Wave A. Off-overview it's null (not fetched).
    includeSpend
      ? fetchSequencesSoft(brandId, campaignId, featureSlug, headers)
      : Promise.resolve<SignalSeries | null>(null),
  ]);
  const breakdown: SpendBreakdown | null = typeof costResult === "number" ? null : costResult;
  // ROI/CAC + costEconomics ride ACTUAL (billed) spend; the `spend` block (buildSpend) carries the
  // committed total + provisioned separately. fetchRunsCostCents already returns actual.
  const actualCostInUsdCents = typeof costResult === "number" ? costResult : costResult.actualSpentCents;

  if (economics === null) {
    return emptyBody(null, actualCostInUsdCents, breakdown ? buildSpend(breakdown, []) : null, sequences);
  }
  const economicsSource: EconomicsSource = source === "user" ? "sales-economics" : "cross-brand-average";

  // Lensed overview: a fixed per-signal probability from sales economics. Uses ONLY Wave A
  // (economics + persons' clicked / positiveReply) — short-circuit BEFORE Wave B + the engine.
  if (lens) {
    return buildLensBody(lens, persons, economics, economicsSource, actualCostInUsdCents);
  }

  const paths = funnel.resolvePaths({ economics, platformRates });

  // ── Wave B: the two SECONDARY enrichment reads, in parallel — both need persons' emails
  // (from Wave A) but are independent of each other. Each is best-effort PER CALL (own catch →
  // warn + null): a failure degrades that overlay (dateless / no meeting-close dates) but does
  // NOT fail the endpoint (pipeline, orgs, leads stay correct). The two mutation loops below run
  // AFTER both settle, in the SAME order as before — concurrency only moves fetch timing, the
  // merge into persons is unchanged, so the response body is byte-identical.
  //   - fetchEventTimestamps  (email-gateway) — per-event dates for dates / time-series / events.
  //   - fetchQualifications   (instantly)     — meeting-booked / closed dates → Phase 2 decay
  //     (reply → meeting → close) + close-win as realized revenue. A known timestamp IS the signal.
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

  // closeValueUsd = LTR — the per-lead cap for combining independent engagement routes (click +
  // reply) as independent probabilities of one close (`undefined` keeps the wall-clock `now`).
  const result = computeRevenue(paths, persons, undefined, economics.lifetimeRevenueUsd);

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
    spend: breakdown ? buildSpend(breakdown, result.leads) : null,
  };
}

// ── GET /features/:featureSlug/revenue ───────────────────────────────────────
//
// Expected pipeline revenue for a feature, scoped to a brand (optionally one campaign).
// features-service is the single source: headline pipeline, organizations + leads tables,
// the cumulative time-series and the per-event ledger.
//
// With ?groupBy=campaignId the response collapses to one LEAN group per campaign that has runs
// for the brand+feature — { campaignId, headline.totalPipelineUsd, costEconomics } only — so the
// dashboard campaigns list gets every campaign's revenue + ROI in ONE call instead of N. Each
// group's values are byte-equal to the standalone ?campaignId= call (same per-campaign compute).

router.get("/features/:featureSlug/revenue", apiKeyAuth, async (req, res) => {
  const { featureSlug } = req.params;
  const { orgId, userId, runId, featureSlug: headerFeatureSlug } = req as AuthenticatedRequest;
  const brandId = req.query.brandId as string | undefined;
  const campaignId = req.query.campaignId as string | undefined;
  const groupBy = req.query.groupBy as string | undefined;
  const lensParam = req.query.lens as string | undefined;

  if (!brandId) {
    return res.status(400).json({ error: "brandId query parameter is required" });
  }

  if (lensParam !== undefined && !LENS_VALUES.includes(lensParam as Lens)) {
    return res.status(400).json({ error: `lens must be one of: ${LENS_VALUES.join(", ")}` });
  }
  const lens = lensParam as Lens | undefined;

  try {
    const feature = await db.query.features.findFirst({ where: eq(features.slug, featureSlug) });
    if (!feature) {
      return res.status(404).json({ error: "Feature not found" });
    }

    const headers: DownstreamHeaders = { orgId, userId, runId, featureSlug: headerFeatureSlug };
    // Resolved once and shared across every campaign — null when no funnel is wired for the feature.
    const funnel = getFunnel(featureSlug);

    // ── Grouped: one lean group per campaign (dashboard campaigns list) ──────────
    // Served through the Gold snapshot cache (O(1) read; the fan-out recomputes off-path ~per TTL).
    if (groupBy === "campaignId") {
      const payload = await servedCached({
        view: "revenue-grouped",
        scopeKey: buildScopeKey(featureSlug, { orgId, brandId, groupBy: "campaignId" }),
        orgId,
        compute: async () => {
          const campaignIds = await fetchCampaignIdsWithRuns(brandId, featureSlug, headers);

          traceEvent(runId, { service: "features-service", event: "feature-revenue-grouped-start", detail: `featureSlug=${featureSlug}, brandId=${brandId}, campaigns=${campaignIds.length}` }, req.headers).catch(() => {});

          // Economics are brand-scoped (identical across campaigns) — fetch ONCE and share, so N
          // campaigns don't each re-hit brand-service. Skipped entirely when no funnel is wired
          // (computeFeatureRevenue short-circuits before Wave A and ignores the override).
          const sharedEconomics = funnel ? await fetchEffectiveEconomics(brandId, headers) : undefined;

          const groups = await Promise.all(
            campaignIds.map(async (cid) => {
              const body = await computeFeatureRevenue(featureSlug, brandId, cid, funnel, headers, undefined, sharedEconomics);
              return { campaignId: cid, headline: body.headline, costEconomics: body.costEconomics };
            }),
          );

          traceEvent(runId, { service: "features-service", event: "feature-revenue-grouped-done", detail: `featureSlug=${featureSlug}, groupCount=${groups.length}` }, req.headers).catch(() => {});

          return { featureSlug, groupBy: "campaignId", groups };
        },
      });

      return res.json(payload);
    }

    // ── Overview / lens: single brand-scoped (optionally one-campaign) response ──
    const payload = await servedCached({
      view: lens ? "revenue-lens" : "revenue",
      scopeKey: buildScopeKey(featureSlug, { orgId, brandId, campaignId, lens }),
      orgId,
      compute: async () => {
        traceEvent(runId, { service: "features-service", event: "feature-revenue-start", detail: `featureSlug=${featureSlug}, brandId=${brandId}, campaignId=${campaignId ?? "none"}` }, req.headers).catch(() => {});

        // Overview (no lens) emits the canonical spend block; the lens path omits it (brand-total concept).
        const body = await computeFeatureRevenue(featureSlug, brandId, campaignId, funnel, headers, lens, undefined, !lens);

        traceEvent(runId, { service: "features-service", event: "feature-revenue-done", detail: `featureSlug=${featureSlug}, orgs=${body.organizations.length}, pipelineUsd=${body.headline.totalPipelineUsd}` }, req.headers).catch(() => {});

        return { featureSlug, ...body };
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
