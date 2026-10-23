/**
 * EVERY PIPE ON THE RESEARCH PAGE (WA-PIPE-RESEARCH-1023, owner 2026-10-23: « add a section for this pipe with all the
 * business pages »). Pure. The three studied pipes keep their studies; every other pipe of the channel catalogue holding
 * a workflow assignment is listed after them, read from the catalogue (never a list of pipe ids), and served the same
 * Workflows / Templates / Models / Performance tabs from the same evidence. A pipe with nothing measured yet reads
 * Learning on every tab, never zero, never hidden.
 */
import { pipeLegKeyOf, servedLegKeyOf } from "../funnel-legs.js";
import type { PipeTerms } from "./studies.js";
import type { ResearchPipeEntry } from "./types.js";

export interface OtherPipe {
  entry: ResearchPipeEntry;
  featureSlug: string;
  /** The leg as computed on (stored spelling). */
  legKey: string;
  /** The step the pipe lands on (the leg's `to` key): the outcome sections list the pipes landing on their step. */
  toStep: string;
}

export interface CatalogueChannelLike {
  slug: string;
  shortDescription: string;
  stepTransitions: ReadonlyArray<{ legKey: string; to: { key: string; label: string } }>;
}

/**
 * PURE. Every (channel, leg) of the published catalogue holding at least one workflow assignment row (any state), minus
 * the studied pipes (matched on channel + served leg). Catalogue order. A `your-team-*` pipe holds no workflow: never listed.
 */
export function otherPipesOf(
  channels: readonly CatalogueChannelLike[],
  assignments: ReadonlyArray<{ featureSlug: string; legKey: string }>,
  studied: readonly Pick<ResearchPipeEntry, "channel" | "leg">[],
): OtherPipe[] {
  const assigned = new Set(assignments.map((a) => `${a.featureSlug}|${pipeLegKeyOf(a.featureSlug, a.legKey)}`));
  const skip = new Set(studied.map((p) => `${p.channel}|${servedLegKeyOf(p.channel, p.leg)}`));
  const out: OtherPipe[] = [];
  const seen = new Set<string>();
  for (const c of channels) {
    for (const t of c.stepTransitions) {
      const legKey = pipeLegKeyOf(c.slug, t.legKey);
      const served = servedLegKeyOf(c.slug, legKey);
      // The catalogue pipe id (`pipeIdOf`, lib/agent-catalogue.ts): the id `/public/channels` and the writer ranking serve.
      const id = `${c.slug}|${served}`;
      if (seen.has(id) || skip.has(id) || !assigned.has(`${c.slug}|${legKey}`)) continue;
      seen.add(id);
      out.push({ entry: { id, channel: c.slug, leg: served, outcome: t.to.label, description: c.shortDescription }, featureSlug: c.slug, legKey, toStep: t.to.key });
    }
  }
  return out;
}

/** PURE. "signup" -> "signups", "positive reply" -> "positive replies", "meeting booked" -> "meetings booked". */
export function pluralOf(noun: string): string {
  const words = noun.split(" ");
  const last = words[words.length - 1] ?? "";
  // A participle closes the phrase ("meeting booked", "lead found"): the noun before it takes the plural.
  const at = words.length > 1 && (/ed$/.test(last) || last === "found") ? words.length - 2 : words.length - 1;
  const w = words[at] ?? "";
  words[at] = /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : /(s|x|ch|sh)$/.test(w) ? `${w}es` : `${w}s`;
  return words.join(" ");
}

/** PURE. The words a pipe's tabs speak in: its outcome (the leg's `to` step), counted over the people it reached. */
export function otherPipeTerms(entry: ResearchPipeEntry, rule: { durationDays: number; outcomesRequired: number }, cutoffDay: string | null): PipeTerms {
  const noun = entry.outcome.toLowerCase();
  const nounPlural = pluralOf(noun);
  const wait = rule.durationDays > 0 ? ` on runs started at least ${rule.durationDays} days before the read` : "";
  return {
    pipe: entry.id,
    noun,
    nounPlural,
    exposureNoun: "people reached",
    exposureNounOne: "person reached",
    outcomesRequired: rule.outcomesRequired,
    partialMonth: cutoffDay && cutoffDay.slice(8, 10) !== "01" ? cutoffDay.slice(0, 7) : null,
    note:
      `A bar reads the people this pipe's campaigns reached and the ${nounPlural} they brought since. A figure needs ` +
      `${rule.outcomesRequired} ${rule.outcomesRequired === 1 ? noun : nounPlural}${wait} behind it; below that it reads Learning, ` +
      `the rule the Workflows page applies. A rate is per person reached.`,
  };
}
