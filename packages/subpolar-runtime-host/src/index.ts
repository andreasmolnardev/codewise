import type {
  Principal,
  RuntimeContextPort,
  RunEventSink,
  StatelessRunResult,
} from "@subpolar/shared";
import path from "node:path";
import { createStatelessSubpolarRuntime, type ToolGateway } from "@subpolar/runtime";
import {
  createPiStatelessExecutor,
  type PiExecutorFactory,
  type PiTranscriptEntry,
} from "@subpolar/runtime-pi";

export interface SubpolarRuntimeHostOptions<Config> {
  context: RuntimeContextPort;
  gateway: ToolGateway;
  piFactory: PiExecutorFactory<Config>;
  piConfig: Config;
  eventSink?: RunEventSink;
  now?: () => Date;
  createId?: () => string;
}

export interface RuntimeHostCapabilities {
  scope: "process";
  durability: "ephemeral" | "persistent";
  supports: {
    "session.create": true;
    "session.resume": boolean;
    "session.persistence": boolean;
    "run.outcome.persistence": false;
    "event.replay": false;
    "multi-process-concurrency": false;
    "container-isolation": false;
    "filesystem-tools": false;
  };
}

export interface RuntimeHostSession {
  readonly sessionId: string;
  readonly capabilities: RuntimeHostCapabilities;
}

export interface RuntimeHostPromptOptions {
  signal?: AbortSignal;
}

interface SessionState {
  id: string;
  principal?: Principal;
  transcript: PiTranscriptEntry[];
  active?: AbortController;
  activeRun?: Promise<StatelessRunResult>;
}

function jsonValue(value: unknown): PiTranscriptEntry["content"] {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, jsonValue(entry)]));
  }
  return String(value);
}

function linkAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

/**
 * Owns transient session transcripts and active turns for one process. The
 * stateless runtime remains responsible for execution, event emission, and tool policy.
 */
export class SubpolarRuntimeHost {
  readonly capabilities: RuntimeHostCapabilities;
  private readonly sessions = new Map<string, SessionState>();
  private readonly runtime;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly options: SubpolarRuntimeHostOptions<unknown>) {
    const config = options.piConfig as { runtimeDataDir?: unknown } | undefined;
    const runtimeDataDir = typeof config?.runtimeDataDir === "string"
      ? config.runtimeDataDir
      : process.env.SUBPOLAR_RUNTIME_DATA_DIR;
    const persistent = options.piFactory.supportsPersistentSessions === true
      && typeof runtimeDataDir === "string"
      && path.isAbsolute(runtimeDataDir);
    this.capabilities = Object.freeze({
      scope: "process",
      durability: persistent ? "persistent" : "ephemeral",
      supports: {
        "session.create": true,
        "session.resume": persistent,
        "session.persistence": persistent,
        "run.outcome.persistence": false,
        "event.replay": false,
        "multi-process-concurrency": false,
        "container-isolation": false,
        "filesystem-tools": false,
      },
    });
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    const executor = createPiStatelessExecutor(
      options.piFactory,
      options.piConfig,
      (execution) => {
        const id = execution.context.sessionId;
        const session = id ? this.sessions.get(id) : undefined;
        return { entries: session?.transcript ?? [], sessionId: id };
      },
      options.gateway.tools,
    );
    this.runtime = createStatelessSubpolarRuntime({
      context: options.context,
      gateway: options.gateway,
      executor,
      eventSink: options.eventSink,
      now: this.now,
    });
  }

  createSession(principal?: Principal, requestedId?: string): RuntimeHostSession {
    if (requestedId) {
      const existing = this.sessions.get(requestedId);
      if (existing) return { sessionId: requestedId, capabilities: this.capabilities };
      this.sessions.set(requestedId, { id: requestedId, principal, transcript: [] });
      return { sessionId: requestedId, capabilities: this.capabilities };
    }
    let id = this.createId();
    while (this.sessions.has(id)) id = this.createId();
    this.sessions.set(id, { id, principal, transcript: [] });
    return { sessionId: id, capabilities: this.capabilities };
  }

  /** Restore a native session key after the ACP layer has validated durable Pi state. */
  restoreSession(sessionId: string, principal?: Principal): RuntimeHostSession {
    if (!sessionId) throw new Error("Runtime session ID is required");
    const existing = this.sessions.get(sessionId);
    if (existing) return { sessionId, capabilities: this.capabilities };
    this.sessions.set(sessionId, { id: sessionId, principal, transcript: [] });
    return { sessionId, capabilities: this.capabilities };
  }

  async prompt(sessionId: string, prompt: string, options: RuntimeHostPromptOptions = {}): Promise<StatelessRunResult> {
    const session = this.requireSession(sessionId);
    if (session.activeRun) throw new Error("A turn is already running for this session");
    const controller = new AbortController();
    const unlink = linkAbort(options.signal, controller);
    const requestId = this.createId();
    const runId = this.createId();
    session.active = controller;
    const pending = this.runtime.run({
      runId,
      requestId,
      sessionId,
      prompt,
      principal: session.principal,
      signal: controller.signal,
    });
    session.activeRun = pending;
    try {
      const result = await pending;
      if (result.state === "completed") {
        const occurredAt = this.now().toISOString();
        session.transcript.push(
          { role: "user", content: prompt, occurredAt },
          { role: "assistant", content: jsonValue(result.output), occurredAt },
        );
      }
      return result;
    } finally {
      unlink();
      if (session.activeRun === pending) {
        session.activeRun = undefined;
        session.active = undefined;
      }
    }
  }

  cancel(sessionId: string): boolean {
    const session = this.requireSession(sessionId);
    if (!session.active) return false;
    session.active.abort();
    return true;
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.active?.abort();
    await session.activeRun?.catch(() => undefined);
    this.sessions.delete(sessionId);
    return true;
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Runtime session does not exist in this process");
    return session;
  }
}

export function createSubpolarRuntimeHost<Config>(options: SubpolarRuntimeHostOptions<Config>): SubpolarRuntimeHost {
  return new SubpolarRuntimeHost(options as SubpolarRuntimeHostOptions<unknown>);
}
