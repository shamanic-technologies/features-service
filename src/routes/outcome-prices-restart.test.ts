/**
 * LEDGER-LOAD-1107-ROI-BOOT: a fresh process serves the last good outcome-prices build persisted by the previous one,
 * even while its own first build fails (lead-service shedding: 502). Before, the store was memory only and every read
 * waiting on it (the expected return's sales-path model) answered "not computed yet" after a restart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } }, sql: {} }));
const cells = vi.hoisted(() => new Map<string, { text: string; computedAt: number }>());
vi.mock("../lib/fleet-cell-store.js", () => ({
  loadFleetCell: async (key: string) => cells.get(key) ?? null,
  claimFleetCellBuild: async () => true,
  storeFleetCell: async (key: string, text: string, computedAt: number) => void cells.set(key, { text, computedAt }),
}));

import {
  __resetOutcomePrices,
  awaitFleetLegConversionRatesFromOutcomePrices,
  awaitFleetLegCostsFromOutcomePrices,
  fleetLegConversionRatesFromOutcomePrices,
  type OutcomePricesPayload,
} from "./public.js";

const COLD = "sales-cold-email-outreach";
const leg = (legKey: string, featureSlug: string, costPerOutcomeUsd: number) => ({ legKey, featureSlug, costPerOutcomeUsd, conversionRatePct: 1.2 });
const payload = {
  grain: "fleet",
  costBasis: "incurred",
  computedAt: "2026-11-07T17:50:00.000Z",
  outcomes: {
    websiteVisit: { maturity: null, priceUsd: 1.41, unmeasuredReason: null, legs: [leg("start_to_website_visit", COLD, 1.41)] },
    meetingBooked: {
      maturity: null,
      priceUsd: 611.78,
      unmeasuredReason: null,
      arithmetic: null,
      legs: [leg("start_to_conversation", COLD, 141.2), leg("conversation_to_meeting_booked", "ai-meeting-booking", 4.53)],
    },
  },
} as unknown as OutcomePricesPayload;

const realFetch = globalThis.fetch;
beforeEach(() => {
  cells.clear();
  __resetOutcomePrices();
  // Every producer sheds: the new process's own build cannot land.
  globalThis.fetch = vi.fn(async () => new Response('{"error":"lead-service general HTTP thread unavailable"}', { status: 502 })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  __resetOutcomePrices();
});

describe("outcome prices across a restart (LEDGER-LOAD-1107-ROI-BOOT)", () => {
  it("a fresh process serves the persisted build at once while its own build fails", async () => {
    cells.set("outcome-prices-v1", { text: JSON.stringify(payload), computedAt: Date.parse("2026-11-07T17:50:00Z") });
    const t0 = Date.now();
    const costs = await awaitFleetLegCostsFromOutcomePrices(20_000);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(costs.get(`start_to_conversation|${COLD}`)).toBe(141.2);
    expect(costs.get("conversation_to_meeting_booked|ai-meeting-booking")).toBe(4.53);
    expect(costs.get(`start_to_website_visit|${COLD}`)).toBe(1.41);
  });

  it("nothing persisted and the build fails: still a visible 'not computed yet', never a guessed price", async () => {
    await expect(awaitFleetLegCostsFromOutcomePrices(50)).rejects.toThrow(/not computed yet/);
  });
});

describe("the fleet's measured conversion across a restart (FLEET-CONVERSION-BOOT-1116)", () => {
  // Prod 2026-11-16: a spend-charts read 90 s after a restart read the store before the persisted build was restored, so
  // the Wide Email cold email part served the 1 % seeded default beside the fleet's measured rate, frozen in its cell.
  it("the boot-window read restores the persisted build first: the measured rate, never an empty map", async () => {
    cells.set("outcome-prices-v1", { text: JSON.stringify(payload), computedAt: Date.parse("2026-11-07T17:50:00Z") });
    expect(fleetLegConversionRatesFromOutcomePrices().size).toBe(0); // the synchronous read: what the charts used to get
    __resetOutcomePrices();
    const rates = await awaitFleetLegConversionRatesFromOutcomePrices(20_000);
    expect(rates.get(`start_to_conversation|${COLD}`)).toBe(1.2);
  });

  it("nothing persisted and the build fails: a visible 'not computed yet', never the default", async () => {
    await expect(awaitFleetLegConversionRatesFromOutcomePrices(50)).rejects.toThrow(/not computed yet/);
  });
});
