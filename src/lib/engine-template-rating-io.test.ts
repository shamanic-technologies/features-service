import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const { templateLinesOf, versionDynastyMap } = await import("./engine-template-rating-io.js");

const d = (slug: string, status: "active" | "deprecated", head: string | null, versions: string[], copiedFrom: Record<string, string> = {}) =>
  ({ slug, name: slug, description: "", signature: null, identity: "", head, versions, status, statusSource: "content_generation", versionStatuses: {}, copiedFrom }) as never;

describe("template Rating candidates and history filing", () => {
  it("one line per dynasty across the Engine's pipes; pickable = active with a head", () => {
    const lines = templateLinesOf([d("a", "deprecated", "a-v1", ["a-v1"]), d("a", "active", "a-v2", ["a-v2"]), d("b", "active", null, ["b-v1"]), d("c", "deprecated", "c-v1", ["c-v1"])]);
    expect(lines.map((l) => [l.slug, l.pickable])).toEqual([["a", true], ["b", false], ["c", false]]);
  });
  it("files every version (and the original a copy states) under its dynasty: history keeps its writer", () => {
    const m = versionDynastyMap([d("blind", "active", "blind-v47", ["blind-v40", "blind-v47"], { "blind-v47": "cold-v9" })]);
    expect([m.get("blind-v40"), m.get("blind-v47"), m.get("cold-v9")]).toEqual(["blind", "blind", "blind"]);
  });
});
