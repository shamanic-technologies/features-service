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
 *
 * A pipe landing on a MEETING step (`lib/meeting-population.ts`, MEETING-POPULATION-1018) is measured, fleet-wide, on
 * the brands that REPORT meetings only: a campaign of a brand that never reported one is kept in `perCampaign` (its
 * own brand / campaign / offer grains are its own figures) with `inFleetPopulation: false`, and left out of
 * `byDynasty` and of every fleet count (spend and people alike). `population` names the brands counted and left out.
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
import type { ChannelStepKey } from "./acquisition-channels.js";
import { MEETING_STEPS, meetingPopulationOf, type MeetingPopulation, type MeetingReporting } from "./meeting-population.js";
import { getMeetingReporting } from "./meeting-reporting-client.js";

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
 * Whether a person reached `step`, read off the signals the revenue engine carries. ONE reading per catalogue
 * step a pipe can end on (typed over `ChannelStepKey`, so a new step fails the build instead of 502-ing every
 * read of its pipes: 2026-10-13, Meeting attended and Purchase had none). The readings are the ones the
 * funnel activity reads per step (`lib/funnel-campaign-activity.ts`): a purchase is lead-service's `sale`, the
 * same signal as a paid client. `booking_call` has no signal on a lead: lead-service's own rule is that an
 * `acted` row of a booking-call campaign IS the call placed (`booking-calls.ts`), so on that step the act is
 * the outcome.
 */
export const STEP_REACHED: Readonly<Record<Exclude<ChannelStepKey, "lead_found">, ((p: EnginePerson) => boolean) | "acted">> = {
  conversation: (p) => Boolean(p.signals.positiveReply),
  website_visit: (p) => Boolean(p.signals.clicked),
  booking_call: "acted",
  meeting_booked: (p) => Boolean(p.signals.meeting),
  meeting_attended: (p) => Boolean(p.signals.meetingAttended),
  signup: (p) => Boolean(p.signals.signup),
  form_submitted: (p) => Boolean(p.signals.formSubmission),
  purchase: (p) => Boolean(p.signals.closeWin),
  paid_client: (p) => Boolean(p.signals.closeWin),
};

const stepReading = (toStep: string): ((p: EnginePerson) => boolean) | "acted" | undefined =>
  (STEP_REACHED as Readonly<Record<string, ((p: EnginePerson) => boolean) | "acted">>)[toStep];

export interface MeetingLegFleet {
  legKey: string;
  campaignCount: number;
  byDynasty: Array<[string, LegMaturityFigures]>;
  unattributableCampaignIds: string[];
  /** Per attributed campaign: its dynasty and the people (`brandId:leadId`) it acted on / that reached the
   *  pipe's `to` step. What a finer grain (brand, campaign, offer) of the workflow ladder sums.
   *  `inFleetPopulation` = counted in fleet figures (false: its brand reports no meeting on a meeting pipe). */
  perCampaign: Array<{ campaignId: string; orgId: string; brandId: string | null; dynasty: string; acted: string[]; reached: string[]; inFleetPopulation: boolean }>;
  /** Who the fleet figures were measured on; null on a pipe not landing on a meeting step (every brand counts). */
  population: MeetingPopulation | null;
  /**
   * Per CLIENT (org), on the fleet population only, every campaign of the pipe that ran, attributable to one workflow or
   * not: what the client spent on the pipe and the people its campaigns acted on / that reached the `to` step. A
   * client's own figure needs no workflow attribution, so a campaign whose runs span several workflows counts here
   * (MB-INDEX-PIPES-1018).
   */
  byOrg: Array<{ orgId: string; spentUsd: number; contacted: number; outcomes: number }>;
  /** The whole pipe on the fleet population (every workflow pooled, mixed campaigns included), spend per dynasty named. */
  pooled: { spentUsd: number; contacted: number; outcomes: number; spentByDynasty: Record<string, number> };
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
  /** The brands that report meetings, on a pipe landing on a meeting step; null = every brand counts. */
  reporting: MeetingReporting | null;
}): MeetingLegFleet {
  const inFleet = (brandId: string | null): boolean => input.reporting === null || input.reporting.reports(brandId);
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
  const perCampaign: MeetingLegFleet["perCampaign"] = [];
  const orgs = new Map<string, { cents: number; acted: Set<string>; reached: Set<string> }>();
  const pooled = { cents: 0, acted: new Set<string>(), reached: new Set<string>(), centsByDynasty: new Map<string, number>() };
  for (const c of input.campaigns) {
    const ran = spendByCampaign.get(c.campaignId);
    if (!ran || ran.size === 0) continue; // never ran: nothing spent, nothing answered
    const counted = inFleet(c.brandId);
    const pair = c.brandId ? input.pairs.get(c.brandId) : undefined;
    // The client's own figure and the whole pipe: every campaign that ran, whatever workflow ran it.
    if (counted) {
      const org = orgs.get(c.orgId) ?? { cents: 0, acted: new Set<string>(), reached: new Set<string>() };
      for (const [d, cents] of ran) {
        org.cents += cents;
        pooled.cents += cents;
        if (cents > 0) pooled.centsByDynasty.set(d, (pooled.centsByDynasty.get(d) ?? 0) + cents);
      }
      for (const leadId of pair?.actedByCampaign.get(c.campaignId) ?? []) {
        const key = `${c.brandId}:${leadId}`;
        org.acted.add(key);
        pooled.acted.add(key);
        if (pair!.meetingLeadIds.has(leadId)) {
          org.reached.add(key);
          pooled.reached.add(key);
        }
      }
      orgs.set(c.orgId, org);
    }
    // A workflow version that spent nothing on the campaign did not act for it: only spending dynasties attribute
    // (2026-10-18: $0 rows of retired versions made 10 of 20 meeting campaigns read as mixed).
    const spending = new Map([...ran].filter(([, cents]) => cents > 0));
    const byDyn = spending.size > 0 ? spending : ran;
    if (byDyn.size > 1) {
      unattributable.push(c.campaignId);
      continue;
    }
    const [dynasty, cents] = [...byDyn][0]!;
    const entry = agg.get(dynasty) ?? { cents: 0, acted: new Set<string>(), meetings: new Set<string>() };
    if (counted) entry.cents += cents;
    const mine = { campaignId: c.campaignId, orgId: c.orgId, brandId: c.brandId, dynasty, acted: [] as string[], reached: [] as string[], inFleetPopulation: counted };
    for (const leadId of pair?.actedByCampaign.get(c.campaignId) ?? []) {
      const key = `${c.brandId}:${leadId}`;
      if (counted) entry.acted.add(key);
      mine.acted.push(key);
      if (pair!.meetingLeadIds.has(leadId)) {
        if (counted) entry.meetings.add(key);
        mine.reached.push(key);
      }
    }
    perCampaign.push(mine);
    if (counted) agg.set(dynasty, entry);
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
    perCampaign,
    population: input.reporting ? meetingPopulationOf(input.campaigns.map((c) => c.brandId), input.reporting) : null,
    byOrg: [...orgs]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([orgId, o]) => ({ orgId, spentUsd: o.cents / 100, contacted: o.acted.size, outcomes: o.reached.size })),
    pooled: {
      spentUsd: pooled.cents / 100,
      contacted: pooled.acted.size,
      outcomes: pooled.reached.size,
      spentByDynasty: Object.fromEntries([...pooled.centsByDynasty].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, c]) => [d, c / 100])),
    },
  };
}

/** One brand's acted leads and which of them reached `toStep` (every cause counts). */
async function readPairActed(orgId: string, brandId: string, campaignIds: string[], toStep: string): Promise<PairActed> {
  const actedByCampaign = await fetchFollowupActedLeads(brandId, campaignIds);
  const actedIds = new Set([...actedByCampaign.values()].flatMap((s) => [...s]));
  const reached = stepReading(toStep);
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

/** Thrown when an internal pipe's `to` step is not a catalogue step (no reading on a person): its outcomes cannot be counted. */
export class StepNotReadableError extends Error {
  constructor(readonly toStep: string) {
    super(`no reading of step ${toStep} on a person: the pipe's outcomes cannot be counted`);
  }
}

/** Any INTERNAL pipe across every org, per workflow dynasty (the rule above). */
export async function computeInternalPipeFleet(featureSlug: string, legKey: string, toStep: string): Promise<MeetingLegFleet> {
  if (!stepReading(toStep)) throw new StepNotReadableError(toStep);
  const campaigns = await fetchFleetLegCampaigns(featureSlug, legKey);
  const ids = [...new Set(campaigns.map((c) => c.campaignId))].sort();
  const reporting = MEETING_STEPS.has(toStep) ? await getMeetingReporting() : null;
  if (ids.length === 0) {
    return {
      legKey,
      campaignCount: 0,
      byDynasty: [],
      unattributableCampaignIds: [],
      perCampaign: [],
      population: reporting ? meetingPopulationOf([], reporting) : null,
      byOrg: [],
      pooled: { spentUsd: 0, contacted: 0, outcomes: 0, spentByDynasty: {} },
    };
  }

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
  return buildMeetingLegFleet({ campaigns, workflows, costGroups: costChunks.flat(), pairs: new Map(pairResults), legKey, reporting });
}

const INTERNAL_FLEET_FRESH_MS = 15 * 60_000;
const INTERNAL_FLEET_STALE_MS = 6 * 60 * 60_000;
const internalFleetCells = new Map<string, { value: MeetingLegFleet; at: number }>();
const internalFleetInFlight = new Map<string, Promise<MeetingLegFleet>>();

/**
 * `computeInternalPipeFleet` held per pipe, stale-while-revalidate (15 min fresh / 6 h stale, single-flight):
 * the freshness of every fleet evidence read on a request path (`lib/leg-fleet-evidence.ts`). A cold cell
 * whose build fails throws; a failed background refresh keeps the previous cell, loudly.
 */
export async function getInternalPipeFleet(featureSlug: string, legKey: string, toStep: string): Promise<MeetingLegFleet> {
  const key = `${featureSlug}|${legKey}`;
  const refresh = (): Promise<MeetingLegFleet> => {
    let p = internalFleetInFlight.get(key);
    if (!p) {
      p = computeInternalPipeFleet(featureSlug, legKey, toStep)
        .then((value) => {
          internalFleetCells.set(key, { value, at: Date.now() });
          return value;
        })
        .finally(() => internalFleetInFlight.delete(key));
      internalFleetInFlight.set(key, p);
    }
    return p;
  };
  const cell = internalFleetCells.get(key);
  const age = cell ? Date.now() - cell.at : Infinity;
  if (cell && age < INTERNAL_FLEET_FRESH_MS) return cell.value;
  if (cell && age < INTERNAL_FLEET_STALE_MS) {
    refresh().catch((err) => console.error(`[features-service] internal pipe ${key} refresh failed (serving the last value): ${(err as Error).message}`));
    return cell.value;
  }
  return refresh();
}

/** Test seam. */
export function __resetInternalPipeFleet(): void {
  internalFleetCells.clear();
  internalFleetInFlight.clear();
}

/**
 * PURE: the people a scope's campaigns acted on and that reached the pipe's step, per dynasty. `inScope`
 * picks the campaigns of the grain (every one for the fleet; the brand's, the identity's, the offer's).
 */
export function internalPipeCountsByDynasty(
  fleet: Pick<MeetingLegFleet, "perCampaign">,
  inScope: (c: MeetingLegFleet["perCampaign"][number]) => boolean,
): Map<string, { contacted: number; reached: number }> {
  const sets = new Map<string, { acted: Set<string>; reached: Set<string> }>();
  for (const c of fleet.perCampaign) {
    if (!inScope(c)) continue;
    const e = sets.get(c.dynasty) ?? { acted: new Set<string>(), reached: new Set<string>() };
    for (const k of c.acted) e.acted.add(k);
    for (const k of c.reached) e.reached.add(k);
    sets.set(c.dynasty, e);
  }
  return new Map([...sets].map(([d, e]) => [d, { contacted: e.acted.size, reached: e.reached.size }]));
}

