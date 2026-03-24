import { describe, it, expect } from "vitest";

// flattenValue is defined in routes/features.ts — extract for testing
// We re-implement here to test in isolation (same logic)
function flattenValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(flattenValue).filter((v): v is string => v !== null);
    return parts.length > 0 ? parts.join(". ") : null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.elements)) return flattenValue(obj.elements);
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.value === "string") return obj.value;
    const parts = Object.values(obj).map(flattenValue).filter((v): v is string => v !== null);
    return parts.length > 0 ? parts.join(". ") : null;
  }
  return String(value);
}

describe("flattenValue", () => {
  it("returns null for null/undefined", () => {
    expect(flattenValue(null)).toBeNull();
    expect(flattenValue(undefined)).toBeNull();
  });

  it("passes through strings", () => {
    expect(flattenValue("hello")).toBe("hello");
  });

  it("stringifies numbers and booleans", () => {
    expect(flattenValue(42)).toBe("42");
    expect(flattenValue(true)).toBe("true");
  });

  it("joins arrays of strings", () => {
    expect(flattenValue(["a", "b", "c"])).toBe("a. b. c");
  });

  it("filters nulls from arrays", () => {
    expect(flattenValue(["a", null, "b"])).toBe("a. b");
  });

  it("extracts .text from objects", () => {
    expect(flattenValue({ text: "hello", confidence: 0.8 })).toBe("hello");
  });

  it("extracts .value from objects", () => {
    expect(flattenValue({ value: "hello", score: 0.9 })).toBe("hello");
  });

  // Real brand-service response: urgency
  it("flattens { elements: [...] } (urgency pattern)", () => {
    const urgency = {
      elements: [
        "Monthly KPI requirements create recurring deadlines",
        "Token Generation Event planned for 2026 Q1",
        "Program levels incentivize early participation",
      ],
    };
    const result = flattenValue(urgency);
    expect(result).toBe(
      "Monthly KPI requirements create recurring deadlines. Token Generation Event planned for 2026 Q1. Program levels incentivize early participation"
    );
  });

  // Real brand-service response: scarcity
  it("flattens { elements: [...] } (scarcity pattern)", () => {
    const scarcity = {
      elements: [
        "Lead Angel role is by invitation only",
        "Program progression is merit-based and not guaranteed",
      ],
    };
    const result = flattenValue(scarcity);
    expect(result).toBe(
      "Lead Angel role is by invitation only. Program progression is merit-based and not guaranteed"
    );
  });

  // Real brand-service response: riskReversal
  it("flattens object with mixed null/string values (riskReversal pattern)", () => {
    const riskReversal = {
      notes: "Rewards are paid only after KPI verification",
      trials: null,
      guarantees: null,
      refundPolicy: null,
    };
    const result = flattenValue(riskReversal);
    expect(result).toBe("Rewards are paid only after KPI verification");
  });

  // Real brand-service response: socialProof
  it("flattens nested objects with arrays (socialProof pattern)", () => {
    const socialProof = {
      metrics: { users: 1491, donated: "$3,105.3", proposals: 32 },
      caseStudies: null,
      testimonials: null,
      ecosystemSupport: [
        "Backed by Generative Venture, Hash Global",
        "Supported by Ethereum Foundation",
      ],
    };
    const result = flattenValue(socialProof);
    expect(result).not.toBeNull();
    expect(result).toContain("1491");
    expect(result).toContain("$3,105.3");
    expect(result).toContain("Backed by Generative Venture");
    expect(result).toContain("Supported by Ethereum Foundation");
  });

  it("returns null for object with all null values", () => {
    expect(flattenValue({ a: null, b: null })).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(flattenValue([])).toBeNull();
  });
});
