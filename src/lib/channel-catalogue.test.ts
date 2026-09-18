/**
 * THE PUBLIC CATALOGUE IS A PRICE LIST, so a row it cannot read is an ERROR, never a row it half-reads.
 * A malformed blob that silently degraded would publish terms nobody set, which is worse than a failure.
 */
import { describe, it, expect } from "vitest";

import {
  buildChannelCatalogue,
  parseAcquisitionChannel,
  channelStepCatalogue,
  salesFunnelCatalogue,
  MalformedAcquisitionChannelError,
  type CatalogueFeatureRow,
} from "./channel-catalogue.js";
import { CHANNEL_STEP_KEYS, funnelStepKeys } from "./acquisition-channels.js";
import { SALES_FUNNELS, SALES_FUNNEL_KEYS } from "./sales-funnels.js";

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
      "sales_from_conversation",
      "sales_from_website",
    ]);
    // A funnel arrives with its funnel, so a row renders without the consumer knowing the catalogue.
    expect(channel.salesFunnels[0].steps).toEqual([
      "Positive reply",
      "Meeting booked",
      "Meeting attended",
      "Paid client",
    ]);
    // Each funnel entry carries the pair's MINIMUM RUN LENGTH already COMPOSED against this channel's
    // own term — one figure to render, never two halves for a consumer to `max()`.
    expect(
      channel.salesFunnels.map((f) => [f.key, f.funnelMinimumCommitmentDays, f.effectiveMinimumCommitmentDays, f.governedBy]),
    ).toEqual([
      ["sales_meetings_from_conversation", null, 30, "channel"],
      ["sales_meetings_from_website", null, 30, "channel"],
      ["website_purchases", null, 30, "channel"],
      ["form_magnet", null, 30, "channel"],
      ["sales_from_conversation", null, 30, "channel"],
      ["sales_from_website", null, 30, "channel"],
    ]);
    // The bare field is GONE — two grains under one word on one payload is what it cost to remove.
    expect(channel.salesFunnels.every((f) => !("minimumCommitmentDays" in f))).toBe(true);
    // The CHANNEL's own terms are unchanged and stand beside it — the admin's only reader.
    expect(channel.terms.minimumCommitmentDays).toBe(CHANNEL.terms.minimumCommitmentDays);
  });

  it("A CHANNEL DELIVERING AN AD STEP SELLS ITS AD FUNNEL — the production is no longer dead", () => {
    // This used to publish an EMPTY funnel list: the step was spelled `in_ad_form_submission` and no
    // deployed funnel started on that spelling, so the channel's whole lead-form production sold
    // nothing. brand-service now starts `lead_forms_from_ads` on exactly the step the ad delivers.
    const [channel] = buildChannelCatalogue([
      row({ acquisitionChannel: { ...CHANNEL, stepTransitions: [{ from: null, to: "form_submitted" }] } }),
    ]);
    expect(channel.salesFunnels.map((f) => f.key)).toEqual(["lead_forms_from_ads"]);
    expect(channel.terms).toEqual(CHANNEL.terms);

    const [meetings] = buildChannelCatalogue([
      row({ acquisitionChannel: { ...CHANNEL, stepTransitions: [{ from: null, to: "meeting_booked" }] } }),
    ]);
    expect(meetings.salesFunnels.map((f) => f.key)).toEqual(["sales_meetings_from_ads"]);
  });

  it("a step no deployed funnel takes still publishes the channel, and says so as an EMPTY funnel list", () => {
    // The honest empty answer still exists — it simply no longer fires for the ad steps. A channel
    // whose only leg is one no funnel has is bookable, listed with its terms, and pairable with nothing.
    const [channel] = buildChannelCatalogue([
      row({ acquisitionChannel: { ...CHANNEL, stepTransitions: [{ from: "signup", to: "meeting_attended" }] } }),
    ]);
    expect(channel.salesFunnels).toEqual([]);
    expect(channel.terms).toEqual(CHANNEL.terms);
  });

  it("THE JOIN NEEDS NO TRANSLATION TABLE — a produced step names its funnels by token match", () => {
    // AC: `funnels.filter(f => f.entryStep.key === step.key)` is the whole answer, from ONE read.
    const funnels = salesFunnelCatalogue();
    expect(funnels.map((f) => f.key)).toEqual([...SALES_FUNNEL_KEYS]);
    for (const funnel of funnels) {
      expect(funnel.entryStep.key, funnel.key).toBe(funnelStepKeys(funnel.key)[0]);
      expect(funnel.entryLegKey, funnel.key).toBe(`start_to_${funnel.entryStep.key}`);
      expect(funnel.steps, funnel.key).toEqual(SALES_FUNNELS[funnel.key].steps);
      expect(funnel.name, funnel.key).toBe(SALES_FUNNELS[funnel.key].name);
    }
    expect(funnels.filter((f) => f.entryStep.key === "form_submitted").map((f) => f.key)).toEqual([
      "lead_forms_from_ads",
    ]);
    expect(funnels.filter((f) => f.entryStep.key === "meeting_booked").map((f) => f.key)).toEqual([
      "sales_meetings_from_ads",
    ]);
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
        // Every published leg carries the ONE canonical identifier of the leg it is.
        legKey: "meeting_attended_to_paid_client",
        from: expect.objectContaining({ key: "meeting_attended" }),
        to: expect.objectContaining({ key: "paid_client" }),
      },
    ]);
    expect(channel.salesFunnels.map((f) => f.key)).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
      "sales_meetings_from_ads",
    ]);
    // A customer-operated channel spends none of the platform's money, and the zero is the statement.
    expect(channel.operatedBy).toBe("customer");
    expect(channel.terms.dailyOperatingCostCents).toBe(0);
  });
});
