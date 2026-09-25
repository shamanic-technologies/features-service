/**
 * GET /offers/:offerId/outcomes — ONE ROW PER OUTCOME THE OFFER BUYS, and under each, every leg ×
 * channel serving it. The model and every rule behind the figures live in `lib/offer-outcomes.ts`.
 *
 * ADDITIVE: no existing read moves. The funnel reads keep answering per funnel exactly as before; this
 * is the outcome-grain read the funnel's retirement needs, served beside them.
 *
 * One campaign read decides the scope (which legs the offer runs, through which channels); one lead
 * read + the same per-lead overlays the brand revenue read applies give the people; one committed-cost
 * read per (leg × channel) gives the money. Everything is combined HERE — a browser summing funnel
 * rungs would count a lead reached through two funnels twice.
 */
import { Router } from "express";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchDeclaredFunnelsSoft, type DownstreamHeaders } from "./revenue.js";
import { fetchBrandCampaignRows } from "../lib/campaign-identity-client.js";
import { buildOfferChannelMap, OfferHasNoChannelsError } from "../lib/offer-channels.js";
import {
  assembleOfferOutcomes,
  buildOfferLegPartition,
  stepValues,
  type GroupSpend,
  type OfferLegGroup,
} from "../lib/offer-outcomes.js";
import { parseAcquisitionChannel } from "../lib/channel-catalogue.js";
import type { AcquisitionChannel } from "../lib/acquisition-channels.js";
import { SEED_FEATURES } from "../seed/features.js";
import { parsePricing, type Pricing } from "../lib/pricing.js";
import { OUTCOME_CAUSES, causeScopeKeyPart, parseOutcomeCauses, type OutcomeCause } from "../lib/outcome-cause.js";
import { fetchEffectiveEconomics, economicsFingerprint } from "../lib/sales-economics-client.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { fetchLeadsForRevenue } from "../lib/leads-client.js";
import { fetchObservedStepFacts } from "../lib/observed-steps.js";
import { fetchQualifications } from "../lib/qualifications-client.js";
import { fetchConversionEmails } from "../lib/conversion-emails-client.js";
import { fetchEventTimestamps } from "../lib/email-status-client.js";
import { applySignalOverlays } from "../lib/signal-overlays.js";
import { fetchMatureSpendCents, fetchRunsCostCents } from "../lib/runs-cost-client.js";
import { maturityCutoffIso, maturityDaysForLeg } from "../lib/roi-maturity.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import type { StepEvidence } from "../lib/funnel-steps.js";
import type { EnginePerson } from "../lib/revenue-engine.js";

const router = Router();

/** The feature catalogue, parsed once on first use: which acquisition channel each slug is, and its name. */
let catalogue: Map<string, { name: string; channel: AcquisitionChannel | null }> | null = null;
function catalogueEntry(slug: string): { name: string; channel: AcquisitionChannel | null } | undefined {
  catalogue ??= new Map(
    SEED_FEATURES.map((f) => [f.slug, { name: f.name, channel: parseAcquisitionChannel(f.slug, f.acquisitionChannel) }]),
  );
  return catalogue.get(slug);
}

const soft = <T>(what: string, p: Promise<T>): Promise<T | null> =>
  p.catch((err) => {
    console.warn(`[features-service] offer outcomes: ${what} unreadable (its steps read as unmeasured): ${(err as Error).message}`);
    return null;
  });

/** The offer's people, carrying the SAME per-lead overlays the brand revenue read applies. */
async function readOfferPersons(input: {
  brandId: string;
  campaignIds: string[];
  headers: DownstreamHeaders;
  pricedFunnelKeys: Parameters<typeof applySignalOverlays>[4];
  causes: readonly OutcomeCause[];
  needDates: boolean;
}): Promise<{ persons: EnginePerson[]; evidence: StepEvidence }> {
  const { brandId, headers } = input;
  const scope = input.campaignIds.length === 1 ? input.campaignIds[0] : input.campaignIds;
  const persons = await fetchLeadsForRevenue(brandId, scope, headers);
  const emails = [...new Set(persons.map((p) => p.email).filter((e): e is string => Boolean(e)))];
  const [timestamps, observed, quals, signupEmails, formEmails] = await Promise.all([
    // Only the maturity cutoff reads a contact date. A failure leaves every lead undated — IN the
    // mature cohort, the same degrade the revenue read's lens takes (never lose information).
    input.needDates ? soft("event timestamps", fetchEventTimestamps(brandId, undefined, emails, headers)) : Promise.resolve(null),
    soft("observed step statements", fetchObservedStepFacts(brandId, input.causes)),
    soft("legacy qualifications", fetchQualifications(brandId, undefined, emails, headers)),
    soft("signup attribution", fetchConversionEmails(brandId, "signup")),
    soft("form-submission attribution", fetchConversionEmails(brandId, "form_submission")),
  ]);
  applySignalOverlays(persons, timestamps, observed?.byEmail ?? null, quals, input.pricedFunnelKeys, input.causes);
  for (const person of persons) {
    const email = person.email?.trim().toLowerCase();
    if (!email) continue;
    if (signupEmails?.has(email)) person.signals.signup = true;
    if (formEmails?.has(email)) person.signals.formSubmission = true;
  }
  return {
    persons,
    evidence: {
      observedSteps: observed !== null,
      legacyQualifications: quals !== null,
      signupAttribution: signupEmails !== null,
      formSubmissionAttribution: formEmails !== null,
    },
  };
}

async function readGroupSpend(
  group: OfferLegGroup,
  brandId: string,
  headers: DownstreamHeaders,
  pricing: Pricing,
): Promise<GroupSpend> {
  const scope = group.campaignIds.length === 1 ? group.campaignIds[0] : group.campaignIds;
  const days = maturityDaysForLeg(group.legKey);
  const cutoffIso = days > 0 ? maturityCutoffIso(days) : null;
  const [whole, mature] = await Promise.all([
    fetchRunsCostCents(brandId, scope, group.featureSlug, headers, pricing),
    cutoffIso
      ? fetchMatureSpendCents(brandId, scope, group.featureSlug, headers, pricing, {
          cutoffIso,
          delayedCampaignIds: new Set(group.campaignIds),
        }).then((r) => r.total)
      : Promise.resolve(null),
  ]);
  return {
    committedCents: whole.committedCents,
    matureCommittedCents: mature ? mature.committedCents : whole.committedCents,
    cutoffIso,
  };
}

router.get("/offers/:offerId/outcomes", apiKeyAuth, async (rawReq, res) => {
  try {
    const req = rawReq as AuthenticatedRequest;
    const offerId = req.params.offerId as string;
    const brandId = (req.query.brandId as string | undefined) ?? "";
    if (!brandId) return res.status(400).json({ error: "brandId query parameter is required" });
    const pricing = parsePricing(req.query.pricing);
    if (pricing === null) return res.status(400).json({ error: "pricing must be one of: gross, net" });
    const causes = parseOutcomeCauses(req.query.cause);
    if (causes === null) {
      return res.status(400).json({
        error: `cause must be a comma-separated subset of: ${OUTCOME_CAUSES.join(", ")}`,
        reason: "cause_unrecognised",
      });
    }

    const headers: DownstreamHeaders = { orgId: req.orgId, userId: req.userId, runId: req.runId, featureSlug: undefined };
    const rows = await fetchBrandCampaignRows(brandId, undefined, { orgId: req.orgId, userId: req.userId, runId: req.runId });
    if (buildOfferChannelMap(rows).channelsOf(offerId).length === 0) throw new OfferHasNoChannelsError(offerId, brandId);

    const partition = buildOfferLegPartition(rows, offerId, (slug) => catalogueEntry(slug)?.channel ?? null);
    const [declared, brandEconomics] = await Promise.all([
      fetchDeclaredFunnelsSoft(brandId, req.orgId, offerId),
      fetchEffectiveEconomics(brandId, headers),
    ]);

    const payload = await servedCached({
      view: "offer-outcomes",
      scopeKey: buildScopeKey(offerId, {
        orgId: req.orgId,
        brandId,
        legs: partition.groups.map((g) => `${g.legKey}@${g.featureSlug}>${g.campaignIds.join("+")}`).join(","),
        decl: declared.map((f) => f.funnelKey).sort().join("+") || "none",
        econ: economicsFingerprint(brandEconomics),
        pricing,
        cause: causeScopeKeyPart(causes),
      }),
      orgId: req.orgId,
      compute: async () => {
        const groupCampaignIds = [...new Set(partition.groups.flatMap((g) => g.campaignIds))].sort();
        const needDates = partition.groups.some((g) => maturityDaysForLeg(g.legKey) > 0);
        const [people, spends] = await Promise.all([
          groupCampaignIds.length > 0
            ? readOfferPersons({
                brandId,
                campaignIds: groupCampaignIds,
                headers,
                pricedFunnelKeys: declared.map((f) => f.funnelKey),
                causes,
                needDates,
              })
            : Promise.resolve({
                persons: [] as EnginePerson[],
                evidence: { observedSteps: true, legacyQualifications: true, signupAttribution: true, formSubmissionAttribution: true },
              }),
          mapWithConcurrency(partition.groups, 4, (g) => readGroupSpend(g, brandId, headers, pricing)),
        ]);
        const spendByGroup = new Map(partition.groups.map((g, i) => [g, spends[i]] as const));
        const outcomes = assembleOfferOutcomes({
          groups: partition.groups,
          persons: people.persons,
          evidence: people.evidence,
          spendByGroup,
          values: stepValues(declared, brandEconomics.economics),
          channelName: (slug) => catalogueEntry(slug)?.name ?? slug,
        });
        const maturityDays = Math.max(0, ...partition.groups.map((g) => maturityDaysForLeg(g.legKey)));
        return {
          offerId,
          brandId,
          costBasis: "charged" as const,
          outcomeCauses: { priced: [...causes] },
          maturityDays,
          outcomes,
          unattributedCampaignIds: partition.unattributedCampaignIds,
          hiddenCampaignIds: partition.hiddenCampaignIds,
        };
      },
    });
    res.json(payload);
  } catch (error) {
    if (error instanceof OfferHasNoChannelsError) {
      return res.status(404).json({ error: error.message, reason: "offer_has_no_channels", offerId: error.offerId });
    }
    console.error("[features-service] Offer outcomes error:", error);
    res.status(502).json({ error: "Failed to compute offer outcomes" });
  }
});

export default router;
