import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";

import type { AcpAdapterV2ExtensionContext } from "@t3tools/provider-acp/server/adapter";
import { isPiProviderId } from "./subpolarCredentials.ts";

const METHOD = "subpolar/model_fetch";
const CANCEL_METHOD = "subpolar/cancel";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const PROVIDER_HOSTS: Readonly<Record<string, string>> = Object.freeze({
  anthropic: "api.anthropic.com",
  deepseek: "api.deepseek.com",
  google: "generativelanguage.googleapis.com",
  groq: "api.groq.com",
  mistral: "api.mistral.ai",
  openai: "api.openai.com",
  openrouter: "openrouter.ai",
  xai: "api.x.ai",
});

function allowedInferencePath(providerId: string, pathname: string): boolean {
  switch (providerId) {
    case "anthropic": return pathname === "/v1/messages";
    case "google": return /^\/v1(?:beta|)\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(pathname);
    case "openai": return pathname === "/v1/responses" || pathname === "/v1/chat/completions";
    case "openrouter": return pathname === "/api/v1/chat/completions";
    default: return pathname === "/v1/chat/completions";
  }
}

const Request = Schema.Struct({
  sessionId: Schema.String,
  requestId: Schema.String,
  providerId: Schema.String,
  url: Schema.String,
  method: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.optional(Schema.String),
});
const CancelRequest = Schema.Struct({ sessionId: Schema.String, requestId: Schema.String });

function publicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  return !(
    a === 0 || a === 10 || a === 127 || a! >= 224 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

async function resolvePublicIpv4(hostname: string): Promise<string> {
  const addresses = await lookup(hostname, { all: true, family: 4, verbatim: true });
  const address = addresses.find((entry) => isIP(entry.address) === 4 && publicIpv4(entry.address));
  if (!address) throw new Error("Provider endpoint did not resolve to a public IPv4 address");
  return address.address;
}

function readLimited(response: IncomingMessage, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > limit) {
        response.destroy(new Error("Provider response exceeded the egress size limit"));
        reject(new Error("Provider response exceeded the egress size limit"));
        return;
      }
      chunks.push(bytes);
    });
    response.on("end", () => resolve(Buffer.concat(chunks)));
    response.on("error", reject);
  });
}

async function requestProvider(
  hostname: string,
  address: string,
  method: string,
  pathname: string,
  headers: Readonly<Record<string, string>>,
  body?: Uint8Array,
  signal?: AbortSignal,
) {
  return new Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }>((resolve, reject) => {
    const requestHeaders = {
      ...headers,
      ...(body === undefined ? {} : { "content-length": String(body.byteLength) }),
    };
    const request = httpsRequest({
      hostname,
      path: pathname,
      method,
      headers: requestHeaders,
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [{ address, family: 4 }])
        : callback(null, address, 4),
      timeout: REQUEST_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    }, (response) => {
      void readLimited(response, MAX_RESPONSE_BYTES).then((bytes) => {
        const status = response.statusCode ?? 502;
        if (status < 200 || status > 599) return reject(new Error("Provider returned an unsupported HTTP status"));
        const resultHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          // Redirects are intentionally not followed and cannot escape the exact provider host.
          if (typeof value === "string" && key !== "set-cookie" && key !== "location") resultHeaders[key] = value;
        }
        resolve({ status, statusText: response.statusMessage ?? "", headers: resultHeaders, body: Buffer.from(bytes).toString("base64") });
      }, reject);
    });
    request.on("timeout", () => request.destroy(new Error("Provider request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

export function registerSubpolarModelEgressExtension(input: {
  readonly providerIds: ReadonlyArray<string>;
  readonly context: AcpAdapterV2ExtensionContext;
  readonly resolveAddress?: typeof resolvePublicIpv4;
  readonly requestProvider?: typeof requestProvider;
}) {
  const providerIds = new Set(input.providerIds.filter(isPiProviderId));
  const activeRequests = new Map<string, AbortController>();
  return Effect.gen(function* () {
    yield* input.context.runtime.handleExtRequest(METHOD, Request, (request) => Effect.gen(function* () {
    const activeSessionId = yield* input.context.activeSessionId;
    return yield* Effect.tryPromise({
      try: async (signal) => {
      if (!request.sessionId || request.sessionId !== activeSessionId) throw new Error("Provider egress session binding is invalid");
      if (!/^[0-9a-f-]{36}$/i.test(request.requestId)) throw new Error("Provider egress request ID is invalid");
      if (!providerIds.has(request.providerId)) throw new Error("Provider egress is disabled for this ACP provider instance");
      const requestKey = `${request.sessionId}:${request.requestId}`;
      if (activeRequests.has(requestKey)) throw new Error("Provider egress request ID is already active");
      const requestController = new AbortController();
      activeRequests.set(requestKey, requestController);
      try {
      const hostname = PROVIDER_HOSTS[request.providerId];
      if (!hostname) throw new Error("Pi provider is not supported by managed model egress");
      const url = new URL(request.url);
      if (url.protocol !== "https:" || url.hostname !== hostname || url.port !== "" || url.username || url.password || url.hash) {
        throw new Error("Provider request is outside the managed egress allowlist");
      }
      if (request.method !== "POST" || !allowedInferencePath(request.providerId, url.pathname)) {
        throw new Error("Provider request is not an approved inference endpoint");
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        const lower = key.toLowerCase();
        if (/[\r\n]/.test(value) || lower === "host" || lower === "connection" || lower === "content-length" || lower.startsWith("proxy-")) {
          throw new Error("Provider request contains an unsupported header");
        }
        headers[lower] = value;
      }
      if (Object.keys(headers).length > 64 || Object.entries(headers).reduce((size, [key, value]) => size + key.length + value.length, 0) > 64 * 1024) {
        throw new Error("Provider request headers exceeded the egress size limit");
      }
      delete headers["accept-encoding"];
      if (request.body !== undefined && request.body.length > Math.ceil(MAX_REQUEST_BYTES * 4 / 3) + 4) {
        throw new Error("Provider request body exceeded the egress size limit");
      }
      if (request.body !== undefined && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.body)) {
        throw new Error("Provider request body is invalid");
      }
      const body = request.body === undefined ? undefined : Buffer.from(request.body, "base64");
      if (body && body.byteLength > MAX_REQUEST_BYTES) throw new Error("Provider request body exceeded the egress size limit");
      const requestSignal = AbortSignal.any([signal, requestController.signal]);
      const address = await (input.resolveAddress ?? resolvePublicIpv4)(hostname);
      if (requestSignal.aborted) throw requestSignal.reason ?? new Error("Provider request was aborted");
      return await (input.requestProvider ?? requestProvider)(hostname, address, request.method, `${url.pathname}${url.search}`, headers, body, requestSignal);
      } finally {
        activeRequests.delete(requestKey);
      }
      },
      catch: (cause) => AcpErrors.AcpRequestError.internalError("Managed Pi provider request failed", undefined, { cause }),
    });
    }));
    yield* input.context.runtime.handleExtNotification(CANCEL_METHOD, CancelRequest, (request) => Effect.gen(function* () {
      const activeSessionId = yield* input.context.activeSessionId;
      if (request.sessionId !== activeSessionId || !/^[0-9a-f-]{36}$/i.test(request.requestId)) return;
      activeRequests.get(`${request.sessionId}:${request.requestId}`)?.abort(new Error("Provider request was cancelled"));
    }));
  });
}

export const managedModelEgressMethod = METHOD;
export const managedCancelMethod = CANCEL_METHOD;
export const managedModelProviderHosts = PROVIDER_HOSTS;
