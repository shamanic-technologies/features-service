import { describe, it, expect } from "vitest";
import { servedReturnOf } from "./served-return.js";

describe("servedReturnOf — the return a customer is shown (dashboard shownReturn, mature basis)", () => {
  it("mature → the mature half", () => {
    expect(servedReturnOf({ flash: { roiMultiple: 9 }, mature: { roiMultiple: 2.5 }, isMature: true })).toEqual({ roiMultiple: 2.5, half: "mature", nullReason: null });
  });
  it("cannot judge (isMature null) → the mature half if any, else unavailable", () => {
    expect(servedReturnOf({ flash: { roiMultiple: 9 }, mature: { roiMultiple: 3 }, isMature: null }).roiMultiple).toBe(3);
    expect(servedReturnOf({ flash: { roiMultiple: 9 }, mature: null, isMature: null }).nullReason).toBe("return_unavailable");
  });
  it("not mature → to-date when above 1x, else Learning", () => {
    expect(servedReturnOf({ flash: { roiMultiple: 4.33 }, mature: { roiMultiple: null }, isMature: false })).toEqual({ roiMultiple: 4.33, half: "flash", nullReason: null });
    expect(servedReturnOf({ flash: { roiMultiple: 1 }, mature: null, isMature: false }).nullReason).toBe("return_learning");
    expect(servedReturnOf({ flash: null, mature: null, isMature: false }).nullReason).toBe("return_learning");
  });
  it("no pair → unavailable", () => {
    expect(servedReturnOf(null)).toEqual({ roiMultiple: null, half: null, nullReason: "return_unavailable" });
  });
});
