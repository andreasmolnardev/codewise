import { createHash } from "node:crypto";
import path from "node:path";

import { createEnvironmentManagerHttpClient } from "@subpolar/environments/manager-client";
import type { ToolDefinition, ToolExecutor } from "@subpolar/shared";
import type { SubpolarAcpOptions } from "./index.ts";

const MAX_CAPTURED_OUTPUT_BYTES = 128 * 1024;

/** Enable the approved managed-exec tool only when all manager settings exist. */
export function createManagedExecutionOptions(
  environment: NodeJS.ProcessEnv,
  fetcher?: typeof fetch,
): Pick<SubpolarAcpOptions, "principalId" | "toolDefinitions" | "executeTool"> {
  const managerUrl = environment.SUBPOLAR_MANAGER_URL;
  const managerToken = environment.SUBPOLAR_MANAGER_TOKEN;
  const storageRoot = environment.SUBPOLAR_STORAGE_ROOT;
  const ownerId = environment.SUBPOLAR_OWNER_ID ?? "t3-installation";
  const configured = [managerUrl, managerToken, storageRoot].filter(Boolean).length;
  if (configured === 0) return {};
  if (configured !== 3) {
    throw new Error("Managed ACP execution requires SUBPOLAR_MANAGER_URL, SUBPOLAR_MANAGER_TOKEN, and SUBPOLAR_STORAGE_ROOT");
  }

  const manager = createEnvironmentManagerHttpClient({
    baseUrl: managerUrl!,
    token: managerToken!,
    allowPrivateHttp: environment.SUBPOLAR_MANAGER_ALLOW_PRIVATE_HTTP === "true",
    ...(fetcher === undefined ? {} : { fetch: fetcher }),
  });
  const definition: ToolDefinition = {
    id: "internal/managed/execute",
    adapter: "internal",
    namespace: "managed",
    name: "execute",
    description: "Run an approved command in the isolated worktree environment and return its output.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "array", minItems: 1, maxItems: 256, items: { type: "string", minLength: 1 } },
        cwd: { type: "string" },
        environment: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["command"],
      additionalProperties: false,
    },
    enabled: true,
  };
  const executeTool: ToolExecutor = async (call, _definition, context, signal) => {
    const input = call.input as { command: string[]; cwd?: string; environment?: Record<string, string> };
    const worktreePath = context.cwd;
    if (!worktreePath || !path.isAbsolute(worktreePath)) {
      return { ok: false, error: { code: "WORKTREE_UNAVAILABLE", message: "T3 did not provide an absolute worktree path" } };
    }
    const workspaceId = `ws_${createHash("sha256").update(path.resolve(worktreePath)).digest("hex").slice(0, 24)}`;
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let capturedBytes = 0;
    let truncated = false;
    try {
      const result = await manager.execute({ ownerId, workspaceId, storageRoot: storageRoot!, worktreePath }, input.command, {
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.environment === undefined ? {} : { environment: input.environment }),
        ...(signal === undefined ? {} : { signal }),
        onOutput: ({ stream, data }) => {
          const remaining = MAX_CAPTURED_OUTPUT_BYTES - capturedBytes;
          if (remaining <= 0) {
            truncated = true;
            return;
          }
          const chunk = data.byteLength > remaining ? data.slice(0, remaining) : data;
          (stream === "stdout" ? stdout : stderr).push(chunk);
          capturedBytes += chunk.byteLength;
          if (chunk.byteLength !== data.byteLength) truncated = true;
        },
      });
      const decode = (chunks: readonly Uint8Array[]) => new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
      return { ok: true, value: { ...result, stdout: decode(stdout), stderr: decode(stderr), outputTruncated: truncated } };
    } catch {
      return { ok: false, error: { code: "MANAGED_PROCESS_FAILED", message: "The managed process could not be completed" } };
    }
  };

  return { principalId: ownerId, toolDefinitions: [definition], executeTool };
}
