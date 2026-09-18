/**
 * THE JOIN IS THE MODEL: a channel states which LEG of a funnel it performs, a funnel states its funnel,
 * and which pairings are possible falls out of the two. These cases pin that nothing is stated twice —
 * in particular that the step mirror cannot drift from the funnels it claims to read, and that widening
 * the join from "the funnel's entry step" to "any of the funnel's legs" left every channel published
 * before it reading the exact same list of funnels.
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
import { SALES_FUNNELS, SALES_FUNNEL_KEYS, type SalesFunnelKey } from "./sales-funnels.js";

describe("the steps a channel can move a lead between", () => {
  it("spans EVERY step of every funnel, not only the ones a funnel can start from", () => {
    // A channel that performs an internal leg names the step it moves a lead OUT of, and that step is
    // never one a funnel starts at — so the vocabulary is the union, not the entry subset it once was.
    expect([...CHANNEL_STEP_KEYS]).toEqual([
      "conversation",
      "website_visit",
      "meeting_booked",
      "meeting_attended",
      "signup",
      "form_submitted",
      "paid_client",
    ]);
    for (const key of CHANNEL_STEP_KEYS) {
      expect(CHANNEL_STEPS[key].key).toBe(key);
      expect(CHANNEL_STEPS[key].label.length).toBeGreaterThan(0);
      expect(CHANNEL_STEPS[key].description.length).toBeGreaterThan(0);
    }
  });

  it("names every step of every deployed funnel — a funnel we cannot read would silently lose a leg", () => {
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
    expect(matchChannelStepKey("Form submitted")).toBe("form_submitted");
    // The pre-rename `platform_*` and `in_ad_*` spellings are GONE, not aliased. Neither had a consumer
    // outside the cluster, every row is rewritten by the boot seed, and two names for one step is a
    // second vocabulary bought for nothing — which is exactly what the rename was closing.
    expect(matchChannelStepKey("platform_form_submission")).toBeNull();
    expect(matchChannelStepKey("in_ad_form_submission")).toBeNull();
    expect(matchChannelStepKey("in_ad_booked_meeting")).toBeNull();
    expect(matchChannelStepKey("carrier pigeon")).toBeNull();
  });

  it("A CHANNEL'S PRODUCED STEP IS A FUNNEL'S FIRST STEP, in the SAME token — that is the whole join", () => {
    // AC: a consumer answers "which funnels does this outcome lead into" with a token match against
    // the funnel catalogue, with no translation table of its own. It only works because a channel's
    // produced step and the funnel's entry step are the SAME key.
    for (const key of SALES_FUNNEL_KEYS) {
      const entry = funnelStepKeys(key)[0]!;
      expect(matchChannelStepKey(entry), key).toBe(entry);
      expect(sellableFunnelsFor(producesFromNothing(entry)), key).toContain(key);
    }
    // And the two ad-delivered steps are the two that could NOT be joined before: the form an ad hosts
    // is the SAME step as a form on the brand's own site (one form step, since #1002), and a meeting
    // booked inside the ad is the SAME step the other meeting funnels reach — brand-service's own
    // decision, mirrored here rather than second-guessed.
    expect(matchChannelStepKey("form_submitted")).toBe("form_submitted");
    expect(funnelStepKeys("lead_forms_from_ads")[0]).toBe("form_submitted");
    expect(funnelStepKeys("form_magnet")[1]).toBe("form_submitted");
    expect(funnelStepKeys("sales_meetings_from_ads")[0]).toBe("meeting_booked");
  });
});

describe("a funnel read as its legs", () => {
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

  it("the entry step MATCHES the funnel's own first step — the mirror cannot drift from what it reads", () => {
    for (const key of SALES_FUNNEL_KEYS) {
      const firstStep = SALES_FUNNELS[key].steps[0];
      expect(SALES_FUNNEL_ENTRY_STEP[key], `${key} starts with "${firstStep}"`).toBe(FUNNEL_STEP_LABEL_TO_KEY[firstStep]);
      expect(funnelLegs(key)[0]).toEqual({ from: null, to: SALES_FUNNEL_ENTRY_STEP[key] });
    }
  });

  it("EVERY funnel terminates in a paid client — the SALE is a leg of all of them", () => {
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
  it("a channel that opens a conversation sells the conversation funnel, and ONLY that one", () => {
    expect(sellableFunnelsFor(producesFromNothing("conversation"))).toEqual([
      "sales_meetings_from_conversation",
      "sales_from_conversation",
    ]);
  });

  it("a channel that sends a website visit sells every click-driven funnel", () => {
    expect(sellableFunnelsFor(producesFromNothing("website_visit"))).toEqual([
      "sales_meetings_from_website",
      "website_purchases",
      "form_magnet",
      "sales_from_website",
    ]);
  });

  it("a channel that does both sells every funnel a click or a reply enters, in the catalogue's own order", () => {
    const bothChannels: SalesFunnelKey[] = [
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
      "website_purchases",
      "form_magnet",
      "sales_from_conversation",
      "sales_from_website",
    ];
    expect(sellableFunnelsFor(producesFromNothing("conversation", "website_visit"))).toEqual(bothChannels);
    // Order is the catalogue's, not the order the channel happens to list its legs in.
    expect(sellableFunnelsFor(producesFromNothing("website_visit", "conversation"))).toEqual(bothChannels);
    // The two AD funnels are NOT in there, and that is the join working rather than a gap: neither a
    // conversation nor a website visit is their first step.
    expect(bothChannels).not.toContain("sales_meetings_from_ads");
    expect(bothChannels).not.toContain("lead_forms_from_ads");
  });

  it("AN AD-DELIVERED STEP SELLS ITS OWN FUNNEL — the step a channel produces IS the funnel's first step", () => {
    // These two used to sell NOTHING, because the steps were spelled `in_ad_*` and no funnel started on
    // that spelling. brand-service now starts a funnel on exactly the step the ad DELIVERS, so the join
    // is a plain token match and the production is no longer dead.
    expect(sellableFunnelsFor(producesFromNothing("form_submitted"))).toEqual(["lead_forms_from_ads"]);
    expect(sellableFunnelsFor(producesFromNothing("meeting_booked"))).toEqual(["sales_meetings_from_ads"]);

    // And producing a booked meeting FROM NOTHING does not make a channel able to sell the two meeting
    // funnels whose meeting is reached FROM a conversation or a website visit — the entry leg and the
    // internal leg are different legs, so no false pairing appears.
    expect(sellableFunnelsFor(producesFromNothing("meeting_booked"))).not.toContain("sales_meetings_from_conversation");
    expect(sellableFunnelsFor(producesFromNothing("meeting_booked"))).not.toContain("sales_meetings_from_website");

    // An ad platform that sends visits AND hosts the form sells both families at once.
    expect(sellableFunnelsFor(producesFromNothing("website_visit", "form_submitted"))).toEqual([
      "sales_meetings_from_website",
      "website_purchases",
      "form_magnet",
      "lead_forms_from_ads",
      "sales_from_website",
    ]);
  });

  it("AN INTERNAL LEG SELLS ITS FUNNEL TOO — that is the whole point of the widened join", () => {
    // Booking the meeting off a reply is a leg of the conversation funnel; off a visit, of the website
    // funnel. A channel that does both sells both, and neither of them is anyone's ENTRY step.
    expect(sellableFunnelsFor([{ from: "conversation", to: "meeting_booked" }])).toEqual([
      "sales_meetings_from_conversation",
    ]);
    expect(sellableFunnelsFor([{ from: "website_visit", to: "meeting_booked" }])).toEqual([
      "sales_meetings_from_website",
    ]);
    // The THREE meeting funnels share every leg AFTER the meeting is booked, so one leg sells all of
    // them — the ad funnel included, which is exactly what "a funnel is a way of READING legs" means.
    expect(sellableFunnelsFor([{ from: "meeting_booked", to: "meeting_attended" }])).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
      "sales_meetings_from_ads",
    ]);
    expect(sellableFunnelsFor([{ from: "meeting_attended", to: "paid_client" }])).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
      "sales_meetings_from_ads",
    ]);
    // And the two self-serve funnels close through their own milestone. Closing a lead who submitted a
    // form sells BOTH form funnels now, and that is the merge behaving as intended rather than a false
    // pairing: there is ONE form step, so where the form was hosted is a fact about the funnel the lead
    // arrived through, not about the leg somebody performs afterwards.
    expect(sellableFunnelsFor([{ from: "signup", to: "paid_client" }])).toEqual(["website_purchases"]);
    expect(sellableFunnelsFor([{ from: "form_submitted", to: "paid_client" }])).toEqual([
      "form_magnet",
      "lead_forms_from_ads",
    ]);
  });

  it("a leg no funnel takes sells nothing, even between two steps that both exist", () => {
    // Both steps are real; the funnel that goes from one to the other is not.
    expect(sellableFunnelsFor([{ from: "signup", to: "meeting_attended" }])).toEqual([]);
    expect(sellableFunnelsFor([{ from: "conversation", to: "signup" }])).toEqual([]);
    // Direction matters: no funnel walks backwards.
    expect(sellableFunnelsFor([{ from: "meeting_attended", to: "meeting_booked" }])).toEqual([]);
  });

  it("names four families and two operators, and no more", () => {
    expect([...CHANNEL_FAMILIES]).toEqual(["outbound_one_to_one", "paid_reach", "earned", "conversion"]);
    expect([...CHANNEL_OPERATORS]).toEqual(["platform", "customer"]);
  });
});

describe("what a VISITOR reads on a step", () => {
  // The onboarding's first screen renders one card per producible step, titled with the step's label
  // and explained with its description, to somebody who has not signed up. So these are customer copy.

  it("names the step a buyer's ANSWER produces the way every funnel that starts on it names it", () => {
    // The case that shipped wrong. `conversation` published "Conversation" while the funnels it opens
    // published "Positive reply", so a consumer joining a produced step to a funnel's first rung BY
    // LABEL matched nothing at all — and the banned word was the title of a pre-signup card.
    expect(CHANNEL_STEPS.conversation.label).toBe("Positive reply");
    expect(SALES_FUNNELS.sales_meetings_from_conversation.steps[0]).toBe(CHANNEL_STEPS.conversation.label);
    expect(SALES_FUNNELS.sales_from_conversation.steps[0]).toBe(CHANNEL_STEPS.conversation.label);
  });

  it("serves ONE form step, named \"Form submitted\", covering the brand's own form AND an ad-hosted one", () => {
    // Owner, 2026-09-18: "Tu vires Form filled de partout, ca n'a aucun sens, on laisse juste Form
    // Submitted dans notre systeme." There used to be two steps — `form_filled` (the brand's own site)
    // and `lead_form_submitted` (a form hosted by the ad platform) — and a signed-out visitor read two
    // near-identical cards on the onboarding's first screen with no way to tell why they were two.
    //
    // Every case here asserts the MERGE, so a suite that only checked "a label came back" would pass on
    // the two-step implementation this replaces.
    expect(CHANNEL_STEP_KEYS.filter((k) => k.includes("form"))).toEqual(["form_submitted"]);
    expect(CHANNEL_STEPS.form_submitted.label).toBe("Form submitted");
    for (const key of CHANNEL_STEP_KEYS) expect(CHANNEL_STEPS[key].label).not.toBe("Form filled");

    // ONE step, so its description has to cover BOTH homes or a reader loses the distinction entirely.
    expect(CHANNEL_STEPS.form_submitted.description).toContain("ad platform");
    expect(CHANNEL_STEPS.form_submitted.description).toContain("brand's own site");

    // BOTH form funnels name it, which is what "one form step" means where it is observable.
    expect(SALES_FUNNELS.lead_forms_from_ads.steps[0]).toBe("Form submitted");
    expect(SALES_FUNNELS.form_magnet.steps[1]).toBe("Form submitted");
    expect(funnelStepKeys("lead_forms_from_ads")[0]).toBe("form_submitted");
    expect(funnelStepKeys("form_magnet")[1]).toBe("form_submitted");
    expect(FUNNEL_STEP_LABEL_TO_KEY["Form submitted"]).toBe("form_submitted");

    // Both funnels survive under their own names — the STEP merged, the funnels did not.
    expect(SALES_FUNNELS.lead_forms_from_ads.name).toBe("Lead Form from Ads");
    expect(SALES_FUNNELS.form_magnet.name).toBe("Form Magnet");
  });

  it("still RESOLVES both retired spellings, so nothing a brand or a stored row already said is lost", () => {
    // brand-service OWNS the funnel vocabulary and still spells the two rungs "Form filled" and "Lead
    // form submitted" in its deployed catalogue. Nothing here asks it to move: both resolve on the way
    // IN, so a rate a customer stated on a "Form filled" arrow still prices, and a stored channel blob
    // or a consumer sending yesterday's key keeps working. NEITHER is ever emitted.
    expect(matchChannelStepKey("form_filled")).toBe("form_submitted");
    expect(matchChannelStepKey("lead_form_submitted")).toBe("form_submitted");
    expect(matchChannelStepKey("Form filled")).toBe("form_submitted");
    expect(matchChannelStepKey("Lead form submitted")).toBe("form_submitted");
    expect(FUNNEL_STEP_LABEL_TO_KEY["Form filled"]).toBe("form_submitted");
    expect(FUNNEL_STEP_LABEL_TO_KEY["Lead form submitted"]).toBe("form_submitted");
    // Resolvable is not published: no step KEY and no step LABEL carries either spelling.
    expect([...CHANNEL_STEP_KEYS]).not.toContain("form_filled");
    expect([...CHANNEL_STEP_KEYS]).not.toContain("lead_form_submitted");
  });

  it("states EVERY step in the funnels' own wording, so the join by LABEL is a lookup", () => {
    // The general invariant behind the case above: a step's published label IS the string
    // brand-service's funnels use for that rung, for all eight. A step whose label drifts off the
    // mirror silently breaks the join for its own funnels and nothing else notices.
    for (const key of CHANNEL_STEP_KEYS) {
      expect(FUNNEL_STEP_LABEL_TO_KEY[CHANNEL_STEPS[key].label]).toBe(key);
    }
  });

  it("carries the banned word in NO step label and NO step description", () => {
    // The owner banned it fleet-wide: the two entry outcomes are a positive reply and a website visit.
    // This is the STEP vocabulary only — a channel legitimately describes a phone call in plain English.
    for (const key of CHANNEL_STEP_KEYS) {
      expect(CHANNEL_STEPS[key].label.toLowerCase()).not.toContain("conversation");
      expect(CHANNEL_STEPS[key].description.toLowerCase()).not.toContain("conversation");
    }
  });

  it("keeps every step KEY exactly where it was, so no consumer join by key breaks", () => {
    // Only what a person reads moved. The keys are referenced by stored rows, by every leg identifier
    // and by every consumer that already joined on them.
    expect([...CHANNEL_STEP_KEYS]).toEqual([
      "conversation",
      "website_visit",
      "meeting_booked",
      "meeting_attended",
      "signup",
      "form_submitted",
      "paid_client",
    ]);
    expect(matchChannelStepKey("conversation")).toBe("conversation");
    expect(CHANNEL_STEPS.conversation.key).toBe("conversation");
  });
});
