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
import { resolveModelAlias } from "./research/writers.js";

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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * PURE. The model alias a workflow version WRITES with: its content-generation `/generate` step's body `model`, else its
 * chat-service `/complete` step's (a workflow drafting its own message). Null when no writing step names a model.
 */
export function writingModelAliasOfDag(dag: unknown): string | null {
  const nodes = isRecord(dag) && Array.isArray(dag.nodes) ? dag.nodes : [];
  const bodies = (service: string, path: string | null) =>
    nodes
      .map((n) => (isRecord(n) && isRecord(n.config) ? n.config : null))
      .filter((c): c is Record<string, unknown> => !!c && c.service === service && (path === null || c.path === path) && isRecord(c.body))
      .map((c) => c.body as Record<string, unknown>);
  for (const body of [...bodies("content-generation", null).filter((b) => typeof b.type === "string"), ...bodies("chat", "/complete")]) {
    if (typeof body.model === "string" && body.model) return body.model;
  }
  return null;
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

export interface MessageWrittenBy {
  /** lead-service's message id: the timeline fact id (outreach subject key) or the Unibox (crm) fact id. */
  id: string;
  kind: string;
  channel: string | null;
  campaignId: string | null;
  sentAt: string | null;
  /** `workflow` = one of our AI workflows wrote it; `person` = a person sent it; `unknown` = not on record. */
  writtenBy: MessageWriter;
  model: WrittenByEntry["model"];
  modelUnavailableReason: ModelUnavailableReason | "written_by_a_person" | "writer_unknown" | "no_workflow_recorded" | "model_not_recorded" | null;
  tactics: WrittenByEntry["tactics"];
  tacticsUnavailableReason: TacticsUnavailableReason | "written_by_a_person" | "writer_unknown" | null;
  underTest: boolean | null;
  underTestUnavailableReason: UnderTestUnavailableReason | "written_by_a_person" | "writer_unknown" | null;
}

/**
 * PURE. One row per message we sent the person, in lead-service's order. Model: the version's writer record on the
 * message's campaign (the latest written at or before the send) when one exists, else the model its DAG writes with.
 */
export function buildMessageWrittenBy(
  input: WrittenByInput & {
    messages: readonly SentMessage[];
    records: readonly WriterRecord[];
    /** workflow version slug -> the model alias its writing step names (null = names none); absent = DAG not read. */
    dagModelAliasOf: ReadonlyMap<string, string | null>;
  },
): MessageWrittenBy[] {
  const versionOf = versionBlocks(input);
  return input.messages.map((m) => {
    const head = { id: m.id, kind: m.kind, channel: m.channel, campaignId: m.campaignId, sentAt: m.sentAt, writtenBy: m.writtenBy.by };
    if (m.writtenBy.by !== "workflow") {
      const reason = m.writtenBy.by === "person" ? ("written_by_a_person" as const) : ("writer_unknown" as const);
      return { ...head, model: null, modelUnavailableReason: reason, tactics: [], tacticsUnavailableReason: reason, underTest: null, underTestUnavailableReason: reason };
    }
    const slug = m.writtenBy.workflowSlug;
    const campaign = m.campaignId ?? m.writtenBy.campaignId;
    const sentAt = m.sentAt ? Date.parse(m.sentAt) : null;
    const record = slug
      ? input.records
          .filter((r) => r.workflowSlug === slug && r.campaignId === campaign && (sentAt === null || r.createdAt.getTime() <= sentAt))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
      : undefined;
    let modelBlock: Pick<MessageWrittenBy, "model" | "modelUnavailableReason">;
    if (!slug) modelBlock = { model: null, modelUnavailableReason: "no_workflow_recorded" };
    else if (record) modelBlock = modelBlockOf(record.model, input.models);
    else {
      const alias = input.dagModelAliasOf.get(slug) ?? null;
      const resolved = alias && input.models ? resolveModelAlias(alias, input.models) : null;
      modelBlock = resolved ? modelBlockOf(resolved.id, input.models) : alias && !input.models ? modelBlockOf(null, null) : { model: null, modelUnavailableReason: "model_not_recorded" };
    }
    return { ...head, ...modelBlock, ...versionOf(slug) };
  });
}
