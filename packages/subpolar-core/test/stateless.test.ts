import { describe, expect, test } from "bun:test";
import type {
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalRecord,
  ApprovalRequest,
  EventReplayPort,
  IdempotencyPort,
  RunEvent,
  RunOutcome,
  RunStore,
  RuntimeContext,
  RuntimeContextPort,
  StatelessRunRequest,
} from "../../subpolar-contracts/src/index.ts";
import { createPolicyGateway, createStatelessSubpolarRuntime } from "../src/index.ts";

const request: StatelessRunRequest = {
  runId: "run-stateless",
  requestId: "request-stateless",
  sessionId: "session-stateless",
  prompt: "hello",
};

const context: RuntimeContext = {
  runId: request.runId,
  requestId: request.requestId,
  sessionId: request.sessionId,
  principal: { id: "user-stateless", kind: "user" },
};

const capabilities: AdapterCapabilities = {
  adapter: "test-durable",
  durability: "remote",
  supports: {
    "run.outcome.persistence": true,
    "event.replay": true,
    "durable-approvals": true,
    idempotency: true,
  },
};

function makeContextPort(calls: RuntimeContext[] = []): RuntimeContextPort {
  return {
    async load(input) {
      calls.push(context);
      return { ...context, runId: input.runId, requestId: input.requestId };
    },
  };
}

function makeRecoveryPorts() {
  const outcomes = new Map<string, RunOutcome>();
  const events: RunEvent[] = [];
  const runStore: RunStore = {
    capabilities,
    async load(runId) { return outcomes.get(runId); },
    async save(outcome) { outcomes.set(outcome.runId, outcome); },
  };
  const eventReplayPort: EventReplayPort = {
    capabilities,
    async append(event) { events.push(event); },
    async replay(runId) { return events.filter((event) => event.runId === runId); },
  };
  return { runStore, eventReplayPort, outcomes, events };
}

function makeIdempotency(): IdempotencyPort {
  const values = new Map<string, unknown>();
  return {
    async execute<T>(key: string, operation: () => Promise<T>): Promise<T> {
      if (values.has(key)) return values.get(key) as T;
      const value = await operation();
      values.set(key, value);
      return value;
    },
  };
}

function makeApprovalStore() {
  const records = new Map<string, ApprovalRecord>();
  const store = {
    async load(approvalId: string) { return records.get(approvalId); },
    async create(input: ApprovalRequest) {
      const record: ApprovalRecord = {
        approvalId: input.approvalId,
        callId: input.call.callId,
        toolId: input.call.toolId,
        runId: input.call.runId,
        request: { approvalId: input.approvalId, callId: input.call.callId, toolId: input.call.toolId },
        status: "pending" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      records.set(record.approvalId, record);
      return record;
    },
    async decide(approvalId: string, decision: ApprovalDecision) {
      const current = records.get(approvalId);
      if (!current) throw new Error("approval not found");
      const next: ApprovalRecord = {
        ...current,
        status: decision.approved ? "approved" : "denied",
        ...(decision.decidedBy === undefined ? {} : { decidedBy: decision.decidedBy }),
        ...(!decision.approved && decision.reason === undefined ? {} : { reason: decision.approved ? undefined : decision.reason }),
        decidedAt: "2026-01-01T00:01:00.000Z",
      };
      records.set(approvalId, next);
      return next;
    },
  };
  return { records, store };
}

describe("StatelessSubpolarRuntime", () => {
  const gateway = () => createPolicyGateway({ tools: [], resolvePolicy: () => ({ deny: true }), execute: async () => ({ ok: true, value: null }) });

  test("does not claim recoverability without both successfully written durable ports", async () => {
    for (const failure of ["missing-replay", "save", "append"] as const) {
      const ports = makeRecoveryPorts();
      if (failure === "save") ports.runStore.save = async () => { throw new Error("offline"); };
      if (failure === "append") ports.eventReplayPort.append = async () => { throw new Error("offline"); };
      const runtime = createStatelessSubpolarRuntime({ context: makeContextPort(), gateway: gateway(), executor: () => null, runStore: ports.runStore, eventReplayPort: failure === "missing-replay" ? undefined : ports.eventReplayPort });
      expect(await runtime.run(request)).toMatchObject({ state: "completed", output: null, recoverable: false });
    }
  });

  test("replays a terminal outcome without re-executing but does not overclaim absent replay", async () => {
    const ports = makeRecoveryPorts();
    let executions = 0;
    const options = { context: makeContextPort(), gateway: gateway(), executor: () => { executions++; return "done"; }, ...ports };
    expect(await createStatelessSubpolarRuntime(options).run(request)).toMatchObject({ recoverable: true });
    expect(await createStatelessSubpolarRuntime({ ...options, eventReplayPort: undefined }).run(request)).toMatchObject({ resumed: true, recoverable: false, output: "done" });
    expect(executions).toBe(1);
  });

  test("classifies cancellation rejection as interrupted without exposing executor secrets", async () => {
    const controller = new AbortController();
    const events: RunEvent[] = [];
    const runtime = createStatelessSubpolarRuntime({ context: makeContextPort(), gateway: gateway(), executor: () => { controller.abort(); throw new Error("token=secret"); }, eventSink: (event) => { events.push(event); } });
    expect(await runtime.run({ ...request, signal: controller.signal })).toMatchObject({ state: "interrupted", error: { code: "RUN_INTERRUPTED" }, recoverable: false });
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.interrupted"]);
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  test("does not claim a known cancellation outcome if executor settles after abort without recovery", async () => {
    const controller = new AbortController();
    const runtime = createStatelessSubpolarRuntime({ context: makeContextPort(), gateway: gateway(), executor: () => { controller.abort(); return { ok: false, status: "approval_required", approvalId: "late-approval" }; } });
    expect(await runtime.run({ ...request, signal: controller.signal })).toMatchObject({ state: "unknown", error: { code: "UNSUPPORTED_RECOVERY" }, recoverable: false });
  });

  test("pre-cancellation does not invoke executor", async () => {
    const controller = new AbortController();
    controller.abort();
    let executions = 0;
    const runtime = createStatelessSubpolarRuntime({ context: makeContextPort(), gateway: gateway(), executor: () => { executions++; } });
    expect(await runtime.run({ ...request, signal: controller.signal })).toMatchObject({ state: "interrupted", recoverable: false });
    expect(executions).toBe(0);
  });
  test("loads context and emits a durable lifecycle on each run", async () => {
    const contextLoads: RuntimeContext[] = [];
    const ports = makeRecoveryPorts();
    const runtime = createStatelessSubpolarRuntime({
      context: makeContextPort(contextLoads),
      gateway: createPolicyGateway({ tools: [], validateInput: () => ({ valid: true }), resolvePolicy: () => ({ allow: true }), execute: async () => ({ ok: true, value: null }) }),
      execute: async ({ emit }) => {
        await emit({ kind: "progress" });
        return { text: "done" };
      },
      ...ports,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await runtime.run(request);

    expect(result).toMatchObject({ state: "completed", output: { text: "done" }, recoverable: true });
    expect(contextLoads).toHaveLength(1);
    expect(ports.events.map((event) => event.type)).toEqual(["run.started", "run.progress", "run.completed"]);
    expect(ports.outcomes.get(request.runId)?.recoverable).toBe(true);
  });

  test("returns approval-required without a local continuation and resumes from durable approval", async () => {
    const approvals = makeApprovalStore();
    const idempotency = makeIdempotency();
    const tools = [{ id: "danger.write", namespace: "danger", description: "Write", inputSchema: {}, enabled: true, risk: "high" as const }];
    let executions = 0;
    const createRuntime = () => createStatelessSubpolarRuntime({
      context: makeContextPort(),
      approvals: approvals.store,
      gateway: createPolicyGateway({
        tools,
        validateInput: () => ({ valid: true }),
        resolvePolicy: () => ({ requiresApproval: true }),
        approvalStore: approvals.store,
        idempotency,
        execute: async () => { executions += 1; return { ok: true, value: "written" }; },
      }),
      execute: async ({ tools: toolInvoker }) => toolInvoker.call({ callId: "call-restart-safe", toolId: "danger.write", input: { value: 1 } }),
    });

    const first = await createRuntime().run(request);
    expect(first).toMatchObject({ state: "approval_required", approvalId: "approval-call-restart-safe", error: { code: "APPROVAL_REQUIRED" } });
    expect(executions).toBe(0);

    await createRuntime().decideApproval("approval-call-restart-safe", { approved: true, decidedBy: "user-stateless" });
    const second = await createRuntime().run(request);

    expect(second).toMatchObject({ state: "completed", output: { ok: true, status: "executed", value: "written" } });
    expect(executions).toBe(1);
  });
});
