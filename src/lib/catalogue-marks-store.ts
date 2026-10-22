/**
 * IO half of the workflow / template marks (MARKS-1022, rule in `lib/catalogue-marks.ts`): read the stored marks, give
 * the unmarked objects theirs on first sight under one transaction-scoped advisory lock (two concurrent reads cannot
 * hand one mark to two objects nor two marks to one), then remember them in-process (a mark never moves, so the memory
 * never goes stale). Fail-loud like `salesPathNamesFor`: a DB error throws, never an invented mark.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { catalogueMarks } from "../db/schema.js";
import { markId, nextMarks, type CatalogueMark, type MarkFamily } from "./catalogue-marks.js";

/** Lock id of the assignment (any constant; scoped to this one table's writes). */
export const MARK_ASSIGNMENT_LOCK = 784_530_122;

const memory = new Map<string, CatalogueMark>();
const memoKey = (family: MarkFamily, key: string): string => `${family}\u0000${key}`;

export function __resetCatalogueMarksMemory(): void {
  memory.clear();
}

/** The mark of every key of `keysInOrder` (one family), giving the unmarked ones theirs in that order. */
export async function marksFor(family: MarkFamily, keysInOrder: readonly string[]): Promise<Map<string, CatalogueMark>> {
  const keys = [...new Set(keysInOrder.filter((k) => k.length > 0))];
  const out = new Map<string, CatalogueMark>();
  const unknown = keys.filter((k) => {
    const m = memory.get(memoKey(family, k));
    if (m) out.set(k, m);
    return !m;
  });
  if (unknown.length === 0) return out;

  const read = async (q: Pick<typeof db, "select">, which: readonly string[]) =>
    q
      .select({ key: catalogueMarks.objectKey, icon: catalogueMarks.icon, color: catalogueMarks.color })
      .from(catalogueMarks)
      .where(and(eq(catalogueMarks.family, family), inArray(catalogueMarks.objectKey, [...which])));
  const remember = (rows: ReadonlyArray<{ key: string; icon: string; color: string }>) => {
    for (const r of rows) {
      const m = { icon: r.icon, color: r.color };
      memory.set(memoKey(family, r.key), m);
      out.set(r.key, m);
    }
  };

  remember(await read(db, unknown));
  const missing = unknown.filter((k) => !out.has(k));
  if (missing.length === 0) return out;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${MARK_ASSIGNMENT_LOCK})`);
    remember(await read(tx, missing));
    const still = missing.filter((k) => !out.has(k));
    if (still.length === 0) return;
    const used = new Set(
      (await tx.select({ icon: catalogueMarks.icon, color: catalogueMarks.color }).from(catalogueMarks).where(eq(catalogueMarks.family, family))).map(markId),
    );
    const given = nextMarks(family, used, still.length);
    await tx.insert(catalogueMarks).values(still.map((objectKey, i) => ({ family, objectKey, icon: given[i].icon, color: given[i].color })));
    remember(still.map((key, i) => ({ key, ...given[i] })));
    console.log(`[features-service] catalogue marks (${family}): marked ${still.map((k, i) => `${k}=${given[i].icon}`).join(", ")}`);
  });
  return out;
}
