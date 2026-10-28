import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { restorePostgresArrayTypes } from "./postgres-array-types.js";
import { restoreDriverErrorMessages } from "../lib/pg-error.js";

const connectionString = process.env.FEATURES_SERVICE_DATABASE_URL;

if (!connectionString) {
  throw new Error("FEATURES_SERVICE_DATABASE_URL is not set");
}

// Connections are RECYCLED (BOX-LOAD-1028-PG-CONNS). A Postgres backend keeps the memory of the biggest
// query it ever ran until it exits; at postgres.js's default lifetime (30-60 min) features_service's 20
// backends (this pool + the view refresher's) held ~0.3 GB private memory on the shared box, mostly swapped
// (2026-10-28). `max_lifetime` 5 min ends a connection after its current query (postgres.js never cuts a
// running query or a reserved connection); `idle_timeout` 60 s closes the ones a quiet stretch leaves
// unused. `max` stays postgres.js's 10, now stated.
export const POOL_OPTIONS = { max: 10, idle_timeout: 60, max_lifetime: 300 } as const;
export const sql = postgres(connectionString, POOL_OPTIONS);
export const db = drizzle(sql, { schema });
// drizzle-orm >= 0.41/0.44 runtime changes, restored to their 0.36 behaviour:
// date[]/timestamp[]/numeric[] back to postgres.js, and a failed query's message is the database's
// own again (no SQL text or bound values in what we answer with or store).
restorePostgresArrayTypes(sql);
restoreDriverErrorMessages();
