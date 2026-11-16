import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { isCurrentBuild } from "./research.js";
import { ENGINE_BUILD_SHAPE } from "../lib/research/engine-build.js";

// RESEARCH-NATIVE-ENGINE-1116-P2: the build is stored by Engine; any other copy is rebuilt at once.
describe("isCurrentBuild", () => {
  const build = (over: Record<string, unknown>) => ({ shape: ENGINE_BUILD_SHAPE, view: "mature", ...over }) as never;
  it("an Engine build on the asked view is current", () => {
    expect(isCurrentBuild(build({}))).toBe(true);
    expect(isCurrentBuild(build({ view: "flash" }), "flash")).toBe(true);
  });
  it("a per-population copy re-keyed at read, another shape, or the other view is rebuilt", () => {
    expect(isCurrentBuild(build({ convertedFromStoredCopy: true }))).toBe(false);
    expect(isCurrentBuild(build({ shape: "engine-v0" }))).toBe(false);
    expect(isCurrentBuild({ file: { view: "mature" }, catalog: null, texts: null } as never)).toBe(false);
    expect(isCurrentBuild(build({}), "flash")).toBe(false);
  });
});
