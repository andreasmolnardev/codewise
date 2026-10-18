import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stdio from "effect/Stdio";
import { createHash, randomUUID } from "node:crypto";

import * as AcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import * as AcpSchema from "effect-acp/schema";
import {
  createPolicyGateway,
  type RuntimeContext,
} from "@subpolar/runtime";
import type { PolicyResolver, ToolCall, ToolDefinition, ToolExecutor } from "@subpolar/shared";
import { validateToolInput } from "@subpolar/tools";
import { createSubpolarRuntimeHost } from "@subpolar/runtime-host";
import {
  createPiSdkExecutorFactory,
  loadPiSdk,
  validatePiSession,
  type PiExecutorFactory,
  type PiSdkConfig,
  type PiSdkModule,
} from "@subpolar/runtime-pi";
import { createAcpCredentialStore } from "./credentialStore.ts";
import { installAcpModelFetch } from "./modelEgress.ts";

export interface SubpolarAcpOptions {
  readonly piConfig?: PiSdkConfig;
  readonly loadPiSdk?: () => Promise<PiSdkModule>;
  readonly executorFactory?: PiExecutorFactory<PiSdkConfig | undefined>;
  readonly principalId?: string;
  readonly toolDefinitions?: readonly ToolDefinition[];
  readonly resolveToolPolicy?: PolicyResolver;
  readonly executeTool?: ToolExecutor;
  /** Map a gateway cwd to the worker's mounted path for proxy-started sessions. */
  readonly sessionCwd?: (requestedCwd: string) => string;
}

interface SessionContext {
  readonly cwd: string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Subpolar execution failed";

function contentText(block: AcpSchema.ContentBlock): string | undefined {
  if (block.type === "text") return block.text;
  if (block.type === "resource_link") return `[Resource: ${block.title ?? block.name}] ${block.uri}`;
  if (block.type === "resource") {
    const resource = block.resource as { text?: unknown };
    return typeof resource.text === "string" ? resource.text : undefined;
  }
  return undefined;
}

function promptText(blocks: ReadonlyArray<AcpSchema.ContentBlock>): string {
  const parts = blocks.map(contentText);
  if (parts.some((part) => part === undefined)) {
    throw new Error("This Subpolar ACP agent currently accepts text and resource content only");
  }
  const result = parts.filter((part): part is string => part !== undefined).join("\n\n");
  if (!result.trim()) throw new Error("The prompt contains no text content");
  return result;
}

function eventText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const text = (value as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}

function createRuntimeHost(
  options: SubpolarAcpOptions,
  sessions: Map<string, SessionContext>,
  requestPermission: (sessionId: string | undefined, call: ToolCall, definition: ToolDefinition, signal?: AbortSignal) => Promise<boolean>,
  emitProgress: (sessionId: string, runId: string, event: unknown) => Effect.Effect<void>,
) {
  const toolDefinitions = options.executeTool ? options.toolDefinitions ?? [] : [];
  const toolNameBySdkName = new Map(toolDefinitions.map((definition) => [
    `subpolar_${createHash("sha256").update(definition.id).digest("hex").slice(0, 16)}`,
    definition.id,
  ]));
  const gateway = createPolicyGateway({
    tools: toolDefinitions,
    validateInput: (input, definition) => validateToolInput(
      input,
      definition.inputSchema as Parameters<typeof validateToolInput>[1],
    ),
    resolvePolicy: async (definition, context, input) => {
      const policy = await options.resolveToolPolicy?.(definition, context, input);
      // T3 must authorize each exact invocation. Persistent/"always" grants are
      // intentionally not offered by this bridge.
      return { ...(policy ?? {}), requiresApproval: true };
    },
    approve: async ({ call, definition, context }, signal) => ({
      approved: await requestPermission(context.sessionId, call, definition, signal),
      decidedBy: "t3-acp-client",
    }),
    execute: options.executeTool ?? (async () => ({
      ok: false as const,
      error: { code: "TOOL_EXECUTION_UNAVAILABLE", message: "Subpolar tool execution is not configured" },
    })),
  });
  const piFactory = options.executorFactory ?? createPiSdkExecutorFactory(options.loadPiSdk ?? loadPiSdk);

  return createSubpolarRuntimeHost({
    gateway,
    piFactory,
    piConfig: options.piConfig,
    context: {
      load: async ({ requestId, runId, sessionId, principal }): Promise<RuntimeContext | undefined> => {
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (!session) return undefined;
        return {
          requestId,
          runId,
          ...(sessionId === undefined ? {} : { sessionId }),
          principal: principal ?? { id: options.principalId ?? "local", kind: "local" },
          cwd: session.cwd,
        };
      },
    },
    createId: () => `subpolar-${crypto.randomUUID()}`,
    eventSink: async (event) => {
      if (event.type === "run.progress" && event.sessionId) {
        await Effect.runPromise(emitProgress(event.sessionId, event.runId, event.data));
      }
    },
  });
}

function makeAgent(stdio: Stdio.Stdio, options: SubpolarAcpOptions): Effect.Effect<AcpAgent.AcpAgent["Service"], never, import("effect/Scope").Scope> {
  return Effect.gen(function* () {
    const agent = yield* AcpAgent.make(stdio);
    const sessions = new Map<string, SessionContext>();
    const activeSessions = new Set<string>();
    const activeRunIds = new Map<string, string>();
    const streamedText = new Set<string>();
    const requestPermission = async (
      sessionId: string | undefined,
      call: ToolCall,
      definition: ToolDefinition,
      signal?: AbortSignal,
    ): Promise<boolean> => {
      if (!sessionId || signal?.aborted) return false;
      try {
        const permission = Effect.runPromise(agent.client.requestPermission({
          sessionId,
          toolCall: {
            toolCallId: call.callId,
            kind: "other",
            status: "pending",
            title: `${definition.id}: ${definition.description}`,
            name: definition.id,
            rawInput: call.input as NonNullable<AcpSchema.ToolCallUpdate["rawInput"]>,
          },
          options: [
            { optionId: "allow-once", name: "Allow this call", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject this call", kind: "reject_once" },
          ],
        }));
        const response = await (signal
          ? await new Promise<Awaited<typeof permission>>((resolve, reject) => {
              const abort = () => reject(new Error("Tool permission request cancelled"));
              signal.addEventListener("abort", abort, { once: true });
              permission.then(
                (value) => { signal.removeEventListener("abort", abort); resolve(value); },
                (error) => { signal.removeEventListener("abort", abort); reject(error); },
              );
            })
          : permission);
        if (signal?.aborted) return false;
        const approved = response.outcome.outcome === "selected" && response.outcome.optionId === "allow-once";
        await Effect.runPromise(agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: call.callId,
            status: approved ? "in_progress" : "failed",
          },
        })).catch(() => undefined);
        return approved;
      } catch {
        await Effect.runPromise(agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: call.callId,
            status: "failed",
          },
        })).catch(() => undefined);
        return false;
      }
    };
    const workerMode = process.env.SUBPOLAR_ACP_WORKER_MODE === "1";
    const resumeSessionIds = new Set<string>();
    const piConfig: PiSdkConfig = {
      ...options.piConfig,
      resumeSessionIds,
      ...(workerMode ? {
        modelRuntimeFactory: async (sdk: PiSdkModule, sessionId: string) => {
            if (!sdk.ModelRuntime) throw new Error("Pi credential runtime is unavailable");
            const runtime = await sdk.ModelRuntime.create({
              credentials: createAcpCredentialStore(agent.client, sessionId),
              modelsPath: null,
              refreshOnCreate: false,
              allowModelNetwork: false,
            });
            installAcpModelFetch(runtime, agent.client, sessionId);
            return runtime;
          },
      } : {}),
    };
    const runtimeOptions: SubpolarAcpOptions = workerMode && options.executeTool
      ? {
          ...options,
          executeTool: async (call, definition, context, signal) => {
            if (definition.id !== "internal/t3-mcp/list-tools" && definition.id !== "internal/t3-mcp/call-tool") {
              return options.executeTool!(call, definition, context, signal);
            }
            if (!context.sessionId || signal?.aborted) {
              return { ok: false, error: { code: "T3_MCP_SESSION_UNAVAILABLE", message: "The T3 MCP session is unavailable" } };
            }
            const input = call.input as { name?: unknown; arguments?: unknown };
            if (definition.id === "internal/t3-mcp/call-tool" &&
                (typeof input.name !== "string" || !input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments))) {
              return { ok: false, error: { code: "T3_MCP_REQUEST_INVALID", message: "A tool name and argument object are required" } };
            }
            try {
              const requestId = randomUUID();
              const request = Effect.runPromise(agent.client.extRequest("subpolar/t3_mcp", {
                sessionId: context.sessionId,
                requestId,
                operation: definition.id === "internal/t3-mcp/list-tools" ? "list_tools" : "call_tool",
                ...(definition.id === "internal/t3-mcp/call-tool" ? { name: input.name, arguments: input.arguments } : {}),
              }), signal ? { signal } : undefined);
              let cancelHostRequestPromise: Promise<void> | undefined;
              const cancelHostRequest = () => {
                cancelHostRequestPromise ??= Effect.runPromise(agent.client.extNotification("subpolar/cancel", {
                  sessionId: context.sessionId,
                  requestId,
                })).catch(() => undefined);
                return cancelHostRequestPromise;
              };
              signal?.addEventListener("abort", cancelHostRequest, { once: true });
              if (signal?.aborted) cancelHostRequest();
              let value: unknown;
              try {
                value = await request;
              } finally {
                signal?.removeEventListener("abort", cancelHostRequest);
                if (signal?.aborted) await cancelHostRequest();
              }
              return { ok: true, value };
            } catch {
              return { ok: false, error: { code: "T3_MCP_REQUEST_FAILED", message: "The authorized T3 MCP request could not be completed" } };
            }
          },
        }
      : options;
    const runtime = createRuntimeHost({ ...runtimeOptions, piConfig }, sessions, requestPermission, (sessionId, runId, event) => {
      activeRunIds.set(sessionId, runId);
      const candidate = event as { type?: unknown; data?: unknown };
      if (candidate?.type === "tool") {
        const data = candidate.data as { type?: unknown; toolCallId?: unknown; toolName?: unknown; args?: unknown; isError?: unknown; result?: unknown; partialResult?: unknown } | undefined;
        if (typeof data?.toolCallId !== "string" || typeof data.toolName !== "string") return Effect.void;
        const isStart = data.type === "tool_execution_start";
        const isEnd = data.type === "tool_execution_end";
        const isUpdate = data.type === "tool_execution_update";
        if (!isStart && !isEnd && !isUpdate) return Effect.void;
        const toolName = toolNameBySdkName.get(data.toolName) ?? "Subpolar tool";
        return agent.client.sessionUpdate({
          sessionId,
          update: isStart
            ? {
                sessionUpdate: "tool_call",
                toolCallId: data.toolCallId,
                title: toolName,
                name: toolName,
                kind: "other",
                status: "pending",
                rawInput: data.args as NonNullable<AcpSchema.ToolCallUpdate["rawInput"]>,
              }
            : isUpdate
              ? {
                  sessionUpdate: "tool_call_update",
                  toolCallId: data.toolCallId,
                  status: "in_progress",
                  rawOutput: data.partialResult,
                }
              : {
                  sessionUpdate: "tool_call_update",
                  toolCallId: data.toolCallId,
                  status: data.isError === true ? "failed" : "completed",
                  rawOutput: data.result,
                },
        }).pipe(Effect.catch(() => Effect.void));
      }
      if (candidate?.type !== "text") return Effect.void;
      const text = eventText(candidate.data);
      if (!text) return Effect.void;
      streamedText.add(runId);
      return agent.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: runId,
          content: { type: "text", text },
        },
      }).pipe(Effect.catch(() => Effect.void));
    });

    yield* agent.handleInitialize((request) =>
      Effect.succeed({
        protocolVersion: request.protocolVersion,
        info: { name: "subpolar", version: "0.1.0" },
        capabilities: { session: {} },
      }),
    );

    yield* agent.handleCreateSession((request) =>
      Effect.sync(() => {
        const meta = request._meta as Record<string, unknown> | undefined;
        const requestedSessionId = workerMode && typeof meta?.["subpolar.sessionId"] === "string"
          ? meta["subpolar.sessionId"] as string
          : undefined;
        const session = runtime.createSession({ id: options.principalId ?? "local", kind: "local" }, requestedSessionId);
        sessions.set(session.sessionId, { cwd: options.sessionCwd?.(request.cwd) ?? request.cwd });
        return { sessionId: session.sessionId };
      }),
    );

    const restoreSession = (request: AcpSchema.LoadSessionRequest | AcpSchema.ResumeSessionRequest) => Effect.tryPromise({
      try: async () => {
        const cwd = options.sessionCwd?.(request.cwd) ?? request.cwd;
        await validatePiSession(options.loadPiSdk ?? loadPiSdk, cwd, request.sessionId, options.piConfig?.runtimeDataDir);
        resumeSessionIds.add(request.sessionId);
        runtime.restoreSession(request.sessionId, { id: options.principalId ?? "local", kind: "local" });
        sessions.set(request.sessionId, { cwd });
        return {};
      },
      catch: (error) => AcpError.AcpRequestError.resourceNotFound(errorMessage(error)),
    });
    yield* agent.handleLoadSession(restoreSession);
    yield* agent.handleResumeSession(restoreSession);

    yield* agent.handleCancel((notification) =>
      Effect.sync(() => {
        runtime.cancel(notification.sessionId);
      }),
    );

    yield* agent.handleCloseSession((request) => Effect.tryPromise({
      try: async () => {
        if (!sessions.has(request.sessionId)) {
          throw AcpError.AcpRequestError.resourceNotFound("Subpolar ACP session was not found");
        }
        await runtime.closeSession(request.sessionId);
        sessions.delete(request.sessionId);
        activeSessions.delete(request.sessionId);
        const runId = activeRunIds.get(request.sessionId);
        if (runId) streamedText.delete(runId);
        activeRunIds.delete(request.sessionId);
        return {};
      },
      catch: (error) => error instanceof AcpError.AcpRequestError
        ? error
        : AcpError.AcpRequestError.internalError(errorMessage(error)),
    }));

    yield* agent.handlePrompt((request) =>
      Effect.gen(function* () {
        const session = sessions.get(request.sessionId);
        if (!session) return yield* Effect.fail(AcpError.AcpRequestError.resourceNotFound("Subpolar ACP session was not found"));
        if (activeSessions.has(request.sessionId)) {
          return yield* Effect.fail(AcpError.AcpRequestError.invalidRequest("A prompt is already running for this session"));
        }

        let prompt: string;
        try {
          prompt = promptText(request.prompt);
        } catch (error) {
          return yield* Effect.fail(AcpError.AcpRequestError.invalidParams(errorMessage(error)));
        }

        activeSessions.add(request.sessionId);
        const previousRunId = activeRunIds.get(request.sessionId);
        if (previousRunId) streamedText.delete(previousRunId);
        activeRunIds.delete(request.sessionId);
        yield* agent.client.sessionUpdate({
          sessionId: request.sessionId,
          update: { sessionUpdate: "state_update", state: "running" },
        });
        const failureMessageId = crypto.randomUUID();

        yield* Effect.forkScoped(
          Effect.tryPromise({
            try: () => runtime.prompt(request.sessionId, prompt),
            catch: (error) => error,
          }).pipe(
            Effect.flatMap((result) => {
              const runId = result.runId;
              const finalText = result.state === "completed" ? eventText(result.output) : undefined;
              const sendFinalText = finalText && !streamedText.has(runId)
                ? agent.client.sessionUpdate({
                    sessionId: request.sessionId,
                    update: {
                      sessionUpdate: "agent_message",
                    messageId: runId,
                      content: [{ type: "text", text: finalText }],
                    },
                  })
                : Effect.void;
              const error = result.state === "completed" ? undefined : result.error.message;
              const sendError = error
                ? agent.client.sessionUpdate({
                    sessionId: request.sessionId,
                    update: {
                      sessionUpdate: "agent_message",
                      messageId: runId,
                      content: [{ type: "text", text: error }],
                    },
                  })
                : Effect.void;
              return sendFinalText.pipe(
                Effect.andThen(sendError),
                Effect.andThen(agent.client.sessionUpdate({
                  sessionId: request.sessionId,
                  update: {
                    sessionUpdate: "state_update",
                    state: "idle",
                    ...(result.state === "interrupted"
                      ? { stopReason: "cancelled" as const }
                      : result.state === "completed"
                        ? { stopReason: "end_turn" as const }
                        : { stopReason: "refusal" as const }),
                  },
                })),
                Effect.ensuring(Effect.sync(() => {
                  activeSessions.delete(request.sessionId);
                  streamedText.delete(runId);
                  activeRunIds.delete(request.sessionId);
                })),
                Effect.as({}),
              );
            }),
            Effect.catch((error) =>
              agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: {
                  sessionUpdate: "agent_message",
                  messageId: failureMessageId,
                  content: [{ type: "text", text: errorMessage(error) }],
                },
              }).pipe(
                Effect.andThen(agent.client.sessionUpdate({
                  sessionId: request.sessionId,
                  update: { sessionUpdate: "state_update", state: "idle", stopReason: "refusal" },
                })),
                Effect.ensuring(Effect.sync(() => {
                  activeSessions.delete(request.sessionId);
                  const runId = activeRunIds.get(request.sessionId);
                  if (runId) streamedText.delete(runId);
                  activeRunIds.delete(request.sessionId);
                })),
              ),
            ),
          ),
        );
        return {};
      }),
    );

    return agent;
  });
}

/** Build a local ACP agent backed by Subpolar's stateless runtime and Pi adapter. */
export const layer = (stdio: Stdio.Stdio, options: SubpolarAcpOptions = {}) =>
  Layer.effect(AcpAgent.AcpAgent, makeAgent(stdio, options));

/** Build a stdio agent using the host's Node stdin/stdout services. */
export const layerStdio = (options: SubpolarAcpOptions = {}) =>
  Layer.effect(
    AcpAgent.AcpAgent,
    Effect.flatMap(Effect.service(Stdio.Stdio), (stdio) => makeAgent(stdio, options)),
  );
