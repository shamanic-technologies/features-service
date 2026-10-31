/**
 * THE WRITER EVIDENCE OF A PIPE WHOSE WRITER RECORDS POSTS (THREADS-IDEAS-AB, owner 2026-10-31). Pure: the IO is
 * `lib/post-writer-evidence-io.ts`.
 *
 * A post writer records no person and no sequence (content-generation-service's `/internal/thread-generations` states one
 * row per post written: its run, its template dynasty, its model), so the sequence path read `no_sequence_recorded_on_pipe`
 * and the pick stayed on rank 1 forever. Here each RUN (one post) is filed under the template dynasty and the LLM dynasty
 * that wrote it (its latest generation), and carries what the ledger credits to it:
 *   - spend = the run's whole subtree cost (writing call, web reads, the publish), billed basis, published or not;
 *   - posts = the run produced `post_published`;
 *   - views / engagements = social-service's latest counts of that post;
 *   - visits = `website_visit` occurrences consuming that `post_published`;
 *   - signups = signups credited on those visits (a consumption of the visit occurrence by a signup).
 * The ranking's outcome is the SIGNUP (the campaign target), never views: `rankWriters` reads spend + signups, so a
 * template is never ranked on views. Pooled per dynasty across versions (the key is the dynasty). Maturity = the leg's rule.
 */
import { isMatureCount } from "./maturity.js";

/** LOCKED (the dashboard codes against it): what a writer row's posts led to, everything to date. */
export interface PostFigures {
  posts: number;
  views: number;
  engagements: number;
  visits: number;
  signups: number;
  spentUsd: number;
  costPerSignupUsd: number | null;
}

export const ZERO_POST_FIGURES: PostFigures = { posts: 0, views: 0, engagements: 0, visits: 0, signups: 0, spentUsd: 0, costPerSignupUsd: null };

/** One post generation of the pipe (content-generation's contract, the fields read here). */
export interface PostGeneration {
  generationId: string;
  createdAt: string;
  runId: string | null;
  templateDynasty: { slug: string; name: string } | null;
  model: string;
}

/** What the ledger credits to one writing run. */
export interface RunCredit {
  spentUsd: number;
  published: boolean;
  views: number;
  engagements: number;
  visits: number;
  signups: number;
}

export interface PostWriterBar {
  key: string;
  label: string;
  basis: "mature" | "flash";
  /** What the ranking reads: contacted = posts, outcomes = signups (on `basis`). */
  figures: { spentUsd: number; contacted: number; outcomes: number };
  postFigures: PostFigures;
}

export interface PostWriterBars {
  templates: PostWriterBar[];
  llms: PostWriterBar[];
  /** Runs whose writer is not on record (no template dynasty / no run id): left out of every bar. */
  leftOut: { templates: { contacted: number; outcomes: number }; llms: { contacted: number; outcomes: number } };
  /** Writing runs read (one post each). */
  runs: number;
}

type Acc = { label: string; flash: PostFigures; mature: PostFigures };

const add = (a: PostFigures, c: RunCredit): void => {
  a.spentUsd += c.spentUsd;
  a.posts += c.published ? 1 : 0;
  a.views += c.views;
  a.engagements += c.engagements;
  a.visits += c.visits;
  a.signups += c.signups;
};

const done = (f: PostFigures): PostFigures => ({ ...f, costPerSignupUsd: f.signups > 0 ? f.spentUsd / f.signups : null });

/**
 * PURE. One bar per template dynasty and per LLM dynasty. `llmOf(model)` = chat-service's dynasty of the model (key +
 * label, the ranking's placement). A run's writer = its LATEST generation (a retry re-writes the same post). Mature = the
 * leg's rule: on a leg that waits N days only runs written before `cutoffIso` count; a bar whose mature signups reach the
 * leg's bar is read on them, else on everything to date (Learning).
 */
export function postWriterBars(
  generations: readonly PostGeneration[],
  creditOf: (runId: string) => RunCredit,
  llmOf: (model: string) => { key: string; label: string },
  legKey: string,
  cutoffIso: string | null,
): PostWriterBars {
  const latest = new Map<string, PostGeneration>();
  let noRun = 0;
  for (const g of generations) {
    if (!g.runId) {
      noRun += 1;
      continue;
    }
    const prev = latest.get(g.runId);
    if (!prev || prev.createdAt < g.createdAt || (prev.createdAt === g.createdAt && prev.generationId < g.generationId)) latest.set(g.runId, g);
  }
  const tpl = new Map<string, Acc>();
  const llm = new Map<string, Acc>();
  const leftOut = { templates: { contacted: noRun, outcomes: 0 }, llms: { contacted: noRun, outcomes: 0 } };
  const fresh = (label: string): Acc => ({ label, flash: { ...ZERO_POST_FIGURES }, mature: { ...ZERO_POST_FIGURES } });
  for (const [runId, g] of latest) {
    const c = creditOf(runId);
    const inMature = !cutoffIso || g.createdAt < cutoffIso;
    const file = (by: Map<string, Acc>, key: string, label: string) => {
      const a = by.get(key) ?? fresh(label);
      add(a.flash, c);
      if (inMature) add(a.mature, c);
      by.set(key, a);
    };
    if (g.templateDynasty) file(tpl, g.templateDynasty.slug, g.templateDynasty.name);
    else {
      leftOut.templates.contacted += c.published ? 1 : 0;
      leftOut.templates.outcomes += c.signups;
    }
    const l = llmOf(g.model);
    file(llm, l.key, l.label);
  }
  const bars = (by: Map<string, Acc>): PostWriterBar[] =>
    [...by].map(([key, a]) => {
      const mature = isMatureCount(a.mature.signups, legKey) === true && a.mature.spentUsd > 0;
      const f = mature ? a.mature : a.flash;
      return { key, label: a.label, basis: mature ? "mature" : "flash", figures: { spentUsd: f.spentUsd, contacted: f.posts, outcomes: f.signups }, postFigures: done(a.flash) };
    });
  return { templates: bars(tpl), llms: bars(llm), leftOut, runs: latest.size };
}
