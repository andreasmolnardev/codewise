import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  type EnvironmentManager,
  type EnvironmentRequest,
} from "@subpolar/environments";
import { createEnvironmentManagerHttpClient } from "@subpolar/environments/manager-client";
import * as AcpAgent from "effect-acp/agent";
import * as AcpClient from "effect-acp/client";
import * as AcpError from "effect-acp/errors";
import * as AcpSchema from "effect-acp/schema";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import { callT3Mcp, type T3McpBridgeConnection } from "./t3McpBridge.ts";

export interface ManagedAcpProxyOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly manager?: EnvironmentManager;
  readonly fetch?: typeof fetch;
}

interface WorkerSession {
  readonly environment: EnvironmentRequest;
  readonly sessionId: string;
  readonly scope: Scope.Scope;
  readonly client: AcpClient.AcpClient["Service"];
  readonly remoteSessionId: string;
}

const SAFE_WORKER_ENVIRONMENT_KEYS = new Set(["COLORTERM", "EDITOR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"]);

function workerEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {
    HOME: "/tmp/home",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    SHELL: "/bin/sh",
    TMPDIR: "/tmp",
    USER: "subpolar",
    SUBPOLAR_ACP_EXECUTION: "local",
    SUBPOLAR_ACP_WORKER_MODE: "1",
  };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && SAFE_WORKER_ENVIRONMENT_KEYS.has(key)) result[key] = value;
  }
  return result;
}

function parseCommand(environment: NodeJS.ProcessEnv): readonly string[] {
  const raw = environment.SUBPOLAR_ACP_WORKER_COMMAND;
  if (!raw) throw new Error("Managed ACP requires SUBPOLAR_ACP_WORKER_COMMAND as a JSON argv array");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (cause) {
    throw new Error("SUBPOLAR_ACP_WORKER_COMMAND must be a JSON argv array", { cause });
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 64 || parsed.some((part) => typeof part !== "string" || part.length === 0 || part.includes("\0"))) {
    throw new Error("SUBPOLAR_ACP_WORKER_COMMAND must be a non-empty JSON argv array of strings");
  }
  return parsed as string[];
}

function environmentFor(cwd: string, environment: NodeJS.ProcessEnv): EnvironmentRequest {
  if (!path.isAbsolute(cwd)) throw new Error("Managed ACP requires an absolute session cwd");
  const storageRoot = environment.SUBPOLAR_STORAGE_ROOT?.trim();
  if (!storageRoot || !path.isAbsolute(storageRoot)) throw new Error("Managed ACP storage root is not configured");
  const worktreePath = path.resolve(cwd);
  return {
    ownerId: environment.SUBPOLAR_OWNER_ID?.trim() || "t3-installation",
    workspaceId: `ws_${createHash("sha256").update(worktreePath).digest("hex").slice(0, 24)}`,
    storageRoot,
    worktreePath,
  };
}

function t3McpConnection(servers: readonly AcpSchema.McpServer[] | undefined): T3McpBridgeConnection | undefined {
  const candidates = (servers ?? []).filter((server) => server.name === "t3-code");
  if (candidates.length === 0) return undefined;
  if (candidates.length !== 1 || candidates[0]?.type !== "stdio") {
    throw new Error("Managed Subpolar accepts only T3's single authenticated MCP bridge");
  }
  const environment = Object.fromEntries((candidates[0].env ?? []).map(({ name, value }) => [name, value]));
  const endpoint = environment.T3_ACP_MCP_ENDPOINT;
  const authorization = environment.T3_ACP_MCP_AUTHORIZATION;
  if (typeof endpoint !== "string" || typeof authorization !== "string" ||
      !authorization.startsWith("Bearer ") || authorization.slice("Bearer ".length).trim().length === 0) {
    throw new Error("Managed Subpolar received an incomplete T3 MCP credential");
  }
  const url = new URL(endpoint);
  if (!["127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/mcp" || url.search || url.hash ||
      url.username || url.password || url.protocol !== "http:") {
    throw new Error("Managed Subpolar requires T3's loopback MCP endpoint");
  }
  return { endpoint, authorization };
}

export function makeManagedAcpManager(options: ManagedAcpProxyOptions): EnvironmentManager {
  if (options.manager) return options.manager;
  const { SUBPOLAR_MANAGER_URL: baseUrl, SUBPOLAR_MANAGER_TOKEN: token } = options.environment;
  if (!baseUrl || !token) throw new Error("Managed ACP requires SUBPOLAR_MANAGER_URL and SUBPOLAR_MANAGER_TOKEN");
  return createEnvironmentManagerHttpClient({
    baseUrl,
    token,
    allowPrivateHttp: options.environment.SUBPOLAR_MANAGER_ALLOW_PRIVATE_HTTP === "true",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

const requestError = (error: unknown) => AcpError.AcpRequestError.internalError(
  "Managed Subpolar worker failed",
  undefined,
  { cause: error },
);

/** ACP stdio proxy that starts one authenticated worker process for each new session. */
function makeManagedAcpProxy(stdio: Stdio.Stdio, options: ManagedAcpProxyOptions) {
  return Effect.gen(function* () {
    const agent = yield* AcpAgent.make(stdio);
    const environment = options.environment;
    const command = parseCommand(environment);
    const manager = makeManagedAcpManager(options);
    const workers = new Map<string, WorkerSession>();
    const activeT3McpRequests = new Map<string, AbortController>();
    let initializeRequest: AcpSchema.InitializeRequest | undefined;

    const getWorker = (sessionId: string) => {
      const worker = workers.get(sessionId);
      return worker
        ? Effect.succeed(worker)
        : Effect.fail(AcpError.AcpRequestError.resourceNotFound("Managed Subpolar session was not found"));
    };
    const forward = <Request extends { readonly sessionId: string }, Response>(
      method: string,
      request: Request,
    ): Effect.Effect<Response, AcpError.AcpError> => getWorker(request.sessionId).pipe(
      Effect.flatMap((worker) => worker.client.raw.request(method, request)),
      Effect.map((value) => value as Response),
      Effect.mapError(requestError),
    );
    const forwardAny = <Response>(method: string, payload: unknown) => {
      const requestedSessionId = typeof payload === "object" && payload !== null && "sessionId" in payload
        ? String((payload as { readonly sessionId: unknown }).sessionId)
        : undefined;
      if (!requestedSessionId) return Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
      return getWorker(requestedSessionId).pipe(
        Effect.flatMap((worker) => worker.client.raw.request(method, payload)),
        Effect.map((value) => value as Response),
        Effect.mapError(requestError),
      );
    };

    yield* agent.handleInitialize((request) => Effect.sync(() => {
      initializeRequest = request;
      return {
        protocolVersion: request.protocolVersion,
        info: { name: "subpolar-managed", version: "0.1.0" },
        capabilities: { session: {} },
      };
    }));

    const startManagedWorker = async (
      request: AcpSchema.NewSessionRequest,
      nativeSessionId: string,
      resume: boolean,
    ) => {
      if (!initializeRequest) throw new Error("ACP initialize must be called before session setup");
      const target = environmentFor(request.cwd, environment);
      const t3Mcp = t3McpConnection(request.mcpServers);
      const workerEnv = workerEnvironment(environment);
      if (t3Mcp) workerEnv.SUBPOLAR_T3_MCP_BRIDGE = "1";
      const started = await manager.startManagedSession(target, command, {
        cwd: ".",
        environment: workerEnv,
        clientSessionId: `t3-acp-${createHash("sha256").update(nativeSessionId).digest("hex").slice(0, 32)}`,
      });
      let workerScope: Scope.CloseableScope | undefined;
      try {
        const scope = workerScope = await Effect.runPromise(Scope.make());
        const input = await Effect.runPromise(Queue.unbounded<Uint8Array, Cause.Done<void>>());
        const stdioForWorker = Stdio.make({
          args: Effect.succeed([]),
          stdin: Stream.fromQueue(input),
          stdout: () => Sink.forEach((chunk: string | Uint8Array) =>
            Effect.promise(() => manager.writeManagedSession(
              target,
              started.sessionId,
              typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
            )),
          ),
          stderr: () => Sink.drain,
        });
        const workerClient = await Effect.runPromise(AcpClient.make(stdioForWorker).pipe(
          Effect.provideService(Scope.Scope, scope),
        ));
        const pump = async () => {
          for await (const event of manager.attachManagedSessionOutput(target, started.sessionId, started.outputSequence)) {
            if (event.type === "exit") {
              await Effect.runPromise(Queue.end(input));
              return;
            }
            if (event.stream === "stdout") await Effect.runPromise(Queue.offer(input, event.data));
          }
          await Effect.runPromise(Queue.end(input));
        };
        void pump().catch(() => Effect.runPromise(Queue.end(input)));
        await Effect.runPromise(workerClient.handleRequestPermission((permission) =>
          agent.client.requestPermission(permission).pipe(Effect.mapError(requestError)),
        ));
        await Effect.runPromise(workerClient.handleSessionUpdate((notification) =>
          agent.client.sessionUpdate(notification).pipe(Effect.mapError(requestError)),
        ));
        await Effect.runPromise(workerClient.handleElicitation((request) =>
          agent.client.elicit(request).pipe(Effect.mapError(requestError)),
        ));
        await Effect.runPromise(workerClient.handleMcpConnect((request) =>
          agent.client.connectMcp(request).pipe(Effect.mapError(requestError)),
        ));
        await Effect.runPromise(workerClient.handleMcpMessage((request) =>
          agent.client.messageMcp(request).pipe(Effect.mapError(requestError)),
        ));
        await Effect.runPromise(workerClient.handleMcpDisconnect((request) =>
          agent.client.disconnectMcp(request).pipe(Effect.mapError(requestError)),
        ));
        await Effect.runPromise(workerClient.handleMcpNotification((notification) =>
          agent.client.notifyMcp(notification).pipe(Effect.mapError(requestError)),
        ));
        await Effect.runPromise(workerClient.handleReadTextFile((request) =>
          agent.client.extRequest("fs/read_text_file", request).pipe(Effect.map((value) => value as AcpSchema.ReadTextFileResponse), Effect.mapError(requestError)),
        ));
        await Effect.runPromise(workerClient.handleWriteTextFile((request) =>
          agent.client.extRequest("fs/write_text_file", request).pipe(Effect.map((value) => value as AcpSchema.WriteTextFileResponse), Effect.mapError(requestError)),
        ));
        await Effect.runPromise(workerClient.handleCreateTerminal((request) =>
          agent.client.extRequest("terminal/create", request).pipe(Effect.map((value) => value as AcpSchema.CreateTerminalResponse), Effect.mapError(requestError)),
        ));
        await Effect.runPromise(workerClient.handleTerminalOutput((request) =>
          agent.client.extRequest("terminal/output", request).pipe(Effect.map((value) => value as AcpSchema.TerminalOutputResponse), Effect.mapError(requestError)),
        ));
        await Effect.runPromise(workerClient.handleTerminalWaitForExit((request) =>
          agent.client.extRequest("terminal/wait_for_exit", request).pipe(Effect.map((value) => value as AcpSchema.WaitForTerminalExitResponse), Effect.mapError(requestError)),
        ));
        await Effect.runPromise(workerClient.handleTerminalKill((request) =>
          agent.client.extRequest("terminal/kill", request).pipe(Effect.map((value) => value as AcpSchema.KillTerminalResponse), Effect.mapError(requestError)),
        ));
        await Effect.runPromise(workerClient.handleTerminalRelease((request) =>
          agent.client.extRequest("terminal/release", request).pipe(Effect.map((value) => value as AcpSchema.ReleaseTerminalResponse), Effect.mapError(requestError)),
        ));
        await Effect.runPromise(workerClient.handleElicitationComplete((notification) =>
          agent.client.elicitationComplete(notification).pipe(Effect.mapError(requestError)),
        ));
        await Effect.runPromise(workerClient.handleUnknownExtRequest((method, payload) =>
          method === "subpolar/t3_mcp"
              ? Effect.tryPromise({
                  try: async (signal) => {
                    const bridgeRequest = payload as { sessionId?: unknown; requestId?: unknown; operation?: unknown; name?: unknown; arguments?: unknown };
                    if (bridgeRequest.sessionId !== nativeSessionId || t3Mcp === undefined) {
                      throw new Error("The T3 MCP session is unavailable");
                    }
                    if (typeof bridgeRequest.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(bridgeRequest.requestId)) {
                      throw new Error("The T3 MCP request ID is invalid");
                    }
                    const requestKey = `${nativeSessionId}:${bridgeRequest.requestId}`;
                    if (activeT3McpRequests.has(requestKey)) throw new Error("The T3 MCP request ID is already active");
                    const requestController = new AbortController();
                    activeT3McpRequests.set(requestKey, requestController);
                    try {
                      const requestSignal = AbortSignal.any([signal, requestController.signal]);
                      if (bridgeRequest.operation === "list_tools") {
                        return await callT3Mcp(t3Mcp, "tools/list", {}, options.fetch, requestSignal);
                      }
                      if (bridgeRequest.operation === "call_tool" && typeof bridgeRequest.name === "string" && bridgeRequest.name.length > 0 &&
                          bridgeRequest.arguments !== null && typeof bridgeRequest.arguments === "object" && !Array.isArray(bridgeRequest.arguments)) {
                        return await callT3Mcp(t3Mcp, "tools/call", { name: bridgeRequest.name, arguments: bridgeRequest.arguments as Record<string, unknown> }, options.fetch, requestSignal);
                      }
                      throw new Error("Invalid T3 MCP bridge request");
                    } finally {
                      activeT3McpRequests.delete(requestKey);
                    }
                  },
                  catch: requestError,
                })
            :
          agent.client.extRequest(method, payload).pipe(Effect.mapError(requestError)),
        ));
        await Effect.runPromise(workerClient.handleUnknownExtNotification((method, payload) => {
          if (method === "subpolar/cancel") {
            const cancelRequest = payload as { sessionId?: unknown; requestId?: unknown };
            if (cancelRequest.sessionId !== nativeSessionId || typeof cancelRequest.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(cancelRequest.requestId)) return Effect.void;
            const requestKey = `${nativeSessionId}:${cancelRequest.requestId}`;
            const activeRequest = activeT3McpRequests.get(requestKey);
            if (activeRequest) {
              activeRequest.abort(new Error("T3 MCP request was cancelled"));
              return Effect.void;
            }
            return agent.client.extNotification(method, payload).pipe(Effect.mapError(requestError));
          }
          return agent.client.extNotification(method, payload).pipe(Effect.mapError(requestError));
        }));
        const initialized = await Effect.runPromise(workerClient.agent.initialize(initializeRequest));
        if (initialized.protocolVersion !== initializeRequest.protocolVersion) {
          throw new Error("Managed ACP worker negotiated an incompatible protocol version");
        }
        const response = resume
          ? await Effect.runPromise(workerClient.agent.loadSession({
              sessionId: nativeSessionId,
              cwd: request.cwd,
              // The host-only bearer stays on this proxy; the worker uses the
              // authenticated ACP bridge below instead of receiving it.
              mcpServers: [],
            }))
          : await Effect.runPromise(workerClient.agent.createSession({
              ...request,
              _meta: { ...(request._meta ?? {}), "subpolar.sessionId": nativeSessionId },
              mcpServers: [],
            }));
        const session: WorkerSession = {
          environment: target,
          sessionId: started.sessionId,
          scope,
          client: workerClient,
          remoteSessionId: nativeSessionId,
        };
        workers.set(nativeSessionId, session);
        return response;
      } catch (error) {
        await manager.terminateManagedSession(target, started.sessionId).catch(() => undefined);
        if (workerScope) await Effect.runPromise(Scope.close(workerScope, Exit.void)).catch(() => undefined);
        throw error;
      }
    };

    yield* agent.handleCreateSession((request) => Effect.tryPromise({
      try: async () => {
        const nativeSessionId = `t3-acp-${randomUUID()}`;
        return await startManagedWorker(request, nativeSessionId, false);
      },
      catch: requestError,
    }));

    yield* agent.handlePrompt((request) => forward("session/prompt", request));
    yield* agent.handleAuthenticate((request) => forwardAny("auth/login", request));
    yield* agent.handleLogout((request) => forwardAny("auth/logout", request));
    const resumeManagedSession = (request: AcpSchema.LoadSessionRequest | AcpSchema.ResumeSessionRequest) => {
      const existing = workers.get(request.sessionId);
      const loadRequest: AcpSchema.LoadSessionRequest = {
        sessionId: request.sessionId,
        cwd: request.cwd,
        mcpServers: [],
      };
      if (existing) {
        return existing.client.agent.loadSession(loadRequest).pipe(
          Effect.map((value) => value as AcpSchema.LoadSessionResponse | AcpSchema.ResumeSessionResponse),
          Effect.mapError(requestError),
        );
      }
      const syntheticRequest = {
        cwd: request.cwd,
        mcpServers: request.mcpServers ?? [],
        _meta: { "subpolar.sessionId": request.sessionId },
      } as AcpSchema.NewSessionRequest;
      return Effect.tryPromise({
        try: () => startManagedWorker(syntheticRequest, request.sessionId, true),
        catch: requestError,
      });
    };
    yield* agent.handleLoadSession(resumeManagedSession);
    yield* agent.handleResumeSession(resumeManagedSession);
    yield* agent.handleListSessions((request) => forwardAny("session/list", request));
    yield* agent.handleForkSession((request) => forwardAny("session/fork", request));
    yield* agent.handleDeleteSession((request) => forwardAny("session/delete", request));
    yield* agent.handleListProviders((request) => forwardAny("providers/list", request));
    yield* agent.handleSetProvider((request) => forwardAny("providers/set", request));
    yield* agent.handleDisableProvider((request) => forwardAny("providers/disable", request));
    yield* agent.handleSetSessionConfigOption((request) => forwardAny("session/set_config_option", request));
    yield* agent.handleCancel((notification) => getWorker(notification.sessionId).pipe(
      Effect.flatMap((worker) => worker.client.agent.cancel(notification)),
      Effect.mapError(requestError),
    ));
    yield* agent.handleCloseSession((request) => Effect.gen(function* () {
      const worker = yield* getWorker(request.sessionId);
      const cleanup = Effect.sync(() => workers.delete(request.sessionId)).pipe(
        Effect.andThen(Effect.promise(() => manager.terminateManagedSession(worker.environment, worker.sessionId)).pipe(
          Effect.catch(() => Effect.void),
        )),
        Effect.andThen(Scope.close(worker.scope, Exit.void)),
      );
      return yield* worker.client.agent.closeSession({ sessionId: worker.remoteSessionId }).pipe(
        Effect.mapError(requestError),
        Effect.ensuring(cleanup),
      );
    }));

    yield* agent.handleUnknownExtRequest((method, payload) => {
      const sessionId = typeof payload === "object" && payload !== null && "sessionId" in payload
        ? String((payload as { sessionId: unknown }).sessionId)
        : undefined;
      if (!sessionId) return Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
      return getWorker(sessionId).pipe(
        Effect.flatMap((worker) => worker.client.raw.request(method, payload)),
        Effect.mapError(requestError),
      );
    });
    yield* agent.handleUnknownExtNotification((method, payload) => {
      const sessionId = typeof payload === "object" && payload !== null && "sessionId" in payload
        ? String((payload as { sessionId: unknown }).sessionId)
        : undefined;
      if (!sessionId) return Effect.void;
      return getWorker(sessionId).pipe(
        Effect.flatMap((worker) => worker.client.raw.notify(method, payload)),
        Effect.mapError(requestError),
      );
    });

    yield* Effect.addFinalizer(() => Effect.forEach(workers.values(), (worker) =>
      Effect.promise(() => manager.terminateManagedSession(worker.environment, worker.sessionId)).pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(Scope.close(worker.scope, Exit.void)),
      ), { discard: true }));
    return agent;
  });
}

export function layerManagedAcpProxy(stdio: Stdio.Stdio, options: ManagedAcpProxyOptions) {
  return Layer.effect(AcpAgent.AcpAgent, makeManagedAcpProxy(stdio, options));
}

export const layerManagedStdio = (options: ManagedAcpProxyOptions) =>
  Layer.effect(AcpAgent.AcpAgent,
    Effect.flatMap(Effect.service(Stdio.Stdio), (stdio) =>
      makeManagedAcpProxy(stdio, options),
    ));
