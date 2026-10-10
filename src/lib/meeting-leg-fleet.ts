/**
 * THE AI MEETING-BOOKING LEG, PER WORKFLOW, ACROSS EVERY ORG — positive reply → meeting booked.
 *
 * An internal leg serves no lead of its own: its campaigns answer people a cold-email campaign found, and
 * lead-service records which leads each campaign's worker ANSWERED (`followup-actions`, `acted` only).
 * So on this leg a workflow's figures are (the same basis `/offers/:offerId/outcomes` states per offer):
 *
 *   - `contacted` = the distinct leads its campaigns answered (the conversations it worked);
 *   - `outcomes`  = those of them who reached "meeting booked", whatever caused it (every outcome counts);
 *   - `spentUsd`  = the fleet INCURRED spend of its campaigns (runs, gross — the benchmark basis the cold-email
 *                   legs' fleet figures are read on, so the two legs of the meetings price share one basis).
 *
 * A campaign is attributed to a workflow DYNASTY by its own runs. A campaign whose runs span several
 * dynasties cannot say which one booked a meeting, so it is left out of every workflow (spend and
 * outcomes alike) and named in `unattributableCampaignIds` — never split on a guess.
 *
 * This leg's maturity rule is 0 days / 10 outcomes (`lib/maturity.ts`), so its mature figures ARE its
 * flash figures; the verdict still reads the count.
 *
 * FAIL-LOUD: an unreadable pair fails the whole read (the caller keeps its previous value).
 */
import { fetchFleetLegCampaigns, type FleetLegCampaign } from "./fleet-leg-campaigns.js";
import { fetchFollowupActedLeads } from "./followup-actions-client.js";
import { fetchLeadsForRevenue } from "./leads-client.js";
import { fetchObservedStepFacts } from "./observed-steps.js";
import { fetchQualifications } from "./qualifications-client.js";
import { applySignalOverlays } from "./signal-overlays.js";
import { OUTCOME_CAUSES } from "./outcome-cause.js";
import { fetchPublicCosts, fetchPublicWorkflows, type CostGroup, type WorkflowMetadata } from "./public-stats-clients.js";
import { dynastyOfSlug } from "./workflow-scope.js";
import { legMaturityFigures, outcomeFigures, type LegMaturityFigures } from "./maturity.js";
import { mapWithConcurrency } from "./concurrency.js";
import type { EnginePerson } from "./revenue-engine.js";

export const MEETING_BOOKING_FEATURE_SLUG = "ai-meeting-booking";
export const MEETING_BOOKING_LEG_KEY = "conversation_to_meeting_booked";

/**
 * ONE RULE FOR EVERY PIPE (owner 2026-10-10: "NE CRÉE PLUS JAMAIS DES CAS PARTICULIERS"). What decides how a
 * pipe is measured is where its leg STARTS, never its channel:
 *   - an ENTRY pipe (from nothing, or from Lead found) serves leads of its own: measured on the leads its
 *     campaigns served (`fetchFleetLegWorkflowMaturity`);
 *   - an INTERNAL pipe (from any other step: Positive reply -> Meeting booked, Positive reply -> Booking
 *     call...) serves nobody: its campaigns act on people another campaign holds, so it is measured on the
 *     people they ACTED on (lead-service follow-up ledger) and the outcome is the pipe's own `to` step.
 */
export const isInternalPipe = (fromStep: string | null): boolean => fromStep !== null && fromStep !== "lead_found";

/**
 * Whether a person reached `step`, read off the signals the revenue engine carries. `booking_call` has no
 * signal on a lead: lead-service's own rule is that an `acted` row of a booking-call campaign IS the call
 * placed (`booking-calls.ts`), so on that step the act is the outcome. A step with no reading is `null`:
 * the pipe's outcomes are then unmeasured, never 0.
 */
const STEP_REACHED: Readonly<Record<string, ((p: EnginePerson) => boolean) | "acted">> = {
  conversation: (p) => Boolean(p.signals.positiveReply),
  website_visit: (p) => Boolean(p.signals.clicked),
  meeting_booked: (p) => Boolean(p.signals.meeting),
  paid_client: (p) => Boolean(p.signals.closeWin),
  booking_call: "acted",
};

export interface MeetingLegFleet {
  legKey: string;
  campaignCount: number;
  byDynasty: Array<[string, LegMaturityFigures]>;
  unattributableCampaignIds: string[];
}

/** One (org, brand)'s answered leads per acting campaign, and which of them reached a booked meeting. */
export interface PairActed {
  actedByCampaign: Map<string, Set<string>>;
  meetingLeadIds: Set<string>;
}

/**
 * PURE. Roll the leg up to dynasties. `costGroups` carry `workflowSlug` and `campaignId`; `pairs` are
 * keyed by brand (a lead id is unique per brand, so `${brandId}:${leadId}` counts a person once).
 */
export function buildMeetingLegFleet(input: {
  campaigns: readonly FleetLegCampaign[];
  workflows: readonly WorkflowMetadata[];
  costGroups: readonly CostGroup[];
  pairs: ReadonlyMap<string, PairActed>;
  /** The internal pipe's leg (default: Positive reply -> Meeting booked). */
  legKey?: string;
}): MeetingLegFleet {
  const legKey = input.legKey ?? MEETING_BOOKING_LEG_KEY;
  const toDynasty = dynastyOfSlug(input.workflows as WorkflowMetadata[]);
  const spendByCampaign = new Map<string, Map<string, number>>();
  for (const g of input.costGroups) {
    const campaignId = g.dimensions.campaignId;
    const slug = g.dimensions.workflowSlug;
    if (!campaignId || !slug) continue;
    const byDyn = spendByCampaign.get(campaignId) ?? new Map<string, number>();
    const dyn = toDynasty(slug);
    byDyn.set(dyn, (byDyn.get(dyn) ?? 0) + Number(g.totalCostInUsdCents));
    spendByCampaign.set(campaignId, byDyn);
  }

  const agg = new Map<string, { cents: number; acted: Set<string>; meetings: Set<string> }>();
  const unattributable: string[] = [];
  for (const c of input.campaigns) {
    const byDyn = spendByCampaign.get(c.campaignId);
    if (!byDyn || byDyn.size === 0) continue; // never ran: nothing spent, nothing answered
    if (byDyn.size > 1) {
      unattributable.push(c.campaignId);
      continue;
    }
    const [dynasty, cents] = [...byDyn][0]!;
    const entry = agg.get(dynasty) ?? { cents: 0, acted: new Set<string>(), meetings: new Set<string>() };
    entry.cents += cents;
    const pair = c.brandId ? input.pairs.get(c.brandId) : undefined;
    for (const leadId of pair?.actedByCampaign.get(c.campaignId) ?? []) {
      const key = `${c.brandId}:${leadId}`;
      entry.acted.add(key);
      if (pair!.meetingLeadIds.has(leadId)) entry.meetings.add(key);
    }
    agg.set(dynasty, entry);
  }

  const byDynasty: Array<[string, LegMaturityFigures]> = [...agg]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([dynasty, e]) => {
      const figures = outcomeFigures(e.cents / 100, e.acted.size, e.meetings.size);
      return [dynasty, legMaturityFigures(legKey, figures, figures)];
    });
  return {
    legKey,
    campaignCount: input.campaigns.length,
    byDynasty,
    unattributableCampaignIds: unattributable.sort(),
  };
}

/** One brand's acted leads and which of them reached `toStep` (every cause counts). */
async function readPairActed(orgId: string, brandId: string, campaignIds: string[], toStep: string): Promise<PairActed> {
  const actedByCampaign = await fetchFollowupActedLeads(brandId, campaignIds);
  const actedIds = new Set([...actedByCampaign.values()].flatMap((s) => [...s]));
  const reached = STEP_REACHED[toStep];
  if (reached === "acted") return { actedByCampaign, meetingLeadIds: actedIds };
  if (actedIds.size === 0) return { actedByCampaign, meetingLeadIds: new Set() };
  const headers = { orgId };
  const persons: EnginePerson[] = (await fetchLeadsForRevenue(brandId, undefined, headers)).filter((p) => actedIds.has(p.leadId));
  const emails = [...new Set(persons.map((p) => p.email).filter((e): e is string => Boolean(e)))];
  const [observed, quals] = await Promise.all([
    fetchObservedStepFacts(brandId, OUTCOME_CAUSES),
    fetchQualifications(brandId, undefined, emails, headers),
  ]);
  applySignalOverlays(persons, null, observed.byEmail, quals, [], OUTCOME_CAUSES);
  return { actedByCampaign, meetingLeadIds: new Set(persons.filter((p) => (reached as (p: EnginePerson) => boolean)(p)).map((p) => p.leadId)) };
}

export async function computeMeetingLegFleet(): Promise<MeetingLegFleet> {
  return computeInternalPipeFleet(MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY, "meeting_booked");
}

/** Thrown when an internal pipe's `to` step has no reading on a person: its outcomes cannot be counted. */
export class StepNotReadableError extends Error {
  constructor(readonly toStep: string) {
    super(`no reading of step ${toStep} on a person: the pipe's outcomes cannot be counted`);
  }
}

/** Any INTERNAL pipe across every org, per workflow dynasty (the rule above). */
export async function computeInternalPipeFleet(featureSlug: string, legKey: string, toStep: string): Promise<MeetingLegFleet> {
  if (!STEP_REACHED[toStep]) throw new StepNotReadableError(toStep);
  const campaigns = await fetchFleetLegCampaigns(featureSlug, legKey);
  const ids = [...new Set(campaigns.map((c) => c.campaignId))].sort();
  if (ids.length === 0) return { legKey, campaignCount: 0, byDynasty: [], unattributableCampaignIds: [] };

  const byPair = new Map<string, { orgId: string; brandId: string; campaignIds: string[] }>();
  for (const c of campaigns) {
    if (!c.brandId) continue;
    const pair = byPair.get(c.brandId) ?? { orgId: c.orgId, brandId: c.brandId, campaignIds: [] };
    pair.campaignIds.push(c.campaignId);
    byPair.set(c.brandId, pair);
  }
  const [workflows, costChunks, pairResults] = await Promise.all([
    fetchPublicWorkflows(featureSlug, "all"),
    // The public cost read groups on ONE dimension, so each campaign is asked on its own and its groups
    // are tagged with it (the leg holds a handful of campaigns).
    mapWithConcurrency(ids, 4, async (id) =>
      (await fetchPublicCosts(featureSlug, "workflowSlug", "gross", "incurred", [id])).map((g) => ({
        ...g,
        dimensions: { ...g.dimensions, campaignId: id },
      })),
    ),
    mapWithConcurrency([...byPair.values()], 2, async (p) => [p.brandId, await readPairActed(p.orgId, p.brandId, p.campaignIds, toStep)] as const),
  ]);
  return buildMeetingLegFleet({ campaigns, workflows, costGroups: costChunks.flat(), pairs: new Map(pairResults), legKey });
}
