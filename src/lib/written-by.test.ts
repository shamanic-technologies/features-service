import { describe, expect, it } from "vitest";
import { buildMessageWrittenBy, buildWrittenBy, underTestOf, vendorOf, writingModelAliasOfDag, type VersionVerdict, type WriterRecord } from "./written-by.js";

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

describe("buildMessageWrittenBy: every message, any channel (WRITTEN-BY-1019-SENDER)", () => {
  const base = { verdicts: [...VERDICTS, verdict("ai-follow-up-email-algenib-v16", "fresh-contacts-only", true)], tactics: TACTICS, models: MODELS };
  const maturity = new Map([
    ["sales-cold-email-outreach-ainalrami", [false]],
    ["ai-follow-up-email-algenib", [true]],
  ]);
  const msg = (id: string, by: "workflow" | "person" | "unknown", workflowSlug: string | null, extra: Partial<{ channel: string | null; campaignId: string | null; sentAt: string | null }> = {}) => ({
    id,
    kind: "email_sent",
    channel: "email",
    campaignId: BLIND.campaignId,
    sentAt: "2026-10-19T06:00:00.000Z",
    writtenBy: { by, workflowSlug, campaignId: extra.campaignId ?? BLIND.campaignId },
    ...extra,
  });

  it("a sequence email reads its writer record's concrete model; a self-drafted WhatsApp follow-up reads the model its DAG asks for", () => {
    const [email, whatsapp] = buildMessageWrittenBy({
      ...base,
      maturityByDynasty: maturity,
      records: [BLIND],
      messages: [msg("subj-1", "workflow", BLIND.workflowSlug), msg("crm-9", "workflow", "ai-follow-up-email-algenib-v16", { channel: "whatsapp", campaignId: null })],
      dagModelAliasOf: new Map([["ai-follow-up-email-algenib-v16", "opus"]]),
    });
    expect(email).toMatchObject({ id: "subj-1", writtenBy: "workflow", model: { name: "Claude Opus 5.5" }, underTest: true, tactics: [{ line: "Brand not named in the first email" }, { line: "Skips anyone you emailed in the last 3 months" }] });
    expect(whatsapp).toMatchObject({ id: "crm-9", channel: "whatsapp", writtenBy: "workflow", model: { name: "Claude Opus 5.5", vendor: { id: "anthropic", name: "Anthropic" } }, modelUnavailableReason: null, underTest: false, tactics: [{ line: "Skips anyone you emailed in the last 3 months" }] });
  });

  it("a message a person sent, or whose writer is not on record, says so and names no model", () => {
    const [person, unknown, noSlug] = buildMessageWrittenBy({ ...base, maturityByDynasty: maturity, records: [], messages: [msg("a", "person", null), msg("b", "unknown", null), msg("c", "workflow", null)], dagModelAliasOf: new Map() });
    expect(person).toMatchObject({ writtenBy: "person", model: null, modelUnavailableReason: "written_by_a_person", tactics: [], underTest: null });
    expect(unknown).toMatchObject({ writtenBy: "unknown", modelUnavailableReason: "writer_unknown", tacticsUnavailableReason: "writer_unknown" });
    expect(noSlug).toMatchObject({ writtenBy: "workflow", modelUnavailableReason: "no_workflow_recorded", tacticsUnavailableReason: "no_workflow_recorded" });
  });

  it("a writer record written AFTER the send is not the one that wrote it", () => {
    const [m] = buildMessageWrittenBy({ ...base, maturityByDynasty: maturity, records: [BLIND], messages: [msg("x", "workflow", BLIND.workflowSlug, { sentAt: "2026-10-18T00:00:00.000Z" })], dagModelAliasOf: new Map() });
    expect(m).toMatchObject({ model: null, modelUnavailableReason: "model_not_recorded" });
  });

  it("reads the model a version writes with off its DAG: the generate step first, else the /complete step", () => {
    const gen = { service: "content-generation", path: "/generate", body: { type: "blind-discovery-email-v15", model: "opus" } };
    const judge = { service: "chat", path: "/orgs/judgments", body: { model: "haiku" } };
    const draft = { service: "chat", path: "/complete", body: { model: "sonnet" } };
    expect(writingModelAliasOfDag({ nodes: [{ config: judge }, { config: draft }, { config: gen }] })).toBe("opus");
    expect(writingModelAliasOfDag({ nodes: [{ config: judge }, { config: draft }] })).toBe("sonnet");
    expect(writingModelAliasOfDag({ nodes: [{ config: judge }] })).toBeNull();
    expect(writingModelAliasOfDag(null)).toBeNull();
  });
});
