import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * GET /internal/writer-pick?campaignId= — WRITER-PICK-NO-WORKFLOW-1105 (owner 2026-11-05, « IL FAUT MIGRER »).
 *
 * An Engine run executes a stored script, no workflow: it knows only its campaign. The pick it gets must be the SAME
 * template dynasty + LLM a workflow run on that campaign's pipe gets today. Driven through the real route and the real
 * ranking read (`pickPipeWriters`, `servedRankings`); only the stores and the remote reads are mocked.
 */

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const cells = new Map<string, string>();
vi.mock("../lib/fleet-cell-store.js", () => ({
  loadFleetCell: async (key: string) => (cells.has(key) ? { text: cells.get(key)!, computedAt: Date.now() } : null),
  storeFleetCell: async () => undefined,
}));
vi.mock("../lib/plays-store.js", async () => {
  const { buildPlayCatalogue } = await import("../lib/plays.js");
  return { loadPlayCatalogue: async () => buildPlayCatalogue({ tactics: [], strategies: [], plays: [], verdicts: [] }) };
});
const playCalls: Array<[string, string, string | null]> = [];
vi.mock("./workflow-projection.js", () => ({
  playOfLegRead: async (featureSlug: string, legKey: string, salesFunnelId: string | null) => {
    playCalls.push([featureSlug, legKey, salesFunnelId]);
    return null;
  },
}));
vi.mock("../lib/workflow-leg-assignments.js", () => ({
  listLegAssignments: async () => [
    { state: "active", featureSlug: "threads-post", legKey: "start_to_post_published", workflowDynastySlug: "threads-post-maasym" },
    { state: "active", featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", workflowDynastySlug: "sales-cold-email-outreach-ballad" },
  ],
}));
vi.mock("../lib/public-stats-clients.js", async (orig) => ({
  ...(await orig<typeof import("../lib/public-stats-clients.js")>()),
  fetchPublicWorkflows: async (featureSlug: string) =>
    featureSlug === "threads-post"
      ? [{ workflowSlug: "threads-post-maasym-v3", workflowDynastySlug: "threads-post-maasym" }]
      : [{ workflowSlug: "sales-cold-email-outreach-ballad-v7", workflowDynastySlug: "sales-cold-email-outreach-ballad" }],
}));
let vendorCredit: string[] = [];
const campaigns: unknown[] = [
  { id: "c-threads", orgId: "f0420eb5", featureSlug: "threads-post", legKey: "start_to_post_published", salesFunnelId: null, workflowSlug: "threads-post-maasym" },
  // The legacy outbound spelling on the campaign row, the served one on the assignment: one pipe.
  { id: "c-cold", orgId: "o2", featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation", salesFunnelId: "sf-1" },
  { id: "c-no-leg", orgId: "o3", featureSlug: "threads-post", legKey: null },
];
vi.mock("../lib/fetch-retry.js", async (orig) => ({
  ...(await orig<typeof import("../lib/fetch-retry.js")>()),
  fetchWithRetry: async (url: string) => {
    if (String(url).includes("/internal/vendor-credit")) return new Response(JSON.stringify({ vendors: vendorCredit.map((provider) => ({ provider, outOfCredit: true })) }), { status: 200 });
    if (!String(url).endsWith("/campaigns/list")) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify({ campaigns }), { status: 200 });
  },
}));

import router from "./leg-writer-ranking.js";
import { llmCandidates, templateCandidates, type LegWriterRankingPayload } from "./leg-writer-ranking.js";
import type { TemplateDynasty } from "../lib/research/template-dynasties.js";
import { __resetCampaignListShareForTest } from "../lib/fleet-leg-campaigns.js";
import { __resetVendorCreditForTest } from "../lib/vendor-credit-client.js";

const dynasty = (slug: string): TemplateDynasty => ({ slug, name: slug.toUpperCase(), description: "", signature: null, identity: "", head: `${slug}-v2`, versions: [`${slug}-v1`, `${slug}-v2`], status: "active", statusSource: "content_generation", versionStatuses: {} });

function payload(featureSlug: string, legKey: string, pipeId: string): LegWriterRankingPayload {
  return {
    featureSlug,
    legKey,
    pipeId,
    computedAt: "2026-11-05T00:00:00Z",
    costBasis: "incurred",
    rankBasis: "cost_per_outcome",
    maturity: { durationDays: 21, outcomesRequired: 1, cutoffIso: "2026-10-15T00:00:00Z" },
    writerEvidence: "measured",
    templates: { candidates: templateCandidates([{ key: "ideas", label: "Ideas", basis: "mature", figures: { spentUsd: 40, contacted: 400, outcomes: 8 } }], [dynasty("ideas"), dynasty("story")]), unavailableReason: null },
    llms: {
      candidates: llmCandidates(
        [
          { key: "kimi-k2", label: "Kimi K2", basis: "mature", figures: { spentUsd: 10, contacted: 400, outcomes: 8 } },
          { key: "claude-opus-5.5", label: "Claude Opus 5.5", basis: "mature", figures: { spentUsd: 40, contacted: 400, outcomes: 8 } },
        ],
        [
          { alias: "kimi-k2", provider: "moonshot", status: "active" },
          { alias: "opus", provider: "anthropic", status: "active" },
        ],
        [
          { modelId: "kimi-k2", displayName: "Kimi K2", aliases: ["kimi-k2"], formerAliases: [], provider: "moonshot", capabilityTier: "pro" },
          { modelId: "claude-opus-5-5", displayName: "Claude Opus 5.5", aliases: ["opus"], formerAliases: [], provider: "anthropic", capabilityTier: "pro" },
        ],
      ),
      unavailableReason: null,
    },
    leftOut: { templates: { contacted: 0, outcomes: 0 }, llms: { contacted: 0, outcomes: 0 } },
  };
}

process.env.FEATURES_SERVICE_API_KEY = "k";
process.env.CAMPAIGN_SERVICE_URL = "http://campaign";
process.env.CAMPAIGN_SERVICE_API_KEY = "ck";
process.env.CHAT_SERVICE_URL = "http://chat";
const app = express().use(router);
const pick = (q: string) => request(app).get(`/internal/writer-pick?${q}`).set("x-api-key", "k");

beforeEach(() => {
  __resetCampaignListShareForTest();
  __resetVendorCreditForTest();
  vendorCredit = [];
  playCalls.length = 0;
  cells.set("leg-writer-ranking:threads-post|start_to_post_published", JSON.stringify(payload("threads-post", "start_to_post_published", "threads-post|start_to_post_published")));
  cells.set(
    "leg-writer-ranking:sales-cold-email-outreach|start_to_conversation",
    JSON.stringify(payload("sales-cold-email-outreach", "start_to_conversation", "sales-cold-email-outreach|lead_found_to_conversation")),
  );
});

describe("GET /internal/writer-pick with only a campaign (an Engine run, no workflow)", () => {
  it("answers the template dynasty + LLM the campaign's workflow gets (threads-post, org f0420eb5)", async () => {
    const byWorkflow = await pick("workflowSlug=threads-post-maasym-v3&campaignId=c-threads");
    const byCampaign = await pick("campaignId=c-threads");
    expect(byWorkflow.status).toBe(200);
    expect(byCampaign.status).toBe(200);
    expect(byCampaign.body.template).not.toBeNull();
    expect(byCampaign.body.llm).not.toBeNull();
    expect(byCampaign.body.template).toEqual(byWorkflow.body.template);
    expect(byCampaign.body.llm).toEqual(byWorkflow.body.llm);
    expect(byCampaign.body.pipeId).toBe(byWorkflow.body.pipeId);
    expect(byCampaign.body).toMatchObject({ workflowSlug: null, workflowDynastySlug: null, campaignId: "c-threads", featureSlug: "threads-post" });
  });

  it("reads the campaign's play and its leg in either spelling: same pick as its workflow on the same pipe", async () => {
    const byWorkflow = await pick("workflowSlug=sales-cold-email-outreach-ballad-v7&campaignId=c-cold");
    const byCampaign = await pick("campaignId=c-cold");
    expect(byCampaign.status).toBe(200);
    expect(byCampaign.body.template).toEqual(byWorkflow.body.template);
    expect(byCampaign.body.llm).toEqual(byWorkflow.body.llm);
    expect(playCalls.map((c) => c[2])).toEqual(["sf-1", "sf-1"]);
  });

  it("keeps the workflow answer's keys exactly as before (no campaignId key, workflow first)", async () => {
    const byWorkflow = await pick("workflowSlug=threads-post-maasym-v3");
    expect(Object.keys(byWorkflow.body)).toEqual([
      "workflowSlug",
      "workflowDynastySlug",
      "featureSlug",
      "legKey",
      "pipeId",
      "strategyId",
      "computedAt",
      "template",
      "templateUnavailableReason",
      "llm",
      "llmUnavailableReason",
    ]);
  });

  it("names the refusal when the campaign cannot be resolved", async () => {
    const unknown = await pick("campaignId=c-nope");
    expect(unknown.status).toBe(404);
    expect(unknown.body.reason).toBe("campaign_not_found");
    const noLeg = await pick("campaignId=c-no-leg");
    expect(noLeg.status).toBe(422);
    expect(noLeg.body.reason).toBe("campaign_states_no_pipe");
    const neither = await pick("");
    expect(neither.status).toBe(400);
    expect(neither.body.reason).toBe("workflow_slug_or_campaign_id_required");
  });
});

describe("GET /internal/writer-pick never answers an LLM whose vendor chat-service states out of credit (WRITER-PICK-VENDOR-CREDIT-1105)", () => {
  it("answers rank 1 while its vendor has credit, the next ranked LLM once chat-service states it out of credit", async () => {
    const healthy = await pick("campaignId=c-threads");
    expect(healthy.body.llm.model).toBe("kimi-k2");
    __resetVendorCreditForTest();
    vendorCredit = ["moonshot"];
    for (const q of ["campaignId=c-threads", "workflowSlug=threads-post-maasym-v3"]) {
      const out = await pick(q);
      expect(out.status).toBe(200);
      expect(out.body.llm).toMatchObject({ model: "opus", provider: "anthropic" });
      expect(out.body.llmUnavailableReason).toBeNull();
    }
  });

  it("no LLM left = the named refusal, never a default writer", async () => {
    vendorCredit = ["moonshot", "anthropic"];
    const none = await pick("campaignId=c-threads");
    expect(none.status).toBe(200);
    expect(none.body.llm).toBeNull();
    expect(none.body.llmUnavailableReason).toBe("no_selectable_candidate");
    expect(none.body.template).not.toBeNull();
  });
});
