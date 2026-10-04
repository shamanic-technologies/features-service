import { beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory stand-in for the one table: rows persist across calls like the real store.
const store = vi.hoisted(() => ({ rows: [] as Array<{ combinationKey: string; name: string }> }));
vi.mock("../db/index.js", () => {
  const selectAll = (cols: Record<string, unknown>) => ({
    from: () => {
      const all = () => store.rows.map((r) => ("key" in cols ? { key: r.combinationKey, name: r.name } : { name: r.name }));
      const q = Promise.resolve().then(all) as Promise<unknown[]> & { where: () => Promise<unknown[]> };
      q.where = () => Promise.resolve(all());
      return q;
    },
  });
  const tx = {
    select: selectAll,
    execute: async () => undefined,
    insert: () => ({
      values: async (vals: Array<{ combinationKey: string; name: string }>) => {
        for (const v of vals) {
          if (store.rows.some((r) => r.combinationKey === v.combinationKey || r.name === v.name)) throw new Error("unique violation");
          store.rows.push(v);
        }
      },
    }),
  };
  return { db: { ...tx, transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) }, sql: {} };
});

import { nextUnusedNames, SALES_PATH_NAME_POOL, salesPathNamesFor, SalesPathNamePoolExhaustedError } from "./sales-path-names.js";
import { combinationKeyOf, enumerateSalesPaths, legChannelsForScope } from "./offer-sales-paths.js";
import { FUNNEL_LEGS } from "./funnel-legs.js";
import { buildChannelCatalogue } from "./channel-catalogue.js";
import { SEED_FEATURES } from "../seed/features.js";

describe("the name pool", () => {
  it("is English one-word optimistic names, each given once", () => {
    expect(SALES_PATH_NAME_POOL.slice(0, 4)).toEqual(["Victory", "Sol", "Herald", "Epiphany"]);
    expect(new Set(SALES_PATH_NAME_POOL).size).toBe(SALES_PATH_NAME_POOL.length);
    for (const w of SALES_PATH_NAME_POOL) expect(w).toMatch(/^[A-Z][a-z]+$/);
  });

  it("outnumbers every combination the catalogue can form, so it never runs out in practice", () => {
    const channels = buildChannelCatalogue(SEED_FEATURES).map((c) => ({
      slug: c.slug,
      name: c.name,
      operatedBy: c.operatedBy,
      trigger: c.trigger,
      legKeys: c.stepTransitions.map((t) => t.legKey),
    }));
    // Every combination BOTH scopes can list (the default managed read over every leg it could be ticked
    // on, and the catalogue read over the shortlist), counted once by key.
    const keys = new Set<string>();
    for (const scope of ["ticked", "catalogue"] as const) {
      for (const chain of enumerateSalesPaths(FUNNEL_LEGS.map((l) => l.legKey))) {
        const options = chain.map((leg) => {
          const offered = legChannelsForScope(channels, leg, scope);
          return offered.length === 0 ? [leg] : offered.map((c) => (c.operatedBy === "platform" ? `${leg}@${c.slug}` : leg));
        });
        const walk = (i: number, acc: string[]): void => {
          if (i === options.length) return void keys.add(acc.join("+"));
          for (const o of options[i]) walk(i + 1, [...acc, o]);
        };
        walk(0, []);
      }
    }
    const combinations = keys.size;
    expect(combinations).toBeGreaterThan(40);
    expect(SALES_PATH_NAME_POOL.length).toBeGreaterThanOrEqual(2 * combinations);
  });

  it("hands out the first unused words in pool order, and fails loud when short", () => {
    expect(nextUnusedNames(["A", "B", "C", "D"], new Set(["A", "C"]), 2)).toEqual(["B", "D"]);
    expect(() => nextUnusedNames(["A", "B"], new Set(["A"]), 2)).toThrow(SalesPathNamePoolExhaustedError);
  });
});

describe("salesPathNamesFor — shared, stable forever, never reused", () => {
  beforeEach(() => {
    store.rows = [];
  });
  const k1 = combinationKeyOf([{ legKey: "start_to_conversation", channelSlug: "sales-cold-email-outreach" }, { legKey: "conversation_to_paid_client", channelSlug: null }]);
  const k2 = combinationKeyOf([{ legKey: "start_to_website_visit", channelSlug: "sales-cold-email-outreach" }, { legKey: "website_visit_to_paid_client", channelSlug: null }]);
  const k3 = "start_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking";

  it("names new combinations in rank order, and a re-read (any brand, any order) returns the same names", async () => {
    expect(k1).toBe("start_to_conversation@sales-cold-email-outreach+conversation_to_paid_client");
    const first = await salesPathNamesFor([k1, k2]);
    expect([first.get(k1), first.get(k2)]).toEqual(["Victory", "Sol"]);
    // Another brand reads the same combinations in the opposite rank, plus a new one.
    const second = await salesPathNamesFor([k3, k2, k1]);
    expect([second.get(k1), second.get(k2), second.get(k3)]).toEqual(["Victory", "Sol", "Herald"]);
    expect(store.rows).toHaveLength(3);
  });

  it("a name already given is never handed to another combination", async () => {
    store.rows = [{ combinationKey: "retired-combination", name: "Victory" }];
    const names = await salesPathNamesFor([k1]);
    expect(names.get(k1)).toBe("Sol");
  });
});
