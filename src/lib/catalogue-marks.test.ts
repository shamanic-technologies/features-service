import { describe, expect, it } from "vitest";
import { GLYPH_COLORS, MARK_ICONS, MarkPoolExhaustedError, markCandidates, markId, nextMarks } from "./catalogue-marks.js";
import { __resetCatalogueMarksMemory } from "./catalogue-marks-store.js";
import { withResearchCatalogMarks, withTemplateRankingMarks, withWorkflowRankingMarks } from "./catalogue-mark-serving.js";

// MARKS-1022 (owner 2026-10-22): every workflow dynasty and every template dynasty has its OWN icon, the same everywhere.
describe("the mark pool", () => {
  it("is Phosphor-spelled, unique, and never reuses a family glyph", () => {
    expect(new Set(MARK_ICONS).size).toBe(MARK_ICONS.length);
    for (const icon of MARK_ICONS) expect(icon).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    for (const family of ["bird", "waves", "flow-arrow", "lightning"]) expect(MARK_ICONS).not.toContain(family);
    expect(MARK_ICONS.length).toBeGreaterThanOrEqual(200);
  });

  it("gives the first pool-size objects a DIFFERENT icon each, then unique (icon, colour) pairs up to icons x colours", () => {
    const all = [...markCandidates()];
    expect(all).toHaveLength(MARK_ICONS.length * GLYPH_COLORS.length);
    expect(new Set(all.map(markId)).size).toBe(all.length);
    expect(new Set(all.slice(0, MARK_ICONS.length).map((m) => m.icon)).size).toBe(MARK_ICONS.length);
  });

  it("hands out the next unused marks in order, and is loud when the family is exhausted", () => {
    const first = nextMarks("workflow", new Set(), 2);
    expect(first[0].icon).not.toBe(first[1].icon);
    const after = nextMarks("workflow", new Set(first.map(markId)), 1);
    expect(markId(after[0])).not.toBe(markId(first[0]));
    const everything = new Set([...markCandidates()].map(markId));
    expect(() => nextMarks("template", everything, 1)).toThrow(MarkPoolExhaustedError);
  });
});

describe("serving the marks (suite store: the same first-sight rule in memory)", () => {
  it("two workflows on the pipe serve different icons; the same workflow serves the same mark on every read and surface", async () => {
    __resetCatalogueMarksMemory();
    const ranking = await withWorkflowRankingMarks({ rows: [{ workflowDynastySlug: "keel" }, { workflowDynastySlug: "nobelium" }] });
    const [keel, nobelium] = ranking.rows as unknown as Array<{ icon: string; color: string }>;
    expect(keel.icon).toBeTruthy();
    expect(keel.icon).not.toBe(nobelium.icon);

    // Read again in another order, and on the Research catalogue: the mark never moves.
    const again = await withWorkflowRankingMarks({ rows: [{ workflowDynastySlug: "nobelium" }, { workflowDynastySlug: "keel" }] });
    expect(again.rows[1]).toMatchObject({ icon: keel.icon, color: keel.color });
    const catalog = await withResearchCatalogMarks({ pipe: { workflows: [{ key: "keel" }], templates: [{ key: "blind-free-offer" }, { key: "named-case-study" }] } });
    expect(catalog.pipe.workflows[0]).toMatchObject({ icon: keel.icon, color: keel.color });
    const [t1, t2] = catalog.pipe.templates as unknown as Array<{ icon: string; color: string }>;
    expect(t1.icon).not.toBe(t2.icon);

    // The writer ranking's template rows read the same template marks; `best` is the marked row.
    const writers = await withTemplateRankingMarks({ templates: { rows: [{ key: "named-case-study" }, { key: "blind-free-offer" }], best: { key: "blind-free-offer" } } });
    expect(writers.templates.rows[1]).toMatchObject({ icon: t1.icon, color: t1.color });
    expect(writers.templates.best).toMatchObject({ key: "blind-free-offer", icon: t1.icon, color: t1.color });
  });
});
