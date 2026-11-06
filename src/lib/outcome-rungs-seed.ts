/**
 * PURE. Reads the rows migration 0061 seeded into `outcome_lifecycle_rungs` out of its SQL text (the migration is the
 * one place the coded steps' rungs were written down). Used by the suite's in-memory store and by the guard that every
 * coded step has its row; never by a production read (production reads the table).
 */
export function seededOutcomeRungs(migrationSql: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of migrationSql.matchAll(/\('([a-z0-9_]+)',\s*'([a-z_]+)',\s*'migration-0061'\)/g)) out.set(m[1]!, m[2]!);
  return out;
}
