import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  EnvironmentManagerError,
  type EnvironmentManager,
  type EnvironmentProcessRequest,
  type EnvironmentManagedSessionRequest,
  type EnvironmentRequest,
} from "./index.ts";

const MAX_BODY_BYTES = 1_048_576;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...Object.fromEntries(new Headers(headers)) },
  });
}

function isAuthorized(request: Request, token: string): boolean {
  const authorization = request.headers.get("authorization");
  const supplied = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!supplied) return false;
  const suppliedBytes = Buffer.from(supplied);
  const tokenBytes = Buffer.from(token);
  if (suppliedBytes.byteLength !== tokenBytes.byteLength) return false;
  return timingSafeEqual(suppliedBytes, tokenBytes);
}

async function readJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new EnvironmentManagerError("INVALID_REQUEST", "Request body exceeds the allowed size");
  }
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new EnvironmentManagerError("INVALID_REQUEST", "Request body exceeds the allowed size");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new EnvironmentManagerError("INVALID_REQUEST", "Request body must be valid JSON", { cause });
  }
}

function environmentRequest(value: unknown): EnvironmentRequest {
  if (!isRecord(value) || typeof value.ownerId !== "string" || typeof value.workspaceId !== "string" ||
      typeof value.storageRoot !== "string" || typeof value.worktreePath !== "string") {
    throw new EnvironmentManagerError("INVALID_REQUEST", "Environment identity is invalid");
  }
  return {
    ownerId: value.ownerId,
    workspaceId: value.workspaceId,
    storageRoot: value.storageRoot,
    worktreePath: value.worktreePath,
  };
}

function processRequest(value: unknown): EnvironmentProcessRequest {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new EnvironmentManagerError("INVALID_REQUEST", "Process options are invalid");
  const cwd = value.cwd;
  const environment = value.environment;
  if (cwd !== undefined && typeof cwd !== "string") {
    throw new EnvironmentManagerError("INVALID_REQUEST", "Process working directory is invalid");
  }
  if (environment !== undefined && (!isRecord(environment) || Object.values(environment).some((entry) => typeof entry !== "string"))) {
    throw new EnvironmentManagerError("INVALID_REQUEST", "Process environment is invalid");
  }
  return {
    ...(cwd === undefined ? {} : { cwd }),
    ...(environment === undefined ? {} : { environment: environment as Record<string, string> }),
  };
}

function interactiveProcessRequest(value: unknown): { cwd?: string; environment?: Record<string, string>; clientSessionId?: string } {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new EnvironmentManagerError("INVALID_REQUEST", "Interactive process options are invalid");
  if (value.cwd !== undefined && typeof value.cwd !== "string") throw new EnvironmentManagerError("INVALID_REQUEST", "Process working directory is invalid");
  if (value.clientSessionId !== undefined && typeof value.clientSessionId !== "string") throw new EnvironmentManagerError("INVALID_REQUEST", "Client session ID is invalid");
  if (value.environment !== undefined && (!isRecord(value.environment) || Object.values(value.environment).some((entry) => typeof entry !== "string"))) {
    throw new EnvironmentManagerError("INVALID_REQUEST", "Process environment is invalid");
  }
  return {
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(value.environment === undefined ? {} : { environment: value.environment as Record<string, string> }),
    ...(value.clientSessionId === undefined ? {} : { clientSessionId: value.clientSessionId }),
  };
}

function managedSessionRequest(value: unknown): EnvironmentManagedSessionRequest {
  return interactiveProcessRequest(value);
}

function statusFor(error: unknown): number {
  if (error instanceof EnvironmentManagerError) {
    if (error.code === "INVALID_REQUEST" || error.code === "WORKTREE_OUTSIDE_ROOT") return 400;
    if (error.code === "OWNERSHIP_MISMATCH") return 403;
    if (error.code === "ENVIRONMENT_NOT_FOUND") return 404;
  }
  return 502;
}

function errorCode(error: unknown): string {
  return error instanceof EnvironmentManagerError ? error.code : "MANAGER_OPERATION_FAILED";
}

/**
 * Authenticated manager API handler. Keep this in the dedicated manager
 * process that owns Docker access; never mount the Docker socket in T3.
 */
export function createEnvironmentManagerHttpHandler(manager: EnvironmentManager, token: string) {
  if (token.length < 32 || token.includes("\0")) throw new Error("Manager API token must contain at least 32 characters");

  return async (request: Request): Promise<Response> => {
    if (request.method === "GET" && new URL(request.url).pathname === "/healthz") {
      return jsonResponse({ ok: true });
    }
    if (!isAuthorized(request, token)) return jsonResponse({ error: "UNAUTHORIZED" }, 401, { "www-authenticate": "Bearer" });
    if (request.method !== "POST") return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405, { allow: "POST" });

    const pathname = new URL(request.url).pathname;
    const interactiveRoute = pathname.match(/^\/v1\/environments\/pty\/(start|input|resize|output|terminate)$/)?.[1];
    const managedSessionRoute = pathname.match(/^\/v1\/environments\/stdio\/(start|input|output|terminate)$/)?.[1];
    const tcpTunnelRoute = pathname === "/v1/environments/tcp/start";
    const adminRoute = pathname.match(/^\/v1\/environments\/admin\/(status|list|inspect|rebuild)$/)?.[1];
    const route = pathname.match(/^\/v1\/environments\/(identity|ensure|start|stop|restart|remove|execute|reconcile)$/)?.[1];
    if (!route && !adminRoute && !interactiveRoute && !managedSessionRoute && !tcpTunnelRoute) return jsonResponse({ error: "NOT_FOUND" }, 404);

    try {
      if (adminRoute === "status") {
        if (!manager.list) return jsonResponse({ error: "ADMIN_UNAVAILABLE" }, 501);
        const registrations = await manager.list();
        return jsonResponse({ ok: true, registeredEnvironmentCount: registrations.length });
      }
      if (adminRoute === "list") {
        if (!manager.list) return jsonResponse({ error: "ADMIN_UNAVAILABLE" }, 501);
        const body = await readJson(request);
        if (!isRecord(body) || (body.ownerId !== undefined && (typeof body.ownerId !== "string" || !body.ownerId.trim()))) {
          throw new EnvironmentManagerError("INVALID_REQUEST", "ownerId must be a non-empty string when provided");
        }
        return jsonResponse({ environments: await manager.list(body.ownerId as string | undefined) });
      }
      if (adminRoute === "inspect" || adminRoute === "rebuild") {
        const operation = adminRoute === "inspect" ? manager.inspect : manager.rebuild;
        if (!operation) return jsonResponse({ error: "ADMIN_UNAVAILABLE" }, 501);
        const body = await readJson(request);
        if (!isRecord(body)) throw new EnvironmentManagerError("INVALID_REQUEST", "Request body must be a JSON object");
        const environment = environmentRequest(body.environment);
        const result = await operation.call(manager, environment);
        return adminRoute === "inspect" ? jsonResponse({ environment: result }) : jsonResponse(result);
      }
      if (route === "reconcile") return jsonResponse({ results: await manager.reconcile() });
      const body = await readJson(request);
      if (!isRecord(body)) throw new EnvironmentManagerError("INVALID_REQUEST", "Request body must be a JSON object");
      const environment = environmentRequest(body.environment);
      if (tcpTunnelRoute) {
        if (typeof body.port !== "number" || !Number.isSafeInteger(body.port) || body.port < 1 || body.port > 65_535) {
          throw new EnvironmentManagerError("INVALID_REQUEST", "Port tunnel target must be a valid TCP port");
        }
        return jsonResponse(await manager.startPortTunnel(environment, body.port));
      }
      if (managedSessionRoute) {
        if (managedSessionRoute === "start") {
          if (!Array.isArray(body.command) || body.command.length === 0 || body.command.length > 256 ||
              body.command.some((part) => typeof part !== "string" || !part || part.includes("\0"))) {
            throw new EnvironmentManagerError("INVALID_REQUEST", "Managed session command must be a valid argv array");
          }
          return jsonResponse(await manager.startManagedSession(environment, body.command as string[], managedSessionRequest(body.process)));
        }
        if (typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.length > 256) {
          throw new EnvironmentManagerError("INVALID_REQUEST", "Managed session ID is invalid");
        }
        if (managedSessionRoute === "input") {
          if (typeof body.data !== "string" || body.data.length > 87_384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data)) {
            throw new EnvironmentManagerError("INVALID_REQUEST", "Managed session input must be base64 encoded");
          }
          const data = Buffer.from(body.data, "base64");
          if (data.byteLength > 65_536) throw new EnvironmentManagerError("INVALID_REQUEST", "Managed session input exceeds 64 KiB");
          await manager.writeManagedSession(environment, body.sessionId, data);
          return jsonResponse({ written: data.byteLength });
        }
        if (managedSessionRoute === "terminate") {
          await manager.terminateManagedSession(environment, body.sessionId);
          return jsonResponse({ terminated: true });
        }
        const afterSequence = body.afterSequence ?? 0;
        if (typeof afterSequence !== "number" || !Number.isSafeInteger(afterSequence) || afterSequence < 0) {
          throw new EnvironmentManagerError("INVALID_REQUEST", "Managed session output cursor is invalid");
        }
        const controller = new AbortController();
        const abortFromRequest = () => controller.abort(request.signal.reason);
        if (request.signal.aborted) abortFromRequest();
        else request.signal.addEventListener("abort", abortFromRequest, { once: true });
        const iterator = manager.attachManagedSessionOutput(environment, body.sessionId, afterSequence)[Symbol.asyncIterator]();
        let closed = false;
        let consumerReady = false;
        let wakeProducer: (() => void) | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controllerStream) {
            const emit = async (event: unknown) => {
              while (!closed && !consumerReady) await new Promise<void>((resolve) => { wakeProducer = resolve; });
              if (closed) return;
              consumerReady = false;
              controllerStream.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
            };
            void (async () => {
              try {
                while (!closed && !controller.signal.aborted) {
                  const next = await iterator.next();
                  if (next.done) break;
                  const event = next.value.type === "output"
                    ? { type: "output", sequence: next.value.sequence, stream: next.value.stream, data: Buffer.from(next.value.data).toString("base64") }
                    : next.value;
                  await emit(event);
                  if (next.value.type === "exit") break;
                }
                if (!closed) { closed = true; controllerStream.close(); }
              } catch (error) {
                if (!closed) {
                  closed = true;
                  controllerStream.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "error", code: errorCode(error) })}\n`));
                  controllerStream.close();
                }
              } finally {
                await iterator.return?.();
                request.signal.removeEventListener("abort", abortFromRequest);
              }
            })();
          },
          pull() { consumerReady = true; wakeProducer?.(); },
          async cancel() {
            closed = true;
            controller.abort();
            wakeProducer?.();
            await iterator.return?.();
            request.signal.removeEventListener("abort", abortFromRequest);
          },
        });
        return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      }
      if (interactiveRoute) {
        if (interactiveRoute === "start") {
          if (!Array.isArray(body.command) || body.command.length === 0 || body.command.length > 256 ||
              body.command.some((part) => typeof part !== "string" || !part || part.includes("\0"))) {
            throw new EnvironmentManagerError("INVALID_REQUEST", "Interactive command must be a valid argv array");
          }
          return jsonResponse(await manager.startInteractive(environment, body.command as string[], interactiveProcessRequest(body.process)));
        }
        if (typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.length > 256) {
          throw new EnvironmentManagerError("INVALID_REQUEST", "Interactive session ID is invalid");
        }
        if (interactiveRoute === "input") {
          if (typeof body.data !== "string" || body.data.length > 87_384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data)) {
            throw new EnvironmentManagerError("INVALID_REQUEST", "Interactive input must be base64 encoded");
          }
          const data = Buffer.from(body.data, "base64");
          if (data.byteLength > 65_536) throw new EnvironmentManagerError("INVALID_REQUEST", "Interactive input exceeds 64 KiB");
          await manager.writeInteractive(environment, body.sessionId, data);
          return jsonResponse({ written: data.byteLength });
        }
        if (interactiveRoute === "resize") {
          if (typeof body.columns !== "number" || typeof body.rows !== "number") throw new EnvironmentManagerError("INVALID_REQUEST", "Terminal dimensions are invalid");
          await manager.resizeInteractive(environment, body.sessionId, body.columns, body.rows);
          return jsonResponse({ resized: true });
        }
        if (interactiveRoute === "terminate") {
          await manager.terminateInteractive(environment, body.sessionId);
          return jsonResponse({ terminated: true });
        }
        const afterSequence = body.afterSequence ?? 0;
        if (typeof afterSequence !== "number" || !Number.isSafeInteger(afterSequence) || afterSequence < 0) {
          throw new EnvironmentManagerError("INVALID_REQUEST", "Interactive output cursor is invalid");
        }
        const controller = new AbortController();
        const abortFromRequest = () => controller.abort(request.signal.reason);
        if (request.signal.aborted) abortFromRequest();
        else request.signal.addEventListener("abort", abortFromRequest, { once: true });
        const iterator = manager.attachInteractiveOutput(environment, body.sessionId, afterSequence)[Symbol.asyncIterator]();
        let closed = false;
        let consumerReady = false;
        let wakeProducer: (() => void) | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controllerStream) {
            const emit = async (event: unknown) => {
              while (!closed && !consumerReady) await new Promise<void>((resolve) => { wakeProducer = resolve; });
              if (closed) return;
              consumerReady = false;
              controllerStream.enqueue(new TextEncoder().encode(`${JSON.stringify(event, (_key, value) => value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value)}\n`));
            };
            void (async () => {
              try {
                while (!closed && !controller.signal.aborted) {
                  const next = await iterator.next();
                  if (next.done) break;
                  const event = next.value.type === "output"
                    ? { type: "output", sequence: next.value.sequence, data: Buffer.from(next.value.data).toString("base64") }
                    : next.value;
                  await emit(event);
                  if (next.value.type === "exit") break;
                }
                if (!closed) { closed = true; controllerStream.close(); }
              } catch (error) {
                if (!closed) {
                  closed = true;
                  controllerStream.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "error", code: errorCode(error) })}\n`));
                  controllerStream.close();
                }
              } finally {
                await iterator.return?.();
                request.signal.removeEventListener("abort", abortFromRequest);
              }
            })();
          },
          pull() { consumerReady = true; wakeProducer?.(); },
          async cancel() {
            closed = true;
            controller.abort();
            wakeProducer?.();
            await iterator.return?.();
            request.signal.removeEventListener("abort", abortFromRequest);
          },
        });
        return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      }
      if (route === "identity") return jsonResponse(await manager.identity(environment));
      if (route === "ensure") return jsonResponse(await manager.ensure(environment));
      if (route === "start") return jsonResponse(await manager.start(environment));
      if (route === "stop") return jsonResponse(await manager.stop(environment));
      if (route === "restart") {
        if (!manager.restart) return jsonResponse({ error: "ADMIN_UNAVAILABLE" }, 501);
        return jsonResponse(await manager.restart(environment));
      }
      if (route === "remove") {
        await manager.remove(environment);
        return jsonResponse({ removed: true });
      }

      if (!Array.isArray(body.command) || body.command.length === 0 || body.command.length > 256 ||
          body.command.some((part) => typeof part !== "string" || part.length === 0 || part.includes("\0"))) {
        throw new EnvironmentManagerError("INVALID_REQUEST", "Process command must be a valid argv array");
      }
      const options = processRequest(body.process);
      const controller = new AbortController();
      const abortFromRequest = () => controller.abort(request.signal.reason);
      if (request.signal.aborted) abortFromRequest();
      else request.signal.addEventListener("abort", abortFromRequest, { once: true });

      let closed = false;
      let consumerReady = false;
      let wakeProducer: (() => void) | undefined;
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controllerStream) {
          streamController = controllerStream;
          const emit = async (event: unknown) => {
            while (!closed && !consumerReady) {
              await new Promise<void>((resolve) => { wakeProducer = resolve; });
            }
            if (closed) return;
            consumerReady = false;
            streamController!.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
          };
          void manager.execute(environment, body.command as string[], {
            ...options,
            signal: controller.signal,
            onOutput: async (output) => emit({
              type: "output",
              stream: output.stream,
              data: Buffer.from(output.data).toString("base64"),
            }),
          }).then(
            (result) => emit({ type: "result", result }),
            (error: unknown) => emit({ type: "error", code: errorCode(error) }),
          ).finally(() => {
            if (!closed) {
              closed = true;
              controllerStream.close();
            }
            wakeProducer?.();
            request.signal.removeEventListener("abort", abortFromRequest);
          });
        },
        pull() {
          consumerReady = true;
          wakeProducer?.();
        },
        cancel(reason) {
          closed = true;
          controller.abort(reason);
          wakeProducer?.();
          request.signal.removeEventListener("abort", abortFromRequest);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    } catch (error) {
      return jsonResponse({ error: errorCode(error) }, statusFor(error));
    }
  };
}

/** Create an HTTP server for the manager; callers choose the listen address. */
export function createEnvironmentManagerServer(input: {
  readonly manager: EnvironmentManager;
  readonly token: string;
  readonly hostname?: string;
  readonly port?: number;
}): Server {
  const handle = createEnvironmentManagerHttpHandler(input.manager, input.token);
  const hostname = input.hostname ?? "127.0.0.1";
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      const body = incoming.method === "GET" || incoming.method === "HEAD"
        ? undefined
        : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      const requestController = new AbortController();
      incoming.once("aborted", () => requestController.abort(new Error("Manager request was disconnected")));
      const requestHost = incoming.headers.host ?? `${hostname}:${input.port ?? 0}`;
      const request = new Request(`http://${requestHost}${incoming.url ?? "/"}`, {
        method: incoming.method,
        headers,
        signal: requestController.signal,
        ...(body === undefined ? {} : { body, duplex: "half" }),
      } as RequestInit & { duplex?: "half" });
      const response = await handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) {
        outgoing.end();
        return;
      }
      await pipeline(Readable.fromWeb(response.body), outgoing);
    })().catch(() => {
      if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "application/json" });
      if (!outgoing.destroyed) outgoing.end(JSON.stringify({ error: "MANAGER_REQUEST_FAILED" }));
    });
  });
  return server;
}
