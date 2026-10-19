import {
  ProviderInstanceMcpAdminError,
  ProviderInstanceMcpServerConfig,
  type ProviderInstanceMcpAdminInput,
  type ProviderInstanceMcpAdminResult,
  type ProviderInstanceMcpServerConfig as McpServerConfig,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  createProviderMcpAdmin,
  createProviderMcpRegistry,
  type ProviderMcpRegistryOptions,
  type SubpolarMcpServerConfig,
} from "@subpolar/mcp";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Path from "effect/Path";
import * as ServerSettings from "../serverSettings.ts";
import { resolveProviderInstanceTerminalEnvironment } from "../terminal/Manager.ts";

type ProviderMcpRegistry = ReturnType<typeof createProviderMcpRegistry>;

export interface ProviderMcpAdminServiceOptions {
  readonly settings: ServerSettings.ServerSettingsService["Service"];
  readonly path: Path.Path;
  readonly createRegistry?: (options: ProviderMcpRegistryOptions) => ProviderMcpRegistry;
}

const adminError = (reason: "invalid_configuration" | "server_unavailable" | "not_found") =>
  new ProviderInstanceMcpAdminError({
    reason,
    message:
      reason === "not_found"
        ? "The provider instance or MCP server was not found."
        : reason === "invalid_configuration"
          ? "The provider MCP configuration is invalid."
          : "The provider MCP server could not be reached.",
  });

const hostFor = (config: McpServerConfig): string => {
  const url = new URL(config.url);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("invalid configuration");
  }
  return url.hostname.toLowerCase().replace(/\.$/, "");
};

const environmentNamesFor = (configs: readonly McpServerConfig[]): string[] => [
  ...new Set(
    configs.flatMap((config) => Object.values(config.headers ?? {}).map(({ env }) => env)),
  ),
];

const toSubpolarConfig = (config: McpServerConfig): SubpolarMcpServerConfig => ({
  id: config.id,
  url: config.url,
  ...(config.headers === undefined ? {} : { headers: config.headers }),
  ...(config.namespace === undefined ? {} : { namespace: config.namespace }),
  ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
});

const isMcpConfig = Schema.is(ProviderInstanceMcpServerConfig);
const isServerId = Schema.is(ProviderInstanceMcpServerConfig.fields.id);

/** Host-side MCP administration for an authenticated environment's provider instance. */
export function makeProviderMcpAdminService(options: ProviderMcpAdminServiceOptions) {
  return {
    execute: Effect.fn("ProviderMcpAdminService.execute")(function* (
      input: ProviderInstanceMcpAdminInput,
    ): Effect.fn.Return<ProviderInstanceMcpAdminResult, ProviderInstanceMcpAdminError> {
      if (input.operation === "configureServer" && !isMcpConfig(input.config))
        return yield* adminError("invalid_configuration");
      if (!Schema.is(ProviderInstanceId)(input.providerInstanceId)) {
        return yield* adminError("invalid_configuration");
      }
      if (
        (input.operation === "removeServer" ||
          input.operation === "listTools" ||
          input.operation === "inspectTool") &&
        !isServerId(input.serverId)
      ) {
        return yield* adminError("invalid_configuration");
      }

      const settings = yield* options.settings.getSettings.pipe(
        Effect.mapError(() => adminError("server_unavailable")),
      );
      const providerInstanceId = input.providerInstanceId;
      if (!Object.hasOwn(settings.providerInstances, providerInstanceId)) {
        return yield* adminError("not_found");
      }

      const storedConfigs = yield* options.settings
        .listProviderInstanceMcpServers(providerInstanceId)
        .pipe(Effect.mapError(() => adminError("server_unavailable")));
      if (input.operation === "listServers") {
        return {
          operation: input.operation,
          servers: storedConfigs.map((config) => {
            let safeUrl = "[invalid URL]";
            try {
              const url = new URL(config.url);
              url.username = "";
              url.password = "";
              url.search = "";
              url.hash = "";
              safeUrl = url.href;
            } catch {
              // Keep malformed legacy settings visible without exposing URL credentials.
            }
            return {
              id: config.id,
              url: safeUrl,
              namespace: config.namespace ?? config.id,
              timeoutMs: config.timeoutMs,
              headerNames: Object.keys(config.headers ?? {}).sort(),
            };
          }),
        };
      }
      if (input.operation === "removeServer") {
        if (!storedConfigs.some((config) => config.id === input.serverId))
          return yield* adminError("not_found");
        yield* options.settings
          .removeProviderInstanceMcpServer(providerInstanceId, input.serverId)
          .pipe(Effect.mapError(() => adminError("server_unavailable")));
        return { operation: input.operation, removed: true };
      }
      const configsForRequest =
        input.operation === "configureServer"
          ? [input.config]
          : storedConfigs.filter((config) => config.id === input.serverId);
      if (configsForRequest.length === 0) return yield* adminError("not_found");

      const allowedHosts = yield* Effect.try({
        try: () => [...new Set(configsForRequest.map(hostFor))],
        catch: () => adminError("invalid_configuration"),
      });

      const referencedNames = environmentNamesFor(configsForRequest);
      const resolvedEnvironment = yield* resolveProviderInstanceTerminalEnvironment({
        serverSettings: options.settings,
        path: options.path,
        rawProviderInstanceId: providerInstanceId,
        env: {},
      }).pipe(Effect.mapError(() => adminError("server_unavailable")));
      const environment = Object.fromEntries(
        referencedNames.flatMap((name) =>
          resolvedEnvironment[name] === undefined ? [] : [[name, resolvedEnvironment[name]!]],
        ),
      );
      if (referencedNames.some((name) => environment[name] === undefined)) {
        return yield* adminError("invalid_configuration");
      }

      const registryOptions: ProviderMcpRegistryOptions = {
        providerInstanceId,
        allowedHosts,
        environment,
      };
      const context = yield* Effect.context();
      const admin = createProviderMcpAdmin({
        ...registryOptions,
        store: {
          list: async (requestedId) =>
            requestedId === providerInstanceId ? storedConfigs.map(toSubpolarConfig) : [],
          put: async (requestedId, config) => {
            if (requestedId !== providerInstanceId)
              throw new Error("MCP provider instance scope mismatch");
            await Effect.runPromiseWith(context)(
              options.settings.putProviderInstanceMcpServer(
                providerInstanceId,
                config as McpServerConfig,
              ),
            );
          },
          remove: async (requestedId, serverId) => {
            if (requestedId !== providerInstanceId)
              throw new Error("MCP provider instance scope mismatch");
            await Effect.runPromiseWith(context)(
              options.settings.removeProviderInstanceMcpServer(providerInstanceId, serverId),
            );
          },
        },
        registry: (options.createRegistry ?? createProviderMcpRegistry)(registryOptions),
      });

      return yield* Effect.tryPromise({
        try: async () => {
          switch (input.operation) {
            case "configureServer":
              return {
                operation: input.operation,
                server: await admin.configureServer(toSubpolarConfig(input.config)),
              };
            case "listTools":
              return {
                operation: input.operation,
                tools: await admin.listTools(input.serverId),
              };
            case "inspectTool":
              return {
                operation: input.operation,
                tool: await admin.inspectTool(input.serverId, input.toolName),
              };
          }
        },
        catch: (cause) => {
          if (Schema.is(ProviderInstanceMcpAdminError)(cause)) return cause;
          const message = cause instanceof Error ? cause.message.toLowerCase() : "";
          return adminError(
            message.includes("not found")
              ? "not_found"
              : /url|configuration|allowlist|hostname|header/.test(message)
                ? "invalid_configuration"
                : "server_unavailable",
          );
        },
      }).pipe(Effect.ensuring(Effect.promise(() => admin.close()).pipe(Effect.ignore)));
    }),
  };
}
