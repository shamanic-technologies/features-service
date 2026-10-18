/**
 * THE TYPED JUDGMENT SECTION (Jev, LIVE-RESEARCH-1018; ported from distribute.you `apps/landing/scripts/blog-data/jev.mjs`).
 * Four studies, each a MEASUREMENT (a count or a share, not a comparison): a conclusion on >= MIN_OUTCOMES events across
 * >= 2 clients, a signal on one client, noise below.
 *
 *  - jev-volume: every judgment billed (runs-service `task-units`: chat-service judgment runs by month, route, asker).
 *  - jev-screen-decline: the lead screen before the paid reveal (human-service until 2026-10-07, lead-service since; a
 *    person passes at P(yes) > 0.5, the bar in force today).
 *  - jev-screen-price: screening one person against revealing one (an Apollo enrichment credit), both as billed.
 *  - jev-machine-replies: who wrote a cold email reply, as instantly-service's reply classifier states it (outreach facts).
 * On the vendor-cost basis the two priced studies say they are not measured there (the prices are billed ones). Pure.
 */
import { MONTHS } from "./format.js";
import { MIN_OUTCOMES } from "./verdict.js";
import { notMeasuredStudy } from "./studies.js";
import type { ResearchOutcomeEntry, ResearchStudy } from "./types.js";

const MIN_ORGS = 2;
const monthLabel = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym;
const n = (v: number) => Math.round(Number(v)).toLocaleString("en-US");
const pct = (v: number) => (v > 0 && v < 0.01 ? "<1%" : `${Math.round(v * 100)}%`);
const usd = (v: number) => (v < 0.01 ? `$${v.toFixed(4)}` : v < 10 ? `$${v.toFixed(2)}` : `$${Math.round(v).toLocaleString("en-US")}`);

function wilson(k: number, total: number): { lo: number; hi: number } | null {
  if (!total) return null;
  const z = 1.96;
  const p = k / total;
  const d = 1 + (z * z) / total;
  const c = p + (z * z) / (2 * total);
  const h = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return { lo: (c - h) / d, hi: (c + h) / d };
}

function measurementVerdict(events: number, orgs: number, what: string): { kind: "conclusion" | "signal" | "noise"; reason: string } {
  if (events < MIN_OUTCOMES) return { kind: "noise", reason: `${n(events)} ${what}: a figure needs at least ${MIN_OUTCOMES}.` };
  if (orgs < MIN_ORGS) return { kind: "signal", reason: `${n(events)} ${what}, all from one client: a measurement of that client, not yet of the fleet.` };
  return { kind: "conclusion", reason: `A measurement on ${n(events)} ${what} across ${n(orgs)} clients, not a comparison.` };
}

function withVerdict(study: Omit<ResearchStudy, "verdict" | "crowned">, verdict: ReturnType<typeof measurementVerdict>): ResearchStudy {
  const headline = verdict.kind === "conclusion" ? study.headline : `${study.headline} ${verdict.kind === "signal" ? "A signal to confirm, not yet a conclusion." : "Noise so far."}`;
  return { ...study, headline, verdict, crowned: verdict.kind === "conclusion" };
}

/** One group of runs-service's judgment volume (`groupBy=month,taskName,parentServiceName`). */
export interface JudgmentGroup {
  month: string;
  taskName: string;
  parentServiceName: string | null;
  runCount: number;
  quantity: number;
  billedCents: number;
}

/** One month of a screen: people per verdict per P(yes) bucket. */
export interface ScreenMonth {
  month: string;
  /** below 0.2 / 0.2 to 0.5 (declined) / above 0.5 below 0.8 / 0.8 and up. */
  buckets: Record<"lt20" | "lt50" | "lt80" | "ge80", { passed: number; declined: number }>;
}

export interface JevInput {
  costBasis: "user" | "actual";
  /** `YYYY-MM-DD` of the read. */
  readOn: string;
  judgments: JudgmentGroup[] | null;
  judgmentOrgs: number;
  /** Screens from both services, null when either could not be read. */
  screens: ScreenMonth[] | null;
  screenOrgs: number;
  screenAudiences: number;
  reveal: { credits: number; billedCents: number } | null;
  /** Reply counts by who wrote them; null when the outreach facts copy is empty. */
  replies: { person: number; outOfOffice: number; otherAuto: number; orgs: number } | null;
}

const BUCKETS: Array<["lt20" | "lt50" | "lt80" | "ge80", string]> = [
  ["lt20", "Below 20%"],
  ["lt50", "20 to 50%"],
  ["lt80", "50 to 80%"],
  ["ge80", "80% and up"],
];
const ASKER: Record<string, string> = { "lead-service": "Lead screens", "google-service": "Inbox triage", google: "Inbox triage", "crm-service": "CRM reads" };

export const JUDGMENT_OUTCOME: ResearchOutcomeEntry = {
  id: "judgment",
  outcome: "Typed judgment",
  description: "One typed question about one piece of text, answered with a probability (Jev).",
  population: "Every judgment our pipes billed since Jev went live on Sep 19, 2026, every client. The reply study reads every reply to our cold emails.",
};

const base = (id: string, goal: "roi" | "rate", question: string) => ({ id, pipe: null, outcome: "judgment" as const, topic: "judgment" as const, goal, question });
const notReadable = (id: string, goal: "roi" | "rate", question: string, what: string) =>
  notMeasuredStudy({ ...base(id, goal, question), headline: "Not readable right now.", reason: `${what} could not be read right now; the study comes back on the next refresh.` });
const vendor = (id: string, goal: "roi" | "rate", question: string) =>
  notMeasuredStudy({ ...base(id, goal, question), headline: "Not measured on vendor cost yet.", reason: "Read this study on the billed basis." });

/** PURE. The four studies. */
export function jevStudies(input: JevInput): ResearchStudy[] {
  const lastMonth = input.readOn.slice(8, 10) === "01" ? null : input.readOn.slice(0, 7);
  const note = "Every judgment billed since Jev went live on Sep 19, 2026, to the read day. A count needs no maturity wait; the month the read day falls in is still running, drawn dotted.";
  const out: ResearchStudy[] = [];
  const Q_VOL = "How many typed judgments do our pipes ask, and what does one cost?";
  const Q_DECLINE = "How many people does the lead screen turn away before we pay to reveal them?";
  const Q_PRICE = "What does screening one person cost, against revealing one?";
  const Q_MACHINE = "How many cold email replies come from a machine, not a person?";

  // volume
  if (input.costBasis === "actual") out.push(vendor("jev-volume", "rate", Q_VOL));
  else if (!input.judgments) out.push(notReadable("jev-volume", "rate", Q_VOL, "runs-service's judgment volume"));
  else {
    const g = input.judgments;
    const total = g.reduce((a, r) => a + r.runCount, 0);
    const tokens = g.reduce((a, r) => a + r.quantity, 0);
    const cents = g.reduce((a, r) => a + r.billedCents, 0);
    const byMonth = new Map<string, number>();
    for (const r of g) byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + r.runCount);
    const byAsker = new Map<string, number>();
    for (const r of g) {
      const k = r.taskName === "platform-judgments" || !r.parentServiceName ? "Platform jobs" : ASKER[r.parentServiceName] ?? "Other questions";
      byAsker.set(k, (byAsker.get(k) ?? 0) + r.runCount);
    }
    const perThousand = total ? cents / 100 / (total / 1000) : 0;
    out.push(
      withVerdict(
        {
          ...base("jev-volume", "rate", Q_VOL),
          status: total ? "measured" : "not_enough_data",
          headline: `${n(total)} judgments since Sep 19, 2026, at ${usd(perThousand)} per 1,000 as billed.`,
          winner: null,
          result: { display: n(total), unit: "typed judgments since Sep 19, 2026", sample: `${n(tokens / 1e6)}M input tokens · ${usd(perThousand)} per 1,000 judgments billed · output free` },
          charts: [
            {
              kind: "bars",
              title: "Judgments by month",
              lowerIsBetter: false,
              points: [...byMonth.keys()].sort().map((m) => ({ label: monthLabel(m), value: byMonth.get(m)!, display: n(byMonth.get(m)!), note: m === lastMonth ? "month in progress" : "", thin: false, ...(m === lastMonth ? { partial: true } : {}) })),
              note,
            },
            {
              kind: "bars",
              title: "Who asks",
              lowerIsBetter: false,
              points: [...byAsker.entries()].sort((a, b) => b[1] - a[1]).map(([label, v]) => ({ label, value: v, display: n(v), note: `${pct(v / total)} of all judgments`, thin: false })),
              note,
            },
          ],
          conclusion: [
            "A judgment is one typed question about one piece of text, answered with a probability: yes or no, one choice among options, or a level.",
            "The bill is input tokens only; Jev charges nothing for its answer.",
          ],
        },
        measurementVerdict(total, input.judgmentOrgs, "judgments"),
      ),
    );
  }

  // the lead screen (a share of people: no price, so the same on both bases)
  if (!input.screens) out.push(notReadable("jev-screen-decline", "rate", Q_DECLINE, "The screens' decisions"));
  else {
    const inBucket = (b: "lt20" | "lt50" | "lt80" | "ge80") => input.screens!.reduce((a, m) => a + m.buckets[b].passed + m.buckets[b].declined, 0);
    const people = BUCKETS.reduce((a, [b]) => a + inBucket(b), 0);
    const declined = inBucket("lt20") + inBucket("lt50");
    const oldBarLost = input.screens.reduce((a, m) => a + m.buckets.lt80.declined, 0);
    const ci = wilson(declined, people);
    out.push(
      withVerdict(
        {
          ...base("jev-screen-decline", "rate", Q_DECLINE),
          status: people ? "measured" : "not_enough_data",
          headline: `${pct(people ? declined / people : 0)} of the people Apollo returns are turned away before the paid reveal.`,
          winner: null,
          result: people ? { display: pct(declined / people), unit: "turned away before the paid reveal", sample: `${n(declined)} of ${n(people)} people · ${n(input.screenAudiences)} audiences · ${n(input.screenOrgs)} clients` } : null,
          charts: [
            {
              kind: "bars",
              title: "People screened, by Jev's probability that they fit the audience",
              lowerIsBetter: false,
              points: BUCKETS.map(([b, label]) => {
                const v = inBucket(b);
                return { label, value: v, display: n(v), note: `${pct(people ? v / people : 0)} · ${b === "lt20" || b === "lt50" ? "turned away" : "revealed"}`, thin: false };
              }),
              note: "Each person is judged once against the audience the client described, before any paid step. A person passes above 50%.",
            },
          ],
          conclusion: people
            ? [
                `A pass needs a probability above 50%. ${pct(declined / people)} stay at or under it, 95% interval ${pct(ci!.lo)} to ${pct(ci!.hi)}.`,
                `${n(inBucket("lt20") + inBucket("ge80"))} of ${n(people)} answers (${pct((inBucket("lt20") + inBucket("ge80")) / people)}) are below 20% or at 80% and up: Jev is sure on most people.`,
                ...(people > declined ? [`Only the people kept are revealed, so the same budget reaches ${(people / (people - declined)).toFixed(1)}x more people who fit than revealing the whole list.`] : []),
                `Until Sep 29, 2026 the bar was 80%. ${n(oldBarLost)} people between 50% and 80% were turned away under it; they count as passes here.`,
                "The clients and audiences counted are at least the larger of the two screens' own counts (human-service until Oct 7, 2026, lead-service since).",
              ]
            : ["No person screened yet."],
        },
        measurementVerdict(declined, input.screenOrgs, "people turned away"),
      ),
    );
  }

  // screen price against reveal price
  if (input.costBasis === "actual") out.push(vendor("jev-screen-price", "roi", Q_PRICE));
  else if (!input.judgments || !input.reveal) out.push(notReadable("jev-screen-price", "roi", Q_PRICE, "runs-service's judgment and reveal prices"));
  else {
    const screens = input.judgments.filter((r) => r.taskName === "judgments" && r.parentServiceName === "lead-service");
    const screenCount = screens.reduce((a, r) => a + r.runCount, 0);
    const screenUsd = screenCount ? screens.reduce((a, r) => a + r.billedCents, 0) / 100 / screenCount : 0;
    const revealUsd = input.reveal.credits ? input.reveal.billedCents / 100 / input.reveal.credits : 0;
    const measured = screenUsd > 0 && revealUsd > 0;
    const ratio = measured ? revealUsd / screenUsd : 0;
    out.push(
      withVerdict(
        {
          ...base("jev-screen-price", "roi", Q_PRICE),
          status: measured ? "measured" : "not_enough_data",
          headline: measured ? `Screening a person costs ${n(ratio)}x less than revealing one.` : "No screen or no reveal billed yet.",
          winner: null,
          result: measured ? { display: `${n(ratio)}x`, unit: "cheaper to screen a person than to reveal one", sample: `${usd(screenUsd * 1000)} per 1,000 screens · ${usd(revealUsd)} per reveal · ${n(screenCount)} screens, ${n(input.reveal.credits)} reveals` } : null,
          charts: measured
            ? [
                {
                  kind: "bars",
                  title: "Billed per person",
                  lowerIsBetter: true,
                  points: [
                    { label: "Screen (Jev)", value: screenUsd, display: usd(screenUsd), note: `${n(screenCount)} screens`, thin: false },
                    { label: "Reveal (Apollo)", value: revealUsd, display: usd(revealUsd), note: `${n(input.reveal.credits)} credits`, thin: false },
                  ],
                  note: "Both as billed to clients. A reveal is one Apollo enrichment credit, billed since Sep 28, 2026, when the screen started.",
                },
              ]
            : [],
          conclusion: [
            "Every person turned away by the screen is a reveal nobody pays for.",
            "Not every pass becomes a paid reveal (no email found, already reached), so the saving is counted per screen, never as a total.",
          ],
        },
        measurementVerdict(screenCount, input.screenOrgs, "screens"),
      ),
    );
  }

  // who wrote the reply
  if (!input.replies) out.push(notReadable("jev-machine-replies", "rate", Q_MACHINE, "The copy of instantly-service's outreach facts"));
  else {
    const r = input.replies;
    const replies = r.person + r.outOfOffice + r.otherAuto;
    const machine = r.outOfOffice + r.otherAuto;
    const mci = wilson(machine, replies);
    const points = [
      ["A person", r.person],
      ["Out of office", r.outOfOffice],
      ["Other auto-reply", r.otherAuto],
    ] as Array<[string, number]>;
    out.push(
      withVerdict(
        {
          ...base("jev-machine-replies", "rate", Q_MACHINE),
          status: replies ? "measured" : "not_enough_data",
          headline: `${pct(replies ? machine / replies : 0)} of our cold email replies are written by a machine.`,
          winner: null,
          result: replies ? { display: pct(machine / replies), unit: "of replies written by a machine", sample: `${n(machine)} of ${n(replies)} replies` } : null,
          charts: [
            {
              kind: "bars",
              title: "Cold email replies, by who wrote them",
              lowerIsBetter: false,
              points: points.sort((a, b) => b[1] - a[1]).map(([label, v]) => ({ label, value: v, display: n(v), note: pct(replies ? v / replies : 0), thin: false })),
              note: "Every reply to our cold emails, labelled by the reply classifier. A reply rate that counts them all counts the machines too.",
            },
          ],
          conclusion: replies
            ? [`${pct(machine / replies)} of replies are out-of-office or other auto-replies, 95% interval ${pct(mci!.lo)} to ${pct(mci!.hi)}.`]
            : ["No reply yet."],
        },
        measurementVerdict(machine, r.orgs, "machine replies"),
      ),
    );
  }
  return out;
}
