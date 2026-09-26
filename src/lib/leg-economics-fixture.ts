/**
 * TEST SUPPORT — the brand-service `offer-economics` body a set of (pre-C1) declared-funnel fixtures
 * describes, exactly as brand-service's own carry-over did it in prod: every rate a funnel stated lands
 * on the LEG it prices (one rate per leg — the first funnel stating a leg wins), and the offer carries
 * the lifetime revenue its funnels stated. Used only by test suites; nothing in the service imports it.
 */

interface DeclaredFixture {
  funnelKey: string;
  rates?: Record<string, number | null> | null;
  arrows?: Array<{ fromStep: string; toStep: string; ratePct: number | null }>;
  lifetimeRevenueUsd?: number | null;
}

/** brand-service's named per-funnel rate → the leg it states. */
const NAMED_RATE_LEG: Record<string, [string, string]> = {
  replyToMeetingPct: ["Positive reply", "Meeting booked"],
  visitToMeetingPct: ["Website visit", "Meeting booked"],
  meetingBookedToAttendedPct: ["Meeting booked", "Meeting attended"],
  // brand-service's `meetingToClosePct` on a funnel is ATTENDED → paid (see declared-funnels.ts).
  meetingToClosePct: ["Meeting attended", "Paid client"],
  visitToSignupPct: ["Website visit", "Signup"],
  signupToPaidClientPct: ["Signup", "Paid client"],
  visitToFormSubmissionPct: ["Website visit", "Form filled"],
  formSubmissionToPaidClientPct: ["Form filled", "Paid client"],
  replyToPaidClientPct: ["Positive reply", "Paid client"],
  visitToPurchasePct: ["Website visit", "Purchase"],
  purchaseToPaidClientPct: ["Purchase", "Paid client"],
};

const norm = (s: string): string => {
  const flat = s.trim().toLowerCase();
  return flat === "form submitted" || flat === "lead form submitted" ? "form filled" : flat;
};

export function offerEconomicsFromDeclared(
  fixtures: readonly unknown[],
  opts: { offerId?: string; offers?: Array<{ offerId: string; name?: string; lifetimeRevenueUsd: number | null }> } = {},
): {
  legRates: Array<{ fromStep: string; toStep: string; ratePct: number | null; stated: boolean; statedAt: string | null }>;
  offers: Array<{ offerId: string; name: string; lifetimeRevenueUsd: number | null; lifetimeRevenueStatedAt: string | null }>;
} {
  const funnels = fixtures as readonly DeclaredFixture[];
  const legs = new Map<string, { fromStep: string; toStep: string; ratePct: number }>();
  const add = (fromStep: string, toStep: string, ratePct: number | null | undefined) => {
    if (typeof ratePct !== "number" || !Number.isFinite(ratePct)) return;
    const key = `${norm(fromStep)}>${norm(toStep)}`;
    if (!legs.has(key)) legs.set(key, { fromStep, toStep, ratePct });
  };
  for (const f of funnels) {
    for (const a of f.arrows ?? []) add(a.fromStep, a.toStep, a.ratePct);
    for (const [key, value] of Object.entries(f.rates ?? {})) {
      const leg = NAMED_RATE_LEG[key];
      if (leg) add(leg[0], leg[1], value);
    }
  }
  const ltr = funnels.map((f) => f.lifetimeRevenueUsd).find((v) => typeof v === "number") ?? null;
  const offers = opts.offers ?? [{ offerId: opts.offerId ?? "offer-1", name: "Offer", lifetimeRevenueUsd: ltr }];
  return {
    legRates: [...legs.values()].map((l) => ({ ...l, stated: true, statedAt: "2026-09-25T00:00:00.000Z" })),
    offers: offers.map((o) => ({
      offerId: o.offerId,
      name: o.name ?? "Offer",
      lifetimeRevenueUsd: o.lifetimeRevenueUsd,
      lifetimeRevenueStatedAt: o.lifetimeRevenueUsd === null ? null : "2026-09-25T00:00:00.000Z",
    })),
  };
}

/** The entry leg of each funnel fixture — what a campaign selling it performs. */
const ENTRY_LEG: Record<string, string> = {
  sales_meetings_from_conversation: "start_to_conversation",
  sales_from_conversation: "start_to_conversation",
  sales_meetings_from_website: "start_to_website_visit",
  website_purchases: "start_to_website_visit",
  form_magnet: "start_to_website_visit",
  sales_from_website: "start_to_website_visit",
};

/** Campaign rows (campaign-service shape) whose legs are the entry legs of the given funnels. */
export function legCampaignRows(
  fixtures: readonly unknown[],
  opts: { brandId?: string; featureSlug?: string; offerId?: string | null } = {},
): Array<Record<string, unknown>> {
  return (fixtures as readonly DeclaredFixture[]).map((f, i) => ({
    id: `leg-campaign-${i + 1}`,
    orgId: "org-1",
    brandId: opts.brandId ?? "brand-1",
    brandIds: [opts.brandId ?? "brand-1"],
    // A channel of its own by default, so a read scoped to a feature's campaigns (the ROI maturity
    // cohort, the identity families) is not moved by the rows that only say what the brand sells.
    featureSlug: opts.featureSlug ?? "leg-fixture-channel",
    legKey: ENTRY_LEG[f.funnelKey] ?? null,
    offerId: opts.offerId ?? null,
    status: "stopped",
  }));
}
