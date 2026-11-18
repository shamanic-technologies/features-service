import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { buildScopeKey, familyKeyOf } from "./view-cache.js";
import {
  currentShapeFingerprints,
  isCurrentShapeKey,
  routeResponseShapeFingerprint,
  routeComputeRule,
  routeCacheFingerprints,
  ROUTE_COMPUTE_RULES,
  RULE_KEY_PART,
  shapeFingerprint,
  withResponseShape,
  withoutResponseShape,
} from "./response-shape.js";
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

describe("ROUTE_COMPUTE_RULES (MON-PAGE-SPEED-1118: compute rule is a scope-key part, not in the shape fingerprint)", () => {
  const doc = {
    paths: { "/x": { get: { responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "integer" } } } } } } } },
  };

  it("a compute rule does NOT move the route's shape fingerprint (separated from shape for family rotation)", () => {
    const none = routeResponseShapeFingerprint("/x", "get", doc, {});
    const v1 = routeResponseShapeFingerprint("/x", "get", doc, { "/x": "fix-a" });
    const v2 = routeResponseShapeFingerprint("/x", "get", doc, { "/x": "fix-b" });
    // All three are the SAME: the shape fingerprint hashes only the response schema, not the rule.
    expect(v1).toBe(none);
    expect(v2).toBe(none);
  });

  it("routeComputeRule returns the rule when stated, undefined otherwise", () => {
    expect(routeComputeRule("/x", { "/x": "fix-a" })).toBe("fix-a");
    expect(routeComputeRule("/x", {})).toBeUndefined();
    expect(routeComputeRule("/x", { "/other": "fix-a" })).toBeUndefined();
  });

  it("routeCacheFingerprints returns both shape and rule", () => {
    const fp = routeCacheFingerprints("/brands/{brandId}/campaign-targets");
    expect(fp.responseShape).toMatch(/^[0-9a-f]{12}$/);
    expect(fp.computeRule).toBe(ROUTE_COMPUTE_RULES["/brands/{brandId}/campaign-targets"]);
  });

  it("a shape change still retires the cell (the shape fingerprint IS the cell boundary for wrong-schema bodies)", () => {
    const path = "/brands/{brandId}/sales-funnel-campaigns/{salesFunnelCampaignId}/spend-charts";
    const current = routeResponseShapeFingerprint(path);
    expect(isCurrentShapeKey(withResponseShape("sfc|pricing=net", current))).toBe(true);
    expect(isCurrentShapeKey(withResponseShape("sfc|pricing=net", "0123456789ab"))).toBe(false);
  });

  it("every route named holds a GET in the served document (a typo would bump nothing)", () => {
    for (const path of Object.keys(ROUTE_COMPUTE_RULES)) {
      expect(routeResponseShapeFingerprint(path, "get", openApiDocument)).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it("_rule is a FINGERPRINT_KEY_PART: a rule bump finds a family member, a shape change does not", () => {
    const base = buildScopeKey("brand1", { orgId: "o", pricing: "net" });
    const ruleA = `${base}&${RULE_KEY_PART}=fix-a`;
    const ruleB = `${base}&${RULE_KEY_PART}=fix-b`;
    // Different rules → same FAMILY (rule is a fingerprint part, removed from family key).
    expect(familyKeyOf(withResponseShape(ruleA, "shape1"))).toBe(familyKeyOf(withResponseShape(ruleB, "shape1")));
    // Different shapes → different FAMILY (shape is NOT a fingerprint part).
    expect(familyKeyOf(withResponseShape(ruleA, "shape1"))).not.toBe(familyKeyOf(withResponseShape(ruleA, "shape2")));
  });
});

describe("isCurrentShapeKey (what the keeper may count as held)", () => {
  const current = currentShapeFingerprints();
  it("this build's whole-document and per-route fingerprints are current", () => {
    expect(isCurrentShapeKey(withResponseShape("b|pricing=net"))).toBe(true);
    expect(isCurrentShapeKey(withResponseShape("b|pricing=net", routeResponseShapeFingerprint("/offers/{offerId}/revenue")))).toBe(true);
    expect(current.has(routeResponseShapeFingerprint("/features/{featureSlug}/workflow-projection"))).toBe(true);
  });
  it("a fingerprint no route of this build has is an earlier build's: not current", () => {
    expect(isCurrentShapeKey(withResponseShape("b|pricing=net", "0123456789ab"))).toBe(false);
    expect(isCurrentShapeKey(withResponseShape("b|pricing=net", "0123456789ab-evidence-v1"))).toBe(false);
  });
  it("a manual marker, a versioned route fingerprint and a key with no shape are current", () => {
    expect(isCurrentShapeKey(withResponseShape("b|m=x", "internal-measurement"))).toBe(true);
    const ev = `${routeResponseShapeFingerprint("/features/{featureSlug}/workflow-projection")}-evidence-v1`;
    expect(isCurrentShapeKey(withResponseShape("b|pricing=net", ev))).toBe(true);
    expect(isCurrentShapeKey("b|pricing=net")).toBe(true);
  });
});

describe("dashboard views keyed on their OWN route's shape", () => {
  // A deploy that changes ANOTHER route must not make these cold (8 shape-changing deploys on
  // 2026-10-14; an offer revenue read waited 133 s on its first read after one). Pin the call sites.
  const read = (f: string) => readFileSync(new URL(`../routes/${f}`, import.meta.url), "utf8");
  it.each([
    ["offer-economics.ts", "/offers/{offerId}/revenue"],
    ["brand-economics.ts", "/brands/{brandId}/revenue"],
    ["brand-economics.ts", "/brands/{brandId}/offers"],
    ["offer-outcomes.ts", "/offers/{offerId}/outcomes"],
    ["lived-sales-paths.ts", "/brands/{brandId}/lived-sales-paths"],
    ["offer-sourcing.ts", "/offers/{offerId}/sourcing"],
    ["stats.ts", "/features/{featureSlug}/stats"],
    ["revenue.ts", "/features/{featureSlug}/revenue"],
    ["workflow-projection.ts", "/features/{featureSlug}/workflow-projection"],
    ["offer-sales-paths.ts", "/offers/{offerId}/sales-paths"],
  ])("%s keys on %s", (file, path) => {
    // MON-PAGE-SPEED-1118: routes with a compute rule use `routeCacheFingerprints` (threads both shape and rule).
    const src = read(file);
    expect(src.includes(`routeResponseShapeFingerprint("${path}")`) || src.includes(`routeCacheFingerprints("${path}")`)).toBe(true);
    expect(() => routeResponseShapeFingerprint(path)).not.toThrow();
  });
});
