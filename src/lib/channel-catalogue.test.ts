/**
 * THE PUBLIC CATALOGUE IS A PRICE LIST, so a row it cannot read is an ERROR, never a row it half-reads.
 * A malformed blob that silently degraded would publish terms nobody set, which is worse than a failure.
 */
import { describe, it, expect } from "vitest";

import {
  buildChannelCatalogue,
  parseAcquisitionChannel,
  channelStepCatalogue,
  MalformedAcquisitionChannelError,
  type CatalogueFeatureRow,
} from "./channel-catalogue.js";
import { CHANNEL_STEP_KEYS } from "./acquisition-channels.js";

const CHANNEL = {
  family: "outbound_one_to_one",
  operatedBy: "platform",
  stepTransitions: [
    { from: null, to: "conversation" },
    { from: null, to: "website_visit" },
  ],
  terms: { dailyOperatingCostCents: 800, minimumCommitmentDays: 30, maxDaysToFirstProduction: 14 },
};

/** A channel that performs an INTERNAL leg: it moves a lead that is already on the funnel. */
const CLOSER = {
  family: "conversion",
  operatedBy: "customer",
  stepTransitions: [{ from: "meeting_attended", to: "paid_client" }],
  terms: { dailyOperatingCostCents: 0, minimumCommitmentDays: 30, maxDaysToFirstProduction: 1 },
};

const row = (over: Partial<CatalogueFeatureRow> = {}): CatalogueFeatureRow => ({
  slug: "cold-email",
  name: "Cold Email",
  description: "Reach buyers by email.",
  icon: "envelope",
  displayOrder: 1,
  acquisitionChannel: CHANNEL,
  ...over,
});

describe("reading a stored channel", () => {
  it("reads a well-formed one", () => {
    const parsed = parseAcquisitionChannel("cold-email", CHANNEL);
    expect(parsed).toEqual(CHANNEL);
  });

  it("null is a STATEMENT — this feature is not an acquisition channel, not a parse failure", () => {
    expect(parseAcquisitionChannel("hiring", null)).toBeNull();
    expect(parseAcquisitionChannel("hiring", undefined)).toBeNull();
  });

  it("FAILS LOUD on anything it cannot read, naming the row and the defect", () => {
    const cases: Array<[string, unknown]> = [
      ["not an object", "outbound"],
      ["unknown family", { ...CHANNEL, family: "telepathy" }],
      ["unknown operator", { ...CHANNEL, operatedBy: "the-weather" }],
      ["operator missing", { family: CHANNEL.family, stepTransitions: CHANNEL.stepTransitions, terms: CHANNEL.terms }],
      ["unknown step", { ...CHANNEL, stepTransitions: [{ from: null, to: "smoke_signal" }] }],
      ["unknown from-step", { ...CHANNEL, stepTransitions: [{ from: "smoke_signal", to: "paid_client" }] }],
      ["performs nothing", { ...CHANNEL, stepTransitions: [] }],
      // `from: null` is a WRITTEN statement. Reading an ABSENT key as "from nothing" would publish a
      // channel as an entry channel because somebody forgot a field.
      ["from unstated", { ...CHANNEL, stepTransitions: [{ to: "conversation" }] }],
      ["a leg to itself", { ...CHANNEL, stepTransitions: [{ from: "signup", to: "signup" }] }],
      ["terms missing", { family: CHANNEL.family, operatedBy: "platform", stepTransitions: CHANNEL.stepTransitions }],
      ["fractional cents", { ...CHANNEL, terms: { ...CHANNEL.terms, dailyOperatingCostCents: 12.5 } }],
      ["negative cost", { ...CHANNEL, terms: { ...CHANNEL.terms, dailyOperatingCostCents: -1 } }],
      ["zero-day commitment", { ...CHANNEL, terms: { ...CHANNEL.terms, minimumCommitmentDays: 0 } }],
      ["fractional days", { ...CHANNEL, terms: { ...CHANNEL.terms, maxDaysToFirstProduction: 1.5 } }],
      // We do not charge for a day of work we do not do.
      ["customer-operated with a daily cost", { ...CLOSER, terms: { ...CLOSER.terms, dailyOperatingCostCents: 100 } }],
    ];
    for (const [label, blob] of cases) {
      expect(() => parseAcquisitionChannel("cold-email", blob), label).toThrow(MalformedAcquisitionChannelError);
      expect(() => parseAcquisitionChannel("cold-email", blob), label).toThrow(/cold-email/);
    }
  });

  it("tolerates separator and case variance in a stored step, as every other mirror here does", () => {
    const parsed = parseAcquisitionChannel("x", {
      ...CHANNEL,
      stepTransitions: [{ from: "Meeting Attended", to: "Paid Client" }],
    });
    expect(parsed!.stepTransitions).toEqual([{ from: "meeting_attended", to: "paid_client" }]);
  });
});

describe("building the public catalogue", () => {
  it("keeps only the channels, and orders them the way the catalogue orders features", () => {
    const catalogue = buildChannelCatalogue([
      row({ slug: "b-channel", name: "B", displayOrder: 5 }),
      row({ slug: "not-a-channel", name: "N", displayOrder: 2, acquisitionChannel: null }),
      row({ slug: "a-channel", name: "A", displayOrder: 3 }),
    ]);
    expect(catalogue.map((c) => c.slug)).toEqual(["a-channel", "b-channel"]);
  });

  it("publishes the terms verbatim and the funnels DERIVED from the legs the channel performs", () => {
    const [channel] = buildChannelCatalogue([row()]);
    expect(channel.terms).toEqual(CHANNEL.terms);
    expect(channel.operatedBy).toBe("platform");
    expect(channel.stepTransitions.map((t) => [t.from?.key ?? null, t.to.key])).toEqual([
      [null, "conversation"],
      [null, "website_visit"],
    ]);
    expect(channel.producibleSteps.map((s) => s.key)).toEqual(["conversation", "website_visit"]);
    // Each step arrives with the wording a buyer reads, so the site never invents a label.
    for (const step of channel.producibleSteps) expect(step.label.length).toBeGreaterThan(0);
    expect(channel.salesFunnels.map((f) => f.key)).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
      "website_purchases",
      "form_magnet",
    ]);
    // A funnel arrives with its funnel, so a row renders without the consumer knowing the catalogue.
    expect(channel.salesFunnels[0].steps).toEqual([
      "Positive reply",
      "Meeting booked",
      "Meeting attended",
      "Paid client",
    ]);
  });

  it("a channel producing only an on-platform step publishes an EMPTY funnel list, and still publishes", () => {
    // No deployed funnel starts from a platform form yet. The channel is still bookable and still
    // listed with its terms; what it cannot do today is be PAIRED, and it says that as an empty list.
    const [channel] = buildChannelCatalogue([
      row({ acquisitionChannel: { ...CHANNEL, stepTransitions: [{ from: null, to: "in_ad_form_submission" }] } }),
    ]);
    expect(channel.salesFunnels).toEqual([]);
    expect(channel.terms).toEqual(CHANNEL.terms);
  });

  it("a malformed row fails the whole read rather than quietly vanishing from the price list", () => {
    expect(() =>
      buildChannelCatalogue([row(), row({ slug: "broken", acquisitionChannel: { family: "telepathy" } })]),
    ).toThrow(MalformedAcquisitionChannelError);
  });

  it("a RETIRED slug is not published — the offering is listed once, under the spelling that is current", () => {
    const catalogue = buildChannelCatalogue([
      row({ slug: "expert-quote-outreach", name: "Current", displayOrder: 1 }),
      // Same offering, same terms, older spelling. Publishing it would render a second identical page
      // and let a stranger book a slug we no longer sell.
      row({
        slug: "expert-quote-opportunities",
        name: "Retired",
        displayOrder: 2,
        supersededBySlug: "expert-quote-outreach",
      }),
    ]);
    expect(catalogue.map((c) => c.slug)).toEqual(["expert-quote-outreach"]);
  });

  it("retirement is read off the MARKER, not off any particular slug — the next one needs no code here", () => {
    const catalogue = buildChannelCatalogue([
      row({ slug: "some-other-channel", supersededBySlug: "its-successor" }),
      row({ slug: "still-current", name: "Still", supersededBySlug: null }),
    ]);
    expect(catalogue.map((c) => c.slug)).toEqual(["still-current"]);
  });

  it("publishes the step vocabulary itself, so a consumer never hardcodes it", () => {
    expect(channelStepCatalogue().map((s) => s.key)).toEqual([...CHANNEL_STEP_KEYS]);
  });

  it("a channel performing an INTERNAL leg publishes it, produces nothing, and still sells its funnels", () => {
    // This is the shape the catalogue could not express before: it starts somewhere that is not the
    // beginning of a funnel, so it produces no entry step at all — and it is still sellable, through
    // every funnel that contains its leg.
    const [channel] = buildChannelCatalogue([row({ slug: "closing", acquisitionChannel: CLOSER })]);
    expect(channel.producibleSteps).toEqual([]);
    expect(channel.stepTransitions).toEqual([
      {
        // Every published leg carries the ONE canonical identifier of the arrow it is.
        arrowKey: "meeting_attended_to_paid_client",
        from: expect.objectContaining({ key: "meeting_attended" }),
        to: expect.objectContaining({ key: "paid_client" }),
      },
    ]);
    expect(channel.salesFunnels.map((f) => f.key)).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
    ]);
    // A customer-operated channel spends none of the platform's money, and the zero is the statement.
    expect(channel.operatedBy).toBe("customer");
    expect(channel.terms.dailyOperatingCostCents).toBe(0);
  });
});
