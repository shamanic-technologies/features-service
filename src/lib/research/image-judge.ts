/**
 * "Ask a website question on the screenshot or on a description of it?" (IMAGE-JUDGE-STUDY-1021). Pure: the evidence
 * is the committed one-off benchmark (`image-judge-benchmark.ts`), this writes the study.
 *
 * The two ways: OLD, a model writes a generic description of the homepage screenshot and Jev answers the qualification
 * question on that text; NEW, Jev answers the question on the screenshot itself (lead-service since 2026-10-21,
 * SCREENSHOT-CHECK-QUESTION-1021). Same screenshots, same questions, same judge: the items are PAIRED, so the like-for-
 * like check of the page's verdict rule holds by construction (no client mix can pass for a way's effect).
 *
 * Verdict, the page's rule (`verdict.ts`) on paired items: per question, only the DISAGREEMENTS checked by eye carry
 * information (where both ways agree, they are both right or both wrong); on each, exactly one way was right. Under "the
 * two ways are as good", the way that was right is a coin flip: the exact two-sided binomial at 1/2 (`exactP` on equal
 * exposures, the exact McNemar test). conclusion = p under 0.05 / the questions compared (Bonferroni); signal = under
 * 0.05 only; noise = the rest, or a leader right on fewer than MIN_OUTCOMES. Ambiguous checks and a way that gave no
 * answer are not scored.
 */
import { exactP, MIN_OUTCOMES, pText, type VerdictKind } from "./verdict.js";
import { DESCRIBED_CRITERIA, IMAGE_JUDGE_BENCHMARK, type ImageJudgeBenchmark, type ImageJudgeRow } from "./image-judge-benchmark.js";
import type { ResearchChart, ResearchPoint, ResearchStudy } from "./types.js";

export const IMAGE_JUDGE_STUDY_ID = "jev-screenshot-vs-description";

const ALPHA = 0.05;
const IMAGE = "On the screenshot";
const DESCRIPTION = "On a description";
const QUESTION_LABEL: Record<ImageJudgeRow["question"], string> = {
  phone: "Phone number in the header",
  reviews: "Review rating",
  chat: "Chat widget",
  address: "Street address",
};
const QUESTION_ORDER: ReadonlyArray<ImageJudgeRow["question"]> = ["phone", "reviews", "address", "chat"];
/** A question's own bars never carry the study's Winner mark (the page puts it on the first bar named like the winner). */
const PER_QUESTION = ["Asked on the screenshot", "Asked on a description"] as const;
const RANK: Record<VerdictKind, number> = { conclusion: 2, signal: 1, noise: 0 };

const decided = (a: string): a is "yes" | "no" => a === "yes" || a === "no";
const judged = (r: ImageJudgeRow): r is ImageJudgeRow & { truth: "yes" | "no" } => r.truth === "yes" || r.truth === "no";
const of = (k: number, total: number) => `${k} of ${total}`;

export interface QuestionScore {
  question: ImageJudgeRow["question"];
  label: string;
  /** Disagreements checked by eye with a clear answer: on each, exactly one way was right. */
  scored: number;
  imageRight: number;
  descriptionRight: number;
  /** Disagreements the eye could not settle (not scored). */
  ambiguous: number;
  leader: typeof IMAGE | typeof DESCRIPTION | null;
  verdict: { kind: VerdictKind; reason: string; p: number | null };
}

/** PURE. One question's paired score and its verdict, Bonferroni over `comparisons` questions. */
export function scoreQuestion(rows: readonly ImageJudgeRow[], question: ImageJudgeRow["question"], comparisons: number): QuestionScore {
  const disagreements = rows.filter((r) => r.question === question && decided(r.image) && decided(r.description) && r.image !== r.description);
  const scoredRows = disagreements.filter(judged);
  const imageRight = scoredRows.filter((r) => r.image === r.truth).length;
  const descriptionRight = scoredRows.filter((r) => r.description === r.truth).length;
  const ambiguous = disagreements.filter((r) => r.truth === "ambiguous").length;
  const label = QUESTION_LABEL[question];
  const base = { question, label, scored: scoredRows.length, imageRight, descriptionRight, ambiguous };
  if (!scoredRows.length) return { ...base, leader: null, verdict: { kind: "noise", reason: `${label}: no disagreement checked by eye, nothing to compare.`, p: null } };
  const leader = imageRight >= descriptionRight ? IMAGE : DESCRIPTION;
  const [lead, trail] = leader === IMAGE ? [imageRight, descriptionRight] : [descriptionRight, imageRight];
  const vs = `${label}: ${leader.toLowerCase()} right on ${of(lead, scoredRows.length)} disagreements checked by eye`;
  if (lead < MIN_OUTCOMES) {
    return { ...base, leader, verdict: { kind: "noise", reason: `${vs}; a lead needs at least ${MIN_OUTCOMES} before chance stops dominating.`, p: null } };
  }
  const p = exactP(lead, 1, trail, 1);
  const m = Math.max(1, comparisons);
  const alpha = ALPHA / m;
  const corr = m > 1 ? ` (${m} questions compared, so the bar is p < ${pText(alpha)})` : "";
  const kind: VerdictKind = p < alpha ? "conclusion" : p < ALPHA ? "signal" : "noise";
  const reason =
    kind === "conclusion"
      ? `${vs}: p ${pText(p)}${corr}, on the same screenshots asked both ways.`
      : kind === "signal"
        ? `${vs}: p ${pText(p)}, but not under the corrected bar${corr}.`
        : `${vs}: p ${pText(p)}, a gap chance alone produces often.`;
  return { ...base, leader, verdict: { kind, reason, p } };
}

const point = (label: string, value: number, display: string, note: string): ResearchPoint => ({ label, value, display, note, thin: false });

/** Two bars, the way right more often first (the page marks the first bar as the leader). */
function pairChart(title: string, image: number, description: number, total: number, note: string, labels: readonly [string, string] = [IMAGE, DESCRIPTION]): ResearchChart {
  const bars = [
    point(labels[0], image, String(image), `right on ${of(image, total)} disagreements checked by eye`),
    point(labels[1], description, String(description), `right on ${of(description, total)} disagreements checked by eye`),
  ];
  return { kind: "bars", title, lowerIsBetter: false, points: description > image ? bars.reverse() : bars, note };
}

/** The phone question on the homepages whose every header was checked by eye, agreements included. */
function everyHeaderChecked(rows: readonly ImageJudgeRow[]) {
  const all = rows.filter((r) => r.question === "phone" && (r.checked ?? "").startsWith("every header checked"));
  const way = (pick: (r: ImageJudgeRow) => string) => {
    const j = all.filter((r) => judged(r) && decided(pick(r)));
    return { right: j.filter((r) => pick(r) === r.truth).length, judged: j.length };
  };
  return { homepages: all.length, image: way((r) => r.image), description: way((r) => r.description) };
}

const pct = (k: number, total: number) => (total ? Math.round((k / total) * 100) : 0);

/** PURE. The study. */
export function imageJudgeStudy(benchmark: ImageJudgeBenchmark = IMAGE_JUDGE_BENCHMARK): ResearchStudy {
  const compared = QUESTION_ORDER.filter((q) => benchmark.rows.some((r) => r.question === q && decided(r.image) && decided(r.description) && r.image !== r.description && judged(r)));
  const scores = QUESTION_ORDER.map((q) => scoreQuestion(benchmark.rows, q, compared.length));
  const scored = scores.reduce((a, s) => a + s.scored, 0);
  const imageRight = scores.reduce((a, s) => a + s.imageRight, 0);
  const descriptionRight = scores.reduce((a, s) => a + s.descriptionRight, 0);
  const ambiguous = scores.reduce((a, s) => a + s.ambiguous, 0);
  const best = scores.reduce<QuestionScore | null>((b, s) => (!b || RANK[s.verdict.kind] > RANK[b.verdict.kind] ? s : b), null);
  const kind: VerdictKind = best?.verdict.kind ?? "noise";
  const winner = imageRight >= descriptionRight ? IMAGE : DESCRIPTION;
  const byKind = (k: VerdictKind) => scores.filter((s) => s.verdict.kind === k).map((s) => s.label.toLowerCase());
  const words = (list: readonly string[]) => (list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`);
  const parts = [
    byKind("conclusion").length ? `a conclusion on ${words(byKind("conclusion"))}` : null,
    byKind("signal").length ? `a signal on ${words(byKind("signal"))}` : null,
    byKind("noise").length ? `noise on ${words(byKind("noise"))}` : null,
  ].filter((x): x is string => x !== null);
  const headers = everyHeaderChecked(benchmark.rows);
  const method =
    `${benchmark.screenshots} stored homepage screenshots, ${compared.length} questions each, asked both ways with the same judge (${benchmark.judge}); ` +
    `the description is the stored one (${benchmark.describer}). Only the disagreements carry a verdict: each was checked by eye. ` +
    `${ambiguous} the eye could not settle are not scored.`;
  const described =
    `On the ${DESCRIBED_CRITERIA.criteria.length} client criteria a generic description does cover (${words(DESCRIBED_CRITERIA.criteria)}; ` +
    `${DESCRIBED_CRITERIA.clients} clients, ${DESCRIBED_CRITERIA.checks} checks), the two ways agreed on every decided answer but ${DESCRIBED_CRITERIA.disagreements} subjective design call.`;
  const conclusion: string[] = scores
    .filter((s) => s.verdict.kind === "conclusion")
    .map((s) => `${s.label}: ask on the screenshot. Where the two ways disagreed, it was right on ${of(s.imageRight, s.scored)} (p ${pText(s.verdict.p ?? 1)}).`);
  if (scores.find((s) => s.question === "phone")?.verdict.kind === "conclusion" && headers.homepages) {
    conclusion.push(
      `On ${headers.homepages} homepages of one trade, every header checked by eye: the screenshot answer was right on ${of(headers.image.right, headers.image.judged)}, the description on ${of(headers.description.right, headers.description.judged)}.`,
    );
  }
  return {
    id: IMAGE_JUDGE_STUDY_ID,
    pipe: null,
    outcome: "judgment",
    topic: "judgment",
    goal: "rate",
    question: "Ask a website question on the screenshot or on a description of it?",
    status: "measured",
    headline: `Ask on the screenshot: where the two ways disagreed, it was right on ${of(imageRight, scored)}.`,
    winner,
    crowned: kind === "conclusion",
    verdict: {
      kind,
      reason: `Paired: the same screenshots asked both ways, scored on the disagreements checked by eye, Bonferroni over ${compared.length} questions. ${parts.join(", ")}. ${scores.map((s) => s.verdict.reason).join(" ")}`,
    },
    result: { display: of(imageRight, scored), unit: "disagreements the screenshot answer got right", sample: `${benchmark.screenshots} homepage screenshots x ${compared.length} questions, read on ${benchmark.readOn}` },
    charts: [
      pairChart("Right answers where the two ways disagreed, every question", imageRight, descriptionRight, scored, `${method} ${described}`),
      ...scores.filter((s) => s.scored > 0).map((s) => pairChart(`${s.label}: right answers where the two ways disagreed`, s.imageRight, s.descriptionRight, s.scored, s.verdict.reason, PER_QUESTION)),
      ...(headers.homepages
        ? [
            {
              kind: "bars" as const,
              title: `Phone number in the header, every header checked by eye (${headers.homepages} homepages)`,
              lowerIsBetter: false,
              points: [
                point(IMAGE, pct(headers.image.right, headers.image.judged), `${pct(headers.image.right, headers.image.judged)}%`, `right on ${of(headers.image.right, headers.image.judged)} judged`),
                point(DESCRIPTION, pct(headers.description.right, headers.description.judged), `${pct(headers.description.right, headers.description.judged)}%`, `right on ${of(headers.description.right, headers.description.judged)} judged`),
              ],
              note: "Agreements included: every header of one trade's homepages was checked by eye, not only the disagreements.",
            },
          ]
        : []),
    ],
    conclusion,
  };
}
