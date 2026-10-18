import { expect, test } from "bun:test";
import { createEnvironmentManagerHttpClient } from "../src/manager-client.ts";
import type { EnvironmentIdentity, ManagedEnvironment } from "../src/index.ts";

const TOKEN = "manager-client-token-with-more-than-thirty-two-characters";
const identity: EnvironmentIdentity = {
  id: "environment-a",
  ownerId: "user-a",
  workspaceId: "workspace-a",
  storageRoot: "/workspaces",
  worktreePath: "/workspaces/repo",
};
const environment: ManagedEnvironment = {
  ...identity,
  backendId: "test",
  resourceId: "resource-a",
  status: "ready",
};

test("manager client authenticates lifecycle calls and reads responses", async () => {
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (String(input).endsWith("/identity")) return Response.json(identity);
    return Response.json(environment);
  }) as typeof fetch;
  const manager = createEnvironmentManagerHttpClient({ baseUrl: "http://subpolar-manager:8080/", token: TOKEN, allowPrivateHttp: true, fetch: fetcher });

  await expect(manager.identity({ ownerId: identity.ownerId, workspaceId: identity.workspaceId, storageRoot: identity.storageRoot, worktreePath: identity.worktreePath })).resolves.toEqual(identity);
  await expect(manager.ensure({ ownerId: identity.ownerId, workspaceId: identity.workspaceId, storageRoot: identity.storageRoot, worktreePath: identity.worktreePath })).resolves.toEqual(environment);
  expect(calls.map((call) => [call.url, call.authorization])).toEqual([
    ["http://subpolar-manager:8080/v1/environments/identity", `Bearer ${TOKEN}`],
    ["http://subpolar-manager:8080/v1/environments/ensure", `Bearer ${TOKEN}`],
  ]);
});

test("manager client authenticates and validates environment administration calls", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/admin/status")) return Response.json({ ok: true, registeredEnvironmentCount: 1 });
    if (url.endsWith("/admin/list")) return Response.json({ environments: [{ environment, createdAt: "created", updatedAt: "updated" }] });
    if (url.endsWith("/admin/inspect")) return Response.json({ environment });
    return Response.json(environment);
  }) as typeof fetch;
  const manager = createEnvironmentManagerHttpClient({ baseUrl: "http://subpolar-manager:8080", token: TOKEN, allowPrivateHttp: true, fetch: fetcher });
  const request = { ownerId: identity.ownerId, workspaceId: identity.workspaceId, storageRoot: identity.storageRoot, worktreePath: identity.worktreePath };

  await expect(manager.status()).resolves.toEqual({ ok: true, registeredEnvironmentCount: 1 });
  await expect(manager.list(identity.ownerId)).resolves.toEqual([{ environment, createdAt: "created", updatedAt: "updated" }]);
  await expect(manager.inspect(request)).resolves.toEqual(environment);
  await expect(manager.restart(request)).resolves.toEqual(environment);
  await expect(manager.rebuild(request)).resolves.toEqual(environment);
  expect(calls.map(({ url, authorization }) => [url.split("/").at(-1), authorization])).toEqual([
    ["status", `Bearer ${TOKEN}`], ["list", `Bearer ${TOKEN}`], ["inspect", `Bearer ${TOKEN}`],
    ["restart", `Bearer ${TOKEN}`], ["rebuild", `Bearer ${TOKEN}`],
  ]);
});

test("manager client decodes streamed process output and results", async () => {
  const body = [
    JSON.stringify({ type: "output", stream: "stderr", data: "bm90aWNl" }),
    JSON.stringify({ type: "result", result: { processId: "process-a", exitCode: 3, cancelled: false } }),
  ].join("\n") + "\n";
  const manager = createEnvironmentManagerHttpClient({
    baseUrl: "http://subpolar-manager:8080",
    token: TOKEN,
    allowPrivateHttp: true,
    fetch: (async () => new Response(body, { headers: { "content-type": "application/x-ndjson" } })) as typeof fetch,
  });
  const output: string[] = [];

  await expect(manager.execute({ ownerId: identity.ownerId, workspaceId: identity.workspaceId, storageRoot: identity.storageRoot, worktreePath: identity.worktreePath }, ["tool", "arg"], {
    onOutput: ({ stream, data }) => output.push(`${stream}:${new TextDecoder().decode(data)}`),
  })).resolves.toEqual({ processId: "process-a", exitCode: 3, cancelled: false });
  expect(output).toEqual(["stderr:notice"]);
});

test("manager client rejects URLs with embedded credentials", () => {
  expect(() => createEnvironmentManagerHttpClient({ baseUrl: "http://user:password@manager", token: TOKEN })).toThrow(/cannot contain credentials/);
});

test("manager client rejects redirects on authenticated requests", async () => {
  let redirectMode: RequestRedirect | undefined;
  const manager = createEnvironmentManagerHttpClient({
    baseUrl: "http://127.0.0.1:8787",
    token: TOKEN,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      redirectMode = init?.redirect;
      return Response.json({ ok: true, registeredEnvironmentCount: 0 });
    }) as typeof fetch,
  });

  await expect(manager.status()).resolves.toEqual({ ok: true, registeredEnvironmentCount: 0 });
  expect(redirectMode).toBe("error");
});

test("manager client allows loopback HTTP by default and requires opt-in for private HTTP", () => {
  expect(() => createEnvironmentManagerHttpClient({ baseUrl: "http://127.0.0.1:8787", token: TOKEN })).not.toThrow();
  expect(() => createEnvironmentManagerHttpClient({ baseUrl: "http://localhost:8787", token: TOKEN })).not.toThrow();
  expect(() => createEnvironmentManagerHttpClient({ baseUrl: "http://manager:8787", token: TOKEN })).toThrow(/loopback host/);
  expect(() => createEnvironmentManagerHttpClient({ baseUrl: "http://192.168.1.20:8787", token: TOKEN })).toThrow(/loopback host/);

  expect(() => createEnvironmentManagerHttpClient({
    baseUrl: "http://localhost:8787",
    token: TOKEN,
    allowPrivateHttp: true,
  })).not.toThrow();
  expect(() => createEnvironmentManagerHttpClient({
    baseUrl: "http://subpolar-manager:8787",
    token: TOKEN,
    allowPrivateHttp: true,
  })).not.toThrow();
  expect(() => createEnvironmentManagerHttpClient({
    baseUrl: "http://192.168.1.20:8787",
    token: TOKEN,
    allowPrivateHttp: true,
  })).not.toThrow();
  for (const address of ["100.64.0.1", "100.127.255.254"]) {
    expect(() => createEnvironmentManagerHttpClient({
      baseUrl: `http://${address}:8787`,
      token: TOKEN,
      allowPrivateHttp: true,
    })).not.toThrow();
  }
  expect(() => createEnvironmentManagerHttpClient({
    baseUrl: "http://100.128.0.1:8787",
    token: TOKEN,
    allowPrivateHttp: true,
  })).toThrow(/private IP or the subpolar-manager service host/);
  for (const hostname of ["attacker", "manager.internal", "manager.local", "subpolar-manager.local"]) {
    expect(() => createEnvironmentManagerHttpClient({
      baseUrl: `http://${hostname}:8787`,
      token: TOKEN,
      allowPrivateHttp: true,
    })).toThrow(/private IP or the subpolar-manager service host/);
  }
  expect(() => createEnvironmentManagerHttpClient({
    baseUrl: "http://manager.example.com:8787",
    token: TOKEN,
    allowPrivateHttp: true,
  })).toThrow(/private IP or the subpolar-manager service host/);
  expect(() => createEnvironmentManagerHttpClient({ baseUrl: "https://manager.example.com", token: TOKEN })).not.toThrow();
});

test("manager client resumes and controls a persistent interactive session", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const output = [
    JSON.stringify({ type: "output", sequence: 8, data: "cHJvbXB0" }),
    JSON.stringify({ type: "exit", result: { exitCode: 0, cancelled: false } }),
  ].join("\n") + "\n";
  const manager = createEnvironmentManagerHttpClient({
    baseUrl: "http://subpolar-manager:8080", token: TOKEN, allowPrivateHttp: true,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ url, body });
      if (url.endsWith("/pty/start")) return Response.json({ sessionId: "manager-session", outputSequence: 7 });
      if (url.endsWith("/pty/output")) return new Response(output, { headers: { "content-type": "application/x-ndjson" } });
      return Response.json({ ok: true });
    }) as typeof fetch,
  });
  const request = { ownerId: identity.ownerId, workspaceId: identity.workspaceId, storageRoot: identity.storageRoot, worktreePath: identity.worktreePath };

  const session = await manager.startInteractive(request, ["/bin/sh"], { clientSessionId: "thread-1-terminal-1" });
  await manager.writeInteractive(request, session.sessionId, Buffer.from("ls\n"));
  await manager.resizeInteractive(request, session.sessionId, 120, 40);
  const events = [];
  for await (const event of manager.attachInteractiveOutput(request, session.sessionId, session.outputSequence)) events.push(event);
  await manager.terminateInteractive(request, session.sessionId);

  expect(session).toEqual({ sessionId: "manager-session", outputSequence: 7 });
  expect(events).toEqual([
    { type: "output", sequence: 8, data: Buffer.from("prompt") },
    { type: "exit", result: { exitCode: 0, cancelled: false } },
  ]);
  expect(calls.map(({ url }) => url.split("/").at(-1))).toEqual(["start", "input", "resize", "output", "terminate"]);
  expect(calls[0]?.body.process).toEqual({ clientSessionId: "thread-1-terminal-1" });
  expect(calls[1]?.body.data).toBe("bHMK");
  expect(calls[3]?.body.afterSequence).toBe(7);
});

test("manager client controls a non-TTY process session and preserves stdout/stderr labels", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const body = [
    JSON.stringify({ type: "output", sequence: 1, stream: "stdout", data: "eyJqc29ucnBjIjo=" }),
    JSON.stringify({ type: "output", sequence: 2, stream: "stderr", data: "ZGlhZ25vc3RpYw==" }),
    JSON.stringify({ type: "exit", result: { exitCode: 0, cancelled: false } }),
  ].join("\n") + "\n";
  const manager = createEnvironmentManagerHttpClient({
    baseUrl: "http://subpolar-manager:8080", token: TOKEN, allowPrivateHttp: true,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const requestBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ url, body: requestBody });
      if (url.endsWith("/stdio/start")) return Response.json({ sessionId: "stdio-session", outputSequence: 0 });
      if (url.endsWith("/stdio/output")) return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
      return Response.json({ ok: true });
    }) as typeof fetch,
  });
  const request = { ownerId: identity.ownerId, workspaceId: identity.workspaceId, storageRoot: identity.storageRoot, worktreePath: identity.worktreePath };
  const session = await manager.startManagedSession(request, ["node", "acp-server.js"], { clientSessionId: "thread-1-acp" });
  await manager.writeManagedSession(request, session.sessionId, Buffer.from('{"jsonrpc":"2.0"}\n'));
  const events = [];
  for await (const event of manager.attachManagedSessionOutput(request, session.sessionId, session.outputSequence)) events.push(event);
  await manager.terminateManagedSession(request, session.sessionId);

  expect(session).toEqual({ sessionId: "stdio-session", outputSequence: 0 });
  expect(events).toEqual([
    { type: "output", sequence: 1, stream: "stdout", data: Buffer.from('{"jsonrpc":') },
    { type: "output", sequence: 2, stream: "stderr", data: Buffer.from("diagnostic") },
    { type: "exit", result: { exitCode: 0, cancelled: false } },
  ]);
  expect(calls.map(({ url }) => url.split("/").at(-1))).toEqual(["start", "input", "output", "terminate"]);
  expect(calls[0]?.body.process).toEqual({ clientSessionId: "thread-1-acp" });
  expect(calls[1]?.body.data).toBe(Buffer.from('{"jsonrpc":"2.0"}\n').toString("base64"));
});

test("manager client requests a port tunnel with only the selected port and environment identity", async () => {
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const manager = createEnvironmentManagerHttpClient({
    baseUrl: "http://subpolar-manager:8080",
    token: TOKEN,
    allowPrivateHttp: true,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json({ sessionId: "tcp-session", outputSequence: 0 });
    }) as typeof fetch,
  });
  const request = {
    ownerId: identity.ownerId,
    workspaceId: identity.workspaceId,
    storageRoot: identity.storageRoot,
    worktreePath: identity.worktreePath,
  };

  await expect(manager.startPortTunnel(request, 5173)).resolves.toEqual({ sessionId: "tcp-session", outputSequence: 0 });
  expect(calls).toEqual([{
    url: "http://subpolar-manager:8080/v1/environments/tcp/start",
    authorization: `Bearer ${TOKEN}`,
    body: { environment: request, port: 5173 },
  }]);
});
