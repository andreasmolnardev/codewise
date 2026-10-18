import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";

import { assert, it } from "@effect/vitest";

import { makeInMemoryStdio } from "../../effect-acp/src/_internal/stdio.ts";
import { layer } from "../src/index.ts";

const encoder = new TextEncoder();

const send = (input: Queue.Queue<Uint8Array, Cause.Done<void>>, message: unknown) =>
  Queue.offer(input, encoder.encode(`${JSON.stringify(message)}\n`));

const readJsonLine = (output: Queue.Queue<string>): Effect.Effect<Record<string, unknown>> =>
  Effect.gen(function* () {
    let line = "";
    while (!line.includes("\n")) line += yield* Queue.take(output);
    return JSON.parse(line.slice(0, line.indexOf("\n"))) as Record<string, unknown>;
  });

const readResponse = (output: Queue.Queue<string>, id: number) =>
  Effect.gen(function* () {
    while (true) {
      const message = yield* readJsonLine(output);
      if (message.id === id) return message;
    }
  });

const request = (id: number, method: string, params: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

const initialize = request(1, "initialize", {
  protocolVersion: 2,
  info: { name: "subpolar-acp-test", version: "1.0" },
  capabilities: {},
});

it.effect("runs a prompt through an injected Pi executor and keeps the ACP session ephemeral", () =>
  Effect.gen(function* () {
    const { stdio, input, output } = yield* makeInMemoryStdio();
    const scope = yield* Scope.make();
    const seen: Array<{ cwd: string | undefined; sessionId: string | undefined }> = [];
    let markExecuted!: () => void;
    const executorExecuted = new Promise<void>((resolve) => { markExecuted = resolve; });
    yield* Layer.buildWithScope(layer(stdio, {
      executorFactory: async (_config, execution) => ({
        async execute(request) {
          seen.push({ cwd: request.context.cwd, sessionId: request.context.sessionId });
          markExecuted();
          await execution?.emit({ type: "text", data: { text: "hello" } });
          return "hello";
        },
      }),
    }), scope);

    yield* send(input, initialize);
    const initialized = yield* readJsonLine(output);
    assert.equal((initialized.result as { info: { name: string } }).info.name, "subpolar");

    yield* send(input, request(2, "session/new", { cwd: "/tmp/subpolar-acp-test" }));
    const created = yield* readJsonLine(output);
    const sessionId = (created.result as { sessionId: string }).sessionId;
    assert.match(sessionId, /^subpolar-/);

    yield* send(input, request(3, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hello" }],
    }));
    const promptResponse = yield* readResponse(output, 3);
    yield* Effect.promise(() => executorExecuted);
    assert.equal(promptResponse.id, 3);
    assert.deepEqual(seen, [{ cwd: "/tmp/subpolar-acp-test", sessionId }]);

    yield* Scope.close(scope, Exit.void);
  }),
);
it.effect("forwards ACP cancellation to the transient Pi executor", () =>
  Effect.gen(function* () {
    const { stdio, input, output } = yield* makeInMemoryStdio();
    const scope = yield* Scope.make();
    let markStarted!: () => void;
    const executorStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    let aborted = false;
    yield* Layer.buildWithScope(layer(stdio, {
      executorFactory: async () => ({
        execute: (execution) => new Promise((resolve) => {
          markStarted();
          if (execution.signal?.aborted) {
            aborted = true;
            resolve("cancelled");
            return;
          }
          execution.signal?.addEventListener("abort", () => {
            aborted = true;
            resolve("cancelled");
          }, { once: true });
        }),
      }),
    }), scope);

    yield* send(input, initialize);
    yield* readJsonLine(output);
    yield* send(input, request(2, "session/new", { cwd: "/tmp/subpolar-acp-test" }));
    const created = yield* readJsonLine(output);
    const sessionId = (created.result as { sessionId: string }).sessionId;
    yield* send(input, request(3, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "wait" }],
    }));
    yield* readResponse(output, 3);
    yield* Effect.promise(() => executorStarted);
    yield* send(input, { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });

    let cancelled = false;
    while (!cancelled) {
      const message = yield* readJsonLine(output);
      const update = (message.params as { update?: { state?: string; stopReason?: string } } | undefined)?.update;
      cancelled = update?.state === "idle" && update.stopReason === "cancelled";
    }
    assert.equal(aborted, true);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("reports an unavailable Pi SDK as an explicit ACP session error", () =>
  Effect.gen(function* () {
    const { stdio, input, output } = yield* makeInMemoryStdio();
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(layer(stdio, {
      loadPiSdk: async () => { throw new Error("test SDK missing"); },
    }), scope);

    yield* send(input, initialize);
    yield* readResponse(output, 1);
    yield* send(input, request(2, "session/new", { cwd: "/tmp/subpolar-acp-test" }));
    const created = yield* readResponse(output, 2);
    const sessionId = (created.result as { sessionId: string }).sessionId;
    yield* send(input, request(3, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hello" }],
    }));
    yield* readResponse(output, 3);

    let errorReported = false;
    while (!errorReported) {
      const message = yield* readJsonLine(output);
      const update = message.params as { update?: { content?: Array<{ text?: string }> } } | undefined;
      errorReported = update?.update?.content?.some((block) => block.text?.includes("test SDK missing")) ?? false;
    }
    assert.equal(errorReported, true);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("routes Subpolar tool calls through T3's exact-call ACP permission request", () =>
  Effect.gen(function* () {
    const { stdio, input, output } = yield* makeInMemoryStdio();
    const scope = yield* Scope.make();
    const executed: unknown[] = [];
    let markExecuted!: () => void;
    const executionFinished = new Promise<void>((resolve) => { markExecuted = resolve; });
    yield* Layer.buildWithScope(layer(stdio, {
      toolDefinitions: [{
        id: "test.echo",
        namespace: "test",
        description: "Echo a value",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        enabled: true,
        risk: "low",
      }],
      resolveToolPolicy: () => ({ allow: true }),
      executeTool: async (call) => {
        executed.push(call);
        markExecuted();
        return { ok: true, value: { echoed: true } };
      },
      executorFactory: async (_config, request) => ({
        async execute() {
          return request!.tools!.call({ callId: "exact-call-1", toolId: "test.echo", input: { value: "hello" } });
        },
      }),
    }), scope);

    yield* send(input, initialize);
    yield* readResponse(output, 1);
    yield* send(input, request(2, "session/new", { cwd: "/tmp/subpolar-acp-test" }));
    const created = yield* readResponse(output, 2);
    const sessionId = (created.result as { sessionId: string }).sessionId;
    yield* send(input, request(3, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "call the tool" }],
    }));
    let promptResponseReceived = false;
    let permissionRequest: Record<string, unknown> | undefined;
    while (!promptResponseReceived || !permissionRequest) {
      const message = yield* readJsonLine(output);
      if (message.id === 3) promptResponseReceived = true;
      if (message.method === "session/request_permission") permissionRequest = message;
    }
    const params = permissionRequest.params as {
      sessionId: string;
      toolCall: { toolCallId: string; name: string; rawInput: unknown };
      options: Array<{ optionId: string; kind: string }>;
    };
    assert.equal(params.sessionId, sessionId);
    assert.deepEqual(params.toolCall, {
      toolCallId: "exact-call-1",
      kind: "other",
      status: "pending",
      title: "test.echo: Echo a value",
      name: "test.echo",
      rawInput: { value: "hello" },
    });
    assert.deepEqual(params.options.map(({ optionId, kind }) => ({ optionId, kind })), [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "reject-once", kind: "reject_once" },
    ]);
    yield* send(input, {
      jsonrpc: "2.0",
      id: permissionRequest.id,
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });
    yield* Effect.promise(() => executionFinished);
    assert.equal(executed.length, 1);
    assert.deepEqual(executed[0], {
      callId: "exact-call-1",
      toolId: "test.echo",
      input: { value: "hello" },
      runId: (executed[0] as { runId: unknown }).runId,
      requestId: (executed[0] as { requestId: unknown }).requestId,
      idempotencyKey: "tool-call:exact-call-1",
    });
    assert.equal(typeof (executed[0] as { runId: unknown }).runId, "string");
    assert.equal(typeof (executed[0] as { requestId: unknown }).requestId, "string");
    yield* Scope.close(scope, Exit.void);
  }),
);
