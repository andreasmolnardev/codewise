import { describe, expect, it } from "bun:test";

import { createProviderMcpRegistry } from "../src/index.ts";
import { createMcpAdapter, type McpTransport } from "../src/subpolarAdapter.ts";

const server = {
  id: "private-docs",
  url: "https://mcp.example.com/mcp",
  headers: { Authorization: { env: "DOCS_TOKEN" } },
};

function captureTransport(configs: Array<Record<string, unknown>>) {
  return (config: Record<string, unknown>): McpTransport => {
    configs.push(config);
    return {
      kind: "http",
      start: async () => undefined,
      request: async () => {
        throw new Error("No request expected");
      },
      notify: async () => undefined,
      close: async () => undefined,
    };
  };
}

describe("provider-scoped MCP environment references", () => {
  it("resolves credentials independently for two provider instances", async () => {
    const transports: Array<Record<string, unknown>> = [];
    const providerA = createProviderMcpRegistry({
      providerInstanceId: "provider-a",
      allowedHosts: ["mcp.example.com"],
      environment: { DOCS_TOKEN: "provider-a-secret" },
      transportFactory: captureTransport(transports),
    });
    const providerB = createProviderMcpRegistry({
      providerInstanceId: "provider-b",
      allowedHosts: ["mcp.example.com"],
      environment: { DOCS_TOKEN: "provider-b-secret" },
      transportFactory: captureTransport(transports),
    });

    const connectionA = await providerA.connect(server);
    const connectionB = await providerB.connect(server);
    const headers = transports.map((config) => config.headers as Record<string, string>);
    expect(headers).toEqual([
      { Authorization: "provider-a-secret" },
      { Authorization: "provider-b-secret" },
    ]);
    expect(process.env.DOCS_TOKEN).toBeUndefined();

    await connectionA.close();
    await connectionB.close();
    await providerA.close();
    await providerB.close();
  });

  it("continues resolving direct adapter references from process.env by default", async () => {
    const previous = process.env.SUBPOLAR_MCP_TEST_TOKEN;
    process.env.SUBPOLAR_MCP_TEST_TOKEN = "direct-process-secret";
    const transports: Array<Record<string, unknown>> = [];
    const adapter = createMcpAdapter({ transportFactory: captureTransport(transports) });
    try {
      const client = await adapter.connect({
        transport: "http",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: { env: "SUBPOLAR_MCP_TEST_TOKEN" } },
      });
      expect(transports[0]?.headers).toEqual({ Authorization: "direct-process-secret" });
      await client.close();
    } finally {
      await adapter.close();
      if (previous === undefined) delete process.env.SUBPOLAR_MCP_TEST_TOKEN;
      else process.env.SUBPOLAR_MCP_TEST_TOKEN = previous;
    }
  });
});
