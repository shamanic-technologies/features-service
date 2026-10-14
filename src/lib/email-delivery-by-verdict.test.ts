import { describe, expect, it } from "vitest";
import { emailDeliveryByVerdictOf, VERDICT_BUCKETS } from "./email-delivery-by-verdict.js";

const fig = (sent: number, bounced: number) => ({ sent, delivered: sent - bounced, bounced, deliveryRate: null, bounceRate: null });

const body = (rows: Array<[string, number, number]>) => ({
  basis: "sequences",
  since: "2026-02-19T01:15:19.000Z",
  sentThrough: "2026-10-14T10:00:00.000Z",
  verificationsSince: "2026-09-25T09:56:21.000Z",
  buckets: rows.map(([verdict, sent, bounced]) => ({ verdict, ...fig(sent, bounced) })),
  bucketsByLatestVerdict: rows.map(([verdict, sent, bounced]) => ({ verdict, ...fig(sent, bounced) })),
  total: fig(rows.reduce((s, r) => s + r[1], 0), rows.reduce((s, r) => s + r[2], 0)),
  sentAfterThrough: 0,
});

const all = (): Array<[string, number, number]> => [
  ["never_verified", 1000, 92],
  ["valid", 1000, 11],
  ["catch_all", 0, 0],
  ["unknown", 0, 0],
  ["invalid", 0, 0],
  ["risky", 0, 0],
  ["no_verdict", 0, 0],
];

describe("email delivery by verdict at send (amarillo-v2 2026-10-14)", () => {
  it("serves every verdict in a fixed order with rates in percent; a zero bucket has null rates", () => {
    const out = emailDeliveryByVerdictOf(body(all()));
    expect(out.byVerdictAtSend?.map((b) => b.verdict)).toEqual([...VERDICT_BUCKETS]);
    expect(out.byVerdictAtSend?.[0]).toEqual({ verdict: "valid", sent: 1000, delivered: 989, bounced: 11, deliveryRatePct: 98.9, bounceRatePct: 1.1 });
    expect(out.byVerdictAtSend?.find((b) => b.verdict === "risky")).toMatchObject({ sent: 0, deliveryRatePct: null, bounceRatePct: null });
    expect(out.total).toEqual({ sent: 2000, delivered: 1897, bounced: 103, deliveryRatePct: 94.85, bounceRatePct: 5.15 });
    expect(out.byLatestVerdict?.map((b) => b.verdict)).toEqual([...VERDICT_BUCKETS]);
    expect(out).toMatchObject({ basis: "sequences", since: "2026-02-19T01:15:19.000Z", unavailableReason: null });
  });

  it("a missing verdict or buckets that do not add up is an error (the caller serves null)", () => {
    expect(() => emailDeliveryByVerdictOf(body(all().slice(1)))).toThrow(/never_verified missing/);
    const b = body(all());
    b.total = fig(1999, 103);
    expect(() => emailDeliveryByVerdictOf(b)).toThrow(/buckets sum/);
  });
});
