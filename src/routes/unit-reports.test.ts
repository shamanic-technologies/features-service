import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * SCRIPT-VALUE-RATING-1113: a client says a Unit is not good (an edit of what we wrote, or a "Report" click, from the
 * dashboard, the API, the MCP or Sophie). The real route; only the store is mocked.
 */
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
process.env.FEATURES_SERVICE_API_KEY = "k";

const stored: Array<Record<string, unknown>> = [];
const asked: Array<Record<string, unknown>> = [];
let failWrite = false;
vi.mock("../lib/unit-client-reports-store.js", () => ({
  UNIT_REPORT_KINDS: ["edited", "reported"],
  listOrgUnitReports: async (q: Record<string, unknown>) => {
    if (failWrite) throw new Error("db down");
    asked.push(q);
    return [{ id: "r1", ...q, kind: "reported", source: "dashboard", note: null, unitAt: null, reportedAt: "2026-11-13T16:00:00.000Z" }];
  },
  recordUnitReport: async (r: Record<string, unknown>) => {
    if (failWrite) throw new Error("db down");
    stored.push(r);
    return { id: "9b0c1a3e-0000-4000-8000-000000000001", ...r, reportedAt: "2026-11-13T16:00:00.000Z" };
  },
}));

const { default: routes } = await import("./unit-reports.js");
const app = express().use(express.json()).use(routes);
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const identity = { "x-api-key": "k", "x-org-id": ORG, "x-user-id": USER, "x-run-id": RUN };
const body = { outcomeKey: "message_written", subjectService: "lead-service", subjectId: "0c0010c9", kind: "reported", source: "dashboard" };

beforeEach(() => {
  stored.length = 0;
  asked.length = 0;
  failWrite = false;
});

describe("POST /orgs/unit-reports", () => {
  it("stores a report of a Unit under the caller's org and user", async () => {
    const res = await request(app).post("/orgs/unit-reports").set(identity).send({ ...body, note: "wrong price" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: expect.any(String), outcomeKey: "message_written", kind: "reported", reportedAt: expect.any(String) });
    expect(stored).toEqual([{ orgId: ORG, userId: USER, outcomeKey: "message_written", subjectService: "lead-service", subjectId: "0c0010c9", kind: "reported", source: "dashboard", note: "wrong price", unitAt: null }]);
  });

  it("an edit of what we wrote is the other kind, no note needed", async () => {
    const res = await request(app).post("/orgs/unit-reports").set(identity).send({ ...body, outcomeKey: "offer_fields_drafted", subjectService: "brand-service", kind: "edited" });
    expect(res.status).toBe(201);
    expect(stored[0]).toMatchObject({ kind: "edited", note: null });
  });

  it.each([
    ["no outcome", { ...body, outcomeKey: "" }],
    ["no subject", { ...body, subjectId: undefined }],
    ["no subject service", { ...body, subjectService: 3 }],
    ["an unknown kind", { ...body, kind: "liked" }],
    ["no source", { ...body, source: "" }],
    ["a note that is not text", { ...body, note: 4 }],
    ["a time that is not a time", { ...body, unitAt: "yesterday-ish" }],
  ])("refuses %s, stores nothing", async (_label, bad) => {
    const res = await request(app).post("/orgs/unit-reports").set(identity).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("unit_report_unrecognised");
    expect(stored).toEqual([]);
  });

  it("needs the key and the identity", async () => {
    expect((await request(app).post("/orgs/unit-reports").send(body)).status).toBe(401);
    expect((await request(app).post("/orgs/unit-reports").set({ "x-api-key": "k" }).send(body)).status).toBe(400);
  });

  it("a write that fails is loud, never a 201", async () => {
    failWrite = true;
    const res = await request(app).post("/orgs/unit-reports").set(identity).send(body);
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("unit_report_unwritable");
  });
});

describe("the Unit the client points at", () => {
  it("keeps when the thing was made, so the ledger resolves that Unit and not the latest of its subject", async () => {
    const res = await request(app).post("/orgs/unit-reports").set(identity).send({ ...body, unitAt: "2026-11-01T09:30:00+01:00" });
    expect(res.status).toBe(201);
    expect(stored[0]).toMatchObject({ unitAt: "2026-11-01T08:30:00.000Z" });
  });
});

describe("GET /orgs/unit-reports", () => {
  it("serves the caller's org's own reports of one subject", async () => {
    const res = await request(app).get("/orgs/unit-reports?subjectService=lead-service&subjectId=0c0010c9&outcomeKey=message_written").set(identity);
    expect(res.status).toBe(200);
    expect(asked).toEqual([{ orgId: ORG, subjectService: "lead-service", subjectId: "0c0010c9", outcomeKey: "message_written" }]);
    expect(res.body.reports).toHaveLength(1);
  });

  it("every outcome of the subject when none is named; a subject is required; a failed read is loud", async () => {
    await request(app).get("/orgs/unit-reports?subjectService=lead-service&subjectId=x").set(identity);
    expect(asked[0]).toMatchObject({ outcomeKey: null });
    expect((await request(app).get("/orgs/unit-reports?subjectId=x").set(identity)).status).toBe(400);
    failWrite = true;
    expect((await request(app).get("/orgs/unit-reports?subjectService=a&subjectId=x").set(identity)).status).toBe(502);
  });
});
