import { randomUUID } from "node:crypto";

import * as Effect from "effect/Effect";

const METHOD = "subpolar/model_fetch";
const CANCEL_METHOD = "subpolar/cancel";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

interface AcpClient {
  extRequest(method: string, payload: unknown): Effect.Effect<unknown, unknown>;
  extNotification(method: string, payload: unknown): Effect.Effect<void, unknown>;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Pi SDK fetch implementation that tunnels requests over its private ACP session. */
export function createAcpModelFetch(client: AcpClient, sessionId: string, providerId: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.signal.aborted) throw new DOMException("Provider request was aborted", "AbortError");
    let bodyBytes: Uint8Array | undefined;
    if (request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const cancelBody = () => { void reader.cancel("Provider request was aborted").catch(() => undefined); };
      request.signal.addEventListener("abort", cancelBody, { once: true });
      try {
        while (true) {
          if (request.signal.aborted) throw new DOMException("Provider request was aborted", "AbortError");
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_REQUEST_BYTES) {
            await reader.cancel("Provider request body exceeded the egress size limit");
            throw new Error("Provider request body exceeded the egress size limit");
          }
          chunks.push(value);
        }
      } finally {
        request.signal.removeEventListener("abort", cancelBody);
        reader.releaseLock();
      }
      bodyBytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bodyBytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    const requestId = randomUUID();
    const responseRequest = Effect.runPromise(client.extRequest(METHOD, {
      sessionId,
      requestId,
      providerId,
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      ...(bodyBytes ? { body: Buffer.from(bodyBytes).toString("base64") } : {}),
    }), { signal: request.signal });
    let cancelHostRequestPromise: Promise<void> | undefined;
    const cancelHostRequest = () => {
      cancelHostRequestPromise ??= Effect.runPromise(client.extNotification(CANCEL_METHOD, { sessionId, requestId }))
        .catch(() => undefined);
      return cancelHostRequestPromise;
    };
    request.signal.addEventListener("abort", cancelHostRequest, { once: true });
    if (request.signal.aborted) cancelHostRequest();
    let responseValue: unknown;
    try {
      responseValue = await responseRequest;
    } catch (error) {
      if (request.signal.aborted) {
        await cancelHostRequest();
        throw new DOMException("Provider request was aborted", "AbortError");
      }
      throw error;
    } finally {
      request.signal.removeEventListener("abort", cancelHostRequest);
    }
    const response = object(responseValue);
    if (typeof response.status !== "number" || typeof response.body !== "string" || !response.headers || typeof response.headers !== "object") {
      throw new Error("Managed provider egress returned an invalid response");
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(object(response.headers))) if (typeof value === "string") headers.set(key, value);
    const bytes = Buffer.from(response.body, "base64");
    return new Response(response.status === 204 || response.status === 304 ? null : bytes, {
      status: response.status,
      statusText: typeof response.statusText === "string" ? response.statusText : "",
      headers,
    });
  };
}

interface RuntimeProvider {
  readonly id: string;
  readonly stream?: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;
  readonly streamSimple?: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;
}

interface RuntimeWithProviders {
  getProviders(): readonly RuntimeProvider[];
  registerNativeProvider(provider: RuntimeProvider): void;
}

/** Re-registers native providers with Pi's supported per-request fetch override. */
export function installAcpModelFetch(runtimeValue: unknown, client: AcpClient, sessionId: string): void {
  const runtime = runtimeValue as RuntimeWithProviders;
  if (!runtime || typeof runtime.getProviders !== "function" || typeof runtime.registerNativeProvider !== "function") {
    throw new Error("Pi model runtime cannot install the managed provider transport");
  }
  for (const provider of runtime.getProviders()) {
    const fetch = createAcpModelFetch(client, sessionId, provider.id);
    const wrapped: RuntimeProvider = { ...provider };
    if (provider.stream) {
      wrapped.stream = (model, context, options) => provider.stream!(model, context, { ...options, fetch });
    }
    if (provider.streamSimple) {
      wrapped.streamSimple = (model, context, options) => provider.streamSimple!(model, context, { ...options, fetch });
    }
    if (wrapped.stream || wrapped.streamSimple) runtime.registerNativeProvider(wrapped);
  }
}

export const MANAGED_MODEL_FETCH_METHOD = METHOD;
export const MANAGED_CANCEL_METHOD = CANCEL_METHOD;
