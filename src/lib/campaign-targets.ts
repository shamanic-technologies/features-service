/**
 * OUTCOME-RUNG-AND-TARGET-1106 (owner 2026-11-06, Today = « plusieurs cards par Target, en ligne par target »): one ROW per
 * ongoing funnel campaign of a brand, on its Target. PURE; IO in `routes/campaign-targets.ts`.
 *
 * The PAST is measured and never moves with the Plan: the Target outcomes the campaign's own pipes made, per UTC day
 * (the pipe spend chart of the unit landing on the Target), the campaign's whole spend, so its $ per Target. Only the
 * PROJECTION reads the current Plan (the factory pass's stored plan line: its expected cost per Target) and says which
 * plan computation it used. A figure that cannot be served is null with a reason, never a guess.
 */

export interface TargetDayCount {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  /** Target outcomes dated on or before the day (cumulative; the last day also holds the undated ones). */
  cumulativeOutcomes: number;
}

export interface CampaignTargetInput {
  salesFunnelCampaignId: string;
  name: string;
  offerId: string;
  mode: "proactive" | "reactive" | null;
  target: { key: string; label: string; lifecycleRung: string | null } | null;
  /** The Target's outcomes per day from the campaign's pipe(s) landing on it (summed per day); null = no pipe of it lands on the Target. */
  targetDays: readonly TargetDayCount[] | null;
  /** The campaign's people at the Target step since inception (its funnel read), when no pipe chart counts it per day. */
  undatedTargetCount: number | null;
  /** Everything the campaign spent (every unit), since inception, and per UTC day. */
  spentUsd: number | null;
  spendByDay: ReadonlyArray<{ date: string; spendUsd: number }>;
  /** What one Target is worth (the plan's catalogue value on the offer's lifetime revenue); null = no value (after Paid client) or no plan. */
  targetValueUsd: number | null;
  targetValueUnavailableReason: string | null;
  /** The current plan line's expected cost per Target, the plan computation it comes from. */
  plan: { computedAt: string; funnelId: string | null; costPerTargetUsd: number | null; basis: string | null; unavailableReason: string | null } | null;
  /** What the customer lets the campaign spend per day (billing caps); null = none stated. */
  dailyBudgetUsd: number | null;
  /** NOW (ISO) and TODAY (UTC day): the clock of the projection. */
  now: string;
}

export interface MeasuredReturn {
  /** Target outcomes × the Target's value ÷ the money actually spent. */
  roiMultiple: number | null;
  valueUsd: number | null;
  spentUsd: number | null;
  unavailableReason: string | null;
}

export interface CampaignTargetRow {
  salesFunnelCampaignId: string;
  name: string;
  offerId: string;
  target: { key: string; label: string; lifecycleRung: string | null } | null;
  /** Target outcomes since the campaign started (measured). */
  outcomesToDate: number | null;
  outcomesUnavailableReason: string | null;
  spentUsd: number | null;
  /** spentUsd ÷ outcomesToDate (every unit's spend: what the Targets cost, full absorption). */
  costPerOutcomeUsd: number | null;
  costPerOutcomeUnavailableReason: string | null;
  measuredReturn: MeasuredReturn;
  /** One point per UTC day from the campaign's first activity to today: that day's Target outcomes + the cumulative. */
  past: Array<{ date: string; outcomes: number; cumulativeOutcomes: number }>;
  pastUnavailableReason: string | null;
  projection: {
    /** The plan computation this projection reads (the Plan changes from one tick to the next; the past never does). */
    planComputedAt: string | null;
    planFunnelId: string | null;
    costPerTargetUsd: number | null;
    costPerTargetBasis: string | null;
    spendPerDayUsd: number | null;
    spendPerDaySource: "daily_budget" | "spend_pace_7d" | null;
    outcomesPerDay: number | null;
    /** The next PROJECTION_DAYS UTC days after today: expected Target outcomes that day + the cumulative from today's count. */
    daily: Array<{ date: string; expectedOutcomes: number; cumulativeExpectedOutcomes: number }>;
    nextExpectedAt: string | null;
    nextExpectedInHours: number | null;
    unavailableReason: string | null;
  };
}

export const PROJECTION_DAYS = 30;
const PACE_DAYS = 7;

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** PURE: the next PROJECTION_DAYS days at `outcomesPerDay` from today's count, and when the next one is due. */
function paceOf(outcomesPerDay: number | null, outcomesToDate: number | null, now: string) {
  const today = now.slice(0, 10);
  const daily: CampaignTargetRow["projection"]["daily"] = [];
  if (outcomesPerDay !== null) {
    for (let k = 1; k <= PROJECTION_DAYS; k += 1) {
      daily.push({ date: addDays(today, k), expectedOutcomes: round(outcomesPerDay, 4), cumulativeExpectedOutcomes: round((outcomesToDate ?? 0) + outcomesPerDay * k, 2) });
    }
  }
  const nextExpectedInHours = outcomesPerDay !== null ? round(24 / outcomesPerDay, 2) : null;
  const nextExpectedAt = nextExpectedInHours !== null ? new Date(Date.parse(now) + nextExpectedInHours * 3_600_000).toISOString() : null;
  return { daily, nextExpectedAt, nextExpectedInHours };
}

/** PURE: one campaign's Target row. */
export function campaignTargetRowOf(i: CampaignTargetInput): CampaignTargetRow {
  const today = i.now.slice(0, 10);

  // ── The past: measured, plan-independent ──
  const days = i.targetDays ?? [];
  const lastCumulative = days.length > 0 ? days[days.length - 1]!.cumulativeOutcomes : null;
  const outcomesToDate = i.targetDays !== null ? (lastCumulative ?? 0) : i.undatedTargetCount;
  const outcomesUnavailableReason = i.target === null ? "campaign_states_no_target" : outcomesToDate === null ? "target_not_counted_for_this_campaign" : null;
  let previous = 0;
  const past = days.map((d) => {
    const outcomes = d.cumulativeOutcomes - previous;
    previous = d.cumulativeOutcomes;
    return { date: d.date, outcomes, cumulativeOutcomes: d.cumulativeOutcomes };
  });
  const pastUnavailableReason = i.target === null ? "campaign_states_no_target" : i.targetDays === null ? "target_not_dated_for_this_campaign" : null;

  const spent = i.spentUsd;
  const costPerOutcomeUsd = spent !== null && spent > 0 && outcomesToDate !== null && outcomesToDate > 0 ? round(spent / outcomesToDate, 4) : null;
  const costPerOutcomeUnavailableReason =
    costPerOutcomeUsd !== null ? null : outcomesUnavailableReason ?? (spent === null ? "spend_unreadable" : spent <= 0 ? "nothing_spent_yet" : "no_target_outcome_yet");

  const valueUsd = i.targetValueUsd !== null && outcomesToDate !== null ? round(outcomesToDate * i.targetValueUsd, 2) : null;
  const measuredReturn: MeasuredReturn =
    outcomesUnavailableReason !== null
      ? { roiMultiple: null, valueUsd: null, spentUsd: spent, unavailableReason: outcomesUnavailableReason }
      : i.targetValueUsd === null
        ? { roiMultiple: null, valueUsd: null, spentUsd: spent, unavailableReason: i.targetValueUnavailableReason ?? "target_has_no_value" }
        : spent === null
          ? { roiMultiple: null, valueUsd, spentUsd: null, unavailableReason: "spend_unreadable" }
          : spent <= 0
            ? { roiMultiple: null, valueUsd, spentUsd: spent, unavailableReason: "nothing_spent_yet" }
            : { roiMultiple: round(valueUsd! / spent, 2), valueUsd, spentUsd: spent, unavailableReason: null };

  // ── The projection: the current Plan's cost per Target × what the campaign spends per day ──
  const plan = i.plan;
  const paceDays = i.spendByDay.filter((d) => d.date < today && d.date >= addDays(today, -PACE_DAYS));
  const pace = paceDays.reduce((a, d) => a + d.spendUsd, 0) / PACE_DAYS;
  const spendPerDaySource: "daily_budget" | "spend_pace_7d" | null = i.dailyBudgetUsd !== null && i.dailyBudgetUsd > 0 ? "daily_budget" : pace > 0 ? "spend_pace_7d" : null;
  const spendPerDayUsd = spendPerDaySource === "daily_budget" ? i.dailyBudgetUsd : spendPerDaySource === "spend_pace_7d" ? round(pace, 4) : null;
  const costPerTarget = plan?.costPerTargetUsd ?? null;
  const projectionReason =
    i.target === null
      ? "campaign_states_no_target"
      : plan === null
        ? "plan_not_computed_yet"
        : costPerTarget === null || costPerTarget <= 0
          ? plan.unavailableReason ?? "plan_prices_no_target"
          : spendPerDayUsd === null
            ? "no_daily_budget_and_no_recent_spend"
            : null;
  const outcomesPerDay = projectionReason === null ? spendPerDayUsd! / costPerTarget! : null;
  const { daily, nextExpectedAt, nextExpectedInHours } = paceOf(outcomesPerDay, outcomesToDate, i.now);

  return {
    salesFunnelCampaignId: i.salesFunnelCampaignId,
    name: i.name,
    offerId: i.offerId,
    target: i.target,
    outcomesToDate,
    outcomesUnavailableReason,
    spentUsd: spent,
    costPerOutcomeUsd,
    costPerOutcomeUnavailableReason,
    measuredReturn,
    past,
    pastUnavailableReason,
    projection: {
      planComputedAt: plan?.computedAt ?? null,
      planFunnelId: plan?.funnelId ?? null,
      costPerTargetUsd: costPerTarget,
      costPerTargetBasis: plan?.basis ?? null,
      spendPerDayUsd,
      spendPerDaySource,
      outcomesPerDay: outcomesPerDay !== null ? round(outcomesPerDay, 4) : null,
      daily,
      nextExpectedAt,
      nextExpectedInHours,
      unavailableReason: projectionReason,
    },
  };
}

/** PURE: Σ per day over several cumulative series (two pipes of one campaign landing on the Target), days unioned and filled. */
export function sumCumulativeDays(series: ReadonlyArray<readonly TargetDayCount[]>): TargetDayCount[] {
  const dates = [...new Set(series.flatMap((s) => s.map((d) => d.date)))].sort();
  return dates.map((date) => ({
    date,
    cumulativeOutcomes: series.reduce((a, s) => {
      let v = 0;
      for (const d of s) if (d.date <= date) v = d.cumulativeOutcomes;
      return a + v;
    }, 0),
  }));
}

/**
 * TARGET-ROWS-UNIQUE-1107 (owner 2026-11-07, « Les rows target doivent etre unique. Si deux campagnes ont la mm target il
 * faut merger les rows »): ONE entry per (offer, Target) over every campaign of that offer on that Target (campaigns with
 * no Target share one entry per offer). Counts, spend, past and expected outcomes per day are SUMMED; $ each and the
 * return are recomputed on the summed inputs (never averaged), so one campaign = its row figure for figure. A person
 * reaching the Target under two campaigns counts in both: the per-campaign counts carry no person id.
 */
export type OfferTargetEntry = Omit<CampaignTargetRow, "salesFunnelCampaignId" | "name" | "projection"> & {
  /** The campaigns merged into this entry, oldest first (ids only: Today names no campaign). */
  salesFunnelCampaignIds: string[];
  projection: Omit<CampaignTargetRow["projection"], "spendPerDaySource" | "costPerTargetBasis"> & {
    spendPerDaySource: CampaignTargetRow["projection"]["spendPerDaySource"] | "mixed";
    costPerTargetBasis: string | null;
    /** Campaigns of the entry with no projection of their own (they add no expected outcome). */
    unprojectedCampaignIds: string[];
  };
};

export interface OfferTargetMember {
  input: CampaignTargetInput;
  row: CampaignTargetRow;
}

const sameOrNull = <T>(values: readonly T[]): T | null => (values.length > 0 && values.every((v) => v === values[0]) ? values[0]! : null);

/** PURE: the members' rows (already oldest first) merged per (offer, Target), in order of each group's first campaign. */
export function offerTargetsOf(members: readonly OfferTargetMember[]): OfferTargetEntry[] {
  const groups = new Map<string, OfferTargetMember[]>();
  for (const m of members) {
    const key = `${m.row.offerId}\u0000${m.row.target?.key ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return [...groups.values()].map(mergeGroup);
}

function mergeGroup(group: readonly OfferTargetMember[]): OfferTargetEntry {
  const ids = group.map((m) => m.row.salesFunnelCampaignId);
  if (group.length === 1) {
    // Picked field by field: the route's rows carry more (milestones) than an entry serves.
    const r = group[0]!.row;
    return {
      offerId: r.offerId,
      target: r.target,
      salesFunnelCampaignIds: ids,
      outcomesToDate: r.outcomesToDate,
      outcomesUnavailableReason: r.outcomesUnavailableReason,
      spentUsd: r.spentUsd,
      costPerOutcomeUsd: r.costPerOutcomeUsd,
      costPerOutcomeUnavailableReason: r.costPerOutcomeUnavailableReason,
      measuredReturn: r.measuredReturn,
      past: r.past,
      pastUnavailableReason: r.pastUnavailableReason,
      projection: { ...r.projection, unprojectedCampaignIds: r.projection.outcomesPerDay === null ? ids : [] },
    };
  }
  const first = group[0]!;
  const now = first.input.now;

  // ── The past: every campaign's Target outcomes summed per day; an undated campaign's count rides the last day. ──
  const anyUncounted = group.some((m) => m.row.outcomesToDate === null);
  const dated = group.filter((m) => m.input.targetDays !== null && m.row.pastUnavailableReason === null);
  const undatedSum = group.filter((m) => !dated.includes(m)).reduce((a, m) => a + (m.row.outcomesToDate ?? 0), 0);
  let targetDays: TargetDayCount[] | null = null;
  if (!anyUncounted && dated.length > 0) {
    targetDays = sumCumulativeDays(dated.map((m) => m.input.targetDays!));
    if (undatedSum > 0 && targetDays.length > 0) {
      const last = targetDays[targetDays.length - 1]!;
      targetDays[targetDays.length - 1] = { date: last.date, cumulativeOutcomes: last.cumulativeOutcomes + undatedSum };
    }
  }
  const spendByDay = new Map<string, number>();
  for (const m of group) for (const d of m.input.spendByDay) spendByDay.set(d.date, (spendByDay.get(d.date) ?? 0) + d.spendUsd);
  const valued = group.find((m) => m.input.targetValueUsd !== null);
  const measured = campaignTargetRowOf({
    ...first.input,
    targetDays,
    undatedTargetCount: anyUncounted ? null : targetDays === null ? undatedSum : null,
    spentUsd: group.every((m) => m.input.spentUsd !== null) ? group.reduce((a, m) => a + m.input.spentUsd!, 0) : null,
    spendByDay: [...spendByDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, spendUsd]) => ({ date, spendUsd })),
    targetValueUsd: valued?.input.targetValueUsd ?? null,
    targetValueUnavailableReason: valued ? null : first.input.targetValueUnavailableReason,
    plan: null,
    dailyBudgetUsd: null,
  });

  // ── The projection: each campaign's own expected outcomes per day, summed; $ per Target = Σ spend per day ÷ Σ outcomes per day. ──
  const projected = group.filter((m) => m.row.projection.outcomesPerDay !== null && m.row.projection.spendPerDayUsd !== null && (m.row.projection.costPerTargetUsd ?? 0) > 0);
  const spendPerDay = projected.reduce((a, m) => a + m.row.projection.spendPerDayUsd!, 0);
  const outcomesPerDay = projected.length > 0 ? projected.reduce((a, m) => a + m.row.projection.spendPerDayUsd! / m.row.projection.costPerTargetUsd!, 0) : null;
  const pace = paceOf(outcomesPerDay, measured.outcomesToDate, now);
  const planDates = group.map((m) => m.row.projection.planComputedAt).filter((d): d is string => d !== null).sort();
  const scope = projected.length > 0 ? projected : group;
  const sources = scope.map((m) => m.row.projection.spendPerDaySource);
  const bases = scope.map((m) => m.row.projection.costPerTargetBasis);

  return {
    offerId: first.row.offerId,
    target: first.row.target,
    salesFunnelCampaignIds: ids,
    outcomesToDate: measured.outcomesToDate,
    outcomesUnavailableReason: measured.outcomesUnavailableReason,
    spentUsd: measured.spentUsd,
    costPerOutcomeUsd: measured.costPerOutcomeUsd,
    costPerOutcomeUnavailableReason: measured.costPerOutcomeUnavailableReason,
    measuredReturn: measured.measuredReturn,
    past: measured.past,
    pastUnavailableReason: measured.pastUnavailableReason,
    projection: {
      planComputedAt: planDates.length > 0 ? planDates[planDates.length - 1]! : null,
      planFunnelId: sameOrNull(group.map((m) => m.row.projection.planFunnelId)),
      costPerTargetUsd: outcomesPerDay !== null && outcomesPerDay > 0 ? round(spendPerDay / outcomesPerDay, 4) : null,
      costPerTargetBasis: projected.length === 0 ? null : sameOrNull(bases) ?? "mixed",
      spendPerDayUsd: projected.length > 0 ? round(spendPerDay, 4) : null,
      spendPerDaySource: projected.length === 0 ? null : sameOrNull(sources) ?? "mixed",
      outcomesPerDay: outcomesPerDay !== null ? round(outcomesPerDay, 4) : null,
      ...pace,
      unavailableReason: outcomesPerDay !== null ? null : first.row.projection.unavailableReason,
      unprojectedCampaignIds: group.filter((m) => !projected.includes(m)).map((m) => m.row.salesFunnelCampaignId),
    },
  };
}
