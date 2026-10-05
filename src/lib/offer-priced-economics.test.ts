import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// reading-funnels reaches the db module transitively; this suite is pure.
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const { buildPricingFunnels } = await import("./reading-funnels.js");
import { economicsFingerprint, economicsFromTerms, offerTermsEconomics } from "./offer-priced-economics.js";
import type { SalesFunnelKey } from "./sales-funnels.js";

/**
 * Owner 2026-10-05 (LOCKED): every figure is priced on the OFFER's terms — its stated lifetime revenue
 * and the priced funnels' effective leg rates — and on nothing else. brand-service's brand-level sales
 * economics (and its cross-brand average) had no writer since 2026-08-03 and are no input any more.
 */

const rated = (funnelKeys: SalesFunnelKey[], lifetimeRevenueUsd: number | null, rates: Record<string, number>) =>
  buildPricingFunnels({
    funnelKeys,
    lifetimeRevenueUsd,
    rateOf: (fromStep, toStep) => {
      const ratePct = rates[`${fromStep}>${toStep}`];
      return ratePct === undefined ? { ratePct: null, provenance: "unstated" } : { ratePct, provenance: "stated_manual" };
    },
  });

const CONVERSATION_RATES = {
  "Positive reply>Meeting booked": 40,
  "Meeting booked>Meeting attended": 100,
  "Meeting attended>Paid client": 30,
};

describe("offerTermsEconomics — the offer's terms are the ONLY pricing input", () => {
  it("prices on the offer's stated lifetime revenue and the funnel's own leg rates", () => {
    const funnels = rated(["sales_meetings_from_conversation"], 1000, CONVERSATION_RATES);
    const priced = offerTermsEconomics(funnels, ["sales_meetings_from_conversation"]);
    expect(priced.unpricedReason).toBeNull();
    expect(priced.economics?.lifetimeRevenueUsd).toBe(1000);
    expect(priced.economics?.replyToMeetingPct).toBe(40);
  });

  it("an offer stating NO lifetime revenue is NULL with its reason — never an average, never a default", () => {
    const funnels = rated(["sales_meetings_from_conversation"], null, CONVERSATION_RATES);
    expect(offerTermsEconomics(funnels, ["sales_meetings_from_conversation"])).toEqual({
      economics: null,
      unpricedReason: "lifetime_revenue_not_stated",
    });
  });

  it("a read walking NO priced funnel is NULL with its reason", () => {
    expect(offerTermsEconomics([], [])).toEqual({ economics: null, unpricedReason: "no_priced_funnel" });
    expect(economicsFromTerms({ lifetimeRevenueUsd: 1000, replyToMeetingPct: 40 }, [])).toEqual({
      economics: null,
      unpricedReason: "no_priced_funnel",
    });
  });

  it("a rate no priced funnel states is 0 — no brand-wide value stands in", () => {
    const funnels = rated(["sales_meetings_from_conversation"], 1000, { "Positive reply>Meeting booked": 40 });
    const economics = offerTermsEconomics(funnels, ["sales_meetings_from_conversation"]).economics!;
    expect(economics.meetingToClosePct).toBe(0);
    expect(economics.visitToSignupPct).toBe(0);
    expect(economics.visitToClosePct).toBe(0);
    expect(economics.visitToMeetingPct).toBe(0);
    expect(economics.visitToPaidClientPct).toBe(0);
    expect(economics.replyToPaidClientPct).toBe(0);
    // The form-magnet rates stay absent: their readers take absent as "no form route walked".
    expect(economics.visitToFormSubmissionPct).toBeUndefined();
  });

  it("a click route the priced paths do not walk is 0, even when another funnel's terms state it", () => {
    const terms = { lifetimeRevenueUsd: 1000, visitToClosePct: 2, visitToMeetingPct: 5 };
    const economics = economicsFromTerms(terms, ["sales_meetings_from_conversation"]).economics!;
    expect(economics.visitToClosePct).toBe(0);
    expect(economics.visitToMeetingPct).toBe(0);
  });

  it("the cache fingerprint moves with the offer's terms and with the priced paths", () => {
    const funnels = rated(["sales_meetings_from_conversation"], 1000, CONVERSATION_RATES);
    const base = economicsFingerprint({ ...offerTermsEconomics(funnels, ["sales_meetings_from_conversation"]), pricedFunnelKeys: ["sales_meetings_from_conversation"] });
    const otherLtr = economicsFingerprint({
      ...offerTermsEconomics(rated(["sales_meetings_from_conversation"], 2500, CONVERSATION_RATES), ["sales_meetings_from_conversation"]),
      pricedFunnelKeys: ["sales_meetings_from_conversation"],
    });
    const unpriced = economicsFingerprint({ economics: null, unpricedReason: "lifetime_revenue_not_stated", pricedFunnelKeys: ["sales_meetings_from_conversation"] });
    expect(new Set([base, otherLtr, unpriced]).size).toBe(3);
    // Deterministic: the same terms land on the same cell.
    expect(economicsFingerprint({ ...offerTermsEconomics(funnels, ["sales_meetings_from_conversation"]), pricedFunnelKeys: ["sales_meetings_from_conversation"] })).toBe(base);
  });
});

describe("no module prices on brand-service's retired brand sales economics", () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
    });

  it("no source file names a brand sales-economics endpoint or its deleted client", () => {
    // `/sales-economics-effective` (brand + cross-brand average), `/sales-economics` (saved set, org and
    // internal), and the client module that read them. A test may still name them; a source may not.
    const banned = /\/sales-economics|sales-economics-client/;
    const offenders = sources(srcRoot)
      .filter((path) => banned.test(readFileSync(path, "utf8")))
      .map((path) => relative(srcRoot, path));
    expect(offenders).toEqual([]);
  });

  it("the guard fails on a file that does name one (checked both ways)", () => {
    const banned = /\/sales-economics|sales-economics-client/;
    expect(banned.test("fetchWithRetry(`${url}/orgs/brands/${brandId}/sales-economics-effective`)")).toBe(true);
    expect(banned.test('import { x } from "./sales-economics-client.js";')).toBe(true);
    expect(banned.test("fetchWithRetry(`${url}/internal/brands/${brandId}/offer-economics`)")).toBe(false);
  });
});
