/**
 * THE PUBLIC CATALOGUE IS A PRICE LIST, so a row it cannot read is an ERROR, never a row it half-reads.
 * A malformed blob that silently degraded would publish terms nobody set, which is worse than a failure.
 */
import { describe, it, expect } from "vitest";

import {
  buildChannelCatalogue,
  parseAcquisitionChannel,
  producibleStepCatalogue,
  MalformedAcquisitionChannelError,
  type CatalogueFeatureRow,
} from "./channel-catalogue.js";
import { PRODUCIBLE_STEP_KEYS } from "./acquisition-channels.js";

const CHANNEL = {
  family: "outbound_one_to_one",
  producibleSteps: ["conversation", "website_visit"],
  terms: { dailyOperatingCostCents: 800, minimumCommitmentDays: 30, maxDaysToFirstProduction: 14 },
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
      ["unknown step", { ...CHANNEL, producibleSteps: ["smoke_signal"] }],
      ["produces nothing", { ...CHANNEL, producibleSteps: [] }],
      ["terms missing", { family: CHANNEL.family, producibleSteps: CHANNEL.producibleSteps }],
      ["fractional cents", { ...CHANNEL, terms: { ...CHANNEL.terms, dailyOperatingCostCents: 12.5 } }],
      ["negative cost", { ...CHANNEL, terms: { ...CHANNEL.terms, dailyOperatingCostCents: -1 } }],
      ["zero-day commitment", { ...CHANNEL, terms: { ...CHANNEL.terms, minimumCommitmentDays: 0 } }],
      ["fractional days", { ...CHANNEL, terms: { ...CHANNEL.terms, maxDaysToFirstProduction: 1.5 } }],
    ];
    for (const [label, blob] of cases) {
      expect(() => parseAcquisitionChannel("cold-email", blob), label).toThrow(MalformedAcquisitionChannelError);
      expect(() => parseAcquisitionChannel("cold-email", blob), label).toThrow(/cold-email/);
    }
  });

  it("tolerates separator and case variance in a stored step, as every other mirror here does", () => {
    const parsed = parseAcquisitionChannel("x", { ...CHANNEL, producibleSteps: ["Website Visit"] });
    expect(parsed!.producibleSteps).toEqual(["website_visit"]);
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

  it("publishes the terms verbatim and the funnels DERIVED from what the channel produces", () => {
    const [channel] = buildChannelCatalogue([row()]);
    expect(channel.terms).toEqual(CHANNEL.terms);
    expect(channel.producibleSteps.map((s) => s.key)).toEqual(["conversation", "website_visit"]);
    // Each step arrives with the wording a buyer reads, so the site never invents a label.
    for (const step of channel.producibleSteps) expect(step.label.length).toBeGreaterThan(0);
    expect(channel.salesFunnels.map((f) => f.key)).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
      "website_purchases",
      "form_magnet",
    ]);
    // A funnel arrives with its chain, so a row renders without the consumer knowing the catalogue.
    expect(channel.salesFunnels[0].steps).toEqual([
      "Positive reply",
      "Meeting booked",
      "Meeting attended",
      "Paid client",
    ]);
  });

  it("a channel producing only an on-platform step publishes an EMPTY funnel list, and still publishes", () => {
    // No deployed chain starts from a platform form yet. The channel is still bookable and still
    // listed with its terms; what it cannot do today is be PAIRED, and it says that as an empty list.
    const [channel] = buildChannelCatalogue([
      row({ acquisitionChannel: { ...CHANNEL, producibleSteps: ["platform_form_submission"] } }),
    ]);
    expect(channel.salesFunnels).toEqual([]);
    expect(channel.terms).toEqual(CHANNEL.terms);
  });

  it("a malformed row fails the whole read rather than quietly vanishing from the price list", () => {
    expect(() =>
      buildChannelCatalogue([row(), row({ slug: "broken", acquisitionChannel: { family: "telepathy" } })]),
    ).toThrow(MalformedAcquisitionChannelError);
  });

  it("publishes the step vocabulary itself, so a consumer never hardcodes it", () => {
    expect(producibleStepCatalogue().map((s) => s.key)).toEqual([...PRODUCIBLE_STEP_KEYS]);
  });
});
