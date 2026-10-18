import { describe, expect, test } from "bun:test";
import type {
  ApprovalDecision,
  ApprovalRecord,
  RuntimeContext,
  RuntimeContextPort,
  StatelessRunRequest,
  TranscriptEvent,
} from "../src/index.ts";

describe("stateless runtime contracts", () => {
  test("make context and continuation boundaries explicit", async () => {
    const request: StatelessRunRequest = { runId: "run-1", requestId: "request-1", prompt: "hello" };
    const contextPort: RuntimeContextPort = {
      async load(input) {
        const context: RuntimeContext = {
          requestId: input.requestId,
          runId: input.runId,
          principal: input.principal ?? { id: "user-1", kind: "user" },
        };
        return context;
      },
    };
    const event: TranscriptEvent = {
      eventId: "event-1",
      type: "approval.required",
      occurredAt: "2026-01-01T00:00:00.000Z",
      runId: request.runId,
      requestId: request.requestId,
      data: { approvalId: "approval-1" },
    };
    const decision: ApprovalDecision = { approved: true, decidedBy: "user-1" };
    const approval: ApprovalRecord = {
      approvalId: "approval-1",
      callId: "call-1",
      toolId: "danger.write",
      request: { approvalId: "approval-1" },
      status: "approved",
      decidedBy: decision.decidedBy,
      createdAt: event.occurredAt,
      decidedAt: event.occurredAt,
    };

    await expect(contextPort.load({ requestId: request.requestId, runId: request.runId })).resolves.toMatchObject({ runId: "run-1", requestId: "request-1" });
    expect(event.type).toBe("approval.required");
    expect(approval.status).toBe("approved");
  });
});
