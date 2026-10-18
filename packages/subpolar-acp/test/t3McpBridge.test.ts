import { expect, test } from "bun:test";
import { callT3Mcp } from "../src/t3McpBridge.ts";

test("T3 MCP bridge keeps its provider credential and MCP session on every request", async () => {
  const requests: Array<{ method: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    if (init?.method === "DELETE") {
      requests.push({ method: "DELETE", headers, body: {} });
      return new Response(null, { status: 204 });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ method: String(body.method), headers, body });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = body.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: {} }
      : { tools: [{ name: "thread_read", inputSchema: { type: "object" } }] };
    return Response.json({ jsonrpc: "2.0", id: body.id, result }, {
      headers: { "mcp-session-id": "provider-session-1" },
    });
  };

  const result = await callT3Mcp({
    endpoint: "http://127.0.0.1:4312/mcp",
    authorization: "Bearer provider-instance-token",
  }, "tools/list", {}, fetcher);

  expect(result).toEqual({ tools: [{ name: "thread_read", inputSchema: { type: "object" } }] });
  expect(requests.map((request) => request.method)).toEqual([
    "initialize",
    "notifications/initialized",
    "tools/list",
    "DELETE",
  ]);
  expect(requests.every((request) => request.headers.get("authorization") === "Bearer provider-instance-token")).toBe(true);
  expect(requests[1]?.headers.get("mcp-session-id")).toBe("provider-session-1");
  expect(requests[2]?.headers.get("mcp-session-id")).toBe("provider-session-1");
  expect(requests[2]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
  expect(requests[3]?.headers.get("mcp-session-id")).toBe("provider-session-1");
  expect(requests[3]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
});

test("T3 MCP bridge returns exact tool results and fails on tool errors", async () => {
  const deletedSessions: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    if (init?.method === "DELETE") {
      deletedSessions.push(new Headers(init.headers).get("mcp-session-id") ?? "");
      return new Response(null, { status: 204 });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/call" && (body.params as { name?: string } | undefined)?.name === "failure") {
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "denied" } });
    }
    const result = body.method === "initialize"
      ? { protocolVersion: "2025-06-18" }
      : { content: [{ type: "text", text: "authorized result" }] };
    return Response.json({ jsonrpc: "2.0", id: body.id, result }, {
      ...(body.method === "initialize" ? { headers: { "mcp-session-id": "provider-session-call" } } : {}),
    });
  };

  await expect(callT3Mcp({ endpoint: "http://127.0.0.1:4312/mcp", authorization: "Bearer scoped" }, "tools/call", {
    name: "thread_read",
    arguments: { threadId: "thread-1" },
  }, fetcher)).resolves.toEqual({ content: [{ type: "text", text: "authorized result" }] });
  await expect(callT3Mcp({ endpoint: "http://127.0.0.1:4312/mcp", authorization: "Bearer scoped" }, "tools/call", {
    name: "failure",
    arguments: {},
  }, fetcher)).rejects.toThrow("T3 MCP request failed");
  expect(deletedSessions).toEqual(["provider-session-call", "provider-session-call"]);
});

test("T3 MCP bridge follows tool-list cursors inside the authenticated session", async () => {
  let listPage = 0;
  const sessions: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const sessionId = headers.get("mcp-session-id");
    if (body.method === "tools/list" && sessionId) sessions.push(sessionId);
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = body.method === "initialize"
      ? { protocolVersion: "2025-06-18" }
      : ++listPage === 1
        ? { tools: [{ name: "first" }], nextCursor: "page-2" }
        : { tools: [{ name: "second" }] };
    return Response.json({ jsonrpc: "2.0", id: body.id, result }, {
      headers: { "mcp-session-id": "provider-session-2" },
    });
  };
  await expect(callT3Mcp({ endpoint: "http://127.0.0.1:4312/mcp", authorization: "Bearer scoped" }, "tools/list", {}, fetcher))
    .resolves.toEqual({ tools: [{ name: "first" }, { name: "second" }] });
  expect(sessions).toEqual(["provider-session-2", "provider-session-2"]);
});

test("T3 MCP bridge forwards cancellation and bounds response buffering", async () => {
  const signals: AbortSignal[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (init?.signal instanceof AbortSignal) signals.push(init.signal);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } });
    }
    return new Response(new Uint8Array(16 * 1024 * 1024 + 1), {
      headers: { "content-type": "application/json" },
    });
  };
  const controller = new AbortController();
  await expect(callT3Mcp({ endpoint: "http://127.0.0.1:4312/mcp", authorization: "Bearer scoped" }, "tools/list", {}, fetcher, controller.signal))
    .rejects.toThrow("size limit");
  expect(signals.length).toBe(3);
  expect(signals.every((signal) => signal.aborted === false)).toBe(true);

  controller.abort();
  await expect(callT3Mcp({ endpoint: "http://127.0.0.1:4312/mcp", authorization: "Bearer scoped" }, "tools/list", {}, fetcher, controller.signal))
    .rejects.toMatchObject({ name: "AbortError" });
});
