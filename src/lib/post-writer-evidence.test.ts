import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { postWriterBars, type PostGeneration, type RunCredit } from "./post-writer-evidence.js";
import { generationsOfPipe, ledgerCredits, type FeedGeneration, type Occurrence } from "./post-writer-evidence-io.js";
import { rankWriters, type WriterCandidate } from "./leg-writer-ranking.js";

const LEG = "start_to_post_published";
const gen = (id: string, runId: string | null, tpl: string | null, model = "claude-haiku", createdAt = "2026-10-30T10:00:00Z"): PostGeneration => ({
  generationId: id,
  createdAt,
  runId,
  templateDynasty: tpl ? { slug: tpl, name: tpl.toUpperCase() } : null,
  model,
});
const credit = (c: Partial<RunCredit>): RunCredit => ({ spentUsd: 0, published: true, views: 0, engagements: 0, visits: 0, signups: 0, ...c });
const llmOf = (m: string) => ({ key: m.startsWith("claude-haiku") ? "claude-haiku" : m, label: m });

describe("post writer evidence (THREADS-IDEAS-AB): each post filed under what wrote it, ranked on signups", () => {
  it("pools a dynasty's posts: spend, views, engagements, visits, signups, cost per signup", () => {
    const credits: Record<string, RunCredit> = {
      r1: credit({ spentUsd: 0.1, views: 120, engagements: 4, visits: 2, signups: 1 }),
      r2: credit({ spentUsd: 0.3, views: 30, engagements: 1 }),
      r3: credit({ spentUsd: 0.05, published: false }),
    };
    const out = postWriterBars([gen("g1", "r1", "hook"), gen("g2", "r2", "hook", "gemini-3-flash"), gen("g3", "r3", "story")], (r) => credits[r]!, llmOf, LEG, null);
    const hook = out.templates.find((b) => b.key === "hook")!;
    expect(hook.postFigures).toEqual({ posts: 2, views: 150, engagements: 5, visits: 2, signups: 1, spentUsd: 0.4, costPerSignupUsd: 0.4 });
    // The ranking reads posts as exposure and SIGNUPS as the outcome, never views.
    expect(hook.figures).toEqual({ spentUsd: 0.4, contacted: 2, outcomes: 1 });
    expect(hook.basis).toBe("flash");
    // A run that never published still spent: its money counts, it is no post.
    expect(out.templates.find((b) => b.key === "story")!.postFigures).toMatchObject({ posts: 0, spentUsd: 0.05, costPerSignupUsd: null });
    expect(out.llms.map((b) => [b.key, b.postFigures.posts]).sort()).toEqual([
      ["claude-haiku", 1],
      ["gemini-3-flash", 1],
    ]);
  });

  it("one run = one post: a retry's latest generation is the writer, its money is counted once", () => {
    const out = postWriterBars([gen("g1", "r1", "old", "claude-haiku", "2026-10-30T10:00:00Z"), gen("g2", "r1", "new", "claude-haiku", "2026-10-30T10:01:00Z")], () => credit({ spentUsd: 1 }), llmOf, LEG, null);
    expect(out.templates.map((b) => [b.key, b.postFigures.spentUsd])).toEqual([["new", 1]]);
    expect(out.runs).toBe(1);
  });

  it("a generation with no template dynasty is left out of the template bars, kept on its LLM", () => {
    const out = postWriterBars([gen("g1", "r1", null)], () => credit({ spentUsd: 1, signups: 1 }), llmOf, LEG, null);
    expect(out.templates).toEqual([]);
    expect(out.leftOut.templates).toEqual({ contacted: 1, outcomes: 1 });
    expect(out.llms[0]!.postFigures.signups).toBe(1);
  });

  it("mature on the leg's bar (10 signups on a 0-day leg)", () => {
    const gens = Array.from({ length: 10 }, (_, i) => gen(`g${i}`, `r${i}`, "hook"));
    const out = postWriterBars(gens, () => credit({ spentUsd: 1, signups: 1 }), llmOf, LEG, null);
    expect(out.templates[0]!.basis).toBe("mature");
  });
});

describe("post pipe membership and ledger credits", () => {
  const feed = (workflowSlug: string | null, featureSlug = "threads-post"): FeedGeneration => ({ ...gen(workflowSlug ?? "x", "r", "hook"), orgId: "o", campaignId: "c", workflowSlug, featureSlug });
  it("a generation is on the pipe its workflow dynasty is assigned on (longest dynasty wins), never on a slug literal", () => {
    const assignments = [
      { featureSlug: "threads-post", legKey: LEG, workflowDynastySlug: "threads-post-maasym" },
      { featureSlug: "threads-post", legKey: "other_leg", workflowDynastySlug: "threads-post" },
    ];
    const gens = [feed("threads-post-maasym-v2"), feed("threads-post-v3"), feed(null), feed("threads-post-maasym", "social-post")];
    expect(generationsOfPipe(gens, assignments, "threads-post", LEG).map((g) => g.workflowSlug)).toEqual(["threads-post-maasym-v2"]);
    expect(generationsOfPipe(gens, assignments, "threads-post", "other_leg").map((g) => g.workflowSlug)).toEqual(["threads-post-v3"]);
  });

  it("a visit consuming the post, then a signup consuming that visit, credit the run that published it", () => {
    const occ = (o: Partial<Occurrence> & Pick<Occurrence, "id" | "runId" | "direction" | "outcomeKey">): Occurrence => ({ subjectService: "x", subjectId: "y", consumption: null, ...o });
    const cons = (src: string, into: string) => ({ sourceOccurrenceId: src, consumingOutcomes: [{ outcomeKey: into }] });
    const out = ledgerCredits(
      ["pub1", "pub2"],
      [occ({ id: "post1", runId: "pub1", direction: "produced", outcomeKey: "post_published" })],
      [
        occ({ id: "c1", runId: "visitA", direction: "consumed", outcomeKey: "post_published", consumption: cons("post1", "website_visit") }),
        occ({ id: "c2", runId: "visitB", direction: "consumed", outcomeKey: "post_published", consumption: cons("post1", "website_visit") }),
        // A social-service view of the post is no visit.
        occ({ id: "c3", runId: "viewed", direction: "consumed", outcomeKey: "post_published", consumption: cons("post1", "post_viewed") }),
      ],
      [occ({ id: "vA", runId: "visitA", direction: "produced", outcomeKey: "website_visit" }), occ({ id: "vB", runId: "visitB", direction: "produced", outcomeKey: "website_visit" })],
      [
        occ({ id: "s1", runId: "signup1", direction: "consumed", outcomeKey: "website_visit", consumption: cons("vA", "signup") }),
        // The same visit consumed twice by signups (a replay) is one signup; a visit consumed by a form is none.
        occ({ id: "s2", runId: "signup2", direction: "consumed", outcomeKey: "website_visit", consumption: cons("vA", "signup") }),
        occ({ id: "s3", runId: "form", direction: "consumed", outcomeKey: "website_visit", consumption: cons("vB", "form_submitted") }),
      ],
    );
    expect(out.get("pub1")).toEqual({ published: true, visits: 2, signups: 1 });
    expect(out.get("pub2")).toEqual({ published: false, visits: 0, signups: 0 });
  });
});

/**
 * EXPLORATION, worked (THREADS-IDEAS-AB): the learning rule IS the exploration. Six template dynasties, one with 20
 * posts, $4 spent and no signup, five brand new; signups are the outcome, the leg's bar is 10 (never reached here), so
 * every dynasty is LEARNING and stands on spend ÷ max(signups, 1).
 */
describe("writer-pick explores post writers in turn (rankWriters, outcome = signup)", () => {
  const tpl = (key: string, spentUsd: number, signups: number, posts = 0): WriterCandidate => ({
    key,
    label: key,
    selectable: true,
    notSelectableReason: null,
    basis: "flash",
    figures: { spentUsd, contacted: posts, outcomes: signups },
  });
  const order = (cs: WriterCandidate[]) => rankWriters(cs).rows.map((r) => r.key);

  it("a brand-new dynasty ($0, never used) is picked before the one that spent $4 with no signup", () => {
    const cs = [tpl("veteran", 4, 0, 20), tpl("new-a", 0, 0), tpl("new-b", 0, 0), tpl("new-c", 0, 0), tpl("new-d", 0, 0), tpl("new-e", 0, 0)];
    expect(rankWriters(cs).best?.key).toBe("new-a");
    expect(order(cs).at(-1)).toBe("veteran");
  });

  it("once each has spent and none signed anyone up, the least-spent goes next", () => {
    const cs = [tpl("veteran", 4, 0, 20), tpl("new-a", 0.4, 0, 2), tpl("new-b", 0.2, 0, 1), tpl("new-c", 0.6, 0, 3), tpl("new-d", 0.3, 0, 1), tpl("new-e", 0.5, 0, 2)];
    expect(order(cs)).toEqual(["new-b", "new-d", "new-a", "new-e", "new-c", "veteran"]);
  });

  it("a dynasty at $2 per signup (1 signup) stays ahead of a learning one only once that one spent more than $2", () => {
    expect(order([tpl("one-signup", 2, 1, 10), tpl("learning", 1.5, 0, 8)])).toEqual(["learning", "one-signup"]);
    expect(order([tpl("one-signup", 2, 1, 10), tpl("learning", 2.5, 0, 12)])).toEqual(["one-signup", "learning"]);
  });

  it("the same rule for LLM dynasties", () => {
    const llm = (key: string, spentUsd: number, signups: number) => ({ ...tpl(key, spentUsd, signups), label: key });
    expect(rankWriters([llm("claude-haiku", 4, 0), llm("gemini-3-flash", 0, 0)]).best?.key).toBe("gemini-3-flash");
    expect(order([llm("claude-haiku", 4, 0), llm("gemini-3-flash", 1, 0), llm("deepseek-flash", 2, 1)])).toEqual(["gemini-3-flash", "deepseek-flash", "claude-haiku"]);
  });
});
