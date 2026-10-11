import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { MANAGED_CHANNEL_SLUGS, PERSON_SCOPED_CHANNEL_SLUGS, channelLegMinimumMonthlyCents } from "./channel-leg-minimums.js";
import { OFFER_PATH_MANAGED_CHANNEL_SLUGS } from "./offer-sales-paths.js";

describe("a person-scoped managed channel runs, but is never a way an offer sells (owner 2026-10-11)", () => {
  it("AI Follow-up Email is managed (billing funds it, its reactive leg has no floor)", () => {
    expect(MANAGED_CHANNEL_SLUGS.has("ai-follow-up-email")).toBe(true);
    expect(PERSON_SCOPED_CHANNEL_SLUGS.has("ai-follow-up-email")).toBe(true);
    expect(channelLegMinimumMonthlyCents({ slug: "ai-follow-up-email", operatedBy: "platform" }, true)).toBe(0);
  });

  it("the offer sales paths cross exactly the three channels they always crossed", () => {
    expect([...OFFER_PATH_MANAGED_CHANNEL_SLUGS].sort()).toEqual(["ai-instant-call", "ai-meeting-booking", "sales-cold-email-outreach"]);
  });
});
