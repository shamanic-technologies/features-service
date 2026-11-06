/**
 * FACTORY-USER-DASHBOARD-1102 (owner 2026-11-02, the customer campaign page, GTM Factory "Milestones"): one row per
 * step of a funnel campaign's OWN funnel, from Start to its Target (never the plan line: OUTCOME-RUNG-AND-TARGET-1106). PURE;
 * IO in `routes/campaign-milestones.ts`.
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

/**
 * PURE: the milestones table of one funnel campaign. ROWS are the steps of the campaign's OWN funnel (the one it was born
 * on: fixed for its life) up to its Target, never the plan line (OUTCOME-RUNG-AND-TARGET-1106: the Plan changes from one
 * tick to the next, and rows built on it dropped the past outcomes of a path it left). The plan line only lends each row
 * its EXPECTED figures, by step; a row the current plan does not walk reads them null `not_on_current_plan`.
 */
export function milestonesOf(input: {
  /** The campaign's funnel steps in path order (Lead found first; never Start), each with its people since inception. */
  steps: readonly MilestoneStepPeople[];
  /** The campaign's Target; null = every step of its funnel. A Target off its funnel is appended as the last row. */
  target: string | null;
  /** The current plan line up to the Target, in order; [] with no plan. */
  planLegs: readonly MilestoneLegFigures[];
  /** Why there is no plan line (`plan_not_computed_yet`), null with one. */
  planUnavailableReason: string | null;
  pipes: readonly MilestonePipeSpend[];
}): MilestoneRow[] {
  const { steps, target, planLegs, pipes } = input;
  const upTo = target === null ? steps.length : steps.findIndex((s) => s.key === target) + 1;
  const rowSteps: MilestoneStepPeople[] = upTo > 0 ? steps.slice(0, upTo) : [...steps, { key: target!, label: titleOf(target!), people: null }];

  // Expected, by step, off the plan line: its leg into the step, and the plan's spend from Start up to it per one of it.
  const legOf = new Map(planLegs.map((l) => [l.toStep, l]));
  const expectedSpendUpTo = new Map<string, number | null>();
  let acc: number | null = 0;
  for (const l of planLegs) {
    acc = acc !== null && l.costPerOutcomeUsd !== null && l.outcomesNeededPerPayingClient !== null ? acc + l.costPerOutcomeUsd * l.outcomesNeededPerPayingClient : null;
    expectedSpendUpTo.set(l.toStep, acc);
  }
  const targetKey = rowSteps[rowSteps.length - 1]?.key ?? null;
  const neededAtTarget = (targetKey !== null ? legOf.get(targetKey)?.outcomesNeededPerPayingClient : null) ?? null;
  const offPlan = input.planUnavailableReason ?? "not_on_current_plan";

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
  let previousPeople: number | null = null;
  rowSteps.forEach((step, i) => {
    const own = pipes.filter((p) => p.toStep === step.key);
    const ownSpend = own.reduce((a, p) => a + p.spendUsd, 0);
    const ownOutcomes = own.reduce((a, p) => a + p.outcomes, 0);
    spentUpTo += ownSpend;
    const people = step.people;
    const leg = legOf.get(step.key) ?? null;
    const needed = leg?.outcomesNeededPerPayingClient ?? null;
    const expectedUpTo = expectedSpendUpTo.get(step.key) ?? null;

    const costPerOutcomeUsd =
      // A pipe with outcomes and NO spend of its own is not free: its spend sits under another unit (a sourcing serve run
      // filed under the outreach campaign). Measured only with spend on both sides, else the plan's expected cost.
      // Divided by the SAME people the row counts (and the cost from Start divides), never the pipe's own tally beside them.
      own.length > 0 && ownSpend > 0 && (people ?? ownOutcomes) > 0
        ? measured(ownSpend / (people ?? ownOutcomes))
        : leg === null
          ? none(offPlan)
          : leg.costSource === "customer_team"
            ? { value: 0, basis: "expected" as const, unavailableReason: null }
            : leg.costPerOutcomeUsd !== null
              ? expected(leg.costPerOutcomeUsd)
              : none("no_price_yet");
    const costFromStartUsd =
      people !== null && people > 0 && spentUpTo > 0
        ? measured(spentUpTo / people)
        : leg === null
          ? none(offPlan)
          : expectedUpTo !== null && needed !== null && needed > 0
            ? expected(expectedUpTo / needed)
            : none("no_price_yet");
    const conversionFromAbovePct =
      i > 0 && people !== null && previousPeople !== null && previousPeople > 0
        ? measured((people / previousPeople) * 100, 2)
        : i === 0
          ? none("from_start")
          : leg?.ratePct != null
            ? expected(leg.ratePct, 4)
            : none(leg === null ? offPlan : "no_rate_yet");
    const attemptsPerTarget = needed !== null && neededAtTarget !== null && neededAtTarget > 0 ? expected(needed / neededAtTarget, 2) : none(leg === null ? offPlan : "no_rate_yet");

    rows.push({
      step: step.key,
      label: step.label,
      isTarget: i === rowSteps.length - 1 && (target === null || step.key === target),
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
