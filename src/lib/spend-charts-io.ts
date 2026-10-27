/**
 * The reads behind `lib/spend-charts.ts` (SPEND-CHARTS-1019): one chart per scope of a brand's sales funnel campaigns
 * (an offer, one funnel campaign, one pipe of it), every scope read the SAME way, no channel or slug branch.
 *
 *   - spend per UTC day: the scope's own dated COMMITTED spend (`fetchBrandCommittedSpendByDay`, the read every
 *     dated money curve uses), on the caller's pricing; a pipe reads its OWN spend (`lib/pipe-spend-attribution.ts`);
 *   - the same spend per (day, runs task) with the runs carrying committed cost (`fetchSpendByTaskDay`), folded into
 *     the pipe's actions; FAIL-SOFT (the curves stay served, `byAction` empty + `spendByActionUnavailableReason`);
 *   - the people: ONE brand-wide lead read (shared by every scope of the request), each scope keeping the people its
 *     campaigns served, plus, on a leg that starts at a later step (an AI meeting booking), the people its units were
 *     HANDED (lead-service follow-up ledger); dated by the event timestamps and the stated outcomes (meetings, sales),
 *     the overlays every revenue read applies;
 *   - the expected values: the scope's expected return model (`lib/expected-return.ts`) for the cost per outcome and
 *     the return, the leg's rate (`lib/expected-conversion.ts` sources) for the conversion.
 */
import { fetchLeadsForRevenue } from "./leads-client.js";
import { dedupPersonsByLead, type EnginePerson } from "./revenue-engine.js";
import { fetchEventTimestamps } from "./email-status-client.js";
import { fetchObservedStepFacts } from "./observed-steps.js";
import { applySignalOverlays } from "./signal-overlays.js";
import { DEFAULT_PRICED_CAUSES } from "./outcome-cause.js";
import { fetchFollowupActionRows, type FollowupActionRow } from "./followup-actions-client.js";
export { fetchFollowupActionRows };
import { fetchBrandCommittedSpendByDay } from "./brand-spend-by-day-client.js";
import { addBrandLevelByDay, fetchBrandLevelSpend } from "./brand-level-spend.js";
import { fetchSpendByTaskDay } from "./spend-by-task-day-client.js";
import { resolvePipeSpendAttribution } from "./pipe-spend-attribution-io.js";
import { withPipeSpendAttribution } from "./pipe-spend-attribution.js";
import { legMaturity } from "./maturity.js";
import { pipeLegKeyOf, storedLegKeyOf } from "./funnel-legs.js";
import { STEP_SIGNAL } from "./value-added.js";
import { ACT_IS_OUTCOME_STEPS } from "./funnel-campaign-activity.js";
import { DEFAULT_ENTRY_RATE_PCT } from "./default-leg-rates.js";
import type { ExpectedReturn } from "./expected-return.js";
import type { Pricing } from "./pricing.js";
import type { ChannelStepKey } from "./acquisition-channels.js";
import { buildSpendChartDays, type ChartPerson, type SpendChartExpected, type SpendChartPoint, type TaskSpendRow } from "./spend-charts.js";

/** The engine signal a person carries once they reached a step (`STEP_SIGNAL` + the attended rung). */
const SIGNAL_OF_STEP: Readonly<Record<string, string>> = { ...STEP_SIGNAL, meeting_attended: "meetingAttended", purchase: "closeWin" };

/** The leg a chart is drawn on: the pipe's (or the scope's leading pipe's) own leg. */
export interface ChartLeg {
  /** The channel performing it. */
  channelSlug: string;
  /** The leg key as campaign-service stores it on the unit. */
  legKey: string;
  /** Null = from nothing (Start). */
  fromStep: string | null;
  toStep: string;
}

/** One scope to chart. */
export interface ChartScope {
  /** Every unit campaign of the scope (its spend). */
  campaignIds: string[];
  featureSlugs: string[];
  /** The campaigns whose SERVED people are the scope's population (a sourcing pipe's are its funnel's outreach units). */
  personCampaignIds: string[];
  /** The units whose HANDED people join the population (a leg starting at a later step). */
  actingCampaignIds: string[];
  leg: ChartLeg | null;
  /** A pipe: its own unit, read with the pipe's own spend attribution. */
  pipe: { campaignId: string; featureSlug: string } | null;
  /**
   * The offer grain: the brand's campaign-less work (setup, notifications) joins the spend IN FULL, per day, like on
   * every offer money figure (owner 2026-10-22, ROI-SPENT-SAME-BASIS-1022, `lib/brand-level-spend.ts`).
   */
  brandLevelSpend: boolean;
}

export interface SpendChart {
  /** The leg the outcome and the conversion are read on; null when the scope runs no leg we perform. */
  leg: (ChartLeg & { maturityDays: number; learningOutcomesRequired: number }) | null;
  /** The step every outcome here is counted in (the leg's TO step). */
  outcomeStep: string | null;
  /** Why the outcome curves are empty, when they are (`no_leg`, `outcome_step_not_counted`). */
  outcomeUnavailableReason: string | null;
  /** Why the conversion is null on every day (`no_entry_population`: a leg that FINDS people has none to convert). */
  conversionUnavailableReason: string | null;
  daily: SpendChartPoint[];
  /** Why `byAction` is empty on every day, when it is. */
  spendByActionUnavailableReason: string | null;
  totals: {
    spendUsd: number;
    outcomes: number;
    costPerOutcomeUsd: number | null;
    entered: number;
    converted: number;
    conversionRatePct: number | null;
    learning: boolean | null;
  };
  expected: SpendChartExpected;
}

type Headers = { orgId: string; userId?: string; runId?: string };

const dayOf = (iso: string | null | undefined): string | null => (iso ? iso.slice(0, 10) : null);

/** Is the leg an ENTRY leg (from nothing or from Lead found): its people enter on their first message. */
export const isEntryLeg = (leg: ChartLeg): boolean => leg.fromStep === null || leg.fromStep === "lead_found";

/**
 * ONE SCOPE's people, overlays applied: the people its campaigns served (one campaign = lead-service's campaign read
 * and that campaign's own event dates, several = the brand's rows of those campaigns, the identity rule every revenue
 * read uses) plus, on a leg from a later step, the people its units were handed (read on the brand's rows).
 */
export async function readScopePeople(
  brandId: string,
  personCampaignIds: readonly string[],
  handedLeadIds: ReadonlySet<string>,
  headers: Headers,
): Promise<EnginePerson[]> {
  const single = personCampaignIds.length === 1 ? personCampaignIds[0] : undefined;
  const [served, brandRows] = await Promise.all([
    personCampaignIds.length === 0 ? Promise.resolve([]) : fetchLeadsForRevenue(brandId, single ?? [...personCampaignIds], headers),
    handedLeadIds.size === 0 ? Promise.resolve([]) : fetchLeadsForRevenue(brandId, undefined, headers),
  ]);
  const servedIds = new Set(served.map((p) => p.leadId));
  const persons = dedupPersonsByLead([...served, ...brandRows.filter((p) => handedLeadIds.has(p.leadId) && !servedIds.has(p.leadId))]);
  const emails = [...new Set(persons.map((p) => p.email).filter((e): e is string => Boolean(e)))];
  // Dates are what the curves stand on: the timestamp read FAILS LOUD (an undated population would draw nothing).
  // The stated outcomes ride fail-soft like on every revenue read (unreadable = those rungs unobserved, logged).
  const [timestamps, observed] = await Promise.all([
    fetchEventTimestamps(brandId, single, emails, headers),
    fetchObservedStepFacts(brandId, DEFAULT_PRICED_CAUSES).catch((err: Error) => {
      console.warn(`[features-service] spend charts: step statements unreadable for brand ${brandId} (overlay skipped): ${err.message}`);
      return null;
    }),
  ]);
  applySignalOverlays(persons, timestamps, observed?.byEmail ?? null);
  return persons;
}

/**
 * PURE. The scope's people reduced to (entered, converted) on its leg.
 *   - entry leg: everybody its campaigns served; entered = contacted (first message day), converted = reached TO.
 *   - a leg from a later step: the people its units were handed (entered the day they were handed, else the day they
 *     reached FROM) plus the people its campaigns served who reached FROM; converted = reached TO (an ACT step: acted on).
 *   - a leg TO Lead found: nobody enters; every served person is an outcome on their serve day.
 */
export function chartPersonsOf(
  leg: ChartLeg,
  persons: readonly EnginePerson[],
  personCampaignIds: ReadonlySet<string>,
  handed: ReadonlyMap<string, { claimedAt: string | null; actedAt: string | null; acted: boolean }>,
  /**
   * The scope's first day (its first spend): a date before it belongs to another campaign that worked the same person
   * (a prospect re-contacted today was first emailed, and may have replied, months ago). Null = no such cut.
   */
  scopeStart: string | null = null,
): ChartPerson[] | null {
  // `persons` is the scope's own read (`readScopePeople`): everybody it served, once.
  const served = persons.filter((p) => p.campaignId != null && personCampaignIds.has(p.campaignId));
  if (leg.toStep === "lead_found") {
    return served.map((p) => ({ entered: false, enteredOn: null, converted: true, convertedOn: dayOf(p.servedAt ?? null) }));
  }
  const actIsOutcome = ACT_IS_OUTCOME_STEPS.has(leg.toStep);
  const toSignal = SIGNAL_OF_STEP[leg.toStep];
  if (!toSignal && !actIsOutcome) return null;
  const reached = (p: EnginePerson) => (toSignal ? Boolean(p.signals[toSignal]) : false);
  const reachedOn = (p: EnginePerson) => (toSignal ? dayOf(p.signalDates?.[toSignal] ?? null) : null);

  if (isEntryLeg(leg)) {
    return served.map((p) => {
      // The cohort day is the first send; one from before the scope existed is another campaign's (a prospect
      // re-contacted today was first emailed months ago): then the scope's own SERVE (the maturity clock of
      // `lib/maturity.ts`; `servedAt` is the LATEST serve, so it is never preferred over a send of this scope).
      const sent = dayOf(p.signalDates?.contacted ?? p.signalDates?.sent ?? null);
      const enteredOn = sent !== null && (scopeStart === null || sent >= scopeStart) ? sent : (dayOf(p.servedAt ?? null) ?? sent);
      return { entered: Boolean(p.signals.contacted), enteredOn, ...ofScope(scopeStart, reached(p), reachedOn(p)) };
    });
  }
  const fromSignal = SIGNAL_OF_STEP[leg.fromStep!];
  const out = new Map<string, ChartPerson>();
  const byLead = new Map(persons.map((p) => [p.leadId, p] as const));
  for (const [leadId, h] of handed) {
    const p = byLead.get(leadId);
    const enteredOn = dayOf(h.claimedAt) ?? (p && fromSignal ? dayOf(p.signalDates?.[fromSignal] ?? null) : null);
    out.set(leadId, {
      entered: true,
      enteredOn,
      ...(actIsOutcome ? { converted: h.acted, convertedOn: dayOf(h.actedAt) } : ofScope(scopeStart, p ? reached(p) : false, p ? reachedOn(p) : null)),
    });
  }
  for (const p of served) {
    if (out.has(p.leadId) || !fromSignal || !p.signals[fromSignal]) continue;
    const enteredOn = dayOf(p.signalDates?.[fromSignal] ?? null);
    out.set(p.leadId, { entered: true, enteredOn, ...ofScope(scopeStart, reached(p), reachedOn(p)) });
  }
  return [...out.values()];
}

/** An outcome counts for the scope only when it came on or after the scope's first day (an undated one is given the benefit of the doubt). */
function ofScope(scopeStart: string | null, converted: boolean, convertedOn: string | null): { converted: boolean; convertedOn: string | null } {
  if (!converted) return { converted: false, convertedOn: null };
  if (scopeStart !== null && convertedOn !== null && convertedOn < scopeStart) return { converted: false, convertedOn: null };
  return { converted: true, convertedOn };
}

/** PURE. The leg's expected conversion: an entry leg on the fleet's (else the seeded entry default), a later leg on the brand's rate. */
export function expectedConversionOf(
  leg: ChartLeg,
  fleetConversions: ReadonlyMap<string, number>,
  brandRate: { ratePct: number | null; source: string | null } | null,
): Pick<SpendChartExpected, "conversionRatePct" | "conversionBasis" | "conversionSource" | "conversionUnavailableReason"> {
  const none = (reason: string) => ({ conversionRatePct: null, conversionBasis: null, conversionSource: null, conversionUnavailableReason: reason });
  if (leg.toStep === "lead_found") return none("no_entry_population");
  const funnelLeg = storedLegKeyOf(pipeLegKeyOf(leg.channelSlug, leg.legKey));
  if (isEntryLeg(leg)) {
    const fleet = fleetConversions.get(`${funnelLeg}|${leg.channelSlug}`);
    if (fleet !== undefined) return { conversionRatePct: fleet, conversionBasis: "fleet", conversionSource: "fleet_measured", conversionUnavailableReason: null };
    const d = DEFAULT_ENTRY_RATE_PCT[leg.toStep as ChannelStepKey];
    if (d !== undefined) return { conversionRatePct: d, conversionBasis: "default", conversionSource: "default_entry", conversionUnavailableReason: null };
    return none("no_rate_for_leg");
  }
  if (brandRate && brandRate.ratePct !== null && brandRate.source !== null) {
    const basis = brandRate.source === "measured" ? "measured" : brandRate.source === "manual" ? "stated" : "default";
    return { conversionRatePct: brandRate.ratePct, conversionBasis: basis, conversionSource: brandRate.source, conversionUnavailableReason: null };
  }
  return none("no_rate_for_leg");
}

/** PURE. The expected cost per outcome and return, kept only when the model prices THIS chart's outcome step. */
export function expectedCostAndReturnOf(
  expected: ExpectedReturn,
  outcomeStep: string | null,
): Pick<SpendChartExpected, "costPerOutcomeUsd" | "costPerOutcomeBasis" | "costPerOutcomeUnavailableReason" | "roiMultiple" | "roiBasis" | "roiUnavailableReason"> {
  const cpo = expected.costPerOutcome;
  const cost =
    cpo && outcomeStep && cpo.stepKey === outcomeStep
      ? { costPerOutcomeUsd: cpo.costPerOutcomeUsd, costPerOutcomeBasis: cpo.basis, costPerOutcomeUnavailableReason: null }
      : {
          costPerOutcomeUsd: null,
          costPerOutcomeBasis: null,
          costPerOutcomeUnavailableReason: cpo ? "expected_prices_another_step" : (expected.unavailableReason ?? "no_expected_cost_for_leg"),
        };
  return { ...cost, roiMultiple: expected.roiMultiple, roiBasis: expected.basis, roiUnavailableReason: expected.unavailableReason };
}

/** TODAY in UTC. */
export const utcToday = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/** One scope's chart. Spend and people reads fail loud; the action split fails soft. */
export async function computeSpendChart(args: {
  brandId: string;
  scope: ChartScope;
  /** The follow-up ledger rows of every unit of the request (`fetchFollowupActionRows`); the scope keeps its own. */
  handedRows: readonly FollowupActionRow[];
  expected: ExpectedReturn;
  fleetConversions: ReadonlyMap<string, number>;
  brandRateOf: (funnelLegKey: string) => { ratePct: number | null; source: string | null } | null;
  pricing: Pricing;
  headers: Headers;
  today?: string;
}): Promise<SpendChart> {
  const { brandId, scope, handedRows, expected, fleetConversions, brandRateOf, pricing, headers } = args;
  const today = args.today ?? utcToday();
  const leg = scope.leg;

  const readSpend = async (): Promise<{ byDay: Map<string, number>; tasks: TaskSpendRow[] | null; tasksReason: string | null }> => {
    const [ownByDay, brandLevel, tasks] = await Promise.all([
      fetchBrandCommittedSpendByDay(brandId, scope.campaignIds, scope.featureSlugs, headers, pricing),
      scope.brandLevelSpend
        ? fetchBrandLevelSpend({ brandId, orgId: headers.orgId, pricing, featureScope: scope.featureSlugs, campaignScoped: true })
        : Promise.resolve(null),
      fetchSpendByTaskDay(brandId, scope.campaignIds, scope.featureSlugs, headers, pricing).then(
        (rows) => ({ rows, reason: null as string | null }),
        (err: Error) => {
          console.error(`[features-service] spend charts: spend by action unreadable (brand ${brandId}, campaigns ${scope.campaignIds.join(",")}): ${err.message}`);
          return { rows: null, reason: "spend_by_action_unreadable" };
        },
      ),
    ]);
    // The brand-level part is no runs task of the scope's campaigns: it shows in the day's `byActionGapUsd`.
    return { byDay: addBrandLevelByDay(ownByDay, brandLevel), tasks: tasks.rows, tasksReason: tasks.reason };
  };
  const attribution = scope.pipe
    ? await resolvePipeSpendAttribution({ brandId, featureSlug: scope.pipe.featureSlug, pipeCampaignIds: scope.campaignIds, headers })
    : null;
  const spend =
    scope.campaignIds.length === 0
      ? { byDay: new Map<string, number>(), tasks: [] as TaskSpendRow[], tasksReason: null }
      : await withPipeSpendAttribution(attribution, readSpend);

  const acting = new Set(leg && !isEntryLeg(leg) ? scope.actingCampaignIds : []);
  const handed = new Map<string, { claimedAt: string | null; actedAt: string | null; acted: boolean }>();
  for (const r of handedRows) {
    if (!acting.has(r.actingCampaignId)) continue;
    const prev = handed.get(r.leadId);
    const earliest = (a: string | null | undefined, b: string | null) => (a && (!b || a < b) ? a : b);
    handed.set(r.leadId, {
      claimedAt: earliest(prev?.claimedAt, r.firstClaimedAt ?? r.firstActedAt),
      actedAt: earliest(prev?.actedAt, r.firstActedAt),
      acted: Boolean(prev?.acted) || r.actedCount > 0,
    });
  }

  const persons = leg ? await readScopePeople(brandId, scope.personCampaignIds, new Set(handed.keys()), headers) : [];
  const spendDays = [...spend.byDay.keys()].sort();
  const chartPersons = leg ? chartPersonsOf(leg, persons, new Set(scope.personCampaignIds), handed, spendDays[0] ?? null) : null;
  const maturity = leg ? legMaturity(storedLegKeyOf(pipeLegKeyOf(leg.channelSlug, leg.legKey))) : null;
  const daily = buildSpendChartDays({
    spendByDay: spend.byDay,
    taskRows: spend.tasks,
    persons: chartPersons ?? [],
    durationDays: maturity?.durationDays ?? 0,
    outcomesRequired: maturity?.outcomesRequired ?? 0,
    today,
  });
  const last = daily.at(-1) ?? null;
  const outcomeStep = leg && chartPersons ? leg.toStep : null;
  const funnelLegKey = leg ? storedLegKeyOf(pipeLegKeyOf(leg.channelSlug, leg.legKey)) : null;
  const conversion = leg ? expectedConversionOf(leg, fleetConversions, funnelLegKey ? brandRateOf(funnelLegKey) : null) : null;
  return {
    leg: leg && maturity ? { ...leg, maturityDays: maturity.durationDays, learningOutcomesRequired: maturity.outcomesRequired } : null,
    outcomeStep,
    outcomeUnavailableReason: !leg ? "no_leg" : chartPersons === null ? "outcome_step_not_counted" : null,
    conversionUnavailableReason: !leg ? "no_leg" : leg.toStep === "lead_found" ? "no_entry_population" : null,
    daily,
    spendByActionUnavailableReason: spend.tasksReason,
    totals: {
      spendUsd: last?.cumulativeSpendUsd ?? 0,
      outcomes: last?.cumulativeOutcomes ?? 0,
      costPerOutcomeUsd: last?.costPerOutcomeUsd ?? null,
      entered: last?.cumulativeEntered ?? 0,
      converted: last?.cumulativeConverted ?? 0,
      conversionRatePct: last?.conversionRatePct ?? null,
      learning: last && outcomeStep ? last.learning : null,
    },
    expected: {
      ...expectedCostAndReturnOf(expected, outcomeStep),
      ...(conversion ?? { conversionRatePct: null, conversionBasis: null, conversionSource: null, conversionUnavailableReason: "no_leg" }),
    },
  };
}
