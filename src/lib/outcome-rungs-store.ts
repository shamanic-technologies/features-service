/**
 * IO for the outcome rung catalogue (`outcome_lifecycle_rungs`, OUTCOME-RUNG-AND-TARGET-1106): every outcome's rung on the
 * ONE generic lead Lifecycle (`lib/lifecycle-ladder.ts`), coded and declared steps alike, read by every catalogue step read.
 * Held 30 s in process (a write drops the copy at once); a read failure throws (a step never reads "no rung" because the
 * table could not be read).
 */
import { asc } from "drizzle-orm";
import { db } from "../db/index.js";
import { outcomeLifecycleRungs } from "../db/schema.js";
import { isStepLifecycleRung, type StepLifecycleRung } from "./lifecycle-ladder.js";

const HELD_MS = 30_000;
let held: { at: number; value: ReadonlyMap<string, StepLifecycleRung> } | null = null;

/** outcome key -> its stated rung (or `none`). An outcome with no row has never stated one. */
export async function listOutcomeRungs(): Promise<ReadonlyMap<string, StepLifecycleRung>> {
  if (held && Date.now() - held.at < HELD_MS) return held.value;
  const rows = await db.select().from(outcomeLifecycleRungs).orderBy(asc(outcomeLifecycleRungs.outcomeKey));
  const value = new Map<string, StepLifecycleRung>();
  for (const r of rows) {
    if (!isStepLifecycleRung(r.lifecycleRung)) throw new Error(`[features-service] outcome_lifecycle_rungs: ${r.outcomeKey} states an unknown rung ${JSON.stringify(r.lifecycleRung)}`);
    value.set(r.outcomeKey, r.lifecycleRung);
  }
  held = { at: Date.now(), value };
  return value;
}

/** States (or restates) one outcome's rung. */
export async function setOutcomeRung(outcomeKey: string, lifecycleRung: StepLifecycleRung, statedBy: string): Promise<void> {
  await db
    .insert(outcomeLifecycleRungs)
    .values({ outcomeKey, lifecycleRung, statedBy })
    .onConflictDoUpdate({ target: outcomeLifecycleRungs.outcomeKey, set: { lifecycleRung, statedBy, statedAt: new Date() } });
  held = null;
}
