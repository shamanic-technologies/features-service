/**
 * ONE rule for every served ROI multiple (ROI-ROUNDING-1116): value ÷ cost to 6 SIGNIFICANT digits, never to a fixed
 * number of decimals. A fixed 2-decimal round served a true 0.004x as 0 (funnel campaign "Mixed Email Replies", a $10
 * client value, after EXPECTED-FLEET-RATE-1116): a ROI is never blank and never a false figure, and a positive one never
 * reads 0. Significant digits keep a tiny ROI exact enough to display ("<0.01x") and trim only float noise
 * (0.30000000000000004). The dashboard formats a ROI for display itself, so this service never rounds one for show.
 * PURE, alias-free.
 */
export const ROI_SIGNIFICANT_DIGITS = 6;

/** A served ROI multiple: `valueUsd / costUsd`, to `ROI_SIGNIFICANT_DIGITS` significant digits. */
export function roiMultipleOf(valueUsd: number, costUsd: number): number {
  return servedRoiMultiple(valueUsd / costUsd);
}

/** An already-divided ROI multiple, to the same precision. */
export function servedRoiMultiple(roi: number): number {
  return Number.isFinite(roi) ? Number(roi.toPrecision(ROI_SIGNIFICANT_DIGITS)) : roi;
}
