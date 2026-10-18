import { createHash } from "node:crypto";
import path from "node:path";

import { PiRuntimeError, type PiExecutorFactory, type PiExecutionRequest } from "./index.ts";

export const PI_SDK_MODULE = "@earendil-works/pi-coding-agent";

export interface PiSessionManager {
  appendMessage(message: unknown): unknown;
  getCwd(): string;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  isPersisted(): boolean;
}

export interface PiSessionManagerApi {
  inMemory(cwd?: string): PiSessionManager;
  create(cwd: string, sessionDir?: string, options?: { id?: string }): PiSessionManager;
  findById(cwd: string, id: string, sessionDir?: string): string | undefined;
  open(path: string, sessionDir?: string, cwdOverride?: string): PiSessionManager;
}

/** Structural SDK boundary: the host owns SDK installation and credentials. */
export interface PiSdkModule {
  getAgentDir(): string;
  SessionManager: PiSessionManagerApi;
  SettingsManager: { inMemory(): unknown };
  DefaultResourceLoader: new (options: Record<string, unknown>) => { reload(): Promise<void> };
  ModelRuntime?: { create(options?: Record<string, unknown>): Promise<unknown> };
  createAgentSession(options: Record<string, unknown>): Promise<{ session: {
    subscribe(listener: (event: unknown) => void): () => void;
    prompt(prompt: string): Promise<void>;
    abort(): Promise<void>;
    dispose(): void;
    messages: readonly { role: string; content?: unknown; stopReason?: string; errorMessage?: string }[];
  } }>;
}

interface PiSdkCustomTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: { toolId: string };
    isError?: boolean;
  }>;
}

export interface PiSdkConfig {
  cwd?: string;
  agentDir?: string;
  model?: unknown;
  modelRuntime?: unknown;
  modelRuntimeFactory?: (sdk: PiSdkModule, sessionId: string) => Promise<unknown>;
  /** ACP-loaded sessions must never silently become a new empty Pi session. */
  resumeSessionIds?: Set<string>;
  runtimeDataDir?: string;
}

function piSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function persistentSessionManager(
  sdk: PiSdkModule,
  cwd: string,
  sessionId: string,
  runtimeDataDir: string,
  requireExisting: boolean,
): PiSessionManager {
  const sessionDir = path.join(runtimeDataDir, "sessions");
  const persistedId = piSessionId(sessionId);
  const file = sdk.SessionManager.findById(cwd, persistedId, sessionDir);
  const manager = file
    ? sdk.SessionManager.open(file, sessionDir)
    : requireExisting
      ? undefined
      : sdk.SessionManager.create(cwd, sessionDir, { id: persistedId });
  if (!manager) throw new PiRuntimeError("Persisted Pi session was not found for this T3 session");
  if (manager.getSessionId() !== persistedId || path.resolve(manager.getCwd()) !== path.resolve(cwd) || !manager.isPersisted()) {
    throw new PiRuntimeError("Persisted Pi session identity does not match this T3 session and environment");
  }
  return manager;
}

/** Validate that a persisted Pi session exists and is bound to this T3 session and cwd. */
export async function validatePiSession(
  load: () => Promise<PiSdkModule>,
  cwd: string,
  sessionId: string,
  runtimeDataDir = process.env.SUBPOLAR_RUNTIME_DATA_DIR,
): Promise<void> {
  if (!runtimeDataDir || !path.isAbsolute(runtimeDataDir) || !sessionId) {
    throw new PiRuntimeError("Persistent Pi session storage is unavailable");
  }
  const sdk = await load();
  persistentSessionManager(sdk, cwd, sessionId, runtimeDataDir, true);
}

export async function loadPiSdk(): Promise<PiSdkModule> {
  try {
    return await import(PI_SDK_MODULE);
  } catch {
    throw new PiRuntimeError("Pi SDK is unavailable. Install @earendil-works/pi-coding-agent for this standalone package, supply a Pi factory/module, or use --fixture for tests.");
  }
}

/** Prompt-only SDK composition. No built-ins or discovered extensions bypass policy. */
export function createPiSdkExecutorFactory(load: () => Promise<PiSdkModule> = loadPiSdk): PiExecutorFactory<PiSdkConfig | undefined> {
  const factory: PiExecutorFactory<PiSdkConfig | undefined> = async (config, request) => {
    if (!request) throw new PiRuntimeError("Pi execution request is required");
    const sdk = await load();
    const cwd = request.context.cwd ?? config?.cwd ?? process.cwd();
    const runtimeDataDir = config?.runtimeDataDir ?? process.env.SUBPOLAR_RUNTIME_DATA_DIR;
    if (runtimeDataDir !== undefined && !path.isAbsolute(runtimeDataDir)) {
      throw new PiRuntimeError("Pi runtime data directory must be an absolute path");
    }
    const agentDir = config?.agentDir ?? (runtimeDataDir ? path.join(runtimeDataDir, "pi-agent") : sdk.getAgentDir());
    const sessionId = request.context.sessionId;
    const persistent = runtimeDataDir !== undefined && sessionId !== undefined;
    const manager = persistent
      ? persistentSessionManager(sdk, cwd, sessionId, runtimeDataDir, config?.resumeSessionIds?.has(sessionId) ?? false)
      : sdk.SessionManager.inMemory(cwd);
    if (!persistent) {
      for (const entry of request.transcript.entries) {
        // Canonical text history is projected only in transient mode. Persistent
        // Pi sessions already contain their native branch and must not duplicate it.
        manager.appendMessage({ role: "custom", customType: `subpolar.${entry.role}`, content: typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content), display: false, timestamp: Date.parse(entry.occurredAt ?? "") || Date.now() });
      }
    }
    const settingsManager = sdk.SettingsManager.inMemory();
    const modelRuntime = request.context.sessionId && config?.modelRuntimeFactory
      ? await config.modelRuntimeFactory(sdk, request.context.sessionId)
      : config?.modelRuntime;
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
    await resourceLoader.reload();
    const definitions = request.toolDefinitions?.filter((tool) => tool.enabled) ?? [];
    if (definitions.length > 0 && !request.tools) {
      throw new PiRuntimeError("Subpolar tools require the runtime policy invoker");
    }
    const customTools: PiSdkCustomTool[] = definitions.map((definition) => {
      if (!definition.inputSchema || typeof definition.inputSchema !== "object" || Array.isArray(definition.inputSchema)) {
        throw new PiRuntimeError(`Tool ${definition.id} has no object input schema`);
      }
      const safeName = `subpolar_${createHash("sha256").update(definition.id).digest("hex").slice(0, 16)}`;
      return {
        name: safeName,
        label: definition.id,
        description: definition.description,
        parameters: definition.inputSchema as Record<string, unknown>,
        async execute(toolCallId, params, signal) {
          if (signal?.aborted) throw new PiRuntimeError("Pi tool call cancelled");
          const result = await request.tools!.call({
            callId: toolCallId,
            toolId: definition.id,
            input: params,
            requestId: request.requestId,
            runId: request.runId,
            idempotencyKey: `tool-call:${toolCallId}`,
          }, signal);
          if (signal?.aborted) throw new PiRuntimeError("Pi tool call cancelled");
          let text: string;
          try {
            text = JSON.stringify(result) ?? String(result);
          } catch {
            text = "Subpolar tool returned a non-serializable result";
          }
          const isError = Boolean(result && typeof result === "object" && "ok" in result && (result as { ok?: unknown }).ok === false);
          return { content: [{ type: "text", text }], details: { toolId: definition.id }, ...(isError ? { isError: true } : {}) };
        },
      };
    });
    const { session } = await sdk.createAgentSession({
      cwd,
      agentDir,
      model: config?.model,
      modelRuntime,
      sessionManager: manager,
      settingsManager,
      resourceLoader,
      tools: customTools.map((tool) => tool.name),
      noTools: customTools.length > 0 ? "builtin" : "all",
      customTools,
    });
    return {
      async execute(execution: PiExecutionRequest) {
        const pending: Promise<void>[] = [];
        const unsubscribe = session.subscribe((event) => { pending.push(Promise.resolve(execution.emit(event))); });
        const abort = () => { void session.abort().catch(() => {}); };
        execution.signal?.addEventListener("abort", abort, { once: true });
        try {
          if (execution.signal?.aborted) throw new PiRuntimeError("Pi execution cancelled");
          await session.prompt(execution.prompt);
          await Promise.all(pending);
          const message = [...session.messages].reverse().find((entry) => entry.role === "assistant");
          if (!message || message.stopReason === "error" || message.stopReason === "aborted") throw new PiRuntimeError("Pi did not produce a completed assistant response");
          const text = Array.isArray(message.content)
            ? message.content.filter((block) => block.type === "text").map((block) => block.text).join("")
            : typeof message.content === "string" ? message.content : "";
          return { text };
        } finally {
          execution.signal?.removeEventListener("abort", abort);
          unsubscribe();
        }
      },
      dispose: () => session.dispose(),
    };
  };
  return Object.assign(factory, { supportsPersistentSessions: true as const });
}
