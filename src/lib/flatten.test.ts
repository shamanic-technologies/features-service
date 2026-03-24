import { describe, it, expect } from "vitest";
import { flattenValue, humanizeKey } from "./flatten.js";

describe("humanizeKey", () => {
  it("converts camelCase to title case", () => {
    expect(humanizeKey("userCount")).toBe("User Count");
    expect(humanizeKey("totalRevenueUsd")).toBe("Total Revenue Usd");
  });

  it("converts snake_case to title case", () => {
    expect(humanizeKey("total_revenue")).toBe("Total Revenue");
  });

  it("converts kebab-case to title case", () => {
    expect(humanizeKey("case-studies")).toBe("Case Studies");
  });

  it("handles single word", () => {
    expect(humanizeKey("backers")).toBe("Backers");
  });
});

describe("flattenValue", () => {
  // Primitives
  it("returns null for null/undefined", () => {
    expect(flattenValue(null)).toBe(null);
    expect(flattenValue(undefined)).toBe(null);
  });

  it("passes strings through", () => {
    expect(flattenValue("hello")).toBe("hello");
  });

  it("converts numbers to strings", () => {
    expect(flattenValue(42)).toBe("42");
    expect(flattenValue(3.14)).toBe("3.14");
  });

  it("converts booleans to strings", () => {
    expect(flattenValue(true)).toBe("true");
  });

  // Arrays
  it("joins array elements with '. '", () => {
    expect(flattenValue(["a", "b", "c"])).toBe("a. b. c");
  });

  it("filters null elements from arrays", () => {
    expect(flattenValue(["a", null, "b"])).toBe("a. b");
  });

  it("returns null for empty arrays", () => {
    expect(flattenValue([])).toBe(null);
  });

  // Object wrappers
  it("unwraps { elements: [...] }", () => {
    expect(flattenValue({ elements: ["a", "b"] })).toBe("a. b");
  });

  it("extracts { text: '...' }", () => {
    expect(flattenValue({ text: "hello" })).toBe("hello");
  });

  it("extracts { value: '...' }", () => {
    expect(flattenValue({ value: "hello" })).toBe("hello");
  });

  // Single-key objects → no prefix
  it("unwraps single-key objects without prefix", () => {
    expect(flattenValue({ name: "Acme Corp" })).toBe("Acme Corp");
  });

  // Multi-key objects → key prefixes
  it("prefixes multi-key object values with humanized keys", () => {
    const result = flattenValue({
      userCount: 1491,
      totalRevenue: "$3,105.3",
      projectCount: 32,
    });
    expect(result).toBe("User Count: 1491. Total Revenue: $3,105.3. Project Count: 32");
  });

  it("skips null values in multi-key objects", () => {
    const result = flattenValue({
      backers: "Generative Venture, Hash Global",
      awards: null,
      events: "ETHDenver",
    });
    expect(result).toBe("Backers: Generative Venture, Hash Global. Events: ETHDenver");
  });

  // Real-world social proof from brand-service
  it("handles social proof with mixed metrics and text", () => {
    const brandResponse = {
      userCount: 1491,
      totalRevenue: "$3,105.3",
      projectCount: 32,
      backers: "Backed by Generative Venture, Hash Global, Tsingting Capital",
      partners: "Supported by Ethereum Foundation, BNB Chain, Uniswap",
      audits: "Audited by Kekkai",
      events: "Participated in ETHDenver and ETH Taipei events",
    };
    const result = flattenValue(brandResponse);
    expect(result).toContain("User Count: 1491");
    expect(result).toContain("Backers: Backed by Generative Venture");
    expect(result).toContain("Audits: Audited by Kekkai");
  });

  // Nested objects
  it("recursively flattens nested objects with key prefixes", () => {
    const result = flattenValue({
      metrics: { users: 500, revenue: "$10k" },
      description: "A great company",
    });
    expect(result).toBe("Metrics: Users: 500. Revenue: $10k. Description: A great company");
  });

  // Array of objects
  it("flattens array of objects", () => {
    const result = flattenValue([
      { text: "First point" },
      { text: "Second point" },
    ]);
    expect(result).toBe("First point. Second point");
  });

  // Elements wrapper with nested objects
  it("handles elements array with mixed content", () => {
    const result = flattenValue({
      elements: [
        "Simple string",
        { text: "Wrapped text" },
      ],
    });
    expect(result).toBe("Simple string. Wrapped text");
  });

  // Empty object
  it("returns null for empty objects", () => {
    expect(flattenValue({})).toBe(null);
  });

  // Object with all null values
  it("returns null when all object values are null", () => {
    expect(flattenValue({ a: null, b: undefined })).toBe(null);
  });
});
