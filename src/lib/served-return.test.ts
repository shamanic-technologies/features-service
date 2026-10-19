import { describe, it, expect } from "vitest";
import { servedReturnOf } from "./served-return.js";

describe("servedReturnOf — the return a customer is shown (dashboard autoStatBasis + shownReturn)", () => {
  it("mature and at least as high as flash → the mature half", () => {
    expect(servedReturnOf({ flash: { roiMultiple: 1.2 }, mature: { roiMultiple: 2.5 }, isMature: true })).toEqual({ roiMultiple: 2.5, half: "mature", nullReason: null });
    expect(servedReturnOf({ flash: { roiMultiple: 2.5 }, mature: { roiMultiple: 2.5 }, isMature: true }).half).toBe("mature");
  });
  it("flash higher than mature → the flash half (owner 2026-10-08; Doc Dinners 0.74x / 2.21x reads 2.21x)", () => {
    expect(servedReturnOf({ flash: { roiMultiple: 2.21 }, mature: { roiMultiple: 0.74 }, isMature: true })).toEqual({ roiMultiple: 2.21, half: "flash", nullReason: null });
    expect(servedReturnOf({ flash: { roiMultiple: 0.9 }, mature: { roiMultiple: 0.5 }, isMature: true }).roiMultiple).toBe(0.9);
  });
  it("cannot judge (isMature null) → the higher half; no mature figure → flash above 1x, else unavailable", () => {
    expect(servedReturnOf({ flash: { roiMultiple: 2 }, mature: { roiMultiple: 3 }, isMature: null }).roiMultiple).toBe(3);
    expect(servedReturnOf({ flash: { roiMultiple: 9 }, mature: null, isMature: null }).roiMultiple).toBe(9);
    expect(servedReturnOf({ flash: { roiMultiple: 0.8 }, mature: null, isMature: null }).nullReason).toBe("return_unavailable");
  });
  it("not mature → to-date when above 1x, else Learning (a Learning mature half is never compared)", () => {
    expect(servedReturnOf({ flash: { roiMultiple: 4.33 }, mature: { roiMultiple: null }, isMature: false })).toEqual({ roiMultiple: 4.33, half: "flash", nullReason: null });
    expect(servedReturnOf({ flash: { roiMultiple: 0.8 }, mature: { roiMultiple: 0.5 }, isMature: false }).nullReason).toBe("return_learning");
    expect(servedReturnOf({ flash: { roiMultiple: 1 }, mature: null, isMature: false }).nullReason).toBe("return_learning");
    expect(servedReturnOf({ flash: null, mature: null, isMature: false }).nullReason).toBe("return_learning");
  });
  it("no pair → unavailable", () => {
    expect(servedReturnOf(null)).toEqual({ roiMultiple: null, half: null, nullReason: "return_unavailable" });
  });
});
