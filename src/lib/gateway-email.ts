/**
 * WHICH ADDRESSES email-gateway ACCEPTS in a batch (SFC-MONEY-SLOW-1016 follow-up, prod 2026-10-16).
 *
 * email-gateway validates every item of `POST /orgs/status` with zod's `z.string().email()` and refuses the WHOLE
 * batch on one address it rejects (400 "Invalid email address"). Lead-service legitimately holds such addresses (a
 * customer.io unsubscribe alias `…====@unsubscribe2.customer.io` on brand f4d73dab), so one of them blanked every
 * timestamp and outcome of the brand, and the fleet outcome-prices build that reads them never finished: the
 * expected return was unavailable for every customer.
 *
 * So a batch sends only the addresses the receiver accepts and names the others LOUDLY. Leaving one out invents
 * nothing: email-gateway refuses the same address on a send (`to` carries the same rule), so it has no status to
 * answer for it; the caller reads it exactly as an address the gateway holds nothing for.
 *
 * The pattern is zod's own (`zod/v4/core/regexes.js` `email`, zod 4.4.3, read from the running email-gateway
 * container 2026-10-16), copied byte for byte: this service runs zod 3, and the receiver's rule is the one that
 * counts. Pure (no `@/` imports), so it carries a real unit test (`gateway-email.test.ts`).
 */
export const GATEWAY_EMAIL_PATTERN = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;

/** PURE: the batch split into what email-gateway accepts and what it would refuse (order kept). */
export function partitionGatewayEmails(emails: readonly string[]): { accepted: string[]; refused: string[] } {
  const accepted: string[] = [];
  const refused: string[] = [];
  for (const email of emails) (GATEWAY_EMAIL_PATTERN.test(email) ? accepted : refused).push(email);
  return { accepted, refused };
}

/** The accepted addresses; the refused ones are logged by name with the read they were left out of. */
export function gatewayAcceptedEmails(emails: readonly string[], read: string): string[] {
  const { accepted, refused } = partitionGatewayEmails(emails);
  if (refused.length > 0) {
    console.error(
      `[features-service] ${read}: ${refused.length} address(es) email-gateway refuses left out of the batch (no status read for them): ${refused.slice(0, 10).join(", ")}${refused.length > 10 ? ", …" : ""}`,
    );
  }
  return accepted;
}
