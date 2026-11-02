import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

/**
 * EXPECTED-ROI-WIDE-EMAIL-1102 (owner 2026-11-02, « ROI: own sales path unpriced -> pourquoi ne pas mettre notre
 * chiffre avec un tag expected? »): a funnel campaign whose own path the offer's sales-path model cannot price (a play
 * `~<strategy>`, a trigger head, a declared leg) reads the CATALOGUE funnel's own expected figure, priced on its offer.
 */
const offerModel = vi.fn();
const catalogueModel = vi.fn();
vi.mock("../routes/offer-sales-paths.js", () => ({ computeOfferSalesPathsModel: (...a: unknown[]) => offerModel(...a) }));
vi.mock("../routes/agent-catalogue.js", () => ({ loadCatalogueModelForOffer: (...a: unknown[]) => catalogueModel(...a) }));

import { buildCatalogueModel, type CatalogueInputs, type PipeMeasurement } from "./agent-catalogue.js";
import { buildChannelCatalogue } from "./channel-catalogue.js";
import { servedLegKeyOf } from "./funnel-legs.js";
import { SEED_FEATURES } from "../seed/features.js";

const er = await vi.importActual<typeof import("./expected-return.js")>("./expected-return.js");

const channels = buildChannelCatalogue(SEED_FEATURES.filter((f) => f.status === "active"));
const mature = (costPerOutcomeUsd: number, conversionRatePct: number): PipeMeasurement => ({ basis: "mature", costPerOutcomeUsd, conversionRatePct, workflowDynastySlug: "w" });
const catalogueInputs = (over: Partial<CatalogueInputs> = {}): CatalogueInputs => ({
  channels,
  publishedPipeIds: new Set(channels.flatMap((c) => c.stepTransitions.map((t) => `${c.slug}|${servedLegKeyOf(c.slug, t.legKey)}`))),
  declaredSteps: [],
  measurements: new Map([["lead-sourcing|start_to_lead_found", mature(0.5, 100)]]),
  // The cold email pipe's "No offer emails" play: no workflow of it measured yet (0 positive replies).
  plays: new Map([
    [
      "lead-sourcing|start_to_lead_found",
      {
        default: null,
        others: [{ strategyId: "valid-catch-all", strategyName: "Valid + Catch-all", strategyDescription: "Confirmed and catch-all addresses.", measurement: mature(0.6, 100), allowedActiveWorkflowCount: 1, allowedActiveDynasties: ["s"], excludedDynasties: [] }],
      },
    ],
    [
      "sales-cold-email-outreach|lead_found_to_conversation",
      {
        default: null,
        others: [{ strategyId: "no-offer-emails", strategyName: "No offer emails", strategyDescription: "Runs every workflow except offer angle ones.", measurement: null, allowedActiveWorkflowCount: 1, allowedActiveDynasties: ["w"], excludedDynasties: [] }],
      },
    ],
  ]),
  lifetimeRevenueUsd: 2000,
  ...over,
});

// The offer's sales-path model: lists only the bare cold email path, so the funnel's own id is not listed.
const sp = {
  body: {
    status: "ok",
    paths: [
      {
        combinationKey: "start_to_conversation@sales-cold-email-outreach+conversation_to_paid_client",
        roi: 3,
        legs: [
          { legKey: "start_to_conversation", toStep: { key: "conversation" }, rateSource: "industry_default", costSource: "default", costPerOutcomeUsd: 50, workedBy: "platform", channel: { slug: "sales-cold-email-outreach" } },
          { legKey: "conversation_to_paid_client", toStep: { key: "paid_client" }, rateSource: "customer_stated", costSource: null, costPerOutcomeUsd: null, workedBy: "human", channel: null },
        ],
      },
    ],
  },
  selectedPaths: { combinationKeys: [] },
  lifetimeRevenue: { usd: 2000, source: "offer_stated" },
  rates: [{ legKey: "conversation_to_paid_client", catalogueFromStep: "conversation", catalogueToStep: "paid_client", effectiveRatePct: 4, source: "manual", measured: { basis: "our_leads" } }],
  prices: new Map(),
  fleetPrices: new Map(),
};

const id = { orgId: "org-1", userId: "u", runId: "r" };

describe("a funnel campaign the offer's model cannot price reads the catalogue funnel's expected figure", () => {
  beforeEach(() => {
    er.__resetExpectedReturnMemo();
    er.__resetCatalogueExpectedMemo();
    offerModel.mockReset().mockResolvedValue(sp);
    catalogueModel.mockReset().mockImplementation(async (offer: { lifetimeRevenueUsd: number; rates: CatalogueInputs["offerRates"] }) =>
      buildCatalogueModel(catalogueInputs({ lifetimeRevenueUsd: offer.lifetimeRevenueUsd, offerRates: offer.rates })),
    );
  });

  // Prod 2026-11-02, Beyond Logic "Wide Email": $160 invested, 0 positive replies, Daily, target Paid client.
  const WIDE = "start_to_lead_found@lead-sourcing~valid-catch-all+lead_found_to_conversation@sales-cold-email-outreach~no-offer-emails+conversation_to_paid_client";

  it("cold email -> positive reply -> the client's team closing -> paid client, 0 outcomes yet: a non-null expected ROI and $ per positive reply", async () => {
    // Its outreach leg runs a PLAY the offer's sales paths never list: priced on the catalogue, on THIS offer's terms.
    const e = await er.expectedReturnForFunnelCampaign(id, "b1", "o1", WIDE, null, 25_000);
    expect(e.unavailableReason).toBeNull();
    expect(e.roiMultiple).not.toBeNull();
    expect(e.roiMultiple!).toBeGreaterThan(0);
    // The $ / Positive reply card: the outreach leg's own expected cost (seeded default: no workflow measured yet).
    expect(e.costPerOutcome).toMatchObject({ stepKey: "conversation", costPerOutcomeUsd: 50, source: "default", basis: "default" });
    expect(e.basis).toBe("default");
    // The offer's own stated LTR and its stated closing rate, never the fleet's.
    expect(catalogueModel).toHaveBeenCalledWith(expect.objectContaining({ lifetimeRevenueUsd: 2000, lifetimeRevenueSource: "offer_stated" }));
    expect(catalogueModel.mock.calls[0][0].rates.get("conversation>paid_client")).toEqual({ ratePct: 4, source: "offer_stated" });
    expect(e.assumptions).toContainEqual({ input: "rate", legKey: expect.stringContaining("conversation_to_paid_client"), basis: "stated", source: "offer_stated" });
  });

  it("a table read never waits: computing first, the figure on the next read", async () => {
    await er.expectedReturnForFunnelCampaign(id, "b1", "o1", WIDE, null, 25_000); // offer model warm
    er.__resetCatalogueExpectedMemo();
    const built = catalogueModel.getMockImplementation()!;
    catalogueModel.mockImplementation(async (o: never) => {
      await new Promise((r) => setTimeout(r, 20));
      return built(o);
    });
    const funnel = WIDE;
    expect((await er.expectedReturnForFunnelCampaign(id, "b1", "o1", funnel, null, 0)).unavailableReason).toBe("expected_model_computing");
    await new Promise((r) => setTimeout(r, 40));
    expect((await er.expectedReturnForFunnelCampaign(id, "b1", "o1", funnel, null, 0)).roiMultiple).not.toBeNull();
  });

  it("still null with a named reason when the catalogue cannot price it either (a step after Paid client has no value)", async () => {
    const e = await er.expectedReturnForFunnelCampaign(id, "b1", "o1", "paid_client_to_client_satisfied@cold-whatsapp-outreach", null, 25_000);
    expect(e).toMatchObject({ roiMultiple: null, unavailableReason: "own_sales_path_unpriced" });
  });

  it("a listed path never asks the catalogue", async () => {
    const e = await er.expectedReturnForFunnelCampaign(id, "b1", "o1", "start_to_conversation@sales-cold-email-outreach+conversation_to_paid_client", null, 25_000);
    expect(e.roiMultiple).toBe(3);
    expect(catalogueModel).not.toHaveBeenCalled();
  });
});
