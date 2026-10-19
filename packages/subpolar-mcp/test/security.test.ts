import { describe, expect, it } from "bun:test";

import { createProviderMcpRegistry } from "../src/index.ts";
import { fetchWithNetworkPolicy } from "../src/networkPolicy.ts";
import { redactSensitiveText } from "../src/securityRedaction.ts";

const registry = () => createProviderMcpRegistry({
  providerInstanceId: "provider-instance-a",
  allowedHosts: ["mcp.example.com"],
});

describe("Subpolar MCP boundary", () => {
  it("requires explicitly trusted, public DNS hosts", async () => {
    expect(() => createProviderMcpRegistry({
      providerInstanceId: "provider-instance-a",
      allowedHosts: ["127.0.0.1"],
    })).toThrow(/public DNS hostnames/);
    expect(() => createProviderMcpRegistry({
      providerInstanceId: "provider-instance-a",
      allowedHosts: ["*.example.com"],
    })).toThrow(/public DNS hostnames/);

    const servers = registry();
    await expect(servers.connect({ id: "local", url: "http://127.0.0.1:8080/mcp" })).rejects.toThrow(/HTTPS/);
    await expect(servers.connect({ id: "public", url: "https://other.example.com/mcp" })).rejects.toThrow(/explicitly allowed/);
    await expect(servers.connect({ id: "query", url: "https://mcp.example.com/mcp?token=secret" })).rejects.toThrow(/explicitly allowed/);
    await servers.close();
  });

  it("checks DNS results on each request and bounds response bodies", async () => {
    const fetchImpl = async () => new Response("should not be reached", { status: 200 });
    await expect(fetchWithNetworkPolicy(
      "https://mcp.example.com/mcp",
      {},
      { allowedHosts: ["mcp.example.com"], maxResponseBytes: 8 },
      fetchImpl,
      async () => ["10.0.0.8"],
    )).rejects.toThrow(/private address/);

    const response = await fetchWithNetworkPolicy(
      "https://mcp.example.com/mcp",
      {},
      { allowedHosts: ["mcp.example.com"], maxResponseBytes: 8 },
      async () => new Response("0123456789", { status: 200 }),
      async () => ["93.184.216.34"],
    );
    await expect(response.text()).rejects.toThrow(/exceeds 8 bytes/);
  });

  it("redacts credentials from transport diagnostics", () => {
    expect(redactSensitiveText("Authorization: Bearer super-secret-value"))
      .not.toContain("super-secret-value");
    expect(redactSensitiveText('{"api_key":"super-secret-value"}'))
      .toBe('{"api_key":"[REDACTED]"}');
  });
});
