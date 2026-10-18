import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import type { PiSdkModule, PiSessionManager } from "@subpolar/runtime-pi";
import { makeInMemoryStdio } from "../../effect-acp/src/_internal/stdio.ts";
import { layer } from "../src/index.ts";

const encoder = new TextEncoder();
const send = (input: Queue.Queue<Uint8Array, Cause.Done<void>>, message: unknown) =>
  Queue.offer(input, encoder.encode(`${JSON.stringify(message)}\n`));

async function readMessage(output: Queue.Queue<string>, id: number) {
  while (true) {
    let line = "";
    while (!line.includes("\n")) line += await Effect.runPromise(Queue.take(output));
    const message = JSON.parse(line.slice(0, line.indexOf("\n"))) as Record<string, unknown>;
    if (message.id === id) return message;
    if (message.id !== undefined) throw new Error(`Expected response ${id}, received ${JSON.stringify(message)}`);
  }
}

function sdkWithSession(cwd: string, expectedId: string, found = true): PiSdkModule {
  const session: PiSessionManager = {
    appendMessage() {},
    getCwd: () => cwd,
    getSessionId: () => expectedId,
    getSessionFile: () => found ? "/var/lib/subpolar/sessions/session.jsonl" : undefined,
    isPersisted: () => found,
  };
  return {
    getAgentDir: () => "/unused",
    SessionManager: {
      inMemory: () => session,
      create: () => session,
      findById: () => found ? "/var/lib/subpolar/sessions/session.jsonl" : undefined,
      open: () => session,
    },
    SettingsManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class { async reload() {} },
    async createAgentSession() { throw new Error("resume test must not create a Pi session"); },
  };
}

test("ACP resumes only a persisted Pi session matching the native session ID and cwd", async () => {
  const cwd = "/workspace/project";
  const nativeId = "t3-acp-native-session";
  const piId = createHash("sha256").update(nativeId).digest("hex");
  const { stdio, input, output } = await Effect.runPromise(makeInMemoryStdio());
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(Layer.buildWithScope(layer(stdio, {
    piConfig: { runtimeDataDir: "/var/lib/subpolar" },
    loadPiSdk: async () => sdkWithSession(cwd, piId),
  }), scope));

  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: 2,
    info: { name: "test", version: "1" },
    capabilities: {},
  } }));
  await readMessage(output, 1);
  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 2, method: "session/resume", params: {
    sessionId: nativeId,
    cwd,
    replayFrom: { type: "start" },
  } }));
  expect((await readMessage(output, 2)).error).toBeUndefined();
  await Scope.close(scope, Exit.void);
});

test("ACP rejects a cold resume when the Pi session is missing or bound to another cwd", async () => {
  const nativeId = "t3-acp-missing-session";
  const piId = createHash("sha256").update(nativeId).digest("hex");
  for (const sdk of [sdkWithSession("/workspace/project", piId, false), sdkWithSession("/workspace/other", piId)]) {
    const { stdio, input, output } = await Effect.runPromise(makeInMemoryStdio());
    const scope = await Effect.runPromise(Scope.make());
    await Effect.runPromise(Layer.buildWithScope(layer(stdio, {
      piConfig: { runtimeDataDir: "/var/lib/subpolar" },
      loadPiSdk: async () => sdk,
    }), scope));
    await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: 2,
      info: { name: "test", version: "1" },
      capabilities: {},
    } }));
    await readMessage(output, 1);
    await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 2, method: "session/resume", params: {
      sessionId: nativeId,
      cwd: "/workspace/project",
      replayFrom: { type: "start" },
    } }));
    expect((await readMessage(output, 2)).error).toBeDefined();
    await Scope.close(scope, Exit.void);
  }
});

test("ACP close releases transient state while preserving Pi session resume", async () => {
  const cwd = "/workspace/project";
  const nativeId = "t3-acp-close-session";
  const piId = createHash("sha256").update(nativeId).digest("hex");
  const { stdio, input, output } = await Effect.runPromise(makeInMemoryStdio());
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(Layer.buildWithScope(layer(stdio, {
    piConfig: { runtimeDataDir: "/var/lib/subpolar" },
    loadPiSdk: async () => sdkWithSession(cwd, piId),
  }), scope));

  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: 2,
    info: { name: "test", version: "1" },
    capabilities: {},
  } }));
  const initialized = await readMessage(output, 1);
  expect((initialized.result as { capabilities: { session: object } }).capabilities.session).toEqual({});

  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 2, method: "session/resume", params: {
    sessionId: nativeId,
    cwd,
    replayFrom: { type: "start" },
  } }));
  expect((await readMessage(output, 2)).error).toBeUndefined();

  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 3, method: "session/close", params: { sessionId: nativeId } }));
  expect((await readMessage(output, 3)).error).toBeUndefined();

  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 4, method: "session/resume", params: {
    sessionId: nativeId,
    cwd,
    replayFrom: { type: "start" },
  } }));
  expect((await readMessage(output, 4)).error).toBeUndefined();
  await Scope.close(scope, Exit.void);
});
