import type {
  Principal,
  RuntimeContextPort,
  RunEventSink,
  StatelessRunResult,
} from "@subpolar/shared";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
    "run.outcome.persistence": boolean;
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
  piSessionId: string;
  principal?: Principal;
  transcript: PiTranscriptEntry[];
  active?: AbortController;
  activeRun?: Promise<StatelessRunResult>;
}

type StoredRun = { runId: string; sessionId: string; state: string; updatedAt: string };
type HostLedger = { version: 1; sessions: Record<string, { piSessionId: string; principal?: Principal }>; runs: Record<string, StoredRun> };

function readLedger(file: string): HostLedger {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as HostLedger;
    if (value.version === 1 && value.sessions && value.runs) return value;
  } catch { /* A missing or unreadable ledger starts empty. */ }
  return { version: 1, sessions: {}, runs: {} };
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
  private readonly ledgerFile?: string;
  private readonly ledger: HostLedger;

  constructor(private readonly options: SubpolarRuntimeHostOptions<unknown>) {
    const config = options.piConfig as { runtimeDataDir?: unknown } | undefined;
    const runtimeDataDir = typeof config?.runtimeDataDir === "string"
      ? config.runtimeDataDir
      : process.env.SUBPOLAR_RUNTIME_DATA_DIR;
    const persistent = options.piFactory.supportsPersistentSessions === true
      && typeof runtimeDataDir === "string"
      && path.isAbsolute(runtimeDataDir);
    this.ledgerFile = persistent ? path.join(runtimeDataDir, "subpolar-runtime-host.json") : undefined;
    this.ledger = this.ledgerFile ? readLedger(this.ledgerFile) : { version: 1, sessions: {}, runs: {} };
    if (this.ledgerFile) {
      // The host cannot know whether an interrupted Pi side effect completed. Record uncertainty
      // and leave reconciliation to T3's authoritative event log; never replay on startup.
      for (const run of Object.values(this.ledger.runs)) {
        if (run.state === "running") {
          run.state = "unknown";
          run.updatedAt = (options.now ?? (() => new Date()))().toISOString();
        }
      }
      this.persistLedger();
    }
    this.capabilities = Object.freeze({
      scope: "process",
      durability: persistent ? "persistent" : "ephemeral",
      supports: {
        "session.create": true,
        "session.resume": persistent,
        "session.persistence": persistent,
        "run.outcome.persistence": persistent,
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
        return { entries: session?.transcript ?? [], sessionId: session?.piSessionId ?? id };
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
      const stored = this.ledger.sessions[requestedId];
      this.sessions.set(requestedId, { id: requestedId, piSessionId: stored?.piSessionId ?? requestedId, principal: principal ?? stored?.principal, transcript: [] });
      if (!stored) this.ledger.sessions[requestedId] = { piSessionId: requestedId, principal };
      this.persistLedger();
      return { sessionId: requestedId, capabilities: this.capabilities };
    }
    let id = this.createId();
    while (this.sessions.has(id)) id = this.createId();
    this.sessions.set(id, { id, piSessionId: id, principal, transcript: [] });
    this.ledger.sessions[id] = { piSessionId: id, principal };
    this.persistLedger();
    return { sessionId: id, capabilities: this.capabilities };
  }

  /** Restore a native session key after the ACP layer has validated durable Pi state. */
  restoreSession(sessionId: string, principal?: Principal): RuntimeHostSession {
    if (!sessionId) throw new Error("Runtime session ID is required");
    if (!this.capabilities.supports["session.resume"]) {
      throw new Error("Runtime host cannot resume sessions without persistent executor storage");
    }
    const existing = this.sessions.get(sessionId);
    if (existing) return { sessionId, capabilities: this.capabilities };
    const stored = this.ledger.sessions[sessionId];
    this.sessions.set(sessionId, { id: sessionId, piSessionId: stored?.piSessionId ?? sessionId, principal: principal ?? stored?.principal, transcript: [] });
    this.ledger.sessions[sessionId] ??= { piSessionId: sessionId, principal };
    this.persistLedger();
    return { sessionId, capabilities: this.capabilities };
  }

  async prompt(sessionId: string, prompt: string, options: RuntimeHostPromptOptions = {}): Promise<StatelessRunResult> {
    const session = this.requireSession(sessionId);
    if (session.activeRun) throw new Error("A turn is already running for this session");
    const controller = new AbortController();
    const unlink = linkAbort(options.signal, controller);
    const requestId = this.createId();
    const runId = this.createId();
    this.ledger.runs[runId] = { runId, sessionId, state: "running", updatedAt: this.now().toISOString() };
    this.persistLedger();
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
      this.ledger.runs[runId] = { runId, sessionId, state: result.state, updatedAt: this.now().toISOString() };
      this.persistLedger();
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
    delete this.ledger.sessions[sessionId];
    this.persistLedger();
    return true;
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Runtime session does not exist in this process");
    return session;
  }

  private persistLedger(): void {
    if (!this.ledgerFile) return;
    mkdirSync(path.dirname(this.ledgerFile), { recursive: true });
    const temporary = `${this.ledgerFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.ledger), { mode: 0o600 });
    renameSync(temporary, this.ledgerFile);
  }
}

export function createSubpolarRuntimeHost<Config>(options: SubpolarRuntimeHostOptions<Config>): SubpolarRuntimeHost {
  return new SubpolarRuntimeHost(options as SubpolarRuntimeHostOptions<unknown>);
}
