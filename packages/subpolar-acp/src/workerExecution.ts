import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { canonicalizeToolId } from "@subpolar/tools";
import type { ExecutionContext, ToolCall, ToolDefinition, ToolExecutor } from "@subpolar/shared";
import type { SubpolarAcpOptions } from "./index.ts";
import { readSubpolarAgentProfile } from "./agentProfile.ts";

const MAX_CAPTURED_OUTPUT_BYTES = 128 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const ENVIRONMENT_KEYS = new Set([
  "COLORTERM",
  "EDITOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER",
]);

export interface WorkerExecutionDependencies {
  readonly workspaceRoot?: string;
  readonly onSpawn?: (child: ChildProcess) => void;
}

export const MCP_TOOL_CATALOG_ENV = "SUBPOLAR_MCP_TOOL_DEFINITIONS";
const MAX_MCP_TOOL_CATALOG_BYTES = 64_000;

export function readWorkerMcpToolDefinitions(
  environment: NodeJS.ProcessEnv,
): readonly ToolDefinition[] {
  const value = environment[MCP_TOOL_CATALOG_ENV];
  if (value === undefined) return [];
  if (Buffer.byteLength(value) > MAX_MCP_TOOL_CATALOG_BYTES)
    throw new Error("Managed MCP tool catalog exceeds its size limit");
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("Managed MCP tool catalog must be valid JSON");
  }
  if (!Array.isArray(decoded) || decoded.length > 100)
    throw new Error("Managed MCP tool catalog must be a bounded JSON array");
  const ids = new Set<string>();
  return decoded.map((item): ToolDefinition => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Managed MCP tool definition is invalid");
    const definition = item as Record<string, unknown>;
    const id = canonicalizeToolId(definition.id, { adapter: "mcp" });
    if (id !== definition.id || ids.has(id))
      throw new Error("Managed MCP tool IDs must be canonical and unique");
    ids.add(id);
    if (
      typeof definition.namespace !== "string" ||
      typeof definition.description !== "string" ||
      typeof definition.enabled !== "boolean" ||
      !definition.inputSchema ||
      typeof definition.inputSchema !== "object" ||
      Array.isArray(definition.inputSchema)
    ) {
      throw new Error("Managed MCP tool definition is incomplete");
    }
    return {
      id,
      namespace: definition.namespace,
      description: definition.description.slice(0, 8_192),
      inputSchema: definition.inputSchema as ToolDefinition["inputSchema"],
      enabled: definition.enabled,
      risk: "high",
      ...(definition.metadata &&
      typeof definition.metadata === "object" &&
      !Array.isArray(definition.metadata)
        ? { metadata: definition.metadata as Record<string, string> }
        : {}),
    };
  });
}

function makeDefinition(): ToolDefinition {
  return {
    id: "internal/worker/execute",
    namespace: "worker",
    description: "Run an approved command in this isolated worktree and return its output.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "array",
          minItems: 1,
          maxItems: 256,
          items: { type: "string", minLength: 1 },
        },
        cwd: { type: "string" },
        environment: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["command"],
      additionalProperties: false,
    } as ToolDefinition["inputSchema"],
    enabled: true,
    risk: "high",
  };
}

function makeT3McpDefinitions(): readonly ToolDefinition[] {
  return [
    {
      id: "internal/t3-mcp/list-tools",
      namespace: "t3",
      description:
        "List the T3 Code MCP tools authorized for this provider session. Use the exact returned name with call_mcp_tool.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      enabled: true,
      risk: "high",
    },
    {
      id: "internal/t3-mcp/call-tool",
      namespace: "t3",
      description:
        "Call one exact T3 Code MCP tool authorized for this provider session, using its returned name and input arguments.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 256 },
          arguments: { type: "object", additionalProperties: true },
        },
        required: ["name", "arguments"],
        additionalProperties: false,
      } as ToolDefinition["inputSchema"],
      enabled: true,
      risk: "high",
    },
  ];
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function workerEnvironment(
  overrides: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ||
      value.includes("\0") ||
      value.length > 16_384
    ) {
      throw new Error("Process environment contains an invalid key or value");
    }
    if (
      key === "SUBPOLAR_MANAGER_TOKEN" ||
      key === "SUBPOLAR_MANAGER_URL" ||
      key === "SUBPOLAR_STORAGE_ROOT"
    ) {
      throw new Error(
        "Worker commands cannot receive environment-manager credentials or configuration",
      );
    }
    environment[key] = value;
  }
  return environment;
}

async function workspaceCwd(root: string, requested: string | undefined): Promise<string> {
  if (requested !== undefined && (path.isAbsolute(requested) || requested.includes("\0"))) {
    throw new Error("Command cwd must be relative to the mounted worktree");
  }
  const candidate = path.resolve(root, requested ?? ".");
  if (!within(root, candidate)) throw new Error("Command cwd escapes the mounted worktree");
  const resolved = await realpath(candidate);
  if (!within(root, resolved) || !(await lstat(resolved)).isDirectory()) {
    throw new Error("Command cwd must resolve to a directory inside the mounted worktree");
  }
  return resolved;
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    if (!child.killed) child.kill(signal);
  }
}

async function executeLocal(
  call: ToolCall,
  context: ExecutionContext,
  signal: AbortSignal | undefined,
  dependencies: WorkerExecutionDependencies,
) {
  const input = call.input as {
    command: string[];
    cwd?: string;
    environment?: Record<string, string>;
  };
  if (
    !Array.isArray(input.command) ||
    input.command.length === 0 ||
    input.command.length > 256 ||
    input.command.some(
      (part) => typeof part !== "string" || part.length === 0 || part.includes("\0"),
    )
  ) {
    return {
      ok: false as const,
      error: {
        code: "PROCESS_REQUEST_INVALID",
        message: "Command must be a non-empty argv array without NUL bytes",
      },
    };
  }
  if (signal?.aborted)
    return {
      ok: true as const,
      value: { exitCode: null, cancelled: true, stdout: "", stderr: "", outputTruncated: false },
    };

  let root: string;
  let cwd: string;
  let commandEnvironment: NodeJS.ProcessEnv;
  try {
    commandEnvironment = workerEnvironment(input.environment);
  } catch (error) {
    return {
      ok: false as const,
      error: {
        code: "PROCESS_REQUEST_INVALID",
        message: error instanceof Error ? error.message : "Process environment is invalid",
      },
    };
  }
  try {
    root = await realpath(dependencies.workspaceRoot ?? process.cwd());
    if (!path.isAbsolute(root) || !context.cwd || !path.isAbsolute(context.cwd))
      throw new Error("Worker session cwd is unavailable");
    const sessionRoot = await realpath(context.cwd);
    if (!within(root, sessionRoot))
      throw new Error("Worker session cwd is outside the mounted worktree");
    cwd = await workspaceCwd(sessionRoot, input.cwd);
  } catch (error) {
    return {
      ok: false as const,
      error: {
        code: "WORKSPACE_CWD_INVALID",
        message: error instanceof Error ? error.message : "Worker cwd is invalid",
      },
    };
  }

  return new Promise<
    | {
        ok: true;
        value: {
          processId?: string;
          exitCode: number | null;
          cancelled: boolean;
          stdout: string;
          stderr: string;
          outputTruncated: boolean;
        };
      }
    | { ok: false; error: { code: string; message: string } }
  >((resolve) => {
    const child = nodeSpawn(input.command[0]!, input.command.slice(1), {
      cwd,
      env: commandEnvironment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    dependencies.onSpawn?.(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let truncated = false;
    let cancelled = signal?.aborted ?? false;
    let settled = false;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const remaining = MAX_CAPTURED_OUTPUT_BYTES - captured;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const kept = chunk.subarray(0, remaining);
      (stream === "stdout" ? stdout : stderr).push(kept);
      captured += kept.byteLength;
      if (kept.byteLength !== chunk.byteLength) truncated = true;
    };
    child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
    const onAbort = () => {
      cancelled = true;
      signalProcessGroup(child, "SIGTERM");
      escalationTimer = setTimeout(
        () => signalProcessGroup(child, "SIGKILL"),
        TERMINATION_GRACE_MS,
      );
      escalationTimer.unref();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (cancelled) onAbort();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (escalationTimer) clearTimeout(escalationTimer);
      resolve({
        ok: false,
        error: {
          code: "PROCESS_START_FAILED",
          message: `Worker command could not start: ${error.message}`,
        },
      });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (escalationTimer) clearTimeout(escalationTimer);
      resolve({
        ok: true,
        value: {
          ...(child.pid === undefined ? {} : { processId: String(child.pid) }),
          exitCode: cancelled ? null : code,
          cancelled,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          outputTruncated: truncated,
        },
      });
    });
  });
}

/** Enable a credential-free execute tool only for a proxy-started worker. */
export function createWorkerExecutionOptions(
  environment: NodeJS.ProcessEnv,
  dependencies: WorkerExecutionDependencies = {},
): Pick<
  SubpolarAcpOptions,
  "workerMode" | "principalId" | "toolDefinitions" | "executeTool" | "sessionCwd" | "profile"
> {
  if (environment.SUBPOLAR_ACP_WORKER_MODE !== "1") return {};
  const definition = makeDefinition();
  const mcpDefinitions = readWorkerMcpToolDefinitions(environment);
  const t3McpDefinitions = environment.SUBPOLAR_T3_MCP_BRIDGE === "1" ? makeT3McpDefinitions() : [];
  const profile = readSubpolarAgentProfile(environment);
  const executeTool: ToolExecutor = (call, _definition, context, signal) =>
    executeLocal(call, context, signal, dependencies);
  return {
    workerMode: true,
    principalId: "subpolar-worker",
    sessionCwd: () => dependencies.workspaceRoot ?? process.cwd(),
    ...(profile === undefined ? {} : { profile }),
    toolDefinitions: [definition, ...t3McpDefinitions, ...mcpDefinitions],
    executeTool,
  };
}
