// @effect-diagnostics nodeBuiltinImport:off globalDate:off cryptoRandomUUID:off -- This optional host owns native filesystem persistence and process-local IDs.
import type {
  Principal,
  RuntimeContextPort,
  RunEventSink,
  StatelessRunResult,
} from "@subpolar/shared";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
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
  active: AbortController | undefined;
  activeRun: Promise<StatelessRunResult> | undefined;
}

type StoredSession = {
  version: 1;
  sessionId: string;
  piSessionId: string;
  principal?: Principal;
  closed?: boolean;
};
type StoredRun = {
  version: 1;
  runId: string;
  sessionId: string;
  state: string;
  updatedAt: string;
  workerPid: number;
};

function samePrincipal(left: Principal | undefined, right: Principal | undefined): boolean {
  return left?.id === right?.id && left?.kind === right?.kind;
}

function readRecord<T extends { version: number }>(file: string): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: T;
  try {
    value = JSON.parse(raw) as T;
  } catch {
    throw new Error(`Persistent runtime record is corrupt: ${file}`);
  }
  if (!value || typeof value !== "object" || value.version !== 1) {
    throw new Error(`Unsupported or invalid persistent runtime record: ${file}`);
  }
  const record = value as unknown as Record<string, unknown>;
  if (
    "runId" in record &&
    (typeof record.runId !== "string" ||
      typeof record.sessionId !== "string" ||
      typeof record.state !== "string" ||
      typeof record.updatedAt !== "string" ||
      typeof record.workerPid !== "number" ||
      !Number.isSafeInteger(record.workerPid) ||
      record.workerPid <= 0)
  ) {
    throw new Error(`Persistent runtime run record is invalid: ${file}`);
  }
  const principal = record.principal;
  if (
    "piSessionId" in record &&
    (typeof record.sessionId !== "string" ||
      typeof record.piSessionId !== "string" ||
      (record.closed !== undefined && typeof record.closed !== "boolean") ||
      (principal !== undefined &&
        (!principal ||
          typeof principal !== "object" ||
          typeof (principal as Record<string, unknown>).id !== "string" ||
          typeof (principal as Record<string, unknown>).kind !== "string")))
  ) {
    throw new Error(`Persistent runtime session record is invalid: ${file}`);
  }
  return value;
}

function recordPath(directory: string, id: string): string {
  return path.join(directory, `${Buffer.from(id).toString("hex")}.json`);
}

function jsonValue(value: unknown): PiTranscriptEntry["content"] {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        jsonValue(entry),
      ]),
    );
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
  private readonly options: SubpolarRuntimeHostOptions<unknown>;
  readonly capabilities: RuntimeHostCapabilities;
  private readonly sessions = new Map<string, SessionState>();
  private readonly runtime;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly stateDirectory: string | undefined;

  constructor(options: SubpolarRuntimeHostOptions<unknown>) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    const config = options.piConfig as { runtimeDataDir?: unknown } | undefined;
    const runtimeDataDir =
      typeof config?.runtimeDataDir === "string"
        ? config.runtimeDataDir
        : process.env.SUBPOLAR_RUNTIME_DATA_DIR;
    const persistent =
      options.piFactory.supportsPersistentSessions === true &&
      typeof runtimeDataDir === "string" &&
      path.isAbsolute(runtimeDataDir);
    this.stateDirectory = persistent
      ? path.join(runtimeDataDir, "subpolar-runtime-host")
      : undefined;
    if (this.stateDirectory) this.recoverAbandonedRuns();
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
      } as const,
    });
    const executor = createPiStatelessExecutor(
      options.piFactory,
      options.piConfig,
      (execution) => {
        const id = execution.context.sessionId;
        const session = id ? this.sessions.get(id) : undefined;
        const sessionId = session?.piSessionId ?? id;
        return {
          entries: session?.transcript ?? [],
          ...(sessionId === undefined ? {} : { sessionId }),
        };
      },
      options.gateway.tools,
    );
    this.runtime = createStatelessSubpolarRuntime({
      context: options.context,
      gateway: options.gateway,
      executor,
      ...(options.eventSink === undefined ? {} : { eventSink: options.eventSink }),
      now: this.now,
    });
  }

  createSession(principal?: Principal, requestedId?: string): RuntimeHostSession {
    if (requestedId) {
      const existing = this.sessions.get(requestedId);
      if (existing) {
        if (!samePrincipal(existing.principal, principal))
          throw new Error("Runtime session belongs to a different principal");
        return { sessionId: requestedId, capabilities: this.capabilities };
      }
      const stored = this.readSession(requestedId);
      if (stored?.closed) throw new Error("Runtime session is closed");
      if (stored && !samePrincipal(stored.principal, principal))
        throw new Error("Runtime session belongs to a different principal");
      if (!stored) this.createSessionRecord(requestedId, principal);
      this.sessions.set(requestedId, {
        id: requestedId,
        piSessionId: stored?.piSessionId ?? requestedId,
        ...(principal === undefined ? {} : { principal }),
        transcript: [],
        active: undefined,
        activeRun: undefined,
      });
      return { sessionId: requestedId, capabilities: this.capabilities };
    }
    let id = this.createId();
    while (this.sessions.has(id)) id = this.createId();
    this.createSessionRecord(id, principal);
    this.sessions.set(id, {
      id,
      piSessionId: id,
      ...(principal === undefined ? {} : { principal }),
      transcript: [],
      active: undefined,
      activeRun: undefined,
    });
    return { sessionId: id, capabilities: this.capabilities };
  }

  /** Restore a native session key after the ACP layer has validated durable Pi state. */
  restoreSession(sessionId: string, principal?: Principal): RuntimeHostSession {
    if (!sessionId) throw new Error("Runtime session ID is required");
    if (!this.capabilities.supports["session.resume"]) {
      throw new Error("Runtime host cannot resume sessions without persistent executor storage");
    }
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (!samePrincipal(existing.principal, principal))
        throw new Error("Runtime session belongs to a different principal");
      return { sessionId, capabilities: this.capabilities };
    }
    const stored = this.readSession(sessionId);
    if (stored?.closed) throw new Error("Runtime session is closed");
    if (stored && !samePrincipal(stored.principal, principal))
      throw new Error("Runtime session belongs to a different principal");
    if (!stored) this.createSessionRecord(sessionId, principal);
    this.sessions.set(sessionId, {
      id: sessionId,
      piSessionId: stored?.piSessionId ?? sessionId,
      ...(principal === undefined ? {} : { principal }),
      transcript: [],
      active: undefined,
      activeRun: undefined,
    });
    return { sessionId, capabilities: this.capabilities };
  }

  async prompt(
    sessionId: string,
    prompt: string,
    options: RuntimeHostPromptOptions = {},
  ): Promise<StatelessRunResult> {
    const session = this.requireSession(sessionId);
    if (session.activeRun) throw new Error("A turn is already running for this session");
    const controller = new AbortController();
    const unlink = linkAbort(options.signal, controller);
    const requestId = this.createId();
    const runId = this.createId();
    this.writeRun(runId, {
      version: 1,
      runId,
      sessionId,
      state: "running",
      updatedAt: this.now().toISOString(),
      workerPid: process.pid,
    });
    session.active = controller;
    const pending = this.runtime.run({
      runId,
      requestId,
      sessionId,
      prompt,
      ...(session.principal === undefined ? {} : { principal: session.principal }),
      signal: controller.signal,
    });
    session.activeRun = pending;
    try {
      const result = await pending;
      this.writeRun(runId, {
        version: 1,
        runId,
        sessionId,
        state: result.state,
        updatedAt: this.now().toISOString(),
        workerPid: process.pid,
      });
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
    const stored = this.readSession(sessionId);
    if (stored)
      this.writeRecord(recordPath(this.sessionDirectory(), sessionId), { ...stored, closed: true });
    return true;
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Runtime session does not exist in this process");
    return session;
  }

  private sessionDirectory(): string {
    const directory = path.join(this.stateDirectory!, "sessions");
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  private runDirectory(): string {
    const directory = path.join(this.stateDirectory!, "runs");
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  private readSession(sessionId: string): StoredSession | undefined {
    return this.stateDirectory
      ? readRecord<StoredSession>(recordPath(this.sessionDirectory(), sessionId))
      : undefined;
  }

  private createSessionRecord(sessionId: string, principal?: Principal): void {
    if (!this.stateDirectory) return;
    const file = recordPath(this.sessionDirectory(), sessionId);
    const value: StoredSession = {
      version: 1,
      sessionId,
      piSessionId: sessionId,
      ...(principal === undefined ? {} : { principal }),
    };
    try {
      writeFileSync(file, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readRecord<StoredSession>(file);
      if (!existing || existing.closed || !samePrincipal(existing.principal, principal)) {
        throw new Error("Runtime session belongs to a different principal");
      }
    }
  }

  private writeRun(runId: string, value: StoredRun): void {
    if (this.stateDirectory) this.writeRecord(recordPath(this.runDirectory(), runId), value);
  }

  private writeRecord(file: string, value: StoredSession | StoredRun): void {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, file);
  }

  private recoverAbandonedRuns(): void {
    const directory = this.runDirectory();
    // Per-run files avoid one host overwriting another host's reservations. Only mark records
    // owned by a process that has exited; a second live host sharing this volume is left alone.
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(directory, name);
      const run = readRecord<StoredRun>(file);
      if (!run || run.state !== "running" || run.workerPid === process.pid) continue;
      let alive = true;
      try {
        process.kill(run.workerPid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (!alive)
        this.writeRecord(file, { ...run, state: "unknown", updatedAt: this.now().toISOString() });
    }
  }
}

export function createSubpolarRuntimeHost<Config>(
  options: SubpolarRuntimeHostOptions<Config>,
): SubpolarRuntimeHost {
  return new SubpolarRuntimeHost(options as SubpolarRuntimeHostOptions<unknown>);
}
