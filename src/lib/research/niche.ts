/**
 * DO CLIENTS WITH A VERY SPECIFIC B2B NICHE CONVERT BETTER ON COLD EMAIL? (RESEARCH-NICHE-1021). Pure.
 *
 * Every person of the fleet person cell is filed under the niche grade of the client (brand x offer) whose campaign
 * emailed them (`lib/research/niche-grades.ts`: Jev's stored verdict), and each workflow version's spend, people and
 * outcomes are shared out on its people (`splitCellsByGroup`), exactly like the LLM and template studies: a grade's bar
 * adds up to the ranking's evidence, read MATURE once its mature outcomes reach the leg's bar, else everything to date
 * and Learning. Two pipes (positive reply rate, website visit = click rate), plus the meeting rate over the brands that
 * report their meetings (MEETING-POPULATION-1018), each with its cost per outcome.
 *
 * A client holds ONE grade, so two grades never ran for the same client in the same month: the verdict can reach a
 * signal, never a conclusion (the gap may be the clients'). Each grade also states its CLIENT median, so one big client
 * cannot carry a grade alone unseen.
 */
import { bucketOf, groupCells, type SlugCell } from "./buckets.js";
import { groupOfSplitSlug, splitCellsByGroup, type SlugCellsInput } from "./slug-cells.js";
import { counts, dimensionStudies, notMeasuredStudy, type PipeTerms, type ResearchBucket } from "./studies.js";
import { n, pctText, usd } from "./format.js";
import type { ReportingBrand } from "./meetings.js";
import type { ResearchStudy } from "./types.js";
import type { FleetPersonBucket } from "../fleet-positive-repliers.js";
import { NICHE_CRITERIA, NICHE_GRADES, NICHE_LABEL, type GradedClient, type NicheGrade, type NicheGradesRead } from "./niche-grades.js";

export interface NichePipeInput {
  terms: PipeTerms;
  legKey: string;
  cells: readonly SlugCell[];
  persons: readonly FleetPersonBucket[];
  split: Pick<SlugCellsInput, "screened" | "signal" | "cutoffDay">;
}

export interface NicheInput {
  reply: NichePipeInput;
  visit: NichePipeInput;
  /** Null = the grades could not be read this build (every study says so). */
  grades: NicheGradesRead | null;
  /** The brands reporting meetings (null = unreadable, undefined = not asked: the actual-cost basis). */
  meetings?: { brands: ReportingBrand[] | null; outcomesRequired: number; note: string };
}

const QUESTION_RATE = (nouns: string) => `Do clients with a very specific B2B niche get more ${nouns}?`;
const QUESTION_ROI = (noun: string) => `Do clients with a very specific B2B niche pay less per ${noun}?`;
const labelOfGrade = (g: string) => NICHE_LABEL[g as NicheGrade] ?? g;
const rateOf = (f: { contacted: number; outcomes: number }) => (f.contacted > 0 ? (100 * f.outcomes) / f.contacted : null);
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** PURE. The lines every niche study carries: how a client is graded, who is left out, why it cannot be a conclusion. */
function methodLines(grades: NicheGradesRead): string[] {
  const out = [
    `Each client (brand and offer) is graded once by Jev on who it targets: what it sells and the target text of the audiences built for it. ${NICHE_GRADES.map((g) => `${NICHE_LABEL[g]}: ${NICHE_CRITERIA[g]}`).join(" ")}`,
    "A client holds one grade, so two grades never ran for the same client in the same month: a gap can be the clients' (their offer, price, market), not the niche alone.",
  ];
  if (grades.excludedOurs) out.push(`${n(grades.excludedOurs)} of our own ${grades.excludedOurs === 1 ? "account is" : "accounts are"} left out (staff test orgs, our own brand).`);
  if (grades.unjudged.count) out.push(`${n(grades.unjudged.count)} ${grades.unjudged.count === 1 ? "client is" : "clients are"} not graded yet and left out of this build.`);
  return out;
}

/**
 * PURE. "Narrow niche (3): Aireena, Doc Dinners, Legistai." per grade: the clients who emailed somebody on THIS pipe (the
 * count the grade line states). One brand run by several accounts is named once, with how many.
 */
function clientLines(clients: readonly GradedClient[], onPipe: ReadonlySet<string>): string[] {
  return NICHE_GRADES.flatMap((g) => {
    const of = clients.filter((c) => c.grade === g && onPipe.has(c.key));
    const byLabel = new Map<string, number>();
    for (const c of of) byLabel.set(c.label, (byLabel.get(c.label) ?? 0) + 1);
    const names = [...byLabel].sort(([a], [b]) => a.localeCompare(b)).map(([l, k]) => (k > 1 ? `${l} (${k} accounts)` : l));
    return names.length ? [`${NICHE_LABEL[g]} (${n(of.length)}): ${names.join(", ")}.`] : [];
  });
}

/** PURE. Each client's own figures (everything to date) on one pipe, to state each grade's client median. */
function clientRates(input: NichePipeInput, byCampaign: ReadonlyMap<string, GradedClient>) {
  const by = new Map<string, { grade: NicheGrade; contacted: number; outcomes: number }>();
  for (const b of input.persons) {
    const c = byCampaign.get(b.campaignId);
    if (!c) continue;
    const x = by.get(c.key) ?? { grade: c.grade, contacted: 0, outcomes: 0 };
    x.contacted += input.split.screened ? b.screenedContacted : b.contacted;
    x.outcomes += input.split.signal === "positiveReply" ? b.positiveReplies : input.split.signal === "clicked" ? (input.split.screened ? b.humanClicked : b.clicked) : 0;
    by.set(c.key, x);
  }
  return by;
}

/** PURE. The answer line: narrow against the broadest grade that emailed somebody (broad, else focused), in words. */
function answerLine(t: PipeTerms, rows: readonly ResearchBucket[], what: "rate" | "cost"): string | null {
  const get = (g: NicheGrade) => rows.find((r) => r.key === g && r.figures.contacted > 0);
  const narrow = get("narrow");
  const broad = get("broad") ?? get("focused");
  if (!narrow || !broad) return null;
  if (what === "rate") {
    const a = rateOf(narrow.figures)!;
    const b = rateOf(broad.figures)!;
    const other = broad.key === "broad" ? get("focused") : undefined;
    const also = other ? ` (${other.label.toLowerCase()}: ${pctText(rateOf(other.figures)!)})` : "";
    if (b === 0) return `${NICHE_LABEL.narrow} clients get ${pctText(a)} ${t.nounPlural} per ${t.exposureNounOne}; ${broad.label.toLowerCase()} ones got none yet${also}.`;
    const x = a / b;
    return `${NICHE_LABEL.narrow} clients get ${pctText(a)} ${t.nounPlural} per ${t.exposureNounOne} against ${pctText(b)} for ${broad.label.toLowerCase()} ones${also}: ${x.toFixed(2)}x, so a narrower niche ${x > 1 ? "converted better" : "did not convert better"} here.`;
  }
  const ca = narrow.figures.outcomes > 0 && narrow.figures.spentUsd > 0 ? narrow.figures.spentUsd / narrow.figures.outcomes : null;
  const cb = broad.figures.outcomes > 0 && broad.figures.spentUsd > 0 ? broad.figures.spentUsd / broad.figures.outcomes : null;
  if (ca === null || cb === null) return null;
  return `A ${t.noun} costs ${usd(ca)} from ${NICHE_LABEL.narrow.toLowerCase()} clients against ${usd(cb)} from ${broad.label.toLowerCase()} ones (${(ca / cb).toFixed(2)}x).`;
}

/** PURE. Each grade's line: its rate, sample, maturity and client median. */
function gradeLines(t: PipeTerms, rows: readonly ResearchBucket[], perClient: Map<string, { grade: NicheGrade; contacted: number; outcomes: number }>): string[] {
  return NICHE_GRADES.flatMap((g) => {
    const r = rows.find((x) => x.key === g);
    if (!r || r.figures.contacted <= 0) return [];
    const clients = [...perClient.values()].filter((c) => c.grade === g && c.contacted > 0);
    const med = median(clients.map((c) => (100 * c.outcomes) / c.contacted));
    return [
      `${r.label}: ${pctText(rateOf(r.figures)!)} (${counts(t, r.figures)}), ${r.learning ? "Learning" : "mature"}; ${n(clients.length)} ${clients.length === 1 ? "client" : "clients"}${med === null ? "" : `, client median ${pctText(med)}`}.`,
    ];
  });
}

function pipeStudies(input: NichePipeInput, grades: NicheGradesRead): ResearchStudy[] {
  const t = input.terms;
  const { cells, leftOut } = splitCellsByGroup(input.cells, input.persons, input.split, (b) => grades.byCampaign.get(b.campaignId)?.grade ?? null);
  const { groups } = groupCells(cells, groupOfSplitSlug);
  const rows: ResearchBucket[] = [...groups].map(([g, cs]) => bucketOf({ key: g, label: labelOfGrade(g), legKey: input.legKey, cells: cs }));
  const perClient = clientRates(input, grades.byCampaign);
  const onPipe = new Set([...perClient].filter(([, c]) => c.contacted > 0).map(([k]) => k));
  const lines = [...methodLines(grades), ...clientLines(grades.clients, onPipe)];
  if (leftOut.contacted >= 1) lines.push(`${n(Math.round(leftOut.contacted))} ${t.exposureNoun} by ungraded clients (ours, or not graded yet) are left out.`);
  const [roi, rate] = dimensionStudies(t, rows, { topic: "niche", dimNoun: "niche grade", keyed: false, extraLines: lines });
  const grade = gradeLines(t, rows, perClient);
  const rateAnswer = answerLine(t, rows, "rate");
  const costAnswer = answerLine(t, rows, "cost");
  return [
    { ...roi!, question: QUESTION_ROI(t.noun), conclusion: [...(costAnswer ? [costAnswer] : []), ...roi!.conclusion] },
    { ...rate!, question: QUESTION_RATE(t.nounPlural), conclusion: [...(rateAnswer ? [rateAnswer] : []), ...grade, ...rate!.conclusion] },
  ];
}

/** PURE. The meeting rate per grade, over the brands that report their meetings (a brand whose offers differ in grade is left out). */
function meetingStudies(input: NicheInput, grades: NicheGradesRead): ResearchStudy[] {
  const m = input.meetings!;
  const ids = { rate: "meeting-niche-rate", roi: "meeting-niche-roi" };
  const base = { pipe: null, outcome: "meeting" as const, topic: "niche" as const };
  if (!m.brands) {
    return [
      notMeasuredStudy({ ...base, id: ids.rate, goal: "rate", question: QUESTION_RATE("meetings"), headline: "Not readable right now.", reason: "lead-service's meeting attribution could not be read this build; the study comes back on the next refresh." }),
      notMeasuredStudy({ ...base, id: ids.roi, goal: "roi", question: QUESTION_ROI("meeting"), headline: "Not readable right now.", reason: "lead-service's meeting attribution could not be read this build; the study comes back on the next refresh." }),
    ];
  }
  const gradeOfBrand = new Map<string, Set<NicheGrade>>();
  for (const c of grades.clients) gradeOfBrand.set(c.brandId, (gradeOfBrand.get(c.brandId) ?? new Set()).add(c.grade));
  const emailed = new Map<string, number>();
  for (const p of [input.reply, input.visit]) {
    for (const b of p.persons) {
      const c = grades.byCampaign.get(b.campaignId);
      if (c) emailed.set(c.brandId, (emailed.get(c.brandId) ?? 0) + b.contacted);
    }
  }
  const acc = new Map<NicheGrade, { spentUsd: number; contacted: number; outcomes: number; brands: number }>();
  let mixed = 0;
  for (const b of m.brands) {
    const gs = gradeOfBrand.get(b.brandId);
    if (!gs) continue;
    if (gs.size > 1) {
      mixed += 1;
      continue;
    }
    const g = [...gs][0]!;
    const x = acc.get(g) ?? { spentUsd: 0, contacted: 0, outcomes: 0, brands: 0 };
    x.spentUsd += Object.values(b.spendByMonth).reduce((a, v) => a + v, 0);
    x.outcomes += Object.values(b.meetingsByMonth).reduce((a, v) => a + v, 0);
    x.contacted += emailed.get(b.brandId) ?? 0;
    x.brands += 1;
    acc.set(g, x);
  }
  const rows: ResearchBucket[] = [...acc].map(([g, x]) => ({
    key: g,
    label: NICHE_LABEL[g],
    basis: "flash",
    figures: { spentUsd: x.spentUsd, contacted: x.contacted, outcomes: x.outcomes },
    learning: x.outcomes < m.outcomesRequired,
    months: null,
    strata: null,
  }));
  const t: PipeTerms = {
    pipe: "cold-email-positive-reply",
    noun: "meeting",
    nounPlural: "meetings",
    exposureNoun: "people emailed",
    exposureNounOne: "person emailed",
    outcomesRequired: m.outcomesRequired,
    partialMonth: null,
    note: m.note,
  };
  const lines = [
    "Counted over the clients that report their booked meetings (a client that never reported one is left out, never read as zero). A meeting counts when booked after one of the person's positive replies to our outreach; the cost is what the client was charged on cold email and meeting booking.",
    ...methodLines(grades),
    ...(mixed ? [`${n(mixed)} ${mixed === 1 ? "client sells" : "clients sell"} offers of different grades and ${mixed === 1 ? "is" : "are"} left out (meetings are not split by offer).`] : []),
    ...[...acc].map(([g, x]) => `${NICHE_LABEL[g]}: ${n(x.brands)} ${x.brands === 1 ? "client" : "clients"} reporting meetings.`),
  ];
  const [roi, rate] = dimensionStudies(t, rows, { topic: "niche", dimNoun: "niche grade", keyed: false, extraLines: lines });
  const rateAnswer = answerLine(t, rows, "rate");
  const costAnswer = answerLine(t, rows, "cost");
  return [
    { ...roi!, ...base, id: ids.roi, question: QUESTION_ROI("meeting"), conclusion: [...(costAnswer ? [costAnswer] : []), ...roi!.conclusion] },
    { ...rate!, ...base, id: ids.rate, question: QUESTION_RATE("meetings"), conclusion: [...(rateAnswer ? [rateAnswer] : []), ...rate!.conclusion] },
  ];
}

/** PURE. Every niche study: per cold email pipe (rate + cost), and the meeting rate when the meeting reporters are read. */
export function nicheStudies(input: NicheInput): ResearchStudy[] {
  if (!input.grades) {
    return [input.reply, input.visit].flatMap((p) =>
      (["rate", "roi"] as const).map((goal) =>
        notMeasuredStudy({
          id: `${p.terms.pipe}-niche-${goal}`,
          pipe: p.terms.pipe,
          topic: "niche",
          goal,
          question: goal === "rate" ? QUESTION_RATE(p.terms.nounPlural) : QUESTION_ROI(p.terms.noun),
          headline: "Not readable right now.",
          reason: "The clients' niche grades could not be read this build; the study comes back on the next refresh.",
        }),
      ),
    );
  }
  return [...pipeStudies(input.reply, input.grades), ...pipeStudies(input.visit, input.grades), ...(input.meetings ? meetingStudies(input, input.grades) : [])];
}
