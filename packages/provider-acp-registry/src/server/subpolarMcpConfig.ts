import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const MAX_TIMEOUT_MS = 15_000;
const McpServerConfig = Schema.Struct({
  id: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  ),
  url: Schema.String.check(Schema.isMinLength(1)),
  headers: Schema.optionalKey(
    Schema.Record(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      Schema.Struct({ env: Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)) }),
    ),
  ),
  namespace: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: MAX_TIMEOUT_MS })),
  ),
});
const ProviderMcpConfig = Schema.Struct({
  version: Schema.Literal(1),
  providers: Schema.Record(Schema.String, Schema.Array(McpServerConfig)),
});

type McpServerConfig = typeof McpServerConfig.Type;
type ProviderMcpConfig = typeof ProviderMcpConfig.Type;

export class SubpolarMcpConfigError extends Schema.TaggedError<SubpolarMcpConfigError>()(
  "SubpolarMcpConfigError",
  { detail: Schema.String },
) {}

/**
 * MCP configuration is kept in the private `<T3 stateDir>/subpolar-mcp.json` file.
 * Keys are T3 ACP provider instance IDs and header values are environment-name references only.
 */
export function subpolarMcpEnvironment(input: {
  readonly stateDir: string;
  readonly providerInstanceId: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.Effect<NodeJS.ProcessEnv, SubpolarMcpConfigError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configPath = path.join(input.stateDir, "subpolar-mcp.json");
    const exists = yield* fs.exists(configPath);
    const inherited = Object.fromEntries(
      Object.entries(input.environment).filter(([name]) => !name.startsWith("SUBPOLAR_MCP_")),
    );
    if (!exists) return inherited;

    const raw = yield* fs.readFileString(configPath).pipe(
      Effect.mapError(
        () =>
          new SubpolarMcpConfigError({
            detail: "Could not read the private Subpolar MCP configuration.",
          }),
      ),
    );
    const config = yield* Schema.decodeEffect(Schema.fromJsonString(ProviderMcpConfig))(raw).pipe(
      Effect.mapError(
        () =>
          new SubpolarMcpConfigError({
            detail: "The private Subpolar MCP configuration is invalid.",
          }),
      ),
    );
    return yield* Effect.try({
      try: () => environmentForProvider(config, input.providerInstanceId, inherited),
      catch: (cause) =>
        new SubpolarMcpConfigError({
          detail:
            cause instanceof Error
              ? cause.message
              : "The private Subpolar MCP configuration is invalid.",
        }),
    });
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(SubpolarMcpConfigError)(cause)
        ? cause
        : new SubpolarMcpConfigError({
            detail: "Could not load the private Subpolar MCP configuration.",
          }),
    ),
  );
}

function environmentForProvider(
  config: ProviderMcpConfig,
  providerInstanceId: string,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const servers = config.providers[providerInstanceId] ?? [];
  if (servers.length === 0) return environment;

  const allowedHosts = new Set<string>();
  const runtimeServers = servers.map((server, serverIndex) => {
    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      throw new Error(`Subpolar MCP server ${server.id} must use an absolute HTTPS URL.`);
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error(
        `Subpolar MCP server ${server.id} must use HTTPS without URL credentials or query parameters.`,
      );
    }
    allowedHosts.add(url.hostname.toLowerCase().replace(/\.$/, ""));

    const headers: Record<string, { env: string }> = {};
    for (const [headerIndex, [name, reference]] of Object.entries(server.headers ?? {}).entries()) {
      const value = environment[reference.env];
      if (value === undefined || value.includes("\0") || value.length > 16_384) {
        throw new Error(
          `Subpolar MCP server ${server.id} references a missing or invalid provider environment variable.`,
        );
      }
      const targetName = `SUBPOLAR_MCP_HEADER_${serverIndex}_${headerIndex}`;
      environment[targetName] = value;
      headers[name] = { env: targetName };
    }
    return {
      id: server.id,
      url: server.url,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(server.namespace === undefined ? {} : { namespace: server.namespace }),
      ...(server.timeoutMs === undefined ? {} : { timeoutMs: server.timeoutMs }),
    };
  });

  environment.SUBPOLAR_MCP_SERVERS = JSON.stringify(runtimeServers);
  environment.SUBPOLAR_MCP_ALLOWED_HOSTS = JSON.stringify([...allowedHosts]);
  return environment;
}
