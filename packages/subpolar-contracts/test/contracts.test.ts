import { describe, expect, test } from "bun:test";
import type {
  ApprovalClaimRepository,
  CanonicalTranscriptEntry,
  CanonicalTranscriptRepository,
  CallIdempotencyRepository,
  OpaqueContinuation,
  RunEventRepository,
  RunRepository,
  ToolDefinitionRepository,
  ToolPolicyRepository,
} from "../src/index.ts";
import { UnsupportedCapabilityError, UnsupportedRecoveryError } from "../src/index.ts";

describe("subpolar contracts", () => {
  test("exposes shared durable repository contracts", () => {
    const entry: CanonicalTranscriptEntry = {
      role: "tool",
      toolResult: { ok: true },
      occurredAt: "2026-01-01T00:00:00.000Z",
    };
    const transcript: CanonicalTranscriptRepository = {
      async append() { return []; },
      async list() { return []; },
      async get() { return undefined; },
    };
    const runs: RunRepository = { async load() { return undefined; }, async list() { return []; }, async save(_owner, outcome) { return { ...outcome, id: "run-record", ownerId: "owner-1" }; } };
    const events: RunEventRepository = { async append(_owner, event) { return event; }, async replay() { return []; } };
    const tools: ToolDefinitionRepository = { async create() { throw new Error("fixture"); }, async get() { return undefined; }, async list() { return []; }, async update() { throw new Error("fixture"); } };
    const policies: ToolPolicyRepository = { async save() { throw new Error("fixture"); }, async get() { return undefined; }, async list() { return []; } };
    const claims: ApprovalClaimRepository = { async claim() { return { ownerId: "owner-1", approvalId: "approval-1", callId: "call-1", claimed: true, claimedAt: entry.occurredAt, claimToken: "claim-1" }; } };
    const callIds: CallIdempotencyRepository = { async execute(_owner, _call, operation) { return operation(); } };
    const continuation: OpaqueContinuation = { payload: "opaque", requestHash: "hash", expiresAt: "2026-01-02T00:00:00.000Z" };

    expect(entry.role).toBe("tool");
    expect([transcript, runs, events, tools, policies, claims, callIds, continuation]).toHaveLength(8);
  });

  test("exposes a typed unsupported capability error", () => {
    const error = new UnsupportedCapabilityError("session.persistence", "ephemeral-local");

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("UNSUPPORTED_CAPABILITY");
    expect(error.capability).toBe("session.persistence");
    expect(error.adapter).toBe("ephemeral-local");
  });

  test("exposes an explicit unsupported recovery error", () => {
    const error = new UnsupportedRecoveryError("ephemeral-local");

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("UNSUPPORTED_RECOVERY");
    expect(error.adapter).toBe("ephemeral-local");
  });
});
