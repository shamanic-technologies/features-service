/**
 * IO for tactics, strategies, plays and the stored Jev verdicts (`lib/plays.ts` is the pure rule). Every read goes
 * through `loadPlayCatalogue`: the four tables are small, read together and shared 30 s in-process (the leg ladder
 * reads them on every campaign tick); every write clears that copy.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { plays, strategies, tactics, workflowTacticVerdicts } from "../db/schema.js";
import { DeclarationError } from "./channel-declarations.js";
import { buildPlayCatalogue, idOfName, type PlayCatalogue, type PlayRecord, type Strategy, type Tactic, type TacticVerdictRow } from "./plays.js";

const SHARE_MS = 30_000;
let shared: { at: number; value: Promise<PlayCatalogue> } | null = null;

export function invalidatePlayCatalogue(): void {
  shared = null;
}

/** Tactics, strategies, plays and every stored verdict, as one catalogue. FAIL-LOUD (a failed read is never "no play"). */
export function loadPlayCatalogue(): Promise<PlayCatalogue> {
  if (shared && Date.now() - shared.at < SHARE_MS) return shared.value;
  const value = (async () => {
    const [t, s, p, v] = await Promise.all([
      db.select().from(tactics),
      db.select().from(strategies),
      db.select().from(plays),
      db.select().from(workflowTacticVerdicts),
    ]);
    return buildPlayCatalogue({
      tactics: t.map(tacticOf).sort((a, b) => (a.id < b.id ? -1 : 1)),
      strategies: s.map(strategyOf).sort((a, b) => (a.id < b.id ? -1 : 1)),
      plays: p.map((r): PlayRecord => ({ pipeId: r.pipeId, strategyId: r.strategyId, isDefault: r.isDefault })),
      verdicts: v.map(verdictOf),
    });
  })();
  shared = { at: Date.now(), value };
  value.catch(() => {
    if (shared?.value === value) shared = null;
  });
  return value;
}

const tacticOf = (r: typeof tactics.$inferSelect): Tactic => ({ id: r.id, name: r.name, description: r.description, createdBy: r.createdBy, createdAt: r.createdAt.toISOString() });
const strategyOf = (r: typeof strategies.$inferSelect): Strategy => ({
  id: r.id,
  name: r.name,
  description: r.description,
  requiresTacticIds: [...r.requiresTacticIds].sort(),
  excludesTacticIds: [...r.excludesTacticIds].sort(),
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
});
const verdictOf = (r: typeof workflowTacticVerdicts.$inferSelect): TacticVerdictRow => ({
  workflowSlug: r.workflowSlug,
  tacticId: r.tacticId,
  workflowDynastySlug: r.workflowDynastySlug,
  version: r.version,
  versionActive: r.versionActive,
  verdict: r.verdict,
  probability: r.probability,
  model: r.model,
  judgedAt: r.judgedAt.toISOString(),
});

/** Every stored verdict of one tactic (the sweep's "already judged" set and the tactic detail). */
export async function listVerdicts(tacticId?: string): Promise<TacticVerdictRow[]> {
  const rows = tacticId ? await db.select().from(workflowTacticVerdicts).where(sql`${workflowTacticVerdicts.tacticId} = ${tacticId}`) : await db.select().from(workflowTacticVerdicts);
  return rows.map(verdictOf);
}

/** A name or a description already taken (case-insensitive) in the family, named in the refusal. */
function assertUnique(existing: ReadonlyArray<{ id: string; name: string; description: string }>, id: string, name: string, description: string, family: string): void {
  if (existing.some((e) => e.id === id)) throw new DeclarationError(409, `${family}_exists`, `a ${family} ${id} already exists`);
  const sameName = existing.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (sameName) throw new DeclarationError(409, `${family}_name_taken`, `the ${family} ${sameName.id} is already named ${JSON.stringify(name)}`);
  const sameDescription = existing.find((e) => e.description.toLowerCase() === description.toLowerCase());
  if (sameDescription) throw new DeclarationError(409, `${family}_description_taken`, `the ${family} ${sameDescription.id} already has this description`);
}

export async function insertTactic(input: { name: string; description: string; createdBy: string }): Promise<Tactic> {
  const id = idOfName(input.name);
  if (!id) throw new DeclarationError(400, "name_invalid", "name must hold at least one letter or digit");
  assertUnique((await loadPlayCatalogueFresh()).tactics, id, input.name, input.description, "tactic");
  const [row] = await db.insert(tactics).values({ id, name: input.name, description: input.description, createdBy: input.createdBy }).returning();
  invalidatePlayCatalogue();
  return tacticOf(row);
}

export async function insertStrategy(input: { name: string; description: string; requiresTacticIds: string[]; excludesTacticIds: string[]; createdBy: string }): Promise<Strategy> {
  const id = idOfName(input.name);
  if (!id) throw new DeclarationError(400, "name_invalid", "name must hold at least one letter or digit");
  const current = await loadPlayCatalogueFresh();
  assertUnique(current.strategies, id, input.name, input.description, "strategy");
  for (const t of [...input.requiresTacticIds, ...input.excludesTacticIds]) {
    if (!current.tactics.some((x) => x.id === t)) throw new DeclarationError(404, "tactic_not_found", `no tactic ${t} (GET /internal/catalogue/tactics)`);
  }
  const both = input.requiresTacticIds.filter((t) => input.excludesTacticIds.includes(t));
  if (both.length > 0) throw new DeclarationError(400, "tactic_required_and_excluded", `a strategy cannot both require and exclude ${both.join(", ")}`);
  if (input.requiresTacticIds.length + input.excludesTacticIds.length === 0) {
    throw new DeclarationError(400, "strategy_empty", "a strategy requires or excludes at least one tactic");
  }
  // Two strategies with the same rule are one strategy under two names.
  const key = (r: string[], e: string[]) => `${[...r].sort().join(",")}|${[...e].sort().join(",")}`;
  const twin = current.strategies.find((s) => key(s.requiresTacticIds, s.excludesTacticIds) === key(input.requiresTacticIds, input.excludesTacticIds));
  if (twin) throw new DeclarationError(409, "strategy_rule_taken", `the strategy ${twin.id} already requires and excludes exactly these tactics`);
  const [row] = await db
    .insert(strategies)
    .values({ id, name: input.name, description: input.description, requiresTacticIds: input.requiresTacticIds, excludesTacticIds: input.excludesTacticIds, createdBy: input.createdBy })
    .returning();
  invalidatePlayCatalogue();
  return strategyOf(row);
}

/** Catalogue a play on a pipe (the caller checked the pipe exists). Idempotent: an existing play answers `created:false`. */
export async function insertPlay(input: { pipeId: string; strategyId: string; createdBy: string }): Promise<{ created: boolean }> {
  const current = await loadPlayCatalogueFresh();
  if (!current.strategies.some((s) => s.id === input.strategyId)) throw new DeclarationError(404, "strategy_not_found", `no strategy ${input.strategyId} (GET /internal/catalogue/strategies)`);
  const inserted = await db.insert(plays).values({ pipeId: input.pipeId, strategyId: input.strategyId, isDefault: false, createdBy: input.createdBy }).onConflictDoNothing().returning();
  invalidatePlayCatalogue();
  return { created: inserted.length > 0 };
}

/** The tables as rows, read now (never the 30 s shared copy): a uniqueness check reads what is stored. */
async function loadPlayCatalogueFresh(): Promise<{ tactics: Tactic[]; strategies: Strategy[] }> {
  const [t, s] = await Promise.all([db.select().from(tactics), db.select().from(strategies)]);
  return { tactics: t.map(tacticOf), strategies: s.map(strategyOf) };
}

/** Store one verdict (judged once: an existing row is never overwritten). */
export async function insertVerdict(row: Omit<TacticVerdictRow, "judgedAt"> & { featureSlug: string }): Promise<void> {
  await db
    .insert(workflowTacticVerdicts)
    .values({
      workflowSlug: row.workflowSlug,
      tacticId: row.tacticId,
      workflowDynastySlug: row.workflowDynastySlug,
      featureSlug: row.featureSlug,
      version: row.version,
      versionActive: row.versionActive,
      verdict: row.verdict,
      probability: row.probability,
      model: row.model,
    })
    .onConflictDoNothing();
  invalidatePlayCatalogue();
}

/** Refresh which version of a judged workflow is active (a version is deprecated when its dynasty moves on). */
export async function refreshVersionActive(workflowSlug: string, versionActive: boolean): Promise<void> {
  await db.update(workflowTacticVerdicts).set({ versionActive }).where(sql`${workflowTacticVerdicts.workflowSlug} = ${workflowSlug} AND ${workflowTacticVerdicts.versionActive} <> ${versionActive}`);
}
