const LIST_PATH = "/api/subpolar-cli/tools/list";
const DESCRIBE_PATH = "/api/subpolar-cli/tools/describe";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TOOL_ID_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SubpolarToolDefinitionView {
  readonly id: string;
  readonly adapter: string;
  readonly namespace: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly enabled: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** A read-only view over the host-owned Subpolar tool catalog. */
export interface SubpolarToolCatalog {
  readonly list: () =>
    | readonly SubpolarToolDefinitionView[]
    | Promise<readonly SubpolarToolDefinitionView[]>;
  /** Receives the canonical adapter/namespace/name ID. */
  readonly get: (
    toolId: string,
  ) => SubpolarToolDefinitionView | undefined | Promise<SubpolarToolDefinitionView | undefined>;
}

export interface SubpolarToolsHttpOptions {
  readonly catalog: SubpolarToolCatalog;
  /** The T3 host supplies its authenticated read-scope check at the route boundary. */
  readonly authorizeRead: (request: Request) => boolean | Promise<boolean>;
}

function json(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    return json(
      {
        error: {
          code: "RESPONSE_TOO_LARGE",
          message: "Tool catalog response exceeds the allowed size",
        },
      },
      500,
    );
  }
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function canonicalToolId(value: string): string | undefined {
  const parts = value.split("/");
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !TOOL_ID_PART.test(part)))
    return undefined;
  if (parts.length === 1) return `internal/default/${parts[0]}`;
  if (parts.length === 2) return `internal/${parts[0]}/${parts[1]}`;
  return parts.join("/");
}

async function readRequestBody(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES)
    throw new RangeError("Request body exceeds the allowed size");
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new RangeError("Request body exceeds the allowed size");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

/**
 * Implements the existing Subpolar CLI's read-only list/describe contract.
 * The gateway must provide a host-owned catalog and its authenticated read
 * scope; this adapter intentionally does not create or persist a catalog.
 */
export function createSubpolarToolsHttpHandler(options: SubpolarToolsHttpOptions) {
  return async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    if (pathname !== LIST_PATH && pathname !== DESCRIBE_PATH)
      return json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404);
    if (request.method !== "POST")
      return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } }, 405);
    if (!(await options.authorizeRead(request)))
      return json(
        { error: { code: "UNAUTHORIZED", message: "Authentication with read access is required" } },
        401,
      );

    let body: Record<string, unknown>;
    try {
      body = await readRequestBody(request);
    } catch (error) {
      const status = error instanceof RangeError ? 413 : 400;
      const code = status === 413 ? "REQUEST_TOO_LARGE" : "INVALID_REQUEST";
      return json(
        {
          error: { code, message: error instanceof Error ? error.message : "Invalid JSON request" },
        },
        status,
      );
    }

    if (pathname === LIST_PATH) {
      try {
        const tools = await options.catalog.list();
        return json({ tools });
      } catch {
        return json(
          { error: { code: "TOOL_CATALOG_UNAVAILABLE", message: "Tool catalog is unavailable" } },
          503,
        );
      }
    }

    if (typeof body.toolId !== "string" || body.toolId.length > 256) {
      return json(
        {
          error: {
            code: "INVALID_TOOL_ID",
            message: "toolId must be a string of at most 256 characters",
          },
        },
        400,
      );
    }
    const toolId = canonicalToolId(body.toolId);
    if (!toolId) {
      return json({ error: { code: "INVALID_TOOL_ID", message: "toolId is invalid" } }, 400);
    }
    try {
      const tool = await options.catalog.get(toolId);
      return tool
        ? json({ tool })
        : json(
            { error: { code: "UNKNOWN_TOOL", message: `No tool is registered with ID ${toolId}` } },
            404,
          );
    } catch {
      return json(
        { error: { code: "TOOL_CATALOG_UNAVAILABLE", message: "Tool catalog is unavailable" } },
        503,
      );
    }
  };
}
