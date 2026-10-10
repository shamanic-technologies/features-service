import { describe, expect, it } from "vitest";
import { offerFunnelSelection, salesFunnelLegKeys } from "./offer-funnel-campaigns.js";

const EPIPHANY = "lead_found_to_website_visit@sales-cold-email-outreach+website_visit_to_purchase+purchase_to_paid_client";
const MOTIVATE = "conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";

describe("an offer's sales path is read off its sales funnel campaigns (owner 2026-10-10)", () => {
  it("reads a funnel id's legs, in order, channels dropped", () => {
    expect(salesFunnelLegKeys(EPIPHANY)).toEqual(["lead_found_to_website_visit", "website_visit_to_purchase", "purchase_to_paid_client"]);
  });

  it("states every leg of every funnel the offer runs, and selects the ones on", () => {
    const rows = [
      { id: "u1", offerId: "o1", salesFunnelId: EPIPHANY, status: "ongoing" },
      { id: "u2", offerId: "o1", salesFunnelId: EPIPHANY, status: "ongoing" },
      { id: "u3", offerId: "o1", salesFunnelId: MOTIVATE, status: "stopped" },
      { id: "u4", offerId: "o2", salesFunnelId: "x_to_paid_client", status: "ongoing" },
      { id: "u5", offerId: "o1", salesFunnelId: null, legKey: "start_to_conversation", status: "ongoing" },
    ];
    const s = offerFunnelSelection(rows, "o1");
    expect(s.salesPath).toEqual({ stated: true, statedAt: null, legKeys: [...salesFunnelLegKeys(EPIPHANY), ...salesFunnelLegKeys(MOTIVATE)].sort() });
    expect(s.selected).toEqual({ stated: true, statedAt: null, combinationKeys: [EPIPHANY] });
  });

  it("states nothing for an offer with no funnel campaign; a sole offer owns rows naming none", () => {
    expect(offerFunnelSelection([{ id: "u", offerId: "o1", status: "ongoing" }], "o1")).toEqual({
      salesPath: { stated: false, legKeys: null, statedAt: null },
      selected: { stated: false, combinationKeys: null, statedAt: null },
    });
    const orphan = [{ id: "u", offerId: null, salesFunnelId: EPIPHANY, status: "stopped" }];
    expect(offerFunnelSelection(orphan, "o1").salesPath.stated).toBe(false);
    expect(offerFunnelSelection(orphan, "o1", true)).toMatchObject({ salesPath: { stated: true }, selected: { stated: false } });
  });
});
