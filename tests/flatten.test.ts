import { describe, it, expect } from "vitest";
import { flattenValue } from "../src/lib/flatten.js";

describe("flattenValue", () => {
  it("returns null for null", () => {
    expect(flattenValue(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(flattenValue(undefined)).toBeNull();
  });

  it("passes through strings", () => {
    expect(flattenValue("hello")).toBe("hello");
  });

  it("joins arrays of strings", () => {
    expect(flattenValue(["a", "b", "c"])).toBe("a, b, c");
  });

  it("filters non-strings from arrays", () => {
    expect(flattenValue(["a", 42, "b"])).toBe("a, b");
  });

  it("extracts .text from objects", () => {
    expect(flattenValue({ text: "Limited time offer", confidence: 0.8 })).toBe("Limited time offer");
  });

  it("extracts .value from objects when no .text", () => {
    expect(flattenValue({ value: "500+ companies", score: 0.9 })).toBe("500+ companies");
  });

  it("prefers .text over .value", () => {
    expect(flattenValue({ text: "from text", value: "from value" })).toBe("from text");
  });

  it("joins string values as fallback for objects", () => {
    expect(flattenValue({ a: "hello", b: 42, c: "world" })).toBe("hello, world");
  });

  it("stringifies numbers", () => {
    expect(flattenValue(42)).toBe("42");
  });
});
