import { describe, expect, it } from "vitest";
import { fleetEmailDeliveryOf } from "./fleet-email-delivery.js";

describe("fleet email delivery (owner 2026-10-13): share of our sent emails the recipient server accepted", () => {
  it("reads email-gateway's broadcast email counters, never the transactional ones", () => {
    const body = {
      transactional: { emailStats: { sent: 42, delivered: 13, bounced: 0 } },
      broadcast: { emailStats: { sent: 161277, delivered: 157853, bounced: 3501 } },
    };
    expect(fleetEmailDeliveryOf(body)).toEqual({
      sentEmails: 161277,
      deliveredEmails: 157853,
      bouncedEmails: 3501,
      deliveryRatePct: 97.88,
      basis: "every_email_our_sending_inboxes_sent",
      unavailableReason: null,
    });
  });

  it("nothing sent is a named null, never 0% or 100%", () => {
    expect(fleetEmailDeliveryOf({ broadcast: { emailStats: { sent: 0, delivered: 0, bounced: 0 } } })).toMatchObject({ deliveryRatePct: null, unavailableReason: "no_email_sent" });
  });

  it("a body without the counters is an error (the caller serves null + email_gateway_unavailable)", () => {
    expect(() => fleetEmailDeliveryOf({ broadcast: {} })).toThrow(/broadcast.emailStats/);
  });
});
