import type { AgentRunPort, JsonValue, RunProgressEmitter, RunRequest, RuntimeToolInvoker, StatelessExecutor, ToolDefinition } from "../../subpolar-contracts/src/index.ts";

export interface PiExecutionContext {
  principal: RunRequest["context"]["principal"];
  sessionId?: string;
  projectId?: string;
  agentId?: string;
  model?: string;
  permission?: string;
  cwd?: string;
  metadata?: RunRequest["context"]["metadata"];
}

export interface PiTranscriptEntry {
  role: "user" | "assistant" | "tool";
  content: JsonValue;
  occurredAt?: string;
  metadata?: JsonValue;
}

/**
 * A caller-owned projection of transcript state. It is input to one execution;
 * it is not a Pi session record and is never loaded or written by this adapter.
 */
export interface PiTranscriptProjection {
  entries: readonly PiTranscriptEntry[];
  sessionId?: string;
  leafId?: string | null;
}

export interface PiRunRequest extends RunRequest {
  transcript?: PiTranscriptProjection | readonly PiTranscriptEntry[];
  tools?: RuntimeToolInvoker;
  toolDefinitions?: readonly ToolDefinition[];
}

export interface PiStreamEvent {
  type: "text" | "status" | "tool" | "message";
  data: JsonValue;
}

export interface PiExecutionRequest {
  runId: string;
  requestId: string;
  prompt: string;
  context: PiExecutionContext;
  transcript: PiTranscriptProjection;
  toolDefinitions?: readonly ToolDefinition[];
  signal?: AbortSignal;
  emit: (event: PiStreamEvent | unknown) => void | Promise<void>;
  tools?: RuntimeToolInvoker;
}

export interface PiExecutor {
  execute(request: PiExecutionRequest): unknown | Promise<unknown>;
  dispose?: () => void | Promise<void>;
}

/** A transient executor that can be used as the per-run Pi session resource. */
export interface PiExecutionSession extends PiExecutor {
  readonly transcript: PiTranscriptProjection;
  readonly disposed: boolean;
}

export type PiExecutorFactory<Config = unknown> = ((
  config: Config,
  request?: PiExecutionRequest,
) => PiExecutor | Promise<PiExecutor>) & {
  /** Set only when this factory can reopen its own persisted native sessions. */
  readonly supportsPersistentSessions?: boolean;
};
export type PiExecutorModule =
  | PiExecutorFactory
  | { default?: PiExecutorFactory; createPiExecutor?: PiExecutorFactory };

export interface PiRunPort extends AgentRunPort {
  readonly capabilities: typeof piAdapterCapabilities;
  run(request: PiRunRequest, emit?: RunProgressEmitter): Promise<unknown>;
}

export const piAdapterCapabilities = {
  adapter: "pi-transient",
  durability: "ephemeral",
  supports: {
    "session.persistence": false,
    "run.outcome.persistence": false,
    "event.replay": false,
    "multi-process-concurrency": false,
    "durable-approvals": false,
  },
} as const;

export class PiProviderError extends Error {
  readonly code = "PI_PROVIDER_ERROR";
  readonly details?: JsonValue;

  constructor(message = "Pi provider execution failed", details?: JsonValue) {
    super(message);
    this.name = "PiProviderError";
    this.details = details;
  }
}

export class PiRuntimeError extends Error {
  readonly code = "PI_RUNTIME_ERROR";
  readonly details?: JsonValue;

  constructor(message = "Pi runtime execution failed", details?: JsonValue) {
    super(message);
    this.name = "PiRuntimeError";
    this.details = details;
  }
}

function mapContext(request: RunRequest): PiExecutionContext {
  const { principal, sessionId, projectId, agentId, model, permission, cwd, metadata } = request.context;
  return {
    principal,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(model === undefined ? {} : { model }),
    ...(permission === undefined ? {} : { permission }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(metadata === undefined ? {} : { metadata: { ...metadata } }),
  };
}

function jsonDetails(value: unknown, seen = new WeakSet<object>()): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => jsonDetails(entry, seen) ?? null);
  const result: { [key: string]: JsonValue } = {};
  for (const [key, entry] of Object.entries(value)) result[key] = jsonDetails(entry, seen) ?? null;
  return result;
}

function normalizeTranscriptEntry(value: unknown, index: number): PiTranscriptEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PiRuntimeError(`Transcript entry ${index} must be an object`);
  }
  const entry = value as { role?: unknown; content?: unknown; occurredAt?: unknown; metadata?: unknown };
  if (entry.role !== "user" && entry.role !== "assistant" && entry.role !== "tool") {
    throw new PiRuntimeError(`Transcript entry ${index} has an invalid role`);
  }
  const content = jsonDetails(entry.content);
  if (content === undefined) throw new PiRuntimeError(`Transcript entry ${index} has invalid content`);
  if (entry.occurredAt !== undefined && typeof entry.occurredAt !== "string") {
    throw new PiRuntimeError(`Transcript entry ${index} has an invalid timestamp`);
  }
  const metadata = entry.metadata === undefined ? undefined : jsonDetails(entry.metadata);
  if (entry.metadata !== undefined && metadata === undefined) {
    throw new PiRuntimeError(`Transcript entry ${index} has invalid metadata`);
  }
  return {
    role: entry.role,
    content,
    ...(entry.occurredAt === undefined ? {} : { occurredAt: entry.occurredAt }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/** Normalize and defensively clone a caller-provided transcript projection. */
export function normalizePiTranscriptProjection(
  value: PiTranscriptProjection | readonly PiTranscriptEntry[] | undefined,
): PiTranscriptProjection {
  const source: PiTranscriptProjection = value === undefined
    ? { entries: [] }
    : Array.isArray(value as unknown)
      ? { entries: [...(value as readonly PiTranscriptEntry[])] }
      : value as PiTranscriptProjection;
  if (!source || typeof source !== "object" || !Array.isArray(source.entries)) {
    throw new PiRuntimeError("Pi transcript projection must contain an entries array");
  }
  if (source.sessionId !== undefined && typeof source.sessionId !== "string") {
    throw new PiRuntimeError("Pi transcript projection has an invalid session ID");
  }
  if (source.leafId !== undefined && source.leafId !== null && typeof source.leafId !== "string") {
    throw new PiRuntimeError("Pi transcript projection has an invalid leaf ID");
  }
  return {
    entries: source.entries.map((entry, index) => normalizeTranscriptEntry(entry, index)),
    ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }),
    ...(source.leafId === undefined ? {} : { leafId: source.leafId }),
  };
}

const normalizedEventTypes = new Set<PiStreamEvent["type"]>(["text", "status", "tool", "message"]);
const eventTypeAliases: Record<string, PiStreamEvent["type"]> = {
  text_delta: "text",
  message_update: "message",
  agent_start: "status",
  agent_end: "status",
  turn_start: "status",
  turn_end: "status",
  tool_call: "tool",
  tool_result: "tool",
  tool_execution_start: "tool",
  tool_execution_update: "tool",
  tool_execution_end: "tool",
};

/** Convert SDK-shaped events into the adapter's small, JSON-safe event vocabulary. */
export function normalizePiStreamEvent(value: PiStreamEvent | unknown): PiStreamEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: "message", data: jsonDetails(value) ?? null };
  }
  const source = value as Record<string, unknown>;
  const sourceType = typeof source.type === "string" ? source.type : "message";
  const type = normalizedEventTypes.has(sourceType as PiStreamEvent["type"])
    ? sourceType as PiStreamEvent["type"]
    : eventTypeAliases[sourceType] ?? "message";
  const dataSource = "data" in source ? source.data : Object.fromEntries(Object.entries(source).filter(([key]) => key !== "type"));
  return { type, data: jsonDetails(dataSource) ?? null };
}

function mapError(error: unknown): PiProviderError | PiRuntimeError {
  if (error instanceof PiProviderError || error instanceof PiRuntimeError) return error;
  const candidate = error as { kind?: unknown; message?: unknown; details?: unknown } | null;
  const message = typeof candidate?.message === "string" ? candidate.message : undefined;
  const details = jsonDetails(candidate?.details);
  return candidate?.kind === "provider" ? new PiProviderError(message, details) : new PiRuntimeError(message, details);
}

/**
 * Build an AgentRunPort backed by one newly-created, transient Pi executor per
 * run. The optional second factory argument is the complete normalized request,
 * which lets an SDK integration configure a session without coupling this
 * package to a particular Pi SDK version.
 */
export function createPiRunPort<Config>(factory: PiExecutorFactory<Config>, config: Config): PiRunPort {
  return {
    capabilities: piAdapterCapabilities,
    async run(request: PiRunRequest, emit?: RunProgressEmitter) {
      let executor: PiExecutor | undefined;
      let result: unknown;
      let failure: unknown;
      try {
        const executionRequest: PiExecutionRequest = {
          runId: request.runId,
          requestId: request.context.requestId,
          prompt: request.prompt,
          context: mapContext(request),
          transcript: normalizePiTranscriptProjection(request.transcript),
          toolDefinitions: request.toolDefinitions,
          signal: request.signal,
          tools: request.tools,
          emit: async (event) => {
            const normalized = normalizePiStreamEvent(event);
            await emit?.({ type: normalized.type, data: normalized.data });
          },
        };
        executor = await factory(config, executionRequest);
        if (!executor || typeof executor.execute !== "function") {
          throw new PiRuntimeError("Pi executor factory did not return an executor");
        }
        result = await executor.execute(executionRequest);
      } catch (error) {
        failure = error;
      }

      if (executor?.dispose) {
        try {
          await executor.dispose();
        } catch (error) {
          if (failure === undefined) failure = error;
        }
      }
      if (failure !== undefined) throw mapError(failure);
      return result;
    },
  };
}

/**
 * An explicit in-memory Pi session for environments where the Pi SDK is not
 * installed. It accepts only the projected transcript supplied for its current
 * execution and drops that projection on disposal.
 */
export class InMemoryPiSession implements PiExecutionSession {
  private projection: PiTranscriptProjection = { entries: [] };
  private disposedState = false;

  constructor(
    private readonly handler: (request: PiExecutionRequest) => unknown | Promise<unknown> = ({ prompt }) => ({ text: prompt }),
  ) {}

  get transcript(): PiTranscriptProjection {
    return normalizePiTranscriptProjection(this.projection);
  }

  get disposed(): boolean {
    return this.disposedState;
  }

  async execute(request: PiExecutionRequest): Promise<unknown> {
    if (this.disposedState) throw new PiRuntimeError("Pi in-memory session has been disposed");
    this.projection = normalizePiTranscriptProjection(request.transcript);
    return this.handler({ ...request, transcript: this.transcript });
  }

  dispose(): void {
    this.disposedState = true;
    this.projection = { entries: [] };
  }
}

/** A disposable in-memory executor that owns at most one transient session. */
export class InMemoryPiExecutor implements PiExecutor {
  private session?: InMemoryPiSession;

  constructor(
    private readonly handler: (request: PiExecutionRequest) => unknown | Promise<unknown> = ({ prompt }) => ({ text: prompt }),
  ) {}

  get activeSession(): InMemoryPiSession | undefined {
    return this.session;
  }

  async execute(request: PiExecutionRequest): Promise<unknown> {
    if (this.session?.disposed === false) throw new PiRuntimeError("Pi in-memory executor is already running");
    this.session = new InMemoryPiSession(this.handler);
    return this.session.execute(request);
  }

  dispose(): void {
    this.session?.dispose();
  }
}

export function createInMemoryPiExecutor(
  handler?: (request: PiExecutionRequest) => unknown | Promise<unknown>,
): InMemoryPiExecutor {
  return new InMemoryPiExecutor(handler);
}

export { createPiSdkExecutorFactory, loadPiSdk, PI_SDK_MODULE, validatePiSession } from "./sdk.ts";
export type { PiSdkModule, PiSdkConfig, PiSessionManager, PiSessionManagerApi } from "./sdk.ts";

/** Share request/context, gateway tools, cancellation and events with any host. */
export function createPiStatelessExecutor<Config>(
  factory: PiExecutorFactory<Config>,
  config: Config,
  transcript?: (execution: Parameters<StatelessExecutor>[0]) => PiRunRequest["transcript"] | Promise<PiRunRequest["transcript"]>,
  toolDefinitions: readonly ToolDefinition[] = [],
): StatelessExecutor {
  const port = createPiRunPort(factory, config);
  return async (execution) => port.run({
    runId: execution.request.runId,
    prompt: execution.request.prompt,
    context: execution.context,
    signal: execution.request.signal,
    tools: execution.tools,
    transcript: await transcript?.(execution),
    toolDefinitions,
  }, execution.emit);
}

export async function resolvePiExecutorFactory(moduleValue: PiExecutorModule): Promise<PiExecutorFactory> {
  const factory = typeof moduleValue === "function" ? moduleValue : moduleValue.default ?? moduleValue.createPiExecutor;
  if (typeof factory !== "function") throw new PiRuntimeError("Pi executor module must export a factory");
  return factory;
}
