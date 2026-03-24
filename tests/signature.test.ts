import { describe, it, expect } from "vitest";
import { computeSignature, slugify, versionedName, versionedSlug } from "../src/lib/signature.js";

describe("computeSignature", () => {
  it("produces deterministic hash from sorted keys", () => {
    const sig1 = computeSignature(["b", "a", "c"], ["y", "x"]);
    const sig2 = computeSignature(["a", "b", "c"], ["x", "y"]);
    expect(sig1).toBe(sig2);
  });

  it("produces different hash for different inputs", () => {
    const sig1 = computeSignature(["a", "b"], ["x", "y"]);
    const sig2 = computeSignature(["a", "b", "c"], ["x", "y"]);
    expect(sig1).not.toBe(sig2);
  });

  it("produces different hash for different outputs", () => {
    const sig1 = computeSignature(["a", "b"], ["x", "y"]);
    const sig2 = computeSignature(["a", "b"], ["x", "y", "z"]);
    expect(sig1).not.toBe(sig2);
  });

  it("returns a 64-char hex string (sha256)", () => {
    const sig = computeSignature(["a"], ["b"]);
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Sales Cold Email Outreach")).toBe("sales-cold-email-outreach");
  });

  it("removes special characters", () => {
    expect(slugify("PR & Media (Pitch)")).toBe("pr-media-pitch");
  });

  it("collapses multiple hyphens", () => {
    expect(slugify("hello---world")).toBe("hello-world");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  Hello World  ")).toBe("hello-world");
  });
});

describe("versionedName", () => {
  it("returns base name for v1", () => {
    expect(versionedName("Sales Cold Email", 1)).toBe("Sales Cold Email");
  });

  it("adds v2 suffix for version 2", () => {
    expect(versionedName("Sales Cold Email", 2)).toBe("Sales Cold Email v2");
  });

  it("adds v3 suffix for version 3", () => {
    expect(versionedName("Sales Cold Email", 3)).toBe("Sales Cold Email v3");
  });
});

describe("versionedSlug", () => {
  it("returns base slug for v1", () => {
    expect(versionedSlug("sales-cold-email", 1)).toBe("sales-cold-email");
  });

  it("adds -v2 suffix for version 2", () => {
    expect(versionedSlug("sales-cold-email", 2)).toBe("sales-cold-email-v2");
  });

  it("adds -v3 suffix for version 3", () => {
    expect(versionedSlug("sales-cold-email", 3)).toBe("sales-cold-email-v3");
  });
});
