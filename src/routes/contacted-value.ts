/**
 * GET /brands/:brandId/contacted-value — what the brand's contacted-but-not-yet-engaged leads are worth
 * in expectation (`lib/contacted-value.ts`), per lead and as a company-level total.
 *
 * The SAME figure the pipeline counts for these leads (their value is added to the pipeline and the
 * ROI at every grain, until the lead's last send is 30 days old — `lib/revenue-engine.ts`). Priced on the byte-same inputs the brand's `/brands/:brandId/revenue` pipeline is priced on — the same
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
import { restrictPathsToDeclaredLegs } from "../lib/funnel-registry.js";
import { fetchDeclaredFunnelsSoft, priceOnDeclaredFunnel, type DownstreamHeaders } from "./revenue.js";
import { distinctChannelFunnels } from "./offer-economics.js";
import { fetchEffectiveEconomics, economicsFingerprint } from "../lib/sales-economics-client.js";
import { resolveBrandChannels, brandFeatureSlugs, BrandHasNoChannelsError, type BrandChannel } from "../lib/brand-channels.js";
import type { DeclaredSalesFunnel } from "../lib/sales-funnels-client.js";
import type { EffectiveEconomics } from "../lib/sales-economics-client.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { fetchLeadsForRevenue } from "../lib/leads-client.js";
import { singleCampaignId } from "../lib/campaign-scope.js";
import { fetchEventTimestamps } from "../lib/email-status-client.js";
import { fetchObservedStepFacts, type ObservedStepFacts } from "../lib/observed-steps.js";
import { fetchQualifications } from "../lib/qualifications-client.js";
import { fetchConversionEmails } from "../lib/conversion-emails-client.js";
import { applySignalOverlays } from "../lib/signal-overlays.js";
import {
  contactedExpiryCutoffIso,
  dedupPersonsByLead,
  type ContactedPricing,
  type EnginePerson,
  type ResolvedPath,
} from "../lib/revenue-engine.js";
import { DEFAULT_PRICED_CAUSES, type OutcomeCause } from "../lib/outcome-cause.js";
import { fetchPublicWorkflows } from "../lib/public-stats-clients.js";
import { dynastyOfSlug } from "../lib/workflow-scope.js";
import { fetchBrandCampaignRows } from "../lib/campaign-identity-client.js";
import { fetchRunsCommittedCentsByCampaignWorkflow } from "../lib/runs-cost-client.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { runLadder, dynastyPriceFromLadder, type LadderBody } from "../lib/leg-ladder.js";
import {
  priceContactedLeads,
  contactedEntryLegs,
  contactedEntryRatesByGroup,
  contactedGroupsOf,
  type ContactedGroupInput,
  type ContactedRoutePrice,
  type ContactedValueResult,
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
    /** Which cause states are PRICED (the pipeline's default: our outreach only). */
    pricedCauses?: readonly OutcomeCause[];
    /**
     * The OFFER grain: only the leads served on these campaigns (the offer's, across every channel), read
     * exactly as `/offers/:offerId/revenue` reads them. Omitted → the whole brand (byte-unchanged).
     */
    campaignIds?: string[];
  },
): Promise<{
  persons: EnginePerson[];
  paths: ResolvedPath[];
  lifetimeRevenueUsd: number | null;
  /** The step statements, per canonical email (null when unreadable). */
  observed: ObservedStepFacts | null;
}> {
  const { channels, declared, effective } = pre;
  const pricedCauses = opts.pricedCauses ?? DEFAULT_PRICED_CAUSES;
  const funnels = distinctChannelFunnels(channels);
  if (funnels.length > 1) throw new BrandPricesDifferentlyError(brandId);
  const funnel = funnels[0] ?? null;

  const soft = <T>(what: string, p: Promise<T>): Promise<T | null> =>
    p.catch((err) => {
      console.warn(`[features-service] brand lead valuation (brand ${brandId}): ${what} unreadable — degrading: ${(err as Error).message}`);
      return null;
    });

  const persons = await fetchLeadsForRevenue(brandId, opts.campaignIds, headers);
  const priced = priceOnDeclaredFunnel(declared, effective);
  const economics = priced.economics.economics;

  const emails = [...new Set(persons.map((p) => p.email).filter((e): e is string => Boolean(e)))];
  // The same per-campaign narrowing the revenue engine applies to its two campaign-keyed overlays.
  const campaignId = singleCampaignId(opts.campaignIds);
  const [timestamps, observed, quals, signupEmails, formEmails] = await Promise.all([
    soft("event timestamps", fetchEventTimestamps(brandId, campaignId, emails, headers)),
    soft("observed step statements", fetchObservedStepFacts(brandId, pricedCauses)),
    soft("legacy qualifications", fetchQualifications(brandId, campaignId, emails, headers)),
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
    observed,
  };
}

/**
 * What one (campaign × workflow) group's leads cost per outcome on each entry route, and what the group
 * spent — the inputs `priceContactedLeads` turns into P(entry | contacted, group). The price is the
 * leg-keyed workflow-projection ladder `/offers/:offerId/sales-paths` reads (`?leg=&offerId=&pricing=net`,
 * the campaign's channel), on the dynasty of the workflow that served the leads; the spend is runs'
 * committed spend on the same NET basis (the basis the dashboard's "$ Invested" and the ladder read).
 * Campaign rows and spend are fail-loud (the cell fails, the pipeline read degrades loudly); a ladder
 * or a workflow catalogue that cannot answer leaves ITS groups unpriced with a named reason.
 */
async function priceContactedGroups(
  brandId: string,
  headers: DownstreamHeaders,
  featureSlugs: string[],
  persons: EnginePerson[],
  paths: ResolvedPath[],
): Promise<ContactedGroupInput[]> {
  const groups = [...contactedGroupsOf(persons).values()];
  const legs = contactedEntryLegs(paths);
  if (groups.length === 0 || legs.length === 0) return [];
  const identity = { orgId: headers.orgId, userId: headers.userId ?? "", runId: headers.runId ?? "" };

  const [campaignRows, spendCents] = await Promise.all([
    fetchBrandCampaignRows(brandId, undefined, headers),
    fetchRunsCommittedCentsByCampaignWorkflow(brandId, featureSlugs, headers, "net"),
  ]);
  const campaignById = new Map(campaignRows.map((c) => [c.id, c]));

  // Slug → dynasty, per channel the groups' campaigns run on.
  const groupFeature = (campaignId: string) => campaignById.get(campaignId)?.featureSlug ?? null;
  const features = [...new Set(groups.map((g) => groupFeature(g.campaignId)).filter((f): f is string => f !== null))];
  const dynastyOf = new Map<string, ((slug: string) => string) | null>();
  await Promise.all(
    features.map(async (featureSlug) => {
      try {
        dynastyOf.set(featureSlug, dynastyOfSlug(await fetchPublicWorkflows(featureSlug, "all")));
      } catch (err) {
        console.error(
          `[features-service] contacted value (brand ${brandId}): workflow catalogue of ${featureSlug} unreadable — its groups unpriced: ${(err as Error).message}`,
        );
        dynastyOf.set(featureSlug, null);
      }
    }),
  );

  // One ladder per (channel, offer, leg) actually needed.
  const ladderKey = (featureSlug: string, offerId: string | null, legKey: string) => `${featureSlug}|${offerId ?? ""}|${legKey}`;
  const needed = new Map<string, { featureSlug: string; offerId: string | null; legKey: string }>();
  for (const g of groups) {
    const row = campaignById.get(g.campaignId);
    const featureSlug = row?.featureSlug ?? null;
    if (!featureSlug || !dynastyOf.get(featureSlug)) continue;
    for (const { legKey } of legs) {
      needed.set(ladderKey(featureSlug, row?.offerId ?? null, legKey), { featureSlug, offerId: row?.offerId ?? null, legKey });
    }
  }
  const ladders = new Map<string, { status: number; body: LadderBody } | null>();
  await mapWithConcurrency([...needed.entries()], 4, async ([key, { featureSlug, offerId, legKey }]) => {
    const query: Record<string, string> = { brandId, leg: legKey, pricing: "net" };
    if (offerId) query.offerId = offerId;
    try {
      const answer = await runLadder(identity, featureSlug, query);
      if (answer.status !== 200) {
        console.error(
          `[features-service] contacted value (brand ${brandId}): ladder ${featureSlug}/${legKey}${offerId ? ` offer ${offerId}` : ""} answered ${answer.status} (${answer.body.reason ?? "no reason"}) — its groups unpriced on that route`,
        );
      }
      ladders.set(key, answer);
    } catch (err) {
      console.error(
        `[features-service] contacted value (brand ${brandId}): ladder ${featureSlug}/${legKey} failed — its groups unpriced on that route: ${(err as Error).message}`,
      );
      ladders.set(key, null);
    }
  });

  return groups.map((g) => {
    const row = campaignById.get(g.campaignId);
    const featureSlug = row?.featureSlug ?? null;
    const offerId = row?.offerId ?? null;
    const toDynasty = featureSlug ? dynastyOf.get(featureSlug) : null;
    const workflowDynastySlug = toDynasty ? toDynasty(g.workflowSlug) : null;
    const prices: Record<string, ContactedRoutePrice> = {};
    for (const { signal, legKey } of legs) {
      if (!row) prices[signal] = { costPerOutcomeUsd: null, unpricedReason: "campaign_unknown" };
      else if (!featureSlug) prices[signal] = { costPerOutcomeUsd: null, unpricedReason: "campaign_states_no_channel" };
      else if (!workflowDynastySlug) prices[signal] = { costPerOutcomeUsd: null, unpricedReason: "workflow_catalogue_unreadable" };
      else {
        const ladder = ladders.get(ladderKey(featureSlug, offerId, legKey));
        prices[signal] = ladder
          ? dynastyPriceFromLadder(ladder.status, ladder.body, workflowDynastySlug)
          : { costPerOutcomeUsd: null, unpricedReason: "ladder_failed" };
      }
    }
    const cents = spendCents.get(`${g.campaignId}|${g.workflowSlug}`);
    return {
      campaignId: g.campaignId,
      workflowSlug: g.workflowSlug,
      offerId,
      featureSlug,
      workflowDynastySlug,
      committedSpentUsd: cents === undefined ? null : cents / 100,
      prices,
    };
  });
}

/** The brand's figure, computed once per refresh (the Gold snapshot layer caches it). */
export async function computeBrandContactedValue(
  brandId: string,
  headers: DownstreamHeaders,
  /** The brand-scoped reads the route already made to key the cache — never read twice. */
  pre: BrandPricingPre,
): Promise<ContactedValueResult> {
  const { persons, paths, lifetimeRevenueUsd } = await loadBrandPricedPopulation(brandId, headers, pre, {});
  const groups = await priceContactedGroups(brandId, headers, brandFeatureSlugs(pre.channels), persons, paths);
  return priceContactedLeads({ paths, persons, lifetimeRevenueUsd, groups });
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

/**
 * The brand's contacted-value figure through its ONE Gold cell — shared by this route and by every
 * pipeline read (`contactedPricingSoft`), so the Contacted column and the pipeline can never be priced
 * off two different entry rates.
 */
export async function getBrandContactedValue(brandId: string, headers: DownstreamHeaders): Promise<ContactedValueResult> {
  // Keyed on what moves the figure without a query parameter moving: the channel set, the declared
  // funnels and the economics (an economics write lands on a new cell, never replays the old price).
  const channels = await resolveBrandChannels(brandId, headers);
  const [declared, effective] = await Promise.all([
    fetchDeclaredFunnelsSoft(brandId, headers.orgId),
    fetchEffectiveEconomics(brandId, headers),
  ]);
  const priced = priceOnDeclaredFunnel(declared, effective);
  return servedCached({
    view: "brand-contacted-value",
    scopeKey: buildScopeKey(brandId, {
      orgId: headers.orgId,
      channels: brandFeatureSlugs(channels).join("+"),
      decl: declared.map((f) => f.funnelKey).sort().join("+") || "none",
      econ: economicsFingerprint(priced.economics),
      m: "contacted-value-v4",
    }),
    orgId: headers.orgId,
    compute: () => computeBrandContactedValue(brandId, { orgId: headers.orgId, userId: headers.userId, runId: headers.runId }, { channels, declared, effective }),
  });
}

/**
 * How a pipeline read prices this brand's contacted-but-not-engaged leads: the per-(campaign × workflow)
 * entry rates of the brand's contacted-value cell (cost per contact ÷ the serving workflow's cost per
 * outcome) and the 30-day last-send expiry. FAIL-SOFT with a loud log, like every other per-lead enrichment of the
 * pipeline: unreadable → null → those leads carry nothing, never a guessed rate.
 */
export async function contactedPricingSoft(brandId: string, headers: DownstreamHeaders): Promise<ContactedPricing | null> {
  try {
    const result = await getBrandContactedValue(brandId, headers);
    if (result.unmeasuredReason !== null) return null;
    return {
      entryRatePctByGroup: contactedEntryRatesByGroup(result.workflows),
      lastSentOnOrAfter: contactedExpiryCutoffIso(new Date()),
    };
  } catch (err) {
    console.warn(
      `[features-service] contacted-lead pricing unreadable for brand ${brandId} — contacted leads add nothing to this pipeline: ${(err as Error).message}`,
    );
    return null;
  }
}

router.get("/brands/:brandId/contacted-value", apiKeyAuth, async (rawReq, res) => {
  const req = rawReq as unknown as AuthenticatedRequest;
  const brandId = rawReq.params.brandId as string;
  const page = parseContactedValuePage(req.query as Record<string, unknown>);
  if ("error" in page) return res.status(400).json({ error: page.error });
  const headers: DownstreamHeaders = { orgId: req.orgId, userId: req.userId, runId: req.runId };
  try {
    const result = await getBrandContactedValue(brandId, headers);
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
