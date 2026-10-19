import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROVIDER_SLUG_MAX_CHARS = 64;
const PROVIDER_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const ENVIRONMENT_VARIABLE_NAME_MAX_CHARS = 128;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const slugSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_SLUG_MAX_CHARS),
  Schema.isPattern(PROVIDER_SLUG_PATTERN),
);

export const ProviderDriverKind = slugSchema.pipe(Schema.brand("ProviderDriverKind"));
export type ProviderDriverKind = typeof ProviderDriverKind.Type;

const isProviderDriverKindValue = Schema.is(ProviderDriverKind);
export const isProviderDriverKind = (value: unknown): value is ProviderDriverKind =>
  isProviderDriverKindValue(value);

export const ProviderInstanceId = slugSchema.pipe(Schema.brand("ProviderInstanceId"));
export type ProviderInstanceId = typeof ProviderInstanceId.Type;

export const ProviderInstanceRef = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
});
export type ProviderInstanceRef = typeof ProviderInstanceRef.Type;

export const ProviderInstanceEnvironmentVariableName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ENVIRONMENT_VARIABLE_NAME_MAX_CHARS),
  Schema.isPattern(ENVIRONMENT_VARIABLE_NAME_PATTERN),
);
export type ProviderInstanceEnvironmentVariableName =
  typeof ProviderInstanceEnvironmentVariableName.Type;

export const ProviderInstanceEnvironmentVariable = Schema.Struct({
  name: ProviderInstanceEnvironmentVariableName,
  value: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  sensitive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  valueRedacted: Schema.optionalKey(Schema.Boolean),
});
export type ProviderInstanceEnvironmentVariable = typeof ProviderInstanceEnvironmentVariable.Type;

export const ProviderInstanceEnvironment = Schema.Array(ProviderInstanceEnvironmentVariable);
export type ProviderInstanceEnvironment = typeof ProviderInstanceEnvironment.Type;

/** A remote MCP server configured for one provider instance. Credentials are references to
 * that instance's environment variables; secret values are never stored here. */
export const ProviderInstanceMcpServerConfig = Schema.Struct({
  id: TrimmedNonEmptyString.check(
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  ),
  url: TrimmedNonEmptyString,
  headers: Schema.optionalKey(
    Schema.Record(
      TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
      Schema.Struct({ env: ProviderInstanceEnvironmentVariableName }),
    ),
  ),
  namespace: Schema.optional(TrimmedNonEmptyString),
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 15_000 }))),
});
export type ProviderInstanceMcpServerConfig = typeof ProviderInstanceMcpServerConfig.Type;

export const ProviderInstanceMcpServerSummary = Schema.Struct({
  id: ProviderInstanceMcpServerConfig.fields.id,
  url: TrimmedNonEmptyString,
  namespace: TrimmedNonEmptyString,
  timeoutMs: Schema.optional(Schema.Int),
  headerNames: Schema.Array(TrimmedNonEmptyString),
});
export type ProviderInstanceMcpServerSummary = typeof ProviderInstanceMcpServerSummary.Type;

export const ProviderInstanceMcpToolSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.String,
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
  outputSchema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  annotations: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  namespace: Schema.optional(TrimmedNonEmptyString),
  toolId: TrimmedNonEmptyString,
});
export type ProviderInstanceMcpToolSummary = typeof ProviderInstanceMcpToolSummary.Type;

export const ProviderInstanceMcpAdminInput = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("listServers"),
    providerInstanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    operation: Schema.Literal("configureServer"),
    providerInstanceId: ProviderInstanceId,
    config: ProviderInstanceMcpServerConfig,
  }),
  Schema.Struct({
    operation: Schema.Literal("removeServer"),
    providerInstanceId: ProviderInstanceId,
    serverId: ProviderInstanceMcpServerConfig.fields.id,
  }),
  Schema.Struct({
    operation: Schema.Literal("listTools"),
    providerInstanceId: ProviderInstanceId,
    serverId: ProviderInstanceMcpServerConfig.fields.id,
  }),
  Schema.Struct({
    operation: Schema.Literal("inspectTool"),
    providerInstanceId: ProviderInstanceId,
    serverId: ProviderInstanceMcpServerConfig.fields.id,
    toolName: TrimmedNonEmptyString,
  }),
]);
export type ProviderInstanceMcpAdminInput = typeof ProviderInstanceMcpAdminInput.Type;

export const ProviderInstanceMcpAdminResult = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("listServers"),
    servers: Schema.Array(ProviderInstanceMcpServerSummary),
  }),
  Schema.Struct({
    operation: Schema.Literal("configureServer"),
    server: ProviderInstanceMcpServerSummary,
  }),
  Schema.Struct({ operation: Schema.Literal("removeServer"), removed: Schema.Boolean }),
  Schema.Struct({
    operation: Schema.Literal("listTools"),
    tools: Schema.Array(ProviderInstanceMcpToolSummary),
  }),
  Schema.Struct({ operation: Schema.Literal("inspectTool"), tool: ProviderInstanceMcpToolSummary }),
]);
export type ProviderInstanceMcpAdminResult = typeof ProviderInstanceMcpAdminResult.Type;

export class ProviderInstanceMcpAdminError extends Schema.TaggedError<ProviderInstanceMcpAdminError>()(
  "ProviderInstanceMcpAdminError",
  {
    reason: Schema.Literals(["invalid_configuration", "server_unavailable", "not_found"]),
    message: TrimmedNonEmptyString,
  },
) {}

/**
 * The driver-specific config payload is left as `Schema.Unknown`; each driver
 * registers its own decoder with the runtime registry, and envelopes for
 * unknown drivers are preserved verbatim so they round-trip across version
 * changes without data loss.
 */
export const ProviderInstanceConfig = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optionalKey(ProviderInstanceEnvironment),
  enabled: Schema.optionalKey(Schema.Boolean),
  config: Schema.optionalKey(Schema.Unknown),
});
export type ProviderInstanceConfig = typeof ProviderInstanceConfig.Type;

export const ProviderInstanceMutation = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("create"),
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  }),
  Schema.Struct({
    operation: Schema.Literal("upsert"),
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  }),
  Schema.Struct({
    operation: Schema.Literal("remove"),
    instanceId: ProviderInstanceId,
  }),
]);
export type ProviderInstanceMutation = typeof ProviderInstanceMutation.Type;

export const ProviderInstanceConfigMap = Schema.Record(ProviderInstanceId, ProviderInstanceConfig);
export type ProviderInstanceConfigMap = typeof ProviderInstanceConfigMap.Type;

/**
 * The legacy single-instance-per-driver world used the driver kind itself as
 * the instance id; preserving that mapping keeps existing persisted threads,
 * bindings, and cache files routable across the migration without rewriting
 * their stored selection payloads.
 */
export const defaultInstanceIdForDriver = (driver: ProviderDriverKind): ProviderInstanceId =>
  ProviderInstanceId.make(driver);
