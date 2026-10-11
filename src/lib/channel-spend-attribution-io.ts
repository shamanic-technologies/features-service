/** IO half of the CHANNEL-grain attribution (`planChannelSpend`, `lib/pipe-spend-attribution.ts`). */
import { planBrandWideChannelSpend, planChannelSpend, type PipeSpendAttribution } from "./pipe-spend-attribution.js";
import { resolveOfferChannels } from "./offer-channels.js";
import { SOURCING_ORIGINS_BY_CHANNEL, isSourcingChannel } from "./sourcing-origins.js";

/**
 * The attribution of ONE channel's read at a grain wider than a campaign (owner 2026-10-11: a sourcing pipe's spend is
 * its own): over an OFFER (`?offerId=`), the offer's channel rows (`planChannelSpend`, read off campaign-service like
 * the offer route's); BRAND-WIDE (no campaign, no offer), every origin feeding it leaves it (`planBrandWideChannelSpend`,
 * no IO). Null = nothing moves. FAIL-LOUD like the pipe read.
 */
export async function resolveChannelSpendAttribution(input: {
  brandId: string;
  featureSlug: string;
  offerId: string | undefined;
  headers: { orgId: string; userId?: string; runId?: string };
}): Promise<PipeSpendAttribution | null> {
  if (!input.offerId) return planBrandWideChannelSpend(input.featureSlug);
  if (SOURCING_ORIGINS_BY_CHANNEL[input.featureSlug] === undefined && !isSourcingChannel(input.featureSlug)) return null;
  const channels = await resolveOfferChannels(input.offerId, input.brandId, input.headers);
  return planChannelSpend(channels).get(input.featureSlug) ?? null;
}
