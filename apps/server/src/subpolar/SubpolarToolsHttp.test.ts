import { describe, expect, test } from "vite-plus/test";

import {
  createSubpolarToolsHttpHandler,
  type SubpolarToolDefinitionView,
} from "./SubpolarToolsHttp.ts";

const tool: SubpolarToolDefinitionView = {
  id: "internal/default/read",
  adapter: "internal",
  namespace: "default",
  name: "read",
  description: "Read a file",
  inputSchema: { type: "object" },
  enabled: true,
};

function request(path: string, body?: unknown, token?: string): Request {
  return new Request(`http://t3.local${path}`, {
    method: "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("Subpolar tools read-only HTTP adapter", () => {
  test("requires the host's authenticated read authorization before accessing the catalog", async () => {
    let reads = 0;
    const handler = createSubpolarToolsHttpHandler({
      catalog: {
        list: () => {
          reads += 1;
          return [tool];
        },
        get: () => {
          reads += 1;
          return tool;
        },
      },
      authorizeRead: (request) => request.headers.get("authorization") === "Bearer read-token",
    });

    const response = await handler(request("/api/subpolar-cli/tools/list", {}, "wrong-token"));
    expect(response.status).toBe(401);
    expect(reads).toBe(0);
  });

  test("lists and describes catalog entries using the existing CLI route shapes", async () => {
    const handler = createSubpolarToolsHttpHandler({
      catalog: {
        list: () => [tool],
        get: (id) => (id === tool.id ? tool : undefined),
      },
      authorizeRead: (request) => request.headers.get("authorization") === "Bearer read-token",
    });

    const list = await handler(
      request("/api/subpolar-cli/tools/list", { userId: "ignored-client-identity" }, "read-token"),
    );
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(await list.json()).toEqual({ tools: [tool] });

    const describe = await handler(
      request("/api/subpolar-cli/tools/describe", { toolId: "read" }, "read-token"),
    );
    expect(describe.status).toBe(200);
    expect(await describe.json()).toEqual({ tool });

    const missing = await handler(
      request("/api/subpolar-cli/tools/describe", { toolId: "write" }, "read-token"),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "UNKNOWN_TOOL" } });
  });

  test("rejects malformed and oversized describe requests", async () => {
    const handler = createSubpolarToolsHttpHandler({
      catalog: { list: () => [], get: () => undefined },
      authorizeRead: () => true,
    });
    const invalid = await handler(
      request("/api/subpolar-cli/tools/describe", { toolId: "bad id" }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "INVALID_TOOL_ID" } });

    const oversized = new Request("http://t3.local/api/subpolar-cli/tools/list", {
      method: "POST",
      body: "x".repeat(64 * 1024 + 1),
    });
    const largeResponse = await handler(oversized);
    expect(largeResponse.status).toBe(413);
  });
});
