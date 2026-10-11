/** IO half of `lib/pipe-spend-attribution.ts` (kept apart so the runs clients import no service client). */
import { fetchSalesFunnelCampaigns } from "./sales-funnel-campaigns-client.js";
import { fetchCampaignFamilies } from "./campaign-identity-client.js";
import { planPipeSpend, type PipeSpendAttribution } from "./pipe-spend-attribution.js";

/**
 * The attribution of the pipe whose campaign identity is `pipeCampaignIds`, read as channel `featureSlug`, or null
 * when nothing moves. The pipe is the ONE funnel unit among those ids (a read may name a stopped ancestor of the
 * unit; two units in one identity = ambiguous, nothing moves, logged). An adopted outreach unit is widened to its whole campaign IDENTITY: the outreach pipe's own
 * read covers that identity, so it releases the origin rows of every member, and the sourcing pipe must adopt
 * exactly those. FAIL-LOUD: a guessed attribution would print one of the two pipes wrong.
 */
export async function resolvePipeSpendAttribution(input: {
  brandId: string;
  featureSlug: string;
  pipeCampaignIds: readonly string[];
  headers: { orgId: string; userId?: string; runId?: string };
}): Promise<PipeSpendAttribution | null> {
  const rows = await fetchSalesFunnelCampaigns(input.brandId, null, input.headers);
  const unitIds = new Set(rows.flatMap((r) => r.units.map((u) => u.campaignId)));
  const units = [...new Set(input.pipeCampaignIds)].filter((id) => unitIds.has(id));
  if (units.length === 0) return null;
  if (units.length > 1) {
    console.error(`[features-service] pipe spend: campaign identity ${input.pipeCampaignIds.join(",")} holds ${units.length} sales funnel units; its spend is not re-attributed`);
    return null;
  }
  const plan = planPipeSpend(rows, units[0]!, input.featureSlug);
  if (!plan) return null;
  const adopted = new Set<string>();
  for (const unit of plan.adoptFrom) {
    const families = await fetchCampaignFamilies(input.brandId, unit.featureSlug, input.headers);
    for (const id of families.identityOf(unit.campaignId)?.campaignIds ?? [unit.campaignId]) adopted.add(id);
  }
  for (const id of input.pipeCampaignIds) adopted.delete(id);
  return {
    pipeCampaignIds: [...new Set(input.pipeCampaignIds)].sort(),
    releasedOriginSlugs: plan.releasedOriginSlugs,
    adoptedCampaignIds: [...adopted].sort(),
  };
}

