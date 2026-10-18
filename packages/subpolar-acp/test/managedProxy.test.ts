import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import type { EnvironmentManagedSessionRequest, EnvironmentManager, EnvironmentRequest } from "@subpolar/environments";
import { makeInMemoryStdio } from "../../effect-acp/src/_internal/stdio.ts";
import { layerManagedAcpProxy } from "../src/managedProxy.ts";

const baseEnvironment = {
  SUBPOLAR_MANAGER_URL: "http://subpolar-manager:8787",
  SUBPOLAR_MANAGER_TOKEN: "managed-proxy-test-token-with-more-than-thirty-two-characters",
  SUBPOLAR_MANAGER_ALLOW_PRIVATE_HTTP: "true",
  SUBPOLAR_STORAGE_ROOT: "/workspaces",
  SUBPOLAR_ACP_WORKER_COMMAND: '["/usr/local/bin/subpolar-acp-worker"]',
};
const encoder = new TextEncoder();

function fakeManager(options: { failStart?: boolean; requestPermission?: boolean } = {}) {
  const calls: Array<{ method: string; request?: EnvironmentRequest; process?: EnvironmentManagedSessionRequest; command?: readonly string[]; sessionId?: string; data?: string }> = [];
  const outputs = new Map<string, ReturnType<typeof yieldQueue>>();
  let markCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => { markCancelled = resolve; });
  let markPermissionResponse!: () => void;
  const permissionResponse = new Promise<void>((resolve) => { markPermissionResponse = resolve; });
  let nextSession = 0;
  const writeWaiters: Array<{ predicate: (call: (typeof calls)[number]) => boolean; resolve: (call: (typeof calls)[number]) => void }> = [];
  const manager = {
    startManagedSession: async (request: EnvironmentRequest, command: readonly string[], process?: EnvironmentManagedSessionRequest) => {
      calls.push({ method: "start", request, command, process });
      if (options.failStart) throw new Error("manager unavailable");
      const sessionId = `managed-${++nextSession}`;
      outputs.set(sessionId, yieldQueue());
      return { sessionId, outputSequence: 0 };
    },
    writeManagedSession: async (_request: EnvironmentRequest, sessionId: string, data: Uint8Array) => {
      const text = new TextDecoder().decode(data);
      const writeCall = { method: "write", sessionId, data: text };
      calls.push(writeCall);
      for (const waiter of writeWaiters.splice(0)) {
        if (waiter.predicate(writeCall)) waiter.resolve(writeCall);
        else writeWaiters.push(waiter);
      }
      const output = outputs.get(sessionId);
      if (!output) throw new Error(`unknown fake session ${sessionId}`);
      for (const line of text.trim().split("\n")) {
        if (!line) continue;
        const message = JSON.parse(line) as { id?: string | number; method?: string; params?: unknown };
        if (message.result && typeof message.result === "object" && JSON.stringify(message.result).includes("allow-once")) {
          calls.push({ method: "permission-response", data: JSON.stringify(message) });
          markPermissionResponse();
        }
        if (message.method === "session/cancel") markCancelled();
        if (message.method === "initialize") {
          output.push(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
            protocolVersion: 2,
            info: { name: "worker", version: "1" },
            capabilities: { session: {} },
          } }));
        } else if (message.method === "session/new") {
          const params = message.params as { _meta?: Record<string, unknown> } | undefined;
          const workerSessionId = String(params?._meta?.["subpolar.sessionId"] ?? `worker-${sessionId}`);
          output.push(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: workerSessionId } }));
        } else if (message.method === "session/resume" || message.method === "session/load") {
          output.push(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        } else if (message.method === "session/prompt") {
          const promptSessionId = String((message.params as { sessionId?: string }).sessionId);
          output.push(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
          if (options.requestPermission) {
            output.push(JSON.stringify({ jsonrpc: "2.0", id: 77, method: "session/request_permission", params: {
              sessionId: promptSessionId,
              title: "test",
              subject: { type: "command", command: "pwd", cwd: "/workspaces/project-a" },
              options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
            } }));
          }
          output.push(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
            sessionId: promptSessionId,
            update: { sessionUpdate: "agent_message_chunk", messageId: "run-1", content: { type: "text", text: "from worker" } },
          } }));
          output.push(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
            sessionId: promptSessionId,
            update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
          } }));
        }
      }
    },
    attachManagedSessionOutput: async function* (_request: EnvironmentRequest, sessionId: string) {
      const output = outputs.get(sessionId);
      if (!output) throw new Error(`unknown fake session ${sessionId}`);
      let sequence = 0;
      while (true) {
        const value = await output.take();
        if (value === null) return;
        const encoded = encoder.encode(`${value}\n`);
        for (let offset = 0; offset < encoded.length; offset += 7) {
          yield { type: "output" as const, sequence: ++sequence, stream: "stdout" as const, data: encoded.slice(offset, offset + 7) };
        }
      }
    },
    terminateManagedSession: async (request: EnvironmentRequest, sessionId: string) => {
      calls.push({ method: "terminate", request, data: sessionId });
      outputs.get(sessionId)?.end();
    },
  } as unknown as EnvironmentManager;
  const waitForWrite = (predicate: (call: (typeof calls)[number]) => boolean) => {
    const found = calls.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise<(typeof calls)[number]>((resolve) => writeWaiters.push({ predicate, resolve }));
  };
  const emit = (sessionId: string, message: unknown) => outputs.get(sessionId)?.push(JSON.stringify(message));
  return { manager, calls, cancelled, permissionResponse, waitForWrite, emit };
}

function yieldQueue() {
  const values: Array<string | null> = [];
  const waiters: Array<(value: string | null) => void> = [];
  let ended = false;
  return {
    push(value: string) {
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else values.push(value);
    },
    take(): Promise<string | null> {
      const value = values.shift();
      if (value !== undefined) return Promise.resolve(value);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    end() {
      ended = true;
      for (const waiter of waiters.splice(0)) waiter(null);
    },
  };
}

const send = (input: Queue.Queue<Uint8Array, Cause.Done<void>>, message: unknown) =>
  Queue.offer(input, encoder.encode(`${JSON.stringify(message)}\n`));

const pendingMessagesByOutput = new WeakMap<object, Array<Record<string, unknown>>>();

async function readMessage(output: Queue.Queue<string>, matches: (message: Record<string, unknown>) => boolean) {
  let pendingMessages = pendingMessagesByOutput.get(output);
  if (!pendingMessages) {
    pendingMessages = [];
    pendingMessagesByOutput.set(output, pendingMessages);
  }
  while (true) {
    const pendingIndex = pendingMessages.findIndex(matches);
    if (pendingIndex >= 0) return pendingMessages.splice(pendingIndex, 1)[0]!;
    let line = "";
    while (!line.includes("\n")) line += await Effect.runPromise(Queue.take(output));
    const message = JSON.parse(line.slice(0, line.indexOf("\n"))) as Record<string, unknown>;
    if (matches(message)) return message;
    pendingMessages.push(message);
  }
}

test("managed proxy starts a worker for the requested worktree and forwards ACP messages", async () => {
  const { stdio, input, output } = await Effect.runPromise(makeInMemoryStdio());
  const scope = await Effect.runPromise(Scope.make());
  const fake = fakeManager();
  await Effect.runPromise(Layer.buildWithScope(layerManagedAcpProxy(stdio, {
    environment: baseEnvironment,
    manager: fake.manager,
  }), scope));

  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2, info: { name: "t3", version: "1" }, capabilities: {} } }));
  await readMessage(output, (message) => message.id === 1);
  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/workspaces/project-a" } }));
  const created = await readMessage(output, (message) => message.id === 2);
  const nativeSessionId = (created.result as { sessionId: string }).sessionId;
  expect(typeof nativeSessionId).toBe("string");
  expect(nativeSessionId).toMatch(/^t3-acp-/);
  expect(fake.calls[0]).toMatchObject({
    method: "start",
    command: ["/usr/local/bin/subpolar-acp-worker"],
    request: {
      ownerId: "t3-installation",
      storageRoot: "/workspaces",
      worktreePath: "/workspaces/project-a",
      workspaceId: expect.stringMatching(/^ws_[a-f0-9]{24}$/),
    },
    process: {
      environment: {
        SUBPOLAR_ACP_EXECUTION: "local",
        SUBPOLAR_ACP_WORKER_MODE: "1",
      },
      clientSessionId: `t3-acp-${createHash("sha256").update(nativeSessionId).digest("hex").slice(0, 32)}`,
    },
  });
  expect(fake.calls[0]?.process?.environment).not.toHaveProperty("SUBPOLAR_MANAGER_TOKEN");
  expect(fake.calls[0]?.process?.environment).not.toHaveProperty("SUBPOLAR_MANAGER_URL");
  expect(fake.calls[0]?.process?.environment).not.toHaveProperty("SUBPOLAR_STORAGE_ROOT");

  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: nativeSessionId, prompt: [{ type: "text", text: "hello" }] } }));
  const update = await readMessage(output, (message) => message.method === "session/update" && JSON.stringify(message.params).includes("from worker"));
  await readMessage(output, (message) => message.id === 3);
  expect(update.params).toMatchObject({ sessionId: nativeSessionId, update: { content: { text: "from worker" } } });

  await Effect.runPromise(Scope.close(scope, Exit.void));
  expect(fake.calls.some((call) => call.method === "terminate")).toBe(true);
});

test("managed proxy keeps the T3 MCP bearer on the host and relays tools through the scoped MCP session", async () => {
  const { stdio, input, output } = await Effect.runPromise(makeInMemoryStdio());
  const scope = await Effect.runPromise(Scope.make());
  const fake = fakeManager();
  const mcpRequests: Array<{ method: string; authorization: string | null; sessionId: string | null; body: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    mcpRequests.push({
      method: String(body.method),
      authorization: headers.get("authorization"),
      sessionId: headers.get("mcp-session-id"),
      body,
    });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = body.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: {} }
      : body.method === "tools/list"
        ? { tools: [{ name: "thread_read", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: "authorized thread data" }] };
    return Response.json({ jsonrpc: "2.0", id: body.id, result }, {
      headers: { "mcp-session-id": "provider-session-1" },
    });
  };
  await Effect.runPromise(Layer.buildWithScope(layerManagedAcpProxy(stdio, {
    environment: baseEnvironment,
    manager: fake.manager,
    fetch: fetcher,
  }), scope));
  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2, info: { name: "t3", version: "1" }, capabilities: {} } }));
  await readMessage(output, (message) => message.id === 1);

  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 2, method: "session/new", params: {
    cwd: "/workspaces/project-a",
    mcpServers: [{
      type: "stdio",
      name: "t3-code",
      command: "/usr/bin/node",
      env: [
        { name: "T3_ACP_MCP_ENDPOINT", value: "http://127.0.0.1:4312/mcp" },
        { name: "T3_ACP_MCP_AUTHORIZATION", value: "Bearer provider-instance-token" },
      ],
    }],
  } }));
  const created = await readMessage(output, (message) => message.id === 2);
  const nativeSessionId = (created.result as { sessionId: string }).sessionId;
  const started = fake.calls.find((call) => call.method === "start");
  expect(started?.process?.environment).toMatchObject({ SUBPOLAR_T3_MCP_BRIDGE: "1" });
  expect(started?.process?.environment).not.toHaveProperty("T3_ACP_MCP_AUTHORIZATION");
  expect(fake.calls.some((call) => call.method === "write" && call.data?.includes('"method":"session/new"') && call.data.includes('"mcpServers":[]'))).toBe(true);

  fake.emit("managed-1", {
    jsonrpc: "2.0", id: 901, method: "subpolar/t3_mcp",
    params: { sessionId: nativeSessionId, requestId: "00000000-0000-4000-8000-000000000901", operation: "list_tools" },
  });
  const listed = await fake.waitForWrite((call) => call.data?.includes('"id":901') === true);
  expect(listed.data).toContain('"name":"thread_read"');

  fake.emit("managed-1", {
    jsonrpc: "2.0", id: 902, method: "subpolar/t3_mcp",
    params: { sessionId: nativeSessionId, requestId: "00000000-0000-4000-8000-000000000902", operation: "call_tool", name: "thread_read", arguments: { threadId: "thread-1" } },
  });
  const called = await fake.waitForWrite((call) => call.data?.includes('"id":902') === true);
  expect(called.data).toContain("authorized thread data");
  expect(mcpRequests.filter((request) => request.method === "tools/call").map((request) => request.body)).toEqual([
    expect.objectContaining({ method: "tools/call", params: { name: "thread_read", arguments: { threadId: "thread-1" } } }),
  ]);
  expect(mcpRequests.every((request) => request.authorization === "Bearer provider-instance-token")).toBe(true);
  expect(mcpRequests.filter((request) => request.sessionId !== null).every((request) => request.sessionId === "provider-session-1")).toBe(true);
  await Scope.close(scope, Exit.void);
});

test("managed proxy rejects a T3 MCP credential that targets a non-loopback endpoint", async () => {
  const { stdio, input, output } = await Effect.runPromise(makeInMemoryStdio());
  const scope = await Effect.runPromise(Scope.make());
  const fake = fakeManager();
  await Effect.runPromise(Layer.buildWithScope(layerManagedAcpProxy(stdio, {
    environment: baseEnvironment,
    manager: fake.manager,
  }), scope));
  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2, info: { name: "t3", version: "1" }, capabilities: {} } }));
  await readMessage(output, (message) => message.id === 1);
  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 2, method: "session/new", params: {
    cwd: "/workspaces/project-a",
    mcpServers: [{
      type: "stdio",
      name: "t3-code",
      command: "/usr/bin/node",
      env: [
        { name: "T3_ACP_MCP_ENDPOINT", value: "https://example.invalid/mcp" },
        { name: "T3_ACP_MCP_AUTHORIZATION", value: "Bearer forged" },
      ],
    }],
  } }));
  expect((await readMessage(output, (message) => message.id === 2)).error).toBeDefined();
  expect(fake.calls).toEqual([]);
  await Scope.close(scope, Exit.void);
});

test("cold ACP resume starts a worker with the persisted native session key", async () => {
  const { stdio, input, output } = await Effect.runPromise(makeInMemoryStdio());
  const scope = await Effect.runPromise(Scope.make());
  const fake = fakeManager();
  await Effect.runPromise(Layer.buildWithScope(layerManagedAcpProxy(stdio, {
    environment: baseEnvironment,
    manager: fake.manager,
  }), scope));
  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2, info: { name: "t3", version: "1" }, capabilities: {} } }));
  await readMessage(output, (message) => message.id === 1);

  const nativeSessionId = "t3-acp-existing-native-session";
  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 2, method: "session/resume", params: {
    sessionId: nativeSessionId,
    cwd: "/workspaces/project-a",
    mcpServers: [],
  } }));
  const loaded = await readMessage(output, (message) => message.id === 2);
  expect(loaded.error).toBeUndefined();
  expect(fake.calls.filter((call) => call.method === "start")).toHaveLength(1);
  expect(fake.calls[0]?.process?.clientSessionId).toBe(
    `t3-acp-${createHash("sha256").update(nativeSessionId).digest("hex").slice(0, 32)}`,
  );
  expect(fake.calls.some((call) => call.method === "write" && call.data?.includes('"method":"session/resume"') && call.data.includes(nativeSessionId) && call.data.includes('"replayFrom":{"type":"start"}'))).toBe(true);
  await Scope.close(scope, Exit.void);
});

test("warm ACP resume rehydrates Pi state through load semantics", async () => {
  const { stdio, input, output } = await Effect.runPromise(makeInMemoryStdio());
  const scope = await Effect.runPromise(Scope.make());
  const fake = fakeManager();
  await Effect.runPromise(Layer.buildWithScope(layerManagedAcpProxy(stdio, {
    environment: baseEnvironment,
    manager: fake.manager,
  }), scope));
  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2, info: { name: "t3", version: "1" }, capabilities: {} } }));
  await readMessage(output, (message) => message.id === 1);
  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/workspaces/project-a" } }));
  const created = await readMessage(output, (message) => message.id === 2);
  const nativeSessionId = (created.result as { sessionId: string }).sessionId;

  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 3, method: "session/resume", params: {
    sessionId: nativeSessionId,
    cwd: "/workspaces/project-a",
    mcpServers: [],
  } }));
  const resumed = await readMessage(output, (message) => message.id === 3);
  expect(resumed.error).toBeUndefined();
  expect(fake.calls.filter((call) => call.method === "start")).toHaveLength(1);
  expect(fake.calls.some((call) => call.method === "write" && call.data?.includes('"method":"session/resume"') && call.data.includes(nativeSessionId) && call.data.includes('"replayFrom":{"type":"start"}'))).toBe(true);
  await Scope.close(scope, Exit.void);
});

test("managed proxy returns startup errors without falling back to a local runtime", async () => {
  const { stdio, input, output } = await Effect.runPromise(makeInMemoryStdio());
  const scope = await Effect.runPromise(Scope.make());
  const fake = fakeManager({ failStart: true });
  await Effect.runPromise(Layer.buildWithScope(layerManagedAcpProxy(stdio, {
    environment: baseEnvironment,
    manager: fake.manager,
  }), scope));
  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2, info: { name: "t3", version: "1" }, capabilities: {} } }));
  await readMessage(output, (message) => message.id === 1);
  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/workspaces/project-a" } }));
  const failed = await readMessage(output, (message) => message.id === 2);
  expect(failed.error).toBeDefined();
  expect(fake.calls.map((call) => call.method)).toEqual(["start"]);
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

test("managed proxy sends worker permission requests to the T3 ACP client and forwards cancellation", async () => {
  const { stdio, input, output } = await Effect.runPromise(makeInMemoryStdio());
  const scope = await Effect.runPromise(Scope.make());
  const fake = fakeManager({ requestPermission: true });
  await Effect.runPromise(Layer.buildWithScope(layerManagedAcpProxy(stdio, {
    environment: baseEnvironment,
    manager: fake.manager,
  }), scope));
  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2, info: { name: "t3", version: "1" }, capabilities: {} } }));
  await readMessage(output, (message) => message.id === 1);
  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/workspaces/project-a" } }));
  const created = await readMessage(output, (message) => message.id === 2);
  const nativeSessionId = (created.result as { sessionId: string }).sessionId;
  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: nativeSessionId, prompt: [{ type: "text", text: "run a command" }] } }));
  const permission = await readMessage(output, (message) => message.method === "session/request_permission");
  expect(permission.params).toMatchObject({ sessionId: nativeSessionId, title: "test", subject: { type: "command" } });
  await Effect.runPromise(send(input, {
    jsonrpc: "2.0",
    id: permission.id,
    result: { outcome: { outcome: "selected", optionId: "allow-once" } },
  }));
  await readMessage(output, (message) => message.id === 3);
  await fake.permissionResponse;
  expect(fake.calls.some((call) => call.method === "permission-response" && call.data?.includes("allow-once"))).toBe(true);

  await Effect.runPromise(send(input, { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: nativeSessionId } }));
  await fake.cancelled;
  expect(fake.calls.some((call) => call.method === "write" && call.data?.includes('"method":"session/cancel"'))).toBe(true);
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

test("managed proxy never routes an unscoped request to an arbitrary worker", async () => {
  const { stdio, input, output } = await Effect.runPromise(makeInMemoryStdio());
  const scope = await Effect.runPromise(Scope.make());
  const fake = fakeManager();
  await Effect.runPromise(Layer.buildWithScope(layerManagedAcpProxy(stdio, {
    environment: baseEnvironment,
    manager: fake.manager,
  }), scope));

  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2, info: { name: "t3", version: "1" }, capabilities: {} } }));
  await readMessage(output, (message) => message.id === 1);
  for (const [id, cwd] of [[2, "/workspaces/project-a"], [3, "/workspaces/project-b"]] as const) {
    await Effect.runPromise(send(input, { jsonrpc: "2.0", id, method: "session/new", params: { cwd } }));
    await readMessage(output, (message) => message.id === id);
  }

  await Effect.runPromise(send(input, { jsonrpc: "2.0", id: 4, method: "providers/list", params: {} }));
  const response = await readMessage(output, (message) => message.id === 4);
  expect(response.error).toBeDefined();
  expect(fake.calls.filter((call) => call.method === "write").every((call) => !call.data?.includes('"method":"providers/list"'))).toBe(true);
  expect(new Set(fake.calls.filter((call) => call.method === "start").map((call) => call.request?.worktreePath))).toEqual(new Set([
    "/workspaces/project-a",
    "/workspaces/project-b",
  ]));

  await Effect.runPromise(Scope.close(scope, Exit.void));
});
