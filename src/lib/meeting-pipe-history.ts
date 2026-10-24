/**
 * THE AI MEETING BOOKING PIPE AS OF A PAST DAY (owner 2026-10-24, MEETING-COST-METHODS-1024: « pourquoi une vue
 * historique ne serait pas possible ? »). Pure; the reads are in `fleet-index-history-io.ts`.
 *
 * The live pipe (`lib/meeting-leg-fleet.ts`) is rebuilt AS OF the end of day D with the same code
 * (`buildMeetingLegFleet`), on inputs each cut at D:
 *   - SPEND: each campaign's spend per workflow version and run-start day (runs ledger, incurred), runs started by D;
 *   - ACTED ON: a person counts for a campaign from the first time its worker answered them (lead-service follow-up
 *     ledger `firstActedAt`), on or before D;
 *   - REACHED: an acted person reached "meeting booked" by D when the live pipe's own reading of them (the revenue
 *     engine's signals, step statements and qualifications overlaid, matched by email) holds a meeting dated on or
 *     before D (`event: acted_person_meeting`, read in `fleet-index-history-io.ts`);
 *   - POPULATION: a brand counts once it had reported a meeting (booked or attended, any source) by D.
 * Who could be picked on D is the live rule as of D (`executableDynastiesOn` + the stated assignments then).
 * Data dated after D never moves D's figures. An act or a meeting with no date is in no past day.
 */
import { buildMeetingLegFleet, MEETING_BOOKING_LEG_KEY, type MeetingLegFleet, type PairActed } from "./meeting-leg-fleet.js";
import { meetingReportingFrom } from "./meeting-population.js";
import { rankLegWorkflows, type LegWorkflowRankingRow } from "./leg-workflow-ranking.js";
import type { FleetLegCampaign } from "./fleet-leg-campaigns.js";
import type { CostGroup, WorkflowMetadata } from "./public-stats-clients.js";
import type { AssignmentChange, WorkflowVersion } from "./fleet-index-history.js";

const DAY_MS = 86_400_000;
const endOfDayIso = (day: string): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS - 1).toISOString();

export interface MeetingCampaignSpend {
  campaignId: string;
  workflowSlug: string;
  /** Run-start UTC day. */
  day: string;
  spentCents: number;
}

export interface MeetingAct {
  brandId: string;
  campaignId: string;
  leadId: string;
  firstActedAt: string | null;
}

/**
 * A dated meeting: lead-service's meeting facts (`meeting_booked` / `meeting_attended`, every brand: who REPORTS meetings)
 * and, per person the pipe acted on, the live reading's booked meeting (`acted_person_meeting`: who it REACHED).
 */
export interface MeetingFact {
  brandId: string;
  leadId: string | null;
  event: string;
  occurredAt: string | null;
}

export interface MeetingHistoryInputs {
  campaigns: readonly FleetLegCampaign[];
  workflows: readonly WorkflowVersion[];
  spend: readonly MeetingCampaignSpend[];
  acts: readonly MeetingAct[];
  meetings: readonly MeetingFact[];
  assignmentChanges: readonly AssignmentChange[];
  /** Absorbed dynasty → its survivor (workflow-service's merges, `fetchDynastyMerges`); absent = none. */
  merges?: ReadonlyMap<string, string>;
}

/** PURE. The executable dynasties at the end of `day` (a version created by then, not yet stopped). */
export function executableOn(day: string, versions: readonly WorkflowVersion[]): Set<string> {
  const end = Date.parse(endOfDayIso(day));
  const out = new Set<string>();
  for (const v of versions) {
    if (Date.parse(v.createdAt) > end) continue;
    if (v.executableUntil === null || Date.parse(v.executableUntil) > end) out.add(v.workflowDynastySlug);
  }
  return out;
}

/**
 * PURE. The stated assignments of a leg at the end of `day`: before its first change the concept did not exist and every
 * dynasty counts as active (the fleet index history's rule). Merged dynasties pool like the live read
 * (`poolLegAssignments`): an absorbed dynasty is no row of its own, a survivor with no row takes its members' (active first).
 */
export function assignmentsOn(
  changes: readonly AssignmentChange[],
  legKey: string,
  day: string,
  dynasties: readonly string[],
  merges: ReadonlyMap<string, string> = new Map(),
): Map<string, "active" | "deprecated"> {
  const legChanges = changes.filter((c) => c.legKey === legKey).sort((a, b) => (a.decidedAt < b.decidedAt ? -1 : 1));
  const end = endOfDayIso(day);
  const raw = new Map<string, "active" | "deprecated">();
  if (legChanges.length === 0 || legChanges[0]!.decidedAt > end) {
    for (const d of dynasties) raw.set(d, "active");
    return raw;
  }
  for (const c of legChanges) {
    if (c.decidedAt > end) break;
    if (c.toState === "active" || c.toState === "deprecated") raw.set(c.workflowDynastySlug, c.toState);
    else raw.delete(c.workflowDynastySlug);
  }
  const out = new Map<string, "active" | "deprecated">();
  for (const [d, st] of raw) if (!merges.has(d)) out.set(d, st);
  const borrowed = [...raw].filter(([d]) => merges.has(d)).sort(([a, x], [b, y]) => (x === "active" ? 0 : 1) - (y === "active" ? 0 : 1) || a.localeCompare(b));
  for (const [d, st] of borrowed) {
    const survivor = merges.get(d)!;
    if (!out.has(survivor)) out.set(survivor, st);
  }
  return out;
}

/** PURE. The pipe on `day`: the live roll-up on inputs cut at the end of the day, and its workflow ranking. */
export function meetingPipeOn(inputs: MeetingHistoryInputs, day: string): { fleet: MeetingLegFleet; rows: LegWorkflowRankingRow[] } {
  const end = endOfDayIso(day);
  const cents = new Map<string, number>();
  for (const s of inputs.spend) {
    if (s.day > day) continue;
    const k = `${s.campaignId}\t${s.workflowSlug}`;
    cents.set(k, (cents.get(k) ?? 0) + s.spentCents);
  }
  const costGroups: CostGroup[] = [...cents].map(([k, c]) => {
    const [campaignId, workflowSlug] = k.split("\t");
    return { dimensions: { campaignId: campaignId!, workflowSlug: workflowSlug! }, totalCostInUsdCents: c.toFixed(10), runCount: 1, minStartedAt: null, maxStartedAt: null };
  });
  const booked = new Map<string, Set<string>>();
  const reporting = new Set<string>();
  for (const m of inputs.meetings) {
    if (!m.occurredAt || m.occurredAt > end) continue;
    if (m.event === "meeting_booked" || m.event === "meeting_attended") reporting.add(m.brandId);
    if (m.event === "acted_person_meeting" && m.leadId) {
      const s = booked.get(m.brandId) ?? new Set<string>();
      s.add(m.leadId);
      booked.set(m.brandId, s);
    }
  }
  const pairs = new Map<string, PairActed>();
  for (const a of inputs.acts) {
    if (!a.firstActedAt || a.firstActedAt > end) continue;
    const pair = pairs.get(a.brandId) ?? { actedByCampaign: new Map<string, Set<string>>(), meetingLeadIds: new Set<string>() };
    const set = pair.actedByCampaign.get(a.campaignId) ?? new Set<string>();
    set.add(a.leadId);
    pair.actedByCampaign.set(a.campaignId, set);
    if (booked.get(a.brandId)?.has(a.leadId)) pair.meetingLeadIds.add(a.leadId);
    pairs.set(a.brandId, pair);
  }
  const fleet = buildMeetingLegFleet({
    campaigns: inputs.campaigns,
    workflows: inputs.workflows as unknown as WorkflowMetadata[],
    costGroups,
    pairs,
    legKey: MEETING_BOOKING_LEG_KEY,
    reporting: meetingReportingFrom(reporting),
  });
  const dynasties = [...new Set(inputs.workflows.map((w) => w.workflowDynastySlug))];
  const names = new Map<string, string | null>();
  for (const w of inputs.workflows) if (!names.has(w.workflowDynastySlug)) names.set(w.workflowDynastySlug, w.workflowDynastyName);
  const rows = rankLegWorkflows({
    byDynasty: new Map(fleet.byDynasty),
    names,
    assignments: assignmentsOn(inputs.assignmentChanges, MEETING_BOOKING_LEG_KEY, day, dynasties, inputs.merges),
    executable: executableOn(day, inputs.workflows),
    pipelineUsd: new Map(),
    billedSpendUsd: new Map(),
  });
  return { fleet, rows };
}
