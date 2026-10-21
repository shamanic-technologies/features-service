/**
 * WHICH PROSPECT COUNTRY CONVERTS BEST ON COLD EMAIL? (owner 2026-10-21, RESEARCH-COUNTRY-1021: he tells clients "the US
 * is the market where cold email works best" and wants it measured.) Pure.
 *
 * Every person of the fleet person cell is filed under their OWN country (lead-service's lead country, never the
 * company's), and each workflow version's spend, people and outcomes are shared out on its people (`splitCellsByGroup`),
 * exactly like the model and template studies: a country's bar adds up, over its versions, to the ranking's evidence.
 * A bar reads MATURE once its pooled mature outcomes reach the leg's bar, else everything to date and Learning.
 *
 *  - Per cold email pipe: the rate study (positive reply / website visit per person emailed) and the cost study (cost
 *    per positive reply / per visit).
 *  - Meetings: of the people who replied positively to our cold email, the share who then booked a meeting (lead-service's
 *    attribution: booked after one of their positive replies), on the brands that REPORT meetings only
 *    (`lib/meeting-population.ts`).
 *
 * A country is CROWNED only when it is out of Learning AND rests on at least `MIN_OUTCOMES` outcomes (the verdict's own
 * bar): a country with a handful of sends is drawn, marked Learning, never the winner. The US line compares the United
 * States with every other country pooled, on the same verdict rule.
 */
import { bucketOf, groupCells, type SlugCell } from "./buckets.js";
import { splitCellsByGroup, groupOfSplitSlug, type SlugCellsInput } from "./slug-cells.js";
import { counts, costTitle, drawnSorted, judge, notMeasuredStudy, pricedSorted, rateTitle, strataOf, type BucketFigures, type PipeTerms, type ResearchBucket } from "./studies.js";
import { compareVerdict, MIN_OUTCOMES, type Arm, type Strata, type StratumCounts, type Verdict } from "./verdict.js";
import { n, pctText, usd } from "./format.js";
import type { ResearchChart, ResearchGoal, ResearchPoint, ResearchStudy } from "./types.js";
import type { FleetPersonBucket } from "../fleet-positive-repliers.js";

/** The United States as lead-service spells it, plus the spellings a source may use. */
const US_NAMES = new Set(["united states", "united states of america", "usa", "us", "u.s.", "u.s.a."]);
export const US_LABEL = "United States";
export const isUs = (country: string): boolean => US_NAMES.has(country.trim().toLowerCase());
/** One label per country: every US spelling reads "United States", the rest as the producer spells them. */
export const countryLabel = (country: string): string => (isUs(country) ? US_LABEL : country.trim());

export interface CountryPipeInput {
  terms: PipeTerms;
  legKey: string;
  cells: readonly SlugCell[];
  persons: readonly FleetPersonBucket[];
  split: Pick<SlugCellsInput, "screened" | "signal" | "cutoffDay">;
  /** Orgs left out of the population (our own: distribute.you, staff, test orgs). */
  excludedOrgIds: ReadonlySet<string>;
}

const costOf = (f: BucketFigures): number | null => (f.outcomes > 0 && f.spentUsd > 0 ? f.spentUsd / f.outcomes : null);
const rateOf = (f: BucketFigures): number | null => (f.contacted > 0 ? (100 * f.outcomes) / f.contacted : null);

/** PURE. One bar per country of one pipe, and what the split could not file. */
export function countryBuckets(input: CountryPipeInput): { rows: ResearchBucket[]; leftOut: { contacted: number; outcomes: number }; ourOrgs: { contacted: number } } {
  let ours = 0;
  const groupOf = (b: FleetPersonBucket): string | null => {
    if (input.excludedOrgIds.has(b.orgId)) return null;
    return b.country ? countryLabel(b.country) : null;
  };
  for (const b of input.persons) if (input.excludedOrgIds.has(b.orgId)) ours += input.split.screened ? b.screenedContacted : b.contacted;
  const { cells, leftOut } = splitCellsByGroup(input.cells, input.persons, input.split, groupOf);
  const { groups } = groupCells(cells, groupOfSplitSlug);
  const rows = [...groups].map(([g, cs]) => bucketOf({ key: g, label: g, legKey: input.legKey, cells: cs }));
  return { rows, leftOut: { contacted: Math.max(0, leftOut.contacted - ours), outcomes: leftOut.outcomes }, ourOrgs: { contacted: ours } };
}

/** Out of Learning AND at least MIN_OUTCOMES outcomes: the only bars that may be crowned. */
const crownable = (r: ResearchBucket) => !r.learning && Math.round(r.figures.outcomes) >= MIN_OUTCOMES;

const arm = (label: string, f: BucketFigures): Arm => ({ label, outcomes: f.outcomes, exposure: f.contacted, spend: f.spentUsd });

/** Every country but the US, pooled (figures and strata). */
function restOf(rows: readonly ResearchBucket[]): { figures: BucketFigures; strata: Record<string, StratumCounts> | null } {
  const figures = { spentUsd: 0, contacted: 0, outcomes: 0 };
  let strata: Record<string, StratumCounts> | null = {};
  for (const r of rows) {
    if (r.label === US_LABEL) continue;
    figures.spentUsd += r.figures.spentUsd;
    figures.contacted += r.figures.contacted;
    figures.outcomes += r.figures.outcomes;
    if (!r.strata) strata = null;
    else if (strata) for (const [k, s] of Object.entries(r.strata)) {
      const t = (strata[k] ??= { exposure: 0, outcomes: 0, spend: 0 });
      t.exposure += s.exposure;
      t.outcomes += s.outcomes;
      t.spend += s.spend;
    }
  }
  return { figures, strata };
}

function points(t: PipeTerms, rows: readonly ResearchBucket[], goal: ResearchGoal): ResearchPoint[] {
  const sorted = goal === "rate" ? drawnSorted(rows) : pricedSorted(rows);
  return sorted.map((r) => {
    const v = goal === "rate" ? rateOf(r.figures)! : costOf(r.figures)!;
    const thin = !crownable(r);
    return {
      label: r.label,
      value: Number(v.toFixed(2)),
      display: goal === "rate" ? pctText(v) : usd(v),
      note: `${counts(t, r.figures)}${goal === "roi" ? `, ${usd(r.figures.spentUsd)} spent` : ""}${thin ? (r.learning ? " · Learning" : ` · under ${MIN_OUTCOMES} ${t.nounPlural}`) : ""}`,
      thin,
    };
  });
}

const valueText = (t: PipeTerms, f: BucketFigures, goal: ResearchGoal) =>
  goal === "rate" ? (rateOf(f) === null ? "nobody emailed" : pctText(rateOf(f)!)) : costOf(f) === null ? `no ${t.noun} yet` : `${usd(costOf(f)!)} per ${t.noun}`;

/** "Is the US the best market?" in one line, from the served numbers only. */
function usLine(t: PipeTerms, rows: readonly ResearchBucket[], goal: ResearchGoal, leader: ResearchBucket | undefined): { line: string; verdict: Verdict | null } {
  const us = rows.find((r) => r.label === US_LABEL);
  if (!us || us.figures.contacted <= 0) return { line: `Is the United States the best market? Not measurable: nobody in the United States was emailed on this pipe.`, verdict: null };
  const rest = restOf(rows);
  const usV = goal === "rate" ? rateOf(us.figures) : costOf(us.figures);
  const restV = goal === "rate" ? rateOf(rest.figures) : costOf(rest.figures);
  const status = crownable(us) ? (us.basis === "mature" ? "mature" : "to date") : us.learning ? "Learning" : `under ${MIN_OUTCOMES} ${t.nounPlural}`;
  const usText = `United States: ${valueText(t, us.figures, goal)} (${counts(t, us.figures)}, ${status})`;
  const restText = `every other country together: ${valueText(t, rest.figures, goal)} (${counts(t, rest.figures)})`;
  if (usV === null || restV === null) return { line: `Is the United States the best market? Not measurable yet. ${usText}; ${restText}.`, verdict: null };
  const usBetter = goal === "rate" ? usV > restV : usV < restV;
  const strata: Strata | null = us.strata && rest.strata ? { [US_LABEL]: us.strata, "Every other country": rest.strata } : null;
  const usArm = arm(US_LABEL, us.figures);
  const restArm = arm("Every other country", rest.figures);
  const v = compareVerdict({ a: usBetter ? usArm : restArm, b: usBetter ? restArm : usArm, goal, comparisons: 1, strata, noun: t.noun, nouns: t.nounPlural });
  // "Yes" only on a CONCLUSION that the US beats every other country together; a country with enough outcomes beating
  // it, or the rest beating it on a conclusion, is "No"; anything else is "Not proven" (never a Yes because the US is the
  // only country with enough outcomes to be judged on its own).
  const otherLeader = leader && leader.label !== US_LABEL ? leader : null;
  const best = otherLeader
    ? `No: ${otherLeader.label} beats it (${valueText(t, otherLeader.figures, goal)}, ${counts(t, otherLeader.figures)})`
    : v.kind === "conclusion"
      ? usBetter
        ? "Yes"
        : "No: every other country together does better"
      : `Not proven: the United States is ${usBetter ? "ahead of" : "behind"} every other country together, but the gap is ${v.kind === "signal" ? "a signal to confirm" : "noise so far"}`;
  // One ratio, read the same way whichever side leads: above 1 the US does better on a rate, costs more on a price.
  const how = goal === "rate" ? `${(usV / restV).toFixed(2)}x the ${t.noun} rate of ${restText}` : `a ${t.noun} costs ${(usV / restV).toFixed(2)}x what it costs in ${restText}`;
  return {
    line: `Is the United States the best market? ${best}. ${usText}, ${how}. ${v.reason}`,
    verdict: v,
  };
}

/** The leader against every other country pooled, on the page's verdict rule. */
function leaderVerdict(t: PipeTerms, rows: readonly ResearchBucket[], leader: ResearchBucket, goal: ResearchGoal, comparisons: number): Verdict {
  const others = rows.filter((r) => r !== leader);
  const figures = { spentUsd: 0, contacted: 0, outcomes: 0 };
  let strata: Record<string, StratumCounts> | null = {};
  for (const r of others) {
    figures.spentUsd += r.figures.spentUsd;
    figures.contacted += r.figures.contacted;
    figures.outcomes += r.figures.outcomes;
    if (!r.strata) strata = null;
    else if (strata) for (const [k, x] of Object.entries(r.strata)) {
      const tt = (strata[k] ??= { exposure: 0, outcomes: 0, spend: 0 });
      tt.exposure += x.exposure;
      tt.outcomes += x.outcomes;
      tt.spend += x.spend;
    }
  }
  const OTHERS = "Every other country";
  const both: Strata | null = leader.strata && strata ? { [leader.label]: leader.strata, [OTHERS]: strata } : null;
  return compareVerdict({ a: arm(leader.label, leader.figures), b: others.length ? arm(OTHERS, figures) : null, goal, comparisons, strata: both, noun: t.noun, nouns: t.nounPlural });
}

/** PURE. The two country studies of one cold email pipe (rate, cost). */
export function countryStudies(input: CountryPipeInput): ResearchStudy[] {
  const t = input.terms;
  const { rows, leftOut, ourOrgs } = countryBuckets(input);
  const strata = strataOf(rows);
  const out: ResearchStudy[] = [];
  for (const goal of ["rate", "roi"] as const) {
    const sorted = goal === "rate" ? drawnSorted(rows) : pricedSorted(rows);
    const eligible = sorted.filter(crownable);
    const leader = eligible[0];
    const chart: ResearchChart = {
      kind: "bars",
      title: goal === "rate" ? rateTitle(t) : costTitle(t),
      lowerIsBetter: goal === "roi",
      points: points(t, rows, goal),
      note: `${t.note} The person's own country, as lead-service holds it. Faded = Learning, or under ${MIN_OUTCOMES} ${t.nounPlural} (the verdict's bar): drawn, never crowned.`,
    };
    const us = usLine(t, rows, goal, leader);
    const lines = [
      us.line,
      ...(leader ? [`Best country with enough ${t.nounPlural} to judge: ${leader.label}, ${valueText(t, leader.figures, goal)} (${counts(t, leader.figures)}).`] : []),
      `${n(eligible.length)} of ${n(sorted.length)} countries reach ${MIN_OUTCOMES} ${t.nounPlural} outside Learning; the others are drawn, never crowned.`,
      ...(leftOut.contacted >= 1 ? [`${n(Math.round(leftOut.contacted))} ${t.exposureNoun} whose country is not on record are left out.`] : []),
      ...(ourOrgs.contacted >= 1 ? [`Our own and staff test accounts are left out (${n(Math.round(ourOrgs.contacted))} ${t.exposureNoun}).`] : []),
      "The countries ran for different clients, offers and months: this is not a split test.",
    ];
    const base = {
      id: `${t.pipe}-country-${goal}`,
      pipe: t.pipe,
      topic: "country" as const,
      goal,
      question: goal === "rate" ? `Which prospect country gets the most ${t.nounPlural}?` : `Which prospect country gets the cheapest ${t.noun}?`,
      status: leader ? ("measured" as const) : ("not_enough_data" as const),
      headline: leader ? `${leader.label} wins ${goal === "rate" ? `with a ${valueText(t, leader.figures, goal)} ${t.noun} rate` : `at ${valueText(t, leader.figures, goal)}`}.` : `No country has enough ${t.nounPlural} to judge yet.`,
      winner: leader ? leader.label : null,
      result: leader ? { display: goal === "rate" ? pctText(rateOf(leader.figures)!) : usd(costOf(leader.figures)!), unit: goal === "rate" ? `${t.noun} rate, % of ${t.exposureNoun}` : `per ${t.noun}`, sample: counts(t, leader.figures) } : null,
      crowned: false,
      charts: [chart],
      conclusion: lines,
    };
    // The leader against every other country together (a 14-person runner-up is no comparison), Bonferroni over the
    // countries that could have led.
    const v: Verdict = leader
      ? leaderVerdict(t, rows, leader, goal, Math.max(1, eligible.length))
      : { kind: "noise", reason: `No country reaches ${MIN_OUTCOMES} ${t.nounPlural} outside Learning yet.` };
    out.push(judge(base, v));
  }
  return out;
}

/** One person who replied positively to our cold email: their brand and country. */
export interface CountryReplier {
  orgId: string;
  brandId: string;
  leadId: string;
  country: string | null;
}

export interface CountryMeetingInput {
  /** Every person who replied positively to our cold email (fleet person cell). */
  repliers: readonly CountryReplier[];
  /** Brands that report meetings (`lib/meeting-population.ts`); null = lead-service unreadable this build. */
  reportingBrandIds: ReadonlySet<string> | null;
  /** `${orgId}|${brandId}|${leadId}` of every person lead-service attributes a meeting booked after a positive reply. */
  booked: ReadonlySet<string>;
  excludedOrgIds: ReadonlySet<string>;
}

const people = (k: number) => `${n(k)} ${k === 1 ? "person" : "people"}`;
const meetings = (k: number) => `${n(k)} ${k === 1 ? "meeting" : "meetings"}`;

/** PURE. Of the people who replied positively, the share who booked a meeting, per country. */
export function countryMeetingStudy(input: CountryMeetingInput): ResearchStudy {
  const base = {
    id: "meeting-country-rate",
    pipe: null,
    outcome: "meeting" as const,
    topic: "country" as const,
    goal: "rate" as const,
    question: "Which prospect country books the most meetings after a positive reply?",
  };
  if (!input.reportingBrandIds) return notMeasuredStudy({ ...base, headline: "Not readable right now.", reason: "lead-service's meeting attribution is unavailable right now; the study comes back on the next refresh." });
  const by = new Map<string, { people: number; booked: number }>();
  let unknown = 0;
  for (const r of input.repliers) {
    if (input.excludedOrgIds.has(r.orgId) || !input.reportingBrandIds.has(r.brandId)) continue;
    if (!r.country) {
      unknown += 1;
      continue;
    }
    const label = countryLabel(r.country);
    const t = by.get(label) ?? { people: 0, booked: 0 };
    t.people += 1;
    if (input.booked.has(`${r.orgId}|${r.brandId}|${r.leadId}`)) t.booked += 1;
    by.set(label, t);
  }
  const rows = [...by.entries()]
    .map(([label, x]) => ({ label, ...x, rate: x.people > 0 ? (100 * x.booked) / x.people : 0 }))
    .sort((a, b) => b.rate - a.rate || b.people - a.people || (a.label < b.label ? -1 : 1));
  if (!rows.length) return notMeasuredStudy({ ...base, headline: "No positive reply on a brand that reports meetings yet.", reason: "No person who replied positively on a brand that reports meetings has a country on record." });
  const ok = (r: (typeof rows)[number]) => r.booked >= MIN_OUTCOMES;
  const eligible = rows.filter(ok);
  const leader = eligible[0];
  const pts: ResearchPoint[] = rows.map((r) => ({
    label: r.label,
    value: Number(r.rate.toFixed(2)),
    display: `${r.rate.toFixed(0)}%`,
    note: `${meetings(r.booked)} booked of ${people(r.people)} with a positive reply${ok(r) ? "" : ` · under ${MIN_OUTCOMES} meetings`}`,
    thin: !ok(r),
  }));
  const usRow = rows.find((r) => r.label === US_LABEL);
  const rest = rows.filter((r) => r.label !== US_LABEL).reduce((a, r) => ({ people: a.people + r.people, booked: a.booked + r.booked }), { people: 0, booked: 0 });
  const per = "per person with a positive reply";
  let usText = "Is the United States the best market? Not measurable: no person in the United States replied positively on a brand that reports meetings.";
  if (usRow && rest.people > 0) {
    const restRate = (100 * rest.booked) / rest.people;
    const usBetter = usRow.rate > restRate;
    const a = { label: US_LABEL, outcomes: usRow.booked, exposure: usRow.people, spend: 0 };
    const b = { label: "Every other country", outcomes: rest.booked, exposure: rest.people, spend: 0 };
    const v = compareVerdict({ a: usBetter ? a : b, b: usBetter ? b : a, goal: "rate", comparisons: 1, strata: null, noun: "meeting", nouns: "meetings", per });
    const otherLeader = leader && leader.label !== US_LABEL ? leader : null;
    const answer = otherLeader
      ? `No: ${otherLeader.label} beats it`
      : v.kind === "conclusion"
        ? usBetter
          ? "Yes"
          : "No: every other country together does better"
        : `Not proven: the gap is ${v.kind === "signal" ? "a signal to confirm" : "noise so far"}`;
    usText = `Is the United States the best market? ${answer}. United States ${usRow.rate.toFixed(0)}% (${meetings(usRow.booked)} of ${people(usRow.people)}) against every other country together ${restRate.toFixed(0)}% (${meetings(rest.booked)} of ${people(rest.people)}). ${v.reason}`;
  }
  const study = {
    ...base,
    status: leader ? ("measured" as const) : ("not_enough_data" as const),
    headline: leader ? `${leader.label} wins with ${leader.rate.toFixed(0)}% of positive repliers booking a meeting.` : `No country has ${MIN_OUTCOMES} meetings yet.`,
    winner: leader ? leader.label : null,
    result: leader ? { display: `${leader.rate.toFixed(0)}%`, unit: "of people with a positive reply booked a meeting", sample: `${meetings(leader.booked)} of ${people(leader.people)}` } : null,
    crowned: false,
    charts: [
      {
        kind: "bars" as const,
        title: "Meeting booked, % of people with a positive reply (higher is better)",
        lowerIsBetter: false,
        points: pts,
        note: `Brands that report meetings only. A meeting counts when lead-service attributes it after one of the person's positive replies. Faded = under ${MIN_OUTCOMES} meetings: drawn, never crowned.`,
      },
    ],
    conclusion: [
      usText,
      ...(unknown ? [`${people(unknown)} with a positive reply whose country is not on record are left out.`] : []),
      "Our own and staff test accounts are left out.",
      "Meetings are few: a country's figure here moves with every booking.",
    ],
  };
  const v: Verdict = leader
    ? (() => {
        const others = rows.filter((r) => r !== leader).reduce((x, r) => ({ people: x.people + r.people, booked: x.booked + r.booked }), { people: 0, booked: 0 });
        const b = others.people > 0 ? { label: "Every other country", outcomes: others.booked, exposure: others.people, spend: 0 } : null;
        return compareVerdict({ a: { label: leader.label, outcomes: leader.booked, exposure: leader.people, spend: 0 }, b, goal: "rate", comparisons: Math.max(1, eligible.length), strata: null, noun: "meeting", nouns: "meetings", per });
      })()
    : { kind: "noise", reason: `No country has ${MIN_OUTCOMES} meetings booked after a positive reply yet.` };
  return judge(study, v);
}
