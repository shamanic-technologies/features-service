import { describe, expect, it } from "vitest";
import { modelsBilled, writerRunOf, type LedgerOccurrence } from "./message-writer-model.js";

const ORG = "8bfec2f4-6184-40b7-b1aa-c8933d506a87";
const occ = (o: Partial<LedgerOccurrence> & Pick<LedgerOccurrence, "runId" | "direction" | "outcomeKey" | "declaredAt">): LedgerOccurrence => ({
  id: `${o.runId}-${o.direction}-${o.outcomeKey}`,
  organizationId: ORG,
  consumption: null,
  ...o,
});

// Prod 2026-11-24, Living Vital, lead bb5d832e: the first email's ledger (trimmed).
const SEND = "a1a87927-0e03-438e-9c7d-93194a55ea51";
const WRITER = "b1c7d6e1-9707-4989-b293-7a66215c7261";
const LEDGER: LedgerOccurrence[] = [
  occ({ runId: WRITER, direction: "produced", outcomeKey: "message_written", declaredAt: "2026-11-24T02:38:33.753Z" }),
  occ({ runId: SEND, direction: "produced", outcomeKey: "email_queued", declaredAt: "2026-11-24T02:38:34.280Z" }),
  occ({ runId: SEND, direction: "produced", outcomeKey: "message_sent", declaredAt: "2026-11-24T06:09:34.819Z" }),
  occ({ runId: SEND, direction: "consumed", outcomeKey: "message_written", declaredAt: "2026-11-24T06:09:34.819Z", consumption: { sourceRunId: WRITER, provenance: "known" } }),
  occ({ runId: SEND, direction: "consumed", outcomeKey: "email_checked", declaredAt: "2026-11-24T06:09:34.819Z", consumption: { sourceRunId: "e7e0b616", provenance: "known" } }),
];

describe("writerRunOf (MODEL-TAG-EVERY-AI-MESSAGE-1126)", () => {
  it("finds the send declared at the message's own instant, then the run that wrote what it sent", () => {
    expect(writerRunOf({ sentAt: "2026-11-24T06:09:34.819Z", statedRunId: null }, LEDGER)).toEqual({ runId: WRITER, sentByOurRun: true, reason: null });
  });

  it("never a nearest time: one millisecond off is no send", () => {
    expect(writerRunOf({ sentAt: "2026-11-24T06:09:34.820Z", statedRunId: null }, LEDGER)).toEqual({ runId: null, sentByOurRun: false, reason: "no_send_in_ledger" });
  });

  it("the run lead-service names wins when it declared the send", () => {
    expect(writerRunOf({ sentAt: "2026-11-25T00:00:00.000Z", statedRunId: SEND }, LEDGER)).toMatchObject({ runId: WRITER, sentByOurRun: true });
  });

  it("no send in the ledger: the run lead-service states wrote it (workflow era)", () => {
    expect(writerRunOf({ sentAt: "2026-10-01T00:00:00.000Z", statedRunId: "wf-run" }, LEDGER)).toEqual({ runId: "wf-run", sentByOurRun: false, reason: null });
  });

  it("two runs at the instant are ambiguous; a send consuming no writing, or two, is named", () => {
    const two = [...LEDGER, occ({ runId: "other", direction: "produced", outcomeKey: "message_sent", declaredAt: "2026-11-24T06:09:34.819Z" })];
    expect(writerRunOf({ sentAt: "2026-11-24T06:09:34.819Z", statedRunId: null }, two).reason).toBe("send_ambiguous_in_ledger");
    const noWriting = LEDGER.filter((o) => !(o.direction === "consumed" && o.outcomeKey === "message_written"));
    expect(writerRunOf({ sentAt: "2026-11-24T06:09:34.819Z", statedRunId: null }, noWriting)).toEqual({ runId: null, sentByOurRun: true, reason: "no_writing_in_ledger" });
    const twoWritings = [...LEDGER, occ({ id: "x", runId: SEND, direction: "consumed", outcomeKey: "message_written", declaredAt: "2026-11-24T06:09:34.819Z", consumption: { sourceRunId: "w2", provenance: "known" } })];
    expect(writerRunOf({ sentAt: "2026-11-24T06:09:34.819Z", statedRunId: null }, twoWritings).reason).toBe("several_writings_in_ledger");
  });

  it("a reversed send is no send; an unreadable ledger is named", () => {
    const reversed = LEDGER.map((o) => (o.outcomeKey === "message_sent" ? { ...o, reversal: { reason: "x" } } : o));
    expect(writerRunOf({ sentAt: "2026-11-24T06:09:34.819Z", statedRunId: null }, reversed).reason).toBe("no_send_in_ledger");
    expect(writerRunOf({ sentAt: "2026-11-24T06:09:34.819Z", statedRunId: null }, null).reason).toBe("ledger_unreadable");
  });
});

describe("modelsBilled", () => {
  const catalogue = new Map([
    ["zai-glm-5.3-flash-tokens-input", ["glm-5.3-flash"]],
    ["zai-glm-5.3-flash-tokens-output", ["glm-5.3-flash"]],
    ["deepseek-v4.1-flash-tokens-input", ["deepseek-flash"]],
  ]);
  it("the fallback that billed is the model, a cancelled hold is no bill (prod: DeepSeek Flash asked, GLM 5.3 Flash billed)", () => {
    expect(
      modelsBilled(
        [
          { costName: "zai-glm-5.3-flash-tokens-output", status: "actual", createdAt: "2026-11-24T02:38:33.423Z" },
          { costName: "zai-glm-5.3-flash-tokens-input", status: "actual", createdAt: "2026-11-24T02:38:33.423Z" },
          { costName: "deepseek-v4.1-flash-tokens-input", status: "cancelled", createdAt: "2026-11-24T02:38:23.342Z" },
          { costName: "treg-micro-usd", status: "actual", createdAt: "2026-11-24T02:38:40.000Z" },
        ],
        catalogue,
      ),
    ).toEqual([["glm-5.3-flash"]]);
  });
  it("several models billed: the one billed last first", () => {
    expect(
      modelsBilled(
        [
          { costName: "deepseek-v4.1-flash-tokens-input", status: "actual", createdAt: "2026-11-24T02:00:00.000Z" },
          { costName: "zai-glm-5.3-flash-tokens-input", status: "actual", createdAt: "2026-11-24T02:01:00.000Z" },
        ],
        catalogue,
      ),
    ).toEqual([["glm-5.3-flash"], ["deepseek-flash"]]);
    expect(modelsBilled([], catalogue)).toEqual([]);
  });
});
