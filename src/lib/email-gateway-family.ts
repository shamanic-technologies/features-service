/**
 * A campaign FAMILY (every stored row of one customer campaign — campaign-identity.ts) asked of
 * email-gateway `/orgs/stats` in as few requests as the producer allows.
 *
 * email-gateway takes the family as a LIST since v0.27.2 (`campaignIds`, at most
 * {@link EMAIL_GATEWAY_CAMPAIGN_IDS_PER_REQUEST}) and answers the SUM of the per-row `campaignId=`
 * answers, per group key when grouped — verified in prod on the 47 rows of `f7b1b610…`: 0 differences
 * over 2,203 values against summing the 47 per-row reads (email-gateway-service#216). So a family that
 * used to cost one request per member costs one request, and the figures do not move. If ANY row
 * fails the producer fails the whole read (502), which is the fail-loud a per-member `Promise.all` had.
 *
 * A single campaign keeps the byte-same `campaignId=` request it always made.
 */
export const EMAIL_GATEWAY_CAMPAIGN_IDS_PER_REQUEST = 200;

/**
 * The query-parameter sets to issue for `campaignIds`, one per request: `[{campaignId}]` for a single
 * campaign, `[{campaignIds}]` for a family under the cap, and one chunk per request above it. The
 * caller sums the answers exactly as it summed the per-member ones.
 */
export function campaignFamilyStatsParams(campaignIds: readonly string[]): Array<Record<string, string>> {
  if (campaignIds.length === 0) return [];
  if (campaignIds.length === 1) return [{ campaignId: campaignIds[0] }];
  const out: Array<Record<string, string>> = [];
  for (let i = 0; i < campaignIds.length; i += EMAIL_GATEWAY_CAMPAIGN_IDS_PER_REQUEST) {
    const chunk = campaignIds.slice(i, i + EMAIL_GATEWAY_CAMPAIGN_IDS_PER_REQUEST);
    out.push(chunk.length === 1 ? { campaignId: chunk[0] } : { campaignIds: chunk.join(",") });
  }
  return out;
}
