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
 *   • no row        — `unassigned`: never put on this leg, so never selectable on it. A NEW dynasty is
 *                     on no leg until someone assigns it.
 *
 * Nothing here looks at a workflow's model, price or tier. The previous rule excluded workflows by the
 * capability tier of the model writing their emails, and it excluded one (`maelstrom`) that had already
 * run on the positive-reply leg and was the cheapest per positive reply in the fleet — which is why the
 * owner wants to judge performance himself rather than have a derived rule judge it for him.
 *
 * workflow-service's own global dynasty status is untouched and still wins: a globally deprecated
 * dynasty is not enumerated by the projection at all, whatever its assignment says.
 *
 * Every write lands in the same transaction as an append-only history row
 * (`workflow_leg_assignment_changes`), so "who deprecated this, when, and from what" always has an
 * answer. Reads and writes FAIL LOUD: the assignment decides what may run, so a swallowed read would
 * report "nothing is assigned" — i.e. exclude every workflow — on a database blip.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { OUTBOUND_LEG_KEY_CORRESPONDENCE, servedLegKeyOf, storedLegKeyOf } from "./funnel-legs.js";
import { db } from "../db/index.js";
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
  const computed = storedLegKeyOf(legKey);
  if (featureSlug) return [servedLegKeyOf(featureSlug, computed)];
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
  const rows = await listLegAssignments({ featureSlug, legKey });
  return new Map(rows.map((r) => [r.workflowDynastySlug, r]));
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
        eq(workflowLegAssignmentChanges.legKey, servedLegKeyOf(key.featureSlug, storedLegKeyOf(key.legKey))),
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
  input = { ...input, legKey: servedLegKeyOf(input.featureSlug, storedLegKeyOf(input.legKey)) };
  const decidedAt = new Date();
  return db.transaction(async (tx) => {
    const key = and(
      eq(workflowLegAssignments.featureSlug, input.featureSlug),
      eq(workflowLegAssignments.legKey, input.legKey),
      eq(workflowLegAssignments.workflowDynastySlug, input.workflowDynastySlug),
    );
    const [existing] = await tx.select().from(workflowLegAssignments).where(key).for("update");
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
  const legKey = servedLegKeyOf(input.featureSlug, storedLegKeyOf(input.legKey));
  const key = and(
    eq(workflowLegAssignments.featureSlug, input.featureSlug),
    eq(workflowLegAssignments.legKey, legKey),
    eq(workflowLegAssignments.workflowDynastySlug, input.workflowDynastySlug),
  );
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(workflowLegAssignments).where(key).for("update");
    if (existing) return { assignment: toRow(existing), created: false };
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
 * PURE: the verdict a projection row carries for its dynasty on the named leg. Only `active` is
 * selectable; a `deprecated` or never-assigned workflow is still served with its figures, and says why
 * it will not be picked.
 */
export function legAssignmentVerdict(
  assignment: LegAssignmentRow | undefined,
  legLabel: string,
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
  return {
    state: "active",
    selectable: true,
    reason: null,
    decidedBy: assignment.decidedBy,
    decidedAt: assignment.decidedAt,
  };
}
