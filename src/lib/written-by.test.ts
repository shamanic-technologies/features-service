import { describe, expect, it } from "vitest";
import { buildWrittenBy, underTestOf, vendorOf, type VersionVerdict, type WriterRecord } from "./written-by.js";

const MODELS = [
  { modelId: "claude-opus-5-5", displayName: "Claude Opus 5.5", provider: "anthropic", capabilityTier: "frontier", aliases: ["opus"], formerAliases: [] },
  { modelId: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", provider: "anthropic", capabilityTier: "strong", aliases: ["sonnet"], formerAliases: [] },
];
const TACTICS = new Map([
  ["blind-angle", { id: "blind-angle", clientLine: "Brand not named in the first email" }],
  ["fresh-contacts-only", { id: "fresh-contacts-only", clientLine: "Skips anyone you emailed in the last 3 months" }],
  ["named-angle", { id: "named-angle", clientLine: "Brand named in the email" }],
  ["catch-all", { id: "catch-all", clientLine: null }],
]);
const verdict = (workflowSlug: string, tacticId: string, v: boolean, dynasty = workflowSlug.replace(/-v\d+$/, "")): VersionVerdict => ({ workflowSlug, workflowDynastySlug: dynasty, tacticId, verdict: v });

// The CeXO AI email of 2026-10-19: the blind version under test, beside the named one.
const BLIND: WriterRecord = { campaignId: "cb8704c3-8763-4739-8c19-48f7ef2b13bd", model: "claude-opus-5-5", workflowSlug: "sales-cold-email-outreach-ainalrami-v2", createdAt: new Date("2026-10-19T05:38:48.854Z") };
const NAMED: WriterRecord = { campaignId: "cb8704c3-8763-4739-8c19-48f7ef2b13bd", model: "claude-sonnet-5-5", workflowSlug: "sales-cold-email-outreach-muliphein-v2", createdAt: new Date("2026-10-18T09:00:00.000Z") };
const VERDICTS = [
  verdict(BLIND.workflowSlug!, "blind-angle", true),
  verdict(BLIND.workflowSlug!, "fresh-contacts-only", true),
  verdict(BLIND.workflowSlug!, "named-angle", false),
  verdict(BLIND.workflowSlug!, "catch-all", true),
  verdict(NAMED.workflowSlug!, "named-angle", true),
];

describe("buildWrittenBy (WRITTEN-BY-1019)", () => {
  it("names the model by its public name and vendor and lists the client lines of the tactics the version follows", () => {
    const [entry, older] = buildWrittenBy({
      records: [NAMED, BLIND],
      verdicts: VERDICTS,
      tactics: TACTICS,
      models: MODELS,
      maturityByDynasty: new Map([
        ["sales-cold-email-outreach-ainalrami", [false]],
        ["sales-cold-email-outreach-muliphein", [true]],
      ]),
    });
    expect(entry).toEqual({
      campaignId: BLIND.campaignId,
      writtenAt: "2026-10-19T05:38:48.854Z",
      model: { name: "Claude Opus 5.5", vendor: { id: "anthropic", name: "Anthropic" } },
      modelUnavailableReason: null,
      // A "no" verdict and a tactic with no client line are never listed.
      tactics: [{ line: "Brand not named in the first email" }, { line: "Skips anyone you emailed in the last 3 months" }],
      tacticsUnavailableReason: null,
      underTest: true,
      underTestUnavailableReason: null,
    });
    expect(older.model?.name).toBe("Claude Sonnet 5.5");
    expect(older.tactics).toEqual([{ line: "Brand named in the email" }]);
    expect(older.underTest).toBe(false);
  });

  it("never serves a workflow name, id or cost", () => {
    const body = JSON.stringify(buildWrittenBy({ records: [BLIND], verdicts: VERDICTS, tactics: TACTICS, models: MODELS, maturityByDynasty: new Map() }));
    expect(body).not.toMatch(/ainalrami|workflow|cost|usd/i);
  });

  it("says why each part is unknown, never a guess", () => {
    const [noWorkflow] = buildWrittenBy({ records: [{ ...BLIND, workflowSlug: null }], verdicts: [], tactics: TACTICS, models: null, maturityByDynasty: new Map() });
    expect(noWorkflow).toMatchObject({ model: null, modelUnavailableReason: "model_names_unreadable", tactics: [], tacticsUnavailableReason: "no_workflow_recorded", underTest: null, underTestUnavailableReason: "no_workflow_recorded" });
    const [unjudged] = buildWrittenBy({ records: [{ ...BLIND, model: "some-new-model" }], verdicts: [], tactics: TACTICS, models: MODELS, maturityByDynasty: new Map() });
    expect(unjudged).toMatchObject({ model: null, modelUnavailableReason: "model_not_served", tacticsUnavailableReason: "not_judged_yet", underTestUnavailableReason: "not_judged_yet" });
    const [rankingDown] = buildWrittenBy({ records: [BLIND], verdicts: VERDICTS, tactics: TACTICS, models: MODELS, maturityByDynasty: null });
    expect(rankingDown).toMatchObject({ underTest: null, underTestUnavailableReason: "ranking_unreadable" });
    const [unranked] = buildWrittenBy({ records: [BLIND], verdicts: VERDICTS, tactics: TACTICS, models: MODELS, maturityByDynasty: new Map() });
    expect(unranked).toMatchObject({ underTest: null, underTestUnavailableReason: "not_ranked_on_any_pipe" });
  });

  it("a workflow is under test until it is mature on one of its pipes", () => {
    expect(underTestOf([false])).toBe(true);
    expect(underTestOf([false, true])).toBe(false);
    expect(underTestOf([null, false])).toBe(true);
    expect(underTestOf([null])).toBeNull();
    expect(underTestOf([])).toBeNull();
  });

  it("names a vendor it has no word for by its id, capitalised", () => {
    expect(vendorOf("openai")).toEqual({ id: "openai", name: "OpenAI" });
    expect(vendorOf("acme")).toEqual({ id: "acme", name: "Acme" });
  });
});
