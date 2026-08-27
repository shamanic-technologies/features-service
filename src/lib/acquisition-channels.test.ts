/**
 * THE JOIN IS THE MODEL: a channel states which LEG of a chain it performs, a funnel states its chain,
 * and which pairings are possible falls out of the two. These cases pin that nothing is stated twice —
 * in particular that the step mirror cannot drift from the chains it claims to read, and that widening
 * the join from "the chain's entry step" to "any of the chain's legs" left every channel published
 * before it reading the exact same list of chains.
 */
import { describe, it, expect } from "vitest";

import {
  CHANNEL_STEPS,
  CHANNEL_STEP_KEYS,
  CHANNEL_OPERATORS,
  SALES_FUNNEL_ENTRY_STEP,
  FUNNEL_STEP_LABEL_TO_KEY,
  funnelLegs,
  funnelStepKeys,
  matchChannelStepKey,
  producesFromNothing,
  producibleStepsOf,
  sellableFunnelsFor,
  CHANNEL_FAMILIES,
  type ChannelStepTransition,
} from "./acquisition-channels.js";
import { SALES_FUNNELS, SALES_FUNNEL_KEYS } from "./sales-funnels.js";

describe("the steps a channel can move a lead between", () => {
  it("spans EVERY step of every chain, not only the ones a chain can start from", () => {
    // A channel that performs an internal leg names the step it moves a lead OUT of, and that step is
    // never one a chain starts at — so the vocabulary is the union, not the entry subset it once was.
    expect([...CHANNEL_STEP_KEYS]).toEqual([
      "conversation",
      "website_visit",
      "meeting_booked",
      "meeting_attended",
      "signup",
      "form_filled",
      "paid_client",
      "in_ad_form_submission",
      "in_ad_booked_meeting",
    ]);
    for (const key of CHANNEL_STEP_KEYS) {
      expect(CHANNEL_STEPS[key].key).toBe(key);
      expect(CHANNEL_STEPS[key].label.length).toBeGreaterThan(0);
      expect(CHANNEL_STEPS[key].description.length).toBeGreaterThan(0);
    }
  });

  it("names every step of every deployed chain — a chain we cannot read would silently lose a leg", () => {
    for (const key of SALES_FUNNEL_KEYS) {
      for (const label of SALES_FUNNELS[key].steps) {
        expect(FUNNEL_STEP_LABEL_TO_KEY[label], `${key} → "${label}"`).toBeDefined();
      }
      expect(() => funnelStepKeys(key), key).not.toThrow();
    }
  });

  it("tolerates separator and case variance on the way IN, and names nothing it does not know", () => {
    expect(matchChannelStepKey("Website Visit")).toBe("website_visit");
    expect(matchChannelStepKey("Meeting Attended")).toBe("meeting_attended");
    expect(matchChannelStepKey("in-ad-form-submission")).toBe("in_ad_form_submission");
    // The pre-rename `platform_*` spelling is GONE, not aliased. It shipped for minutes, no consumer
    // outside the cluster ever read it, and every row is rewritten by the boot seed — so two names for
    // one step is a second vocabulary bought for nothing.
    expect(matchChannelStepKey("platform_form_submission")).toBeNull();
    expect(matchChannelStepKey("carrier pigeon")).toBeNull();
  });

  it("keeps the `in_ad_` prefix apart from the SITE steps it would otherwise collide with", () => {
    // "Form filled" and "Meeting booked" are real INTERNAL steps of deployed chains, reached on the
    // brand's own site. What an ad produces is an ENTRY step reached without ever getting there, so the
    // two pairs of names must stay distinct — which is the whole reason the prefix exists.
    expect(matchChannelStepKey("form_filled")).toBe("form_filled");
    expect(matchChannelStepKey("in_ad_form_submission")).toBe("in_ad_form_submission");
    expect(matchChannelStepKey("meeting_booked")).toBe("meeting_booked");
    expect(matchChannelStepKey("in_ad_booked_meeting")).toBe("in_ad_booked_meeting");
  });
});

describe("a chain read as its legs", () => {
  it("starts with a leg FROM NOTHING, then one leg per consecutive pair", () => {
    expect(funnelLegs("sales_meetings_from_conversation")).toEqual([
      { from: null, to: "conversation" },
      { from: "conversation", to: "meeting_booked" },
      { from: "meeting_booked", to: "meeting_attended" },
      { from: "meeting_attended", to: "paid_client" },
    ]);
    expect(funnelLegs("website_purchases")).toEqual([
      { from: null, to: "website_visit" },
      { from: "website_visit", to: "signup" },
      { from: "signup", to: "paid_client" },
    ]);
  });

  it("has exactly one leg fewer than it has steps, plus its entry", () => {
    for (const key of SALES_FUNNEL_KEYS) {
      expect(funnelLegs(key).length, key).toBe(SALES_FUNNELS[key].steps.length);
    }
  });

  it("the entry step MATCHES the chain's own first step — the mirror cannot drift from what it reads", () => {
    for (const key of SALES_FUNNEL_KEYS) {
      const firstStep = SALES_FUNNELS[key].steps[0];
      expect(SALES_FUNNEL_ENTRY_STEP[key], `${key} starts with "${firstStep}"`).toBe(FUNNEL_STEP_LABEL_TO_KEY[firstStep]);
      expect(funnelLegs(key)[0]).toEqual({ from: null, to: SALES_FUNNEL_ENTRY_STEP[key] });
    }
  });

  it("EVERY chain terminates in a paid client — the SALE is a leg of all of them", () => {
    for (const key of SALES_FUNNEL_KEYS) {
      expect(funnelStepKeys(key).at(-1), key).toBe("paid_client");
    }
  });
});

describe("from nothing is the SPECIAL case, written as one", () => {
  it("`producesFromNothing` states a null `from` for each step", () => {
    expect(producesFromNothing("conversation", "website_visit")).toEqual([
      { from: null, to: "conversation" },
      { from: null, to: "website_visit" },
    ]);
  });

  it("what a channel PRODUCES is derived from its legs, never stated beside them", () => {
    const legs: ChannelStepTransition[] = [
      { from: null, to: "website_visit" },
      { from: "website_visit", to: "signup" },
    ];
    expect(producibleStepsOf(legs)).toEqual(["website_visit"]);
    // A channel that only performs internal legs produces nothing, and that is a real answer.
    expect(producibleStepsOf([{ from: "meeting_attended", to: "paid_client" }])).toEqual([]);
  });
});

describe("which pairings are possible", () => {
  it("a channel that opens a conversation sells the conversation chain, and ONLY that one", () => {
    expect(sellableFunnelsFor(producesFromNothing("conversation"))).toEqual(["sales_meetings_from_conversation"]);
  });

  it("a channel that sends a website visit sells every click-driven chain", () => {
    expect(sellableFunnelsFor(producesFromNothing("website_visit"))).toEqual([
      "sales_meetings_from_website",
      "website_purchases",
      "form_magnet",
    ]);
  });

  it("a channel that does both sells all four, in the catalogue's own order", () => {
    expect(sellableFunnelsFor(producesFromNothing("conversation", "website_visit"))).toEqual([...SALES_FUNNEL_KEYS]);
    // Order is the catalogue's, not the order the channel happens to list its legs in.
    expect(sellableFunnelsFor(producesFromNothing("website_visit", "conversation"))).toEqual([...SALES_FUNNEL_KEYS]);
  });

  it("a step no deployed chain starts from sells NOTHING yet, and says so as an empty list", () => {
    // brand-service ships the in-ad chains in parallel. Until it does, a channel producing only those
    // sells through none of the declared four — and the moment the mirror gains the chain, it starts
    // selling with no change here.
    expect(sellableFunnelsFor(producesFromNothing("in_ad_form_submission"))).toEqual([]);
    expect(sellableFunnelsFor(producesFromNothing("in_ad_booked_meeting"))).toEqual([]);
    expect(sellableFunnelsFor(producesFromNothing("website_visit", "in_ad_form_submission"))).toEqual([
      "sales_meetings_from_website",
      "website_purchases",
      "form_magnet",
    ]);
  });

  it("AN INTERNAL LEG SELLS ITS CHAIN TOO — that is the whole point of the widened join", () => {
    // Booking the meeting off a reply is a leg of the conversation chain; off a visit, of the website
    // chain. A channel that does both sells both, and neither of them is anyone's ENTRY step.
    expect(sellableFunnelsFor([{ from: "conversation", to: "meeting_booked" }])).toEqual([
      "sales_meetings_from_conversation",
    ]);
    expect(sellableFunnelsFor([{ from: "website_visit", to: "meeting_booked" }])).toEqual([
      "sales_meetings_from_website",
    ]);
    // The two meeting chains share every leg AFTER the meeting is booked, so one leg sells both.
    expect(sellableFunnelsFor([{ from: "meeting_booked", to: "meeting_attended" }])).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
    ]);
    expect(sellableFunnelsFor([{ from: "meeting_attended", to: "paid_client" }])).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
    ]);
    // And the two self-serve chains close through their own milestone.
    expect(sellableFunnelsFor([{ from: "signup", to: "paid_client" }])).toEqual(["website_purchases"]);
    expect(sellableFunnelsFor([{ from: "form_filled", to: "paid_client" }])).toEqual(["form_magnet"]);
  });

  it("a leg no chain takes sells nothing, even between two steps that both exist", () => {
    // Both steps are real; the chain that goes from one to the other is not.
    expect(sellableFunnelsFor([{ from: "signup", to: "meeting_attended" }])).toEqual([]);
    expect(sellableFunnelsFor([{ from: "conversation", to: "signup" }])).toEqual([]);
    // Direction matters: no chain walks backwards.
    expect(sellableFunnelsFor([{ from: "meeting_attended", to: "meeting_booked" }])).toEqual([]);
  });

  it("names four families and two operators, and no more", () => {
    expect([...CHANNEL_FAMILIES]).toEqual(["outbound_one_to_one", "paid_reach", "earned", "conversion"]);
    expect([...CHANNEL_OPERATORS]).toEqual(["platform", "customer"]);
  });
});
