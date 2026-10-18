import { describe, expect, test } from "bun:test";
import type {
  AdapterCapabilities,
  EventReplayPort,
  RunEvent,
  RunOutcome,
  RunStore,
  SessionRecord,
  SessionStore,
  SessionTranscriptEntry,
} from "../../subpolar-contracts/src/index.ts";
import { createRunService } from "../src/index.ts";

const context = {
  requestId: "request-run-1",
  principal: { id: "test-user", kind: "local" as const },
  sessionId: "session-run-1",
};

function makeStore(persistent: boolean): SessionStore & { records: Map<string, SessionRecord> } {
  const records = new Map<string, SessionRecord>();
  const capabilities: AdapterCapabilities = {
    adapter: persistent ? "test-durable" : "test-ephemeral",
    durability: persistent ? "json-file" : "ephemeral",
    supports: {
      "session.persistence": persistent,
      "event.replay": false,
      "multi-process-concurrency": false,
      "durable-approvals": false,
    },
  };
  return {
    capabilities,
    records,
    async load(sessionId) {
      return records.get(sessionId);
    },
    async append(sessionId, entries: SessionTranscriptEntry[]) {
      const record = records.get(sessionId) ?? { sessionId, transcript: [], updatedAt: "2026-01-01T00:00:00.000Z" };
      const next = { ...record, transcript: [...record.transcript, ...entries] };
      records.set(sessionId, next);
      return next;
    },
  };
}

function makeRecoveryPorts(persistent = true): {
  runStore: RunStore & { outcomes: RunOutcome[] };
  eventReplayPort: EventReplayPort & { events: RunEvent[] };
} {
  const outcomes: RunOutcome[] = [];
  const events: RunEvent[] = [];
  const capabilities: AdapterCapabilities = {
    adapter: "test-run-durable",
    durability: "json-file",
    supports: {
      "run.outcome.persistence": persistent,
      "event.replay": persistent,
    },
  };
  return {
    runStore: {
      capabilities,
      outcomes,
      async load(runId) {
        return outcomes.find((outcome) => outcome.runId === runId);
      },
      async save(outcome) {
        outcomes.push(outcome);
      },
    },
    eventReplayPort: {
      capabilities,
      events,
      async append(event) {
        events.push(event);
      },
      async replay(runId) {
        return events.filter((event) => event.runId === runId);
      },
    },
  };
}

describe("subpolar-core run service", () => {
  test("completes an idle run through the injected executor", async () => {
    const run = createRunService({ executor: async ({ prompt }) => ({ text: `answer: ${prompt}` }) });

    await expect(run.run({ runId: "run-idle", prompt: "hello", context })).resolves.toMatchObject({
      state: "completed",
      runId: "run-idle",
      output: { text: "answer: hello" },
      resumed: false,
    });
  });

  test("passes cancellation to the executor and returns interrupted", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const run = createRunService({
      executor: ({ signal }) => new Promise((_, reject) => {
        started();
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
    });
    const pending = run.run({ runId: "run-cancel", prompt: "stop", context, signal: controller.signal });
    await startedPromise;
    controller.abort();

    await expect(pending).resolves.toMatchObject({ state: "interrupted", recoverable: false, error: { code: "RUN_INTERRUPTED" } });
  });

  test("emits correlated lifecycle events", async () => {
    const events: RunEvent[] = [];
    const run = createRunService({
      executor: async () => "done",
      eventSink: (event) => { events.push(event); },
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    await run.run({ runId: "run-events", prompt: "hello", context });

    expect(events.map((event) => event.state)).toEqual(["running", "completed"]);
    expect(events.every((event) => event.runId === "run-events" && event.requestId === context.requestId && event.sessionId === context.sessionId)).toBe(true);
  });

  test("only persists messages for a durable session store", async () => {
    const ephemeral = makeStore(false);
    const durable = makeStore(true);
    const request = { runId: "run-session", prompt: "hello", context };

    await createRunService({ executor: async () => ({ text: "reply" }), sessionStore: ephemeral }).run(request);
    const durableResult = await createRunService({ executor: async () => ({ text: "reply" }), sessionStore: durable }).run(request);

    expect(ephemeral.records.size).toBe(0);
    expect(durable.records.get(context.sessionId)?.transcript.map((entry) => entry.role)).toEqual(["user", "assistant"]);
    expect(durableResult.resumed).toBe(false);
    expect(durableResult.recoverable).toBe(false);
    await expect(createRunService({ executor: async () => "again", sessionStore: durable }).run({ ...request, runId: "run-session-2" })).resolves.toMatchObject({ resumed: true });
  });

  test("returns a sanitized executor failure", async () => {
    const run = createRunService({ executor: async () => { throw new Error("provider token=secret"); } });

    const result = await run.run({ runId: "run-failure", prompt: "hello", context });

    expect(result).toMatchObject({ state: "failed", error: { code: "EXECUTION_FAILED", message: "Agent execution failed" } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("returns unknown when cancellation settles without durable recovery", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const run = createRunService({ executor: () => new Promise((resolve) => { started(); release = () => resolve("late result"); }) });
    const pending = run.run({ runId: "run-unknown", prompt: "hello", context, signal: controller.signal });
    await startedPromise;
    controller.abort();
    release();

    await expect(pending).resolves.toMatchObject({ state: "unknown", recoverable: false, error: { code: "UNSUPPORTED_RECOVERY" } });
  });

  test("makes a result recoverable only with a durable outcome and replay port", async () => {
    const ports = makeRecoveryPorts();
    const events: RunEvent[] = [];
    const result = await createRunService({
      executor: async () => "done",
      runStore: ports.runStore,
      eventReplayPort: ports.eventReplayPort,
      eventSink: (event) => { events.push(event); },
    }).run({ runId: "run-durable", prompt: "hello", context });

    expect(result).toMatchObject({ state: "completed", recoverable: true });
    expect(ports.runStore.outcomes).toMatchObject([{ runId: "run-durable", state: "completed", recoverable: true }]);
    expect(ports.eventReplayPort.events.map((event) => event.eventId)).toEqual(["event-run-durable-1", "event-run-durable-2"]);
    expect(events.every((event) => event.runId === "run-durable" && event.requestId === context.requestId && event.sessionId === context.sessionId)).toBe(true);
  });

  test("persists an interrupted outcome when cancellation follows executor completion", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const ports = makeRecoveryPorts();
    const run = createRunService({
      executor: () => new Promise((resolve) => { started(); release = () => resolve("late result"); }),
      runStore: ports.runStore,
      eventReplayPort: ports.eventReplayPort,
    });
    const pending = run.run({ runId: "run-durable-cancel", prompt: "hello", context, signal: controller.signal });
    await startedPromise;
    controller.abort();
    release();

    await expect(pending).resolves.toMatchObject({ state: "interrupted", recoverable: true });
    expect(ports.runStore.outcomes).toMatchObject([{ runId: "run-durable-cancel", state: "interrupted", recoverable: true }]);
  });

  test("does not persist cancellation metadata through an unsupported run store", async () => {
    const ports = makeRecoveryPorts(false);
    const controller = new AbortController();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const resultPromise = createRunService({
      executor: () => new Promise((resolve) => { started(); release = () => resolve("late"); }),
      runStore: ports.runStore,
      eventReplayPort: ports.eventReplayPort,
    }).run({
      runId: "run-unsupported-store",
      prompt: "hello",
      context,
      signal: controller.signal,
    });
    await startedPromise;
    controller.abort();
    release();

    await expect(resultPromise).resolves.toMatchObject({ state: "unknown", recoverable: false });
    expect(ports.runStore.outcomes).toHaveLength(0);
  });
});
