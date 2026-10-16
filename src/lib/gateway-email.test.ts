import { describe, expect, it, vi } from "vitest";
import { gatewayAcceptedEmails, partitionGatewayEmails } from "./gateway-email.js";

describe("partitionGatewayEmails (email-gateway's zod email rule)", () => {
  it("leaves out exactly what email-gateway refuses, keeps the rest in order", () => {
    const unsub = "4d0QB5BUAQgGEJu9N-mAaZ-XzG4ZM2kvRA====@unsubscribe2.customer.io";
    expect(partitionGatewayEmails(["a@b.co", unsub, "first.last+tag@sub.example.com", "o'neil@x.io", "bad@", ".dot@x.io", "a..b@x.io"])).toEqual({
      accepted: ["a@b.co", "first.last+tag@sub.example.com", "o'neil@x.io"],
      refused: [unsub, "bad@", ".dot@x.io", "a..b@x.io"],
    });
  });

  it("logs every refused address by name, and nothing when all are accepted", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(gatewayAcceptedEmails(["a@b.co"], "outcomes")).toEqual(["a@b.co"]);
    expect(err).not.toHaveBeenCalled();
    expect(gatewayAcceptedEmails(["a@b.co", "x====@unsubscribe2.customer.io"], "outcomes")).toEqual(["a@b.co"]);
    expect(err.mock.calls[0][0]).toContain("x====@unsubscribe2.customer.io");
    err.mockRestore();
  });
});
