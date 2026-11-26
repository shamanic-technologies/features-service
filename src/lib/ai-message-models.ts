/**
 * AI MESSAGES WITH THE MODEL NAMED, PER DAY (owner 2026-11-26, MODEL-TAG-EVERY-AI-MESSAGE-1126; Monitoring's « AI
 * messages with no model named »). PURE.
 *
 * An AI message = a `message_sent` Unit one of our runs declared in runs-service's ledger (every channel, one rule) whose
 * sending run consumed a `message_written` Unit: what it sent was written by one of our runs. A send that consumed none
 * (a newsletter release: the text was written once, by hand) is counted apart (`sentNotWrittenByOurRuns`), never red.
 * Its model = the same rule as the client's « written by » read (`lib/message-writer-model.ts`): the run that wrote the
 * consumed Unit -> the LLM billed in that run's tree, the one billed last. An AI message without one names why
 * (`withoutByReason`), never a guessed model.
 */
import { modelsBilled, type ModelResolutionReason, type RunCostLine } from "./message-writer-model.js";

/** Bump with any change of what is counted: every stored day is then recomputed. */
export const AI_MESSAGE_MODELS_RULE = "ai-message-models-v2";

export interface DaySend {
  /** The run that declared the send. */
  runId: string;
  orgId: string | null;
}

export interface OrgDayTally {
  /** '' = the sending run names no org. */
  orgId: string;
  /** Sends whose run consumed no `message_written` Unit (not written by our runs). */
  sentNotWrittenByOurRuns: number;
  /** AI messages: sends whose run consumed a `message_written` Unit. */
  messages: number;
  withModel: number;
  withoutModel: number;
  withoutByReason: Partial<Record<ModelResolutionReason, number>>;
  /** Concrete model id (chat-service's) -> messages it wrote. */
  byModel: Record<string, number>;
}

/** PURE: one day's sends tallied per org. */
export function tallySends(input: {
  sends: readonly DaySend[];
  /** sending run -> the runs that produced the `message_written` Units it consumed (deduped). */
  writersOfSendRun: ReadonlyMap<string, readonly string[]>;
  /** writing run -> its tree's cost lines; null = unreadable. */
  linesOfWriter: ReadonlyMap<string, readonly RunCostLine[] | null>;
  /** cost name -> model ids; null = chat-service's catalogue unreadable. */
  catalogue: ReadonlyMap<string, readonly string[]> | null;
}): OrgDayTally[] {
  const byOrg = new Map<string, OrgDayTally>();
  for (const s of input.sends) {
    const org = s.orgId ?? "";
    const t = byOrg.get(org) ?? { orgId: org, sentNotWrittenByOurRuns: 0, messages: 0, withModel: 0, withoutModel: 0, withoutByReason: {}, byModel: {} };
    byOrg.set(org, t);
    const writers = input.writersOfSendRun.get(s.runId) ?? [];
    if (writers.length === 0) {
      t.sentNotWrittenByOurRuns += 1;
      continue;
    }
    t.messages += 1;
    let reason: ModelResolutionReason | null = null;
    let model: string | null = null;
    if (writers.length > 1) reason = "several_writings_in_ledger";
    else {
      const lines = input.linesOfWriter.get(writers[0]);
      if (lines == null) reason = "writing_run_unreadable";
      else if (!input.catalogue) reason = "llm_cost_names_unreadable";
      else {
        const billed = modelsBilled(lines, input.catalogue);
        if (billed.length === 0) reason = "no_llm_billed";
        else model = billed[0][0];
      }
    }
    if (model) {
      t.withModel += 1;
      t.byModel[model] = (t.byModel[model] ?? 0) + 1;
    } else {
      t.withoutModel += 1;
      const r = reason as ModelResolutionReason;
      t.withoutByReason[r] = (t.withoutByReason[r] ?? 0) + 1;
    }
  }
  return [...byOrg.values()].sort((a, b) => a.orgId.localeCompare(b.orgId));
}

/** PURE: org rows of one day summed into the fleet row. */
export function fleetOf(rows: readonly Omit<OrgDayTally, "orgId">[]): Omit<OrgDayTally, "orgId"> {
  const out: Omit<OrgDayTally, "orgId"> = { sentNotWrittenByOurRuns: 0, messages: 0, withModel: 0, withoutModel: 0, withoutByReason: {}, byModel: {} };
  for (const r of rows) {
    out.sentNotWrittenByOurRuns += r.sentNotWrittenByOurRuns;
    out.messages += r.messages;
    out.withModel += r.withModel;
    out.withoutModel += r.withoutModel;
    for (const [k, v] of Object.entries(r.withoutByReason)) out.withoutByReason[k as ModelResolutionReason] = (out.withoutByReason[k as ModelResolutionReason] ?? 0) + (v ?? 0);
    for (const [k, v] of Object.entries(r.byModel)) out.byModel[k] = (out.byModel[k] ?? 0) + v;
  }
  return out;
}
