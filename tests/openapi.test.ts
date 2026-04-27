import { describe, it, expect } from "vitest";
import { openApiDocument } from "../src/lib/openapi.js";

describe("openApiDocument", () => {
  it("has correct metadata", () => {
    expect(openApiDocument.openapi).toBe("3.0.3");
    expect(openApiDocument.info.title).toBe("Features Service API");
    expect(openApiDocument.info.version).toBe("4.0.0");
  });

  it("exposes feature endpoints", () => {
    const paths = Object.keys(openApiDocument.paths ?? {});
    expect(paths).toContain("/features");
    expect(paths).toContain("/features/{slug}");
  });

  it("does not expose removed dynasty endpoints", () => {
    const paths = Object.keys(openApiDocument.paths ?? {});
    expect(paths).not.toContain("/features/dynasty");
    expect(paths).not.toContain("/features/dynasty/slugs");
    expect(paths).not.toContain("/features/dynasties");
    expect(paths).not.toContain("/features/by-dynasty/{dynastySlug}");
    expect(paths).not.toContain("/features/{dynastySlug}/inputs");
    expect(paths).not.toContain("/features/{dynastySlug}/prefill");
    expect(paths).not.toContain("/stats/dynasty");
    expect(paths).not.toContain("/public/features/dynasty/slugs");
  });

  it("exposes stats endpoints", () => {
    const paths = Object.keys(openApiDocument.paths ?? {});
    expect(paths).toContain("/stats/registry");
    expect(paths).toContain("/features/{featureSlug}/stats");
    expect(paths).toContain("/stats");
  });

  it("exposes public endpoints", () => {
    const paths = Object.keys(openApiDocument.paths ?? {});
    expect(paths).toContain("/public/features");
    expect(paths).toContain("/public/stats/ranked");
    expect(paths).toContain("/public/stats/best");
  });

  it("has GET /features/{slug}", () => {
    const get = (openApiDocument.paths as Record<string, Record<string, unknown>>)["/features/{slug}"]?.["get"] as Record<string, unknown> | undefined;
    expect(get).toBeDefined();
  });

  it("does not have PUT /features (batch upsert removed)", () => {
    const put = (openApiDocument.paths as Record<string, Record<string, unknown>>)["/features"]?.["put"] as Record<string, unknown> | undefined;
    expect(put).toBeUndefined();
  });

  it("does not have POST /features (create removed)", () => {
    const post = (openApiDocument.paths as Record<string, Record<string, unknown>>)["/features"]?.["post"] as Record<string, unknown> | undefined;
    expect(post).toBeUndefined();
  });

  it("includes top-level security requirement", () => {
    expect(openApiDocument.security).toBeDefined();
    expect(openApiDocument.security).toContainEqual({ ApiKeyAuth: [] });
  });

  it("Feature schema has simplified fields only", () => {
    const schemas = (openApiDocument.components as Record<string, unknown>)?.schemas as Record<string, Record<string, unknown>> | undefined;
    const featureProps = (schemas?.Feature as Record<string, unknown>)?.properties as Record<string, unknown> | undefined;
    expect(featureProps?.slug).toBeDefined();
    expect(featureProps?.name).toBeDefined();
    expect(featureProps?.description).toBeDefined();
    expect(featureProps?.status).toBeDefined();
    // Removed fields
    expect(featureProps?.dynastyName).toBeUndefined();
    expect(featureProps?.dynastySlug).toBeUndefined();
    expect(featureProps?.version).toBeUndefined();
    expect(featureProps?.signature).toBeUndefined();
    expect(featureProps?.inputs).toBeUndefined();
    expect(featureProps?.outputs).toBeUndefined();
  });
});
