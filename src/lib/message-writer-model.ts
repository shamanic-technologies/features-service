/**
 * THE MODEL THAT ACTUALLY WROTE A MESSAGE WE SENT (owner 2026-11-26, MODEL-TAG-EVERY-AI-MESSAGE-1126: « remplacer ce
 * tag automated par le tag où tu mettais le logo + nom du LLM utilisé », on every message our AI wrote). PURE.
 *
 * One rule for every channel, read off runs-service's ledger (the cost-accounting books), never off what a script,
 * workflow version or template ASKS for: on our platform key a rate-limited model is silently served by another
 * (prod 2026-11-24, Living Vital: the writer asked DeepSeek Flash, chat-service billed GLM 5.3 Flash).
 *
 *  1. The SEND: the `message_sent` Unit our run declared for the person, found by a recorded fact only:
 *       a. the run lead-service names for the message (`writtenBy.runId`) when that run declared the send, else
 *       b. the send declared at the message's own instant, to the millisecond (the sender declares the Unit at the
 *          time it records the send: every email of the last 7 days matched exactly, 4,078 of 4,078); two runs at
 *          that instant = ambiguous, never picked. Never a nearest time.
 *  2. The WRITING: the `message_written` Unit that send consumed; its producing run is the writing run (one only).
 *     No send in the ledger: the run lead-service states wrote it (workflow era: the writing ran inside that run).
 *  3. The MODEL: the LLM cost lines billed (not cancelled) in the writing run's tree, through chat-service's cost-name
 *     catalogue (exact names, never parsed). Several models billed = the one billed LAST (the call whose text was
 *     kept: a writer's later call rewrites the earlier one); every one is listed.
 * Anything missing = null + a named reason, never a guess.
 */

/** One ledger occurrence on the person, as runs-service `GET /internal/outcome-occurrences` serves it. */
export interface LedgerOccurrence {
  id: string;
  runId: string;
  organizationId: string | null;
  direction: "produced" | "consumed";
  outcomeKey: string;
  declaredAt: string;
  consumption: { sourceRunId: string | null; provenance: string } | null;
  reversal?: unknown;
}

/** One cost line of a run tree (runs-service `GET /v1/runs/:id`, own + descendants). */
export interface RunCostLine {
  costName: string;
  status: string;
  createdAt: string;
}

export type WriterRunReason =
  | "ledger_unreadable"
  | "no_send_in_ledger"
  | "send_ambiguous_in_ledger"
  | "no_writing_in_ledger"
  | "several_writings_in_ledger";

export type ModelResolutionReason =
  | WriterRunReason
  | "writing_run_unreadable"
  | "no_llm_billed"
  | "llm_cost_names_unreadable"
  | "model_names_unreadable"
  | "model_not_served";

export interface WriterRun {
  /** The writing run (internal: never served to a client). */
  runId: string | null;
  /** True when the ledger holds a send of ours for this message: our AI sent it. */
  sentByOurRun: boolean;
  reason: WriterRunReason | null;
}

const SENT = "message_sent";
const WRITTEN = "message_written";

const ms = (iso: string) => Date.parse(iso);

/** PURE: the writing run of one message (see the module doc, steps 1 and 2). */
export function writerRunOf(
  message: { sentAt: string | null; statedRunId: string | null },
  occurrences: readonly LedgerOccurrence[] | null,
): WriterRun {
  if (occurrences === null) return { runId: message.statedRunId, sentByOurRun: false, reason: message.statedRunId ? null : "ledger_unreadable" };
  const live = occurrences.filter((o) => !o.reversal);
  const sends = live.filter((o) => o.direction === "produced" && o.outcomeKey === SENT);
  let sendRun: string | null = null;
  if (message.statedRunId && sends.some((o) => o.runId === message.statedRunId)) sendRun = message.statedRunId;
  else if (message.sentAt !== null) {
    const at = ms(message.sentAt);
    const runs = [...new Set(sends.filter((o) => ms(o.declaredAt) === at).map((o) => o.runId))];
    if (runs.length > 1) return { runId: null, sentByOurRun: true, reason: "send_ambiguous_in_ledger" };
    sendRun = runs[0] ?? null;
  }
  if (sendRun === null) {
    return message.statedRunId ? { runId: message.statedRunId, sentByOurRun: false, reason: null } : { runId: null, sentByOurRun: false, reason: "no_send_in_ledger" };
  }
  const writers = [
    ...new Set(
      live
        .filter((o) => o.runId === sendRun && o.direction === "consumed" && o.outcomeKey === WRITTEN && o.consumption?.sourceRunId)
        .map((o) => o.consumption!.sourceRunId as string),
    ),
  ];
  if (writers.length === 0) return { runId: null, sentByOurRun: true, reason: "no_writing_in_ledger" };
  if (writers.length > 1) return { runId: null, sentByOurRun: true, reason: "several_writings_in_ledger" };
  return { runId: writers[0], sentByOurRun: true, reason: null };
}

/**
 * PURE: the concrete model ids billed in a run tree, the one billed LAST first (a cost name holding several ids keeps
 * the catalogue's order). Cancelled lines are no bill. Lines no LLM cost name covers are not a model.
 */
export function modelsBilled(lines: readonly RunCostLine[], modelsOfCostName: ReadonlyMap<string, readonly string[]>): string[][] {
  const billed = lines
    .filter((l) => l.status !== "cancelled" && modelsOfCostName.has(l.costName))
    .sort((a, b) => ms(b.createdAt) - ms(a.createdAt) || a.costName.localeCompare(b.costName));
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const l of billed) {
    const ids = modelsOfCostName.get(l.costName) as readonly string[];
    const key = ids.join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([...ids]);
  }
  return out;
}
