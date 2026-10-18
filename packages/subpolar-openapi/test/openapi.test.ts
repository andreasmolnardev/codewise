import { describe, expect, test } from "bun:test";
import { createToolRegistry } from "../../subpolar-tools/src/index.ts";
import { discoverOpenApiTools, OPENAPI_LIMITS, registerOpenApiToolDefinitions } from "../src/index.ts";

const origin = "https://api.example.test";
const spec = {
  openapi: "3.1.0",
  servers: [{ url: `${origin}/v1` }],
  paths: {
    "/items/{itemId}": {
      parameters: [{ name: "itemId", in: "path", required: true, schema: { type: "string" } }],
      get: {
        operationId: "getItem",
        summary: "Get item",
        parameters: [{ name: "include", in: "query", schema: { type: "boolean" } }],
        responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } } } },
      },
      delete: { operationId: "deleteItem", responses: { "204": { description: "Deleted" } } },
    },
    "/items": {
      post: {
        operationId: "createItem",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateItem" } } } },
        responses: { "201": { description: "Created" } },
      },
    },
  },
  components: {
    schemas: {
      Item: { type: "object", properties: { name: { type: "string", maxLength: 40 }, apiToken: { type: "string" } }, required: ["name"] },
      CreateItem: { type: "object", properties: { name: { type: "string" }, password: { type: "string" } }, required: ["name"] },
    },
  },
};

describe("@subpolar/openapi operation discovery", () => {
  test("generates bounded definitions with normalized schemas and risk metadata", () => {
    const tools = discoverOpenApiTools({ name: "inventory", document: spec }, { allowedOrigins: [origin] });

    expect(tools).toHaveLength(3);
    expect(tools[0]).toMatchObject({
      id: "openapi/inventory/getitem",
      adapter: "openapi",
      target: `${origin}/v1/items/{itemId}`,
      risk: "read",
      requiresApproval: false,
      inputSchema: {
        type: "object",
        properties: { itemId: { type: "string" }, include: { type: "boolean" } },
        required: ["itemId"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", properties: { name: { type: "string", maxLength: 40 } }, required: ["name"] },
    });
    expect(tools[0].metadata["openapi.method"]).toBe("GET");
    expect(tools[1]).toMatchObject({ risk: "delete", requiresApproval: true });
    expect(tools[2]).toMatchObject({ risk: "write", requiresApproval: true });
    expect(JSON.stringify(tools)).not.toContain("password");
    expect(JSON.stringify(tools)).not.toContain("apiToken");
  });

  test("filters selected operations and rejects missing or duplicate selections", () => {
    expect(discoverOpenApiTools({ name: "inventory", document: spec, operations: ["getItem"] }, { allowedOrigins: [origin] })).toHaveLength(1);
    expect(() => discoverOpenApiTools({ name: "inventory", document: spec, operations: ["missing"] }, { allowedOrigins: [origin] })).toThrow("Unknown OpenAPI operation ID");
    expect(() => discoverOpenApiTools({ name: "inventory", document: spec, operations: ["getItem", "getItem"] }, { allowedOrigins: [origin] })).toThrow("unique valid operation IDs");
  });

  test("requires an exact host-approved public HTTPS origin and rejects SSRF-shaped targets", () => {
    expect(() => discoverOpenApiTools({ name: "inventory", document: spec }, { allowedOrigins: ["https://other.example.test"] })).toThrow("not allowed");
    expect(() => discoverOpenApiTools({ name: "inventory", baseUrl: "http://api.example.test", document: spec }, { allowedOrigins: [origin] })).toThrow("public HTTPS");
    expect(() => discoverOpenApiTools({ name: "inventory", baseUrl: "https://127.0.0.1", document: spec }, { allowedOrigins: [origin] })).toThrow("public HTTPS");
    expect(() => discoverOpenApiTools({ name: "inventory", baseUrl: "https://metadata.google.internal", document: spec }, { allowedOrigins: ["https://metadata.google.internal"] })).toThrow("Allowed OpenAPI origins");
    expect(() => discoverOpenApiTools({ name: "inventory", baseUrl: "https://user:pass@api.example.test", document: spec }, { allowedOrigins: [origin] })).toThrow("public HTTPS");
    expect(() => discoverOpenApiTools({ name: "inventory", document: { ...spec, paths: { "//attacker.test/x": { get: { operationId: "read" } } } } }, { allowedOrigins: [origin] })).toThrow("path is invalid");
    expect(() => discoverOpenApiTools({ name: "inventory", document: { ...spec, paths: { "/x/%2e%2e/admin": { get: { operationId: "read" } } } } }, { allowedOrigins: [origin] })).toThrow("path is invalid");
  });

  test("rejects external and circular references, and enforces document bounds", () => {
    const external = { ...spec, paths: { "/x": { get: { operationId: "read", parameters: [{ $ref: "https://attacker.test/parameter" }] } } } };
    expect(() => discoverOpenApiTools({ name: "inventory", document: external }, { allowedOrigins: [origin] })).toThrow("external references");
    const circular = {
      openapi: "3.0.0",
      servers: [{ url: origin }],
      paths: {
        "/x": {
          get: {
            operationId: "read",
            responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Loop" } } } } },
          },
        },
      },
      components: { schemas: { Loop: { $ref: "#/components/schemas/Loop" } } },
    };
    expect(() => discoverOpenApiTools({ name: "inventory", document: circular }, { allowedOrigins: [origin] })).toThrow("circular reference");
    const tooManyPaths = Object.fromEntries(Array.from({ length: OPENAPI_LIMITS.maxPaths + 1 }, (_, index) => [`/p${index}`, {}]));
    expect(() => discoverOpenApiTools({ name: "inventory", document: { openapi: "3.0.0", paths: tooManyPaths } }, { allowedOrigins: [origin] })).toThrow("too many paths");
  });

  test("registers definitions into the existing policy gateway without invoking adapters", async () => {
    let executions = 0;
    const registry = createToolRegistry({
      adapters: [{ kind: "openapi", execute: async () => { executions += 1; return "executed"; } }],
    });
    const generated = discoverOpenApiTools({ name: "inventory", document: spec }, { allowedOrigins: [origin] });
    const registered = registerOpenApiToolDefinitions(registry, generated);

    expect(registered.map(({ id }) => id)).toEqual(generated.map(({ id }) => id));
    const denied = await registry.execute({ callId: "call-1", toolId: generated[0].id, input: { itemId: "one" } });
    expect(denied).toMatchObject({ ok: false, error: { code: "POLICY_DENIED" } });
    expect(executions).toBe(0);
  });
});
