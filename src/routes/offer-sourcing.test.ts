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
    const provider = Object.fromEntries(res.body.origins.map((o: { slug: string; provider: unknown }) => [o.slug, o.provider]));
    expect(provider["sourcing-apollo-cold-filters"]).toEqual({ name: "Apollo", domain: "apollo.io" });
    expect(provider["sourcing-linkedin-engagement-signals"]).toEqual({ name: "LinkedIn", domain: "linkedin.com" });
    expect(provider["sourcing-crm-contacts"]).toBeNull();
    for (const o of res.body.origins) expect(o).toHaveProperty("provider");
  });
});
