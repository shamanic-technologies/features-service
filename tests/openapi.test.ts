import { describe, it, expect } from "vitest";
import { openApiDocument } from "../src/lib/openapi.js";

describe("openApiDocument", () => {
  it("has correct metadata", () => {
    expect(openApiDocument.openapi).toBe("3.0.3");
    expect(openApiDocument.info.title).toBe("Features Service API");
    expect(openApiDocument.info.version).toBe("3.0.0");
  });

  it("exposes all feature endpoints", () => {
    const paths = Object.keys(openApiDocument.paths ?? {});
    expect(paths).toContain("/features");
    expect(paths).toContain("/features/{slug}");
    expect(paths).toContain("/features/by-dynasty/{dynastySlug}");
    expect(paths).toContain("/features/{dynastySlug}/inputs");
    expect(paths).toContain("/features/{dynastySlug}/prefill");
  });

  it("exposes stats endpoints", () => {
    const paths = Object.keys(openApiDocument.paths ?? {});
    expect(paths).toContain("/stats/registry");
    expect(paths).toContain("/features/{featureSlug}/stats");
    expect(paths).toContain("/stats");
  });

  it("has POST /features (create single)", () => {
    const post = (openApiDocument.paths as Record<string, Record<string, unknown>>)["/features"]?.["post"] as Record<string, unknown> | undefined;
    expect(post).toBeDefined();
    expect(post?.summary).toContain("Create a single feature");
  });

  it("has PUT /features (batch upsert)", () => {
    const put = (openApiDocument.paths as Record<string, Record<string, unknown>>)["/features"]?.["put"] as Record<string, unknown> | undefined;
    expect(put).toBeDefined();
    expect(put?.summary).toContain("Batch upsert");
  });

  it("has PUT /features/{slug} (fork-on-write)", () => {
    const put = (openApiDocument.paths as Record<string, Record<string, unknown>>)["/features/{slug}"]?.["put"] as Record<string, unknown> | undefined;
    expect(put).toBeDefined();
    expect(put?.summary).toContain("fork-on-write");
  });

  it("has GET /features/{slug}", () => {
    const get = (openApiDocument.paths as Record<string, Record<string, unknown>>)["/features/{slug}"]?.["get"] as Record<string, unknown> | undefined;
    expect(get).toBeDefined();
  });

  it("includes top-level security requirement", () => {
    expect(openApiDocument.security).toBeDefined();
    expect(openApiDocument.security).toContainEqual({ ApiKeyAuth: [] });
  });

  it("has GET /features/dynasty", () => {
    const get = (openApiDocument.paths as Record<string, Record<string, unknown>>)["/features/dynasty"]?.["get"] as Record<string, unknown> | undefined;
    expect(get).toBeDefined();
    expect(get?.summary).toContain("dynasty");
  });

  it("Feature schema includes dynasty fields", () => {
    const schemas = (openApiDocument.components as Record<string, unknown>)?.schemas as Record<string, Record<string, unknown>> | undefined;
    const featureProps = (schemas?.Feature as Record<string, unknown>)?.properties as Record<string, unknown> | undefined;
    expect(featureProps?.dynastyName).toBeDefined();
    expect(featureProps?.dynastySlug).toBeDefined();
    expect(featureProps?.version).toBeDefined();
  });

  it("has component schemas registered", () => {
    const schemas = (openApiDocument.components as Record<string, unknown>)?.schemas as Record<string, unknown> | undefined;
    expect(schemas).toBeDefined();
    expect(schemas?.CreateFeature).toBeDefined();
    expect(schemas?.UpdateFeature).toBeDefined();
    expect(schemas?.FeatureInput).toBeDefined();
    expect(schemas?.FeatureOutput).toBeDefined();
    expect(schemas?.FeatureStatsResponse).toBeDefined();
    expect(schemas?.RegistryResponse).toBeDefined();
  });
});
