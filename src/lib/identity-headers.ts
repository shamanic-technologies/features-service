/**
 * THE CALLER'S IDENTITY IS A UUID TRIPLE, OR IT IS NOT AN IDENTITY.
 *
 * `x-org-id`, `x-user-id` and `x-run-id` are forwarded to the siblings (runs-service, lead-service,
 * billing...), which refuse anything but a UUID (runs-service: 400 "x-user-id header must be a valid
 * UUID"). A request carrying a malformed one could never be answered, and worse, it did not stay its own
 * problem: its headers were recorded as a Gold cell's replay template, the view keeper adopted them as
 * its ORG's identity and replayed every precompute of that org under them, so other callers' reads 502'd
 * and the keeper parked their cells for hours (prod 2026-10-09, a probe sending `x-user-id: x`).
 *
 * So the door refuses it (`middleware/auth.ts`, 400 `invalid_identity`) and the keeper never adopts a
 * stored identity that fails this test (`lib/view-keeper.ts`, rows recorded before the door existed).
 * The published contract already declares these headers `format: uuid`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const IDENTITY_HEADERS = ["x-org-id", "x-user-id", "x-run-id"] as const;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** The identity headers present but not a UUID (absent ones are not listed: "missing" is its own answer). */
export function malformedIdentityHeaders(headers: Record<string, unknown>): string[] {
  return IDENTITY_HEADERS.filter((name) => headers[name] !== undefined && headers[name] !== "" && !isUuid(headers[name]));
}

/** The all-zero UUID: well-formed, and nobody's. A probe's placeholder, never a person or a run. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** TRUE ⟺ all three identity headers are present, UUIDs, and not the nil placeholder: a request another
 *  caller may be replayed under (a probe sending the nil UUID once left it on 11 cells of org d4cbcbd5,
 *  2026-10-09). */
export function isReplayableIdentity(headers: Record<string, unknown>): boolean {
  return IDENTITY_HEADERS.every((name) => isUuid(headers[name]) && headers[name] !== NIL_UUID);
}
