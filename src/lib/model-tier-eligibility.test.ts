/**
 * THE RULE ITSELF — three cases, and the two the study is silent about must stay silent.
 *
 * Each case asserts the DIVERGENCE between what two legs say about the SAME workflow, so a suite that
 * only checked "a verdict came back" would pass on an implementation that returned `eligible: true`
 * for everything (which is exactly the inert version this ship must not be).
 */
import { describe, it, expect } from "vitest";
import {
  CAPABILITY_TIERS,
  eligibleTiersForStep,
  isCapabilityTier,
  modelEligibilityFor,
  type CapabilityTier,
} from "./model-tier-eligibility.js";
import { CHANNEL_STEP_KEYS, CHANNEL_STEPS, type ChannelStepKey } from "./acquisition-channels.js";

/**
 * chat-service's DEPLOYED catalogue, copied verbatim off `GET /internal/models` in production on
 * 2026-09-14. Pinned rather than paraphrased, because it contains TWO aliases a substring rule gets
 * wrong and both are load-bearing here: `flash-pro` is CHEAP despite containing "pro", and
 * `deepseek-pro` is CHEAP because both DeepSeek aliases point at V4.1 Flash (chat-service#446).
 */
const TIERS = new Map<string, CapabilityTier>([
  ["haiku", "cheap"],
  ["sonnet", "strong"],
  ["opus", "frontier"],
  ["fable", "frontier"],
  ["flash-lite", "cheap"],
  ["flash", "cheap"],
  ["flash-pro", "cheap"],
  ["pro", "strong"],
  ["deepseek-flash", "cheap"],
  ["deepseek-pro", "cheap"],
  ["glm-flash", "cheap"],
  ["glm-pro", "strong"],
  ["kimi-flash", "cheap"],
  ["kimi-pro", "strong"],
  ["gpt-pro", "frontier"],
]);

const verdict = (step: ChannelStepKey, modelAlias: string | null, tiers = TIERS as ReadonlyMap<string, CapabilityTier> | null) =>
  modelEligibilityFor({
    stepLabel: CHANNEL_STEPS[step].label,
    restriction: eligibleTiersForStep(step),
    modelAlias,
    tierByAlias: tiers,
  });

describe("the rule: which capability tiers a leg may be served by", () => {
  it("lets ONLY the strong and frontier tiers sell a CONVERSATION", () => {
    expect(eligibleTiersForStep("conversation")).toEqual(["strong", "frontier"]);
    expect(verdict("conversation", "pro").eligible).toBe(true);
    expect(verdict("conversation", "fable").eligible).toBe(true);
    expect(verdict("conversation", "flash").eligible).toBe(false);
    expect(verdict("conversation", "glm-flash").eligible).toBe(false);
  });

  it("lets ONLY the cheap tier sell a WEBSITE VISIT — the exact inverse, on the same workflows", () => {
    expect(eligibleTiersForStep("website_visit")).toEqual(["cheap"]);
    for (const alias of ["flash", "glm-flash", "flash-pro", "deepseek-flash", "haiku"]) {
      expect(verdict("conversation", alias).eligible).toBe(false);
      expect(verdict("website_visit", alias).eligible).toBe(true);
    }
    for (const alias of ["pro", "sonnet", "opus", "fable", "gpt-pro"]) {
      expect(verdict("conversation", alias).eligible).toBe(true);
      expect(verdict("website_visit", alias).eligible).toBe(false);
    }
  });

  it("restricts NOTHING on every other step — the study said nothing about them, so nor do we", () => {
    const silent = CHANNEL_STEP_KEYS.filter((k) => k !== "conversation" && k !== "website_visit");
    expect(silent.length).toBeGreaterThan(0);
    for (const step of silent) {
      expect(eligibleTiersForStep(step)).toBeNull();
      for (const alias of TIERS.keys()) {
        const v = verdict(step, alias);
        expect(v.eligible).toBe(true);
        expect(v.ineligibleReason).toBeNull();
        // The tier is still STATED where it decides nothing — a surface listing the models a campaign
        // could run should be able to name them.
        expect(v.modelTier).toBe(TIERS.get(alias));
      }
    }
  });

  it("pins the two aliases a substring rule gets wrong, so no refactor can re-derive them", () => {
    // `flash-pro` resolves to a Flash model; `deepseek-pro` points at V4.1 Flash (chat-service#446).
    for (const alias of ["flash-pro", "deepseek-pro"]) {
      expect(TIERS.get(alias)).toBe("cheap");
      expect(verdict("conversation", alias)).toMatchObject({ modelTier: "cheap", eligible: false });
    }
    // The substring rule a lazy implementation would reach for says the opposite for all three.
    expect(verdict("conversation", "pro").eligible).toBe(true);
    expect(verdict("conversation", "glm-pro").eligible).toBe(true);
  });
});

describe("an unknowable tier is ELIGIBLE, and says which gap it is", () => {
  it("keeps a workflow whose DAG names NO model eligible", () => {
    const v = verdict("conversation", null);
    expect(v.eligible).toBe(true);
    expect(v.modelTier).toBeNull();
    expect(v.ineligibleReason).toBeNull();
    expect(v.unknownTierReason).toContain("names no content model");
  });

  it("keeps a workflow naming an alias the catalogue does not carry eligible", () => {
    const v = verdict("conversation", "some-model-nobody-recorded");
    expect(v.eligible).toBe(true);
    expect(v.modelTier).toBeNull();
    expect(v.modelAlias).toBe("some-model-nobody-recorded");
    expect(v.unknownTierReason).toContain("carries no entry for the alias");
  });

  it("keeps EVERY workflow eligible when the tier catalogue could not be read at all", () => {
    for (const alias of ["flash", "pro", null]) {
      const v = verdict("conversation", alias, null);
      expect(v.eligible).toBe(true);
      expect(v.modelTier).toBeNull();
      expect(v.unknownTierReason).toContain("could not be read on this request");
    }
  });

  it("tells a failed WORKFLOW read apart from a workflow that states no model", () => {
    const unavailable = modelEligibilityFor({
      stepLabel: "Conversation",
      restriction: eligibleTiersForStep("conversation"),
      modelAlias: null,
      modelsUnavailable: true,
      tierByAlias: TIERS,
    });
    expect(unavailable.eligible).toBe(true);
    expect(unavailable.unknownTierReason).toContain("workflow-service could not be asked");
    expect(unavailable.unknownTierReason).not.toBe(verdict("conversation", null).unknownTierReason);
  });
});

describe("the reason a human reads", () => {
  it("names the model, its tier, what the leg sells and the tiers that do work", () => {
    const v = verdict("conversation", "flash");
    expect(v.eligible).toBe(false);
    expect(v.ineligibleReason).toContain('"flash"');
    expect(v.ineligibleReason).toContain("cheap-tier");
    expect(v.ineligibleReason).toContain("Conversation");
    expect(v.ineligibleReason).toContain("strong and frontier");
  });

  it("reads naturally for the single-tier restriction too", () => {
    const v = verdict("website_visit", "fable");
    expect(v.eligible).toBe(false);
    expect(v.ineligibleReason).toContain("frontier-tier");
    expect(v.ineligibleReason).toContain("Website visit");
    expect(v.ineligibleReason).toContain("on the cheap tier");
    expect(v.ineligibleReason).not.toContain("tiers");
  });

  it("states a reason ⟺ the row is ineligible, and an unknown-tier reason ⟺ the tier is null", () => {
    for (const step of CHANNEL_STEP_KEYS) {
      for (const alias of [...TIERS.keys(), null, "unknown-alias"]) {
        const v = verdict(step, alias);
        expect(v.ineligibleReason === null).toBe(v.eligible);
        expect(v.unknownTierReason === null).toBe(v.modelTier !== null);
      }
    }
  });
});

describe("the tier vocabulary is chat-service's, taken as data", () => {
  it("knows the three levels and refuses anything else", () => {
    expect(CAPABILITY_TIERS).toEqual(["cheap", "strong", "frontier"]);
    for (const t of CAPABILITY_TIERS) expect(isCapabilityTier(t)).toBe(true);
    for (const bad of ["Cheap", "premium", "", null, undefined, 3, {}]) expect(isCapabilityTier(bad)).toBe(false);
  });
});
