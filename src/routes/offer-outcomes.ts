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
import { fetchDeclaredFunnelsSoft, priceOnDeclaredFunnel, pricedFingerprint, type DownstreamHeaders } from "./revenue.js";
import { fetchBrandCampaignRows } from "../lib/campaign-identity-client.js";
import { buildOfferChannelMap, OfferHasNoChannelsError } from "../lib/offer-channels.js";
import {
  assembleOfferOutcomes,
  buildOfferLegPartition,
  offerGroupSpend,
  stepValues,
} from "../lib/offer-outcomes.js";
import { parseAcquisitionChannel } from "../lib/channel-catalogue.js";
import type { AcquisitionChannel } from "../lib/acquisition-channels.js";
import { SEED_FEATURES } from "../seed/features.js";
import { parsePricing, type Pricing } from "../lib/pricing.js";
import { OUTCOME_CAUSES, causeScopeKeyPart, parseOutcomeCauses, type OutcomeCause } from "../lib/outcome-cause.js";
import { assertBrandHeld } from "../lib/brand-ownership.js";
import { servedCachedJson, sendSnapshotJson, buildScopeKey } from "../lib/view-cache.js";
import { fetchLeadsForRevenue } from "../lib/leads-client.js";
import { fetchObservedStepFacts } from "../lib/observed-steps.js";
import { fetchQualifications } from "../lib/qualifications-client.js";
import { fetchConversionEmails } from "../lib/conversion-emails-client.js";
import { fetchEventTimestamps } from "../lib/email-status-client.js";
import { applySignalOverlays } from "../lib/signal-overlays.js";
import { maturityDaysForLeg } from "../lib/roi-maturity.js";
import { serveDatesStated } from "../lib/mature-evidence.js";
import { fetchSpendSplit, type ScopeCampaign, type SpendSplit } from "../lib/scope-maturity.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { fetchFollowupActedLeads } from "../lib/followup-actions-client.js";
import type { StepEvidence } from "../lib/funnel-steps.js";
import type { EnginePerson } from "../lib/revenue-engine.js";
import type { ColdLeadsRead } from "../lib/step-outcomes-client.js";
import { buildOfferPipeline, explainStepValue, offerStepSets, stepConversion } from "../lib/offer-pipeline-explained.js";

const router = Router();

/** The feature catalogue, parsed once on first use: which acquisition channel each slug is, and its name. */
let catalogue: Map<string, { name: string; channel: AcquisitionChannel | null }> | null = null;
export function catalogueEntry(slug: string): { name: string; channel: AcquisitionChannel | null } | undefined {
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
export async function readOfferPersons(input: {
  brandId: string;
  campaignIds: string[];
  headers: DownstreamHeaders;
  pricedFunnelKeys: Parameters<typeof applySignalOverlays>[4];
  causes: readonly OutcomeCause[];
  needDates: boolean;
}): Promise<{ persons: EnginePerson[]; evidence: StepEvidence; cold: ColdLeadsRead | null }> {
  const { brandId, headers } = input;
  const scope = input.campaignIds.length === 1 ? input.campaignIds[0] : input.campaignIds;
  const persons = await fetchLeadsForRevenue(brandId, scope, headers);
  const emails = [...new Set(persons.map((p) => p.email).filter((e): e is string => Boolean(e)))];
  const [timestamps, observed, quals, signupEmails, formEmails] = await Promise.all([
    // The delivery dates feed the legacy-qualification cause rule on the legs that wait (the gate
    // predates the serve clock and is kept so no priced figure moves). The mature cohort itself is
    // cut on each lead's SERVE date, read off the lead row (`lib/maturity.ts`). A failure leaves every
    // lead undated, the same degrade the revenue read's lens takes.
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
    // Who went cold rides the statements read (one lead-service call); unreadable ⇒ null, never "nobody".
    cold: observed?.cold ?? null,
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
    const [declared] = await Promise.all([fetchDeclaredFunnelsSoft(brandId, req.orgId, offerId), assertBrandHeld(brandId, headers)]);

    const payload = await servedCachedJson({
      view: "offer-outcomes",
      scopeKey: buildScopeKey(offerId, {
        orgId: req.orgId,
        brandId,
        legs: partition.groups.map((g) => `${g.legKey}@${g.featureSlug}>${g.campaignIds.join("+")}`).join(","),
        decl: declared.map((f) => f.funnelKey).sort().join("+") || "none",
        econ: pricedFingerprint(priceOnDeclaredFunnel(declared)),
        pricing,
        cause: causeScopeKeyPart(causes),
      }),
      orgId: req.orgId,
      compute: async () => {
        const groupCampaignIds = [...new Set(partition.groups.flatMap((g) => g.campaignIds))].sort();
        const needDates = partition.groups.some((g) => maturityDaysForLeg(g.legKey) > 0);
        const internalCampaignIds = partition.groups.filter((g) => g.fromStep !== null).flatMap((g) => g.campaignIds);
        const [people, spends, acted] = await Promise.all([
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
                cold: null as ColdLeadsRead | null,
              }),
          // ONE spend read for every group: each campaign's spend on both bases, summed exactly, cut at its
          // own leg's cutoff. A campaign carries exactly one leg, so the groups partition it.
          groupCampaignIds.length > 0
            ? fetchSpendSplit({
                brandId,
                featureScope: [...new Set(partition.groups.map((g) => g.featureSlug))],
                campaignIds: groupCampaignIds,
                campaigns: partition.groups.flatMap((g) => g.campaignIds.map((id): ScopeCampaign => ({ id, legKey: g.legKey }))),
                headers,
                pricing,
              })
            : Promise.resolve(new Map<string, SpendSplit>()),
          // Unreadable → the internal legs degrade to the offer's leads at their step, unattributed.
          internalCampaignIds.length > 0
            ? soft("follow-up actions", fetchFollowupActedLeads(brandId, internalCampaignIds))
            : Promise.resolve(new Map<string, Set<string>>()),
        ]);
        const spendByGroup = new Map(partition.groups.map((g) => [g, offerGroupSpend(g, spends)] as const));
        const values = stepValues(declared);
        const sets = offerStepSets(people.persons, people.evidence);
        const pricedFunnelKeys = priceOnDeclaredFunnel(declared).pricedFunnelKeys;
        const outcomes = assembleOfferOutcomes({
          groups: partition.groups,
          persons: people.persons,
          evidence: people.evidence,
          spendByGroup,
          values,
          channelName: (slug) => catalogueEntry(slug)?.name ?? slug,
          actedLeadIdsByCampaign: acted,
          serveDatesStated: serveDatesStated(people.persons),
          explainValue: (step) => explainStepValue(declared, step, values.get(step)),
          conversionOf: (step, reached) => (reached ? stepConversion(step, reached, sets, pricedFunnelKeys) : null),
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
          pipeline: buildOfferPipeline({
            persons: people.persons,
            evidence: people.evidence,
            declared,
            values,
            cold: people.cold,
            sets,
            pricedCauses: causes,
          }),
        };
      },
    });
    sendSnapshotJson(res, payload);
  } catch (error) {
    if (error instanceof OfferHasNoChannelsError) {
      return res.status(404).json({ error: error.message, reason: "offer_has_no_channels", offerId: error.offerId });
    }
    console.error("[features-service] Offer outcomes error:", error);
    res.status(502).json({ error: "Failed to compute offer outcomes" });
  }
});

export default router;
