import { describe, it, expect } from "vitest";
import { parseCrmFunnelReach } from "./crm-funnel-reach-client.js";

describe("parseCrmFunnelReach — conforms to crm-service's deployed GhlFunnelReachResponse", () => {
  it("an available answer keeps the per-step counts and the coverage", () => {
    const parsed = parseCrmFunnelReach({
      brandId: "b",
      available: true,
      steps: [
        { step: "meeting_booked", contacts: 249, contactsAtOrBeyond: 251, bySource: { appointment: 248 } },
        { step: "a_step_added_later", contacts: 1, contactsAtOrBeyond: 1, bySource: {} },
      ],
      coverage: { connectionStatus: "active", lastSyncedAt: "2026-09-26T09:45:51.909Z", totalContacts: 2696 },
    });
    expect(parsed).toEqual({
      available: true,
      steps: [{ step: "meeting_booked", contacts: 249, contactsAtOrBeyond: 251 }],
      totalContacts: 2696,
      lastSyncedAt: "2026-09-26T09:45:51.909Z",
    });
  });
  it("each unavailable reason is its own answer, never zeros", () => {
    for (const reason of ["no_connection", "not_synced", "stage_meanings_pending"]) {
      expect(parseCrmFunnelReach({ brandId: "b", available: false, reason, coverage: null })).toEqual({ available: false, reason });
    }
  });
  it("a body the contract does not describe fails loud", () => {
    expect(() => parseCrmFunnelReach({ brandId: "b" })).toThrow();
    expect(() => parseCrmFunnelReach({ available: false, reason: "mystery" })).toThrow();
    expect(() => parseCrmFunnelReach({ available: true, steps: [{ step: "sale", contacts: "x", contactsAtOrBeyond: 1 }] })).toThrow();
  });
});
