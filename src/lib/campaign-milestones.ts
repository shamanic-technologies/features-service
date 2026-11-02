/**
 * FACTORY-USER-DASHBOARD-1102 (owner 2026-11-02, the customer campaign page, GTM Factory "Milestones"): one row per
 * milestone of a funnel campaign's line, from Start to its Target. PURE; IO in `routes/campaign-milestones.ts`.
 *
 * Every figure is MEASURED on the campaign when it can be (its people per step: the activity read; each pipe's own
 * spend: the spend charts), else EXPECTED from the campaign's stored plan line (the factory pass), and says which:
 * - outcomes = people of the campaign who reached the milestone since it started (measured only, never expected);
 * - cost per outcome = the spend of the pipe making it ÷ its outcomes; else the plan leg's expected cost;
 * - cost from Start = everything the pipes up to this milestone spent ÷ its people; else Σ expected cost x outcomes
 *   needed up to here ÷ this milestone's outcomes needed;
 * - conversion from the row above = its people ÷ the row above's people; else the plan leg's expected rate;
 * - attempts per Target = how many of this milestone one Target needs (expected, the plan's ladder).
 */

export interface MilestoneLegFigures {
  legKey: string;
  toStep: string;
  costPerOutcomeUsd: number | null;
  ratePct: number | null;
  outcomesNeededPerPayingClient: number | null;
  costSource: string | null;
}
export interface MilestonePipeSpend {
  toStep: string;
  spendUsd: number;
  outcomes: number;
}
export interface MilestoneStepPeople {
  key: string;
  label: string;
  people: number | null;
}

export interface MilestoneValue {
  value: number | null;
  basis: "measured" | "expected" | null;
  unavailableReason: string | null;
}

export interface MilestoneRow {
  step: string;
  label: string;
  isTarget: boolean;
  outcomes: number | null;
  outcomesUnavailableReason: string | null;
  costPerOutcomeUsd: MilestoneValue;
  costFromStartUsd: MilestoneValue;
  conversionFromAbovePct: MilestoneValue;
  attemptsPerTarget: MilestoneValue;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const titleOf = (key: string) => key.split("_").map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
const measured = (v: number, d = 4): MilestoneValue => ({ value: round(v, d), basis: "measured", unavailableReason: null });
const expected = (v: number, d = 4): MilestoneValue => ({ value: round(v, d), basis: "expected", unavailableReason: null });
const none = (reason: string): MilestoneValue => ({ value: null, basis: null, unavailableReason: reason });

/** PURE: the milestones table of one funnel campaign (`legs` = its plan line up to the Target, in order). */
export function milestonesOf(input: { legs: readonly MilestoneLegFigures[]; steps: readonly MilestoneStepPeople[]; pipes: readonly MilestonePipeSpend[] }): MilestoneRow[] {
  const { legs, steps, pipes } = input;
  const peopleOf = new Map(steps.map((s) => [s.key, s]));
  const neededAtTarget = legs[legs.length - 1]?.outcomesNeededPerPayingClient ?? null;
  const rows: MilestoneRow[] = [
    {
      step: "start",
      label: "Start",
      isTarget: false,
      outcomes: null,
      outcomesUnavailableReason: "start_is_the_market",
      costPerOutcomeUsd: none("start_is_the_market"),
      costFromStartUsd: measured(0),
      conversionFromAbovePct: none("first_row"),
      attemptsPerTarget: none("start_is_the_market"),
    },
  ];
  let spentUpTo = 0;
  let expectedSpendUpTo = 0;
  let expectedComplete = true;
  let previousPeople: number | null = null;
  legs.forEach((leg, i) => {
    const own = pipes.filter((p) => p.toStep === leg.toStep);
    const ownSpend = own.reduce((a, p) => a + p.spendUsd, 0);
    const ownOutcomes = own.reduce((a, p) => a + p.outcomes, 0);
    spentUpTo += ownSpend;
    const stepRow = peopleOf.get(leg.toStep);
    const people = stepRow?.people ?? null;
    // Expected cumulative: what the plan spends up to here per one of this milestone.
    if (leg.costPerOutcomeUsd !== null && leg.outcomesNeededPerPayingClient !== null) expectedSpendUpTo += leg.costPerOutcomeUsd * leg.outcomesNeededPerPayingClient;
    else expectedComplete = false;
    const needed = leg.outcomesNeededPerPayingClient;

    const costPerOutcomeUsd =
      // A pipe with outcomes and NO spend of its own is not free: its spend sits under another unit (a sourcing serve run
      // filed under the outreach campaign). Measured only with spend on both sides, else the plan's expected cost.
      // Divided by the SAME people the row counts (and the cost from Start divides), never the pipe's own tally beside them.
      own.length > 0 && ownSpend > 0 && (people ?? ownOutcomes) > 0
        ? measured(ownSpend / (people ?? ownOutcomes))
        : leg.costSource === "customer_team"
          ? { value: 0, basis: "expected" as const, unavailableReason: null }
          : leg.costPerOutcomeUsd !== null
            ? expected(leg.costPerOutcomeUsd)
            : none("no_price_yet");
    const costFromStartUsd =
      people !== null && people > 0 && spentUpTo > 0
        ? measured(spentUpTo / people)
        : expectedComplete && needed !== null && needed > 0
          ? expected(expectedSpendUpTo / needed)
          : none("no_price_yet");
    const conversionFromAbovePct =
      i > 0 && people !== null && previousPeople !== null && previousPeople > 0
        ? measured((people / previousPeople) * 100, 2)
        : leg.ratePct !== null && i > 0
          ? expected(leg.ratePct, 4)
          : none(i === 0 ? "from_start" : "no_rate_yet");
    const attemptsPerTarget = needed !== null && neededAtTarget !== null && neededAtTarget > 0 ? expected(needed / neededAtTarget, 2) : none("no_rate_yet");

    rows.push({
      step: leg.toStep,
      label: stepRow?.label ?? titleOf(leg.toStep),
      isTarget: i === legs.length - 1,
      outcomes: people,
      outcomesUnavailableReason: people === null ? "not_counted_for_this_campaign" : null,
      costPerOutcomeUsd,
      costFromStartUsd,
      conversionFromAbovePct,
      attemptsPerTarget,
    });
    previousPeople = people;
  });
  return rows;
}
