import type { ToolDefinition, ToolRegistry } from "@subpolar/tools";
export const OPENAPI_LIMITS = {
  maxDocumentBytes: 4 * 1024 * 1024,
  maxPaths: 500,
  maxOperations: 1_000,
  maxParameters: 100,
  maxSchemaDepth: 16,
  maxSchemaEntries: 128,
  maxDescriptionLength: 1_000,
} as const;

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];
type Risk = "read" | "write" | "delete";
type JsonObject = Record<string, unknown>;

const secretName = /(?:authorization|api.?key|token|secret|password|credential|cookie|private.?key)/i;
const unsafeHeaderName = /^(?:host|connection|content-length|transfer-encoding|te|trailer|upgrade|proxy-.*|forwarded|x-forwarded-.*)$/i;
const namePattern = /^[a-z][a-z0-9._-]{0,63}$/;
const operationIdPattern = /^[a-z][a-z0-9._:-]{0,127}$/i;
const schemaKeys = new Set([
  "type", "title", "description", "format", "default", "enum", "const", "properties", "required",
  "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength", "pattern",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "anyOf", "oneOf",
  "allOf", "not", "nullable", "readOnly", "writeOnly", "deprecated",
]);

export interface OpenApiProviderInput {
  readonly name: string;
  readonly document: unknown;
  readonly baseUrl?: string;
  readonly operations?: readonly string[];
}

export interface OpenApiDiscoveryOptions {
  /** Exact HTTPS origins trusted by host configuration, never supplied by a tool call. */
  readonly allowedOrigins: readonly string[];
}

export interface OpenApiToolDefinition extends ToolDefinition {
  readonly adapter: "openapi";
  readonly risk: Risk;
  readonly requiresApproval: boolean;
  readonly target: string;
  readonly operationId: string;
  readonly outputSchema: JsonObject;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function boundedDocument(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("OpenAPI document must be an object");
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new TypeError("OpenAPI document must be JSON serializable"); }
  if (Buffer.byteLength(serialized) > OPENAPI_LIMITS.maxDocumentBytes) throw new TypeError("OpenAPI document exceeds the configured size limit");
  const document = value as JsonObject;
  if (typeof document.openapi !== "string" && typeof document.swagger !== "string") throw new TypeError("OpenAPI document must declare openapi or swagger");
  if (!document.paths || typeof document.paths !== "object" || Array.isArray(document.paths)) throw new TypeError("OpenAPI document must contain paths");
  if (Object.keys(object(document.paths)).length > OPENAPI_LIMITS.maxPaths) throw new TypeError("OpenAPI document contains too many paths");
  return document;
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new TypeError("Allowed OpenAPI origins must be valid URLs"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || !isPublicHostname(parsed.hostname)) {
    throw new TypeError("Allowed OpenAPI origins must be public HTTPS host origins without credentials, paths, or IP literals");
  }
  return parsed.origin;
}

function isPublicHostname(hostname: string): boolean {
  return !hostname.includes(":") && !/^\d+(?:\.\d+){3}$/.test(hostname) && hostname !== "localhost" && !/\.(?:localhost|local|internal)$/.test(hostname);
}

function resolveLocalRef(document: JsonObject, value: unknown): unknown {
  const ref = object(value).$ref;
  if (ref === undefined) return value;
  if (typeof ref !== "string" || !ref.startsWith("#/") || ref.startsWith("#//")) throw new TypeError("OpenAPI external references are not supported");
  let result: unknown = document;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    result = object(result)[key];
    if (result === undefined) throw new TypeError("OpenAPI reference does not resolve");
  }
  return result;
}

function normalizeSchema(document: JsonObject, value: unknown, depth = 0, refs = new Set<string>()): JsonObject {
  if (depth > OPENAPI_LIMITS.maxSchemaDepth) throw new TypeError("OpenAPI schema exceeds the nesting limit");
  const input = object(value);
  if (typeof input.$ref === "string") {
    if (refs.has(input.$ref)) throw new TypeError("OpenAPI schema contains a circular reference");
    const nextRefs = new Set(refs);
    nextRefs.add(input.$ref);
    const resolved = object(resolveLocalRef(document, value));
    return normalizeSchema(document, resolved, depth + 1, nextRefs);
  }

  const output: JsonObject = {};
  for (const key of Object.keys(input).slice(0, OPENAPI_LIMITS.maxSchemaEntries)) {
    if (!schemaKeys.has(key) || secretName.test(key)) continue;
    const item = input[key];
    if (key === "properties") {
      const properties = object(item);
      output.properties = Object.fromEntries(Object.entries(properties).slice(0, OPENAPI_LIMITS.maxSchemaEntries)
        .filter(([name]) => !secretName.test(name))
        .map(([name, schema]) => [name, normalizeSchema(document, schema, depth + 1, refs)]));
    } else if (key === "items" || key === "not") {
      output[key] = normalizeSchema(document, item, depth + 1, refs);
    } else if (key === "allOf" || key === "anyOf" || key === "oneOf") {
      if (!Array.isArray(item)) continue;
      output[key === "allOf" ? "allOf" : "anyOf"] = item.slice(0, OPENAPI_LIMITS.maxSchemaEntries)
        .map((schema) => normalizeSchema(document, schema, depth + 1, refs));
    } else if (key === "required") {
      if (Array.isArray(item)) output.required = item.filter((name): name is string => typeof name === "string" && !secretName.test(name)).slice(0, OPENAPI_LIMITS.maxSchemaEntries);
    } else if (key === "additionalProperties") {
      output.additionalProperties = typeof item === "boolean" ? item : normalizeSchema(document, item, depth + 1, refs);
    } else if (key === "description" || key === "title") {
      if (typeof item === "string") output[key] = item.replace(/[\r\n\0]/g, " ").slice(0, OPENAPI_LIMITS.maxDescriptionLength);
    } else if (key === "enum") {
      if (Array.isArray(item)) output.enum = item.slice(0, OPENAPI_LIMITS.maxSchemaEntries);
    } else if (key === "type") {
      if (typeof item === "string" || (Array.isArray(item) && item.every((type) => typeof type === "string"))) output.type = item;
    } else if (item === null || ["string", "number", "boolean"].includes(typeof item)) {
      output[key] = typeof item === "string" ? item.slice(0, OPENAPI_LIMITS.maxDescriptionLength) : item;
    }
  }
  return output;
}

function operationParameters(document: JsonObject, pathItem: JsonObject, operation: JsonObject): {
  properties: JsonObject;
  required: string[];
  parameters: Array<{ name: string; in: string }>;
} {
  const properties: JsonObject = {};
  const required: string[] = [];
  const parameters: Array<{ name: string; in: string }> = [];
  const seen = new Set<string>();
  const rawParameters = [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
  if (rawParameters.length > OPENAPI_LIMITS.maxParameters) throw new TypeError("OpenAPI operation contains too many parameters");
  for (const raw of rawParameters) {
    const parameter = object(resolveLocalRef(document, raw));
    if (typeof parameter.name !== "string" || !["path", "query", "header"].includes(String(parameter.in)) || secretName.test(parameter.name)) continue;
    if (parameter.in === "header" && unsafeHeaderName.test(parameter.name)) continue;
    if (seen.has(parameter.name)) throw new TypeError("OpenAPI parameters with duplicate names are not supported");
    seen.add(parameter.name);
    const parameterSchema = normalizeSchema(document, parameter.schema ?? {});
    if (parameter.description && typeof parameter.description === "string") parameterSchema.description = parameter.description.slice(0, OPENAPI_LIMITS.maxDescriptionLength);
    properties[parameter.name] = parameterSchema;
    parameters.push({ name: parameter.name, in: String(parameter.in) });
    if (parameter.required === true) required.push(parameter.name);
  }
  const requestBody = object(resolveLocalRef(document, operation.requestBody));
  const content = object(requestBody.content);
  const jsonBody = object(content["application/json"]);
  if (jsonBody.schema !== undefined) {
    if (seen.has("body")) throw new TypeError("OpenAPI parameter conflicts with the request body field");
    const body = normalizeSchema(document, jsonBody.schema);
    if (requestBody.description && typeof requestBody.description === "string") body.description = requestBody.description.slice(0, OPENAPI_LIMITS.maxDescriptionLength);
    properties.body = body;
    if (requestBody.required === true) required.push("body");
  }
  return { properties, required, parameters };
}

function endpoint(baseUrl: string, path: string, allowedOrigins: ReadonlySet<string>): { url: string; origin: string } {
  let base: URL;
  try { base = new URL(baseUrl); } catch { throw new TypeError("OpenAPI server URL is invalid"); }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || !isPublicHostname(base.hostname)) {
    throw new TypeError("OpenAPI server must use a public HTTPS hostname without credentials, query, or fragment");
  }
  if (/[{}]/.test(baseUrl)) throw new TypeError("OpenAPI server variables must be resolved by host configuration");
  if (!allowedOrigins.has(base.origin)) throw new TypeError("OpenAPI server origin is not allowed by host policy");
  if (!path.startsWith("/") || path.startsWith("//") || /[\\?#\0\r\n]/.test(path) || /%(?:2e|2f|5c)/i.test(path) || /%(?![0-9a-f]{2})/i.test(path) || path.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError("OpenAPI path is invalid");
  }
  const pathname = `${base.pathname.replace(/\/$/, "")}${path}` || "/";
  const result = new URL(pathname, base.origin);
  if (result.origin !== base.origin || !allowedOrigins.has(result.origin)) throw new TypeError("OpenAPI operation escaped its allowed server origin");
  return { url: `${result.origin}${result.pathname.replace(/%7B/gi, "{").replace(/%7D/gi, "}")}`, origin: result.origin };
}

function slug(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^[^a-z]+/, "").slice(0, 64);
  if (!namePattern.test(result)) throw new TypeError("OpenAPI provider or operation identifier is invalid");
  return result;
}

function riskFor(method: HttpMethod): Risk {
  if (method === "delete") return "delete";
  if (method === "get" || method === "head" || method === "options") return "read";
  return "write";
}

function successSchema(document: JsonObject, operation: JsonObject): JsonObject {
  const responses = object(operation.responses);
  const response = object(resolveLocalRef(document, responses["200"] ?? responses["201"] ?? responses["202"] ?? responses["default"]));
  const content = object(response.content);
  const json = object(content["application/json"]);
  return json.schema === undefined ? { type: "object", additionalProperties: true } : normalizeSchema(document, json.schema);
}

/**
 * Turns supplied OpenAPI data into policy-gateway definitions. This function
 * performs no network or file access and never executes generated operations.
 */
export function discoverOpenApiTools(provider: OpenApiProviderInput, options: OpenApiDiscoveryOptions): OpenApiToolDefinition[] {
  const document = boundedDocument(provider.document);
  const providerName = slug(provider.name);
  if (!Array.isArray(options.allowedOrigins) || options.allowedOrigins.length === 0) throw new TypeError("At least one host-approved OpenAPI origin is required");
  const allowedOrigins = new Set(options.allowedOrigins.map(normalizeOrigin));
  const servers = Array.isArray(document.servers) ? document.servers : [];
  const specServer = object(servers[0]).url;
  const baseUrl = provider.baseUrl ?? (typeof specServer === "string" ? specServer : undefined);
  if (!baseUrl) throw new TypeError("OpenAPI server URL is required");

  const selected = provider.operations === undefined ? undefined : new Set(provider.operations);
  if (provider.operations && (selected?.size !== provider.operations.length || provider.operations.some((id) => !operationIdPattern.test(id)))) {
    throw new TypeError("OpenAPI operation selection must contain unique valid operation IDs");
  }

  const definitions: OpenApiToolDefinition[] = [];
  const ids = new Set<string>();
  let operationCount = 0;
  for (const [path, rawPathItem] of Object.entries(object(document.paths))) {
    const pathItem = object(resolveLocalRef(document, rawPathItem));
    for (const method of HTTP_METHODS) {
      const operation = object(pathItem[method]);
      if (Object.keys(operation).length === 0) continue;
      if (++operationCount > OPENAPI_LIMITS.maxOperations) throw new TypeError("OpenAPI document contains too many operations");
      const operationId = operation.operationId;
      if (typeof operationId !== "string" || !operationIdPattern.test(operationId)) continue;
      if (selected && !selected.has(operationId)) continue;
      const name = slug(operationId);
      const id = `openapi/${providerName}/${name}`;
      if (ids.has(id)) throw new TypeError("OpenAPI operation IDs collide after normalization");
      ids.add(id);
      const target = endpoint(baseUrl, path, allowedOrigins);
      const parsed = operationParameters(document, pathItem, operation);
      const risk = riskFor(method);
      const summary = typeof operation.summary === "string" ? operation.summary : typeof operation.description === "string" ? operation.description : `${method.toUpperCase()} ${path}`;
      const description = summary.replace(/[\r\n\0]/g, " ").slice(0, OPENAPI_LIMITS.maxDescriptionLength);
      const metadata = Object.freeze({
        "openapi.operationId": operationId,
        "openapi.origin": target.origin,
        "openapi.path": path,
        "openapi.url": target.url,
        "openapi.method": method.toUpperCase(),
        "openapi.parameters": JSON.stringify(parsed.parameters),
        "openapi.risk": risk,
        "openapi.requiresApproval": risk !== "read" ? "true" : "false",
      });
      definitions.push(Object.freeze({
        id,
        adapter: "openapi" as const,
        namespace: providerName,
        name,
        description,
        inputSchema: Object.freeze({ type: "object", properties: parsed.properties, required: [...new Set(parsed.required)], additionalProperties: false }),
        enabled: true,
        metadata,
        risk,
        requiresApproval: risk !== "read",
        target: target.url,
        operationId,
        outputSchema: successSchema(document, operation),
      }));
    }
  }
  if (selected) {
    const found = new Set(definitions.map((definition) => definition.operationId));
    for (const operationId of selected) if (!found.has(operationId)) throw new TypeError(`Unknown OpenAPI operation ID: ${operationId}`);
  }
  return definitions;
}

/** Register definitions only; execution remains behind @subpolar/tools policy and adapter approval. */
export function registerOpenApiToolDefinitions(registry: Pick<ToolRegistry, "registerTool">, definitions: readonly OpenApiToolDefinition[]): readonly ToolDefinition[] {
  return definitions.map((definition) => registry.registerTool({
    id: definition.id,
    adapter: definition.adapter,
    namespace: definition.namespace,
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    enabled: definition.enabled,
    metadata: definition.metadata,
  }));
}
import type { ToolDefinition, ToolRegistry } from "@subpolar/tools";
