/**
 * WHAT THE COMPLETION THAT WROTE EACH SEQUENCE COST (MODEL-RUN-COST-1024). content-generation-service states, per
 * sequence of its feed, the chat completion run(s) that wrote it (`lib/generation-sequences-copy.ts` copies them; two when the first
 * answer was unusable and regenerated: both are the cost of writing it); this sweep reads those runs' OWN cost rows from runs-service (`POST /v1/runs/batch`, org-scoped, ≤500 ids a call) and stores
 * them on the copied row, split in two:
 *
 *  - OUTPUT = the rows whose cost name is an output-token line (`…-tokens-output`, chat-service's naming of every model);
 *  - INPUT = every other row of the run (input tokens, cached input, cache writes: cache is FOLDED into input, so
 *    input + output = the whole run cost, owner 2026-10-24: cache does not matter to him).
 *
 * Money basis = billed GROSS, COMMITTED (actual + open holds), the basis of the Research model bars' spend. A run still
 * holding a provisioned row is stored `held` and re-read an hour later; a run runs-service does not return for the
 * sequence's org makes the row `run_not_found` (counted as a run with no cost, never $0). Read once per row otherwise: a charged
 * completion's cost does not move.
 */
import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { generationSequenceCopy } from "../db/schema.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { mapWithConcurrency } from "./concurrency.js";

const BATCH = 500;
const MAX_ROWS_PER_SWEEP = 20_000;
const SETTLE_MS = 5 * 60_000;
const HELD_REREAD_MS = 60 * 60_000;

export interface RunCostRow {
  costName: string;
  status: string;
  totalCostInUsdCents: string;
}

/** True for an output-token cost line (`google-flash-3.8-tokens-output`, `anthropic-haiku-5.5-tokens-output`). */
export const isOutputTokenCost = (costName: string): boolean => costName.endsWith("-tokens-output");

/** PURE. One completion run's committed cost, split input (cache folded in) vs output, exact decimal cents. */
export function splitCompletionCost(costs: readonly RunCostRow[]): { inputCents: string; outputCents: string; held: boolean } {
  let input = 0n;
  let output = 0n;
  let held = false;
  // numeric(16,10) cents: summed as integers of 1e-10 cents, so a run's parts add up to its total exactly.
  const units = (v: string): bigint => {
    const [i, f = ""] = v.trim().replace(/^\+/, "").split(".");
    const neg = i.startsWith("-");
    const whole = BigInt((neg ? i.slice(1) : i) || "0") * 10n ** 10n + BigInt((f + "0000000000").slice(0, 10));
    return neg ? -whole : whole;
  };
  for (const c of costs) {
    if (c.status !== "actual" && c.status !== "provisioned") continue;
    if (c.status === "provisioned") held = true;
    const u = units(c.totalCostInUsdCents);
    if (isOutputTokenCost(c.costName)) output += u;
    else input += u;
  }
  const text = (u: bigint) => {
    const neg = u < 0n;
    const a = neg ? -u : u;
    return `${neg ? "-" : ""}${a / 10n ** 10n}.${(a % 10n ** 10n).toString().padStart(10, "0")}`;
  };
  return { inputCents: text(input), outputCents: text(output), held };
}

interface DueRow {
  generationId: string;
  orgId: string;
  completionRunIds: string[];
}

async function readRunCosts(orgId: string, runIds: readonly string[]): Promise<Map<string, RunCostRow[]>> {
  const res = await fetchWithRetry(
    `${process.env.RUNS_SERVICE_URL}/v1/runs/batch`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.RUNS_SERVICE_API_KEY ?? "", "x-org-id": orgId },
      body: JSON.stringify({ runIds }),
    },
    { timeoutMs: 60_000 },
  );
  if (!res.ok) throw new Error(`runs-service /v1/runs/batch ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { runs?: Array<{ id: string; costs?: RunCostRow[] }> };
  if (!Array.isArray(body.runs)) throw new Error("runs-service /v1/runs/batch: malformed body");
  return new Map(body.runs.map((r) => [r.id, r.costs ?? []]));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the cost of every copied sequence whose completion run is due, oldest first. Returns rows stored. */
export async function sweepCompletionCosts(): Promise<number> {
  const now = Date.now();
  const due: DueRow[] = (await db
    .select({ generationId: generationSequenceCopy.generationId, orgId: generationSequenceCopy.orgId, completionRunIds: generationSequenceCopy.completionRunIds })
    .from(generationSequenceCopy)
    .where(
      and(
        isNotNull(generationSequenceCopy.completionRunIds),
        lt(generationSequenceCopy.createdAt, new Date(now - SETTLE_MS)),
        or(
          isNull(generationSequenceCopy.llmCostReadAt),
          and(eq(generationSequenceCopy.llmCostStatus, "held"), lt(generationSequenceCopy.llmCostReadAt, new Date(now - HELD_REREAD_MS))),
        ),
      ),
    )
    .orderBy(generationSequenceCopy.createdAt)
    .limit(MAX_ROWS_PER_SWEEP)) as DueRow[];
  if (!due.length) return 0;
  const chunks: DueRow[][] = [];
  const byOrg = new Map<string, DueRow[]>();
  for (const r of due) byOrg.set(r.orgId, [...(byOrg.get(r.orgId) ?? []), r]);
  for (const rows of byOrg.values()) for (let i = 0; i < rows.length; i += BATCH) chunks.push(rows.slice(i, i + BATCH));
  let stored = 0;
  await mapWithConcurrency(chunks, 2, async (rows) => {
    try {
      const ids = [...new Set(rows.flatMap((r) => r.completionRunIds).filter((id) => UUID_RE.test(id)))];
      const costs = ids.length ? await readRunCosts(rows[0].orgId, ids) : new Map<string, RunCostRow[]>();
      for (const r of rows) {
        // Every run of the generation must be found, else its cost is not known (never a partial sum).
        const found = r.completionRunIds.length > 0 && r.completionRunIds.every((id) => costs.has(id));
        const split = found ? splitCompletionCost(r.completionRunIds.flatMap((id) => costs.get(id)!)) : null;
        await db
          .update(generationSequenceCopy)
          .set({
            llmInputCostCents: split?.inputCents ?? null,
            llmOutputCostCents: split?.outputCents ?? null,
            llmCostStatus: !split ? "run_not_found" : split.held ? "held" : "read",
            llmCostReadAt: sql`now()`,
          })
          .where(eq(generationSequenceCopy.generationId, r.generationId));
        stored++;
      }
    } catch (err) {
      console.error(`[features-service] completion costs: org ${rows[0].orgId} unreadable this sweep (retried next tick):`, err);
    }
  });
  return stored;
}
