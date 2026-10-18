import { expect, test } from "bun:test";
import { createManagedExecutionOptions } from "../src/managedExecution.ts";
import type { ExecutionContext, ToolCall } from "@subpolar/shared";

const environment = {
  SUBPOLAR_MANAGER_URL: "http://subpolar-manager:8080",
  SUBPOLAR_MANAGER_TOKEN: "managed-execution-test-token-with-more-than-thirty-two-characters",
  SUBPOLAR_MANAGER_ALLOW_PRIVATE_HTTP: "true",
  SUBPOLAR_STORAGE_ROOT: "/workspaces",
  SUBPOLAR_OWNER_ID: "t3-installation-test",
};

test("managed execution is absent when manager configuration is unset and rejects partial setup", () => {
  expect(createManagedExecutionOptions({})).toEqual({});
  expect(() => createManagedExecutionOptions({ SUBPOLAR_MANAGER_URL: environment.SUBPOLAR_MANAGER_URL })).toThrow(/requires SUBPOLAR_MANAGER_URL/);
});

test("managed execution routes only the approved argv tool through the manager client", async () => {
  let seen: { url: string; authorization: string | null; body: Record<string, unknown> } | undefined;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = {
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    const output = JSON.stringify({ type: "output", stream: "stdout", data: "aGVsbG8=" });
    const result = JSON.stringify({ type: "result", result: { processId: "p1", exitCode: 0, cancelled: false } });
    return new Response(`${output}\n${result}\n`, { headers: { "content-type": "application/x-ndjson" } });
  }) as typeof fetch;
  const options = createManagedExecutionOptions(environment, fetcher);
  expect(options.toolDefinitions).toHaveLength(1);
  expect(options.toolDefinitions?.[0]).toMatchObject({ id: "internal/managed/execute", enabled: true });

  const call: ToolCall = {
    callId: "call-1",
    toolId: "internal/managed/execute",
    input: { command: ["node", "-e", "console.log('hello')"], cwd: "packages" },
  };
  const context: ExecutionContext = {
    requestId: "request-1",
    principal: { id: environment.SUBPOLAR_OWNER_ID, kind: "local" },
    cwd: "/workspaces/project-a",
  };
  const response = await options.executeTool!(call, options.toolDefinitions![0], context);
  expect(response).toEqual({
    ok: true,
    value: { processId: "p1", exitCode: 0, cancelled: false, stdout: "hello", stderr: "", outputTruncated: false },
  });
  expect(seen).toEqual({
    url: "http://subpolar-manager:8080/v1/environments/execute",
    authorization: `Bearer ${environment.SUBPOLAR_MANAGER_TOKEN}`,
    body: {
      environment: {
        ownerId: environment.SUBPOLAR_OWNER_ID,
        workspaceId: expect.stringMatching(/^ws_[a-f0-9]{24}$/),
        storageRoot: "/workspaces",
        worktreePath: "/workspaces/project-a",
      },
      command: ["node", "-e", "console.log('hello')"],
      process: { cwd: "packages" },
    },
  });
});

test("managed execution fails closed when T3 does not supply an absolute worktree", async () => {
  const options = createManagedExecutionOptions(environment, (async () => { throw new Error("network should not be reached"); }) as typeof fetch);
  const response = await options.executeTool!({ callId: "call-1", toolId: "internal/managed/execute", input: { command: ["pwd"] } }, options.toolDefinitions![0], {
    requestId: "request-1",
    principal: { id: environment.SUBPOLAR_OWNER_ID, kind: "local" },
  });
  expect(response).toMatchObject({ ok: false, error: { code: "WORKTREE_UNAVAILABLE" } });
});

test("manager unavailability returns an error without host process fallback", async () => {
  const options = createManagedExecutionOptions(environment, (async () => { throw new Error("manager unavailable"); }) as typeof fetch);
  const response = await options.executeTool!({
    callId: "call-1",
    toolId: "internal/managed/execute",
    input: { command: ["touch", "/tmp/should-not-run"] },
  }, options.toolDefinitions![0], {
    requestId: "request-1",
    principal: { id: environment.SUBPOLAR_OWNER_ID, kind: "local" },
    cwd: "/workspaces/project-a",
  });
  expect(response).toMatchObject({ ok: false, error: { code: "MANAGED_PROCESS_FAILED" } });
});
