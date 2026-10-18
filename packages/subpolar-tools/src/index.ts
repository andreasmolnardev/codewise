/**
 * Persistence-neutral tool registration and execution boundaries.
 *
 * This package deliberately does not know how context, policy, or persistence
 * are implemented. Environment-specific work belongs in registered adapter
 * handlers.
 */

export const TOOL_ADAPTER_KINDS = [
  "internal",
  "http",
  "openapi",
  "mcp",
  "browser",
  "memory",
  "subagent",
] as const;

export type ToolAdapterKind = (typeof TOOL_ADAPTER_KINDS)[number];

const adapterKinds = new Set<string>(TOOL_ADAPTER_KINDS);
const identifierPart = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const errorCodePattern = /^[A-Z][A-Z0-9_.-]{0,63}$/;

export interface CanonicalToolIdOptions {
  adapter?: string;
  namespace?: string;
}

export class ToolRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ToolRegistryError";
  }
}

export class UnknownAdapterError extends ToolRegistryError {
  constructor(adapter: unknown) {
    super("UNKNOWN_ADAPTER", `Unknown tool adapter: ${String(adapter)}`, { adapter });
    this.name = "UnknownAdapterError";
  }
}

export class DuplicateToolError extends ToolRegistryError {
  constructor(toolId: string) {
    super("DUPLICATE_TOOL", `A tool is already registered with ID: ${toolId}`, { toolId });
    this.name = "DuplicateToolError";
  }
}

export class InvalidToolIdError extends ToolRegistryError {
  constructor(value: unknown, message = "Tool ID is not canonicalizable") {
    super("INVALID_TOOL_ID", `${message}: ${String(value)}`, { value });
    this.name = "InvalidToolIdError";
  }
}

export class ToolExecutionError extends Error {
  readonly name = "ToolExecutionError";

  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * Build a cache key for an MCP connection owned by one authenticated principal.
 * `ownerId` must come from the host's trusted request context, never tool input
 * or remote MCP metadata. Authorization still belongs to the host policy.
 */
export function ownerScopedMcpCacheKey(ownerId: string, serverKey: string): string {
  if (typeof ownerId !== "string" || !ownerId.trim() || ownerId.trim() !== ownerId) {
    throw new ToolRegistryError("MCP_OWNER_REQUIRED", "A trusted MCP connection owner is required");
  }
  if (typeof serverKey !== "string" || !serverKey.trim() || serverKey.trim() !== serverKey) {
    throw new ToolRegistryError("MCP_SERVER_KEY_REQUIRED", "A non-empty MCP server key is required");
  }
  return `mcp:${JSON.stringify([ownerId, serverKey])}`;
}

export interface ToolError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ToolSuccess<T = unknown> {
  ok: true;
  value: T;
}

export interface ToolFailure {
  ok: false;
  error: ToolError;
}

export type ToolExecutionResult<T = unknown> = ToolSuccess<T> | ToolFailure;

export type JsonSchemaType = "array" | "boolean" | "integer" | "null" | "number" | "object" | "string";

export interface JsonSchema {
  type?: JsonSchemaType | readonly JsonSchemaType[];
  title?: string;
  description?: string;
  enum?: readonly unknown[];
  const?: unknown;
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  anyOf?: readonly JsonSchema[];
  allOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
  not?: JsonSchema;
  [keyword: string]: unknown;
}

export type SchemaValidationResult =
  | { valid: true }
  | { valid: false; errors: readonly string[] };

export interface ToolDefinition {
  /** Always a canonical ID returned by canonicalizeToolId. */
  readonly id: string;
  readonly adapter: ToolAdapterKind;
  readonly namespace: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonSchema;
  readonly enabled: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ToolDefinitionInput {
  /** If omitted, namespace and name are used to construct the ID. */
  id?: string;
  adapter: string;
  namespace?: string;
  name?: string;
  description?: string;
  inputSchema?: JsonSchema;
  enabled?: boolean;
  metadata?: Readonly<Record<string, string>>;
}

export interface ToolCall {
  readonly callId: string;
  readonly toolId: string;
  readonly input: unknown;
}

export interface ToolContext {
  readonly requestId?: string;
  readonly principal?: unknown;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly [key: string]: unknown;
}

export interface ToolContextBoundary {
  resolve(call: ToolCall): ToolContext | Promise<ToolContext>;
}

export type ContextBoundary = ToolContextBoundary | ((call: ToolCall) => ToolContext | Promise<ToolContext>);

/**
 * The registry never calls persistence methods. It only passes this injected
 * boundary to handlers, allowing a host to choose PocketBase, a file, memory,
 * or another store without coupling this package to that choice.
 */
export interface ToolPersistenceBoundary {
  get<T = unknown>(key: string): T | undefined | Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): void | Promise<void>;
  delete?(key: string): void | Promise<void>;
}

export type ToolPolicyDecision =
  | { kind: "allow"; reason?: string }
  | { kind: "deny"; reason?: string }
  | { kind: "approval_required"; reason?: string }
  | { allowed: boolean; reason?: string };

export type ToolPolicy = (
  definition: ToolDefinition,
  context: ToolContext,
  input: unknown,
) => ToolPolicyDecision | Promise<ToolPolicyDecision>;

export interface ToolHandlerRequest {
  readonly call: ToolCall;
  readonly definition: ToolDefinition;
  readonly context: ToolContext;
  readonly persistence?: ToolPersistenceBoundary;
}

export type ToolHandler = (
  request: ToolHandlerRequest,
) => unknown | Promise<unknown>;

export interface ToolAdapter {
  /** Runtime validation intentionally accepts string so bad integrations fail clearly. */
  readonly kind: string;
  readonly execute: ToolHandler;
}

export interface RedactionHooks {
  input?(value: unknown, request: ToolHandlerRequest): unknown;
  output?(value: unknown, request: ToolHandlerRequest): unknown;
  error?(error: ToolError, request: ToolHandlerRequest): ToolError;
}

export type ToolExecutionStatus = "executed" | "failed";

export interface ToolExecutionEvent {
  readonly status: ToolExecutionStatus;
  readonly callId: string;
  readonly toolId: string;
  readonly adapter: ToolAdapterKind;
  readonly input: unknown;
  readonly output?: unknown;
  readonly error?: ToolError;
}

export interface ToolRegistryOptions {
  adapters?: readonly ToolAdapter[];
  /** No policy means deny; authorization is never implicitly granted. */
  policy?: ToolPolicy;
  context?: ContextBoundary;
  persistence?: ToolPersistenceBoundary;
  redaction?: RedactionHooks;
  onExecution?: (event: ToolExecutionEvent) => void | Promise<void>;
}

export interface ToolAuthorization {
  readonly call: ToolCall;
  readonly definition: ToolDefinition;
  readonly context: ToolContext;
  readonly policyReason?: string;
}

export interface ToolRegistry {
  registerAdapter(adapter: ToolAdapter): void;
  registerTool(input: ToolDefinitionInput): ToolDefinition;
  get(toolId: string): ToolDefinition | undefined;
  list(): readonly ToolDefinition[];
  authorize(call: ToolCall, context?: ToolContext): Promise<ToolAuthorization>;
  execute<T = unknown>(call: ToolCall, context?: ToolContext): Promise<ToolExecutionResult<T>>;
  /**
   * Invoke only a capability produced by authorize on this registry instance.
   * Callers cannot set an `authorized` flag or manufacture this capability by
   * shape alone, so this method is not a policy bypass.
   */
  invokeAuthorized<T = unknown>(authorization: ToolAuthorization): Promise<ToolExecutionResult<T>>;
}

function isKnownAdapter(value: unknown): value is ToolAdapterKind {
  return typeof value === "string" && adapterKinds.has(value.toLowerCase());
}

function normalizePart(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || !identifierPart.test(value)) {
    throw new InvalidToolIdError(value, `${label} must be a non-empty identifier without whitespace`);
  }
  return value.toLowerCase();
}

interface CanonicalParts {
  adapter: ToolAdapterKind;
  namespace: string;
  name: string;
}

function splitToolId(value: string): string[] {
  const scheme = value.match(/^([A-Za-z][A-Za-z0-9_-]*):\/\/(.*)$/);
  if (scheme) return [scheme[1], ...scheme[2].split("/")];
  const prefix = value.match(/^([A-Za-z][A-Za-z0-9_-]*):(.*)$/);
  if (prefix) return [prefix[1], ...prefix[2].split("/")];
  return value.split("/");
}

function canonicalParts(value: unknown, options: CanonicalToolIdOptions = {}): CanonicalParts {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new InvalidToolIdError(value, "Tool ID must be a non-empty string without surrounding whitespace");
  }

  const pieces = splitToolId(value);
  let adapterText = options.adapter;
  let remainder = pieces;
  if (pieces.length >= 2 && isKnownAdapter(pieces[0])) {
    adapterText = pieces[0];
    remainder = pieces.slice(1);
  }
  if (!adapterText) adapterText = "internal";
  if (!isKnownAdapter(adapterText)) throw new UnknownAdapterError(adapterText);
  if (pieces.length >= 2 && isKnownAdapter(pieces[0]) && options.adapter && pieces[0].toLowerCase() !== options.adapter.toLowerCase()) {
    throw new InvalidToolIdError(value, "Tool ID adapter does not match the supplied adapter");
  }

  if (remainder.length === 1 && options.namespace) remainder = [options.namespace, remainder[0]];
  if (remainder.length === 1) remainder = ["default", remainder[0]];
  if (remainder.length !== 2) throw new InvalidToolIdError(value, "Tool ID must contain an adapter, namespace, and name");

  return {
    adapter: normalizePart(adapterText, "adapter") as ToolAdapterKind,
    namespace: normalizePart(remainder[0], "namespace"),
    name: normalizePart(remainder[1], "tool name"),
  };
}

/**
 * Canonical IDs are lower-case `adapter/namespace/name` strings. The parser
 * also accepts `adapter:namespace/name`, `adapter://namespace/name`,
 * `namespace/name` (internal), and a bare name (internal/default).
 */
export function canonicalizeToolId(value: unknown, options: CanonicalToolIdOptions = {}): string {
  const parts = canonicalParts(value, options);
  return `${parts.adapter}/${parts.namespace}/${parts.name}`;
}

export const canonicalToolId = canonicalizeToolId;

function validationError(path: string, message: string): string {
  return `${path || "$"} ${message}`;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function schemaTypes(schema: JsonSchema): readonly string[] | undefined {
  const type = schema.type;
  if (type === undefined) return undefined;
  return typeof type === "string" ? [type] : type;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function validateSchemaValue(value: unknown, schema: JsonSchema, path: string): string[] {
  const errors: string[] = [];
  const types = schemaTypes(schema);
  if (types && !types.some((type) => matchesType(value, type))) {
    errors.push(validationError(path, `must be ${types.join(" or ")}`));
    return errors;
  }
  if (schema.const !== undefined && !sameValue(value, schema.const)) errors.push(validationError(path, "must equal const"));
  if (schema.enum && !schema.enum.some((candidate) => sameValue(value, candidate))) errors.push(validationError(path, "must be one of the allowed values"));

  if (schema.anyOf && !schema.anyOf.some((candidate) => validateSchemaValue(value, candidate, path).length === 0)) errors.push(validationError(path, "must match at least one schema"));
  if (schema.oneOf && schema.oneOf.filter((candidate) => validateSchemaValue(value, candidate, path).length === 0).length !== 1) errors.push(validationError(path, "must match exactly one schema"));
  if (schema.allOf) for (const candidate of schema.allOf) errors.push(...validateSchemaValue(value, candidate, path));
  if (schema.not && validateSchemaValue(value, schema.not, path).length === 0) errors.push(validationError(path, "must not match the schema"));

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(validationError(path, `must contain at least ${schema.minLength} characters`));
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(validationError(path, `must contain at most ${schema.maxLength} characters`));
    if (schema.pattern !== undefined) {
      try { if (!new RegExp(schema.pattern).test(value)) errors.push(validationError(path, "does not match the required pattern")); }
      catch { errors.push(validationError(path, "uses an invalid schema pattern")); }
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(validationError(path, `must be >= ${schema.minimum}`));
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(validationError(path, `must be <= ${schema.maximum}`));
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) errors.push(validationError(path, `must be > ${schema.exclusiveMinimum}`));
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) errors.push(validationError(path, `must be < ${schema.exclusiveMaximum}`));
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(validationError(path, `must contain at least ${schema.minItems} items`));
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(validationError(path, `must contain at most ${schema.maxItems} items`));
    if (schema.items) value.forEach((entry, index) => errors.push(...validateSchemaValue(entry, schema.items!, `${path || "$"}[${index}]`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    for (const required of schema.required ?? []) if (!(required in objectValue)) errors.push(validationError(`${path || "$"}.${required}`, "is required"));
    const properties = schema.properties ?? {};
    for (const [key, entry] of Object.entries(objectValue)) {
      if (key in properties) errors.push(...validateSchemaValue(entry, properties[key], `${path || "$"}.${key}`));
      else if (schema.additionalProperties === false) errors.push(validationError(`${path || "$"}.${key}`, "is not allowed"));
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") errors.push(...validateSchemaValue(entry, schema.additionalProperties, `${path || "$"}.${key}`));
    }
  }
  return errors;
}

export function validateToolInput(input: unknown, schema: JsonSchema): SchemaValidationResult {
  const errors = validateSchemaValue(input, schema, "$");
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

function policyKind(decision: ToolPolicyDecision): "allow" | "deny" | "approval_required" {
  if ("kind" in decision) return decision.kind;
  return decision.allowed ? "allow" : "deny";
}

function errorCode(code: unknown, fallback: string): string {
  return typeof code === "string" && errorCodePattern.test(code) ? code : fallback;
}

function asError(error: unknown, request: ToolHandlerRequest, redaction?: RedactionHooks): ToolError {
  const candidate = error instanceof ToolExecutionError
    ? { code: error.code, message: error.message, details: error.details }
    : { code: "ADAPTER_EXECUTION_FAILED", message: "Tool adapter execution failed", details: undefined };
  let result: ToolError = {
    code: errorCode(candidate.code, "ADAPTER_EXECUTION_FAILED"),
    message: candidate.message || "Tool adapter execution failed",
    ...(candidate.details === undefined ? {} : { details: candidate.details }),
  };
  if (redaction?.error) {
    try { result = redaction.error(result, request); } catch { result = { code: "REDACTION_FAILED", message: "Tool execution failed" }; }
  }
  return result;
}

function failure(error: ToolError): ToolFailure {
  return { ok: false, error };
}

function contextResolver(boundary: ContextBoundary | undefined): ((call: ToolCall) => Promise<ToolContext>) | undefined {
  if (!boundary) return undefined;
  return typeof boundary === "function" ? async (call) => boundary(call) : async (call) => boundary.resolve(call);
}

export class DefaultToolRegistry implements ToolRegistry {
  private readonly adapters = new Map<ToolAdapterKind, ToolAdapter>();
  private readonly definitions = new Map<string, ToolDefinition>();
  private readonly authorizations = new WeakSet<object>();
  private readonly resolveContext: ((call: ToolCall) => Promise<ToolContext>) | undefined;
  private readonly policy: ToolPolicy;

  constructor(private readonly options: ToolRegistryOptions = {}) {
    this.resolveContext = contextResolver(options.context);
    this.policy = options.policy ?? (() => ({ kind: "deny", reason: "No tool policy is configured" }));
    for (const adapter of options.adapters ?? []) this.registerAdapter(adapter);
  }

  registerAdapter(adapter: ToolAdapter): void {
    if (!adapter || !isKnownAdapter(adapter.kind)) throw new UnknownAdapterError(adapter?.kind);
    if (typeof adapter.execute !== "function") throw new ToolRegistryError("INVALID_ADAPTER", `Adapter ${adapter.kind} must provide an execute handler`);
    const kind = adapter.kind.toLowerCase() as ToolAdapterKind;
    if (this.adapters.has(kind)) throw new ToolRegistryError("DUPLICATE_ADAPTER", `An adapter is already registered: ${kind}`, { adapter: kind });
    this.adapters.set(kind, { ...adapter, kind });
  }

  registerTool(input: ToolDefinitionInput): ToolDefinition {
    if (!input || typeof input !== "object") throw new ToolRegistryError("INVALID_TOOL", "Tool definition must be an object");
    if (!isKnownAdapter(input.adapter)) throw new UnknownAdapterError(input.adapter);
    const adapter = input.adapter.toLowerCase() as ToolAdapterKind;
    const id = input.id === undefined
      ? canonicalizeToolId(`${input.namespace ?? ""}/${input.name ?? ""}`, { adapter })
      : canonicalizeToolId(input.id, { adapter, namespace: input.namespace });
    const parts = canonicalParts(id);
    const definition: ToolDefinition = Object.freeze({
      id,
      adapter,
      namespace: parts.namespace,
      name: parts.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      inputSchema: input.inputSchema ?? {},
      enabled: input.enabled ?? true,
      ...(input.metadata === undefined ? {} : { metadata: Object.freeze({ ...input.metadata }) }),
    });
    if (this.definitions.has(id)) throw new DuplicateToolError(id);
    this.definitions.set(id, definition);
    return definition;
  }

  get(toolId: string): ToolDefinition | undefined {
    try { return this.definitions.get(canonicalizeToolId(toolId)); }
    catch { return undefined; }
  }

  list(): readonly ToolDefinition[] {
    return [...this.definitions.values()];
  }

  private async resolvedContext(call: ToolCall, context?: ToolContext): Promise<ToolContext> {
    if (context) return context;
    return (await this.resolveContext?.(call)) ?? {};
  }

  async authorize(call: ToolCall, context?: ToolContext): Promise<ToolAuthorization> {
    const resolvedContext = await this.resolvedContext(call, context);
    let canonicalId: string;
    try { canonicalId = canonicalizeToolId(call.toolId); }
    catch (error) { throw error instanceof ToolRegistryError ? new ToolExecutionError(error.code, error.message, error.details) : new ToolExecutionError("INVALID_TOOL_ID", "Invalid tool ID"); }
    const definition = this.definitions.get(canonicalId);
    if (!definition) throw new ToolExecutionError("UNKNOWN_TOOL", `Unknown tool: ${canonicalId}`);
    if (!definition.enabled) throw new ToolExecutionError("TOOL_DISABLED", `Tool is disabled: ${canonicalId}`);
    const inputValidation = validateToolInput(call.input, definition.inputSchema);
    if (inputValidation.valid === false) throw new ToolExecutionError("INVALID_TOOL_INPUT", "Tool input failed schema validation", inputValidation.errors);

    let decision: ToolPolicyDecision;
    try { decision = await this.policy(definition, resolvedContext, call.input); }
    catch { throw new ToolExecutionError("POLICY_FAILED", "Tool policy evaluation failed"); }
    const kind = policyKind(decision);
    if (kind === "deny") throw new ToolExecutionError("POLICY_DENIED", decision.reason ?? "Tool denied by policy");
    if (kind === "approval_required") throw new ToolExecutionError("APPROVAL_REQUIRED", decision.reason ?? "Tool approval is required");

    const authorization: ToolAuthorization = Object.freeze({
      call: Object.freeze({ ...call, toolId: canonicalId }),
      definition,
      context: resolvedContext,
      ...(decision.reason === undefined ? {} : { policyReason: decision.reason }),
    });
    this.authorizations.add(authorization);
    return authorization;
  }

  async execute<T = unknown>(call: ToolCall, context?: ToolContext): Promise<ToolExecutionResult<T>> {
    try {
      const authorization = await this.authorize(call, context);
      return await this.invokeAuthorized<T>(authorization);
    } catch (error) {
      const request = this.requestForFailure(call, context);
      return failure(this.publicError(error, request));
    }
  }

  async invokeAuthorized<T = unknown>(authorization: ToolAuthorization): Promise<ToolExecutionResult<T>> {
    if (!authorization || typeof authorization !== "object" || !this.authorizations.has(authorization as object)) {
      return failure({ code: "AUTHORIZATION_REQUIRED", message: "A registry-issued authorization is required" });
    }
    const definition = this.definitions.get(authorization.definition.id);
    if (!definition || definition !== authorization.definition) return failure({ code: "AUTHORIZATION_STALE", message: "Tool authorization is stale" });
    if (!definition.enabled) return failure({ code: "TOOL_DISABLED", message: `Tool is disabled: ${definition.id}` });
    const adapter = this.adapters.get(definition.adapter);
    if (!adapter) return failure({ code: "ADAPTER_NOT_REGISTERED", message: `No handler is registered for adapter: ${definition.adapter}` });

    const request: ToolHandlerRequest = {
      call: authorization.call,
      definition,
      context: authorization.context,
      persistence: this.options.persistence,
    };
    try {
      const value = await adapter.execute(request);
      await this.observe({
        status: "executed",
        callId: request.call.callId,
        toolId: definition.id,
        adapter: definition.adapter,
        input: this.redactInput(request.call.input, request),
        output: this.options.redaction?.output ? this.options.redaction.output(value, request) : value,
      });
      return { ok: true, value: value as T };
    } catch (error) {
      const toolError = asError(error, request, this.options.redaction);
      await this.observe({
        status: "failed",
        callId: request.call.callId,
        toolId: definition.id,
        adapter: definition.adapter,
        input: this.redactInput(request.call.input, request),
        error: toolError,
      });
      return failure(toolError);
    }
  }

  private requestForFailure(call: ToolCall, context?: ToolContext): ToolHandlerRequest {
    const definition = this.get(call.toolId) ?? {
      id: call.toolId,
      adapter: "internal" as const,
      namespace: "default",
      name: "unknown",
      inputSchema: {},
      enabled: false,
    };
    return { call, definition, context: context ?? {}, persistence: this.options.persistence };
  }

  private publicError(error: unknown, request: ToolHandlerRequest): ToolError {
    let result: ToolError;
    if (error instanceof ToolExecutionError) {
      result = { code: errorCode(error.code, "TOOL_EXECUTION_FAILED"), message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
    } else if (error instanceof ToolRegistryError) {
      result = { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
    } else {
      result = { code: "TOOL_EXECUTION_FAILED", message: "Tool execution failed" };
    }
    if (!this.options.redaction?.error) return result;
    try { return this.options.redaction.error(result, request); } catch { return { code: "REDACTION_FAILED", message: "Tool execution failed" }; }
  }

  private redactInput(input: unknown, request: ToolHandlerRequest): unknown {
    if (!this.options.redaction?.input) return input;
    try { return this.options.redaction.input(input, request); } catch { return "[REDACTED]"; }
  }

  private async observe(event: ToolExecutionEvent): Promise<void> {
    try { await this.options.onExecution?.(event); } catch { /* Observation must not change tool outcome. */ }
  }
}

export function createToolRegistry(options: ToolRegistryOptions = {}): ToolRegistry {
  return new DefaultToolRegistry(options);
}
