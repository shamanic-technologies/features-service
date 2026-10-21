/**
 * "Which AI reads a prospect's homepage best, and at what price?" (IMAGE-JUDGE-RIVALS-STUDY-1021). Pure: the evidence
 * is the committed one-off benchmark (`image-judge-rivals-benchmark.ts`), this writes the study.
 *
 * Six models answered the same yes/no lead qualification questions on the same stored homepage screenshots, so the
 * items are PAIRED: the like-for-like check of the page's verdict rule holds by construction. An answer is right when it
 * is among the accepted ones; an `ambiguous` item is not scored.
 *
 * Verdict, the page's rule (`verdict.ts`) on paired items, each rival against Jev: only the items where exactly one of
 * the two is right carry information. Under "the two read as well", which one was right is a coin flip: the exact
 * two-sided binomial at 1/2 (`exactP` on equal exposures, the exact sign test). conclusion = p under 0.05 / the rivals
 * compared (Bonferroni); signal = under 0.05 only; noise = the rest, or a leader right on fewer than MIN_OUTCOMES. The
 * study's verdict = its strongest rival's. Price is a MEASURED fact (what each run billed at catalogue prices, over its
 * calls), never a statistical claim: it carries no verdict.
 */
import { exactP, MIN_OUTCOMES, pText, type VerdictKind } from "./verdict.js";
import { IMAGE_JUDGE_RIVALS_BENCHMARK, type RivalsBenchmark, type RivalsModel, type RivalsRow } from "./image-judge-rivals-benchmark.js";
import type { ResearchPoint, ResearchStudy } from "./types.js";

export const IMAGE_JUDGE_RIVALS_STUDY_ID = "image-judge-rivals";

const ALPHA = 0.05;
const REFERENCE = "jev";
const RANK: Record<VerdictKind, number> = { conclusion: 2, signal: 1, noise: 0 };

type Scored = RivalsRow & { accepted: RivalsRow["accepted"] & unknown[] };
const isScored = (r: RivalsRow): r is Scored => r.accepted !== "ambiguous";
const right = (r: Scored, key: string) => r.accepted.includes(r.answers[key]!);
const of = (k: number, total: number) => `${k} of ${total}`;
const pct1 = (k: number, total: number) => Math.round((k / total) * 1000) / 10;
/** "Jev 1.13 (TypeSafe)" reads "Jev 1.13" on a bar. */
const short = (m: RivalsModel) => m.label.replace(/\s*\(.*\)\s*$/, "");

export interface ModelScore {
  key: string;
  label: string;
  right: number;
  scored: number;
  /** USD per 1,000 checks: billed cents / calls x 10. */
  perThousandUsd: number;
}

export interface RivalVsReference {
  key: string;
  label: string;
  /** Items the reference got right and the rival wrong, and the reverse. */
  referenceOnly: number;
  rivalOnly: number;
  verdict: { kind: VerdictKind; reason: string; p: number | null };
}

/** PURE. Every model's right answers on the scored items and its price per 1,000 checks. */
export function scoreModels(b: RivalsBenchmark): ModelScore[] {
  const scored = b.rows.filter(isScored);
  return b.models.map((m) => ({
    key: m.key,
    label: short(m),
    right: scored.filter((r) => right(r, m.key)).length,
    scored: scored.length,
    perThousandUsd: (m.billedCents / 100 / m.calls) * 1000,
  }));
}

/** PURE. One rival against the reference, paired, Bonferroni over `comparisons` rivals. */
export function compareToReference(b: RivalsBenchmark, rival: RivalsModel, reference: RivalsModel, comparisons: number): RivalVsReference {
  const scored = b.rows.filter(isScored);
  const referenceOnly = scored.filter((r) => right(r, reference.key) && !right(r, rival.key)).length;
  const rivalOnly = scored.filter((r) => right(r, rival.key) && !right(r, reference.key)).length;
  const label = short(rival);
  const base = { key: rival.key, label, referenceOnly, rivalOnly };
  const split = referenceOnly + rivalOnly;
  const vs = `${label} vs ${short(reference)}: ${short(reference)} alone right on ${referenceOnly}, ${label} alone on ${rivalOnly}`;
  if (!split) return { ...base, verdict: { kind: "noise", reason: `${vs}: they never split, nothing to compare.`, p: null } };
  if (Math.max(referenceOnly, rivalOnly) < MIN_OUTCOMES) {
    return { ...base, verdict: { kind: "noise", reason: `${vs}; a lead needs at least ${MIN_OUTCOMES} before chance stops dominating.`, p: null } };
  }
  const p = exactP(referenceOnly, 1, rivalOnly, 1);
  const m = Math.max(1, comparisons);
  const alpha = ALPHA / m;
  const corr = m > 1 ? ` (${m} rivals compared, so the bar is p < ${pText(alpha)})` : "";
  const kind: VerdictKind = p < alpha ? "conclusion" : p < ALPHA ? "signal" : "noise";
  const reason =
    kind === "conclusion"
      ? `${vs}: p ${pText(p)}${corr}, on the same screenshots and questions.`
      : kind === "signal"
        ? `${vs}: p ${pText(p)}, but not under the corrected bar${corr}.`
        : `${vs}: p ${pText(p)}, a gap chance alone produces often.`;
  return { ...base, verdict: { kind, reason, p } };
}

const point = (label: string, value: number, display: string, note: string): ResearchPoint => ({ label, value, display, note, thin: false });
const usd = (x: number) => `$${x.toFixed(2)}`;

/** PURE. The study. */
export function imageJudgeRivalsStudy(b: RivalsBenchmark = IMAGE_JUDGE_RIVALS_BENCHMARK): ResearchStudy {
  const reference = b.models.find((m) => m.key === REFERENCE);
  if (!reference) throw new Error(`image-judge rivals benchmark has no ${REFERENCE} model`);
  const rivals = b.models.filter((m) => m.key !== REFERENCE);
  const scores = scoreModels(b);
  const scoreOf = (key: string) => scores.find((s) => s.key === key)!;
  const vs = rivals.map((m) => compareToReference(b, m, reference, rivals.length));
  const best = vs.reduce<RivalVsReference | null>((acc, v) => (!acc || RANK[v.verdict.kind] > RANK[acc.verdict.kind] ? v : acc), null);
  const kind: VerdictKind = best?.verdict.kind ?? "noise";
  const scored = scores[0]?.scored ?? 0;
  const ambiguous = b.rows.length - scored;
  const unanimous = b.rows.filter((r) => isScored(r) && r.truthFrom === "unanimous").length;
  const questions = Object.keys(b.questions).length;
  const byPrice = [...scores].sort((x, y) => x.perThousandUsd - y.perThousandUsd);
  const cheapest = byPrice[0]!;
  const dearest = byPrice[byPrice.length - 1]!;
  const byAccuracy = [...scores].sort((x, y) => y.right - x.right || x.perThousandUsd - y.perThousandUsd);
  const lo = byAccuracy[byAccuracy.length - 1]!;
  const hi = byAccuracy[0]!;

  // A winner only when a rival differs from the reference beyond chance; the reference wins when it beat that rival.
  const decisive = kind === "conclusion" ? best! : null;
  const winner = decisive ? (decisive.referenceOnly > decisive.rivalOnly ? short(reference) : decisive.label) : null;
  const differs = vs.filter((v) => v.verdict.kind !== "noise");
  const accuracyLine = differs.length
    ? differs.map((v) => v.verdict.reason).join(" ")
    : `No accuracy winner: every model was right on ${pct1(lo.right, scored)}% to ${pct1(hi.right, scored)}% of the ${scored} scored checks, and no rival differs from ${short(reference)} beyond chance (paired, Bonferroni over ${rivals.length} rivals).`;
  const priceLine =
    `Price per 1,000 checks, measured on the billed run: ${byPrice.map((s) => `${s.label} ${usd(s.perThousandUsd)}`).join(", ")}. ` +
    `${dearest.label} costs ${Math.round(dearest.perThousandUsd / cheapest.perThousandUsd)}x ${cheapest.label}.`;
  const method =
    `${b.screenshots} stored prospect homepage screenshots, ${questions} yes/no qualification questions each, asked of every model through our model router. ` +
    `Truth: the answer all six gave (${unanimous} checks), else checked by eye (${scored - unanimous}); ${ambiguous} the eye could not settle are not scored.`;

  return {
    id: IMAGE_JUDGE_RIVALS_STUDY_ID,
    pipe: null,
    outcome: "judgment",
    topic: "judgment",
    goal: "rate",
    question: "Which AI reads a prospect's homepage best, and at what price?",
    status: "measured",
    // the page's headline rule: a study short of a conclusion says so in its own words
    headline: decisive
      ? `${winner} reads homepages best: ${decisive.verdict.reason}`
      : `No AI reads a homepage measurably better. ${cheapest.label} is the cheapest at ${usd(cheapest.perThousandUsd)} per 1,000 checks, ${dearest.label} costs ${usd(dearest.perThousandUsd)}. ${kind === "signal" ? "A signal to confirm, not yet a conclusion." : "Noise so far."}`,
    winner,
    crowned: kind === "conclusion",
    verdict: {
      kind,
      reason: `Paired: every model on the same screenshots and questions, each rival against ${short(reference)} on the checks where exactly one was right, exact sign test, Bonferroni over ${rivals.length} rivals. ${vs.map((v) => v.verdict.reason).join(" ")} Price is measured, not tested.`,
    },
    result: {
      display: usd(cheapest.perThousandUsd),
      unit: `per 1,000 checks, ${cheapest.label}, the cheapest model`,
      sample: `${b.screenshots} homepage screenshots x ${questions} questions, ${scored} checks scored per model, read on ${b.readOn}`,
    },
    charts: [
      {
        kind: "bars",
        title: `Right answers, out of ${scored} scored checks`,
        lowerIsBetter: false,
        points: byAccuracy.map((s) => {
          const v = vs.find((x) => x.key === s.key);
          const pair = v ? `; vs ${short(reference)}: ${short(reference)} alone right on ${v.referenceOnly}, ${s.label} alone on ${v.rivalOnly}${v.verdict.p === null ? "" : `, p ${pText(v.verdict.p)}`}` : "";
          return point(s.label, pct1(s.right, scored), `${pct1(s.right, scored)}%`, `right on ${of(s.right, scored)}${pair}`);
        }),
        note: `${method} ${accuracyLine}`,
      },
      {
        kind: "bars",
        title: "Price per 1,000 checks",
        lowerIsBetter: true,
        points: byPrice.map((s) => {
          const m = b.models.find((x) => x.key === s.key)!;
          return point(s.label, Math.round(s.perThousandUsd * 100) / 100, usd(s.perThousandUsd), `${usd(m.billedCents / 100)} billed over ${m.calls} checks, at our catalogue prices`);
        }),
        note: "What each model's run billed at our catalogue prices, divided by the checks it was asked. A measured fact, not a statistical claim.",
      },
    ],
    conclusion: [accuracyLine, priceLine],
  };
}
