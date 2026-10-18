/**
 * NAMING THE CLIENT (LIVE-RESEARCH-1018; ported from distribute.you `apps/landing/scripts/blog-data/naming/naming.mjs`):
 * does an email that keeps the client's name back get more positive replies, and cheaper ones, than one that names it?
 * Each template VERSION is put on a side by what its prompt tells the model, read from the prompt text itself (served by
 * content-generation-service), never from the template's family name: some "blind" versions tell the model to name the
 * client and some "cold" ones to keep it back. A prompt that says both, or neither, is left out and counted. Asked of the
 * positive reply pipe only: a website visit needs the name and the link. Pure.
 */
import { n, pctText, usd } from "./format.js";
import { costP, headlineFor, pTextShort, rateP } from "./verdict.js";
import { compareVerdict } from "./verdict.js";
import { costBars, costTitle, counts, pricedSorted, rateBars, rateTitle, strataOf, type PipeTerms, type ResearchBucket } from "./studies.js";
import type { ResearchStudy } from "./types.js";

export const NAMES_CLIENT =
  /(?<!never )(?<!not )\bname the client\b|\bDO name the brand\b|\bname the (?:client )?brand\b|reveal the brand name and website|naming them, recommending them|you can name the agency/i;
export const KEEPS_CLIENT_BACK =
  /never (?:name|reveal|mention) the (?:client|agency)|not (?:reveal|mention) the client|client's name[^.\n]*(?:hidden|replaced)|name and URL stay hidden|do not mention the client|keeping the client anonymous|never mention the client's brand name|without naming the agency/i;

export type NamingSide = "held" | "named";
export const NAMING_LABEL: Record<NamingSide, string> = { held: "Client not named", named: "Client named" };
const WITH: Record<NamingSide, string> = { held: "with the client not named", named: "with the client named" };

/** PURE. A template prompt's side: `held`, `named`, `both` (says both: left out), or null (says neither / no text). */
export function namingOf(text: string | null | undefined): NamingSide | "both" | null {
  if (!text) return null;
  const named = NAMES_CLIENT.test(text);
  const held = KEEPS_CLIENT_BACK.test(text);
  if (named && held) return "both";
  return named ? "named" : held ? "held" : null;
}

export interface NamingInput {
  /** The two sides as buckets (pooled template slugs), `held` first. */
  held: ResearchBucket & { versions: number };
  named: ResearchBucket & { versions: number };
  /** People of templates whose prompt says neither / both / has no text. */
  silentPeople: number;
  bothTemplates: string[];
}

const sideOf = (b: ResearchBucket): NamingSide => (b.label === NAMING_LABEL.held ? "held" : "named");
const exposure = (b: ResearchBucket) => ({ exposure: b.figures.contacted, outcomes: b.figures.outcomes, spend: b.figures.spentUsd });

/** PURE. The rate study and the cost study of the positive reply pipe. */
export function namingStudies(t: PipeTerms, input: NamingInput): ResearchStudy[] {
  const { held, named } = input;
  const rows = [held, named];
  const strata = strataOf(rows);
  const nouns = { noun: t.noun, nouns: t.nounPlural };
  const pools = [
    `${NAMING_LABEL.held}: ${counts(t, held.figures)}, ${usd(held.figures.spentUsd)} spent, over ${held.versions} template versions whose prompt tells the model never to name the client or give its website.`,
    `${NAMING_LABEL.named}: ${counts(t, named.figures)}, ${usd(named.figures.spentUsd)} spent, over ${named.versions} template versions whose prompt tells the model to name the client, some with a link to its website.`,
    ...(input.silentPeople > 0 ? [`${n(input.silentPeople)} ${t.exposureNoun} from templates whose prompt says neither (or whose text is not on record) are left out.`] : []),
    ...(input.bothTemplates.length ? [`Left out, their prompt says both: ${input.bothTemplates.join(", ")}.`] : []),
    `The two sides ran for different clients, audiences and months: this is not a split test.`,
  ];
  const out: ResearchStudy[] = [];
  const measured = held.figures.contacted > 0 && named.figures.contacted > 0;
  const rate = (b: ResearchBucket) => (b.figures.contacted > 0 ? (100 * b.figures.outcomes) / b.figures.contacted : 0);
  // rate
  {
    const [a, b] = [...rows].sort((x, y) => rate(y) - rate(x));
    const pv = measured ? rateP(exposure(held), exposure(named)) : 1;
    const v = measured
      ? compareVerdict({ a: { label: a!.label, outcomes: a!.figures.outcomes, exposure: a!.figures.contacted, spend: a!.figures.spentUsd }, b: { label: b!.label, outcomes: b!.figures.outcomes, exposure: b!.figures.contacted, spend: b!.figures.spentUsd }, goal: "rate", comparisons: 1, strata, ...nouns })
      : { kind: "noise" as const, reason: "One side reached nobody yet: nothing to compare." };
    const headline = measured
      ? `${a!.label} wins: a ${pctText(rate(a!))} ${t.noun} rate, against ${pctText(rate(b!))} ${WITH[sideOf(b!)]} (p ${pTextShort(pv)}).`
      : `Not enough data on both sides yet.`;
    out.push({
      id: `${t.pipe}-naming-rate`,
      pipe: t.pipe,
      topic: "naming",
      goal: "rate",
      question: `Does naming the client get more ${t.nounPlural}?`,
      status: measured ? "measured" : "not_enough_data",
      headline: measured ? headlineFor(headline, v.kind) : headline,
      winner: measured ? a!.label : null,
      result: measured
        ? { display: pctText(rate(a!)), unit: `${WITH[sideOf(a!)]}, ${pctText(rate(b!))} ${WITH[sideOf(b!)].replace("with the client ", "")}`, sample: `p ${pTextShort(pv)}, ${n(held.figures.contacted + named.figures.contacted)} ${t.exposureNoun}` }
        : null,
      crowned: v.kind === "conclusion",
      verdict: { kind: v.kind, reason: v.reason },
      charts: [{ kind: "bars", title: rateTitle(t), lowerIsBetter: false, points: rateBars(t, rows), note: t.note }],
      conclusion: [...pools, `The p-value asks whether ${t.nounPlural} per person differ between the two sides.`],
    });
  }
  // cost
  {
    const priced = pricedSorted(rows);
    const [a, b] = priced;
    const pv = measured ? costP(exposure(held), exposure(named)) : 1;
    const v = a && b
      ? compareVerdict({ a: { label: a.label, outcomes: a.figures.outcomes, exposure: a.figures.contacted, spend: a.figures.spentUsd }, b: { label: b.label, outcomes: b.figures.outcomes, exposure: b.figures.contacted, spend: b.figures.spentUsd }, goal: "roi", comparisons: 1, strata, ...nouns })
      : { kind: "noise" as const, reason: priced.length ? `Only one side has earned a ${t.noun}.` : `Neither side has earned a ${t.noun} yet.` };
    const cost = (x: ResearchBucket) => x.figures.spentUsd / x.figures.outcomes;
    const headline = !a
      ? `Neither side has earned a ${t.noun} yet.`
      : b
        ? `${a.label} wins at ${usd(cost(a))} per ${t.noun}, against ${usd(cost(b))} ${WITH[sideOf(b)]} (p ${pTextShort(pv)}).`
        : `${a.label} wins at ${usd(cost(a))} per ${t.noun}; no ${t.noun} yet ${WITH[sideOf(a) === "held" ? "named" : "held"]} (p ${pTextShort(pv)}).`;
    out.push({
      id: `${t.pipe}-naming-roi`,
      pipe: t.pipe,
      topic: "naming",
      goal: "roi",
      question: `Does naming the client get a cheaper ${t.noun}?`,
      status: a ? "measured" : "not_enough_data",
      headline: a ? headlineFor(headline, v.kind) : headline,
      winner: a ? a.label : null,
      result: a
        ? { display: usd(cost(a)), unit: `per ${t.noun} ${WITH[sideOf(a)]}${b ? `, ${usd(cost(b))} ${WITH[sideOf(b)].replace("with the client ", "")}` : ""}`, sample: `p ${pTextShort(pv)}, ${n(held.figures.outcomes + named.figures.outcomes)} ${t.nounPlural}` }
        : null,
      crowned: v.kind === "conclusion",
      verdict: { kind: v.kind, reason: v.reason },
      charts: [{ kind: "bars", title: costTitle(t), lowerIsBetter: true, points: costBars(t, rows), note: t.note }],
      conclusion: [
        ...pools,
        ...(held.figures.contacted > 0 && named.figures.contacted > 0
          ? [`Reaching one person cost ${usd(held.figures.spentUsd / held.figures.contacted)} ${WITH.held}, ${usd(named.figures.spentUsd / named.figures.contacted)} ${WITH.named}.`]
          : []),
        `The p-value asks whether ${t.nounPlural} per dollar spent differ between the two sides.`,
      ],
    });
  }
  return out;
}
