import * as Effect from "effect/Effect";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_LIST_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const SESSION_CLOSE_TIMEOUT_MS = 5_000;

export interface T3McpBridgeConnection {
  readonly endpoint: string;
  readonly authorization: string;
}

interface JsonRpcResponse {
  readonly id?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}

async function responsePayloads(response: Response): Promise<{ readonly payloads: readonly unknown[]; readonly byteLength: number }> {
  if (response.status === 202 || response.status === 204) {
    await response.body?.cancel().catch(() => undefined);
    return { payloads: [], byteLength: 0 };
  }
  const reader = response.body?.getReader();
  if (!reader) return { payloads: [], byteLength: 0 };
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel("T3 MCP response exceeded the size limit");
        throw new Error("T3 MCP response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  if (!text.trim()) return { payloads: [], byteLength };
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return { payloads: [JSON.parse(text) as unknown], byteLength };
  }
  const payloads = text.split(/\r?\n\r?\n/u)
    .flatMap((event) => {
      const data = event.split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      return data ? [JSON.parse(data) as unknown] : [];
    });
  return { payloads, byteLength };
}

function asResponse(value: unknown): JsonRpcResponse | undefined {
  return typeof value === "object" && value !== null ? value as JsonRpcResponse : undefined;
}

function protocolVersion(value: unknown): string | undefined {
  const result = asResponse(value)?.result;
  if (!result || typeof result !== "object") return undefined;
  const version = (result as { protocolVersion?: unknown }).protocolVersion;
  return typeof version === "string" ? version : undefined;
}

/** Uses the provider-scoped T3 credential kept by the ACP gateway process. */
export async function callT3Mcp(
  connection: T3McpBridgeConnection,
  method: "tools/list" | "tools/call",
  params: Readonly<Record<string, unknown>>,
  fetchImplementation: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  let sessionId: string | undefined;
  let negotiatedVersion: string | undefined;
  let nextId = 0;

  const send = async (message: unknown): Promise<readonly unknown[]> => {
    if (signal?.aborted) throw signal.reason ?? new DOMException("T3 MCP request was aborted", "AbortError");
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new Error("T3 MCP request exceeded the size limit");
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetchImplementation(connection.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: connection.authorization,
        ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
        ...(negotiatedVersion === undefined ? {} : { "mcp-protocol-version": negotiatedVersion }),
      },
      body,
      signal: requestSignal,
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`T3 MCP endpoint returned HTTP ${response.status}`);
    }
    const decoded = await responsePayloads(response);
    for (const payload of decoded.payloads) negotiatedVersion = protocolVersion(payload) ?? negotiatedVersion;
    return decoded.payloads;
  };

  const closeSession = async () => {
    if (!sessionId) return;
    try {
      const response = await fetchImplementation(connection.endpoint, {
        method: "DELETE",
        headers: {
          authorization: connection.authorization,
          "mcp-session-id": sessionId,
          ...(negotiatedVersion === undefined ? {} : { "mcp-protocol-version": negotiatedVersion }),
        },
        // Cleanup must still run when the model request itself was cancelled.
        signal: AbortSignal.timeout(SESSION_CLOSE_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // Session cleanup is best effort and must not replace the MCP result/error.
    }
  };

  try {
    const initializeId = `subpolar-t3-mcp-${++nextId}`;
    const initialized = await send({
      jsonrpc: "2.0",
      id: initializeId,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "t3-code-subpolar", version: "0.1.0" },
      },
    });
    const initializeResponse = initialized.map(asResponse).find((entry) => entry?.id === initializeId);
    if (!initializeResponse || initializeResponse.error !== undefined) {
      throw new Error("T3 MCP endpoint rejected initialization");
    }
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const requestId = `subpolar-t3-mcp-${++nextId}`;
    let requestParams = params;
    const allTools: unknown[] = [];
    let toolListBytes = 0;
    for (let page = 0; page < 64; page += 1) {
      const responses = await send({ jsonrpc: "2.0", id: requestId, method, params: requestParams });
      const result = responses.map(asResponse).find((entry) => entry?.id === requestId);
      if (!result || result.error !== undefined) throw new Error("T3 MCP request failed");
      if (method !== "tools/list") return result.result;
      if (!result.result || typeof result.result !== "object") throw new Error("T3 MCP returned an invalid tool list");
      const pageResult = result.result as { tools?: unknown; nextCursor?: unknown };
      if (!Array.isArray(pageResult.tools)) throw new Error("T3 MCP returned an invalid tool list");
      toolListBytes += Buffer.byteLength(JSON.stringify(pageResult.tools));
      if (toolListBytes > MAX_TOOL_LIST_BYTES) throw new Error("T3 MCP tool listing exceeded the size limit");
      allTools.push(...pageResult.tools);
      if (typeof pageResult.nextCursor !== "string" || pageResult.nextCursor.length === 0) {
        return { ...pageResult, tools: allTools };
      }
      requestParams = { cursor: pageResult.nextCursor };
    }
    throw new Error("T3 MCP tool listing exceeded the page limit");
  } finally {
    await closeSession();
  }
}
