import type {
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalRequiredRunResult,
  ApprovalStore,
  EventReplayPort,
  JsonValue,
  RunError,
  RunEvent,
  RunEventSink,
  RunOutcome,

  RunResult,
  RunResultBase,
  RunStore,
  RuntimeContext,
  RuntimeContextPort,
  RuntimeExecution,
  SessionStore,
  StatelessExecutor,
  StatelessRunRequest,
  StatelessRunResult,
  ToolCall,
  TranscriptEvent,
} from "../../subpolar-contracts/src/index.ts";
import { redactAuditValue, type GatewayFailure, type GatewayResult, type ToolGateway } from "./index.ts";

export interface StatelessSubpolarRuntimeOptions {
  context: RuntimeContextPort;
  /** Compose this gateway with the durable approval and idempotency ports. */
  gateway: ToolGateway;
  executor?: StatelessExecutor;
  execute?: StatelessExecutor;
  sessions?: SessionStore;
  runStore?: RunStore;
  approvals?: ApprovalStore;
  eventReplayPort?: EventReplayPort;
  eventSink?: RunEventSink;
  now?: () => Date;
}

export interface StatelessSubpolarRuntimePort {
  run(request: StatelessRunRequest): Promise<StatelessRunResult>;
  callTool(call: ToolCall, request: StatelessRunRequest): Promise<GatewayResult>;
  decideApproval(approvalId: string, decision: ApprovalDecision): ReturnType<ApprovalStore["decide"]>;
}

export class StatelessRuntimeValidationError extends Error {
  readonly code = "INVALID_STATELESS_RUNTIME_REQUEST";

  constructor(message: string) {
    super(message);
    this.name = "StatelessRuntimeValidationError";
  }
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function asJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : `[${typeof value}]`;
  if (Array.isArray(value)) return value.map((entry) => asJson(entry));
  if (typeof value === "object") {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) result[key] = asJson(entry);
    return result;
  }
  return `[${typeof value}]`;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string") {
    return (value as { text: string }).text;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "" : serialized;
}

function baseResult(request: StatelessRunRequest, resumed: boolean): RunResultBase {
  return {
    runId: request.runId,
    requestId: request.requestId,
    sessionId: request.sessionId,
    resumed,
    recoverable: false,
  };
}

function isApprovalRequired(value: unknown): value is GatewayFailure & { status: "approval_required"; approvalId: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { ok?: unknown }).ok === false &&
      (value as { status?: unknown }).status === "approval_required" &&
      typeof (value as { approvalId?: unknown }).approvalId === "string",
  );
}

function hasReplay(capabilities: AdapterCapabilities | undefined): boolean {
  return capabilities?.supports["event.replay"] === true;
}

function hasPersistence(capabilities: AdapterCapabilities | undefined, capability: "session.persistence" | "run.outcome.persistence"): boolean {
  return capabilities?.supports[capability] === true;
}

/**
 * A request-scoped runtime. It keeps no continuation map or durable state of its own.
 * Any state that must survive a process restart is read and written through the ports.
 */
export class StatelessSubpolarRuntime implements StatelessSubpolarRuntimePort {
  private readonly executor: StatelessExecutor;
  private readonly now: () => Date;
  constructor(private readonly options: StatelessSubpolarRuntimeOptions) {
    this.executor = options.executor ?? options.execute ?? (() => {
      throw new Error("A stateless runtime executor is required");
    });
    this.now = options.now ?? (() => new Date());
  }

  private validateRequest(request: StatelessRunRequest): void {
    if (!request || typeof request !== "object") throw new StatelessRuntimeValidationError("A run request is required");
    if (!validIdentifier(request.runId)) throw new StatelessRuntimeValidationError("A run ID is required");
    if (!validIdentifier(request.requestId)) throw new StatelessRuntimeValidationError("A request ID is required");
    if (typeof request.prompt !== "string" || request.prompt.trim().length === 0) {
      throw new StatelessRuntimeValidationError("A non-empty prompt is required");
    }
    if (request.sessionId !== undefined && !validIdentifier(request.sessionId)) {
      throw new StatelessRuntimeValidationError("The session ID is invalid");
    }
  }

  private async resolveContext(request: StatelessRunRequest): Promise<RuntimeContext> {
    const context = await this.options.context.load({
      requestId: request.requestId,
      runId: request.runId,
      sessionId: request.sessionId,
      principal: request.principal,
    });
    if (!context) throw new StatelessRuntimeValidationError("Runtime context could not be resolved");
    if (!validIdentifier(context.requestId) || !context.principal || !validIdentifier(context.principal.id)) {
      throw new StatelessRuntimeValidationError("Resolved runtime context is invalid");
    }
    return { ...context, runId: context.runId ?? request.runId };
  }

  private async emit(
    request: StatelessRunRequest,
    state: RunEvent["state"],
    type: RunEvent["type"],
    data: JsonValue,
  ): Promise<boolean> {
    const event: RunEvent = {
      // Runtime instances are intentionally disposable, so event IDs cannot rely
      // on an instance-local counter for uniqueness across restarts.
      eventId: `event-${request.runId}-${request.requestId}-${crypto.randomUUID()}`,
      type,
      occurredAt: this.now().toISOString(),
      runId: request.runId,
      requestId: request.requestId,
      sessionId: request.sessionId,
      state,
      data,
    };
    try {
      await this.options.eventSink?.(event);
    } catch {
      // Event observers must not change execution semantics.
    }
    if (!hasReplay(this.options.eventReplayPort?.capabilities)) return false;
    try {
      await this.options.eventReplayPort!.append(event);
      return true;
    } catch {
      return false;
    }
  }

  private async persist(
    request: StatelessRunRequest,
    state: RunOutcome["state"],
    output: unknown,
    error: RunError | undefined,
    replayed: boolean,
  ): Promise<boolean> {
    if (!this.options.runStore || !hasPersistence(this.options.runStore.capabilities, "run.outcome.persistence")) return false;
    const recoverable = replayed && hasReplay(this.options.eventReplayPort?.capabilities);
    try {
      await this.options.runStore.save({
        runId: request.runId,
        requestId: request.requestId,
        sessionId: request.sessionId,
        state,
        ...(output === undefined ? {} : { output }),
        ...(error === undefined ? {} : { error }),
        recoverable,
        occurredAt: this.now().toISOString(),
      });
      return recoverable;
    } catch {
      return false;
    }
  }

  private resultFromOutcome(request: StatelessRunRequest, outcome: RunOutcome): RunResult {
    const common = baseResult(request, true);
    const recoverable = outcome.recoverable && hasPersistence(this.options.runStore?.capabilities, "run.outcome.persistence") && hasReplay(this.options.eventReplayPort?.capabilities);
    if (outcome.state === "completed") return { ...common, state: "completed", output: outcome.output, recoverable };
    return { ...common, state: outcome.state, error: outcome.error ?? { code: "RUN_UNKNOWN", message: "The run outcome is unavailable" }, recoverable };
  }

  async callTool(call: ToolCall, request: StatelessRunRequest, signal = request.signal): Promise<GatewayResult> {
    this.validateRequest({ ...request, prompt: request.prompt || "tool-call" });
    const context = await this.resolveContext(request);
    const scopedCall: ToolCall = {
      ...call,
      runId: call.runId ?? request.runId,
      requestId: call.requestId ?? request.requestId,
      idempotencyKey: call.idempotencyKey ?? `tool-call:${call.callId}`,
    };
    // The gateway is the sole policy boundary. The optional idempotency port belongs
    // in createPolicyGateway; this runtime never executes a tool directly.
    return this.options.gateway.call(scopedCall, context, signal);
  }

  async decideApproval(approvalId: string, decision: ApprovalDecision) {
    if (!this.options.approvals) throw new StatelessRuntimeValidationError("Durable approvals are not configured");
    return this.options.approvals.decide(approvalId, decision);
  }

  async run(request: StatelessRunRequest): Promise<StatelessRunResult> {
    this.validateRequest(request);
    const context = await this.resolveContext(request);

    const prior = hasPersistence(this.options.runStore?.capabilities, "run.outcome.persistence") ? await this.options.runStore!.load(request.runId) : undefined;
    if (prior && prior.requestId === request.requestId && prior.sessionId === request.sessionId
      && (prior.state === "completed" || prior.state === "failed" || prior.state === "interrupted" || prior.state === "unknown")) {
      return this.resultFromOutcome(request, prior);
    }

    let resumed = false;
    const sessionPersistent = Boolean(request.sessionId && hasPersistence(this.options.sessions?.capabilities, "session.persistence"));
    if (sessionPersistent && request.sessionId) resumed = Boolean(await this.options.sessions!.load(request.sessionId));

    await this.emit(request, "running", "run.started", { state: "running" });
    if (request.signal?.aborted) {
      const error = { code: "RUN_INTERRUPTED", message: "Run was cancelled before execution" };
      const replayed = await this.emit(request, "interrupted", "run.interrupted", { state: "interrupted", error });
      const recoverable = await this.persist(request, "interrupted", undefined, error, replayed);
      return { ...baseResult(request, resumed), state: "interrupted", error, recoverable };
    }

    if (sessionPersistent && request.sessionId) {
      try {
        await this.options.sessions!.append(request.sessionId, [{ role: "user", content: request.prompt, occurredAt: this.now().toISOString() }]);
      } catch {
        const error = { code: "SESSION_PERSISTENCE_FAILED", message: "Run session could not be persisted" };
        const replayed = await this.emit(request, "unknown", "run.unknown", { state: "unknown", error });
        const recoverable = await this.persist(request, "unknown", undefined, error, replayed);
        return { ...baseResult(request, resumed), state: "unknown", error, recoverable };
      }
    }

    let output: unknown;
    try {
      const execution: RuntimeExecution = {
        request,
        context,
        tools: { call: (call, signal) => this.callTool(call, request, signal) },
        emit: async (data) => { await this.emit(request, "running", "run.progress", data); },
      };
      output = await this.executor(execution);
    } catch (error) {
      const interrupted = request.signal?.aborted === true;
      const candidate = error as { code?: unknown; message?: unknown } | null;
      const safeCode = typeof candidate?.code === "string" && /^[A-Z][A-Z0-9_.-]{0,63}$/.test(candidate.code);
      const runError: RunError = interrupted
        ? { code: "RUN_INTERRUPTED", message: "Run was cancelled during execution" }
        : safeCode && typeof candidate?.message === "string"
          ? { code: candidate.code as string, message: redactAuditValue(candidate.message) as string }
          : { code: "EXECUTION_FAILED", message: "Agent execution failed" };
      const state = interrupted ? "interrupted" : "failed";
      const replayed = await this.emit(request, state, interrupted ? "run.interrupted" : "run.failed", { state, error: asJson(runError) });
      const recoverable = await this.persist(request, state, undefined, runError, replayed);
      return { ...baseResult(request, resumed), state, error: runError, recoverable };
    }

    if (!request.signal?.aborted && isApprovalRequired(output)) {
      const approval: ApprovalRequiredRunResult = {
        ...baseResult(request, resumed),
        state: "approval_required",
        approvalId: output.approvalId,
        error: output.error,
      };
      await this.emit(request, "running", "run.progress", { state: "approval_required", approvalId: output.approvalId });
      return approval;
    }

    if (request.signal?.aborted) {
      const durable = hasPersistence(this.options.runStore?.capabilities, "run.outcome.persistence") && hasReplay(this.options.eventReplayPort?.capabilities);
      const state = durable ? "interrupted" : "unknown";
      const error = durable
        ? { code: "RUN_INTERRUPTED", message: "Run was cancelled during execution" }
        : { code: "UNSUPPORTED_RECOVERY", message: "Executor settled after cancellation; durable recovery is unavailable" };
      const replayed = await this.emit(request, state, durable ? "run.interrupted" : "run.unknown", { state, error });
      const recoverable = await this.persist(request, state, undefined, error, replayed);
      return { ...baseResult(request, resumed), state, error, recoverable };
    }

    if (sessionPersistent && request.sessionId) {
      try {
        await this.options.sessions!.append(request.sessionId, [{ role: "assistant", content: text(output), occurredAt: this.now().toISOString() }]);
      } catch {
        const error = { code: "SESSION_PERSISTENCE_FAILED", message: "Run result could not be persisted" };
        const replayed = await this.emit(request, "unknown", "run.unknown", { state: "unknown", error });
        const recoverable = await this.persist(request, "unknown", undefined, error, replayed);
        return { ...baseResult(request, resumed), state: "unknown", error, recoverable };
      }
    }

    const replayed = await this.emit(request, "completed", "run.completed", { state: "completed", output: asJson(output) });
    const recoverable = await this.persist(request, "completed", output, undefined, replayed);
    return { ...baseResult(request, resumed), state: "completed", output, recoverable };
  }
}

export function createStatelessSubpolarRuntime(options: StatelessSubpolarRuntimeOptions): StatelessSubpolarRuntime {
  return new StatelessSubpolarRuntime(options);
}

export type { TranscriptEvent };
