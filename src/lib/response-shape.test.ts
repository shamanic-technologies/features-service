import { describe, expect, it, vi } from "vitest";

import { buildScopeKey, familyKeyOf } from "./view-cache.js";
import { routeResponseShapeFingerprint, shapeFingerprint, withResponseShape, withoutResponseShape } from "./response-shape.js";
import { openApiDocument } from "./openapi.js";

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

describe("routeResponseShapeFingerprint", () => {
  const routeDoc = (wField: Record<string, unknown> = {}, otherField: Record<string, unknown> = {}) => ({
    paths: {
      "/x": { get: { responses: { 200: { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/W" } } } } } } },
      "/y": { get: { responses: { 200: { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/V" } } } } } } },
    },
    components: {
      schemas: {
        W: { type: "object", properties: { a: { type: "integer" }, nested: { $ref: "#/components/schemas/N" }, ...wField } },
        N: { type: "object", properties: { b: { type: "string" } } },
        V: { type: "object", properties: { c: { type: "integer" }, ...otherField } },
      },
    },
  });

  it("does not move when ANOTHER route's response changes (the lead-families cell survives such a deploy)", () => {
    expect(routeResponseShapeFingerprint("/x", "get", routeDoc({}, { d: { type: "string" } }))).toBe(
      routeResponseShapeFingerprint("/x", "get", routeDoc()),
    );
  });

  it("moves when a field of THIS route's response changes, a referenced component's included", () => {
    expect(routeResponseShapeFingerprint("/x", "get", routeDoc({ e: { type: "string" } }))).not.toBe(routeResponseShapeFingerprint("/x", "get", routeDoc()));
    const nestedMoved = routeDoc();
    (nestedMoved.components.schemas.N.properties as Record<string, unknown>).z = { type: "integer" };
    expect(routeResponseShapeFingerprint("/x", "get", nestedMoved)).not.toBe(routeResponseShapeFingerprint("/x", "get", routeDoc()));
  });

  it("fails loud on a route the document does not hold, and resolves the real lead-families route", () => {
    expect(() => routeResponseShapeFingerprint("/nope", "get", routeDoc())).toThrow(/no GET \/nope/);
    expect(routeResponseShapeFingerprint("/brands/{brandId}/lead-families", "get", openApiDocument)).toMatch(/^[0-9a-f]{12}$/);
  });
});
