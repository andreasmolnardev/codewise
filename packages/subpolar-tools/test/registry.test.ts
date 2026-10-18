import { describe, expect, test } from "bun:test";
import {
  canonicalToolId,
  canonicalizeToolId,
  createToolRegistry,
  ownerScopedMcpCacheKey,
  type ToolAdapter,
  type ToolAuthorization,
} from "../src/index.ts";

const echoAdapter: ToolAdapter = {
  kind: "internal",
  execute: async ({ call }) => ({ echoed: call.input }),
};

function thrownCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return (error as { code?: string }).code ?? "";
  }
  return "";
}

function echoDefinition() {
  return {
    adapter: "internal",
    namespace: "core",
    name: "echo",
    inputSchema: {
      type: "object" as const,
      properties: { value: { type: "string" as const } },
      required: ["value"],
      additionalProperties: false,
    },
  };
}

describe("@subpolar/tools registry", () => {
  test("scopes MCP connection cache keys to a trusted owner", () => {
    expect(ownerScopedMcpCacheKey("user-1", "https://mcp.example/server")).toBe(
      ownerScopedMcpCacheKey("user-1", "https://mcp.example/server"),
    );
    expect(ownerScopedMcpCacheKey("user-1", "https://mcp.example/server")).not.toBe(
      ownerScopedMcpCacheKey("user-2", "https://mcp.example/server"),
    );
    expect(thrownCode(() => ownerScopedMcpCacheKey("", "https://mcp.example/server"))).toBe("MCP_OWNER_REQUIRED");
    expect(thrownCode(() => ownerScopedMcpCacheKey("user-1", " "))).toBe("MCP_SERVER_KEY_REQUIRED");
  });

  test("does not execute MCP calls until the host policy explicitly allows them", async () => {
    let executions = 0;
    const registry = createToolRegistry({
      adapters: [{ kind: "mcp", execute: async () => { executions += 1; return "called"; } }],
    });
    registry.registerTool({ adapter: "mcp", namespace: "remote", name: "read" });

    const result = await registry.execute({ callId: "mcp-denied", toolId: "mcp/remote/read", input: {} });

    expect(result).toMatchObject({ ok: false, error: { code: "POLICY_DENIED" } });
    expect(executions).toBe(0);
  });

  test("registers adapters and tools under a canonical ID", async () => {
    const registry = createToolRegistry({
      adapters: [echoAdapter],
      policy: () => ({ kind: "allow", reason: "test policy" }),
    });
    const definition = registry.registerTool(echoDefinition());

    expect(definition.id).toBe("internal/core/echo");
    expect(registry.get("core/echo")?.id).toBe("internal/core/echo");
    expect(registry.list()).toHaveLength(1);

    const result = await registry.execute({ callId: "call-1", toolId: "core/echo", input: { value: "ok" } });
    expect(result).toEqual({ ok: true, value: { echoed: { value: "ok" } } });
  });

  test("canonicalizes supported ID spellings and rejects malformed IDs", () => {
    expect(canonicalizeToolId("MCP://GitHub/ListIssues")).toBe("mcp/github/listissues");
    expect(canonicalToolId("echo", { adapter: "internal", namespace: "Core" })).toBe("internal/core/echo");
    expect(canonicalizeToolId("browser:chrome/open_page")).toBe("browser/chrome/open_page");
    expect(thrownCode(() => canonicalizeToolId("internal//echo"))).toBe("INVALID_TOOL_ID");
  });

  test("rejects an unknown adapter instead of silently treating it as internal", () => {
    const registry = createToolRegistry();
    expect(thrownCode(() => registry.registerAdapter({ kind: "pocketbase", execute: async () => undefined }))).toBe("UNKNOWN_ADAPTER");
    expect(thrownCode(() => registry.registerTool({ adapter: "pocketbase", namespace: "data", name: "read" }))).toBe("UNKNOWN_ADAPTER");
  });

  test("validates input before policy and adapter execution", async () => {
    let policyCalls = 0;
    let executions = 0;
    const registry = createToolRegistry({
      adapters: [{ kind: "internal", execute: async () => { executions += 1; return "ran"; } }],
      policy: () => { policyCalls += 1; return { kind: "allow" }; },
    });
    registry.registerTool(echoDefinition());

    const result = await registry.execute({ callId: "call-invalid", toolId: "internal/core/echo", input: {} });

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_TOOL_INPUT" } });
    expect(policyCalls).toBe(0);
    expect(executions).toBe(0);
  });

  test("does not allow execution to bypass policy or manufacture authorization", async () => {
    let executions = 0;
    const registry = createToolRegistry({
      adapters: [{ kind: "internal", execute: async () => { executions += 1; return "should not run"; } }],
      policy: () => ({ kind: "deny", reason: "not allowed" }),
    });
    registry.registerTool({ adapter: "internal", namespace: "secure", name: "write" });

    const denied = await registry.execute({ callId: "call-denied", toolId: "secure/write", input: {} });
    const forged = await registry.invokeAuthorized({
      call: { callId: "call-forged", toolId: "internal/secure/write", input: {} },
      definition: registry.get("secure/write")!,
      context: {},
    } as ToolAuthorization);

    expect(denied).toMatchObject({ ok: false, error: { code: "POLICY_DENIED" } });
    expect(forged).toEqual({ ok: false, error: { code: "AUTHORIZATION_REQUIRED", message: "A registry-issued authorization is required" } });
    expect(executions).toBe(0);
  });

  test("invokes a registry-issued authorization without re-running policy", async () => {
    let policyCalls = 0;
    let executions = 0;
    const registry = createToolRegistry({
      adapters: [{ kind: "memory", execute: async () => { executions += 1; return { stored: true }; } }],
      policy: () => { policyCalls += 1; return { kind: "allow" }; },
    });
    registry.registerTool({ adapter: "memory", namespace: "notes", name: "save" });

    const authorization = await registry.authorize({ callId: "call-authorized", toolId: "memory/notes/save", input: {} }, { requestId: "request-1" });
    const result = await registry.invokeAuthorized(authorization);

    expect(result).toEqual({ ok: true, value: { stored: true } });
    expect(policyCalls).toBe(1);
    expect(executions).toBe(1);
  });
});
