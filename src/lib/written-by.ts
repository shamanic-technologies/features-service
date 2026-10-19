/**
 * WHO WROTE A MESSAGE WE SENT FOR A CLIENT, AND HOW (owner 2026-10-19, WRITTEN-BY-1019). A client read one of their
 * cold emails ("There is no mention of CeXO, or the website - is it ok ?"): it came from a workflow version under test
 * that never names the brand in the first email. On every message we sent on their behalf, any channel, a client may
 * see the LLM that wrote it (public name + vendor) and the plain lines of the TACTICS of the workflow version that
 * wrote it, marked as being tested while that version is still learning. Never the workflow's name or id, never a cost.
 *
 * Pure. The writer record is content-generation-service's (one per generated sequence, campaign x person: the concrete
 * model it wrote with and the workflow version that asked), copied here (`generation_sequence_copy`). A tactic is shown
 * when Jev judged that version follows it (`workflow_tactic_verdicts`) AND the tactic states a client line.
 */
import type { ServedModel } from "./model-ids-client.js";
import type { Tactic } from "./plays.js";

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
  /** One plain line per tactic the writing version follows, in tactic id order. */
  tactics: Array<{ line: string }>;
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

/** PURE. One entry per writer record, newest first. */
export function buildWrittenBy(input: {
  records: readonly WriterRecord[];
  verdicts: readonly VersionVerdict[];
  tactics: ReadonlyMap<string, Pick<Tactic, "id" | "clientLine">>;
  /** null = chat-service's model list could not be read. */
  models: readonly ServedModel[] | null;
  /** dynasty -> maturity verdicts on its pipes; absent dynasty = not ranked anywhere; null map = ranking unreadable. */
  maturityByDynasty: ReadonlyMap<string, ReadonlyArray<boolean | null>> | null;
}): WrittenByEntry[] {
  const verdictsOf = new Map<string, VersionVerdict[]>();
  for (const v of input.verdicts) verdictsOf.set(v.workflowSlug, [...(verdictsOf.get(v.workflowSlug) ?? []), v]);
  const records = [...input.records].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.campaignId < b.campaignId ? -1 : 1));
  return records.map((r) => {
    const served = input.models?.find((m) => m.modelId === r.model) ?? null;
    const own = r.workflowSlug ? (verdictsOf.get(r.workflowSlug) ?? []) : [];
    const lines = own
      .filter((v) => v.verdict)
      .map((v) => input.tactics.get(v.tacticId))
      .filter((t): t is Pick<Tactic, "id" | "clientLine"> => !!t && typeof t.clientLine === "string" && t.clientLine.length > 0)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((t) => ({ line: t.clientLine as string }));
    const dynasty = own[0]?.workflowDynastySlug ?? null;
    let underTest: boolean | null = null;
    let underTestReason: UnderTestUnavailableReason | null = null;
    if (!r.workflowSlug) underTestReason = "no_workflow_recorded";
    else if (!dynasty) underTestReason = "not_judged_yet";
    else if (!input.maturityByDynasty) underTestReason = "ranking_unreadable";
    else {
      underTest = underTestOf(input.maturityByDynasty.get(dynasty) ?? []);
      if (underTest === null) underTestReason = "not_ranked_on_any_pipe";
    }
    return {
      campaignId: r.campaignId,
      writtenAt: r.createdAt.toISOString(),
      model: served ? { name: served.displayName, vendor: vendorOf(served.provider) } : null,
      modelUnavailableReason: served ? null : input.models ? "model_not_served" : "model_names_unreadable",
      tactics: lines,
      tacticsUnavailableReason: !r.workflowSlug ? "no_workflow_recorded" : own.length === 0 ? "not_judged_yet" : null,
      underTest,
      underTestUnavailableReason: underTestReason,
    };
  });
}
