/**
 * The fleet brand-transfer route: contract shape, auth, validation, the 409 on an overlapping stated
 * amount, and the answer being exactly what the lib reports.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
const transferBrand = vi.fn();
vi.mock("../lib/transfer-brand.js", () => ({ transferBrand: (...a: unknown[]) => transferBrand(...a) }));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
const { default: app } = await import("../index.js");
const { StatedAmountConflictError } = await import("../lib/stated-monthly-amounts-store.js");

const SRC_BRAND = "11111111-1111-4111-8111-111111111111";
const SRC_ORG = "22222222-2222-4222-8222-222222222222";
const DST_ORG = "33333333-3333-4333-8333-333333333333";

describe("POST /internal/transfer-brand", () => {
  beforeEach(() => {
    transferBrand.mockReset();
    delete process.env.VIEW_REFRESHER_PORT;
  });

  it("moves the brand and reports what moved", async () => {
    const tables = [
      { tableName: "stated_monthly_amounts", count: 1 },
      { tableName: "feature_view_snapshots", count: 7 },
    ];
    transferBrand.mockResolvedValue(tables);
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", "test-key")
      .send({ sourceBrandId: SRC_BRAND, sourceOrgId: SRC_ORG, targetOrgId: DST_ORG });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updatedTables: tables });
    expect(transferBrand).toHaveBeenCalledWith({ sourceBrandId: SRC_BRAND, sourceOrgId: SRC_ORG, targetOrgId: DST_ORG });
  });

  it("needs only the service key (no org/user/run headers)", async () => {
    const res = await request(app).post("/internal/transfer-brand").send({ sourceBrandId: SRC_BRAND, sourceOrgId: SRC_ORG, targetOrgId: DST_ORG });
    expect(res.status).toBe(401);
  });

  it("400s a malformed body", async () => {
    const res = await request(app).post("/internal/transfer-brand").set("x-api-key", "test-key").send({ sourceBrandId: "x" });
    expect(res.status).toBe(400);
    expect(transferBrand).not.toHaveBeenCalled();
  });

  it("409s when a moved stated amount would overlap one the target holds", async () => {
    transferBrand.mockRejectedValue(new StatedAmountConflictError("overlap"));
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", "test-key")
      .send({ sourceBrandId: SRC_BRAND, sourceOrgId: SRC_ORG, targetOrgId: DST_ORG });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("stated_amount_conflict");
  });
});
