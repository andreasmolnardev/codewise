import { isIP } from "node:net";

import {
  createMcpAdapter as createSubpolarAdapter,
  type McpClient,
  type McpLimits,
  type McpTool,
} from "./subpolarAdapter.ts";
import { isPrivateHost } from "./networkPolicy.ts";
export { createProviderMcpAdmin } from "./admin.ts";
export type {
  ManagedMcpServerSummary,
  ManagedMcpToolSummary,
  ProviderMcpAdminOptions,
  ProviderMcpAdminStore,
} from "./admin.ts";

const MAX_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;

export interface SubpolarMcpServerConfig {
  readonly id: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, { readonly env: string }>>;
  readonly namespace?: string;
  readonly timeoutMs?: number;
}

export interface ProviderMcpRegistryOptions {
  /** Trusted ACP provider instance identity. Never accept this from tool metadata. */
  readonly providerInstanceId: string;
  /** Server hostnames explicitly approved by the host's server-side policy. */
  readonly allowedHosts: readonly string[];
}

export interface SubpolarMcpConnection {
  readonly listTools: () => Promise<McpTool[]>;
  readonly callTool: (
    name: string,
    input: unknown,
    timeoutMs?: number,
  ) => ReturnType<McpClient["callTool"]>;
  readonly close: () => Promise<void>;
}

function trustedHosts(hosts: readonly string[]): readonly string[] {
  const normalized = hosts.map((host) => host.trim().toLowerCase().replace(/\.$/, ""));
  if (
    normalized.length === 0 ||
    normalized.some(
      (host) =>
        !host ||
        host.includes("*") ||
        isIP(host) !== 0 ||
        isPrivateHost(host) ||
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
        host.includes("/") ||
        host.includes(":") ||
        host.includes("@"),
    )
  ) {
    throw new Error("MCP server allowlist must contain public DNS hostnames only");
  }
  return [...new Set(normalized)];
}

function validatedConfig(
  input: SubpolarMcpServerConfig,
  providerInstanceId: string,
  allowedHosts: readonly string[],
) {
  if (!input || typeof input !== "object") throw new Error("MCP server configuration is required");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.id)) {
    throw new Error("MCP server ID is invalid");
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error("MCP server URL must be an absolute HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !allowedHosts.includes(url.hostname.toLowerCase().replace(/\.$/, ""))
  ) {
    throw new Error(
      "MCP server URL must use HTTPS on an explicitly allowed public host without credentials or query parameters",
    );
  }
  if (
    input.timeoutMs !== undefined &&
    (!Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 100 ||
      input.timeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new Error(`MCP server timeout must be between 100 and ${MAX_TIMEOUT_MS} milliseconds`);
  }
  const headers: Record<string, { env: string }> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      !value ||
      typeof value.env !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.env)
    ) {
      throw new Error("MCP headers must use valid names and environment-variable references");
    }
    headers[name] = value;
  }
  return {
    ownerId: providerInstanceId,
    serverKey: input.id,
    transport: "http" as const,
    url: url.href,
    namespace: input.namespace ?? input.id,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    // Deliberately ignore caller-provided limits and network policy. DNS is
    // resolved and checked by the transport on every request and redirect.
    networkPolicy: {
      allowedHosts,
      allowPrivateHosts: false,
      timeoutMs: input.timeoutMs ?? MAX_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxRedirects: 2,
    },
    limits: {
      requestTimeoutMs: input.timeoutMs ?? MAX_TIMEOUT_MS,
      maxRequestTimeoutMs: MAX_TIMEOUT_MS,
      maxTools: 100,
      maxListPages: 5,
      maxInputBytes: 256_000,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxLineBytes: MAX_RESPONSE_BYTES,
      maxStderrBytes: 0,
    } satisfies Partial<McpLimits>,
  };
}

/**
 * Create an owner-scoped registry for remote Streamable HTTP MCP servers.
 * It supports HTTPS only, denies private and loopback DNS targets, and keeps
 * transport credentials scoped to the ACP provider instance.
 */
export function createProviderMcpRegistry(options: ProviderMcpRegistryOptions) {
  if (!options.providerInstanceId.trim()) throw new Error("A provider instance ID is required");
  const hosts = trustedHosts(options.allowedHosts);
  const limits = {
    requestTimeoutMs: MAX_TIMEOUT_MS,
    maxRequestTimeoutMs: MAX_TIMEOUT_MS,
    maxTools: 100,
    maxListPages: 5,
    maxInputBytes: 256_000,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    maxLineBytes: MAX_RESPONSE_BYTES,
    maxStderrBytes: 0,
  } satisfies Partial<McpLimits>;
  const clients = new Map<
    string,
    { readonly adapter: ReturnType<typeof createSubpolarAdapter>; readonly client: McpClient }
  >();
  let closed = false;

  return {
    async connect(input: SubpolarMcpServerConfig): Promise<SubpolarMcpConnection> {
      if (closed) throw new Error("MCP provider registry is closed");
      const config = validatedConfig(input, options.providerInstanceId, hosts);
      await this.closeServer(input.id);
      const adapter = createSubpolarAdapter({ limits });
      const client = await adapter.connect(config);
      clients.set(input.id, { adapter, client });
      const assertActive = () => {
        if (closed || clients.get(input.id)?.client !== client) {
          throw new Error("MCP server connection is closed");
        }
      };
      return {
        listTools: () => {
          assertActive();
          return client.listTools();
        },
        callTool: (name, toolInput, timeoutMs) => {
          assertActive();
          return client.callTool(name, toolInput, timeoutMs);
        },
        close: async () => {
          if (clients.get(input.id)?.client === client) await this.closeServer(input.id);
        },
      };
    },
    async closeServer(id: string): Promise<void> {
      const entry = clients.get(id);
      if (!entry) return;
      clients.delete(id);
      await entry.adapter.close();
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const entries = [...clients.values()];
      clients.clear();
      await Promise.all(entries.map(({ adapter }) => adapter.close()));
    },
  };
}
