import {
  createProviderMcpRegistry,
  type ProviderMcpRegistryOptions,
  type SubpolarMcpConnection,
  type SubpolarMcpServerConfig,
} from "./index.ts";

export interface ProviderMcpAdminStore {
  readonly list: (providerInstanceId: string) => Promise<readonly SubpolarMcpServerConfig[]>;
  readonly put: (providerInstanceId: string, config: SubpolarMcpServerConfig) => Promise<void>;
  readonly remove: (providerInstanceId: string, serverId: string) => Promise<void>;
}

export interface ProviderMcpAdminOptions extends ProviderMcpRegistryOptions {
  readonly store: ProviderMcpAdminStore;
  /** Test seam; production callers should use the guarded default registry. */
  readonly registry?: Pick<ReturnType<typeof createProviderMcpRegistry>, "connect" | "close">;
}

export interface ManagedMcpServerSummary {
  readonly id: string;
  readonly url: string;
  readonly namespace: string;
  readonly timeoutMs: number | undefined;
  readonly headerNames: readonly string[];
}

export interface ManagedMcpToolSummary {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
  readonly namespace?: string;
  readonly toolId: string;
}

const summarizeServer = (config: SubpolarMcpServerConfig): ManagedMcpServerSummary => ({
  id: config.id,
  url: safeServerUrl(config.url),
  namespace: config.namespace ?? config.id,
  timeoutMs: config.timeoutMs,
  headerNames: Object.keys(config.headers ?? {}).sort(),
});

function safeServerUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "[invalid URL]";
  }
}

const summarizeTool = (
  tool: Awaited<ReturnType<SubpolarMcpConnection["listTools"]>>[number],
): ManagedMcpToolSummary => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  ...(tool.annotations ? { annotations: tool.annotations } : {}),
  ...(tool.namespace ? { namespace: tool.namespace } : {}),
  toolId: tool.toolId,
});

/**
 * Authenticated host-facing administration for one provider instance's MCP
 * configuration. The host supplies the authenticated identity and store;
 * configuration never contains resolved credential values.
 */
export function createProviderMcpAdmin(options: ProviderMcpAdminOptions) {
  if (!options.providerInstanceId.trim()) throw new Error("A provider instance ID is required");
  const registry = options.registry ?? createProviderMcpRegistry(options);
  let closed = false;

  const configFor = async (serverId: string) => {
    const configs = await options.store.list(options.providerInstanceId);
    const config = configs.find((candidate) => candidate.id === serverId);
    if (!config) throw new Error("MCP server was not found");
    return config;
  };

  const withConnection = async <T>(
    serverId: string,
    use: (connection: SubpolarMcpConnection) => Promise<T>,
  ) => {
    if (closed) throw new Error("MCP administration is closed");
    const connection = await registry.connect(await configFor(serverId));
    try {
      return await use(connection);
    } finally {
      await connection.close();
    }
  };

  return {
    async listServers(): Promise<ManagedMcpServerSummary[]> {
      if (closed) throw new Error("MCP administration is closed");
      return (await options.store.list(options.providerInstanceId)).map(summarizeServer);
    },

    async inspectServer(serverId: string): Promise<ManagedMcpServerSummary> {
      return summarizeServer(await configFor(serverId));
    },

    async configureServer(config: SubpolarMcpServerConfig): Promise<ManagedMcpServerSummary> {
      if (closed) throw new Error("MCP administration is closed");
      // Validate policy and confirm the remote endpoint initializes before the
      // host makes this configuration durable.
      const connection = await registry.connect(config);
      await connection.close();
      await options.store.put(options.providerInstanceId, config);
      return summarizeServer(config);
    },

    async removeServer(serverId: string): Promise<void> {
      if (closed) throw new Error("MCP administration is closed");
      await configFor(serverId);
      await options.store.remove(options.providerInstanceId, serverId);
    },

    async listTools(serverId: string): Promise<ManagedMcpToolSummary[]> {
      return withConnection(serverId, async (connection) =>
        (await connection.listTools()).map(summarizeTool),
      );
    },

    async inspectTool(serverId: string, toolName: string): Promise<ManagedMcpToolSummary> {
      return withConnection(serverId, async (connection) => {
        const tool = (await connection.listTools()).find(
          (candidate) => candidate.name === toolName,
        );
        if (!tool) throw new Error("MCP tool was not found");
        return summarizeTool(tool);
      });
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await registry.close();
    },
  };
}
