import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── The serve path that sends the STORED TEXT as the response (servedCachedJson) ─────────────────────
//
// A snapshot hit used to decode a multi-MB jsonb row, parse it, then re-stringify it for `res.json` —
// all on the serving loop. The text column is now served as-is. These cases pin that the bytes a
// client receives are exactly what `res.json(value)` sends, for an ordinary body and for a body jsonb
// refuses (a NUL in a lead's name), on every path: miss, hit on a text row, hit on a pre-text jsonb row.

let storedRow: Record<string, unknown> | undefined;

const dbMock = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => (storedRow ? [storedRow] : []),
        orderBy: () => ({ limit: async () => [] }),
      }),
    }),
  }),
  insert: () => ({
    values: (v: Record<string, unknown>) => ({
      onConflictDoUpdate: async () => {
        storedRow = { ...v };
      },
    }),
  }),
  update: () => ({
    set: () => ({
      where: () => ({
        then: (resolve: (v: unknown) => void) => resolve(undefined),
        returning: async () => [{ id: "snap-1" }],
      }),
    }),
  }),
  delete: () => ({ where: () => ({ returning: async () => [] }) }),
};

vi.mock("../db/index.js", () => ({ db: dbMock, sql: {} }));

const { servedCached, servedCachedJson, sendSnapshotJson, encodeSnapshotBody, bodyFromText, bodyFromValue } = await import(
  "./view-cache.js"
);
const { envelopedJson } = await import("./view-refresher.js");

// Key order is deliberately NOT sorted: jsonb would reorder it, the text keeps the computed order.
const ORDINARY = { zeta: 1, alpha: { b: [1, 2.5, null], a: "é ✓" }, total: 3 };
const WITH_NUL = { organizations: [{ name: "Ada\u0000Lovelace", value: 12.5 }], note: "x\ud800y", total: 3 };

const args = (compute: () => Promise<unknown>) => ({ view: "brand-revenue", scopeKey: "b1|pricing=net", orgId: "o1", compute });

/** What `res.json(value)` sends: status, content type, ETag and bytes. */
async function viaResJson(value: unknown) {
  const app = express();
  app.get("/x", (_req, res) => {
    res.json(value);
  });
  return request(app).get("/x");
}

async function viaSnapshot(json: string) {
  const app = express();
  app.get("/x", (_req, res) => {
    sendSnapshotJson(res, { json } as never);
  });
  return request(app).get("/x");
}

beforeEach(() => {
  storedRow = undefined;
  process.env.FEATURE_VIEW_CACHE_ENABLED = "true";
  process.env.FEATURE_VIEW_SNAPSHOT_TTL_MS = "60000";
});

describe.each([
  ["an ordinary body", ORDINARY],
  ["a body jsonb refuses (NUL, lone surrogate)", WITH_NUL],
])("servedCachedJson — %s", (_label, value) => {
  it("a MISS computes, answers the value's own JSON text, and persists it as text beside the jsonb", async () => {
    const out = await servedCachedJson(args(async () => value));
    expect(out.json).toBe(JSON.stringify(value));
    expect(storedRow!.bodyText).toBe(JSON.stringify(value));
    // The jsonb column is still written (readable by a query or a rolled-back build), encoded when refused.
    expect(storedRow!.body).toEqual(encodeSnapshotBody(value));
  });

  it("a HIT on a text row answers the stored text byte for byte, and never computes", async () => {
    await servedCachedJson(args(async () => value));
    const compute = vi.fn(async () => ({ different: true }));
    const out = await servedCachedJson(args(compute));
    expect(compute).not.toHaveBeenCalled();
    expect(out.json).toBe(JSON.stringify(value));
    // The value path reads the same row and restores the same value.
    expect(await servedCached(args(compute))).toEqual(value);
  });

  it("a HIT on a row written BEFORE the text column (jsonb only) answers the same bytes", async () => {
    storedRow = { body: encodeSnapshotBody(value), bodyText: null, computedAt: new Date(), factsFingerprint: null };
    const out = await servedCachedJson(args(async () => ({ never: true })));
    expect(out.json).toBe(JSON.stringify(value));
    expect(await servedCached(args(async () => ({ never: true })))).toEqual(value);
  });

  it("sends exactly what res.json(value) sends: status, content type, ETag and bytes", async () => {
    const out = await servedCachedJson(args(async () => value));
    const [expected, actual] = await Promise.all([viaResJson(value), viaSnapshot(out.json)]);
    expect(actual.status).toBe(expected.status);
    expect(actual.headers["content-type"]).toBe(expected.headers["content-type"]);
    expect(actual.headers["etag"]).toBe(expected.headers["etag"]);
    expect(actual.text).toBe(expected.text);
    expect(JSON.parse(actual.text)).toEqual(value);
  });
});

describe("sendSnapshotJson", () => {
  it("answers a conditional request with 304, exactly as res.json does", async () => {
    const json = JSON.stringify(ORDINARY);
    const app = express();
    app.get("/x", (_req, res) => {
      sendSnapshotJson(res, { json } as never);
    });
    const first = await request(app).get("/x");
    const second = await request(app).get("/x").set("If-None-Match", first.headers["etag"]);
    expect(second.status).toBe(304);
  });
});

describe("a cached body converts only when, and only once, the other form is asked for", () => {
  it("text → value parses once", () => {
    const parse = vi.spyOn(JSON, "parse");
    const body = bodyFromText(JSON.stringify(ORDINARY));
    expect(parse).not.toHaveBeenCalled();
    expect(body.value()).toEqual(ORDINARY);
    body.value();
    expect(parse).toHaveBeenCalledTimes(1);
    parse.mockRestore();
  });

  it("value → text stringifies once, and an undefined value is an empty body like res.json's", () => {
    expect(bodyFromValue(ORDINARY).text()).toBe(JSON.stringify(ORDINARY));
    expect(bodyFromValue(undefined).text()).toBe("");
  });
});

describe("envelopedJson — the refresher's answer, cut out without a parse", () => {
  const envelope = (value: unknown) => JSON.stringify({ __viewRefresherComputed: value });

  it.each([["ordinary", ORDINARY], ["NUL-carrying", WITH_NUL], ["null", null], ["array", [1, 2]], ["string", "a}b"]])(
    "returns the %s value's exact JSON text",
    (_label, value) => {
      expect(envelopedJson(envelope(value))).toBe(JSON.stringify(value));
    },
  );

  it("refuses anything that is not the envelope", () => {
    expect(envelopedJson("{}")).toBeUndefined(); // an undefined value is not a computed one
    expect(envelopedJson(JSON.stringify({ error: "boom" }))).toBeUndefined();
    expect(envelopedJson("not json")).toBeUndefined();
  });
});

describe("withInteractiveReads — a request's pre-cache reads share downstream answers like a view compute", () => {
  it("marks its async context interactive, and only its own", async () => {
    const { withInteractiveReads, insideInteractiveView } = await import("./lead-copy.js");
    expect(insideInteractiveView()).toBe(false);
    expect(await withInteractiveReads(async () => insideInteractiveView())).toBe(true);
    expect(insideInteractiveView()).toBe(false);
  });
});
