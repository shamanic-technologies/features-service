import { describe, expect, it } from "vitest";
import { buildMessageWrittenBy, buildWrittenBy, underTestOf, vendorOf, type VersionVerdict, type WriterRecord } from "./written-by.js";

const MODELS = [
  { modelId: "claude-opus-5-5", displayName: "Claude Opus 5.5", provider: "anthropic", capabilityTier: "frontier", aliases: ["opus"], formerAliases: [] },
  { modelId: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", provider: "anthropic", capabilityTier: "strong", aliases: ["sonnet"], formerAliases: [] },
];
const TACTICS = new Map([
  ["blind-angle", { id: "blind-angle", name: "Blind angle", clientLine: "Brand not named in the first email" }],
  ["fresh-contacts-only", { id: "fresh-contacts-only", name: "Fresh contacts only", clientLine: "Skips anyone you emailed in the last 3 months" }],
  ["named-angle", { id: "named-angle", name: "Named angle", clientLine: "Brand named in the email" }],
  ["catch-all", { id: "catch-all", name: "Catch all", clientLine: null }],
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
      tactics: [{ name: "Blind angle", line: "Brand not named in the first email" }, { name: "Fresh contacts only", line: "Skips anyone you emailed in the last 3 months" }],
      tacticsUnavailableReason: null,
      underTest: true,
      underTestUnavailableReason: null,
    });
    expect(older.model?.name).toBe("Claude Sonnet 5.5");
    expect(older.tactics).toEqual([{ name: "Named angle", line: "Brand named in the email" }]);
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

  const resolved = (entries: Array<[string, { modelIds: string[][]; reason?: string | null; sentByOurRun?: boolean }]>) =>
    new Map(entries.map(([id, r]) => [id, { modelIds: r.modelIds, reason: (r.reason ?? null) as never, sentByOurRun: r.sentByOurRun ?? true }]));

  it("names the model the ledger billed for the writing, any channel, never the one the version asks for", () => {
    const [email, whatsapp] = buildMessageWrittenBy({
      ...base,
      maturityByDynasty: maturity,
      messages: [msg("subj-1", "workflow", BLIND.workflowSlug), msg("crm-9", "workflow", "ai-follow-up-email-algenib-v16", { channel: "whatsapp", campaignId: null })],
      resolved: resolved([
        ["subj-1", { modelIds: [["claude-sonnet-5-5"]] }],
        ["crm-9", { modelIds: [["claude-opus-5-5"], ["claude-sonnet-5-5"]] }],
      ]),
    });
    expect(email).toMatchObject({ id: "subj-1", writtenBy: "workflow", model: { name: "Claude Sonnet 5.5" }, underTest: true, tactics: [{ name: "Blind angle", line: "Brand not named in the first email" }, { name: "Fresh contacts only", line: "Skips anyone you emailed in the last 3 months" }] });
    expect(whatsapp).toMatchObject({ id: "crm-9", channel: "whatsapp", writtenBy: "workflow", model: { name: "Claude Opus 5.5", vendor: { id: "anthropic", name: "Anthropic" } }, modelUnavailableReason: null, underTest: false });
  });

  it("a message lead-service cannot place but whose send our run declared is our AI's (script era: no version)", () => {
    const [m] = buildMessageWrittenBy({ ...base, maturityByDynasty: maturity, messages: [msg("s", "unknown", null)], resolved: resolved([["s", { modelIds: [["claude-opus-5-5"]] }]]) });
    expect(m).toMatchObject({ writtenBy: "workflow", model: { name: "Claude Opus 5.5" }, modelUnavailableReason: null, tactics: [], tacticsUnavailableReason: "no_workflow_recorded" });
  });

  it("a message a person sent, or whose writer is not on record, says so and names no model; a missing fact is a named reason", () => {
    const [person, unknown, noSend, noLlm] = buildMessageWrittenBy({
      ...base,
      maturityByDynasty: maturity,
      messages: [msg("a", "person", null), msg("b", "unknown", null), msg("c", "workflow", null), msg("d", "workflow", null)],
      resolved: resolved([
        ["b", { modelIds: [], reason: "no_send_in_ledger", sentByOurRun: false }],
        ["c", { modelIds: [], reason: "no_send_in_ledger", sentByOurRun: false }],
        ["d", { modelIds: [], reason: "no_llm_billed" }],
      ]),
    });
    expect(person).toMatchObject({ writtenBy: "person", model: null, modelUnavailableReason: "written_by_a_person", tactics: [], underTest: null });
    expect(unknown).toMatchObject({ writtenBy: "unknown", modelUnavailableReason: "writer_unknown", tacticsUnavailableReason: "writer_unknown" });
    expect(noSend).toMatchObject({ writtenBy: "workflow", model: null, modelUnavailableReason: "no_send_in_ledger", tacticsUnavailableReason: "no_workflow_recorded" });
    expect(noLlm).toMatchObject({ model: null, modelUnavailableReason: "no_llm_billed" });
  });

  it("a model chat-service does not name reads model_not_served, never a guessed name", () => {
    const [m] = buildMessageWrittenBy({ ...base, maturityByDynasty: maturity, messages: [msg("z", "workflow", null)], resolved: resolved([["z", { modelIds: [["glm-9"]] }]]) });
    expect(m).toMatchObject({ model: null, modelUnavailableReason: "model_not_served" });
  });
});
