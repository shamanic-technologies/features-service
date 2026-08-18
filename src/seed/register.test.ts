/**
 * THE STALE-ROW PRUNE RUNS BEFORE THE UPSERT, AND A SLUG RENAME IS WHY.
 *
 * Renaming a feature's slug is a delete plus an insert, and while both rows exist they agree on
 * every column except the slug — including `name`, which is UNIQUE in the schema. Writing the new
 * row first therefore trips `features_name_unique` on the BOOT path, so the process dies before it
 * listens, the deploy health check fails and the box rolls the service back. The order is the fix,
 * so it is asserted here rather than left to a comment.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];

vi.mock("../db/index.js", () => {
  const db = {
    delete: () => {
      calls.push("delete");
      return {
        where: () => ({ returning: async () => [{ slug: "sales-feedback-request-cold-email-outreach" }] }),
      };
    },
    query: {
      features: {
        // Every seed slug reads as absent, so each one takes the INSERT branch — the branch that
        // collides with a dead row's name when the prune has not run yet.
        findFirst: async () => undefined,
      },
    },
    insert: () => {
      calls.push("insert");
      return { values: async () => undefined };
    },
    update: () => {
      calls.push("update");
      return { set: () => ({ where: async () => undefined }) };
    },
  };
  return { db, sql: {} };
});

import { registerSeedFeatures } from "./register.js";
import { SEED_FEATURES } from "./features.js";

beforeEach(() => {
  calls.length = 0;
});

describe("registerSeedFeatures", () => {
  it("prunes stale rows BEFORE writing any seed row — a slug rename must not collide on the unique name", async () => {
    await registerSeedFeatures();

    expect(calls[0]).toBe("delete");
    expect(calls.filter((c) => c === "delete")).toHaveLength(1);
    expect(calls.slice(1).every((c) => c === "insert" || c === "update")).toBe(true);
    expect(calls).toHaveLength(1 + SEED_FEATURES.length);
  });
});

describe("the seed catalogue itself", () => {
  it("states a UNIQUE name per feature — the column is unique, so a duplicate would fail at boot, not in a request", () => {
    const names = SEED_FEATURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("states a unique slug per feature", () => {
    const slugs = SEED_FEATURES.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
