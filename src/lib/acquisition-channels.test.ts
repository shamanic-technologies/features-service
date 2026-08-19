/**
 * THE JOIN IS THE MODEL: a channel states what it can PRODUCE, a funnel states what STARTS it, and which
 * pairings are possible falls out of the two. These cases pin that nothing is stated twice — in
 * particular that the entry-step mirror cannot drift from the chain it claims to read.
 */
import { describe, it, expect } from "vitest";

import {
  PRODUCIBLE_STEPS,
  PRODUCIBLE_STEP_KEYS,
  SALES_FUNNEL_ENTRY_STEP,
  FUNNEL_ENTRY_STEP_LABEL,
  matchProducibleStepKey,
  sellableFunnelsFor,
  CHANNEL_FAMILIES,
} from "./acquisition-channels.js";
import { SALES_FUNNELS, SALES_FUNNEL_KEYS } from "./sales-funnels.js";

describe("what a channel can produce", () => {
  it("names the four kinds in play, each with buyer-facing wording", () => {
    expect([...PRODUCIBLE_STEP_KEYS]).toEqual([
      "conversation",
      "website_visit",
      "in_ad_form_submission",
      "in_ad_booked_meeting",
    ]);
    for (const key of PRODUCIBLE_STEP_KEYS) {
      expect(PRODUCIBLE_STEPS[key].key).toBe(key);
      expect(PRODUCIBLE_STEPS[key].label.length).toBeGreaterThan(0);
      expect(PRODUCIBLE_STEPS[key].description.length).toBeGreaterThan(0);
    }
  });

  it("tolerates separator and case variance on the way IN, and names nothing it does not know", () => {
    expect(matchProducibleStepKey("Website Visit")).toBe("website_visit");
    expect(matchProducibleStepKey("in-ad-form-submission")).toBe("in_ad_form_submission");
    expect(matchProducibleStepKey("In Ad Booked Meeting")).toBe("in_ad_booked_meeting");
    // The pre-rename `platform_*` spelling is GONE, not aliased. It shipped for minutes, no consumer
    // outside the cluster ever read it, and every row is rewritten by the boot seed — so two names for
    // one step is a second vocabulary bought for nothing.
    expect(matchProducibleStepKey("platform_form_submission")).toBeNull();
    expect(matchProducibleStepKey("carrier pigeon")).toBeNull();
  });
});

describe("what STARTS a funnel", () => {
  it("every declared chain states its entry step", () => {
    for (const key of SALES_FUNNEL_KEYS) {
      expect(PRODUCIBLE_STEP_KEYS, key).toContain(SALES_FUNNEL_ENTRY_STEP[key]);
    }
  });

  it("the entry step MATCHES the chain's own first step — the mirror cannot drift from what it reads", () => {
    for (const key of SALES_FUNNEL_KEYS) {
      const firstStep = SALES_FUNNELS[key].steps[0];
      const entry = SALES_FUNNEL_ENTRY_STEP[key];
      expect(FUNNEL_ENTRY_STEP_LABEL[entry], `${key} starts with "${firstStep}"`).toContain(firstStep);
    }
  });
});

describe("which pairings are possible", () => {
  it("a channel that opens a conversation sells the conversation chain, and ONLY that one", () => {
    expect(sellableFunnelsFor(["conversation"])).toEqual(["sales_meetings_from_conversation"]);
  });

  it("a channel that sends a website visit sells every click-driven chain", () => {
    expect(sellableFunnelsFor(["website_visit"])).toEqual([
      "sales_meetings_from_website",
      "website_purchases",
      "form_magnet",
    ]);
  });

  it("a channel that does both sells all four, in the catalogue's own order", () => {
    expect(sellableFunnelsFor(["conversation", "website_visit"])).toEqual([...SALES_FUNNEL_KEYS]);
    // Order is the catalogue's, not the order the channel happens to list its steps in.
    expect(sellableFunnelsFor(["website_visit", "conversation"])).toEqual([...SALES_FUNNEL_KEYS]);
  });

  it("a step no deployed chain starts from sells NOTHING yet, and says so as an empty list", () => {
    // brand-service ships the on-platform chains in parallel. Until it does, a channel producing only
    // those sells through none of the declared four — and the moment the mirror gains the chain, it
    // starts selling with no change here.
    expect(sellableFunnelsFor(["in_ad_form_submission"])).toEqual([]);
    expect(sellableFunnelsFor(["in_ad_booked_meeting"])).toEqual([]);
    expect(sellableFunnelsFor(["website_visit", "in_ad_form_submission"])).toEqual([
      "sales_meetings_from_website",
      "website_purchases",
      "form_magnet",
    ]);
  });

  it("names three families and no more", () => {
    expect([...CHANNEL_FAMILIES]).toEqual(["outbound_one_to_one", "paid_reach", "earned"]);
  });
});
