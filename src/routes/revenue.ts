import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { getFunnel, orP, type EconomicsSource, type SalesEconomics } from "../lib/funnel-registry.js";
import { fetchEffectiveEconomics, type EffectiveEconomics } from "../lib/sales-economics-client.js";
import { fetchLeadsForRevenue } from "../lib/leads-client.js";
import { fetchRunsCostCents, fetchCampaignIdsWithRuns } from "../lib/runs-cost-client.js";
import { fetchEventTimestamps } from "../lib/email-status-client.js";
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
 *   - totalCostUsd:          total run cost in dollars (same source as /stats systemStats), >= 0.
 *   - costOfAcquisitionPct:  (totalCostUsd / totalPipelineUsd) * 100; null when pipeline is null OR 0.
 *   - roiMultiple:           totalPipelineUsd / totalCostUsd; null when cost is 0 OR pipeline is null.
 *   - expectedConversions:   LENS ONLY — sum of per-lead conversion probability (decimal) across the
 *                            lensed leads (totalPipelineUsd = expectedConversions × LTR). Absent off-lens.
 *   - costPerConversionUsd:  LENS ONLY — totalCostUsd / expectedConversions; null when expectedConversions
 *                            is 0. Absent off-lens.
 */
export interface CostEconomics {
  totalCostUsd: number;
  costOfAcquisitionPct: number | null;
  roiMultiple: number | null;
  expectedConversions?: number;
  costPerConversionUsd?: number | null;
}

export function buildCostEconomics(totalCostInUsdCents: number, totalPipelineUsd: number | null): CostEconomics {
  const totalCostUsd = totalCostInUsdCents / 100;
  const costOfAcquisitionPct =
    totalPipelineUsd === null || totalPipelineUsd === 0 ? null : (totalCostUsd / totalPipelineUsd) * 100;
  const roiMultiple =
    totalCostUsd === 0 || totalPipelineUsd === null ? null : totalPipelineUsd / totalCostUsd;
  return { totalCostUsd, costOfAcquisitionPct, roiMultiple };
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
  outreachContacted: SignalSeries;
  /**
   * The Opens / Clicks / goal-outcome ACTUAL series for the Overview daily graph, each
   * server-computed from the SAME `leads[]` above — exactly like `outreachContacted` — so all four
   * actual series and the conversions table move together from one snapshot (features-service#377).
   * This replaces the old pipeline-activity / instantly event-day source, which bucketed raw events
   * (re-opens by already-advanced leads) decoupled from the contacted snapshot and produced
   * impossible states ("3 opens today while 0 outreach today"). Coherent by construction with
   * `outreachContacted` + the table: each series' total = sum(daily counts) + undatedCount =
   * count(leads carrying the signal), and no series can exceed the contacted snapshot.
   *   - opened         → Opens series   (email-gateway firstOpenedAt).
   *   - clicked        → Clicks series  (website-visit; ALSO the signup-goal outcome — a self-serve
   *     signup is downstream of the visit on the client's own site and is NOT tracked here, so the
   *     observed website visit is the coherent signup-funnel actual; the dashboard scales it by
   *     visitToSignupPct for the projected signups line, which stays a forecast).
   *   - meetingsBooked → the meeting-goal outcome (instantly manual-qualification meetingBookedAt).
   *   - purchased      → the purchase-goal outcome (instantly manual-qualification closedAt).
   */
  opened: SignalSeries;
  clicked: SignalSeries;
  meetingsBooked: SignalSeries;
  purchased: SignalSeries;
}

/**
 * The Opens / Clicks / meeting / purchase ACTUAL series, each built from the SAME `leads[]` snapshot
 * (mirrors `buildContactedSeries`). Coherent-by-construction with `outreachContacted` + the table.
 */
function buildOutcomeSeries(leads: LeadRow[]): Pick<RevenueBody, "opened" | "clicked" | "meetingsBooked" | "purchased"> {
  return {
    opened: buildSignalSeries(leads, (l) => l.opened, (l) => l.openedAt),
    clicked: buildSignalSeries(leads, (l) => l.clicked, (l) => l.clickedAt),
    meetingsBooked: buildSignalSeries(leads, (l) => l.meetingBooked, (l) => l.meetingBookedAt),
    purchased: buildSignalSeries(leads, (l) => l.purchased, (l) => l.purchasedAt),
  };
}

/** The revenue response body for one (brand, campaign?) scope — everything but the featureSlug. */
export type RevenueBody = Omit<RevenueResponse, "featureSlug">;

export type DownstreamHeaders = { orgId: string; userId?: string; runId?: string; featureSlug?: string };

function emptyBody(totalPipelineUsd: number | null, totalCostInUsdCents: number): RevenueBody {
  return {
    headline: { totalPipelineUsd, economicsSource: null },
    costEconomics: buildCostEconomics(totalCostInUsdCents, totalPipelineUsd),
    timeSeries: [],
    organizations: [],
    leads: [],
    events: [],
    outreachContacted: buildContactedSeries([]),
    ...buildOutcomeSeries([]),
  };
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
  totalCostInUsdCents: number,
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
      tags: lensTags(person.signals),
      expectedRevenueUsd: p * ltr,
      date: null,
      contacted: Boolean(person.signals.contacted),
      contactedAt: person.signalDates?.contacted ?? null,
      opened: Boolean(person.signals.open),
      openedAt: person.signalDates?.open ?? null,
      clicked: Boolean(person.signals.clicked),
      clickedAt: person.signalDates?.clicked ?? null,
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
  // expectedConversions × LTR. costPerConversionUsd = totalCostUsd / expectedConversions (null at 0).
  const expectedConversions = leads.reduce((sum, l) => sum + (l.conversionProbabilityPct ?? 0) / 100, 0);
  const costEconomics = buildCostEconomics(totalCostInUsdCents, totalPipelineUsd);
  return {
    headline: { totalPipelineUsd, economicsSource },
    costEconomics: {
      ...costEconomics,
      expectedConversions,
      costPerConversionUsd: expectedConversions === 0 ? null : costEconomics.totalCostUsd / expectedConversions,
    },
    timeSeries: [],
    organizations: [],
    leads,
    events: [],
    outreachContacted: buildContactedSeries(leads),
    ...buildOutcomeSeries(leads),
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
): Promise<RevenueBody> {
  // No funnel wired for this feature yet → null pipeline (not an error). `funnel` is known up
  // front (caller param), so short-circuit BEFORE Wave A and fetch ONLY the cost the empty body
  // needs — never over-fetching economics/rates/leads on the no-funnel path. Fail-loud: a
  // swallowed cost error must not fake $0 cost / infinite ROI.
  if (!funnel) {
    const totalCostInUsdCents = await fetchRunsCostCents(brandId, campaignId, featureSlug, headers);
    return emptyBody(null, totalCostInUsdCents);
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
  const [totalCostInUsdCents, { economics, source }, platformRates, persons] = await Promise.all([
    fetchRunsCostCents(brandId, campaignId, featureSlug, headers),
    economicsOverride ?? fetchEffectiveEconomics(brandId, { ...headers, campaignId }),
    fetchPlatformEmailRates(),
    fetchLeadsForRevenue(brandId, campaignId, headers),
  ]);

  if (economics === null) {
    return emptyBody(null, totalCostInUsdCents);
  }
  const economicsSource: EconomicsSource = source === "user" ? "sales-economics" : "cross-brand-average";

  // Lensed overview: a fixed per-signal probability from sales economics. Uses ONLY Wave A
  // (economics + persons' clicked / positiveReply) — short-circuit BEFORE Wave B + the engine.
  if (lens) {
    return buildLensBody(lens, persons, economics, economicsSource, totalCostInUsdCents);
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
    costEconomics: buildCostEconomics(totalCostInUsdCents, result.headline.totalPipelineUsd),
    timeSeries: result.timeSeries,
    organizations: result.organizations,
    leads: result.leads,
    events: result.events,
    outreachContacted: buildContactedSeries(result.leads),
    ...buildOutcomeSeries(result.leads),
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

        const body = await computeFeatureRevenue(featureSlug, brandId, campaignId, funnel, headers, lens);

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
