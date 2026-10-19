// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - This transport pins Node HTTP requests to validated DNS addresses.
// Adapted from pi-subpolar's @subpolar-agent/server/core/network-policy.ts.
import { resolve4, resolve6 } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";

export type NetworkPolicyOptions = {
  allowPrivateHosts?: boolean;
  allowLoopback?: boolean;
  allowLocalhost?: boolean;
  allowedHosts?: readonly string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
};

export const DEFAULT_NETWORK_POLICY: Required<
  Pick<NetworkPolicyOptions, "timeoutMs" | "maxResponseBytes" | "maxRedirects">
> = {
  timeoutMs: 15_000,
  maxResponseBytes: 4 * 1024 * 1024,
  maxRedirects: 3,
};

export class NetworkPolicyError extends Error {
  readonly code:
    | "INVALID_URL"
    | "PRIVATE_HOST"
    | "UNTRUSTED_HOSTNAME"
    | "DNS_RESOLUTION_FAILED"
    | "REDIRECT_BLOCKED"
    | "TIMEOUT"
    | "RESPONSE_TOO_LARGE";

  constructor(
    code:
      | "INVALID_URL"
      | "PRIVATE_HOST"
      | "UNTRUSTED_HOSTNAME"
      | "DNS_RESOLUTION_FAILED"
      | "REDIRECT_BLOCKED"
      | "TIMEOUT"
      | "RESPONSE_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "NetworkPolicyError";
    this.code = code;
  }
}

function ipv4Private(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  const [a, b, c] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 2 || b === 168)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 31) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6Value(hostname: string): bigint | null {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    if (separator < 0) return null;
    const ipv4 = value
      .slice(separator + 1)
      .split(".")
      .map(Number);
    if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
      return null;
    const high = ((ipv4[0]! << 8) | ipv4[1]!).toString(16);
    const low = ((ipv4[2]! << 8) | ipv4[3]!).toString(16);
    return ipv6Value(`${value.slice(0, separator)}:${high}:${low}`);
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (left.concat(right).some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  return groups.reduce((result, part) => (result << 16n) | BigInt(`0x${part}`), 0n);
}

function ipv6Private(hostname: string): boolean {
  const value = ipv6Value(hostname);
  if (value === null) return false;
  const range = (prefix: bigint, bits: number) => value >> BigInt(128 - bits) === prefix;
  return (
    value === 0n ||
    value === 1n ||
    range(0xffn, 8) || // multicast
    range(0x3fbn, 10) || // deprecated site-local
    range(0x7en, 7) || // fc00::/7 ULA
    range(0x3fan, 10) || // fe80::/10 link-local
    range(0x20010db8n, 32) || // documentation
    range(0x20010002n, 32) || // benchmarking
    range(0x1n, 8) || // 0100::/8 discard-only / reserved
    (value >> 32n === 0xffffn &&
      ipv4Private(
        `${Number((value >> 24n) & 255n)}.${Number((value >> 16n) & 255n)}.${Number((value >> 8n) & 255n)}.${Number(value & 255n)}`,
      ))
  );
}

export function isPrivateHost(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/\.$/, "");
  return (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local") ||
    value.endsWith(".internal") ||
    value === "nip.io" ||
    value.endsWith(".nip.io") ||
    value === "sslip.io" ||
    value.endsWith(".sslip.io") ||
    value === "localtest.me" ||
    value.endsWith(".localtest.me") ||
    value === "lvh.me" ||
    value.endsWith(".lvh.me") ||
    ipv4Private(value) ||
    (value.includes(":") && ipv6Private(value))
  );
}

export function validateHttpUrl(value: string | URL, policy: NetworkPolicyOptions = {}): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new NetworkPolicyError("INVALID_URL", "Only valid HTTP(S) URLs are allowed");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new NetworkPolicyError("INVALID_URL", "Only http and https URLs are allowed");
  if (url.username || url.password)
    throw new NetworkPolicyError("INVALID_URL", "URLs with embedded credentials are not allowed");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const allowed = (policy.allowedHosts ?? []).some(
    (candidate) => candidate.toLowerCase().replace(/\.$/, "") === hostname,
  );
  const localhost = hostname === "localhost" || hostname.endsWith(".localhost");
  const privateHost = isPrivateHost(hostname);
  const loopback =
    hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" || localhost;
  if (
    privateHost &&
    !policy.allowPrivateHosts &&
    !(loopback && (policy.allowLoopback || policy.allowLocalhost))
  ) {
    throw new NetworkPolicyError(
      "PRIVATE_HOST",
      `Network access to private host ${hostname} is not allowed`,
    );
  }
  const normalizedHostname = hostname.replace(/^\[|\]$/g, "");
  if (
    !allowed &&
    !isIP(normalizedHostname) &&
    !(privateHost && (policy.allowPrivateHosts || policy.allowLoopback || policy.allowLocalhost))
  ) {
    throw new NetworkPolicyError(
      "UNTRUSTED_HOSTNAME",
      `Hostname ${hostname} is not in the trusted network allowlist`,
    );
  }
  return url;
}

function validateResolvedAddresses(
  addresses: readonly string[],
  policy: NetworkPolicyOptions,
): void {
  if (policy.allowPrivateHosts) return;
  for (const address of addresses) {
    const blocked =
      isIP(address) === 4 ? ipv4Private(address) : isIP(address) === 6 && ipv6Private(address);
    if (blocked && !(policy.allowLoopback && (address === "127.0.0.1" || address === "::1"))) {
      throw new NetworkPolicyError(
        "PRIVATE_HOST",
        `Network access to private address ${address} is not allowed`,
      );
    }
  }
}

export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

type PinnedTarget = { url: URL; address: string };

async function resolvePinnedTarget(
  value: string | URL,
  policy: NetworkPolicyOptions,
  resolver: DnsResolver,
): Promise<PinnedTarget> {
  const url = validateHttpUrl(value, policy);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) return { url, address: hostname };
  const addresses = await resolver(hostname);
  if (addresses.length === 0)
    throw new NetworkPolicyError("DNS_RESOLUTION_FAILED", `DNS resolution failed for ${hostname}`);
  validateResolvedAddresses(addresses, policy);
  const address = addresses.find((candidate) => isIP(candidate) !== 0);
  if (!address)
    throw new NetworkPolicyError(
      "DNS_RESOLUTION_FAILED",
      `DNS resolution did not return an IP address for ${hostname}`,
    );
  return { url, address };
}

export async function resolveAndValidateHttpUrl(
  value: string | URL,
  policy: NetworkPolicyOptions = {},
  resolver: DnsResolver = resolveHostAddresses,
): Promise<URL> {
  return (await resolvePinnedTarget(value, policy, resolver)).url;
}

async function resolveHostAddresses(hostname: string): Promise<readonly string[]> {
  const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  const addresses = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (addresses.length === 0)
    throw new NetworkPolicyError("DNS_RESOLUTION_FAILED", `DNS resolution failed for ${hostname}`);
  return addresses;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new NetworkPolicyError("TIMEOUT", `Network request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function boundedHeaders(init: RequestInit | undefined): Headers {
  const headers = new Headers(init?.headers);
  // Cookies and proxy credentials are never sent by outbound tool requests.
  headers.delete("cookie");
  headers.delete("proxy-authorization");
  return headers;
}

const CREDENTIAL_HEADER =
  /(?:^|[-_])(?:authorization|authentication|auth|access[-_]?token|token|api[-_]?key|apikey|proxy|cookie|secret|password|credential|session(?:[-_]?id)?|csrf(?:[-_]?token)?|jwt|signature|private[-_]?key|bearer)(?:$|[-_])/i;

function redirectHeaders(headers: Headers): Headers {
  const result = new Headers();
  for (const [name, value] of headers) if (!CREDENTIAL_HEADER.test(name)) result.set(name, value);
  return result;
}

function redirectedMethod(status: number, method: string): string {
  return status === 301 || status === 302 || status === 303
    ? method === "GET" || method === "HEAD"
      ? method
      : "GET"
    : method;
}

async function requestBodyBytes(body: RequestInit["body"]): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return new Uint8Array(await new Response(body as never).arrayBuffer());
}

function limitedResponse(response: Response, maxResponseBytes: number): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let size = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        size += next.value.byteLength;
        if (size > maxResponseBytes) {
          await reader.cancel();
          controller.error(
            new NetworkPolicyError(
              "RESPONSE_TOO_LARGE",
              `Network response exceeds ${maxResponseBytes} bytes`,
            ),
          );
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function pinnedRequest(
  target: PinnedTarget,
  headers: Headers,
  method: string,
  body: Uint8Array | undefined,
  policy: NetworkPolicyOptions,
  signal: AbortSignal,
): Promise<Response> {
  const resolved = target;
  if (signal.aborted)
    throw new NetworkPolicyError(
      "TIMEOUT",
      `Network request timed out after ${policy.timeoutMs}ms`,
    );
  const requestHeaders = Object.fromEntries(headers.entries());
  // Connect to the validated address while retaining the URL host for virtual
  // hosting and TLS certificate selection. There is no fallback to hostname
  // resolution after this point.
  requestHeaders.host = resolved.url.host;
  const requestOptions = {
    protocol: resolved.url.protocol,
    hostname: resolved.address,
    port: resolved.url.port || undefined,
    method,
    path: `${resolved.url.pathname}${resolved.url.search}`,
    headers: requestHeaders,
    ...(resolved.url.protocol === "https:"
      ? { servername: resolved.url.hostname.replace(/^\[|\]$/g, "") }
      : {}),
  };
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(
        signal.aborted
          ? new NetworkPolicyError(
              "TIMEOUT",
              `Network request timed out after ${policy.timeoutMs}ms`,
            )
          : error,
      );
    };
    const onResponse = (incoming: http.IncomingMessage) => {
      const length = Number(incoming.headers["content-length"]);
      if (
        Number.isFinite(length) &&
        length > (policy.maxResponseBytes ?? DEFAULT_NETWORK_POLICY.maxResponseBytes)
      ) {
        request.destroy();
        fail(
          new NetworkPolicyError(
            "RESPONSE_TOO_LARGE",
            `Network response exceeds ${policy.maxResponseBytes} bytes`,
          ),
        );
        return;
      }
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined)
          responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const responseBody = new ReadableStream<Uint8Array>({
        start(controller) {
          incoming.on("data", (chunk: Buffer | string) => {
            controller.enqueue(
              typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk),
            );
          });
          incoming.on("end", () => controller.close());
          incoming.on("error", (error) => controller.error(error));
        },
        cancel(reason) {
          incoming.destroy(reason instanceof Error ? reason : undefined);
        },
      });
      settled = true;
      resolve(
        new Response(responseBody, {
          status: incoming.statusCode ?? 0,
          statusText: incoming.statusMessage ?? "",
          headers: responseHeaders,
        }),
      );
    };
    const request =
      resolved.url.protocol === "https:"
        ? https.request(requestOptions as https.RequestOptions, onResponse)
        : http.request(requestOptions as http.RequestOptions, onResponse);
    const abort = () => {
      request.destroy();
      fail(
        new NetworkPolicyError("TIMEOUT", `Network request timed out after ${policy.timeoutMs}ms`),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    request.setTimeout(policy.timeoutMs ?? DEFAULT_NETWORK_POLICY.timeoutMs, abort);
    request.on("error", fail);
    request.on("close", () => signal.removeEventListener("abort", abort));
    if (body) request.write(body);
    request.end();
  });
}

export async function fetchWithNetworkPolicy(
  input: string | URL,
  init: RequestInit = {},
  policy: NetworkPolicyOptions = {},
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>,
  resolver: DnsResolver = resolveHostAddresses,
): Promise<Response> {
  const timeoutMs = policy.timeoutMs ?? DEFAULT_NETWORK_POLICY.timeoutMs;
  const maxRedirects = policy.maxRedirects ?? DEFAULT_NETWORK_POLICY.maxRedirects;
  const maxResponseBytes = policy.maxResponseBytes ?? DEFAULT_NETWORK_POLICY.maxResponseBytes;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isInteger(maxRedirects) ||
    maxRedirects < 0 ||
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes <= 0
  )
    throw new RangeError("Invalid network policy limits");
  let url: URL;
  let method = (init.method ?? "GET").toUpperCase();
  const requestBody = await requestBodyBytes(init.body);
  let currentBody = requestBody;
  let headers = boundedHeaders(init);
  const injectedFetch = Boolean(fetchImpl && fetchImpl !== globalThis.fetch);
  let target: PinnedTarget | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    if (injectedFetch)
      url = await withTimeout(resolveAndValidateHttpUrl(input, policy, resolver), timeoutMs);
    else {
      target = await withTimeout(resolvePinnedTarget(input, policy, resolver), timeoutMs);
      url = target.url;
    }
    for (let redirect = 0; ; redirect += 1) {
      let response: Response;
      try {
        const requestInit: RequestInit = {
          ...init,
          method,
          ...(currentBody === undefined
            ? {}
            : { body: currentBody as NonNullable<RequestInit["body"]> }),
          headers,
          redirect: "manual",
          credentials: "omit",
          signal: controller.signal,
        };
        response = injectedFetch
          ? await fetchImpl!(url, requestInit)
          : await pinnedRequest(
              target!,
              headers,
              method,
              currentBody,
              { ...policy, timeoutMs, maxResponseBytes },
              controller.signal,
            );
      } catch (error) {
        if (controller.signal.aborted)
          throw new NetworkPolicyError("TIMEOUT", `Network request timed out after ${timeoutMs}ms`);
        throw error;
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        const length = Number(response.headers.get("content-length"));
        if (Number.isFinite(length) && length > maxResponseBytes)
          throw new NetworkPolicyError(
            "RESPONSE_TOO_LARGE",
            `Network response exceeds ${maxResponseBytes} bytes`,
          );
        return limitedResponse(response, maxResponseBytes);
      }
      if (redirect >= maxRedirects)
        throw new NetworkPolicyError("REDIRECT_BLOCKED", "Network redirect limit exceeded");
      const location = response.headers.get("location");
      if (!location)
        throw new NetworkPolicyError(
          "REDIRECT_BLOCKED",
          "Network redirect did not provide a location",
        );
      await response.body?.cancel();
      let redirectUrl: URL;
      try {
        redirectUrl = new URL(location, url);
      } catch {
        throw new NetworkPolicyError("INVALID_URL", "Network redirect location is not a valid URL");
      }
      if (injectedFetch)
        url = await withTimeout(
          resolveAndValidateHttpUrl(redirectUrl, policy, resolver),
          timeoutMs,
        );
      else {
        target = await withTimeout(resolvePinnedTarget(redirectUrl, policy, resolver), timeoutMs);
        url = target.url;
      }
      method = redirectedMethod(response.status, method);
      if (method === "GET" || method === "HEAD") currentBody = undefined;
      headers = redirectHeaders(headers);
      if (method === "GET" || method === "HEAD") headers.delete("content-length");
    }
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}

export async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0)
    throw new RangeError("maxBytes must be a positive integer");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes)
        throw new NetworkPolicyError(
          "RESPONSE_TOO_LARGE",
          `Network response exceeds ${maxBytes} bytes`,
        );
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
}

export function networkPolicyFromMetadata(
  value: Record<string, unknown> | undefined,
): NetworkPolicyOptions {
  // Host exemptions are server policy, never tool registration metadata. DNS
  // answers are checked by fetchWithNetworkPolicy for every request target.
  const nested =
    value?.mcp && typeof value.mcp === "object" && !Array.isArray(value.mcp)
      ? (value.mcp as Record<string, unknown>)
      : {};
  const policy =
    nested.networkPolicy &&
    typeof nested.networkPolicy === "object" &&
    !Array.isArray(nested.networkPolicy)
      ? (nested.networkPolicy as Record<string, unknown>)
      : value?.networkPolicy &&
          typeof value.networkPolicy === "object" &&
          !Array.isArray(value.networkPolicy)
        ? (value.networkPolicy as Record<string, unknown>)
        : (value ?? {});
  const trusted = trustedNetworkPolicy();
  return {
    ...trusted,
    ...(typeof policy.timeoutMs === "number" ? { timeoutMs: policy.timeoutMs } : {}),
    ...(typeof policy.maxResponseBytes === "number"
      ? { maxResponseBytes: policy.maxResponseBytes }
      : {}),
    ...(typeof policy.maxRedirects === "number" ? { maxRedirects: policy.maxRedirects } : {}),
  };
}

export function trustedNetworkPolicy(): NetworkPolicyOptions {
  const allowedHosts = (process.env.SUBPOLAR_NETWORK_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    ...(process.env.SUBPOLAR_NETWORK_ALLOW_PRIVATE_HOSTS === "true"
      ? { allowPrivateHosts: true }
      : {}),
    ...(process.env.SUBPOLAR_NETWORK_ALLOW_LOOPBACK === "true" ? { allowLoopback: true } : {}),
    ...(process.env.SUBPOLAR_NETWORK_ALLOW_LOCALHOST === "true" ? { allowLocalhost: true } : {}),
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
  };
}
