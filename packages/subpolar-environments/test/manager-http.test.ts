import { expect, test } from "bun:test";
import { createEnvironmentManagerHttpHandler } from "../src/manager-http.ts";
import type { EnvironmentManager, EnvironmentRequest, ManagedEnvironment } from "../src/index.ts";

const TOKEN = "manager-test-token-with-more-than-thirty-two-characters";
const requestInput: EnvironmentRequest = {
  ownerId: "user-a",
  workspaceId: "workspace-a",
  storageRoot: "/workspaces",
  worktreePath: "/workspaces/repo",
};
const environment: ManagedEnvironment = {
  ...requestInput,
  id: "environment-a",
  backendId: "test",
  resourceId: "resource-a",
  status: "ready",
};

function managerFixture() {
  const calls: Array<{ method: string; request?: EnvironmentRequest; command?: readonly string[]; sessionId?: string; data?: Uint8Array; columns?: number; rows?: number; port?: number }> = [];
  const manager = {
    identity: async () => ({ ...environment }),
    ensure: async (request: EnvironmentRequest) => { calls.push({ method: "ensure", request }); return environment; },
    start: async (request: EnvironmentRequest) => { calls.push({ method: "start", request }); return environment; },
    stop: async (request: EnvironmentRequest) => { calls.push({ method: "stop", request }); return { ...environment, status: "stopped" as const }; },
    restart: async (request: EnvironmentRequest) => { calls.push({ method: "restart", request }); return environment; },
    remove: async (request: EnvironmentRequest) => { calls.push({ method: "remove", request }); },
    execute: async (request: EnvironmentRequest, command: readonly string[], process: { onOutput?: (output: { stream: "stdout" | "stderr"; data: Uint8Array }) => void | Promise<void> }) => {
      calls.push({ method: "execute", request, command });
      await process.onOutput?.({ stream: "stdout", data: new TextEncoder().encode("ok") });
      return { processId: "process-a", exitCode: 0, cancelled: false };
    },
    startInteractive: async (request: EnvironmentRequest, command: readonly string[]) => {
      calls.push({ method: "startInteractive", request, command });
      return { sessionId: "session-a", outputSequence: 0 };
    },
    writeInteractive: async (request: EnvironmentRequest, sessionId: string, data: Uint8Array) => { calls.push({ method: "writeInteractive", request, sessionId, data }); },
    resizeInteractive: async (request: EnvironmentRequest, sessionId: string, columns: number, rows: number) => { calls.push({ method: "resizeInteractive", request, sessionId, columns, rows }); },
    attachInteractiveOutput: async function* (request: EnvironmentRequest, sessionId: string) {
      calls.push({ method: "attachInteractiveOutput", request, sessionId });
      yield { type: "output" as const, sequence: 1, data: new TextEncoder().encode("prompt") };
      yield { type: "exit" as const, result: { exitCode: 0, cancelled: false } };
    },
    terminateInteractive: async (request: EnvironmentRequest, sessionId: string) => { calls.push({ method: "terminateInteractive", request, sessionId }); },
    startManagedSession: async (request: EnvironmentRequest, command: readonly string[]) => {
      calls.push({ method: "startManagedSession", request, command });
      return { sessionId: "stdio-session-a", outputSequence: 0 };
    },
    startPortTunnel: async (request: EnvironmentRequest, port: number) => {
      calls.push({ method: "startPortTunnel", request, port });
      return { sessionId: "tcp-session-a", outputSequence: 0 };
    },
    writeManagedSession: async (request: EnvironmentRequest, sessionId: string, data: Uint8Array) => { calls.push({ method: "writeManagedSession", request, sessionId, data }); },
    attachManagedSessionOutput: async function* (request: EnvironmentRequest, sessionId: string) {
      calls.push({ method: "attachManagedSessionOutput", request, sessionId });
      yield { type: "output" as const, stream: "stdout" as const, sequence: 1, data: new TextEncoder().encode("jsonrpc") };
      yield { type: "exit" as const, result: { exitCode: 0, cancelled: false } };
    },
    terminateManagedSession: async (request: EnvironmentRequest, sessionId: string) => { calls.push({ method: "terminateManagedSession", request, sessionId }); },
    reconcile: async () => [],
    list: async () => [{ environment, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" }],
    inspect: async () => environment,
    rebuild: async () => environment,
  } satisfies EnvironmentManager;
  return { manager, calls };
}

function makeRequest(path: string, body?: unknown, token: string | null = TOKEN) {
  return new Request(`http://manager${path}`, {
    method: "POST",
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("manager API exposes a minimal health check without manager details", async () => {
  const { manager } = managerFixture();
  const handle = createEnvironmentManagerHttpHandler(manager, TOKEN);
  const response = await handle(new Request("http://manager/healthz"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});

test("manager API rejects missing or invalid bearer credentials before dispatch", async () => {
  const { manager, calls } = managerFixture();
  const handle = createEnvironmentManagerHttpHandler(manager, TOKEN);

  const missing = await handle(makeRequest("/v1/environments/ensure", { environment: requestInput }, null));
  const invalid = await handle(makeRequest("/v1/environments/ensure", { environment: requestInput }, "wrong"));
  const multibyte = await handle(makeRequest("/v1/environments/ensure", { environment: requestInput }, TOKEN.replace("a", "é")));
  expect(missing.status).toBe(401);
  expect(invalid.status).toBe(401);
  expect(multibyte.status).toBe(401);
  expect(calls).toEqual([]);
});

test("manager admin routes require authentication and expose list, inspect, status, and rebuild", async () => {
  const { manager } = managerFixture();
  const handle = createEnvironmentManagerHttpHandler(manager, TOKEN);

  const denied = await handle(makeRequest("/v1/environments/admin/list", {}, null));
  expect(denied.status).toBe(401);

  const status = await handle(makeRequest("/v1/environments/admin/status", {}));
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({ ok: true, registeredEnvironmentCount: 1 });

  const list = await handle(makeRequest("/v1/environments/admin/list", { ownerId: "user-a" }));
  expect(await list.json()).toMatchObject({ environments: [{ environment: { id: "environment-a" } }] });

  const inspect = await handle(makeRequest("/v1/environments/admin/inspect", { environment: requestInput }));
  expect(await inspect.json()).toEqual({ environment });

  const rebuild = await handle(makeRequest("/v1/environments/admin/rebuild", { environment: requestInput }));
  expect(await rebuild.json()).toEqual(environment);

  const restart = await handle(makeRequest("/v1/environments/restart", { environment: requestInput }));
  expect(await restart.json()).toEqual(environment);
});

test("manager API validates the route body and dispatches lifecycle operations", async () => {
  const { manager, calls } = managerFixture();
  const handle = createEnvironmentManagerHttpHandler(manager, TOKEN);

  const response = await handle(makeRequest("/v1/environments/stop", { environment: requestInput }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "stopped" });
  expect(calls).toEqual([{ method: "stop", request: requestInput }]);

  const invalid = await handle(makeRequest("/v1/environments/ensure", { environment: { ...requestInput, ownerId: 3 } }));
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ error: "INVALID_REQUEST" });
});

test("manager API streams process output and the final result as NDJSON", async () => {
  const { manager, calls } = managerFixture();
  const handle = createEnvironmentManagerHttpHandler(manager, TOKEN);

  const response = await handle(makeRequest("/v1/environments/execute", {
    environment: requestInput,
    command: ["node", "-e", "process.stdout.write('ok')"],
    process: { cwd: "packages", environment: { MODE: "test" } },
  }));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toStartWith("application/x-ndjson");
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  expect(events).toEqual([
    { type: "output", stream: "stdout", data: "b2s=" },
    { type: "result", result: { processId: "process-a", exitCode: 0, cancelled: false } },
  ]);
  expect(calls).toEqual([{ method: "execute", request: requestInput, command: ["node", "-e", "process.stdout.write('ok')"] }]);
});

test("manager API cancels managed execution when its output stream is abandoned", async () => {
  let aborted = false;
  const manager: EnvironmentManager = {
    ...managerFixture().manager,
    execute: async (_request, _command, process) => {
      await process.onOutput?.({ stream: "stdout", data: new TextEncoder().encode("started") });
      await new Promise<void>((resolve) => {
        if (process.signal?.aborted) resolve();
        else process.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      aborted = process.signal?.aborted === true;
      return { exitCode: null, cancelled: true };
    },
  };
  const handle = createEnvironmentManagerHttpHandler(manager, TOKEN);
  const response = await handle(makeRequest("/v1/environments/execute", {
    environment: requestInput,
    command: ["long-running"],
  }));
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel("client disconnected");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(aborted).toBe(true);
});

test("manager API starts, attaches to, controls, and terminates an authenticated TTY session", async () => {
  const { manager, calls } = managerFixture();
  const handle = createEnvironmentManagerHttpHandler(manager, TOKEN);
  const start = await handle(makeRequest("/v1/environments/pty/start", {
    environment: requestInput, command: ["/bin/sh"], process: { cwd: "packages", clientSessionId: "thread-1-terminal-1" },
  }));
  expect(start.status).toBe(200);
  await expect(start.json()).resolves.toEqual({ sessionId: "session-a", outputSequence: 0 });

  const input = await handle(makeRequest("/v1/environments/pty/input", {
    environment: requestInput, sessionId: "session-a", data: Buffer.from("ls\n").toString("base64"),
  }));
  expect(input.status).toBe(200);
  const resize = await handle(makeRequest("/v1/environments/pty/resize", {
    environment: requestInput, sessionId: "session-a", columns: 120, rows: 40,
  }));
  expect(resize.status).toBe(200);
  const output = await handle(makeRequest("/v1/environments/pty/output", {
    environment: requestInput, sessionId: "session-a", afterSequence: 0,
  }));
  expect((await output.text()).trim().split("\n").map((line) => JSON.parse(line))).toEqual([
    { type: "output", sequence: 1, data: "cHJvbXB0" },
    { type: "exit", result: { exitCode: 0, cancelled: false } },
  ]);
  const terminate = await handle(makeRequest("/v1/environments/pty/terminate", { environment: requestInput, sessionId: "session-a" }));
  expect(terminate.status).toBe(200);
  expect(calls.map((call) => call.method)).toEqual([
    "startInteractive", "writeInteractive", "resizeInteractive", "attachInteractiveOutput", "terminateInteractive",
  ]);
  expect(calls[1]?.data).toEqual(Buffer.from("ls\n"));
});

test("manager API streams authenticated non-TTY stdio sessions with separate output channels", async () => {
  const { manager, calls } = managerFixture();
  const handle = createEnvironmentManagerHttpHandler(manager, TOKEN);
  const start = await handle(makeRequest("/v1/environments/stdio/start", {
    environment: requestInput, command: ["node", "acp-server.js"], process: { cwd: "packages", clientSessionId: "thread-1-acp" },
  }));
  await expect(start.json()).resolves.toEqual({ sessionId: "stdio-session-a", outputSequence: 0 });
  const input = await handle(makeRequest("/v1/environments/stdio/input", {
    environment: requestInput, sessionId: "stdio-session-a", data: Buffer.from('{"jsonrpc":"2.0"}').toString("base64"),
  }));
  expect(input.status).toBe(200);
  const output = await handle(makeRequest("/v1/environments/stdio/output", { environment: requestInput, sessionId: "stdio-session-a" }));
  expect((await output.text()).trim().split("\n").map((line) => JSON.parse(line))).toEqual([
    { type: "output", sequence: 1, stream: "stdout", data: "anNvbnJwYw==" },
    { type: "exit", result: { exitCode: 0, cancelled: false } },
  ]);
  const terminate = await handle(makeRequest("/v1/environments/stdio/terminate", { environment: requestInput, sessionId: "stdio-session-a" }));
  expect(terminate.status).toBe(200);
  expect(calls.map((call) => call.method)).toEqual(["startManagedSession", "writeManagedSession", "attachManagedSessionOutput", "terminateManagedSession"]);
  expect(calls[1]?.data).toEqual(Buffer.from('{"jsonrpc":"2.0"}'));
});

test("manager API starts a loopback port tunnel for one authenticated environment", async () => {
  const { manager, calls } = managerFixture();
  const handle = createEnvironmentManagerHttpHandler(manager, TOKEN);
  const denied = await handle(makeRequest("/v1/environments/tcp/start", { environment: requestInput, port: 5173 }, null));
  expect(denied.status).toBe(401);

  const invalidPort = await handle(makeRequest("/v1/environments/tcp/start", { environment: requestInput, port: 65_536 }));
  expect(invalidPort.status).toBe(400);
  expect(calls).toEqual([]);

  const started = await handle(makeRequest("/v1/environments/tcp/start", { environment: requestInput, port: 5173 }));
  expect(started.status).toBe(200);
  await expect(started.json()).resolves.toEqual({ sessionId: "tcp-session-a", outputSequence: 0 });
  expect(calls).toEqual([{ method: "startPortTunnel", request: requestInput, port: 5173 }]);
});
