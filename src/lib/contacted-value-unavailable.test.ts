import { describe, it, expect, vi } from "vitest";

vi.unmock("./contacted-value-unavailable.js");
const { readOrUnavailable, ContactedValueUnavailableError, contactedValueUnavailableBody } = await import("./contacted-value-unavailable.js");

describe("readOrUnavailable: retry once, then loud (never a silent $0)", () => {
  it("answers on the first try", async () => {
    const read = vi.fn(async () => 7);
    expect(await readOrUnavailable("b1", "send_dates_unreadable", "x", read)).toBe(7);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a read failing once then answering is served", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("504")).mockResolvedValueOnce(9);
    expect(await readOrUnavailable("b1", "send_dates_unreadable", "x", read)).toBe(9);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("failing twice throws the named reason, and the route body says it", async () => {
    const read = vi.fn(async () => {
      throw new Error("email-gateway down");
    });
    const err = await readOrUnavailable("b1", "contacted_pricing_unreadable", "x", read).catch((e) => e);
    expect(err).toBeInstanceOf(ContactedValueUnavailableError);
    expect(err.reason).toBe("contacted_pricing_unreadable");
    expect(read).toHaveBeenCalledTimes(2);
    expect(contactedValueUnavailableBody(err)).toMatchObject({
      reason: "contacted_value_unavailable",
      detail: "contacted_pricing_unreadable",
      brandId: "b1",
    });
  });
});
