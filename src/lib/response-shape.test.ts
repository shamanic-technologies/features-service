import { describe, expect, it, vi } from "vitest";

import { buildScopeKey, familyKeyOf } from "./view-cache.js";
import { shapeFingerprint, withResponseShape, withoutResponseShape } from "./response-shape.js";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const doc = (extra: Record<string, unknown> = {}, description = "Spend over the window.") => ({
  paths: { "/x": { get: { summary: "X", responses: { 200: { description: "ok" } } } } },
  components: {
    schemas: {
      W: {
        type: "object",
        description,
        properties: { actualSpentCents: { type: "integer", description }, description: { type: "string" }, ...extra },
      },
    },
  },
});

describe("shapeFingerprint", () => {
  it("does not move when only prose moves", () => {
    expect(shapeFingerprint(doc({}, "Reworded."))).toBe(shapeFingerprint(doc()));
  });

  it("moves when a response field is added", () => {
    expect(shapeFingerprint(doc({ totalSpentCents: { type: "integer" } }))).not.toBe(shapeFingerprint(doc()));
  });

  it("a FIELD named like a prose key is shape, not prose", () => {
    const without = doc();
    delete (without.components.schemas.W.properties as Record<string, unknown>).description;
    expect(shapeFingerprint(without)).not.toBe(shapeFingerprint(doc()));
  });
});

describe("withResponseShape", () => {
  const key = buildScopeKey("b1", { orgId: "o", econ: "e1", pricing: "net" });

  it("binds a key to a shape, and the shape survives into the family (no cross-build rotation)", () => {
    const a = withResponseShape(key, "aaa");
    const b = withResponseShape(key, "bbb");
    expect(a).not.toBe(b);
    expect(familyKeyOf(a)).not.toBe(familyKeyOf(b));
    expect(familyKeyOf(a)).toContain("_shape=aaa");
  });

  it("handles a key with no query and a key with no bar", () => {
    expect(withResponseShape("b1|", "s")).toBe("b1|_shape=s");
    expect(withResponseShape("fleet", "s")).toBe("fleet|_shape=s");
  });

  it("withoutResponseShape matches the same cell across builds (the keeper's replay target)", () => {
    const old = familyKeyOf(key); // a cell stored before shapes keyed cells
    const now = familyKeyOf(withResponseShape(key, "new"));
    expect(withoutResponseShape(now)).toBe(withoutResponseShape(old));
    expect(withoutResponseShape(familyKeyOf(withResponseShape(key, "a")))).toBe(withoutResponseShape(familyKeyOf(withResponseShape(key, "b"))));
  });
});
