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
      "form_filled",
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
    // The RETIRED form spelling still resolves, onto the ONE form step that survived it. That is not
    // the same call as the `in_ad_*` rename below: those were renamed before anything stored them, this
    // one was published and may sit in a stored blob, a campaign row or a budget ceiling.
    expect(matchChannelStepKey("lead_form_submitted")).toBe("form_filled");
    expect(matchChannelStepKey("Lead form submitted")).toBe("form_filled");
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
    // And the two ad-delivered steps are the two that could NOT be joined before. BOTH of them are now
    // steps this catalogue already had: a form filled inside the ad is the SAME `form_filled` step the
    // form magnet walks through, and a meeting booked inside the ad is the SAME step the other meeting
    // funnels reach.
    expect(matchChannelStepKey("form_filled")).toBe("form_filled");
    expect(funnelStepKeys("lead_forms_from_ads")[0]).toBe("form_filled");
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
    // Producing the form step FROM NOTHING sells the ad lead-form funnel — and ONLY that one: the form
    // magnet reaches its form FROM a website visit, so its own form leg is a different leg.
    expect(sellableFunnelsFor(producesFromNothing("form_filled"))).toEqual(["lead_forms_from_ads"]);
    expect(sellableFunnelsFor(producesFromNothing("meeting_booked"))).toEqual(["sales_meetings_from_ads"]);

    // And producing a booked meeting FROM NOTHING does not make a channel able to sell the two meeting
    // funnels whose meeting is reached FROM a conversation or a website visit — the entry leg and the
    // internal leg are different legs, so no false pairing appears.
    expect(sellableFunnelsFor(producesFromNothing("meeting_booked"))).not.toContain("sales_meetings_from_conversation");
    expect(sellableFunnelsFor(producesFromNothing("meeting_booked"))).not.toContain("sales_meetings_from_website");

    // An ad platform that sends visits AND hosts the form sells both families at once.
    expect(sellableFunnelsFor(producesFromNothing("website_visit", "form_filled"))).toEqual([
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
    // And the two self-serve funnels close through their own milestone. The FORM close spans THREE now
    // and that is the collapse behaving correctly rather than a false pairing: with one form step, the
    // form magnet's closing leg and the ad lead-form funnel's closing leg are the SAME leg — somebody
    // who turns a submitted form into a paying client does the identical work whichever funnel put the
    // form there. Same overlap the two meeting funnels already have on their tail legs.
    expect(sellableFunnelsFor([{ from: "signup", to: "paid_client" }])).toEqual(["website_purchases"]);
    expect(sellableFunnelsFor([{ from: "form_filled", to: "paid_client" }])).toEqual([
      "form_magnet",
      "lead_forms_from_ads",
    ]);
    // …while the two funnels' ENTRY legs stay distinct, so nothing about where the form came from is
    // lost: the form magnet reaches it FROM a website visit, the ad funnel lands on it from nothing.
    expect(sellableFunnelsFor([{ from: "website_visit", to: "form_filled" }])).toEqual(["form_magnet"]);
    expect(sellableFunnelsFor(producesFromNothing("form_filled"))).toEqual(["lead_forms_from_ads"]);
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

  it("publishes exactly ONE form step, labelled \"Form submitted\", and BOTH form funnels walk through it", () => {
    // THE GUARD. The owner ruled that a form hosted by the ad platform and a form on the brand's own
    // site are one step: what a buyer did is identical and only the CHANNEL differs, which the channel
    // already says. Every case here asserts the COLLAPSE — a suite that only checked "a label came
    // back" would pass on the two-step implementation this replaces.
    const formSteps = CHANNEL_STEP_KEYS.filter(
      (key) => /form/i.test(key) || /form/i.test(CHANNEL_STEPS[key].label),
    );
    expect(formSteps).toEqual(["form_filled"]);
    expect(CHANNEL_STEPS.form_filled.label).toBe("Form submitted");

    // The RETIRED key never comes back into the catalogue, under any spelling.
    expect((CHANNEL_STEP_KEYS as readonly string[])).not.toContain("lead_form_submitted");
    expect(Object.keys(CHANNEL_STEPS)).not.toContain("lead_form_submitted");
    expect(Object.values(CHANNEL_STEPS).map((s) => s.label)).not.toContain("Form filled");

    // …and is still ACCEPTED on the way in, resolving onto the survivor, so a stored blob or a caller
    // that still says yesterday's word reads the SAME step and therefore the same figure.
    expect(matchChannelStepKey("lead_form_submitted")).toBe("form_filled");

    // BOTH funnels walk through it: the form magnet reaches it from a website visit, the ad funnel
    // lands on it from nothing. Same step, two legs.
    expect(funnelStepKeys("form_magnet")).toEqual(["website_visit", "form_filled", "paid_client"]);
    expect(funnelStepKeys("lead_forms_from_ads")).toEqual(["form_filled", "paid_client"]);
    expect(SALES_FUNNELS.form_magnet.steps).toEqual(["Website visit", "Form submitted", "Paid client"]);
    expect(SALES_FUNNELS.lead_forms_from_ads.steps).toEqual(["Form submitted", "Paid client"]);

    // The label join resolves BOTH wordings onto the one key — brand-service still spells the form
    // magnet's middle rung "Form filled", and a mirror that stopped resolving the producer's own word
    // would silently drop that funnel's leg.
    expect(FUNNEL_STEP_LABEL_TO_KEY["Form submitted"]).toBe("form_filled");
    expect(FUNNEL_STEP_LABEL_TO_KEY["Form filled"]).toBe("form_filled");
    expect(FUNNEL_STEP_LABEL_TO_KEY["Lead form submitted"]).toBeUndefined();

    // Only the words moved: the surviving key, its legs and the funnels' own names are untouched.
    expect(CHANNEL_STEPS.form_filled.key).toBe("form_filled");
    expect(SALES_FUNNELS.lead_forms_from_ads.name).toBe("Lead Form from Ads");
    expect(SALES_FUNNELS.form_magnet.name).toBe("Form Magnet");
  });

  it("states EVERY step in the funnels' own wording, so the join by LABEL is a lookup", () => {
    // The general invariant behind the case above: a step's published label resolves back to its own
    // key, for every one of them. A step whose label drifts off the mirror silently breaks the join
    // for its own funnels and nothing else notices.
    for (const key of CHANNEL_STEP_KEYS) {
      expect(FUNNEL_STEP_LABEL_TO_KEY[CHANNEL_STEPS[key].label]).toBe(key);
    }
    // And every rung of every deployed funnel resolves too — the mirror can never carry a wording this
    // catalogue cannot name, which is what `funnelStepKeys` fails loud on.
    for (const funnelKey of SALES_FUNNEL_KEYS) {
      for (const label of SALES_FUNNELS[funnelKey].steps) {
        expect(FUNNEL_STEP_LABEL_TO_KEY[label], `${funnelKey}: ${label}`).toBeDefined();
      }
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
      "form_filled",
      "paid_client",
    ]);
    expect(matchChannelStepKey("conversation")).toBe("conversation");
    expect(CHANNEL_STEPS.conversation.key).toBe("conversation");
  });
});
