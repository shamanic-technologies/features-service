import { describe, it, expect } from "vitest";

import { buildChannelCatalogue } from "./channel-catalogue.js";
import { CHANNEL_SHORT_DESCRIPTIONS, channelShortDescription, MissingChannelShortDescriptionError } from "./channel-short-descriptions.js";
import { SEED_FEATURES } from "../seed/features.js";

const PUBLISHED = buildChannelCatalogue(SEED_FEATURES);

describe("channel card captions", () => {
  it("the three channels we run carry the owner's approved copy verbatim", () => {
    const captionOf = (slug: string) => PUBLISHED.find((c) => c.slug === slug)?.shortDescription;
    expect(captionOf("sales-cold-email-outreach")).toBe("We find your buyers and email them for you.");
    expect(captionOf("ai-meeting-booking")).toBe("Our AI answers replies and books the meeting.");
    expect(captionOf("ai-instant-call")).toBe("A buyer says yes? We ring your rep right away.");
  });

  it("every published channel has a caption, and every caption belongs to a published channel", () => {
    expect(PUBLISHED.length).toBeGreaterThan(40);
    for (const c of PUBLISHED) expect(c.shortDescription, c.slug).toBe(CHANNEL_SHORT_DESCRIPTIONS[c.slug]);
    expect(Object.keys(CHANNEL_SHORT_DESCRIPTIONS).sort()).toEqual(PUBLISHED.map((c) => c.slug).sort());
  });

  it("every caption fits a small card: at most 10 words, no dash, no internal vocabulary", () => {
    for (const [slug, caption] of Object.entries(CHANNEL_SHORT_DESCRIPTIONS)) {
      expect(caption.split(/\s+/).length, slug).toBeLessThanOrEqual(10);
      expect(caption, slug).not.toMatch(/[—–]|funnel|workflow|model/i);
    }
  });

  it("a channel with no caption fails loud", () => {
    expect(() => channelShortDescription("not-a-channel")).toThrow(MissingChannelShortDescriptionError);
  });
});
