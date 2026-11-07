/**
 * LEDGER-LOAD-1107-ROI-BOOT: a features-service restart never blanks the expected return. The last good per-offer model
 * is persisted; a fresh process (empty memo) whose own computation fails (lead-service shedding: 502) or never lands
 * serves the persisted build, byte for byte the figure served before the restart. A mature scope keeps its measured
 * return even when there is no model at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const cells = new Map<string, { text: string; computedAt: number }>();
vi.mock("./fleet-cell-store.js", () => ({
  loadFleetCell: vi.fn(async (key: string) => cells.get(key) ?? null),
  claimFleetCellBuild: vi.fn(async () => true),
  storeFleetCell: vi.fn(async (key: string, text: string, computedAt: number) => {
    cells.set(key, { text, computedAt });
  }),
}));

const computeOfferSalesPathsModel = vi.fn();
vi.mock("../routes/offer-sales-paths.js", () => ({ computeOfferSalesPathsModel: (...a: unknown[]) => computeOfferSalesPathsModel(...a) }));

vi.mock("./brand-leg-economics-client.js", () => ({
  fetchBrandLegEconomics: vi.fn(async () => ({ offers: [{ offerId: "o1" }] })),
}));

// The suite-wide setup mocks the IO entry points; this file tests the real ones.
const actual = await vi.importActual<typeof import("./expected-return.js")>("./expected-return.js");
const {
  expectedReturnForOffer,
  expectedReturnForBrand,
  __resetExpectedReturnMemo,
  serializeOfferExpectedModel,
  parseStoredOfferExpectedModel,
} = actual;
import { storeFleetCell } from "./fleet-cell-store.js";
import type { OfferSalesPathsBody, SalesPath } from "./offer-sales-paths.js";

const COLD = "sales-cold-email-outreach";
const reply = {
  rank: 1,
  combinationKey: `start_to_conversation@${COLD}+conversation_to_paid_client`,
  roi: 0.4058,
  roiUnavailableReason: null,
  legs: [
    { legKey: "start_to_conversation", reactive: false, toStep: { key: "conversation" }, rateSource: "measured_on_our_leads", costSource: "workflow", costPerOutcomeUsd: 175.96, workedBy: "platform", channel: { slug: COLD } },
    { legKey: "conversation_to_paid_client", reactive: false, toStep: { key: "paid_client" }, rateSource: "customer_stated", costSource: null, costPerOutcomeUsd: null, workedBy: "human", channel: null },
  ],
} as unknown as SalesPath;

const built = {
  body: { status: "ok", paths: [reply] } as unknown as OfferSalesPathsBody,
  selectedPaths: { combinationKeys: [reply.combinationKey] },
  published: [],
  lifetimeRevenue: { usd: 3750, source: "offer_stated" },
  rates: [],
  prices: new Map([[`start_to_conversation|${COLD}`, { costPerOutcomeUsd: 175.96, workflowDynastySlug: "keel", grain: "brand", unpricedReason: null }]]),
  fleetPrices: new Map([[`start_to_conversation|${COLD}`, 41.2]]),
};

const identity = { orgId: "f0420eb5-8f72-4f0a-a150-f473746df1e6", userId: "u", runId: "r" };
const BRAND = "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb";

/** A process restart: the in-memory memo is gone, the persisted cells stay. */
const restart = () => __resetExpectedReturnMemo();

beforeEach(() => {
  cells.clear();
  restart();
  computeOfferSalesPathsModel.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("expected return across a restart (LEDGER-LOAD-1107-ROI-BOOT)", () => {
  it("a restart whose own model build fails (lead-service 502) serves the last good expected return, same figures", async () => {
    computeOfferSalesPathsModel.mockResolvedValue(built);
    const before = await expectedReturnForOffer(identity, BRAND, "o1", null);
    expect(before.roiMultiple).toBe(0.4058);
    expect(before.unavailableReason).toBeNull();
    // Let the background store land.
    await vi.waitFor(() => expect(storeFleetCell).toHaveBeenCalled());

    restart();
    computeOfferSalesPathsModel.mockRejectedValue(new Error('lead-service /orgs/leads failed (502): {"error":"lead-service general HTTP thread unavailable"}'));
    const after = await expectedReturnForOffer(identity, BRAND, "o1", null);
    expect(after).toEqual(before);
    // And a later read after the failed rebuild still serves it (a failure never replaces the last good build).
    await new Promise((r) => setTimeout(r, 0));
    expect(await expectedReturnForOffer(identity, BRAND, "o1", null)).toEqual(before);
  });

  it("a restart whose model build never lands serves the persisted build at once (no cold wait, no expected_model_computing)", async () => {
    computeOfferSalesPathsModel.mockResolvedValue(built);
    const before = await expectedReturnForBrand(identity, BRAND, null);
    await vi.waitFor(() => expect(storeFleetCell).toHaveBeenCalled());

    restart();
    computeOfferSalesPathsModel.mockReturnValue(new Promise(() => {}));
    const t0 = Date.now();
    const after = await expectedReturnForBrand(identity, BRAND, null);
    expect(after).toEqual(before);
    expect(after.unavailableReason).not.toBe("expected_model_computing");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("a persisted build older than the 30-min stale window is still served on boot (rebuilt behind it)", async () => {
    const old = Date.now() - 3 * 60 * 60_000;
    cells.set(`expected-model-v1:${identity.orgId}|${BRAND}|o1`, {
      text: serializeOfferExpectedModel({ offerId: "o1", body: built.body, selected: [reply.combinationKey], lifetimeRevenueSource: "offer_stated", notRunning: false }),
      computedAt: old,
    });
    computeOfferSalesPathsModel.mockReturnValue(new Promise(() => {}));
    const e = await expectedReturnForOffer(identity, BRAND, "o1", null);
    expect(e.roiMultiple).toBe(0.4058);
    await vi.waitFor(() => expect(computeOfferSalesPathsModel).toHaveBeenCalledTimes(1));
  });

  it("no persisted build and no model yet: a MATURE scope keeps its measured return (never blank)", async () => {
    computeOfferSalesPathsModel.mockRejectedValue(new Error("fleet leg costs (outcome prices) not computed yet"));
    const e = await expectedReturnForOffer(identity, BRAND, "o1", { isMature: true, mature: { roiMultiple: 0.41 } });
    expect(e).toMatchObject({ roiMultiple: 0.41, basis: "measured", unavailableReason: null });
  });

  it("the stored text round-trips the model's Maps (a jsonb Map would read back as {})", () => {
    const m = { offerId: "o1", body: built.body, selected: ["k"], lifetimeRevenueSource: "offer_stated" as const, notRunning: false, inputs: { lifetimeRevenueUsd: 3750, rates: [], prices: built.prices, fleetPrices: built.fleetPrices } };
    const back = parseStoredOfferExpectedModel(serializeOfferExpectedModel(m));
    expect(back).toEqual(m);
    expect(back.inputs!.prices.get(`start_to_conversation|${COLD}`)!.costPerOutcomeUsd).toBe(175.96);
    expect(() => parseStoredOfferExpectedModel('{"x":1}')).toThrow();
  });
});
