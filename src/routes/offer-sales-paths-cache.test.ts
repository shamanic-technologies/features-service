import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every dashboard v2 brand page polls `/offers/:id/sales-paths` every 5 s; computed live it cost 1.7-2.3 s
// warm (prod 2026-10-14, brand ea3fb68c). It is served from its Gold cell like every other money read, and
// the inputs a customer writes ride the key so a write never replays the pre-write answer.
const route = readFileSync(new URL("./offer-sales-paths.ts", import.meta.url), "utf8");
const handler = route.slice(route.indexOf('router.get("/offers/:offerId/sales-paths"'));

describe("offer sales-paths read served from its Gold cell", () => {
  it("answers through servedCachedJson + sendSnapshotJson, never a live res.json of the computed body", () => {
    expect(handler).toContain('view: "offer-sales-paths"');
    expect(handler).toContain("sendSnapshotJson(res, payload)");
    expect(handler).toContain("computeSalesPathsBody(");
    expect(handler).not.toContain("computeOfferSalesPathsModel(");
  });

  it("keys the cell on every request input and on the two customer-written inputs (as fingerprint parts)", () => {
    for (const part of ["orgId: identity.orgId", "brandId,", "scope,", "creditUsd: String(creditUsd)", "econ: fingerprint(legEconomics)", "decl: fingerprint(selection)"]) {
      expect(handler).toContain(part);
    }
    expect(handler).toContain('routeResponseShapeFingerprint("/offers/{offerId}/sales-paths")');
  });

  it("an offer the brand does not sell is still a 404 (never a cached body)", () => {
    expect(route).toContain("throw new OfferNotFoundError(");
    expect(handler).toContain('reason: "offer_not_found"');
  });
});
