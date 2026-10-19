import { describe, expect, it } from "bun:test";

import {
  createProviderMcpAdmin,
  type ProviderMcpAdminStore,
  type SubpolarMcpServerConfig,
} from "../src/index.ts";

const config: SubpolarMcpServerConfig = {
  id: "docs",
  url: "https://mcp.example.com/mcp",
  headers: { Authorization: { env: "DOCS_MCP_TOKEN" } },
};

const tool = {
  name: "search",
  description: "Search documents",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  toolId: "docs.search",
  namespace: "docs",
  raw: { api_key: "remote-secret" },
};

function fixture(failConnect = false) {
  const configs = new Map<string, SubpolarMcpServerConfig[]>();
  const calls: Array<{ providerId: string; serverId: string }> = [];
  const store: ProviderMcpAdminStore = {
    list: async (providerId) => configs.get(providerId) ?? [],
    put: async (providerId, serverConfig) => {
      configs.set(providerId, [
        ...(configs.get(providerId) ?? []).filter((item) => item.id !== serverConfig.id),
        serverConfig,
      ]);
    },
    remove: async (providerId, serverId) => {
      configs.set(
        providerId,
        (configs.get(providerId) ?? []).filter((item) => item.id !== serverId),
      );
    },
  };
  const registry = {
    connect: async (serverConfig: SubpolarMcpServerConfig) => {
      calls.push({ providerId: "provider-a", serverId: serverConfig.id });
      if (failConnect) throw new Error("connection rejected");
      return {
        listTools: async () => [tool],
        callTool: async () => ({ content: [], isError: false, raw: {} }),
        close: async () => undefined,
      };
    },
    close: async () => undefined,
  };
  const admin = (providerInstanceId: string) =>
    createProviderMcpAdmin({
      providerInstanceId,
      allowedHosts: ["mcp.example.com"],
      store,
      registry,
    });
  return { admin, configs, calls };
}

describe("provider-scoped MCP administration", () => {
  it("configures, lists, inspects, discovers, and removes server tools without exposing secrets", async () => {
    const { admin, configs, calls } = fixture();
    const provider = admin("provider-a");
    const otherProvider = admin("provider-b");

    expect(await provider.configureServer(config)).toEqual({
      id: "docs",
      url: "https://mcp.example.com/mcp",
      namespace: "docs",
      timeoutMs: undefined,
      headerNames: ["Authorization"],
    });
    expect(configs.get("provider-a")).toEqual([config]);
    expect(await provider.listServers()).toHaveLength(1);
    expect(await otherProvider.listServers()).toEqual([]);
    expect(await provider.inspectServer("docs")).toMatchObject({
      id: "docs",
      headerNames: ["Authorization"],
    });

    const tools = await provider.listTools("docs");
    expect(tools).toHaveLength(1);
    expect(tools[0]).not.toHaveProperty("raw");
    expect(JSON.stringify(tools)).not.toContain("remote-secret");
    expect(await provider.inspectTool("docs", "search")).toMatchObject({
      name: "search",
      toolId: "docs.search",
    });
    await expect(provider.inspectTool("docs", "missing")).rejects.toThrow("MCP tool was not found");
    expect(calls.every((call) => call.providerId === "provider-a")).toBe(true);

    await provider.removeServer("docs");
    expect(await provider.listServers()).toEqual([]);
    await expect(provider.inspectServer("docs")).rejects.toThrow("MCP server was not found");
    await provider.close();
    await otherProvider.close();
  });

  it("does not persist a configuration until its endpoint has initialized", async () => {
    const { admin, configs } = fixture(true);
    const provider = admin("provider-a");
    await expect(provider.configureServer(config)).rejects.toThrow("connection rejected");
    expect(configs.get("provider-a")).toBeUndefined();
    await provider.close();
  });

  it("redacts URL credentials and query values from stored configuration summaries", async () => {
    const { admin, configs } = fixture();
    configs.set("provider-a", [
      {
        ...config,
        url: "https://user:password@mcp.example.com/mcp?token=secret#fragment",
      },
    ]);
    const provider = admin("provider-a");
    const summary = await provider.inspectServer("docs");
    expect(summary.url).toBe("https://mcp.example.com/mcp");
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(JSON.stringify(summary)).not.toContain("password");
    await provider.close();
  });
});
