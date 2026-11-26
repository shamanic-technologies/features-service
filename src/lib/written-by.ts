/**
 * WHO WROTE A MESSAGE WE SENT FOR A CLIENT, AND HOW (owner 2026-10-19, WRITTEN-BY-1019). A client read one of their
 * cold emails ("There is no mention of CeXO, or the website - is it ok ?"): it came from a workflow version under test
 * that never names the brand in the first email. On every message we sent on their behalf, any channel, a client may
 * see the LLM that wrote it (public name + vendor) and the plain lines of the TACTICS of the workflow version that
 * wrote it, marked as being tested while that version is still learning. Never the workflow's name or id, never a cost.
 *
 * Pure. Two producers, one rule for every channel:
 *  - `entries`: content-generation-service's writer records (one per generated sequence, campaign x person: the concrete
 *    model it wrote with and the workflow version that asked), copied here (`generation_sequence_copy`).
 *  - `messages`: every message we sent the person, any channel, with the workflow version that wrote it, as lead-service
 *    states it (`GET /internal/leads/{leadId}/sent-messages`, WRITTEN-BY-1019-SENDER). The model is the concrete one of
 *    the version's writer record on that campaign when one exists, else the model the version's writing step asks for
 *    (its DAG: the content-generation `/generate` step, else the chat-service `/complete` step), resolved by chat-service.
 * A tactic is shown when Jev judged that version follows it (`workflow_tactic_verdicts`) AND the tactic states a client line;
 * it is served as its catalogue NAME (the tag, e.g. "Blind angle", WRITTEN-WITH-TACTIC-NAMES-1019) beside that line (the tag's hover).
 */
import type { ServedModel } from "./model-ids-client.js";
import type { Tactic } from "./plays.js";
import type { ModelResolutionReason } from "./message-writer-model.js";

/** chat-service's vendor ids in the words a client reads (the dashboard keys the logo on `id`). */
const VENDOR_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  google: "Google",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  zai: "Z.ai",
  moonshot: "Moonshot AI",
  mistral: "Mistral AI",
  xai: "xAI",
};

export interface WriterRecord {
  campaignId: string;
  /** Concrete model id content-generation wrote with. */
  model: string;
  /** The workflow version that asked (null on a generation no workflow asked for). */
  workflowSlug: string | null;
  createdAt: Date;
}

export interface VersionVerdict {
  workflowSlug: string;
  workflowDynastySlug: string;
  tacticId: string;
  verdict: boolean;
}

export type ModelUnavailableReason = "model_names_unreadable" | "model_not_served";
export type TacticsUnavailableReason = "no_workflow_recorded" | "not_judged_yet";
export type UnderTestUnavailableReason = "no_workflow_recorded" | "not_judged_yet" | "ranking_unreadable" | "not_ranked_on_any_pipe";

export interface WrittenByEntry {
  campaignId: string;
  writtenAt: string;
  model: { name: string; vendor: { id: string; name: string } } | null;
  modelUnavailableReason: ModelUnavailableReason | null;
  /** One tag per tactic the writing version follows, in tactic id order: its catalogue name + its plain client line. */
  tactics: Array<{ name: string; line: string }>;
  tacticsUnavailableReason: TacticsUnavailableReason | null;
  /** True while the writing workflow is still being tested (learning) on its pipe; null + reason when unknown. */
  underTest: boolean | null;
  underTestUnavailableReason: UnderTestUnavailableReason | null;
}

export const vendorOf = (provider: string): { id: string; name: string } => ({
  id: provider,
  name: VENDOR_NAMES[provider] ?? (provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : provider),
});

/**
 * PURE. Is a workflow dynasty still under test? Its maturity verdict on every pipe it is assigned to: mature on one
 * pipe = proven there, not under test; learning on every pipe that judged it = under test; no verdict anywhere = null.
 */
export function underTestOf(verdicts: ReadonlyArray<boolean | null>): boolean | null {
  if (verdicts.some((v) => v === true)) return false;
  if (verdicts.some((v) => v === false)) return true;
  return null;
}

export interface WrittenByInput {
  verdicts: readonly VersionVerdict[];
  tactics: ReadonlyMap<string, Pick<Tactic, "id" | "name" | "clientLine">>;
  /** null = chat-service's model list could not be read. */
  models: readonly ServedModel[] | null;
  /** dynasty -> maturity verdicts on its pipes; absent dynasty = not ranked anywhere; null map = ranking unreadable. */
  maturityByDynasty: ReadonlyMap<string, ReadonlyArray<boolean | null>> | null;
}

type ModelBlock = Pick<WrittenByEntry, "model" | "modelUnavailableReason">;
type VersionBlock = Pick<WrittenByEntry, "tactics" | "tacticsUnavailableReason" | "underTest" | "underTestUnavailableReason">;

/** PURE. A concrete model id as the client reads it; null + reason when chat-service names none. */
function modelBlockOf(modelId: string | null, models: readonly ServedModel[] | null): ModelBlock {
  const served = modelId ? (models?.find((m) => m.modelId === modelId) ?? null) : null;
  if (served) return { model: { name: served.displayName, vendor: vendorOf(served.provider) }, modelUnavailableReason: null };
  return { model: null, modelUnavailableReason: models ? "model_not_served" : "model_names_unreadable" };
}

/** PURE. The tactic lines of one workflow VERSION and whether its workflow is still under test. */
function versionBlocks(input: WrittenByInput) {
  const verdictsOf = new Map<string, VersionVerdict[]>();
  for (const v of input.verdicts) verdictsOf.set(v.workflowSlug, [...(verdictsOf.get(v.workflowSlug) ?? []), v]);
  return (workflowSlug: string | null): VersionBlock => {
    const own = workflowSlug ? (verdictsOf.get(workflowSlug) ?? []) : [];
    const tactics = own
      .filter((v) => v.verdict)
      .map((v) => input.tactics.get(v.tacticId))
      .filter((t): t is Pick<Tactic, "id" | "name" | "clientLine"> => !!t && typeof t.clientLine === "string" && t.clientLine.length > 0)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((t) => ({ name: t.name, line: t.clientLine as string }));
    const dynasty = own[0]?.workflowDynastySlug ?? null;
    let underTest: boolean | null = null;
    let underTestUnavailableReason: UnderTestUnavailableReason | null = null;
    if (!workflowSlug) underTestUnavailableReason = "no_workflow_recorded";
    else if (!dynasty) underTestUnavailableReason = "not_judged_yet";
    else if (!input.maturityByDynasty) underTestUnavailableReason = "ranking_unreadable";
    else {
      underTest = underTestOf(input.maturityByDynasty.get(dynasty) ?? []);
      if (underTest === null) underTestUnavailableReason = "not_ranked_on_any_pipe";
    }
    return { tactics, tacticsUnavailableReason: !workflowSlug ? "no_workflow_recorded" : own.length === 0 ? "not_judged_yet" : null, underTest, underTestUnavailableReason };
  };
}

/** PURE. One entry per writer record, newest first. */
export function buildWrittenBy(input: WrittenByInput & { records: readonly WriterRecord[] }): WrittenByEntry[] {
  const versionOf = versionBlocks(input);
  const records = [...input.records].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.campaignId < b.campaignId ? -1 : 1));
  return records.map((r) => ({ campaignId: r.campaignId, writtenAt: r.createdAt.toISOString(), ...modelBlockOf(r.model, input.models), ...versionOf(r.workflowSlug) }));
}

/** One message we sent the person, as lead-service states it (`SentMessage`). */
export interface SentMessage {
  id: string;
  kind: string;
  channel: string | null;
  campaignId: string | null;
  sentAt: string | null;
  writtenBy: { by: "workflow" | "person" | "unknown"; workflowSlug: string | null; campaignId: string | null; runId?: string | null };
}

export type MessageWriter = "workflow" | "person" | "unknown";

/**
 * What the ledger says wrote one message (MODEL-TAG-EVERY-AI-MESSAGE-1126, `lib/message-writer-model.ts`): the
 * concrete model id(s) billed in its writing run, the one billed last first (empty = none), or why not, and whether
 * a run of ours declared its send.
 */
export interface ResolvedMessageModel {
  modelIds: string[][];
  reason: ModelResolutionReason | null;
  sentByOurRun: boolean;
}

export interface MessageWrittenBy {
  /** lead-service's message id: the timeline fact id (outreach subject key) or the Unibox (crm) fact id. */
  id: string;
  kind: string;
  channel: string | null;
  campaignId: string | null;
  sentAt: string | null;
  /** `workflow` = our AI wrote it; `person` = a person sent it; `unknown` = not on record. */
  writtenBy: MessageWriter;
  model: WrittenByEntry["model"];
  modelUnavailableReason: ModelResolutionReason | "written_by_a_person" | "writer_unknown" | null;
  tactics: WrittenByEntry["tactics"];
  tacticsUnavailableReason: TacticsUnavailableReason | "written_by_a_person" | "writer_unknown" | null;
  underTest: boolean | null;
  underTestUnavailableReason: UnderTestUnavailableReason | "written_by_a_person" | "writer_unknown" | null;
}

/** PURE: the first model id of the latest-billed group chat-service serves a public name for. */
function servedModelBlock(groups: readonly string[][], models: readonly ServedModel[] | null): ModelBlock {
  if (!models) return modelBlockOf(null, null);
  const latest = groups[0] ?? [];
  const id = latest.find((m) => models.some((s) => s.modelId === m)) ?? latest[0] ?? null;
  return modelBlockOf(id, models);
}

/**
 * PURE. One row per message we sent the person, in lead-service's order. The model is the one that ACTUALLY wrote it,
 * read off the ledger (`resolved`, MODEL-TAG-EVERY-AI-MESSAGE-1126), never the model a script, version or template
 * asks for. A message lead-service cannot place but whose send a run of ours declared is written by our AI.
 */
export function buildMessageWrittenBy(
  input: WrittenByInput & {
    messages: readonly SentMessage[];
    /** message id -> what the ledger says wrote it; absent = not resolved (a person's message). */
    resolved: ReadonlyMap<string, ResolvedMessageModel>;
  },
): MessageWrittenBy[] {
  const versionOf = versionBlocks(input);
  return input.messages.map((m) => {
    const resolved = input.resolved.get(m.id) ?? null;
    const writer: MessageWriter = m.writtenBy.by === "person" ? "person" : m.writtenBy.by === "workflow" || resolved?.sentByOurRun ? "workflow" : "unknown";
    const head = { id: m.id, kind: m.kind, channel: m.channel, campaignId: m.campaignId, sentAt: m.sentAt, writtenBy: writer };
    if (writer !== "workflow") {
      const reason = writer === "person" ? ("written_by_a_person" as const) : ("writer_unknown" as const);
      return { ...head, model: null, modelUnavailableReason: reason, tactics: [], tacticsUnavailableReason: reason, underTest: null, underTestUnavailableReason: reason };
    }
    let modelBlock: Pick<MessageWrittenBy, "model" | "modelUnavailableReason">;
    if (!resolved) modelBlock = { model: null, modelUnavailableReason: "no_send_in_ledger" };
    else if (resolved.modelIds.length > 0) modelBlock = servedModelBlock(resolved.modelIds, input.models);
    else modelBlock = { model: null, modelUnavailableReason: resolved.reason ?? "no_llm_billed" };
    const slug = m.writtenBy.by === "workflow" ? m.writtenBy.workflowSlug : null;
    return { ...head, ...modelBlock, ...versionOf(slug) };
  });
}
