// @effect-diagnostics nodeBuiltinImport:off - These tests allocate and clean temporary Node filesystem fixtures.
import { afterEach, expect, it as test } from "@effect/vitest";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExecutionContext, ToolCall } from "@subpolar/shared";
import {
  createWorkerExecutionOptions,
  readWorkerMcpToolDefinitions,
} from "../src/workerExecution.ts";

const roots: string[] = [];

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "subpolar-acp-worker-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function call(input: ToolCall["input"]): ToolCall {
  return { callId: "worker-call", toolId: "internal/worker/execute", input };
}

function context(cwd: string): ExecutionContext {
  return { requestId: "worker-request", principal: { id: "worker", kind: "local" }, cwd };
}

test("worker execution requires its explicit proxy flag and does not use manager configuration", () => {
  expect(createWorkerExecutionOptions({ SUBPOLAR_MANAGER_TOKEN: "manager-secret" })).toEqual({});
  const enabled = createWorkerExecutionOptions({
    SUBPOLAR_ACP_WORKER_MODE: "1",
    SUBPOLAR_MANAGER_URL: "http://unused",
    SUBPOLAR_MANAGER_TOKEN: "manager-secret",
    SUBPOLAR_STORAGE_ROOT: "/unused",
    SUBPOLAR_AGENT_PROFILE_JSON: JSON.stringify({ model: "mock-local", toolPolicies: {} }),
  });
  expect(enabled.profile).toEqual({ model: "mock-local", toolPolicies: {} });
  expect(enabled.toolDefinitions).toMatchObject([{ id: "internal/worker/execute", enabled: true }]);
  expect(enabled.toolDefinitions?.[0]?.id).not.toContain("managed");
  expect(
    createWorkerExecutionOptions({
      SUBPOLAR_ACP_WORKER_MODE: "1",
      SUBPOLAR_T3_MCP_BRIDGE: "1",
    }).toolDefinitions?.map(({ id }) => id),
  ).toEqual(["internal/worker/execute", "internal/t3-mcp/list-tools", "internal/t3-mcp/call-tool"]);
});

test("managed worker accepts only host-brokered MCP tool metadata", () => {
  const definitions = [
    {
      id: "mcp/issue-tracker/search",
      namespace: "issue-tracker",
      description: "Search issues",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      enabled: true,
      risk: "high",
      metadata: { serverId: "issue-tracker" },
    },
  ];
  const environment = {
    SUBPOLAR_ACP_WORKER_MODE: "1",
    SUBPOLAR_MCP_TOOL_DEFINITIONS: JSON.stringify(definitions),
    SUBPOLAR_MCP_HEADER_ISSUES: "must-not-be-used-in-worker",
    SUBPOLAR_MCP_SERVERS: "must-not-be-used-in-worker",
  };
  expect(readWorkerMcpToolDefinitions(environment)).toEqual(definitions);
  expect(createWorkerExecutionOptions(environment).toolDefinitions).toContainEqual(definitions[0]);
  expect(() => readWorkerMcpToolDefinitions({ SUBPOLAR_MCP_TOOL_DEFINITIONS: "not-json" })).toThrow(
    /valid JSON/,
  );
  expect(() =>
    readWorkerMcpToolDefinitions({
      SUBPOLAR_MCP_TOOL_DEFINITIONS: JSON.stringify([{ ...definitions[0], id: "mcp/invalid" }]),
    }),
  ).toThrow(/canonical and unique/);
});

test("worker execute runs argv in the mounted workspace with bounded output", async () => {
  const root = await workspace();
  const subdirectory = path.join(root, "packages");
  await mkdir(subdirectory);
  const options = createWorkerExecutionOptions(
    { SUBPOLAR_ACP_WORKER_MODE: "1" },
    { workspaceRoot: root },
  );
  const workingDirectory = await options.executeTool!(
    call({ command: ["pwd"], cwd: "packages" }),
    options.toolDefinitions![0]!,
    context(root),
  );
  expect(workingDirectory).toMatchObject({
    ok: true,
    value: { stdout: `${await realpath(subdirectory)}\n`, exitCode: 0 },
  });
  const response = await options.executeTool!(
    call({
      command: ["node", "-e", "process.stdout.write('x'.repeat(140000))"],
      cwd: "packages",
    }),
    options.toolDefinitions![0]!,
    context(root),
  );

  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect(response.value).toMatchObject({ exitCode: 0, cancelled: false, outputTruncated: true });
  const output = response.value as { stdout: string; stderr: string };
  expect(output.stdout.startsWith("x")).toBe(true);
  expect(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr)).toBeLessThanOrEqual(
    128 * 1024,
  );
});

test("worker execute rejects cwd traversal and symlink escapes", async () => {
  const root = await workspace();
  const outside = await workspace();
  const link = path.join(root, "outside-link");
  await symlink(outside, link);
  const options = createWorkerExecutionOptions(
    { SUBPOLAR_ACP_WORKER_MODE: "1" },
    { workspaceRoot: root },
  );
  const definition = options.toolDefinitions![0]!;

  await expect(
    options.executeTool!(call({ command: ["pwd"], cwd: "../outside" }), definition, context(root)),
  ).resolves.toMatchObject({ ok: false, error: { code: "WORKSPACE_CWD_INVALID" } });
  await expect(
    options.executeTool!(
      call({ command: ["pwd"], cwd: "outside-link" }),
      definition,
      context(root),
    ),
  ).resolves.toMatchObject({ ok: false, error: { code: "WORKSPACE_CWD_INVALID" } });
});

test("worker execute omits manager credentials from child processes", async () => {
  const root = await workspace();
  const options = createWorkerExecutionOptions(
    {
      SUBPOLAR_ACP_WORKER_MODE: "1",
      SUBPOLAR_MANAGER_TOKEN: "must-not-be-forwarded",
      SUBPOLAR_MANAGER_URL: "http://manager",
      SUBPOLAR_STORAGE_ROOT: "/workspaces",
    },
    { workspaceRoot: root },
  );
  const response = await options.executeTool!(
    call({
      command: [
        "node",
        "-e",
        "console.log(['SUBPOLAR_MANAGER_TOKEN','SUBPOLAR_MANAGER_URL','SUBPOLAR_STORAGE_ROOT'].some(key => key in process.env))",
      ],
    }),
    options.toolDefinitions![0]!,
    context(root),
  );

  expect(response).toMatchObject({ ok: true, value: { stdout: "false\n", exitCode: 0 } });
});

test("agent-launched commands cannot read host-side MCP credentials or configuration", async () => {
  const root = await workspace();
  const previousHeader = process.env.SUBPOLAR_MCP_HEADER_ISSUES;
  const previousConfig = process.env.SUBPOLAR_MCP_SERVERS;
  process.env.SUBPOLAR_MCP_HEADER_ISSUES = "host-only-secret";
  process.env.SUBPOLAR_MCP_SERVERS = '[{"id":"issue-tracker"}]';
  try {
    const options = createWorkerExecutionOptions(
      { SUBPOLAR_ACP_WORKER_MODE: "1" },
      { workspaceRoot: root },
    );
    const response = await options.executeTool!(
      call({
        command: [
          "node",
          "-e",
          "console.log(Object.keys(process.env).some(key => key.startsWith('SUBPOLAR_MCP_')))",
        ],
      }),
      options.toolDefinitions![0]!,
      context(root),
    );
    expect(response).toMatchObject({ ok: true, value: { stdout: "false\n", exitCode: 0 } });
  } finally {
    if (previousHeader === undefined) delete process.env.SUBPOLAR_MCP_HEADER_ISSUES;
    else process.env.SUBPOLAR_MCP_HEADER_ISSUES = previousHeader;
    if (previousConfig === undefined) delete process.env.SUBPOLAR_MCP_SERVERS;
    else process.env.SUBPOLAR_MCP_SERVERS = previousConfig;
  }
});

test("worker execute terminates a running process when its tool call is cancelled", async () => {
  const root = await workspace();
  const controller = new AbortController();
  const options = createWorkerExecutionOptions(
    { SUBPOLAR_ACP_WORKER_MODE: "1" },
    {
      workspaceRoot: root,
      onSpawn: (child) => child.once("spawn", () => controller.abort()),
    },
  );
  const response = await options.executeTool!(
    call({
      command: ["node", "-e", "setInterval(() => {}, 1000)"],
    }),
    options.toolDefinitions![0]!,
    context(root),
    controller.signal,
  );

  expect(response).toMatchObject({ ok: true, value: { cancelled: true, exitCode: null } });
});

test("worker execute rejects attempts to inject manager credentials", async () => {
  const root = await workspace();
  const options = createWorkerExecutionOptions(
    { SUBPOLAR_ACP_WORKER_MODE: "1" },
    { workspaceRoot: root },
  );
  const response = await options.executeTool!(
    call({
      command: ["node", "-e", "process.exit(0)"],
      environment: { SUBPOLAR_MANAGER_TOKEN: "attempted-injection" },
    }),
    options.toolDefinitions![0]!,
    context(root),
  );

  expect(response).toMatchObject({ ok: false, error: { code: "PROCESS_REQUEST_INVALID" } });
});
