/**
 * Persistence + validation for the STATED MONTHLY AMOUNTS store (`stated_monthly_amounts`) — the
 * staff-writable record of what a HUMAN says a brand is worth per month, over a date range.
 *
 * See the table's own doc in `db/schema.ts` for WHY it exists (an agency's daily budget is an
 * allocation decision, not its monthly worth). This module owns the two rules a read can never
 * recover from if they are broken at write time:
 *
 *   1. A RANGE MUST BE COHERENT — `startDate <= endDate` when both are given, and each is a real
 *      `YYYY-MM-DD` day. A malformed day would silently never match any period.
 *   2. TWO ROWS FOR ONE (org, brand) MAY NEVER OVERLAP ON A SINGLE DAY. Two stated amounts in force
 *      at once is two answers to one question, and no read could pick between them honestly — so the
 *      write is REFUSED, with a message naming the row it collided with and the exact range, because
 *      the person fixing it needs to know which row to move.
 *
 * Unlike the committed-MRR snapshot store beside it, these functions FAIL LOUD: they back a staff
 * WRITE API, where a swallowed error would report a save that did not happen. The READ used by the
 * revenue split is wrapped fail-soft by its caller, not here.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { statedMonthlyAmounts, type StatedMonthlyAmount } from "../db/schema.js";

/** A stated monthly amount as served on the wire (cents → USD, both bounds explicit). */
export interface StatedAmountRow {
  id: string;
  orgId: string;
  brandId: string;
  /** What a person says this brand is worth per month, USD (2-decimal). A stated 0 is a real answer. */
  amountUsd: number;
  /** First UTC day in force (`YYYY-MM-DD`, inclusive), or null = since the brand's first billed day. */
  startDate: string | null;
  /** Last UTC day in force (`YYYY-MM-DD`, inclusive), or null = still running. */
  endDate: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A write refused because it broke one of this module's two rules. Carries a message a person can read. */
export class StatedAmountConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatedAmountConflictError";
  }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireDay(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !DAY_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new StatedAmountConflictError(`${field} must be a calendar day formatted YYYY-MM-DD (got ${JSON.stringify(value)})`);
  }
  return value;
}

function toRow(r: StatedMonthlyAmount): StatedAmountRow {
  return {
    id: r.id,
    orgId: r.orgId,
    brandId: r.brandId,
    amountUsd: Math.round(r.amountCents) / 100,
    startDate: r.startDate,
    endDate: r.endDate,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Human-readable rendering of a half-open-at-both-ends range, for a refusal message. */
export function describeRange(startDate: string | null, endDate: string | null): string {
  const from = startDate ?? "the brand's first billed day";
  const to = endDate ?? "today";
  return `${from} → ${to}`;
}

/**
 * Do two INCLUSIVE ranges share at least one day? A null start is "-infinity" and a null end is
 * "+infinity" for this test — the open ends are what make a second open-ended row a conflict rather
 * than a harmless append. Pure.
 */
export function rangesOverlap(
  a: { startDate: string | null; endDate: string | null },
  b: { startDate: string | null; endDate: string | null },
): boolean {
  const aStart = a.startDate ?? "0000-01-01";
  const bStart = b.startDate ?? "0000-01-01";
  const aEnd = a.endDate ?? "9999-12-31";
  const bEnd = b.endDate ?? "9999-12-31";
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * Validate a range and refuse it when it collides with any EXISTING row of the same (org, brand).
 * `excludeId` skips the row being updated so an edit does not collide with itself. Pure given the
 * existing rows — the DB read is the caller's.
 */
export function assertNoOverlap(
  candidate: { startDate: string | null; endDate: string | null },
  existing: StatedAmountRow[],
  excludeId?: string,
): void {
  if (candidate.startDate && candidate.endDate && candidate.startDate > candidate.endDate) {
    throw new StatedAmountConflictError(
      `startDate ${candidate.startDate} is after endDate ${candidate.endDate} — a range cannot end before it begins`,
    );
  }
  for (const row of existing) {
    if (excludeId && row.id === excludeId) continue;
    if (rangesOverlap(candidate, row)) {
      throw new StatedAmountConflictError(
        `this range (${describeRange(candidate.startDate, candidate.endDate)}) overlaps the stated amount ` +
          `already recorded for this brand (${describeRange(row.startDate, row.endDate)}, id ${row.id}). ` +
          "One brand can only be worth one amount on a given day — close or move the existing range first.",
      );
    }
  }
}

/** Every stated amount, oldest range first; optionally narrowed to one org and/or one brand. Fails loud. */
export async function listStatedAmounts(filter?: { orgId?: string; brandId?: string }): Promise<StatedAmountRow[]> {
  const conditions = [
    filter?.orgId ? eq(statedMonthlyAmounts.orgId, filter.orgId) : undefined,
    filter?.brandId ? eq(statedMonthlyAmounts.brandId, filter.brandId) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  const rows = await db
    .select()
    .from(statedMonthlyAmounts)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(statedMonthlyAmounts.brandId), asc(statedMonthlyAmounts.startDate), asc(statedMonthlyAmounts.createdAt));
  return rows.map(toRow);
}

export interface StatedAmountInput {
  orgId: string;
  brandId: string;
  amountUsd: number;
  startDate?: string | null;
  endDate?: string | null;
  note?: string | null;
}

function requireAmountCents(amountUsd: unknown): number {
  const n = Number(amountUsd);
  if (!Number.isFinite(n) || n < 0) {
    throw new StatedAmountConflictError(`amountUsd must be a number of dollars, zero or more (got ${JSON.stringify(amountUsd)})`);
  }
  return Math.round(n * 100);
}

/** Create one stated amount. Refuses a malformed or overlapping range. Fails loud. */
export async function createStatedAmount(input: StatedAmountInput, now: Date = new Date()): Promise<StatedAmountRow> {
  const startDate = requireDay(input.startDate ?? null, "startDate");
  const endDate = requireDay(input.endDate ?? null, "endDate");
  const amountCents = requireAmountCents(input.amountUsd);

  const existing = await listStatedAmounts({ orgId: input.orgId, brandId: input.brandId });
  assertNoOverlap({ startDate, endDate }, existing);

  const [created] = await db
    .insert(statedMonthlyAmounts)
    .values({
      orgId: input.orgId,
      brandId: input.brandId,
      amountCents,
      startDate,
      endDate,
      note: input.note ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return toRow(created);
}

/**
 * Update one stated amount in place. Every field is optional; an omitted field keeps its stored value,
 * and an explicit `null` on a bound OPENS that end (which is a real edit, not an omission). The range
 * is re-checked against every sibling row of the same pair, excluding itself.
 */
export async function updateStatedAmount(
  id: string,
  patch: Partial<StatedAmountInput>,
  now: Date = new Date(),
): Promise<StatedAmountRow | null> {
  const [current] = await db.select().from(statedMonthlyAmounts).where(eq(statedMonthlyAmounts.id, id));
  if (!current) return null;

  const startDate = "startDate" in patch ? requireDay(patch.startDate ?? null, "startDate") : current.startDate;
  const endDate = "endDate" in patch ? requireDay(patch.endDate ?? null, "endDate") : current.endDate;
  const amountCents = "amountUsd" in patch ? requireAmountCents(patch.amountUsd) : current.amountCents;
  const note = "note" in patch ? (patch.note ?? null) : current.note;

  const existing = await listStatedAmounts({ orgId: current.orgId, brandId: current.brandId });
  assertNoOverlap({ startDate, endDate }, existing, id);

  const [updated] = await db
    .update(statedMonthlyAmounts)
    .set({ amountCents, startDate, endDate, note, updatedAt: now })
    .where(eq(statedMonthlyAmounts.id, id))
    .returning();
  return toRow(updated);
}

/** Delete one stated amount. Returns false when no row carried that id. Fails loud on a DB error. */
export async function deleteStatedAmount(id: string): Promise<boolean> {
  const deleted = await db.delete(statedMonthlyAmounts).where(eq(statedMonthlyAmounts.id, id)).returning({ id: statedMonthlyAmounts.id });
  return deleted.length > 0;
}

/**
 * Read every stated amount for the revenue split, FAIL-SOFT: the split is additive enrichment on an
 * already-working endpoint, so a store blip must null the split rather than 502 the whole revenue read.
 * `null` means "we could not read this", which is distinguishable from `[]` ("nobody has stated anything").
 */
export async function readStatedAmountsSoft(): Promise<StatedAmountRow[] | null> {
  try {
    return await listStatedAmounts();
  } catch (err) {
    console.error("[features-service] stated-monthly-amounts read failed (soft):", err);
    return null;
  }
}
