import { describe, expect, it } from "vitest";
import { CONTACT_METHODS, CONTACT_METHODS_BY_CHANNEL, contactMethodsOf } from "./channel-contact-methods.js";
import { CHANNEL_TYPED_SLUGS, OUTBOUND_CHANNEL_SLUGS } from "./channel-types.js";

describe("contact methods: how a one-to-one channel reaches a person (owner 2026-10-12)", () => {
  it("every OUTBOUND channel states at least one method", () => {
    for (const slug of OUTBOUND_CHANNEL_SLUGS) expect(contactMethodsOf(slug)?.length ?? 0).toBeGreaterThan(0);
  });

  it("names only typed features and only known methods", () => {
    for (const [slug, methods] of Object.entries(CONTACT_METHODS_BY_CHANNEL)) {
      expect(CHANNEL_TYPED_SLUGS).toContain(slug);
      for (const m of methods) expect(CONTACT_METHODS).toContain(m);
    }
  });

  it("WhatsApp, SMS and calls need a phone; cold email needs an email", () => {
    expect(contactMethodsOf("cold-whatsapp-outreach")).toEqual(["phone"]);
    expect(contactMethodsOf("cold-sms-outreach")).toEqual(["phone"]);
    expect(contactMethodsOf("cold-call-outreach")).toEqual(["phone"]);
    expect(contactMethodsOf("sales-cold-email-outreach")).toEqual(["email"]);
    expect(contactMethodsOf("sales-crm-email-outreach")).toEqual(["email"]);
    expect(contactMethodsOf("meta-ads")).toBeNull();
  });
});
