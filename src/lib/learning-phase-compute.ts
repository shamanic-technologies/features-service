/**
 * Assemble the learning verdict for one scope: read the campaigns, count each one's own leg's
 * outcomes, name the leader, price it, and hand the lot to the pure {@link buildLearningPhase}.
 *
 * THE SCOPE IS THE ONE THE REVENUE READ ALREADY ANSWERS FOR. A campaign-scoped read narrows to that
 * campaign's identity; the funnel and offer grains pass their own campaign sets, which is what makes
 * this one implementation serve all four grains rather than four spellings of one question. A
 * brand-wide read narrows to nothing and sees every campaign of the channel set.
 *
 * ── THE CALL BUDGET, AND WHY IT IS BOUNDED BY THE LEADER AND NOT BY THE SCOPE ────────────────────
 *
 * Counting EVERY campaign's outcomes costs ONE email-gateway call per channel (`groupBy=campaignId`
 * answers for all of them at once), so the `priced` / `paused` / `unmeasured` half of the verdict is
 * flat in the number of campaigns. Only the COUNTDOWN needs the (campaign × workflow) split, and a
 * scope has exactly one countdown — its leading campaign's — so that fan-out is paid ONCE however
 * many campaigns the scope holds. It is the byte-same `fetchCampaignWorkflowEvidence` the leg-keyed
 * projection already makes for `?leg=&campaignId=`, so no new shape of read enters the fleet.
 *
 * FAIL-SOFT throughout, with a loud log: this rides a body whose every other figure is already
 * correct, so a producer blip must name a missing ingredient rather than 502 the page. What it must
 * never do is fabricate one — every degrade lands on a NAMED `unmeasured` reason.
 */
import { fetchBrandCampaignRows } from "./campaign-identity-client.js";
import { buildCampaignFamilies, type CampaignIdentityRow } from "./campaign-identity.js";
import { featureSlugList, featureSlugsParam, type FeatureScope } from "./feature-scope.js";
import { fetchPublicWorkflows } from "./public-stats-clients.js";
import { fetchCampaignWorkflowEvidence, type Identity } from "./workflow-projection-grains.js";
import { fetchCampaignCommittedCents, fetchCampaignDriverCounts, fetchLegDailyCeilingUsd } from "./learning-phase-clients.js";
import {
  buildLearningPhase,
  resolveLearningLeader,
  type LearningCampaignInput,
  type LearningCell,
  type LearningPhase,
  type ResolvedLeg,
} from "./learning-phase.js";
import type { CostPerOutcomeTerms } from "./cost-per-outcome-history.js";
import type { SalesEconomics } from "./funnel-registry.js";
import type { Pricing } from "./pricing.js";

/**
 * The verdict, and the TERMS the scope's outcome is counted and priced on.
 *
 * The terms ride along because the leader resolution that produces them costs a campaign-service read
 * and is already paid here — and because the dated cost-per-outcome curve the route builds beside
 * this verdict MUST be denominated in the same step, by the same rate, or one body would state two
 * different things about one outcome. `null` whenever the scope has no usable leg (no leader, no leg
 * stated, or a rate the brand never declared): a curve is never drawn on a step nobody named.
 */
export interface LearningPhaseResult {
  phase: LearningPhase;
  outcomeTerms: CostPerOutcomeTerms | null;
}

/** The leader's resolved leg, as the curve needs it. Null when it carries no declared rate. */
function outcomeTermsOf(leg: ResolvedLeg | null): CostPerOutcomeTerms | null {
  if (!leg || leg.rateFromDriver == null || leg.rateFromDriver <= 0) return null;
  return {
    legKey: leg.legKey,
    outcomeStep: leg.outcomeStep,
    driver: leg.driver,
    rateFromDriver: leg.rateFromDriver,
    outcomeObserved: leg.outcomeObserved,
  };
}

export interface LearningPhaseScope {
  brandId: string;
  featureScope: FeatureScope;
  /** The campaign ids the read is narrowed to. EMPTY ⟺ the whole brand's campaigns on this channel set. */
  campaignScopeIds: string[];
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string };
  /** The brand's merged economics — the rate ladder each leg is walked through. Null at cold start. */
  economics: SalesEconomics | null;
  pricing: Pricing;
}

function inScope(row: CampaignIdentityRow, slugs: Set<string>, scopeIds: Set<string> | null): boolean {
  if (scopeIds && !scopeIds.has(row.id)) return false;
  // A row stating no channel cannot be placed in a channel-scoped read: including it would attribute
  // its evidence to a channel nobody said it belongs to.
  return row.featureSlug != null && slugs.has(row.featureSlug);
}

export async function computeLearningPhase(scope: LearningPhaseScope): Promise<LearningPhaseResult> {
  const { brandId, featureScope, headers, economics, pricing } = scope;
  const identity: Identity = {
    orgId: headers.orgId,
    ...(headers.userId ? { userId: headers.userId } : {}),
    ...(headers.runId ? { runId: headers.runId } : {}),
    ...(headers.featureSlug ? { featureSlug: headers.featureSlug } : {}),
  };

  // EVERY channel's campaigns in ONE read, then filtered locally: `fetchBrandCampaignRows` takes at
  // most one slug, and a multi-channel scope would otherwise be one call per channel for a list the
  // producer already serves whole.
  const rows = await fetchBrandCampaignRows(brandId, undefined, headers);
  const slugs = new Set(featureSlugList(featureScope));
  const scopeIds = scope.campaignScopeIds.length > 0 ? new Set(scope.campaignScopeIds) : null;
  const scoped = rows.filter((row) => inScope(row, slugs, scopeIds));

  const [driverCounts, committedCents, workflows] = await Promise.all([
    fetchCampaignDriverCounts(brandId, featureScope, headers),
    fetchCampaignCommittedCents(brandId, featureScope, headers, pricing),
    fetchPublicWorkflows(featureSlugsParam(featureScope), "all"),
  ]);

  const families = buildCampaignFamilies(scoped);
  const byId = new Map(scoped.map((row) => [row.id, row]));
  const campaigns: LearningCampaignInput[] = [];
  const seen = new Set<string>();
  for (const row of scoped) {
    const family = families.identityOf(row.id);
    const key = family?.key ?? `campaign:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const memberIds = family?.campaignIds ?? [row.id];
    const representativeId = family?.representativeId ?? row.id;
    const representative = byId.get(representativeId) ?? row;
    // A campaign that sent nothing has no bucket, which is a measured 0 for a campaign we know exists.
    // Summing the family's members is exact: a send carries exactly one campaign.
    let clicks = 0;
    let replies = 0;
    for (const id of memberIds) {
      const counts = driverCounts.get(id);
      if (!counts) continue;
      clicks += counts.clicks;
      replies += counts.replies;
    }
    campaigns.push({
      campaignId: representativeId,
      campaignIds: memberIds,
      campaignIdentityKey: family?.key ?? null,
      // The leg the CAMPAIGN states. A family's members share their identity, not necessarily their
      // leg, so the representative — the live member when there is one — is the one that answers.
      legKey: representative.legKey ?? memberIds.map((id) => byId.get(id)?.legKey).find((l) => l) ?? null,
      funnelKey: representative.funnelKey ?? family?.funnelKey ?? null,
      live: (family?.liveCampaignIds.length ?? 0) > 0 || representative.status === "ongoing",
      observed: { clicks, replies },
    });
  }

  const leader = resolveLearningLeader(campaigns, economics);
  let leadingCells: LearningCell[] | null = null;
  let leadingCommittedSpentUsd: number | null = null;
  let dailyCeilingUsd: number | null = null;

  if (leader) {
    const legKey = leader.leg?.legKey ?? null;
    const [evidence, ceiling] = await Promise.all([
      // THE COUNTDOWN'S ONLY FAN-OUT, and it is paid once per scope rather than once per campaign.
      fetchCampaignWorkflowEvidence(
        brandId,
        featureSlugsParam(featureScope),
        leader.input.campaignIds,
        workflows,
        identity,
        pricing,
      ).catch((error: Error) => {
        console.warn(`[features-service] learning cells unavailable (no expected price): ${error.message}`);
        return null;
      }),
      legKey
        ? fetchLegDailyCeilingUsd(brandId, legKey, featureScope, headers).catch((error: Error) => {
            console.warn(`[features-service] learning ceiling unavailable (no countdown): ${error.message}`);
            return null;
          })
        : Promise.resolve<number | null>(null),
    ]);
    if (evidence) {
      leadingCells = [...evidence.values()].map((cell) => ({
        spentUsd: cell.totalCostInUsdCents / 100,
        clicks: cell.clicks,
        replies: cell.replies,
      }));
    }
    // The leading campaign's committed spend comes from the LEDGER, not from summing the cells above:
    // those are rolled up by workflow DYNASTY and a lineage since retired is absent from them, so the
    // sum under-states what the campaign spent and would contradict the `costEconomics` figure sitting
    // beside it on the same body. See `fetchCampaignCommittedCents`.
    let leadingCents = 0;
    for (const id of leader.input.campaignIds) leadingCents += committedCents.get(id) ?? 0;
    leadingCommittedSpentUsd = leadingCents / 100;
    dailyCeilingUsd = ceiling;
  }

  return {
    phase: buildLearningPhase({
      campaigns,
      economics,
      leadingCells,
      leadingCommittedSpentUsd,
      dailyCeilingUsd,
    }),
    outcomeTerms: outcomeTermsOf(leader?.leg ?? null),
  };
}

/**
 * The fail-soft wrapper every revenue grain uses. A read that could not run at all lands on the
 * `campaigns_unreadable` verdict — a stated reason, never a missing block and never a zero.
 */
export async function computeLearningPhaseSoft(scope: LearningPhaseScope): Promise<LearningPhaseResult> {
  try {
    return await computeLearningPhase(scope);
  } catch (error) {
    console.warn(`[features-service] learning phase unavailable: ${(error as Error).message}`);
    return {
      phase: buildLearningPhase({
        campaigns: null,
        economics: scope.economics,
        leadingCells: null,
        leadingCommittedSpentUsd: null,
        dailyCeilingUsd: null,
      }),
      // No campaigns read means no leg named, so the curve has no step to be denominated in. A
      // fabricated one would put a number on the wire about an outcome nobody stated.
      outcomeTerms: null,
    };
  }
}
