/**
 * THE RESEARCH STUDIES AS A BACKEND SERVICE READS THEM (LIVE-RESEARCH-1018): social-service quotes the CONCLUSION studies
 * in the takes it posts as Kevin / distribute.you, and its comment writer reads every measured study for context. The
 * bodies are byte-compatible with what the dashboard served off the nightly snapshot (distribute.you
 * `apps/dashboard/src/lib/research/conclusions.ts`, `/api/internal/research/{conclusions,studies}`), now from the live file.
 *
 * Only a `measured` study whose verdict is `conclusion` is quotable; a Learning chart point (`thin`) or one stating no
 * value is never a fact. Always the BILLED basis (the actual one reveals our margin). Pure: nothing here computes a
 * figure, every string is the study's own.
 */
import type { ResearchFile, ResearchStudy } from "./types.js";

export interface ResearchFact {
  statement: string;
  sample: string | null;
}

export interface ResearchConclusion {
  id: string;
  outcome: string;
  question: string;
  headline: string;
  verdict: { kind: "conclusion"; reason: string };
  result: { display: string; unit: string; sample: string } | null;
  facts: ResearchFact[];
}

export interface ResearchConclusionsBody {
  generatedAt: string;
  readOn: string;
  window: { from: string; to: string };
  costBasis: "user";
  conclusions: ResearchConclusion[];
}

export interface ResearchStudyItem {
  id: string;
  outcome: string;
  question: string;
  headline: string;
  verdict: { kind: "conclusion" | "signal" | "noise"; reason: string } | null;
  quotable: boolean;
  result: { display: string; unit: string; sample: string } | null;
  facts: ResearchFact[];
}

export interface ResearchStudiesBody {
  generatedAt: string;
  readOn: string;
  window: { from: string; to: string };
  costBasis: "user";
  studies: ResearchStudyItem[];
}

const NO_VALUE = /^(none yet|no one yet)$/i;

function factsOf(study: ResearchStudy): ResearchFact[] {
  const sample = study.result?.sample ?? null;
  const facts: ResearchFact[] = [];
  if (study.result) facts.push({ statement: `${study.headline} (${study.result.display} ${study.result.unit})`, sample });
  else facts.push({ statement: study.headline, sample: null });
  facts.push({ statement: study.verdict.reason, sample });
  for (const line of study.conclusion) facts.push({ statement: line, sample });
  for (const chart of study.charts) {
    const series = [{ title: chart.title, points: chart.points }];
    if (chart.cumulative) series.push({ title: chart.cumulative.title, points: chart.cumulative.points });
    for (const s of series) {
      for (const p of s.points) {
        if (p.thin || NO_VALUE.test(p.display.trim())) continue;
        facts.push({ statement: `${s.title}: ${p.label}, ${p.display}`, sample: p.note });
      }
    }
  }
  return facts;
}

/** The outcome a study measures, in plain words (its pipe's or its outcome section's). */
function outcomeText(study: ResearchStudy, file: ResearchFile): string {
  const text = study.pipe
    ? file.pipes.find((p) => p.id === study.pipe)?.outcome
    : file.outcomes.find((o) => o.id === study.outcome)?.outcome;
  if (!text) throw new Error(`[features-service] research study ${study.id} names section ${study.pipe ?? study.outcome}, absent from the file`);
  return text;
}

function billed(file: ResearchFile): void {
  if (file.costBasis !== "user") throw new Error(`[features-service] research quotes must come from the billed basis, got ${file.costBasis}`);
}

/** PURE. The quotable studies. */
export function researchConclusions(file: ResearchFile): ResearchConclusionsBody {
  billed(file);
  const conclusions: ResearchConclusion[] = [];
  for (const study of file.studies) {
    if (study.status !== "measured" || study.verdict.kind !== "conclusion") continue;
    conclusions.push({
      id: study.id,
      outcome: outcomeText(study, file),
      question: study.question,
      headline: study.headline,
      verdict: { kind: "conclusion", reason: study.verdict.reason },
      result: study.result,
      facts: factsOf(study),
    });
  }
  return { generatedAt: file.generatedAt, readOn: file.readOn, window: file.window, costBasis: "user", conclusions };
}

/** PURE. Every measured study, `quotable` only on a conclusion. */
export function researchMeasuredStudies(file: ResearchFile): ResearchStudiesBody {
  billed(file);
  const studies: ResearchStudyItem[] = [];
  for (const study of file.studies) {
    if (study.status !== "measured") continue;
    studies.push({
      id: study.id,
      outcome: outcomeText(study, file),
      question: study.question,
      headline: study.headline,
      verdict: study.verdict,
      quotable: study.verdict.kind === "conclusion",
      result: study.result,
      facts: factsOf(study),
    });
  }
  return { generatedAt: file.generatedAt, readOn: file.readOn, window: file.window, costBasis: "user", studies };
}
