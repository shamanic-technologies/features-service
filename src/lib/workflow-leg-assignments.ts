/**
 * WHICH WORKFLOWS MAY RUN ON A LEG IS A STATED ASSIGNMENT, NEVER A RULE (supersedes the model-tier rule)
 *
 * The owner decides, workflow by workflow and leg by leg, which workflow dynasties may run on a leg
 * (e.g. "nothing → Positive reply" through `sales-cold-email-outreach`). The decision is stored in
 * `workflow_leg_assignments`, keyed on (acquisition channel = feature slug, leg, workflow dynasty):
 *
 *   • `active`      — assigned; the selector may pick it on this leg.
 *   • `deprecated`  — assigned once, now retired ON THIS LEG ONLY: no new run picks it here, but every
 *                     stats read keeps serving it with its history and says so.
 *   • no row        — `unassigned`: never put on this leg, so never selectable on it. A workflow created
 *                     for a pipe is registered active on it at once (`registerLegAssignment`).
 *
 * Nothing here looks at a workflow's model, price or tier. The previous rule excluded workflows by the
 * capability tier of the model writing their emails, and it excluded one (`maelstrom`) that had already
 * run on the positive-reply leg and was the cheapest per positive reply in the fleet — which is why the
 * owner wants to judge performance himself rather than have a derived rule judge it for him.
 *
 * workflow-service's own global dynasty status is untouched and still wins: a globally deprecated
 * dynasty is not enumerated by the projection at all, whatever its assignment says.
 *
 * ONE LEG AT A TIME (owner 2026-10-19, ONE-LEG-PER-WORKFLOW-1019: « A workflow can only be at one leg at a time. »): a
 * dynasty is `active` on at most one (channel, leg). Every write that would put it active on a SECOND leg is refused
 * with `WorkflowOnAnotherLegError` (409 `workflow_on_another_leg`, naming the leg it holds): deprecate it there first.
 * Checked inside the write's transaction under a per-dynasty advisory lock, so two concurrent writes cannot both pass.
 * Re-confirming a leg it is already active on is not a second leg.
 *
 * Every write lands in the same transaction as an append-only history row
 * (`workflow_leg_assignment_changes`), so "who deprecated this, when, and from what" always has an
 * answer. Reads and writes FAIL LOUD: the assignment decides what may run, so a swallowed read would
 * report "nothing is assigned" — i.e. exclude every workflow — on a database blip.
 */
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { OUTBOUND_LEG_KEY_CORRESPONDENCE, pipeLegKeyOf, servedLegKeyOf, storedLegKeyOf } from "./funnel-legs.js";
import { db } from "../db/index.js";
import type { DynastyMerges } from "./dynasty-merges.js";
import { dynastyMergesOf, executableDynasties, fetchDynastyMerges, fetchStatedPublicWorkflows, type WorkflowMetadata } from "./public-stats-clients.js";
import { workflowLegAssignmentChanges, workflowLegAssignments } from "../db/schema.js";

export const LEG_ASSIGNMENT_STATES = ["active", "deprecated"] as const;
export type LegAssignmentStoredState = (typeof LEG_ASSIGNMENT_STATES)[number];
/** The three answers a reader can get — the third one is the ABSENCE of a row. */
export type LegAssignmentState = LegAssignmentStoredState | "unassigned";

export const isLegAssignmentState = (v: unknown): v is LegAssignmentStoredState =>
  typeof v === "string" && (LEG_ASSIGNMENT_STATES as readonly string[]).includes(v);

/** One assignment as served on the wire. */
export interface LegAssignmentRow {
  featureSlug: string;
  legKey: string;
  workflowDynastySlug: string;
  state: LegAssignmentStoredState;
  decidedBy: string;
  decidedAt: string;
  note: string | null;
}

/**
 * What a projection row states about its workflow on the leg the read named. Present ⟺ the read
 * named a `?leg=`, so every funnel- and goal-keyed body is byte-unchanged.
 */
export interface LegAssignmentVerdict {
  /** `active` | `deprecated` | `unassigned` (never put on this leg). */
  state: LegAssignmentState;
  /** TRUE ⟺ `state === "active"`: the one condition under which a new run may pick this workflow here. */
  selectable: boolean;
  /** Why it is not selectable, in a sentence a human reads. Null ⟺ selectable. */
  reason: string | null;
  /** Who decided the current state. Null ⟺ `unassigned`. */
  decidedBy: string | null;
  /** When. Null ⟺ `unassigned`. */
  decidedAt: string | null;
}

/** A write would put a dynasty active on a second leg (owner 2026-10-19: one leg at a time). */
export class WorkflowOnAnotherLegError extends Error {
  readonly reason = "workflow_on_another_leg";
  constructor(
    readonly workflowDynastySlug: string,
    readonly requested: { featureSlug: string; legKey: string },
    readonly activeOn: Array<{ featureSlug: string; legKey: string }>,
  ) {
    super(
      `workflow ${workflowDynastySlug} is already active on ${activeOn.map((a) => `${a.featureSlug}|${a.legKey}`).join(", ")}: ` +
        `a workflow runs on one leg at a time, so it cannot also be active on ${requested.featureSlug}|${requested.legKey} (deprecate it there first)`,
    );
    this.name = "WorkflowOnAnotherLegError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Refuse a write that would put `dynasty` active on a second leg. Runs INSIDE the write's transaction, after taking a
 * per-dynasty advisory lock (released at commit), so the read and the write it guards cannot interleave with another.
 */
async function assertNoOtherActiveLeg(tx: Tx, key: { featureSlug: string; legKey: string; workflowDynastySlug: string }): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`workflow-leg:${key.workflowDynastySlug}`}))`);
  const others = await tx
    .select({ featureSlug: workflowLegAssignments.featureSlug, legKey: workflowLegAssignments.legKey })
    .from(workflowLegAssignments)
    .where(
      and(
        eq(workflowLegAssignments.workflowDynastySlug, key.workflowDynastySlug),
        eq(workflowLegAssignments.state, "active"),
        or(ne(workflowLegAssignments.featureSlug, key.featureSlug), ne(workflowLegAssignments.legKey, key.legKey)),
      ),
    );
  if (others.length > 0) throw new WorkflowOnAnotherLegError(key.workflowDynastySlug, { featureSlug: key.featureSlug, legKey: key.legKey }, others);
}

function toRow(r: typeof workflowLegAssignments.$inferSelect): LegAssignmentRow {
  return {
    featureSlug: r.featureSlug,
    legKey: r.legKey,
    workflowDynastySlug: r.workflowDynastySlug,
    state: r.state as LegAssignmentStoredState,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt.toISOString(),
    note: r.note,
  };
}

/** The stored spellings a leg named for `featureSlug` (or for no channel) can be under. */
function storedSpellingsOf(featureSlug: string | undefined, legKey: string): string[] {
  if (featureSlug) return [servedLegKeyOf(featureSlug, pipeLegKeyOf(featureSlug, legKey))];
  const computed = storedLegKeyOf(legKey);
  const outbound = OUTBOUND_LEG_KEY_CORRESPONDENCE.find((c) => c.legacyLegKey === computed);
  return outbound ? [computed, outbound.legKey] : [computed];
}

/** Every assignment, optionally narrowed to a channel and/or a leg, in a stable order. */
export async function listLegAssignments(filter: { featureSlug?: string; legKey?: string } = {}): Promise<LegAssignmentRow[]> {
  const conds = [];
  if (filter.featureSlug) conds.push(eq(workflowLegAssignments.featureSlug, filter.featureSlug));
  // Rows are stored in the served spelling (outbound leg rename, wave 2): a leg named without a channel
  // matches both an outbound channel's `lead_found_to_*` row and any other channel's `start_to_*` one.
  if (filter.legKey) conds.push(inArray(workflowLegAssignments.legKey, storedSpellingsOf(filter.featureSlug, filter.legKey)));
  const rows = await db
    .select()
    .from(workflowLegAssignments)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(
      asc(workflowLegAssignments.featureSlug),
      asc(workflowLegAssignments.legKey),
      asc(workflowLegAssignments.workflowDynastySlug),
    );
  return rows.map(toRow);
}

/** The assignments of ONE (channel, leg), keyed by dynasty — what a leg-keyed projection reads. */
export async function fetchLegAssignments(featureSlug: string, legKey: string): Promise<Map<string, LegAssignmentRow>> {
  const [rows, merges] = await Promise.all([listLegAssignments({ featureSlug, legKey }), fetchDynastyMerges(featureSlug)]);
  return poolLegAssignments(rows, merges);
}

/**
 * PURE. The leg's assignments as STATS read them (`lib/dynasty-merges.ts`): an absorbed dynasty is no row of its own, it
 * counts inside its survivor. The survivor's own row stands; a survivor with no row on the leg takes its absorbed
 * members' (active first), so a merge never makes a pipe lose its workflow. No merge = byte-identical.
 */
export function poolLegAssignments(rows: readonly LegAssignmentRow[], merges: DynastyMerges): Map<string, LegAssignmentRow> {
  const out = new Map<string, LegAssignmentRow>();
  for (const r of rows) if (!merges.has(r.workflowDynastySlug)) out.set(r.workflowDynastySlug, r);
  const borrowed = rows
    .filter((r) => merges.has(r.workflowDynastySlug))
    .sort((a, b) => (a.state === "active" ? 0 : 1) - (b.state === "active" ? 0 : 1) || a.workflowDynastySlug.localeCompare(b.workflowDynastySlug));
  for (const r of borrowed) {
    const survivor = merges.get(r.workflowDynastySlug)!;
    if (!out.has(survivor)) out.set(survivor, { ...r, workflowDynastySlug: survivor });
  }
  return out;
}

/**
 * PURE. The assignments a RUNNABILITY verdict may count (PLAY-SEED-LADDER-1022): per (channel, leg), absorbed dynasties
 * pooled into their survivor (`poolLegAssignments`), then every row whose dynasty workflow-service runs no version of
 * (`executableDynasties`, the same predicate as a leg read's `selectable`) dropped. Prod 2026-10-22: "Blind emails only"
 * read runnable on 32 assigned-active dynasties, every one retired or merged into a non-blind survivor, while the leg
 * read campaign-service seeds a launch from served none of them, so the launch was refused. A feature whose catalogue
 * is not in `workflowsByFeature` keeps no row (never counted runnable on a guess).
 */
export function runnableLegAssignments(
  rows: readonly LegAssignmentRow[],
  workflowsByFeature: ReadonlyMap<string, ReadonlyArray<Pick<WorkflowMetadata, "workflowDynastySlug" | "status" | "workflowDynastyStatus" | "mergedIntoDynastySlug">>>,
): LegAssignmentRow[] {
  const byPipe = new Map<string, LegAssignmentRow[]>();
  for (const r of rows) {
    const k = `${r.featureSlug}|${pipeLegKeyOf(r.featureSlug, r.legKey)}`;
    byPipe.set(k, [...(byPipe.get(k) ?? []), r]);
  }
  const out: LegAssignmentRow[] = [];
  for (const pipeRows of byPipe.values()) {
    const workflows = workflowsByFeature.get(pipeRows[0].featureSlug);
    if (!workflows) continue;
    const runnable = executableDynasties(workflows);
    for (const r of poolLegAssignments(pipeRows, dynastyMergesOf(workflows)).values()) if (runnable.has(r.workflowDynastySlug)) out.push(r);
  }
  return out;
}

/** Every assignment a runnability verdict may count, read live (`runnableLegAssignments`). An unreadable catalogue throws. */
export async function listRunnableLegAssignments(): Promise<LegAssignmentRow[]> {
  const rows = await listLegAssignments();
  const features = [...new Set(rows.map((r) => r.featureSlug))];
  const catalogues = await Promise.all(features.map(async (f) => [f, await fetchStatedPublicWorkflows(f, "all")] as const));
  return runnableLegAssignments(rows, new Map(catalogues));
}

/** The history of one (channel, leg, dynasty), oldest first. */
export async function listLegAssignmentChanges(key: {
  featureSlug: string;
  legKey: string;
  workflowDynastySlug: string;
}) {
  const rows = await db
    .select()
    .from(workflowLegAssignmentChanges)
    .where(
      and(
        eq(workflowLegAssignmentChanges.featureSlug, key.featureSlug),
        eq(workflowLegAssignmentChanges.legKey, servedLegKeyOf(key.featureSlug, pipeLegKeyOf(key.featureSlug, key.legKey))),
        eq(workflowLegAssignmentChanges.workflowDynastySlug, key.workflowDynastySlug),
      ),
    )
    .orderBy(asc(workflowLegAssignmentChanges.decidedAt));
  return rows.map((r) => ({
    fromState: r.fromState,
    toState: r.toState,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt.toISOString(),
    note: r.note,
  }));
}

/**
 * Put a dynasty on a leg in a state (assign as active, deprecate, reactivate) — an upsert plus a
 * history row, in one transaction. Returns the stored row and the state it replaced (null = was not
 * assigned). Writing the state it already holds still records who re-confirmed it.
 */
export async function setLegAssignment(input: {
  featureSlug: string;
  legKey: string;
  workflowDynastySlug: string;
  state: LegAssignmentStoredState;
  decidedBy: string;
  note?: string | null;
}): Promise<{ assignment: LegAssignmentRow; previousState: LegAssignmentStoredState | null }> {
  // Stored in the served spelling (outbound leg rename, wave 2): either spelling writes the same row.
  input = { ...input, legKey: servedLegKeyOf(input.featureSlug, pipeLegKeyOf(input.featureSlug, input.legKey)) };
  const decidedAt = new Date();
  return db.transaction(async (tx) => {
    const key = and(
      eq(workflowLegAssignments.featureSlug, input.featureSlug),
      eq(workflowLegAssignments.legKey, input.legKey),
      eq(workflowLegAssignments.workflowDynastySlug, input.workflowDynastySlug),
    );
    const [existing] = await tx.select().from(workflowLegAssignments).where(key).for("update");
    // One leg at a time: turning it active here must not make a second active leg.
    if (input.state === "active" && existing?.state !== "active") await assertNoOtherActiveLeg(tx, input);
    const [stored] = await tx
      .insert(workflowLegAssignments)
      .values({
        featureSlug: input.featureSlug,
        legKey: input.legKey,
        workflowDynastySlug: input.workflowDynastySlug,
        state: input.state,
        decidedBy: input.decidedBy,
        decidedAt,
        note: input.note ?? null,
      })
      .onConflictDoUpdate({
        target: [
          workflowLegAssignments.featureSlug,
          workflowLegAssignments.legKey,
          workflowLegAssignments.workflowDynastySlug,
        ],
        set: { state: input.state, decidedBy: input.decidedBy, decidedAt, note: input.note ?? null },
      })
      .returning();
    await tx.insert(workflowLegAssignmentChanges).values({
      featureSlug: input.featureSlug,
      legKey: input.legKey,
      workflowDynastySlug: input.workflowDynastySlug,
      fromState: existing?.state ?? null,
      toState: input.state,
      decidedBy: input.decidedBy,
      decidedAt,
      note: input.note ?? null,
    });
    return {
      assignment: toRow(stored),
      previousState: (existing?.state as LegAssignmentStoredState | undefined) ?? null,
    };
  });
}

/**
 * REGISTER a workflow on the pipe it was created for (owner 2026-10-10, option A: the pipe <-> workflow link
 * lives HERE only, and a workflow created for a pipe is ACTIVE at once; the explore allowance caps what an
 * unproven workflow can spend). Insert-if-absent: a dynasty already stated on the pipe keeps its state
 * (a staff `deprecated` is never undone by a later version's creation), and the answer says so.
 */
export async function registerLegAssignment(input: {
  featureSlug: string;
  legKey: string;
  workflowDynastySlug: string;
  registeredBy: string;
  note?: string | null;
}): Promise<{ assignment: LegAssignmentRow; created: boolean }> {
  const legKey = servedLegKeyOf(input.featureSlug, pipeLegKeyOf(input.featureSlug, input.legKey));
  const key = and(
    eq(workflowLegAssignments.featureSlug, input.featureSlug),
    eq(workflowLegAssignments.legKey, legKey),
    eq(workflowLegAssignments.workflowDynastySlug, input.workflowDynastySlug),
  );
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(workflowLegAssignments).where(key).for("update");
    if (existing) return { assignment: toRow(existing), created: false };
    // One leg at a time: a workflow already active on another pipe is refused, never registered on a second one.
    await assertNoOtherActiveLeg(tx, { featureSlug: input.featureSlug, legKey, workflowDynastySlug: input.workflowDynastySlug });
    const decidedAt = new Date();
    const note = input.note ?? "registered at creation (a workflow created for a pipe is active at once)";
    const [stored] = await tx
      .insert(workflowLegAssignments)
      .values({ featureSlug: input.featureSlug, legKey, workflowDynastySlug: input.workflowDynastySlug, state: "active", decidedBy: input.registeredBy, decidedAt, note })
      .onConflictDoNothing()
      .returning();
    if (!stored) {
      const [raced] = await tx.select().from(workflowLegAssignments).where(key);
      return { assignment: toRow(raced), created: false };
    }
    await tx.insert(workflowLegAssignmentChanges).values({
      featureSlug: input.featureSlug,
      legKey,
      workflowDynastySlug: input.workflowDynastySlug,
      fromState: null,
      toState: "active",
      decidedBy: input.registeredBy,
      decidedAt,
      note,
    });
    return { assignment: toRow(stored), created: true };
  });
}

/**
 * PURE: the verdict a projection row carries for its dynasty on the named leg. Only `active` on a dynasty
 * workflow-service can run is selectable; a `deprecated`, never-assigned or unrunnable workflow is still served with its figures, and says why
 * it will not be picked.
 */
export function legAssignmentVerdict(
  assignment: LegAssignmentRow | undefined,
  legLabel: string,
  /** workflow-service has a runnable version of this dynasty (`executableDynasties`). */
  executable: boolean,
): LegAssignmentVerdict {
  if (!assignment) {
    return {
      state: "unassigned",
      selectable: false,
      reason: `this workflow has not been assigned to the "${legLabel}" leg, so no campaign on that leg runs it`,
      decidedBy: null,
      decidedAt: null,
    };
  }
  if (assignment.state === "deprecated") {
    return {
      state: "deprecated",
      selectable: false,
      reason: `this workflow is deprecated on the "${legLabel}" leg (by ${assignment.decidedBy}, ${assignment.decidedAt.slice(0, 10)}): no new run picks it there, its history stays`,
      decidedBy: assignment.decidedBy,
      decidedAt: assignment.decidedAt,
    };
  }
  if (!executable) {
    // Assigned, but workflow-service runs no version of it (every version retired): a run asked of it is
    // refused (410), so it is never picked, never recommended, and never copied as a candidate.
    return {
      state: "active",
      selectable: false,
      reason: `this workflow has no version that can run (every version is retired in workflow-service), so no campaign on the "${legLabel}" leg can run it`,
      decidedBy: assignment.decidedBy,
      decidedAt: assignment.decidedAt,
    };
  }
  return {
    state: "active",
    selectable: true,
    reason: null,
    decidedBy: assignment.decidedBy,
    decidedAt: assignment.decidedAt,
  };
}
