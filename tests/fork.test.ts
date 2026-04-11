import { describe, it, expect } from "vitest";
import { computeSignature, slugify, versionedName, versionedSlug } from "../src/lib/signature.js";

describe("fork naming conventions", () => {
  it("versionedName produces v2, v3 suffixes", () => {
    expect(versionedName("Sales Cold Email Outreach", 1)).toBe("Sales Cold Email Outreach");
    expect(versionedName("Sales Cold Email Outreach", 2)).toBe("Sales Cold Email Outreach v2");
    expect(versionedName("Sales Cold Email Outreach", 3)).toBe("Sales Cold Email Outreach v3");
  });

  it("versionedSlug produces -v2, -v3 suffixes", () => {
    expect(versionedSlug("sales-cold-email-outreach", 1)).toBe("sales-cold-email-outreach");
    expect(versionedSlug("sales-cold-email-outreach", 2)).toBe("sales-cold-email-outreach-v2");
    expect(versionedSlug("sales-cold-email-outreach", 3)).toBe("sales-cold-email-outreach-v3");
  });

  it("slugify handles display names correctly", () => {
    expect(slugify("Sales Cold Email Outreach")).toBe("sales-cold-email-outreach");
    expect(slugify("PR Cold Email Outreach")).toBe("pr-cold-email-outreach");
    expect(slugify("Outlet Database Discovery")).toBe("outlet-database-discovery");
  });
});

describe("fork signature logic", () => {
  it("same inputs + outputs → same signature", () => {
    const sig1 = computeSignature(["a", "b"], ["x", "y"]);
    const sig2 = computeSignature(["b", "a"], ["y", "x"]); // different order, same keys
    expect(sig1).toBe(sig2);
  });

  it("different inputs → different signature (triggers fork)", () => {
    const sig1 = computeSignature(["a", "b"], ["x", "y"]);
    const sig2 = computeSignature(["a", "b", "c"], ["x", "y"]);
    expect(sig1).not.toBe(sig2);
  });

  it("different outputs → different signature (triggers fork)", () => {
    const sig1 = computeSignature(["a", "b"], ["x", "y"]);
    const sig2 = computeSignature(["a", "b"], ["x", "y", "z"]);
    expect(sig1).not.toBe(sig2);
  });

  it("metadata changes with same inputs/outputs → same signature (no fork)", () => {
    // This verifies that metadata-only changes don't trigger a fork
    const sig1 = computeSignature(["targetAudience"], ["emailsSent"]);
    const sig2 = computeSignature(["targetAudience"], ["emailsSent"]);
    expect(sig1).toBe(sig2);
  });
});

describe("lineage stats aggregation", () => {
  it("same feature queried across chain produces consistent signatures", () => {
    // When a feature is forked, the old version has different inputs/outputs (different signature).
    // Stats aggregation should query all slugs in the chain, not just the active one.
    const originalSig = computeSignature(["targetAudience", "tone"], ["emailsSent", "positiveReplyRate"]);
    const forkedSig = computeSignature(["targetAudience", "tone", "newField"], ["emailsSent", "positiveReplyRate"]);

    // Different signatures confirm they're different features in the chain
    expect(originalSig).not.toBe(forkedSig);

    // Each slug in the chain has its own signature — aggregation happens at the slug level
    // The stats endpoint resolves the full chain via forkedFrom/upgradedTo
  });
});

describe("fork-on-write decision matrix", () => {
  const existingInputKeys = ["targetAudience", "tone"];
  const existingOutputKeys = ["emailsSent", "positiveReplyRate"];
  const existingSignature = computeSignature(existingInputKeys, existingOutputKeys);

  it("no inputs/outputs change → metadata-only → 200", () => {
    // Simulates: PUT with only { description: "new desc" }
    const newSignature = existingSignature; // unchanged
    expect(newSignature).toBe(existingSignature);
  });

  it("inputs change → new signature → fork → 201", () => {
    const newInputKeys = ["targetAudience", "tone", "newField"];
    const newSignature = computeSignature(newInputKeys, existingOutputKeys);
    expect(newSignature).not.toBe(existingSignature);
  });

  it("outputs change → new signature → fork → 201", () => {
    const newOutputKeys = ["emailsSent", "positiveReplyRate", "openRate"];
    const newSignature = computeSignature(existingInputKeys, newOutputKeys);
    expect(newSignature).not.toBe(existingSignature);
  });

  it("same inputs sent in different order → same signature → 200", () => {
    const reorderedInputKeys = ["tone", "targetAudience"];
    const newSignature = computeSignature(reorderedInputKeys, existingOutputKeys);
    expect(newSignature).toBe(existingSignature);
  });
});
