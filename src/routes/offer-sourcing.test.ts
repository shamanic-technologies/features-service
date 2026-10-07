import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import express from "express";
import request from "supertest";
import router from "./offer-sourcing.js";
import { SOURCING_ORIGINS_BY_CHANNEL } from "../lib/sourcing-origins.js";

describe("GET /public/sourcing-origins", () => {
  it("serves every origin, the sourcing channels and the origins each channel serves from", async () => {
    const app = express().use(router);
    const res = await request(app).get("/public/sourcing-origins");
    expect(res.status).toBe(200);
    expect(res.body.origins.map((o: { slug: string }) => o.slug)).toContain("sourcing-apollo-cold-filters");
    expect(res.body.sourcingChannels).toEqual(Object.keys(SOURCING_ORIGINS_BY_CHANNEL).sort());
    expect(res.body.originsByChannel).toEqual(SOURCING_ORIGINS_BY_CHANNEL);
    expect(res.body.originsByChannel["sales-crm-email-outreach"]).toEqual(["sourcing-crm-contacts"]);
  });
});
