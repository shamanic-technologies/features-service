import { describe, expect, it, vi } from "vitest";
vi.mock("../../db/index.js", () => ({ db: {}, sql: {} }));
import type { SlugCell } from "./buckets.js";
import { generationBuckets, generationStudies, type GenerationsInput } from "./generations.js";
import { pipeCatalog } from "./catalog.js";
import { dynastyLegKeyOf, dynastyStatusOf, templateDynastyIndex, type TemplateDynasty } from "./template-dynasties.js";

// TPL-DYNASTY-1021-FS2: a Research template page is a template DYNASTY, its versions pooled.

const terms = {
  pipe: "cold-email-positive-reply" as const,
  noun: "positive reply",
  nounPlural: "positive replies",
  exposureNoun: "people emailed",
  exposureNounOne: "person emailed",
  outcomesRequired: 1,
  partialMonth: null,
  note: "rule",
};
const half = (spentUsd: number, contacted: number, outcomes: number) => ({
  figures: { spentUsd, contacted, outcomes },
  months: { "2026-09": { spentUsd, contacted, outcomes } },
  strata: { "o1|2026-09": { spentUsd, contacted, outcomes } },
});
const gen = (promptType: string) => ({ model: "gemini-3.5-flash", promptType, layout: "double_line_breaks", opening: "greeting", dash: "none" });
const pb = (slug: string, tpl: string, contacted: number, replies: number) => ({
  orgId: "o1", brandId: "b1", campaignId: "c1", country: null, workflowSlug: slug, servedDay: "2026-09-10", contacted, clicked: 0, positiveReplies: replies, screenedContacted: 0, humanClicked: 0, generation: gen(tpl),
});

const BLIND_FREE_OFFER: TemplateDynasty = {
  slug: "cold-reply-free-offer-blind",
  name: "Blind Free Offer",
  description: "Gets a reply by offering the prospect something free from your list, like an audit or a benchmark, while keeping your brand private.",
  signature: "free-offer|blind",
  identity: "blind",
  head: "blind-discovery-email-v47",
  versions: ["blind-discovery-email-v40", "blind-discovery-email-v41", "blind-discovery-email-v47"],
  status: "active",
  statusSource: "all_versions_deprecated",
  versionStatuses: { "blind-discovery-email-v40": "deprecated", "blind-discovery-email-v41": "deprecated", "blind-discovery-email-v47": "active" },
};
const PAIN_QUESTION: TemplateDynasty = { slug: "cold-reply-pain-question-blind", name: "Pain Question", description: "Asks.", signature: null, identity: "blind", head: "blind-discovery-email-v4", versions: ["blind-discovery-email-v4"], status: "deprecated", statusSource: "all_versions_deprecated", versionStatuses: { "blind-discovery-email-v4": "deprecated" } };

// Two workflow versions; v40 and v41 (one dynasty) and cold-email-v35 (no dynasty) wrote their people.
const cells: SlugCell[] = [
  { slug: "azalea-v1", flash: half(400, 400, 8), mature: half(300, 300, 6) },
  { slug: "azalea-v2", flash: half(100, 200, 1), mature: half(100, 200, 1) },
];
const persons = [
  pb("azalea-v1", "blind-discovery-email-v40", 200, 5),
  pb("azalea-v1", "blind-discovery-email-v41", 100, 0),
  pb("azalea-v1", "cold-email-v35", 100, 3),
  pb("azalea-v2", "blind-discovery-email-v41", 200, 1),
];
const input = (dynasties: readonly TemplateDynasty[] | "template_dynasties_unreadable"): GenerationsInput => ({
  terms,
  legKey: "start_to_conversation",
  cells,
  persons,
  split: { screened: false, signal: "positiveReply", cutoffDay: "2026-09-27" },
  models: new Map([["gemini-3.5-flash", { label: "Gemini 3.5 Flash", tier: "Flash" as const }]]),
  templateTexts: new Map(),
  naming: false,
  templateDynasties: templateDynastyIndex(dynasties),
});

describe("template dynasties on the Research pages", () => {
  it("asks content-generation-service on the wave-2 leg spelling", () => {
    expect(dynastyLegKeyOf("sales-cold-email-outreach", "start_to_conversation")).toBe("lead_found_to_conversation");
    expect(dynastyLegKeyOf("sales-cold-email-outreach", "start_to_website_visit")).toBe("lead_found_to_website_visit");
    // every other leg is asked verbatim (WA-PIPE-RESEARCH-1023: Cold WhatsApp's Start -> Signup has its own dynasty)
    expect(dynastyLegKeyOf("cold-whatsapp-outreach", "start_to_signup")).toBe("start_to_signup");
    expect(dynastyLegKeyOf("cold-whatsapp-outreach", "lead_found_to_conversation")).toBe("lead_found_to_conversation");
  });

  it("pools every version into its dynasty's bar; the versions add up to it exactly, on its basis", () => {
    const { tpl, tplVersions } = generationBuckets(input([BLIND_FREE_OFFER, PAIN_QUESTION]));
    expect(tpl.rows.map((r) => [r.key, r.label]).sort()).toEqual([
      ["cold-email-v35", "Cold email v35"],
      ["cold-reply-free-offer-blind", "Blind Free Offer"],
    ]);
    const bar = tpl.rows.find((r) => r.key === "cold-reply-free-offer-blind")!;
    const vs = tplVersions.filter((v) => BLIND_FREE_OFFER.versions.includes(v.key));
    expect(vs.map((v) => v.key).sort()).toEqual(["blind-discovery-email-v40", "blind-discovery-email-v41"]);
    // v41 alone has 1 mature reply... the dynasty reads mature, and so does every version (never its own basis).
    expect(bar.basis).toBe("mature");
    expect(vs.every((v) => v.basis === bar.basis)).toBe(true);
    for (const k of ["spentUsd", "contacted", "outcomes"] as const) {
      expect(vs.reduce((a, v) => a + v.figures[k], 0)).toBeCloseTo(bar.figures[k], 9);
    }
  });

  it("a version read on its dynasty's basis even when its own count would read flash", () => {
    const one: SlugCell[] = [{ slug: "azalea-v1", flash: half(400, 400, 8), mature: half(300, 300, 6) }];
    const p = [pb("azalea-v1", "blind-discovery-email-v40", 200, 5), pb("azalea-v1", "blind-discovery-email-v41", 200, 0)];
    const { tplVersions } = generationBuckets({ ...input([BLIND_FREE_OFFER]), cells: one, persons: p });
    expect(tplVersions.find((v) => v.key === "blind-discovery-email-v41")!.basis).toBe("mature");
  });

  it("the template study's bars are the dynasties", () => {
    const study = generationStudies(input([BLIND_FREE_OFFER])).find((s) => s.id === "cold-email-positive-reply-template-roi")!;
    expect(study.charts[0]!.points.map((p) => p.key).sort()).toEqual(["cold-email-v35", "cold-reply-free-offer-blind"]);
  });

  it("serves one page per dynasty, named and described as it, with its versions inspectable; a version on its own says so", () => {
    const dyn = templateDynastyIndex([BLIND_FREE_OFFER, PAIN_QUESTION]);
    const g = generationBuckets(input([BLIND_FREE_OFFER, PAIN_QUESTION]));
    const c = pipeCatalog({
      terms,
      workflows: [{ key: "azalea", label: "Azalea", basis: "mature", figures: { spentUsd: 400, contacted: 500, outcomes: 7 }, learning: false, months: null, strata: null }],
      templates: g.tpl.rows,
      templateVersions: g.tplVersions,
      templateDynasties: dyn,
      models: [],
      nameOf: () => null,
      mainOf: () => ({ model: null, template: "cold-reply-free-offer-blind" }),
      modelLabel: (id) => id,
      dynastyOf: (s) => s.replace(/-v\d+$/, ""),
      workflowRuns: [],
      generationRuns: [{ createdAt: "2026-10-18T10:00:00Z", model: "gemini-3.5-flash", promptType: "blind-discovery-email-v41", workflowSlug: "azalea-v2" }],
      templateTexts: new Set(["blind-discovery-email-v47"]),
      runnableWorkflows: null,
      writerOf: () => ({ ok: true, workflowSlug: "azalea-v2", version: 2, template: "blind-discovery-email-v47", modelAlias: "pro", model: { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" } }),
    });
    const page = c.templates.find((t) => t.key === "cold-reply-free-offer-blind")!;
    expect(page.label).toBe("Blind Free Offer");
    expect(page.dynasty).toEqual({
      slug: "cold-reply-free-offer-blind",
      name: "Blind Free Offer",
      description: BLIND_FREE_OFFER.description,
      signature: "free-offer|blind",
      identity: "blind",
      head: { key: "blind-discovery-email-v47", label: "Blind discovery v47" },
    });
    expect(page.standaloneReason).toBeNull();
    expect(page.hasText).toBe(true);
    expect(page.versions.map((v) => [v.key, v.head, v.emails])).toEqual([
      ["blind-discovery-email-v40", false, "150"],
      ["blind-discovery-email-v41", false, "275"],
      ["blind-discovery-email-v47", true, "0"],
    ]);
    expect(page.emails).toBe("425");
    expect(page.runs.map((r) => r.templateVersion)).toEqual(["blind-discovery-email-v41"]);
    expect(page.workflows).toEqual([{ key: "azalea", label: "Azalea" }]);
    // Every dynasty of the pipe has its page, empty until a version writes.
    const empty = c.templates.find((t) => t.key === "cold-reply-pain-question-blind")!;
    expect([empty.label, empty.emails, empty.versions.length]).toEqual(["Pain Question", "0", 1]);
    const alone = c.templates.find((t) => t.key === "cold-email-v35")!;
    expect([alone.dynasty, alone.standaloneReason, alone.versions]).toEqual([null, "no_dynasty_on_pipe", []]);
    // The workflow page names the template DYNASTY it writes with, and the version.
    expect(c.workflows[0]!.writesWithNow!.template).toEqual({
      key: "cold-reply-free-offer-blind",
      label: "Blind Free Offer",
      linked: true,
      version: { key: "blind-discovery-email-v47", label: "Blind discovery v47" },
    });
    expect(c.workflows[0]!.template).toEqual({ key: "cold-reply-free-offer-blind", label: "Blind Free Offer", linked: true });
  });

  it("dynasties unreadable: every version keeps its own page, said so", () => {
    const g = generationBuckets(input("template_dynasties_unreadable"));
    expect(g.tpl.rows.map((r) => r.key).sort()).toEqual(["blind-discovery-email-v40", "blind-discovery-email-v41", "cold-email-v35"]);
    const c = pipeCatalog({
      terms,
      workflows: [],
      templates: g.tpl.rows,
      templateVersions: g.tplVersions,
      templateDynasties: templateDynastyIndex("template_dynasties_unreadable"),
      models: [],
      nameOf: () => null,
      mainOf: () => ({ model: null, template: null }),
      modelLabel: (id) => id,
      dynastyOf: (s) => s,
      workflowRuns: [],
      generationRuns: [],
      templateTexts: new Set(),
      runnableWorkflows: null,
      writerOf: "workflow_definitions_unreadable",
    });
    expect(new Set(c.templates.map((t) => t.standaloneReason))).toEqual(new Set(["template_dynasties_unreadable"]));
  });

  it("a post pipe (THREADS-IDEAS-AB): template pages stand in the writer ranking's order and carry postFigures; null elsewhere", () => {
    const dyn = templateDynastyIndex([BLIND_FREE_OFFER, PAIN_QUESTION]);
    const base = {
      terms,
      workflows: [],
      templates: [],
      templateDynasties: dyn,
      models: [],
      nameOf: () => null,
      mainOf: () => ({ model: null, template: null }),
      modelLabel: (id: string) => id,
      dynastyOf: (s: string) => s,
      workflowRuns: [],
      generationRuns: [],
      templateTexts: new Set<string>(),
      runnableWorkflows: null,
      writerOf: "workflow_definitions_unreadable" as const,
    };
    expect(pipeCatalog(base).templates.every((t) => t.postFigures === null)).toBe(true);
    const pf = { posts: 20, views: 900, engagements: 31, visits: 3, signups: 0, spentUsd: 4, costPerSignupUsd: null };
    const c = pipeCatalog({ ...base, postWriters: { templates: [{ key: "cold-reply-pain-question-blind", postFigures: null }, { key: "cold-reply-free-offer-blind", postFigures: pf }], models: [] } });
    expect(c.templates.map((t) => [t.key, t.rank])).toEqual([
      ["cold-reply-pain-question-blind", 1],
      ["cold-reply-free-offer-blind", 2],
    ]);
    expect(c.templates[1]!.postFigures).toEqual(pf);
    expect(c.templates[0]!.postFigures).toEqual({ posts: 0, views: 0, engagements: 0, visits: 0, signups: 0, spentUsd: 0, costPerSignupUsd: null });
  });

  // TPL-DYNASTY-ROWS-1021-FS: ROI and status on every template row and version.
  it("a dynasty's status is content-generation-service's when served, else deprecated exactly when every version is", () => {
    expect(dynastyStatusOf("deprecated", [{ status: "active" }])).toEqual({ status: "deprecated", statusSource: "content_generation" });
    expect(dynastyStatusOf(undefined, [{ status: "deprecated" }, { status: "active" }])).toEqual({ status: "active", statusSource: "all_versions_deprecated" });
    expect(dynastyStatusOf(undefined, [{ status: "deprecated" }, { status: "deprecated" }])).toEqual({ status: "deprecated", statusSource: "all_versions_deprecated" });
    expect(dynastyStatusOf(undefined, [{ status: "deprecated" }, { status: null }])).toEqual({ status: null, statusSource: null });
    expect(dynastyStatusOf(undefined, [])).toEqual({ status: null, statusSource: null });
  });

  // ROI-CONSISTENCY-1103 (owner 2026-11-03): no Research page (workflow, template, version) serves a return.
  const catalogWith = (cs: SlugCell[] = cells, ps = persons, wfOutcomes = 7) => {
    const g = generationBuckets({ ...input([BLIND_FREE_OFFER, PAIN_QUESTION]), cells: cs, persons: ps });
    return pipeCatalog({
      terms,
      workflows: [{ key: "azalea", label: "Azalea", basis: "mature", figures: { spentUsd: 400, contacted: 500, outcomes: wfOutcomes }, learning: false, months: null, strata: null }],
      templates: g.tpl.rows,
      templateVersions: g.tplVersions,
      templateDynasties: templateDynastyIndex([BLIND_FREE_OFFER, PAIN_QUESTION]),
      models: [],
      nameOf: () => null,
      mainOf: () => ({ model: null, template: null }),
      modelLabel: (id) => id,
      dynastyOf: (s) => s.replace(/-v\d+$/, ""),
      workflowRuns: [],
      generationRuns: [],
      templateTexts: new Set(),
      runnableWorkflows: null,
      writerOf: () => ({ ok: true, workflowSlug: "azalea-v2", version: 2, template: "blind-discovery-email-v4", modelAlias: "pro", model: null }),
    });
  };

  it("template pages carry their status and versions, and no return on any page", () => {
    const cs: SlugCell[] = [{ slug: "azalea-v1", flash: half(400, 400, 8), mature: half(300, 300, 6) }];
    const ps = [pb("azalea-v1", "blind-discovery-email-v40", 300, 6), pb("azalea-v1", "blind-discovery-email-v41", 100, 2)];
    const c = catalogWith(cs, ps);
    const page = c.templates.find((t) => t.key === "cold-reply-free-offer-blind")!;
    expect([page.status, page.statusSource, page.statusUnavailableReason]).toEqual(["active", "all_versions_deprecated", null]);
    expect(page.versions.map((v) => v.status)).toEqual(["deprecated", "deprecated", "active"]);
    const keys = [c.workflows[0]!, page, ...page.versions].flatMap((x) => Object.keys(x));
    expect(keys.filter((k) => /roi/i.test(k))).toEqual([]);
  });

  it("rank states its basis: the cost per outcome", () => {
    const c = catalogWith();
    expect(new Set(c.templates.map((t) => t.rankBasis))).toEqual(new Set(["cost_per_outcome"]));
    expect(c.templates.find((t) => t.key === "cold-email-v35")!.statusUnavailableReason).toBe("no_dynasty");
  });

  it("TPL-DYNASTY-ONE-HOME-1021-FS: a generation under an original template counts for the dynasty of the pipe listing its copy", () => {
    // content-generation split cold-email-v35: this pipe's dynasty now holds the copy, past emails still carry the original.
    const CLICK: TemplateDynasty = {
      slug: "cold-click-website-click-named",
      name: "Website Click",
      description: "Clicks.",
      signature: null,
      identity: "named",
      head: "cold-email-website-visit-v35",
      versions: ["cold-email-website-visit-v35"],
      status: "active",
      statusSource: "content_generation",
      versionStatuses: { "cold-email-website-visit-v35": "active" },
      copiedFrom: { "cold-email-website-visit-v35": "cold-email-v35" },
    };
    const dyn = templateDynastyIndex([CLICK]);
    expect([dyn.keyOf("cold-email-v35"), dyn.versionOf("cold-email-v35"), dyn.dynastyOfVersion("cold-email-v35")?.slug]).toEqual([
      "cold-click-website-click-named",
      "cold-email-website-visit-v35",
      "cold-click-website-click-named",
    ]);
    const g = generationBuckets(input([CLICK]));
    expect(g.tpl.rows.map((r) => r.key)).not.toContain("cold-email-v35");
    const bar = g.tpl.rows.find((r) => r.key === "cold-click-website-click-named")!;
    const copy = g.tplVersions.find((v) => v.key === "cold-email-website-visit-v35")!;
    // Exactly what the original's own bar read before the split.
    const before = generationBuckets(input([])).tpl.rows.find((r) => r.key === "cold-email-v35")!;
    expect([bar.basis, bar.figures]).toEqual([before.basis, before.figures]);
    expect(copy.figures).toEqual(bar.figures);
    // A pipe listing the original itself keeps it as is (the conversation pipe is untouched).
    const both = templateDynastyIndex([CLICK, { ...PAIN_QUESTION, versions: ["cold-email-v35"], versionStatuses: { "cold-email-v35": "active" } }]);
    expect([both.keyOf("cold-email-v35"), both.versionOf("cold-email-v35")]).toEqual(["cold-reply-pain-question-blind", "cold-email-v35"]);
  });
});
