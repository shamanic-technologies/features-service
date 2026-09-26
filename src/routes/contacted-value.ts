/**
 * GET /brands/:brandId/contacted-value — what the brand's contacted-but-not-yet-engaged leads are worth
 * in expectation (`lib/contacted-value.ts`), per lead and as a company-level total.
 *
 * A SEPARATE figure: it is added to no pipeline, no ROI, no cost of acquisition and no existing body.
 * Priced on the byte-same inputs the brand's `/brands/:brandId/revenue` pipeline is priced on — the same
 * channels, the same funnel definition, the same declared-funnel economics and LTR, the same engine
 * paths restricted to the same legs, the same lead population and overlays — so a contacted lead that
 * engages moves onto the pipeline at the price this read was already forecasting through.
 *
 * Paged, because the largest brands hold 16k+ contacted leads: `?limit=` (1..5000, default 1000),
 * `?cursor=` (the `nextCursor` of the previous page), or `?leadIds=` (comma-separated, ≤1000) to price
 * exactly the cards a board shows. The summary rides every page.
 */
import { Router } from "express";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { getFunnel, restrictPathsToDeclaredLegs } from "../lib/funnel-registry.js";
import { fetchDeclaredFunnelsSoft, priceOnDeclaredFunnel, type DownstreamHeaders } from "./revenue.js";
import { distinctChannelFunnels } from "./offer-economics.js";
import { fetchEffectiveEconomics, economicsFingerprint } from "../lib/sales-economics-client.js";
import { resolveBrandChannels, brandFeatureSlugs, BrandHasNoChannelsError, type BrandChannel } from "../lib/brand-channels.js";
import type { DeclaredSalesFunnel } from "../lib/sales-funnels-client.js";
import type { EffectiveEconomics } from "../lib/sales-economics-client.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { fetchLeadsForRevenue } from "../lib/leads-client.js";
import { fetchEventTimestamps } from "../lib/email-status-client.js";
import { fetchObservedStepFacts, type ObservedStepFacts } from "../lib/observed-steps.js";
import { fetchQualifications } from "../lib/qualifications-client.js";
import { fetchConversionEmails } from "../lib/conversion-emails-client.js";
import { applySignalOverlays } from "../lib/signal-overlays.js";
import { dedupPersonsByLead, type EnginePerson, type ResolvedPath } from "../lib/revenue-engine.js";
import { DEFAULT_PRICED_CAUSES, type OutcomeCause } from "../lib/outcome-cause.js";
import { fetchPublicEmailStats } from "../lib/public-stats-clients.js";
import {
  priceContactedLeads,
  fleetEntryCountsOf,
  type ContactedValueResult,
  type FleetEntryCounts,
} from "../lib/contacted-value.js";

const router = Router();

export const CONTACTED_VALUE_DEFAULT_LIMIT = 1000;
export const CONTACTED_VALUE_MAX_LIMIT = 5000;
export const CONTACTED_VALUE_MAX_LEAD_IDS = 1000;

/** The brand-scoped reads a route makes to key its cache — handed down, never read twice. */
export interface BrandPricingPre {
  channels: BrandChannel[];
  declared: DeclaredSalesFunnel[];
  effective: EffectiveEconomics;
}

/**
 * The brand's lead population with every overlay the pipeline applies, plus the engine paths and LTR
 * it prices them on — the byte-same inputs `/brands/:brandId/revenue` prices its pipeline from. Shared
 * by every per-lead valuation read (contacted value, Deals column values) so none of them can come to
 * price a lead differently from the pipeline.
 */
export async function loadBrandPricedPopulation(
  brandId: string,
  headers: DownstreamHeaders,
  pre: BrandPricingPre,
  opts: {
    fleetEntryStats: boolean;
    /** Which cause states are PRICED (the pipeline's default: our outreach only). */
    pricedCauses?: readonly OutcomeCause[];
  },
): Promise<{
  persons: EnginePerson[];
  paths: ResolvedPath[];
  lifetimeRevenueUsd: number | null;
  fleetGroups: Map<string, Record<string, number>> | null;
  /** The step statements, per canonical email (null when unreadable). */
  observed: ObservedStepFacts | null;
}> {
  const { channels, declared, effective } = pre;
  const pricedCauses = opts.pricedCauses ?? DEFAULT_PRICED_CAUSES;
  const featureSlugs = brandFeatureSlugs(channels);
  const funnels = distinctChannelFunnels(channels);
  if (funnels.length > 1) throw new BrandPricesDifferentlyError(brandId);
  const funnel = funnels[0] ?? null;
  const measuredSlugs = featureSlugs.filter((slug) => getFunnel(slug) !== null);

  const soft = <T>(what: string, p: Promise<T>): Promise<T | null> =>
    p.catch((err) => {
      console.warn(`[features-service] brand lead valuation (brand ${brandId}): ${what} unreadable — degrading: ${(err as Error).message}`);
      return null;
    });

  const [persons, fleetGroups] = await Promise.all([
    fetchLeadsForRevenue(brandId, undefined, headers),
    opts.fleetEntryStats && measuredSlugs.length > 0
      ? soft("fleet email stats", fetchPublicEmailStats(measuredSlugs.join(","), "workflowSlug"))
      : Promise.resolve(null),
  ]);
  const priced = priceOnDeclaredFunnel(declared, effective);
  const economics = priced.economics.economics;

  const emails = [...new Set(persons.map((p) => p.email).filter((e): e is string => Boolean(e)))];
  const [timestamps, observed, quals, signupEmails, formEmails] = await Promise.all([
    soft("event timestamps", fetchEventTimestamps(brandId, undefined, emails, headers)),
    soft("observed step statements", fetchObservedStepFacts(brandId, pricedCauses)),
    soft("legacy qualifications", fetchQualifications(brandId, undefined, emails, headers)),
    soft("signup attribution", fetchConversionEmails(brandId, "signup")),
    soft("form-submission attribution", fetchConversionEmails(brandId, "form_submission")),
  ]);
  applySignalOverlays(persons, timestamps, observed?.byEmail ?? null, quals, priced.pricedFunnelKeys, pricedCauses);
  for (const person of persons) {
    const email = person.email?.trim().toLowerCase();
    if (!email) continue;
    if (signupEmails?.has(email)) person.signals.signup = true;
    if (formEmails?.has(email)) person.signals.formSubmission = true;
  }

  const paths =
    funnel && economics
      ? restrictPathsToDeclaredLegs(
          funnel.resolvePaths({ economics, pricedFunnelKeys: priced.pricedFunnelKeys }),
          priced.pricedFunnelKeys,
        )
      : [];
  return {
    persons: dedupPersonsByLead(persons),
    paths,
    lifetimeRevenueUsd: economics ? economics.lifetimeRevenueUsd : null,
    fleetGroups: fleetGroups as Map<string, Record<string, number>> | null,
    observed,
  };
}

/** The brand's figure, computed once per refresh (the Gold snapshot layer caches it). */
export async function computeBrandContactedValue(
  brandId: string,
  headers: DownstreamHeaders,
  /** The brand-scoped reads the route already made to key the cache — never read twice. */
  pre: BrandPricingPre,
): Promise<ContactedValueResult> {
  const { persons, paths, lifetimeRevenueUsd, fleetGroups } = await loadBrandPricedPopulation(brandId, headers, pre, {
    fleetEntryStats: true,
  });
  const fleet: FleetEntryCounts = fleetGroups ? fleetEntryCountsOf(fleetGroups.values()) : null;
  return priceContactedLeads({ paths, persons, lifetimeRevenueUsd, fleet });
}

export class BrandPricesDifferentlyError extends Error {
  constructor(readonly brandId: string) {
    super(`brand ${brandId} runs channels that price on different funnels, so its contacted leads cannot be priced as one figure`);
    this.name = "BrandPricesDifferentlyError";
  }
}

type PageQuery = { limit: number; offset: number; leadIds: string[] | null };

/** PURE. Parse the paging parameters, or a 400 message. */
export function parseContactedValuePage(query: Record<string, unknown>): PageQuery | { error: string } {
  const raw = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
  const limitRaw = raw(query.limit);
  const limit = limitRaw === undefined ? CONTACTED_VALUE_DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > CONTACTED_VALUE_MAX_LIMIT) {
    return { error: `limit must be an integer from 1 to ${CONTACTED_VALUE_MAX_LIMIT}` };
  }
  const cursorRaw = raw(query.cursor);
  const offset = cursorRaw === undefined ? 0 : Number(cursorRaw);
  if (!Number.isInteger(offset) || offset < 0) return { error: "cursor must be the nextCursor of a previous page" };
  const idsRaw = raw(query.leadIds);
  const leadIds = idsRaw === undefined ? null : [...new Set(idsRaw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (leadIds && leadIds.length > CONTACTED_VALUE_MAX_LEAD_IDS) {
    return { error: `leadIds may name at most ${CONTACTED_VALUE_MAX_LEAD_IDS} leads` };
  }
  if (leadIds && cursorRaw !== undefined) return { error: "leadIds and cursor cannot be combined" };
  return { limit, offset, leadIds };
}

/** PURE. The served body: the summary plus one page of lead rows. */
export function pageContactedValue(result: ContactedValueResult, page: PageQuery) {
  const { leads, ...summary } = result;
  if (page.leadIds) {
    const wanted = new Set(page.leadIds);
    return { ...summary, leads: leads.filter((l) => wanted.has(l.leadId)), nextCursor: null };
  }
  const slice = leads.slice(page.offset, page.offset + page.limit);
  const next = page.offset + page.limit;
  return { ...summary, leads: slice, nextCursor: next < leads.length ? String(next) : null };
}

router.get("/brands/:brandId/contacted-value", apiKeyAuth, async (rawReq, res) => {
  const req = rawReq as unknown as AuthenticatedRequest;
  const brandId = rawReq.params.brandId as string;
  const page = parseContactedValuePage(req.query as Record<string, unknown>);
  if ("error" in page) return res.status(400).json({ error: page.error });
  const headers: DownstreamHeaders = { orgId: req.orgId, userId: req.userId, runId: req.runId };
  try {
    // Keyed on what moves the figure without a query parameter moving: the channel set, the declared
    // funnels and the economics (an economics write lands on a new cell, never replays the old price).
    const channels = await resolveBrandChannels(brandId, headers);
    const [declared, effective] = await Promise.all([
      fetchDeclaredFunnelsSoft(brandId, headers.orgId),
      fetchEffectiveEconomics(brandId, headers),
    ]);
    const priced = priceOnDeclaredFunnel(declared, effective);
    const result = await servedCached({
      view: "brand-contacted-value",
      scopeKey: buildScopeKey(brandId, {
        orgId: headers.orgId,
        channels: brandFeatureSlugs(channels).join("+"),
        decl: declared.map((f) => f.funnelKey).sort().join("+") || "none",
        econ: economicsFingerprint(priced.economics),
        m: "contacted-value-v1",
      }),
      orgId: headers.orgId,
      compute: () => computeBrandContactedValue(brandId, headers, { channels, declared, effective }),
    });
    return res.json({ brandId, ...pageContactedValue(result, page) });
  } catch (error) {
    if (error instanceof BrandHasNoChannelsError) {
      return res.status(404).json({ error: error.message, reason: "brand_has_no_channels", brandId });
    }
    if (error instanceof BrandPricesDifferentlyError) {
      return res.status(409).json({ error: error.message, reason: "brand_channels_price_differently", brandId });
    }
    console.error(`[features-service] Brand contacted value error:`, error);
    return res.status(502).json({ error: "Failed to compute brand contacted value" });
  }
});

export default router;
