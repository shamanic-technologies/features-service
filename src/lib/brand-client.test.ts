/**
 * WHICH OFFER a prefill is grounded in — the wire contract between features-service and
 * brand-service, plus the two refusals that are ANSWERS rather than outages.
 *
 * Every case asserts the DIVERGENCE between naming an offer and naming none, so a suite that only
 * checked "a value came back" would pass on an implementation that dropped the offer on the floor —
 * which is exactly the behaviour this replaces.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

process.env.BRAND_SERVICE_URL = "http://brand:3000";
process.env.BRAND_SERVICE_API_KEY = "brand-key";

const { extractBrandFields, BrandFieldExtractionError } = await import("./brand-client.js");

const FIELDS = [{ key: "industry", description: "The brand's industry" }];
const HEADERS = { orgId: "org-1", userId: "user-1", runId: "run-1", brandId: "brand-1" };
const OFFER_ID = "9f1c2f6e-2a4b-4f0e-9d21-6b0b8a5f2d31";

function mockOnce(status: number, body: unknown) {
  const seen: { url: string; body: any } = { url: "", body: undefined };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    seen.url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    seen.body = JSON.parse((init?.body as string) ?? "{}");
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  return seen;
}

const OK_BODY = { brands: [], fields: { industry: { value: "SaaS", byBrand: {} } } };

describe("extractBrandFields — which offer grounds the extraction", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the offer in the BODY under brand-service's own field name", async () => {
    const seen = mockOnce(200, OK_BODY);

    await extractBrandFields(FIELDS, HEADERS, OFFER_ID);

    expect(seen.url).toBe("http://brand:3000/orgs/brands/extract-fields");
    expect(seen.body.offerId).toBe(OFFER_ID);
    expect(seen.body.fields).toEqual(FIELDS);
  });

  it("OMITS the key entirely when the caller names none — the request is byte-identical to before", async () => {
    const seen = mockOnce(200, OK_BODY);

    await extractBrandFields(FIELDS, HEADERS);

    expect(Object.keys(seen.body)).toEqual(["fields"]);
    expect(seen.body).toEqual({ fields: FIELDS });
  });

  it("treats an explicit null / empty string as naming none, never as a value to send", async () => {
    const seen = mockOnce(200, OK_BODY);
    await extractBrandFields(FIELDS, HEADERS, null);
    expect(seen.body.offerId).toBeUndefined();

    const seen2 = mockOnce(200, OK_BODY);
    await extractBrandFields(FIELDS, HEADERS, "");
    expect(seen2.body.offerId).toBeUndefined();
  });

  it("surfaces the several-offers REFUSAL with its code and the offers it declined to choose between", async () => {
    mockOnce(409, {
      error: "This brand sells several offers; name one.",
      code: "SEVERAL_OFFERS",
      offers: [
        { offerId: "832126f3-0000-4000-8000-000000000001", name: "Product-led" },
        { offerId: "5a2868bb-0000-4000-8000-000000000002", name: "Sales-led" },
      ],
    });

    await expect(extractBrandFields(FIELDS, HEADERS)).rejects.toMatchObject({
      name: "BrandFieldExtractionError",
      status: 409,
      code: "SEVERAL_OFFERS",
      message: "This brand sells several offers; name one.",
      offers: [
        { offerId: "832126f3-0000-4000-8000-000000000001", name: "Product-led" },
        { offerId: "5a2868bb-0000-4000-8000-000000000002", name: "Sales-led" },
      ],
    });
  });

  it("surfaces an unknown offer as a 404 carrying brand-service's own sentence", async () => {
    mockOnce(404, { error: "Offer not found for this brand", code: "OFFER_NOT_FOUND" });

    await expect(extractBrandFields(FIELDS, HEADERS, OFFER_ID)).rejects.toMatchObject({
      status: 404,
      code: "OFFER_NOT_FOUND",
      message: "Offer not found for this brand",
    });
  });

  it("an ordinary failure carries no code and no offers, and keeps the raw text in its message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));

    const error = await extractBrandFields(FIELDS, HEADERS).catch((e) => e);

    expect(error).toBeInstanceOf(BrandFieldExtractionError);
    expect(error.status).toBe(500);
    expect(error.code).toBeNull();
    expect(error.offers).toEqual([]);
    expect(error.message).toContain("brand-service extract-fields failed (500)");
    expect(error.message).toContain("boom");
  });
});
