import * as Effect from "effect/Effect";

const METHOD = "subpolar/model_fetch";
const CANCEL_METHOD = "subpolar/cancel";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

interface AcpClient {
  extRequest(method: string, payload: unknown): Effect.Effect<unknown, Error>;
  extNotification(method: string, payload: unknown): Effect.Effect<void, Error>;
}

function randomId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Pi SDK fetch implementation that tunnels requests over its private ACP session. */
export function createAcpModelFetch(
  client: AcpClient,
  sessionId: string,
  providerId: string,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.signal.aborted)
      throw new DOMException("Provider request was aborted", "AbortError");
    let bodyBytes: Uint8Array | undefined;
    if (request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const cancelBody = () => {
        void reader.cancel("Provider request was aborted").catch(() => undefined);
      };
      request.signal.addEventListener("abort", cancelBody, { once: true });
      try {
        while (true) {
          if (request.signal.aborted)
            throw new DOMException("Provider request was aborted", "AbortError");
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
    const requestId = randomId();
    const responseRequest = Effect.runPromise(
      client.extRequest(METHOD, {
        sessionId,
        requestId,
        providerId,
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        ...(bodyBytes ? { body: Buffer.from(bodyBytes).toString("base64") } : {}),
      }),
      { signal: request.signal },
    );
    let cancelHostRequestPromise: Promise<void> | undefined;
    const cancelHostRequest = () => {
      cancelHostRequestPromise ??= Effect.runPromise(
        client.extNotification(CANCEL_METHOD, { sessionId, requestId }),
      ).catch(() => undefined);
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
    if (
      typeof response.status !== "number" ||
      typeof response.body !== "string" ||
      !response.headers ||
      typeof response.headers !== "object"
    ) {
      throw new Error("Managed provider egress returned an invalid response");
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(object(response.headers)))
      if (typeof value === "string") headers.set(key, value);
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
  readonly stream?: (
    model: unknown,
    context: unknown,
    options?: Record<string, unknown>,
  ) => unknown;
  readonly streamSimple?: (
    model: unknown,
    context: unknown,
    options?: Record<string, unknown>,
  ) => unknown;
}

interface RuntimeWithProviders {
  getProviders(): readonly RuntimeProvider[];
  registerNativeProvider(provider: RuntimeProvider): void;
}

/** Re-registers native providers with Pi's supported per-request fetch override. */
export function installAcpModelFetch(
  runtimeValue: unknown,
  client: AcpClient,
  sessionId: string,
): void {
  const runtime = runtimeValue as RuntimeWithProviders;
  if (
    !runtime ||
    typeof runtime.getProviders !== "function" ||
    typeof runtime.registerNativeProvider !== "function"
  ) {
    throw new Error("Pi model runtime cannot install the managed provider transport");
  }
  for (const provider of runtime.getProviders()) {
    const fetch = createAcpModelFetch(client, sessionId, provider.id);
    const stream = provider.stream;
    const streamSimple = provider.streamSimple;
    const wrapped: RuntimeProvider = {
      ...provider,
      ...(stream === undefined
        ? {}
        : {
            stream: (model: unknown, context: unknown, options?: Record<string, unknown>) =>
              stream(model, context, { ...options, fetch }),
          }),
      ...(streamSimple === undefined
        ? {}
        : {
            streamSimple: (model: unknown, context: unknown, options?: Record<string, unknown>) =>
              streamSimple(model, context, { ...options, fetch }),
          }),
    };
    if (stream || streamSimple) runtime.registerNativeProvider(wrapped);
  }
}

export const MANAGED_MODEL_FETCH_METHOD = METHOD;
export const MANAGED_CANCEL_METHOD = CANCEL_METHOD;
