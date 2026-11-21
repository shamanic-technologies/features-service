/**
 * DISTRY-CALL-IS-CAMPAIGN-1121: a sales funnel campaign may name NO offer (a campaign = Target + start + budget + brief).
 * Every reader states it, never asks billing at `/offers/null/...`, never invents an offer.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { capacityUnavailableReason } from "./spend-capacity.js";
import { readCampaignCapChanges, CAP_CHANGES_NO_OFFER_REASON } from "./campaign-change-log-io.js";
import type { SalesFunnelCampaignRow } from "./sales-funnel-campaigns-client.js";

const row = (offerId: string | null): SalesFunnelCampaignRow =>
  ({ id: "c1", brandId: "b1", offerId, salesFunnelId: "f1", salesFunnelName: "Backlink earned", status: "ongoing", createdAt: "2026-11-21T00:00:00.000Z", units: [] }) as unknown as SalesFunnelCampaignRow;

afterEach(() => vi.unstubAllGlobals());

describe("a campaign naming no offer", () => {
  it("its projection says the caps are not served yet (never `spend_capacity_unreadable`, never a guess)", () => {
    expect(capacityUnavailableReason({ campaignStatus: "ongoing", budget: null, volumeReached: null, unreadableReason: "campaign_names_no_offer_caps_not_served_yet" })).toBe(
      "campaign_names_no_offer_caps_not_served_yet",
    );
    expect(capacityUnavailableReason({ campaignStatus: "ongoing", budget: null, volumeReached: null, unreadableReason: "billing_caps_unreadable" })).toBe("spend_capacity_unreadable");
  });

  it("its cap changes are not asked of billing (no `/offers/null`): none listed, the reason stated; a campaign naming an offer keeps its read", async () => {
    process.env.BILLING_SERVICE_URL = "http://billing";
    process.env.BILLING_SERVICE_API_KEY = "k";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ changes: [{ at: "2026-11-20T00:00:00.000Z" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const h = { orgId: "org-1", userId: "u", runId: "r" };
    expect(await readCampaignCapChanges(row(null), h)).toEqual({ changes: [], unavailableReason: CAP_CHANGES_NO_OFFER_REASON });
    expect(fetchMock).not.toHaveBeenCalled();
    const withOffer = await readCampaignCapChanges(row("o1"), h);
    expect(withOffer.unavailableReason).toBeNull();
    expect(withOffer.changes).toHaveLength(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("/offers/o1/sales-funnels/f1/campaigns/c1/cap-changes");
  });

  it("its expected return is stated `campaign_names_no_offer`, the measured half kept", async () => {
    // The suite mocks expected-return (vitest.setup): read the real one.
    const { expectedReturnForFunnelCampaign } = await vi.importActual<typeof import("./expected-return.js")>("./expected-return.js");
    const e = await expectedReturnForFunnelCampaign({ orgId: "org-1", userId: "u", runId: "r" } as never, "b1", null, "f1", null);
    expect(e).toMatchObject({ roiMultiple: null, unavailableReason: "campaign_names_no_offer" });
  }, 60_000);
});
