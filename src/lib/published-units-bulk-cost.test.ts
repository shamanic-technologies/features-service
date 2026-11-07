import { beforeEach, describe, expect, it, vi } from "vitest";

// NEWSLETTER-COST-1107-FEATURES: a stored newsletter release total moves when the ledger's money on its rows moves,
// not only when its Units count moves (prod 2026-11-07: Postmark sends re-priced 1.19c -> 0.165c, count unchanged).

const store = new Map<string, string>();
let lastWriteKey: string | null = null;
vi.mock("../db/index.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (lastWriteKey && store.has(lastWriteKey) ? [{ bodyText: store.get(lastWriteKey) }] : []) }),
      }),
    }),
    insert: () => ({
      values: (v: { scopeKey: string; bodyText: string }) => ({
        onConflictDoUpdate: async () => {
          store.set(v.scopeKey, v.bodyText);
          lastWriteKey = v.scopeKey;
        },
      }),
    }),
  },
  sql: {},
}));

const fetchWithRetry = vi.fn();
vi.mock("./fetch-retry.js", () => ({ fetchWithRetry: (...a: unknown[]) => fetchWithRetry(...a) }));

import { sweepBulkRuns } from "./published-units-io.js";
import { BULK_RUN_REBUILD_CEILING_MS, bulkRunCostKeyOf, bulkRunRebuildReason, type LedgerOccurrence } from "./published-units.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const UNITS = 3;
let centsPerEmail = "1.1923620000";
let fullReads = 0;

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

function ledger(url: string): unknown {
  const q = new URL(url).searchParams;
  if (q.get("limit") === "1000") fullReads += 1;
  if (q.get("direction") === "produced") {
    return { occurrences: Array.from({ length: UNITS }, (_, i) => ({ id: `n${i}`, runId: RUN, direction: "produced", outcomeKey: "newsletter_email_sent", cost: { grossCents: "0", netCents: "0" } })), nextCursor: null };
  }
  return {
    occurrences: Array.from({ length: UNITS }, (_, i) => ({
      id: `m${i}`,
      runId: RUN,
      direction: "consumed",
      outcomeKey: "message_sent",
      consumption: { sourceOccurrenceId: `s${i}`, sourceRunId: `sr${i}`, consumingOutcomes: [{ outcomeKey: "newsletter_email_sent", standardCost: { grossCents: centsPerEmail, netCents: centsPerEmail } }] },
    })),
    nextCursor: null,
  };
}

beforeEach(() => {
  store.clear();
  lastWriteKey = null;
  fullReads = 0;
  centsPerEmail = "1.1923620000";
  process.env.RUNS_SERVICE_URL = "http://runs";
  process.env.RUNS_SERVICE_API_KEY = "k";
  process.env.TRANSACTIONAL_EMAIL_SERVICE_URL = "http://tes";
  process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "k";
  fetchWithRetry.mockReset();
  fetchWithRetry.mockImplementation(async (url: string) => {
    if (url.startsWith("http://tes/internal/mailing-list-releases")) {
      return json({ releases: [{ releaseId: "r1", listSlug: "newsletter", subject: "Hi", orgId: "org-1", brandIds: [], unitsRunId: RUN, emailsSent: UNITS, unitsDeclared: UNITS, firstSentAt: "2026-10-12T11:42:49Z", createdAt: "2026-10-12T11:40:00Z" }] });
    }
    if (url.startsWith("http://runs/internal/outcome-occurrences")) return json(ledger(url));
    throw new Error(`unexpected ${url}`);
  });
});

const storedGross = () => (JSON.parse(store.get(`${RUN}|newsletter_email_sent`)!) as { agg: { grossUsd: number } }).agg.grossUsd;

describe("a newsletter release total follows its ledger money (NEWSLETTER-COST-1107-FEATURES)", () => {
  it("same Units count, changed ledger cost: the sweep rebuilds and stores the new figure", async () => {
    await sweepBulkRuns();
    expect(fullReads).toBe(2);
    expect(storedGross()).toBeCloseTo(0.035771, 6);

    centsPerEmail = "0.1650000000"; // runs-service re-priced the sends; the Units count did not move
    await sweepBulkRuns();
    expect(fullReads).toBe(4);
    expect(storedGross()).toBeCloseTo(0.00495, 6);
  });

  it("unchanged Units and ledger cost: no rebuild", async () => {
    await sweepBulkRuns();
    await sweepBulkRuns();
    await sweepBulkRuns();
    expect(fullReads).toBe(2);
  });

  it("a total stored before the money key existed is rebuilt once (the one-time invalidation)", async () => {
    store.set(`${RUN}|newsletter_email_sent`, JSON.stringify({ fingerprint: String(UNITS), agg: { units: UNITS, netUsd: 9, grossUsd: 9 } }));
    lastWriteKey = `${RUN}|newsletter_email_sent`;
    await sweepBulkRuns();
    expect(fullReads).toBe(2);
    expect(storedGross()).toBeCloseTo(0.035771, 6);
    await sweepBulkRuns();
    expect(fullReads).toBe(2);
  });
});

describe("bulkRunRebuildReason", () => {
  const agg = { units: 1, netUsd: 0, grossUsd: 0 };
  const now = Date.parse("2026-11-07T16:00:00Z");
  const builtAt = "2026-11-07T15:00:00Z";
  it("names why a stored total is no longer the ledger's", () => {
    expect(bulkRunRebuildReason(null, { fingerprint: "1", costKey: "a" }, now)).toBe("never_built");
    expect(bulkRunRebuildReason({ fingerprint: "1", costKey: "a", builtAt, agg }, { fingerprint: "2", costKey: "a" }, now)).toBe("units_moved");
    expect(bulkRunRebuildReason({ fingerprint: "1", costKey: "a", builtAt, agg }, { fingerprint: "1", costKey: "b" }, now)).toBe("ledger_cost_moved");
    expect(bulkRunRebuildReason({ fingerprint: "1", costKey: "a", builtAt, agg }, { fingerprint: "1", costKey: "a" }, now)).toBeNull();
    expect(bulkRunRebuildReason({ fingerprint: "1", costKey: "a", builtAt, agg }, { fingerprint: "1", costKey: "a" }, Date.parse(builtAt) + BULK_RUN_REBUILD_CEILING_MS + 1)).toBe("ceiling");
  });
  it("an unreadable money key (null) never forces a rebuild on its own", () => {
    expect(bulkRunRebuildReason({ fingerprint: "1", costKey: "a", builtAt, agg }, { fingerprint: "1", costKey: null }, now)).toBeNull();
  });
  it("the money key moves with a consumed part's cost, not with rows of another outcome", () => {
    const c = (cents: string, key = "newsletter_email_sent"): LedgerOccurrence =>
      ({ id: "m", runId: "r", direction: "consumed", outcomeKey: "message_sent", consumption: { sourceOccurrenceId: null, consumingOutcomes: [{ outcomeKey: key, standardCost: { grossCents: cents, netCents: cents } }] } }) as LedgerOccurrence;
    expect(bulkRunCostKeyOf("newsletter_email_sent", [], [c("1.19")])).not.toBe(bulkRunCostKeyOf("newsletter_email_sent", [], [c("0.165")]));
    expect(bulkRunCostKeyOf("newsletter_email_sent", [], [c("1.19", "x")])).toBe(bulkRunCostKeyOf("newsletter_email_sent", [], [c("5", "x")]));
  });
});
