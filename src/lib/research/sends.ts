/**
 * THE STUDIES READ ON EACH EMAIL SENT (LIVE-RESEARCH-1018): follow-ups, day of the week, hour of the day, open tracking.
 * Pure. Input = features-service's copy of instantly-service's outreach facts (`lib/outreach-facts-copy.ts`) grouped by
 * `routes/research.ts`, and the leg's spend split in two by runs-service's cost names.
 *
 * Doctrine carried over from the nightly snapshot (research.mjs):
 *  - The population is the leg's MATURE cohort: sequences whose first email went out before the leg's cutoff, with every
 *    outcome they earned since. A bar short of the leg's bar reads Learning.
 *  - An outcome is credited to the LAST email sent before it on the same thread (a human click to the email it was on).
 *  - ROI is MARGINAL: what a person costs (the lead, writing the whole sequence, the upload) lands on the first email;
 *    the per-email sending charges land on each email sent. A follow-up costs only its own sending.
 *  - Timing is read in the PROSPECT's timezone (instantly-service's local send time); a send with no known zone is left out.
 *  - A website visit is a human-judged click on an email we sent ourselves: on that leg only those sends count.
 * What differs from the snapshot: positive replies are the ones the reply classifier (or a person) stated on the thread;
 * the ones a client recorded in their CRM are counted by the person-based studies, not here (they name no email).
 */
import { MONTHS, n, pctText, usd } from "./format.js";
import { compareVerdict, headlineFor, MIN_OUTCOMES, rateP, pTextShort, type Strata, type StratumCounts, type Verdict } from "./verdict.js";
import { costBars, costTitle, counts, notMeasuredStudy, rateBars, rateTitle, type PipeTerms, type ResearchBucket } from "./studies.js";
import type { ResearchStudy } from "./types.js";

/** Emails of one leg, grouped. */
export interface SendGroup {
  orgId: string;
  /** `YYYY-MM` of the send. */
  month: string;
  /** 1 = the first email. */
  step: number;
  /** In the prospect's timezone; null when the zone is unknown. */
  weekday: string | null;
  hour: number | null;
  /** Sent through our own sender (a click on it is screened). */
  screenable: boolean;
  emails: number;
  /** Outcomes credited to these emails. */
  replies: number;
  clicks: number;
}

/** The leg's mature spend, split by what it buys. */
export interface LegSpendSplit {
  perEmailUsd: number;
  perPersonUsd: number;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const monthLabel = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym;

export interface SendsPipe {
  terms: PipeTerms;
  /** The leg's outcome is the click: only our own sender's emails count, clicks are the outcome. */
  visit: boolean;
  groups: SendGroup[];
  spend: LegSpendSplit;
}

interface Scoped {
  rows: SendGroup[];
  /** Spend per email sent and per person reached, scaled to the counted emails. */
  perEmail: number;
  perPerson: number;
  outcomesOf: (g: SendGroup) => number;
}

function scope(p: SendsPipe): Scoped {
  const all = p.groups;
  const rows = p.visit ? all.filter((g) => g.screenable) : all;
  // The per-email charges are the PROVIDER's (its mailbox and domain per email sent): they land on the emails the
  // provider sent; an email from our own sender adds no per-email charge (the snapshot: "sending is not charged per email").
  const providerEmails = all.filter((g) => !g.screenable).reduce((a, g) => a + g.emails, 0);
  const firstAll = all.filter((g) => g.step === 1).reduce((a, g) => a + g.emails, 0);
  return {
    rows,
    perEmail: providerEmails ? p.spend.perEmailUsd / providerEmails : 0,
    perPerson: firstAll ? p.spend.perPersonUsd / firstAll : 0,
    outcomesOf: (g) => (p.visit ? g.clicks : g.replies),
  };
}

const spendOf = (s: Scoped, g: SendGroup) => (g.screenable ? 0 : g.emails * s.perEmail) + (g.step === 1 ? g.emails * s.perPerson : 0);
const stepLabel = (step: number) => (step === 1 ? "First email" : `Follow-up ${step - 1}`);
const emailsNoun = (t: PipeTerms) => (t.pipe === "cold-email-website-visit" ? "emails from our sender" : "emails");
const sendCounts = (t: PipeTerms, outcomes: number, emails: number) =>
  `${n(Math.round(outcomes))} ${Math.round(outcomes) === 1 ? t.noun : t.nounPlural} · ${n(emails)} ${emailsNoun(t)}`;

/** PURE. The follow-up ROI and rate studies of one pipe. */
export function followupStudies(p: SendsPipe): ResearchStudy[] {
  const t = p.terms;
  const s = scope(p);
  const bySteps = new Map<number, { emails: number; outcomes: number; spend: number }>();
  for (const g of s.rows) {
    const x = bySteps.get(g.step) ?? { emails: 0, outcomes: 0, spend: 0 };
    x.emails += g.emails;
    x.outcomes += s.outcomesOf(g);
    x.spend += spendOf(s, g);
    bySteps.set(g.step, x);
  }
  const steps = [...bySteps.entries()].sort((a, b) => a[0] - b[0]).map(([step, x]) => ({ step, bucket: stepLabel(step), ...x }));
  const first = steps.find((x) => x.step === 1);
  const people = first?.emails ?? 0;
  const out: ResearchStudy[] = [];
  const qRoi = `How many follow-ups are worth their cost, for ${t.nounPlural}?`;
  const qRate = `How many follow-ups get the most ${t.nounPlural}?`;
  if (!first || people === 0) {
    out.push(notMeasuredStudy({ id: `${t.pipe}-followups-roi`, pipe: t.pipe, topic: "followups", goal: "roi", question: qRoi, headline: "No sequences yet.", reason: "No sequence of this pipe is old enough to count yet." }));
    out.push(notMeasuredStudy({ id: `${t.pipe}-followups-rate`, pipe: t.pipe, topic: "followups", goal: "rate", question: qRate, headline: "No sequences yet.", reason: "No sequence of this pipe is old enough to count yet." }));
    return out;
  }
  let spend = 0;
  let got = 0;
  const depth = steps.map((x, i) => {
    spend += x.spend;
    got += x.outcomes;
    return { label: i === 0 ? "First email only" : `+ ${i} follow-up${i > 1 ? "s" : ""}`, spend, got };
  });
  const roiPts = depth
    .filter((d) => d.got > 0 && d.spend > 0)
    .map((d) => ({ label: d.label, value: Number((d.spend / d.got).toFixed(2)), display: usd(d.spend / d.got), note: `${n(d.got)} ${d.got === 1 ? t.noun : t.nounPlural} · ${usd(d.spend)} spent`, thin: d.got < t.outcomesRequired }));
  const ratePts = depth.map((d) => ({
    label: d.label,
    value: Number(((100 * d.got) / people).toFixed(2)),
    display: pctText((100 * d.got) / people),
    note: `${n(d.got)} ${d.got === 1 ? t.noun : t.nounPlural} from ${n(people)} people`,
    thin: d.got < t.outcomesRequired,
  }));
  const stepRows: ResearchBucket[] = steps.map((x) => ({
    key: String(x.step),
    label: x.bucket,
    basis: "mature",
    figures: { spentUsd: x.spend, contacted: x.emails, outcomes: x.outcomes },
    learning: x.outcomes < t.outcomesRequired,
    months: null,
    strata: null,
  }));
  const stepTerms: PipeTerms = { ...t, exposureNoun: emailsNoun(t), exposureNounOne: emailsNoun(t).replace(/^emails/, "email") };
  const stepCost = costBars(stepTerms, stepRows, { ordinal: true });
  const gains = ratePts.slice(1).map((pt, i) => ({ label: pt.label, gain: pt.value - ratePts[i]!.value }));
  const lastUseful = [...gains].reverse().find((g) => g.gain > 0);
  const firstCpo = first.outcomes > 0 && first.spend > 0 ? first.spend / first.outcomes : null;
  const marginal = steps.slice(1).map((st) => ({ bucket: st.bucket, spend: st.spend, got: st.outcomes, cpo: st.outcomes > 0 ? st.spend / st.outcomes : null }));
  const worth = marginal.filter((m) => m.got > 0 && (firstCpo === null || (m.cpo ?? Infinity) <= firstCpo));
  const deepest = worth.length ? worth[worth.length - 1]! : null;
  const extra = (m: (typeof marginal)[number]) => (m.spend > 0 ? `${usd(m.cpo!)} per extra ${t.noun}` : `no extra cost (sending is not charged per email)`);
  // ROI verdict: the first email against the follow-ups the study says to send, on the SAME people
  const upTo = deepest ? steps.findIndex((st) => st.bucket === deepest.bucket) : steps.length - 1;
  const sent = steps.slice(1, upTo + 1).reduce((a, st) => ({ emails: a.emails + st.emails, spend: a.spend + st.spend, out: a.out + st.outcomes }), { emails: 0, spend: 0, out: 0 });
  let roiVerdict: Verdict;
  if (sent.spend === 0) {
    roiVerdict = sent.out < MIN_OUTCOMES
      ? { kind: "noise", reason: `Follow-ups cost nothing extra but brought ${n(sent.out)} ${sent.out === 1 ? t.noun : t.nounPlural} in all: too few to say they add any.` }
      : { kind: "conclusion", reason: `Follow-ups cost nothing extra and brought ${n(sent.out)} ${t.nounPlural} on the same people the first email reached.` };
  } else {
    const f = { label: "The first email", outcomes: first.outcomes, exposure: first.emails, spend: first.spend };
    const u = { label: "the follow-ups", outcomes: sent.out, exposure: sent.emails, spend: sent.spend };
    const firstCheaper = (f.outcomes / f.spend || 0) >= (u.outcomes / u.spend || 0);
    const [a, b] = firstCheaper ? [f, u] : [{ ...u, label: "The follow-ups" }, { ...f, label: "the first email" }];
    roiVerdict = compareVerdict({ a, b, goal: "roi", comparisons: 1, strata: null, splitTest: true, noun: t.noun, nouns: t.nounPlural });
  }
  const roiHeadline = deepest
    ? `Send through ${deepest.bucket.toLowerCase()}: it adds ${t.nounPlural} at ${extra(deepest)}${firstCpo !== null ? `, against ${usd(firstCpo)} on a first email` : ""}.`
    : `Stop after the first email: no follow-up adds a ${t.noun} for less than the ${firstCpo !== null ? usd(firstCpo) : "price"} a first email pays.`;
  out.push({
    id: `${t.pipe}-followups-roi`,
    pipe: t.pipe,
    topic: "followups",
    goal: "roi",
    question: qRoi,
    status: "measured",
    headline: headlineFor(roiHeadline, roiVerdict.kind),
    winner: deepest ? deepest.bucket : firstCpo !== null ? "First email" : null,
    result: deepest
      ? { display: deepest.spend > 0 ? usd(deepest.cpo!) : usd(0), unit: `per extra ${t.noun}, ${deepest.bucket.toLowerCase()}`, sample: `${n(deepest.got)} ${deepest.got === 1 ? t.noun : t.nounPlural} · ${usd(deepest.spend)} extra spent` }
      : firstCpo !== null
        ? { display: usd(firstCpo), unit: `per ${t.noun}, first email`, sample: `${n(first.outcomes)} ${t.nounPlural} · ${usd(first.spend)} spent` }
        : null,
    crowned: roiVerdict.kind === "conclusion",
    verdict: { kind: roiVerdict.kind, reason: roiVerdict.reason },
    charts: [
      { kind: "bars", title: `What each email adds: cost per extra ${t.noun} (USD, lower is better)`, lowerIsBetter: true, points: stepCost, note: t.note },
      { kind: "bars", title: `Cost per ${t.noun} if the sequence stopped here (USD, lower is better)`, lowerIsBetter: true, points: roiPts, note: t.note },
    ],
    conclusion: [
      `A first email carries everything bought once per person: the lead, writing the whole sequence, the upload. A follow-up adds only its own sending, so its bar is the extra cost of the extra ${t.nounPlural} it brought.`,
      `A follow-up is worth sending while its extra ${t.noun} costs no more than one bought with a first email to a new person.`,
      `Each ${t.noun} is credited to the last email sent before it on the same thread. The ${t.nounPlural} a client recorded in their CRM name no email and are left out of this study.`,
    ],
  });
  const rest = steps.filter((st) => st.step !== 1).reduce((a, st) => a + st.outcomes, 0);
  const lastStep = [...steps].reverse().find((st) => st.step !== 1 && st.outcomes > 0);
  const lastN = lastStep?.outcomes ?? 0;
  const rateVerdict: Verdict =
    rest < MIN_OUTCOMES
      ? { kind: "noise", reason: `Follow-ups brought ${n(rest)} ${rest === 1 ? t.noun : t.nounPlural} in all: too few to say they add any.` }
      : lastN >= MIN_OUTCOMES
        ? { kind: "conclusion", reason: `Follow-ups brought ${n(rest)} of ${n(rest + first.outcomes)} ${t.nounPlural}, on the same people the first email reached, and the last useful one (${lastStep!.bucket.toLowerCase()}) brought ${n(lastN)} on its own.` }
        : { kind: "signal", reason: `Follow-ups brought ${n(rest)} of ${n(rest + first.outcomes)} ${t.nounPlural}, so they add some; but the last useful one (${lastStep!.bucket.toLowerCase()}) brought only ${n(lastN)}, too few to say how far to go.` };
  const rateHeadline = lastUseful
    ? `${t.nounPlural.charAt(0).toUpperCase()}${t.nounPlural.slice(1)} keep coming through ${lastUseful.label.replace("+ ", "")}: the last one adds ${lastUseful.gain.toFixed(2)} points.`
    : `Follow-ups add no ${t.nounPlural} past the first email.`;
  out.push({
    id: `${t.pipe}-followups-rate`,
    pipe: t.pipe,
    topic: "followups",
    goal: "rate",
    question: qRate,
    status: "measured",
    headline: headlineFor(rateHeadline, rateVerdict.kind),
    winner: lastUseful ? lastUseful.label : ratePts[0]?.label ?? null,
    result: { display: ratePts[ratePts.length - 1]!.display, unit: `of people got a ${t.noun}, all follow-ups`, sample: ratePts[ratePts.length - 1]!.note },
    crowned: rateVerdict.kind === "conclusion",
    verdict: { kind: rateVerdict.kind, reason: rateVerdict.reason },
    charts: [
      { kind: "bars", title: `${t.noun.charAt(0).toUpperCase()}${t.noun.slice(1)} rate, % of people, adding each follow-up (higher is better)`, lowerIsBetter: false, points: ratePts, note: t.note },
    ],
    conclusion: [
      `Counted per person reached, so a follow-up is judged on what it adds, not on how many emails it took.`,
      ...gains.map((g) => `${g.label}: ${g.gain >= 0 ? "+" : ""}${g.gain.toFixed(2)} points.`),
    ],
  });
  return out;
}

/** PURE. The day-of-week or hour-of-day study of one pipe; null when it has too little to rank (a leg all Learning). */
export function timingStudy(p: SendsPipe, dim: "weekday" | "hour"): ResearchStudy | null {
  const t = p.terms;
  const s = scope(p);
  const keyOf = (g: SendGroup): string | null => (dim === "weekday" ? g.weekday : g.hour === null ? null : String(g.hour));
  const label = (k: string) => (dim === "weekday" ? k : `${k.padStart(2, "0")}:00`);
  const noLocal = s.rows.filter((g) => keyOf(g) === null).reduce((a, g) => a + g.emails, 0);
  const by = new Map<string, { emails: number; outcomes: number; spend: number; strata: Record<string, StratumCounts> }>();
  for (const g of s.rows) {
    const k = keyOf(g);
    if (k === null) continue;
    const x = by.get(k) ?? { emails: 0, outcomes: 0, spend: 0, strata: {} };
    const sp = spendOf(s, g);
    x.emails += g.emails;
    x.outcomes += s.outcomesOf(g);
    x.spend += sp;
    const st = (x.strata[`${g.orgId}|${g.month}`] ??= { exposure: 0, outcomes: 0, spend: 0 });
    st.exposure += g.emails;
    st.outcomes += s.outcomesOf(g);
    st.spend += sp;
    by.set(k, x);
  }
  const order = dim === "weekday" ? WEEKDAYS : Array.from({ length: 24 }, (_, i) => String(i));
  const rows: ResearchBucket[] = order
    .filter((k) => by.has(k))
    .map((k) => {
      const x = by.get(k)!;
      return { key: k, label: label(k), basis: "mature", figures: { spentUsd: x.spend, contacted: x.emails, outcomes: x.outcomes }, learning: x.outcomes < t.outcomesRequired, months: null, strata: x.strata };
    });
  const total = rows.reduce((a, r) => a + r.figures.outcomes, 0);
  if (total < MIN_OUTCOMES || !rows.some((r) => !r.learning)) return null;
  const eTerms: PipeTerms = { ...t, exposureNoun: emailsNoun(t), exposureNounOne: emailsNoun(t).replace(/^emails/, "email") };
  const rate = (r: ResearchBucket) => (100 * r.figures.outcomes) / r.figures.contacted;
  const sorted = rows.filter((r) => r.figures.contacted > 0).sort((a, b) => rate(b) - rate(a) || b.figures.contacted - a.figures.contacted);
  const w = sorted.find((r) => r.figures.outcomes > 0);
  const runnerUp = sorted.find((r) => r !== w) ?? null;
  const strata: Strata = Object.fromEntries(rows.map((r) => [r.label, r.strata!]));
  const arm = (r: ResearchBucket) => ({ label: r.label, outcomes: r.figures.outcomes, exposure: r.figures.contacted, spend: r.figures.spentUsd });
  const v: Verdict = w
    ? compareVerdict({ a: arm(w), b: runnerUp ? arm(runnerUp) : null, goal: "rate", comparisons: rows.length - 1, strata, noun: t.noun, nouns: t.nounPlural, per: "per email" })
    : { kind: "noise", reason: `No ${dim === "weekday" ? "day" : "hour"} has earned a ${t.noun} yet.` };
  const lines: string[] = [];
  if (w) lines.push(`${w.label}: ${sendCounts(t, w.figures.outcomes, w.figures.contacted)}${runnerUp ? `; runner-up ${runnerUp.label}, ${pctText(rate(runnerUp))} (${sendCounts(t, runnerUp.figures.outcomes, runnerUp.figures.contacted)})` : ""}.`);
  // how the sending schedule moved over the window
  const byMonth = new Map<string, { emails: number; inWindow: number; weekend: number }>();
  for (const g of s.rows) {
    if (g.weekday === null || g.hour === null) continue;
    const m = byMonth.get(g.month) ?? { emails: 0, inWindow: 0, weekend: 0 };
    m.emails += g.emails;
    if (g.weekday === "Saturday" || g.weekday === "Sunday") m.weekend += g.emails;
    else if (g.hour >= 8 && g.hour < 17) m.inWindow += g.emails;
    byMonth.set(g.month, m);
  }
  const months = [...byMonth.keys()].sort();
  if (months.length > 1) {
    const a = byMonth.get(months[0]!)!;
    const b = byMonth.get(months[months.length - 1]!)!;
    const pc = (x: number, of: number) => Math.round((100 * x) / of);
    lines.push(
      `The schedule moved over the window: in ${monthLabel(months[0]!)}, ${pc(a.inWindow, a.emails)}% of emails went out Monday to Friday between 08:00 and 17:00 in the prospect's timezone and ${pc(a.weekend, a.emails)}% on a weekend; in ${monthLabel(months[months.length - 1]!)}, ${pc(b.inWindow, b.emails)}% and ${pc(b.weekend, b.emails)}%. So a day or an hour outside that window is also an older month, other clients and other campaigns.`,
    );
  }
  if (dim === "weekday") {
    const sun = rows.find((r) => r.key === "Sunday");
    const week = rows.filter((r) => WEEKDAYS.slice(0, 5).includes(r.key));
    const wk = week.reduce((acc, r) => ({ e: acc.e + r.figures.contacted, o: acc.o + r.figures.outcomes }), { e: 0, o: 0 });
    if (sun && sun.figures.contacted > 0 && wk.e > 0) {
      const pv = rateP({ exposure: sun.figures.contacted, outcomes: sun.figures.outcomes, spend: 0 }, { exposure: wk.e, outcomes: wk.o, spend: 0 });
      lines.push(`Sunday against Monday to Friday: ${pctText(rate(sun))} against ${pctText((100 * wk.o) / wk.e)} (p ${pTextShort(pv)}).`);
    }
    lines.push(`What this cannot answer: whether a Sunday email works on today's campaigns. The days differ by client, month and step of the sequence, which a same-clients, same-months check only partly removes. Only a split test can settle it.`);
  } else {
    const all = rows.reduce((a, r) => a + r.figures.contacted, 0);
    const inWin = rows.filter((r) => Number(r.key) >= 8 && Number(r.key) < 17).reduce((a, r) => a + r.figures.contacted, 0);
    lines.push(`${all ? Math.round((100 * inWin) / all) : 0}% of these emails went out between 08:00 and 17:00 in the prospect's timezone.`);
    lines.push(`What this cannot answer: whether an evening or early-morning email works on today's campaigns. Only a split test on the same clients in the same weeks can settle it.`);
  }
  if (noLocal > 0) lines.push(`${n(noLocal)} ${emailsNoun(t)} whose prospect has no timezone on record are left out.`);
  lines.push(`Each email is filed under its own send ${dim === "weekday" ? "day" : "hour"} in the prospect's timezone, and a ${t.noun} under the email that earned it.`);
  const headline = w ? `${w.label} wins with a ${pctText(rate(w))} ${t.noun} rate.` : `No ${dim === "weekday" ? "day" : "hour"} has earned a ${t.noun} yet.`;
  return {
    id: `${t.pipe}-${dim}-rate`,
    pipe: t.pipe,
    topic: dim,
    goal: "rate",
    question: dim === "weekday" ? "Which day of the week should a cold email go out on?" : "Which hour of the day should a cold email go out at?",
    status: w ? "measured" : "not_enough_data",
    headline: w ? headlineFor(headline, v.kind) : headline,
    winner: w ? w.label : null,
    result: w ? { display: pctText(rate(w)), unit: `${t.noun} rate, % of ${emailsNoun(t)}`, sample: sendCounts(t, w.figures.outcomes, w.figures.contacted) } : null,
    crowned: v.kind === "conclusion",
    verdict: { kind: v.kind, reason: v.reason },
    charts: [
      { kind: "bars", title: `${dim === "weekday" ? "By day of the week" : "By hour of the day"}, prospect's timezone: ${rateTitle(eTerms).charAt(0).toLowerCase()}${rateTitle(eTerms).slice(1)}`, lowerIsBetter: false, points: rateBars(eTerms, rows, { ordinal: true }), note: t.note },
      { kind: "bars", title: `${dim === "weekday" ? "By day of the week" : "By hour of the day"}, prospect's timezone: ${costTitle(eTerms).charAt(0).toLowerCase()}${costTitle(eTerms).slice(1)}`, lowerIsBetter: true, points: costBars(eTerms, rows, { ordinal: true }), note: t.note },
    ],
    conclusion: lines,
  };
}

/** The open-tracking arms (people whose sequence carried the pixel, or not). */
export interface OpensArm {
  people: number;
  positive: number;
  replied: number;
  bounced: number;
  firstDay: string | null;
  lastDay: string | null;
}

/** PURE. The two open-tracking studies of the positive reply pipe (two periods, never a split test: at best a signal). */
export function opensStudies(t: PipeTerms, arms: { on: OpensArm; off: OpensArm; unplaced: number }, cutoffDay: string): ResearchStudy[] {
  const { on, off } = arms;
  if (!on.people || !off.people) {
    const reason = "One arm of the open-tracking comparison reached nobody yet.";
    return [
      notMeasuredStudy({ id: `${t.pipe}-opens-roi`, pipe: t.pipe, topic: "opens", goal: "roi", question: `Should we track opens for the cheapest ${t.noun}?`, headline: "Not enough data yet.", reason }),
      notMeasuredStudy({ id: `${t.pipe}-opens-rate`, pipe: t.pipe, topic: "opens", goal: "rate", question: "Should we track opens for the best reply rate?", headline: "Not enough data yet.", reason }),
    ];
  }
  const metric = (k: "positive" | "replied" | "bounced") => {
    const a = { exposure: off.people, outcomes: off[k], spend: 0 };
    const b = { exposure: on.people, outcomes: on[k], spend: 0 };
    const p = rateP(a, b);
    return { off: { count: off[k], of: off.people, pct: (100 * off[k]) / off.people }, on: { count: on[k], of: on.people, pct: (100 * on[k]) / on.people }, p, significant: p < 0.05 };
  };
  type M = ReturnType<typeof metric>;
  const lead = (m: M) => (m.off.pct >= m.on.pct ? "off" : "on");
  const other = (w: "on" | "off") => (w === "off" ? "on" : "off");
  const arm = (m: M, which: "on" | "off") => ({ label: which === "off" ? "Tracking off" : "Tracking on", value: Number(m[which].pct.toFixed(2)), display: pctText(m[which].pct), note: `${n(m[which].count)} of ${n(m[which].of)} people`, thin: false });
  const verdict = (m: M): Verdict =>
    m.significant
      ? { kind: "signal", reason: `p ${pTextShort(m.p)}, but tracking was on and off in two different periods, not a split test: the calendar can move this as much as the pixel.` }
      : { kind: "noise", reason: `p ${pTextShort(m.p)}: a gap chance alone produces often, and the two periods are not a split test.` };
  const head = (m: M, what: string) => {
    const w = lead(m);
    return `Tracking ${w} wins: ${pctText(m[w].pct)} of people ${what}, against ${pctText(m[other(w)].pct)} (p ${pTextShort(m.p)}).`;
  };
  const result = (m: M) => {
    const w = lead(m);
    const l = other(w);
    return { display: pctText(m[w].pct), unit: `with tracking ${w}, ${pctText(m[l].pct)} ${l}`, sample: `p ${pTextShort(m.p)}, ${n(m.off.of + m.on.of)} people` };
  };
  const periods = `Tracking was on from ${on.firstDay ?? "?"} to ${on.lastDay ?? "?"} and off until ${off.lastDay ?? "?"}: two periods, not a split test, over ${n(on.people + off.people)} people.${arms.unplaced ? ` ${n(arms.unplaced)} people whose sequence cannot be placed in an arm are left out.` : ""}`;
  const note = `People we started writing to on or after ${cutoffDay} are left out: their replies have not had time to arrive.`;
  const pos = metric("positive");
  const rep = metric("replied");
  const bnc = metric("bounced");
  const vPos = verdict(pos);
  const vRep = verdict(rep);
  return [
    {
      id: `${t.pipe}-opens-roi`,
      pipe: t.pipe,
      topic: "opens",
      goal: "roi",
      question: `Should we track opens for the cheapest ${t.noun}?`,
      status: "measured",
      headline: headlineFor(head(pos, "replied positively"), vPos.kind),
      winner: lead(pos) === "off" ? "Tracking off" : "Tracking on",
      result: result(pos),
      crowned: false,
      verdict: { kind: vPos.kind, reason: vPos.reason },
      charts: [{ kind: "bars", title: "People who replied positively (%, higher is better)", lowerIsBetter: false, points: [arm(pos, lead(pos)), arm(pos, other(lead(pos)))], note }],
      conclusion: [`An email costs the same with or without the pixel, so the cheaper ${t.noun} is the arm with more of them per person.`, periods],
    },
    {
      id: `${t.pipe}-opens-rate`,
      pipe: t.pipe,
      topic: "opens",
      goal: "rate",
      question: "Should we track opens for the best reply rate?",
      status: "measured",
      headline: headlineFor(head(rep, "replied"), vRep.kind),
      winner: lead(rep) === "off" ? "Tracking off" : "Tracking on",
      result: result(rep),
      crowned: false,
      verdict: { kind: vRep.kind, reason: vRep.reason },
      charts: [
        { kind: "bars", title: "People who replied, any reply (%, higher is better)", lowerIsBetter: false, points: [arm(rep, lead(rep)), arm(rep, other(lead(rep)))], note },
        { kind: "bars", title: "Bounced (%, lower is better)", lowerIsBetter: true, points: [arm(bnc, "off"), arm(bnc, "on")], note },
      ],
      conclusion: ["Auto-replies and out-of-office messages are not counted as replies.", periods],
    },
  ];
}

export { counts };
