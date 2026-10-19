// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - MCP transports run at the standalone Node boundary.
// Adapted from pi-subpolar's @subpolar-agent/server/application/tools/mcp-adapter.ts.
// Keep this transport boundary local so T3 can apply stricter network policy.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { fetchWithNetworkPolicy, networkPolicyFromMetadata, NetworkPolicyError, validateHttpUrl, type NetworkPolicyOptions } from './networkPolicy.ts'
import { redactSensitiveText } from './securityRedaction.ts'

export type JsonRpcId = string | number

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcResponse = {
  jsonrpc: '2.0'
  id?: JsonRpcId | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type McpTransportKind = 'stdio' | 'http' | 'sse'

export type McpHeaderValue = string | { env: string }

export type McpLimits = {
  requestTimeoutMs: number
  maxRequestTimeoutMs: number
  maxTools: number
  maxListPages: number
  maxInputBytes: number
  maxResponseBytes: number
  maxLineBytes: number
  maxStderrBytes: number
}

export type McpServerConfig = {
  /** Trusted composition scope, never taken from tool metadata. Unscoped connections are not reused. */
  ownerId?: string
  transport: McpTransportKind
  /** URL for HTTP/SSE transports. */
  url?: string
  /** Executable for stdio transport. `target` from a tool definition is also accepted by the resolver. */
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string | { env: string }>
  headers?: Record<string, McpHeaderValue>
  namespace?: string
  serverKey?: string
  protocolVersion?: string
  clientName?: string
  clientVersion?: string
  timeoutMs?: number
  networkPolicy?: NetworkPolicyOptions
  limits?: Partial<McpLimits>
}

export type McpClientOptions = {
  fetch?: typeof globalThis.fetch
  limits?: Partial<McpLimits>
  clientName?: string
  clientVersion?: string
}

export type McpTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: Record<string, unknown>
  namespace?: string
  toolId: string
  raw: Record<string, unknown>
}

export type McpCallResult = {
  content: unknown[]
  isError: boolean
  structuredContent?: unknown
  raw: Record<string, unknown>
}

export type McpToolReference = {
  owner_id?: string
  tool_id: string
  namespace: string
  description?: string
  target: string
  operation: string
  metadata?: Record<string, unknown>
}

export type McpToolRegistryDefinition = {
  tool_id: string
  namespace: string
  description: string
  adapter: 'mcp'
  target: string
  operation: string
  input_schema: Record<string, unknown>
  output_schema: Record<string, unknown>
  risk: 'read' | 'write' | 'delete' | 'external'
  requires_approval: boolean
  enabled: boolean
  metadata: Record<string, unknown>
}

export type McpErrorCode =
  | 'MCP_CONFIGURATION_ERROR'
  | 'MCP_CONNECTION_ERROR'
  | 'MCP_TIMEOUT'
  | 'MCP_PROTOCOL_ERROR'
  | 'MCP_REMOTE_ERROR'
  | 'MCP_TOOL_ERROR'
  | 'MCP_LIMIT_EXCEEDED'

export class McpAdapterError extends Error {
  readonly code: McpErrorCode
  readonly method: string | undefined
  readonly serverKey: string | undefined
  override readonly cause: unknown

  constructor(code: McpErrorCode, message: string, options: { method?: string | undefined; serverKey?: string | undefined; cause?: unknown } = {}) {
    super(message)
    this.name = 'McpAdapterError'
    this.code = code
    this.method = options.method
    this.serverKey = options.serverKey
    this.cause = options.cause instanceof Error ? redactSensitiveText(options.cause.message) : undefined
  }
}

export interface McpTransport {
  readonly kind: McpTransportKind
  start(): Promise<void>
  request(request: JsonRpcRequest, timeoutMs: number): Promise<JsonRpcResponse>
  notify(method: string, params?: Record<string, unknown>): Promise<void>
  close(): Promise<void>
}

export type McpTransportFactory = (config: McpServerConfig) => McpTransport

export type NormalizeMcpToolsOptions = {
  namespace?: string
  maxTools?: number
  maxNameLength?: number
  maxDescriptionLength?: number
  maxSchemaBytes?: number
}

export type CreateMcpAdapterOptions = McpClientOptions & {
  transportFactory?: McpTransportFactory
  defaults?: Partial<McpServerConfig>
}

const DEFAULT_LIMITS: McpLimits = {
  requestTimeoutMs: 30_000,
  maxRequestTimeoutMs: 5 * 60_000,
  maxTools: 500,
  maxListPages: 100,
  maxInputBytes: 1 * 1024 * 1024,
  maxResponseBytes: 4 * 1024 * 1024,
  maxLineBytes: 4 * 1024 * 1024,
  maxStderrBytes: 16 * 1024,
}

const DEFAULT_PROTOCOL_VERSION = '2026-07-28'
const MODERN_PROTOCOL_VERSION = DEFAULT_PROTOCOL_VERSION
const JSON_RPC_VERSION = '2.0' as const
const MCP_META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
const MCP_META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
const MCP_META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'

function encodeMcpHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value) && value === value.trim() && !(/^=\?base64\?.*\?=$/.test(value))) return value
  return `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

type RecordValue = Record<string, unknown>

type PendingRequest = {
  resolve: (response: JsonRpcResponse) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

function object(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}

const MCP_NAME = /^[a-z][a-z0-9._-]{0,127}$/

function validateMcpSchema(value: unknown, label: string, limit: number): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new McpAdapterError('MCP_PROTOCOL_ERROR', `${label} must be a JSON object`, { method: 'tools/list' })
  jsonBytes(value, label, limit)
  return value as RecordValue
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function limitsFor(value: Partial<McpLimits> | undefined): McpLimits {
  const merged = { ...DEFAULT_LIMITS, ...(value ?? {}) }
  const limits: McpLimits = {
    requestTimeoutMs: positiveInteger(merged.requestTimeoutMs, DEFAULT_LIMITS.requestTimeoutMs),
    maxRequestTimeoutMs: positiveInteger(merged.maxRequestTimeoutMs, DEFAULT_LIMITS.maxRequestTimeoutMs),
    maxTools: positiveInteger(merged.maxTools, DEFAULT_LIMITS.maxTools),
    maxListPages: positiveInteger(merged.maxListPages, DEFAULT_LIMITS.maxListPages),
    maxInputBytes: positiveInteger(merged.maxInputBytes, DEFAULT_LIMITS.maxInputBytes),
    maxResponseBytes: positiveInteger(merged.maxResponseBytes, DEFAULT_LIMITS.maxResponseBytes),
    maxLineBytes: positiveInteger(merged.maxLineBytes, DEFAULT_LIMITS.maxLineBytes),
    maxStderrBytes: positiveInteger(merged.maxStderrBytes, DEFAULT_LIMITS.maxStderrBytes),
  }
  if (limits.maxRequestTimeoutMs < limits.requestTimeoutMs) limits.maxRequestTimeoutMs = limits.requestTimeoutMs
  return limits
}

function serverKeyFor(config: McpServerConfig): string {
  if (config.serverKey?.trim()) return config.serverKey.trim()
  return config.transport === 'stdio'
    ? `stdio:${config.command ?? ''}:${(config.args ?? []).join('\u0000')}`
    : `${config.transport}:${config.url ?? ''}`
}

function jsonBytes(value: unknown, label: string, limit: number): number {
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch (error) {
    throw new McpAdapterError('MCP_PROTOCOL_ERROR', `${label} is not JSON serializable`, { cause: error })
  }
  if (encoded === undefined) throw new McpAdapterError('MCP_PROTOCOL_ERROR', `${label} must be JSON serializable`)
  const bytes = new TextEncoder().encode(encoded).byteLength
  if (bytes > limit) throw new McpAdapterError('MCP_LIMIT_EXCEEDED', `${label} is ${bytes} bytes; the limit is ${limit} bytes`)
  return bytes
}

function responseError(response: JsonRpcResponse, method: string, serverKey?: string): never | undefined {
  if (!response.error) return undefined
  const detail = response.error.data === undefined ? '' : ` (${redactSensitiveText(summarize(response.error.data))})`
  throw new McpAdapterError('MCP_REMOTE_ERROR', `MCP ${method} failed with ${response.error.code}: ${redactSensitiveText(response.error.message)}${detail}`, { method, serverKey })
}

function summarize(value: unknown): string {
  let text: string
  try { text = JSON.stringify(value) } catch { text = String(value) }
  return text.length > 500 ? `${text.slice(0, 497)}...` : text
}

function responseResult(response: JsonRpcResponse, method: string, serverKey?: string): unknown {
  responseError(response, method, serverKey)
  if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
    throw new McpAdapterError('MCP_PROTOCOL_ERROR', `MCP ${method} response did not contain a result`, { method, serverKey })
  }
  return response.result
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  const record = object(value)
  return record.jsonrpc === JSON_RPC_VERSION && (typeof record.id === 'string' || typeof record.id === 'number' || record.id === null || record.id === undefined) && (Object.prototype.hasOwnProperty.call(record, 'result') || Object.prototype.hasOwnProperty.call(record, 'error'))
}

function timeoutFor(value: number | undefined, limits: McpLimits): number {
  const timeout = value ?? limits.requestTimeoutMs
  if (!Number.isInteger(timeout) || timeout <= 0) throw new McpAdapterError('MCP_CONFIGURATION_ERROR', `Timeout must be a positive integer; received ${String(timeout)}`)
  if (timeout > limits.maxRequestTimeoutMs) throw new McpAdapterError('MCP_LIMIT_EXCEEDED', `Timeout ${timeout}ms exceeds the configured maximum of ${limits.maxRequestTimeoutMs}ms`)
  return timeout
}

function errorForTransport(error: unknown, message: string, config: McpServerConfig): McpAdapterError {
  if (error instanceof McpAdapterError) return error
  return new McpAdapterError('MCP_CONNECTION_ERROR', redactSensitiveText(`${message}: ${error instanceof Error ? error.message : String(error)}`), { serverKey: serverKeyFor(config), cause: error })
}

function resolveEnvValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const record = object(value)
  return typeof record.env === 'string' ? process.env[record.env] : undefined
}

function resolveHeaders(headers: Record<string, McpHeaderValue> | undefined): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    const result = resolveEnvValue(value)
    if (result !== undefined) resolved[name] = result
  }
  return resolved
}

function makeRequest(id: JsonRpcId, method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return params === undefined ? { jsonrpc: JSON_RPC_VERSION, id, method } : { jsonrpc: JSON_RPC_VERSION, id, method, params }
}

export class StdioMcpTransport implements McpTransport {
  readonly kind = 'stdio' as const
  private readonly config: McpServerConfig
  private readonly limits: McpLimits
  private child: ChildProcessWithoutNullStreams | undefined
  private buffer = ''
  private stderr = ''
  private readonly pending = new Map<string, PendingRequest>()
  private started = false
  private closed = false

  constructor(config: McpServerConfig, limits: Partial<McpLimits> = {}) {
    this.config = config
    this.limits = limitsFor({ ...config.limits, ...limits })
  }

  async start(): Promise<void> {
    if (this.started && !this.closed) return
    const command = nonEmptyString(this.config.command)
    if (!command) throw new McpAdapterError('MCP_CONFIGURATION_ERROR', 'stdio MCP transport requires a command', { serverKey: serverKeyFor(this.config) })
    this.closed = false
    this.started = true
    try {
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
      for (const [key, value] of Object.entries(this.config.env ?? {})) {
        const resolved = resolveEnvValue(value)
        if (resolved !== undefined) env[key] = resolved
      }
      this.child = spawn(command, this.config.args ?? [], { cwd: this.config.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
      this.child.stdout.on('data', (chunk: Uint8Array | string) => this.onStdout(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)) )
      this.child.stderr.on('data', (chunk: Uint8Array | string) => {
        this.stderr = `${this.stderr}${typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)}`
        if (new TextEncoder().encode(this.stderr).byteLength > this.limits.maxStderrBytes) this.stderr = this.stderr.slice(-this.limits.maxStderrBytes)
      })
      this.child.once('error', (error) => this.fail(new McpAdapterError('MCP_CONNECTION_ERROR', redactSensitiveText(`MCP stdio process failed: ${error.message}`), { serverKey: serverKeyFor(this.config), cause: error })))
      this.child.once('exit', (code, signal) => {
        if (!this.closed) {
          const suffix = this.stderr.trim() ? `: ${this.stderr.trim().slice(0, 500)}` : ''
          this.fail(new McpAdapterError('MCP_CONNECTION_ERROR', `MCP stdio process exited (${signal ?? `code ${String(code)}`})${suffix}`, { serverKey: serverKeyFor(this.config) }))
        }
      })
    } catch (error) {
      this.started = false
      throw errorForTransport(error, 'Could not start MCP stdio process', this.config)
    }
  }

  async request(request: JsonRpcRequest, timeoutMs: number): Promise<JsonRpcResponse> {
    await this.start()
    if (!this.child || this.closed) throw new McpAdapterError('MCP_CONNECTION_ERROR', 'MCP stdio transport is closed', { serverKey: serverKeyFor(this.config) })
    jsonBytes(request, 'MCP request', this.limits.maxInputBytes)
    const id = String(request.id)
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpAdapterError('MCP_TIMEOUT', `MCP ${request.method} timed out after ${timeoutMs}ms`, { method: request.method, serverKey: serverKeyFor(this.config) }))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child?.stdin.write(`${JSON.stringify(request)}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(errorForTransport(error, `Could not send MCP ${request.method} request`, this.config))
      }
    })
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.start()
    if (!this.child || this.closed) throw new McpAdapterError('MCP_CONNECTION_ERROR', 'MCP stdio transport is closed', { serverKey: serverKeyFor(this.config) })
    const notification = params === undefined ? { jsonrpc: JSON_RPC_VERSION, method } : { jsonrpc: JSON_RPC_VERSION, method, params }
    jsonBytes(notification, 'MCP notification', this.limits.maxInputBytes)
    try { this.child.stdin.write(`${JSON.stringify(notification)}\n`) } catch (error) { throw errorForTransport(error, `Could not send MCP ${method} notification`, this.config) }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.fail(new McpAdapterError('MCP_CONNECTION_ERROR', 'MCP stdio transport was closed', { serverKey: serverKeyFor(this.config) }))
    this.child?.kill()
    this.child = undefined
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (new TextEncoder().encode(line).byteLength > this.limits.maxLineBytes) {
        this.fail(new McpAdapterError('MCP_LIMIT_EXCEEDED', `MCP stdio message exceeded ${this.limits.maxLineBytes} bytes`, { serverKey: serverKeyFor(this.config) }))
        return
      }
      if (line.trim()) this.onLine(line)
      newline = this.buffer.indexOf('\n')
    }
    if (new TextEncoder().encode(this.buffer).byteLength > this.limits.maxLineBytes) this.fail(new McpAdapterError('MCP_LIMIT_EXCEEDED', `MCP stdio message exceeded ${this.limits.maxLineBytes} bytes`, { serverKey: serverKeyFor(this.config) }))
  }

  private onLine(line: string): void {
    let value: unknown
    try { value = JSON.parse(line) } catch (error) {
      this.fail(new McpAdapterError('MCP_PROTOCOL_ERROR', `MCP stdio returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { serverKey: serverKeyFor(this.config), cause: error }))
      return
    }
    if (!isJsonRpcResponse(value)) return
    const id = value.id === null || value.id === undefined ? '' : String(value.id)
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(value)
  }

  private fail(error: unknown): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(error)
    }
  }
}

type SseEvent = { event: string; data: string }

type PendingSseRequest = PendingRequest

export class HttpMcpTransport implements McpTransport {
  readonly kind: 'http' | 'sse'
  private readonly config: McpServerConfig
  private readonly limits: McpLimits
  private readonly fetchImpl: typeof globalThis.fetch | undefined
  private readonly pending = new Map<string, PendingSseRequest>()
  private readonly streamAbort = new AbortController()
  private endpoint?: URL
  private endpointResolve?: (url: URL) => void
  private endpointReject?: (error: unknown) => void
  private sessionId?: string
  private cancelEventStream: (() => Promise<void>) | undefined
  private started = false
  private closed = false

  constructor(config: McpServerConfig, options: McpClientOptions = {}) {
    this.kind = config.transport === 'sse' ? 'sse' : 'http'
    this.config = config
    this.limits = limitsFor({ ...config.limits, ...(options.limits ?? {}) })
    this.fetchImpl = options.fetch
    if (!this.fetchImpl && !globalThis.fetch) throw new McpAdapterError('MCP_CONFIGURATION_ERROR', 'A fetch implementation is required for HTTP/SSE MCP transport', { serverKey: serverKeyFor(config) })
  }

  async start(): Promise<void> {
    if (this.started && !this.closed) return
    if (this.config.transport === 'sse' && (this.config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION) === MODERN_PROTOCOL_VERSION) {
      throw new McpAdapterError('MCP_CONFIGURATION_ERROR', 'The 2026-07-28 protocol does not support the legacy HTTP+SSE transport', { serverKey: serverKeyFor(this.config) })
    }
    const rawUrl = nonEmptyString(this.config.url)
    if (!rawUrl) throw new McpAdapterError('MCP_CONFIGURATION_ERROR', `${this.kind} MCP transport requires a URL`, { serverKey: serverKeyFor(this.config) })
    let url: URL
    try { url = new URL(rawUrl) } catch (error) { throw new McpAdapterError('MCP_CONFIGURATION_ERROR', `Invalid MCP URL: ${redactSensitiveText(rawUrl)}`, { serverKey: serverKeyFor(this.config), cause: error }) }
    this.closed = false
    this.started = true
    if (this.kind === 'http') {
      this.endpoint = url
      return
    }
    const endpointPromise = new Promise<URL>((resolve, reject) => {
      this.endpointResolve = resolve
      this.endpointReject = reject
    })
    try {
      const response = await fetchWithNetworkPolicy(url, { headers: this.requestHeaders('text/event-stream'), signal: this.streamAbort.signal }, { ...this.config.networkPolicy, timeoutMs: this.limits.requestTimeoutMs }, this.fetchImpl)
      if (!response.ok) throw new McpAdapterError('MCP_CONNECTION_ERROR', `MCP SSE endpoint returned HTTP ${response.status}`, { serverKey: serverKeyFor(this.config) })
      if (!response.body) throw new McpAdapterError('MCP_PROTOCOL_ERROR', 'MCP SSE endpoint returned no response body', { serverKey: serverKeyFor(this.config) })
      const session = response.headers.get('mcp-session-id')
      if ((this.config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION) !== MODERN_PROTOCOL_VERSION && session) this.sessionId = session
      void this.consumeSse(response.body).catch((error: unknown) => {
        const normalized = errorForTransport(error, 'MCP SSE stream failed', this.config)
        this.endpointReject?.(normalized)
        this.fail(normalized)
      })
      await this.withTimeout(endpointPromise, this.limits.requestTimeoutMs, 'MCP SSE endpoint announcement')
    } catch (error) {
      this.endpointReject?.(error)
      if (error instanceof DOMException && error.name === 'AbortError') throw new McpAdapterError('MCP_TIMEOUT', `MCP SSE connection timed out after ${this.limits.requestTimeoutMs}ms`, { serverKey: serverKeyFor(this.config) })
      throw errorForTransport(error, 'Could not connect to MCP SSE endpoint', this.config)
    }
  }

  async request(request: JsonRpcRequest, timeoutMs: number): Promise<JsonRpcResponse> {
    await this.start()
    if (!this.endpoint || this.closed) throw new McpAdapterError('MCP_CONNECTION_ERROR', `MCP ${this.kind} transport is closed`, { serverKey: serverKeyFor(this.config) })
    jsonBytes(request, 'MCP request', this.limits.maxInputBytes)
    const pending = this.expect(request.id, request.method, timeoutMs)
    // The network request is awaited before `pending` below; handle early protocol/timeout
    // failures immediately so rejected pending RPCs do not surface as unhandled rejections.
    void pending.catch(() => undefined)
    try {
      const response = await fetchWithNetworkPolicy(this.endpoint, {
        method: 'POST',
        headers: this.requestHeaders('application/json, text/event-stream', request),
        body: JSON.stringify(request),
      }, { ...this.config.networkPolicy, timeoutMs }, this.fetchImpl)
      const session = response.headers.get('mcp-session-id')
      if ((this.config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION) !== MODERN_PROTOCOL_VERSION && session) this.sessionId = session
      if (!response.ok && response.status !== 202) {
        const text = await boundedText(response, this.limits.maxResponseBytes)
        throw new McpAdapterError('MCP_CONNECTION_ERROR', `MCP ${this.kind} request returned HTTP ${response.status}: ${redactSensitiveText(text)}`, { method: request.method, serverKey: serverKeyFor(this.config) })
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (contentType.includes('application/json')) {
        const body = await readBody(response, this.limits.maxResponseBytes)
        if (body.truncated) throw new McpAdapterError('MCP_LIMIT_EXCEEDED', `MCP response exceeded ${this.limits.maxResponseBytes} bytes`, { method: request.method, serverKey: serverKeyFor(this.config) })
        let value: unknown
        try { value = JSON.parse(body.text) } catch (error) { throw new McpAdapterError('MCP_PROTOCOL_ERROR', `MCP ${request.method} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { method: request.method, serverKey: serverKeyFor(this.config), cause: error }) }
        if (!isJsonRpcResponse(value)) throw new McpAdapterError('MCP_PROTOCOL_ERROR', `MCP ${request.method} returned an invalid JSON-RPC response`, { method: request.method, serverKey: serverKeyFor(this.config) })
        this.resolveResponse(value)
      } else if (contentType.includes('text/event-stream') && response.body) {
        await this.consumeSse(response.body)
      }
      return await pending
    } catch (error) {
      const normalized = error instanceof NetworkPolicyError && error.code === 'TIMEOUT'
        ? new McpAdapterError('MCP_TIMEOUT', `MCP ${request.method} timed out after ${timeoutMs}ms`, { method: request.method, serverKey: serverKeyFor(this.config) })
        : error instanceof DOMException && error.name === 'AbortError'
        ? new McpAdapterError('MCP_TIMEOUT', `MCP ${request.method} timed out after ${timeoutMs}ms`, { method: request.method, serverKey: serverKeyFor(this.config) })
        : errorForTransport(error, `Could not send MCP ${request.method} request`, this.config)
      this.rejectResponse(request.id, normalized)
      throw normalized
    }
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.start()
    if (!this.endpoint || this.closed) throw new McpAdapterError('MCP_CONNECTION_ERROR', `MCP ${this.kind} transport is closed`, { serverKey: serverKeyFor(this.config) })
    const notification = params === undefined ? { jsonrpc: JSON_RPC_VERSION, method } : { jsonrpc: JSON_RPC_VERSION, method, params }
    jsonBytes(notification, 'MCP notification', this.limits.maxInputBytes)
    try {
      const response = await fetchWithNetworkPolicy(this.endpoint, { method: 'POST', headers: this.requestHeaders('application/json, text/event-stream'), body: JSON.stringify(notification) }, { ...this.config.networkPolicy, timeoutMs: this.limits.requestTimeoutMs }, this.fetchImpl)
      if (!response.ok && response.status !== 202) throw new McpAdapterError('MCP_CONNECTION_ERROR', `MCP notification returned HTTP ${response.status}`, { method, serverKey: serverKeyFor(this.config) })
    } catch (error) {
      if ((error instanceof NetworkPolicyError && error.code === 'TIMEOUT') || (error instanceof DOMException && error.name === 'AbortError')) throw new McpAdapterError('MCP_TIMEOUT', `MCP ${method} notification timed out`, { method, serverKey: serverKeyFor(this.config) })
      throw errorForTransport(error, `Could not send MCP ${method} notification`, this.config)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.streamAbort.abort()
    await this.cancelEventStream?.()
    this.endpointReject?.(new McpAdapterError('MCP_CONNECTION_ERROR', 'MCP HTTP/SSE transport was closed', { serverKey: serverKeyFor(this.config) }))
    this.fail(new McpAdapterError('MCP_CONNECTION_ERROR', 'MCP HTTP/SSE transport was closed', { serverKey: serverKeyFor(this.config) }))
  }

  private requestHeaders(accept: string, request?: JsonRpcRequest): Record<string, string> {
    const headers: Record<string, string> = { accept, 'content-type': 'application/json', ...resolveHeaders(this.config.headers) }
    const protocolVersion = this.config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION
    if (protocolVersion !== MODERN_PROTOCOL_VERSION && this.sessionId) headers['mcp-session-id'] = this.sessionId
    headers['MCP-Protocol-Version'] = protocolVersion
    if (protocolVersion === MODERN_PROTOCOL_VERSION && request) {
      headers['Mcp-Method'] = request.method
      const params = object(request.params)
      const name = request.method === 'resources/read' ? params.uri
        : request.method === 'tools/call' || request.method === 'prompts/get' ? params.name
          : undefined
      if (typeof name === 'string') headers['Mcp-Name'] = encodeMcpHeaderValue(name)
    }
    return headers
  }

  private expect(id: JsonRpcId, method: string, timeoutMs: number): Promise<JsonRpcResponse> {
    const key = String(id)
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(new McpAdapterError('MCP_TIMEOUT', `MCP ${method} timed out after ${timeoutMs}ms`, { method, serverKey: serverKeyFor(this.config) }))
      }, timeoutMs)
      this.pending.set(key, { resolve, reject, timer })
    })
  }

  private resolveResponse(response: JsonRpcResponse): void {
    if (response.id === undefined || response.id === null) return
    const key = String(response.id)
    const pending = this.pending.get(key)
    if (!pending) return
    this.pending.delete(key)
    clearTimeout(pending.timer)
    pending.resolve(response)
  }

  private rejectResponse(id: JsonRpcId, error: unknown): void {
    const key = String(id)
    const pending = this.pending.get(key)
    if (!pending) return
    this.pending.delete(key)
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  private async consumeSse(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    this.cancelEventStream = () => reader.cancel().then(() => undefined).catch(() => undefined)
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        buffer += decoder.decode(next.value, { stream: true })
        if (new TextEncoder().encode(buffer).byteLength > this.limits.maxResponseBytes) throw new McpAdapterError('MCP_LIMIT_EXCEEDED', `MCP SSE event exceeded ${this.limits.maxResponseBytes} bytes`, { serverKey: serverKeyFor(this.config) })
        let boundary = buffer.search(/\r?\n\r?\n/)
        while (boundary >= 0) {
          const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n'
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + separator.length)
          this.onSseEvent(parseSseEvent(block))
          boundary = buffer.search(/\r?\n\r?\n/)
        }
      }
      const tail = decoder.decode()
      if (tail.trim()) this.onSseEvent(parseSseEvent(buffer + tail))
    } finally {
      this.cancelEventStream = undefined
      reader.releaseLock()
    }
  }

  private onSseEvent(event: SseEvent): void {
    if (!event.data || event.data === '[DONE]') return
    if (event.event === 'endpoint') {
      try {
        const endpoint = validateHttpUrl(new URL(event.data.trim(), this.config.url), this.config.networkPolicy)
        this.endpoint = endpoint
        this.endpointResolve?.(endpoint)
      } catch (error) { this.endpointReject?.(new McpAdapterError('MCP_PROTOCOL_ERROR', `MCP SSE announced an invalid endpoint: ${redactSensitiveText(event.data)}`, { serverKey: serverKeyFor(this.config), cause: error })) }
      return
    }
    let value: unknown
    try { value = JSON.parse(event.data) } catch (error) { throw new McpAdapterError('MCP_PROTOCOL_ERROR', `MCP SSE returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { serverKey: serverKeyFor(this.config), cause: error }) }
    if (isJsonRpcResponse(value)) this.resolveResponse(value)
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new McpAdapterError('MCP_TIMEOUT', `${label} timed out after ${timeoutMs}ms`, { serverKey: serverKeyFor(this.config) })), timeoutMs)
      promise.then((value) => { clearTimeout(timer); resolve(value) }, (error: unknown) => { clearTimeout(timer); reject(error) })
    })
  }

  private fail(error: unknown): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(error)
    }
  }
}

function parseSseEvent(block: string): SseEvent {
  let event = 'message'
  const data: string[] = []
  for (const line of block.replaceAll('\r\n', '\n').split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  return { event, data: data.join('\n') }
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const body = await readBody(response, limit)
  const text = body.text.slice(0, 500)
  return body.truncated ? `${text}... [response truncated at ${limit} bytes]` : text
}

async function readBody(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let truncated = false
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const remaining = limit - bytes
      if (remaining <= 0) { truncated = true; break }
      const chunk = next.value.byteLength > remaining ? next.value.slice(0, remaining) : next.value
      chunks.push(chunk)
      bytes += chunk.byteLength
      if (chunk.byteLength < next.value.byteLength) { truncated = true; break }
    }
  } finally { await reader.cancel().catch(() => undefined) }
  return { text: new TextDecoder().decode(concatBytes(chunks)), truncated }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}

export class McpClient {
  private readonly transport: McpTransport
  private readonly config: McpServerConfig
  private readonly limits: McpLimits
  private readonly clientName: string
  private readonly clientVersion: string
  private nextId = 1
  private initialized = false
  private initialization: Promise<RecordValue> | undefined

  constructor(transport: McpTransport, config: McpServerConfig, options: McpClientOptions = {}) {
    this.transport = transport
    this.config = config
    this.limits = limitsFor({ ...config.limits, ...(options.limits ?? {}) })
    this.clientName = config.clientName ?? options.clientName ?? 'pi-subpolar'
    this.clientVersion = config.clientVersion ?? options.clientVersion ?? '1.0.0'
  }

  async initialize(): Promise<RecordValue> {
    if (this.protocolVersion() === MODERN_PROTOCOL_VERSION) {
      await this.transport.start()
      this.initialized = true
      return {}
    }
    if (this.initialized) return {}
    if (this.initialization) return this.initialization
    const initialization = this.initializeOnce()
    this.initialization = initialization
    try { return await initialization } finally { if (this.initialization === initialization) this.initialization = undefined }
  }

  private async initializeOnce(): Promise<RecordValue> {
    await this.transport.start()
    const result = object(await this.requestResult('initialize', {
      protocolVersion: this.config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.clientName, version: this.clientVersion },
    }))
    await this.transport.notify('notifications/initialized')
    this.initialized = true
    return result
  }

  async listTools(): Promise<McpTool[]> {
    await this.initialize()
    const rawTools: unknown[] = []
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    for (let page = 0; page < this.limits.maxListPages; page += 1) {
      const params = cursor ? { cursor } : undefined
      const result = object(await this.requestResult('tools/list', params))
      if (!Array.isArray(result.tools)) throw new McpAdapterError('MCP_PROTOCOL_ERROR', 'MCP tools/list response did not contain a tools array', { method: 'tools/list', serverKey: serverKeyFor(this.config) })
      const tools = result.tools
      rawTools.push(...tools)
      if (rawTools.length > this.limits.maxTools) throw new McpAdapterError('MCP_LIMIT_EXCEEDED', `MCP server returned more than ${this.limits.maxTools} tools`, { method: 'tools/list', serverKey: serverKeyFor(this.config) })
      const next = nonEmptyString(result.nextCursor)
      if (!next) break
      if (seenCursors.has(next)) throw new McpAdapterError('MCP_PROTOCOL_ERROR', 'MCP tools/list returned a repeated pagination cursor', { method: 'tools/list', serverKey: serverKeyFor(this.config) })
      seenCursors.add(next)
      cursor = next
      if (page === this.limits.maxListPages - 1) throw new McpAdapterError('MCP_LIMIT_EXCEEDED', `MCP tools/list exceeded ${this.limits.maxListPages} pages`, { method: 'tools/list', serverKey: serverKeyFor(this.config) })
    }
    return normalizeMcpTools(rawTools, { ...(this.config.namespace ? { namespace: this.config.namespace } : {}), maxTools: this.limits.maxTools, maxSchemaBytes: this.limits.maxResponseBytes })
  }

  async callTool(name: string, input: unknown, timeoutMs?: number): Promise<McpCallResult> {
    await this.initialize()
    const toolName = nonEmptyString(name)
    if (!toolName) throw new McpAdapterError('MCP_CONFIGURATION_ERROR', 'MCP tool name is required')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new McpAdapterError('MCP_TOOL_ERROR', `Arguments for MCP tool ${toolName} must be a JSON object`)
    jsonBytes(input, 'MCP tool arguments', this.limits.maxInputBytes)
    const result = object(await this.requestResult('tools/call', { name: toolName, arguments: input as Record<string, unknown> }, timeoutMs))
    if (!Array.isArray(result.content)) throw new McpAdapterError('MCP_PROTOCOL_ERROR', `MCP tools/call response for ${toolName} did not contain a content array`, { method: 'tools/call', serverKey: serverKeyFor(this.config) })
    const normalized: McpCallResult = { content: result.content, isError: result.isError === true, raw: result }
    if (Object.prototype.hasOwnProperty.call(result, 'structuredContent')) normalized.structuredContent = result.structuredContent
    jsonBytes(normalized, 'MCP tool result', this.limits.maxResponseBytes)
    return normalized
  }

  async close(): Promise<void> {
    await this.transport.close()
    this.initialized = false
    this.initialization = undefined
  }

  private async requestResult(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const requestTimeout = timeoutFor(timeoutMs, this.limits)
    const requestParams = this.protocolVersion() === MODERN_PROTOCOL_VERSION
      ? { ...(params ?? {}), _meta: {
          ...object(params?._meta),
          [MCP_META_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION,
          [MCP_META_CLIENT_INFO]: { name: this.clientName, version: this.clientVersion },
          [MCP_META_CLIENT_CAPABILITIES]: {},
        } }
      : params
    const response = await this.transport.request(makeRequest(this.nextId++, method, requestParams), requestTimeout)
    return responseResult(response, method, serverKeyFor(this.config))
  }

  private protocolVersion(): string {
    return this.config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION
  }
}

export type McpAdapter = {
  connect(config: McpServerConfig): Promise<McpClient>
  discover(config: McpServerConfig): Promise<McpTool[]>
  discoverForTool(tool: McpToolReference): Promise<McpTool[]>
  invoke(tool: McpToolReference, input: unknown, options?: { timeoutMs?: number }): Promise<McpCallResult>
  close(): Promise<void>
}

export class DefaultMcpAdapter implements McpAdapter {
  private readonly options: CreateMcpAdapterOptions
  private readonly clients = new Map<string, McpClient>()
  private readonly connections = new Map<string, Promise<McpClient>>()
  private closing: Promise<void> | undefined

  constructor(options: CreateMcpAdapterOptions = {}) { this.options = options }

  async connect(config: McpServerConfig): Promise<McpClient> {
    if (this.closing) throw new McpAdapterError('MCP_CONNECTION_ERROR', 'MCP adapter is closing')
    // Freeze the effective credentials before keying and opening the transport.
    // serverKey is a display label, not an authentication/context identity.
    const effective = structuredClone({ ...this.options.defaults, ...config, limits: { ...this.options.defaults?.limits, ...config.limits, ...this.options.limits } })
    if (effective.env) effective.env = Object.fromEntries(Object.entries(effective.env).flatMap(([key, value]) => {
      const resolved = resolveEnvValue(value)
      return resolved === undefined ? [] : [[key, resolved]]
    }))
    if (effective.transport === 'stdio') {
      effective.cwd ??= process.cwd()
      effective.env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...effective.env }
    }
    if (effective.headers) effective.headers = resolveHeaders(effective.headers)
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
    const key = effective.ownerId?.trim()
      ? createHash('sha256').update(JSON.stringify(canonical(effective))).digest('hex')
      : randomUUID()
    const existing = this.clients.get(key)
    if (existing) return existing
    const connecting = this.connections.get(key)
    if (connecting) return connecting
    const connection = this.openClient(effective, key)
    this.connections.set(key, connection)
    try { return await connection } finally { if (this.connections.get(key) === connection) this.connections.delete(key) }
  }

  private async openClient(config: McpServerConfig, key: string): Promise<McpClient> {
    const transport = this.options.transportFactory?.(config) ?? createMcpTransport(config, this.options)
    const client = new McpClient(transport, config, this.options)
    try {
      await client.initialize()
      if (this.closing) throw new McpAdapterError('MCP_CONNECTION_ERROR', 'MCP adapter closed during initialization', { serverKey: key })
      this.clients.set(key, client)
      return client
    } catch (error) {
      await transport.close().catch(() => undefined)
      throw errorForTransport(error, `Could not initialize MCP server ${key}`, config)
    }
  }

  private async releaseUnscoped(client: McpClient, config: McpServerConfig): Promise<void> {
    if ((config.ownerId ?? this.options.defaults?.ownerId)?.trim()) return
    for (const [key, cached] of this.clients) if (cached === client) this.clients.delete(key)
    await client.close()
  }

  async discover(config: McpServerConfig): Promise<McpTool[]> {
    const client = await this.connect(config)
    try { return await client.listTools() } finally { await this.releaseUnscoped(client, config) }
  }

  async discoverForTool(tool: McpToolReference): Promise<McpTool[]> {
    const resolved = resolveMcpToolReference(tool, this.options.defaults)
    return this.discover(resolved.config)
  }

  async invoke(tool: McpToolReference, input: unknown, options: { timeoutMs?: number } = {}): Promise<McpCallResult> {
    const resolved = resolveMcpToolReference(tool, this.options.defaults)
    const client = await this.connect(resolved.config)
    try { return await client.callTool(resolved.toolName, input, options.timeoutMs ?? resolved.config.timeoutMs) } finally { await this.releaseUnscoped(client, resolved.config) }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing
    const clients = [...this.clients.values()]
    const connections = [...this.connections.values()]
    this.clients.clear()
    const closing = Promise.all([
      ...clients.map((client) => client.close().catch(() => undefined)),
      ...connections.map((connection) => connection.catch(() => undefined)),
    ]).then(() => undefined)
    this.closing = closing
    try { await closing } finally { if (this.closing === closing) this.closing = undefined }
  }
}

export function createMcpAdapter(options: CreateMcpAdapterOptions = {}): McpAdapter {
  return new DefaultMcpAdapter(options)
}

function createMcpTransport(config: McpServerConfig, options: McpClientOptions): McpTransport {
  if (config.transport === 'stdio') return new StdioMcpTransport(config, options.limits)
  return new HttpMcpTransport(config, options)
}

export function normalizeMcpTool(raw: unknown, options: NormalizeMcpToolsOptions = {}): McpTool {
  const record = object(raw)
  const name = nonEmptyString(record.name)
  if (!name) throw new McpAdapterError('MCP_PROTOCOL_ERROR', 'MCP tools/list returned a tool without a name', { method: 'tools/list' })
  const maxNameLength = positiveInteger(options.maxNameLength, 256)
  if (name.length > maxNameLength) throw new McpAdapterError('MCP_LIMIT_EXCEEDED', `MCP tool name exceeds ${maxNameLength} characters`, { method: 'tools/list' })
  if (!MCP_NAME.test(name)) throw new McpAdapterError('MCP_PROTOCOL_ERROR', `MCP tool name is malformed: ${redactSensitiveText(name)}`, { method: 'tools/list' })
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  const maxDescriptionLength = positiveInteger(options.maxDescriptionLength, 8_192)
  const inputSchemaValue = record.inputSchema ?? record.input_schema
  const inputSchema = inputSchemaValue === undefined ? { type: 'object', properties: {}, additionalProperties: true } : validateMcpSchema(inputSchemaValue, `Input schema for ${name}`, positiveInteger(options.maxSchemaBytes, DEFAULT_LIMITS.maxResponseBytes))
  const outputSchemaValue = record.outputSchema ?? record.output_schema
  const outputSchema = outputSchemaValue === undefined ? undefined : validateMcpSchema(outputSchemaValue, `Output schema for ${name}`, positiveInteger(options.maxSchemaBytes, DEFAULT_LIMITS.maxResponseBytes))
  const maxSchemaBytes = positiveInteger(options.maxSchemaBytes, DEFAULT_LIMITS.maxResponseBytes)
  jsonBytes(inputSchema, `Input schema for ${name}`, maxSchemaBytes)
  if (outputSchema) jsonBytes(outputSchema, `Output schema for ${name}`, maxSchemaBytes)
  const namespace = nonEmptyString(options.namespace)
  return {
    name,
    description: description.length > maxDescriptionLength ? `${description.slice(0, maxDescriptionLength - 3).trimEnd()}...` : description,
    inputSchema: Object.keys(inputSchema).length ? inputSchema : { type: 'object', properties: {}, additionalProperties: true },
    ...(outputSchema ? { outputSchema } : {}),
    ...(Object.keys(object(record.annotations)).length ? { annotations: object(record.annotations) } : {}),
    ...(namespace ? { namespace } : {}),
    toolId: namespace ? `${namespace}/${name}` : name,
    raw: record,
  }
}

export function normalizeMcpTools(rawTools: unknown[], options: NormalizeMcpToolsOptions = {}): McpTool[] {
  const maxTools = positiveInteger(options.maxTools, DEFAULT_LIMITS.maxTools)
  if (rawTools.length > maxTools) throw new McpAdapterError('MCP_LIMIT_EXCEEDED', `MCP server returned ${rawTools.length} tools; the limit is ${maxTools}`, { method: 'tools/list' })
  const normalized: McpTool[] = []
  const ids = new Set<string>()
  for (const raw of rawTools) {
    const tool = normalizeMcpTool(raw, options)
    if (ids.has(tool.toolId)) throw new McpAdapterError('MCP_PROTOCOL_ERROR', `MCP tools/list returned duplicate tool ID ${tool.toolId}`, { method: 'tools/list' })
    ids.add(tool.toolId)
    normalized.push(tool)
  }
  return normalized
}

export function resolveMcpToolReference(tool: McpToolReference, defaults: Partial<McpServerConfig> = {}): { config: McpServerConfig; toolName: string } {
  const metadata = object(tool.metadata)
  const nested = object(metadata.mcp)
  const value = (key: string): unknown => nested[key] ?? metadata[key]
  const configuredTransport = value('transport')
  const transport: McpTransportKind = configuredTransport === 'stdio' || configuredTransport === 'http' || configuredTransport === 'sse'
    ? configuredTransport
    : nonEmptyString(value('command'))
      ? 'stdio'
      : /^https?:\/\//i.test(nonEmptyString(value('url')) ?? tool.target)
        ? (value('sse') === true ? 'sse' : 'http')
        : defaults.transport ?? 'stdio'
  if (configuredTransport !== undefined && transport !== configuredTransport) throw new McpAdapterError('MCP_CONFIGURATION_ERROR', `Unsupported MCP transport for ${tool.tool_id}`)
  const command = nonEmptyString(value('command')) ?? (transport === 'stdio' ? nonEmptyString(tool.target) : undefined)
  const url = nonEmptyString(value('url')) ?? (transport !== 'stdio' ? nonEmptyString(tool.target) : undefined)
  if (transport === 'stdio' && !value('command') && /^[a-z][a-z0-9+.-]*:\/\//i.test(tool.target)) throw new McpAdapterError('MCP_CONFIGURATION_ERROR', `Unsupported MCP target for ${tool.tool_id}`)
  if (transport === 'stdio' && !command) throw new McpAdapterError('MCP_CONFIGURATION_ERROR', `No stdio command configured for ${tool.tool_id}`)
  if (transport !== 'stdio' && !url) throw new McpAdapterError('MCP_CONFIGURATION_ERROR', `No ${transport} URL configured for ${tool.tool_id}`)
  if (url) {
    try { validateHttpUrl(new URL(url), defaults.networkPolicy) } catch (error) { throw new McpAdapterError('MCP_CONFIGURATION_ERROR', `Invalid MCP target for ${tool.tool_id}`, { cause: error }) }
  }
  const argsValue = value('args')
  if (argsValue !== undefined && !Array.isArray(argsValue)) throw new McpAdapterError('MCP_CONFIGURATION_ERROR', `MCP args for ${tool.tool_id} must be an array`)
  if (Array.isArray(argsValue) && argsValue.some((item) => typeof item !== 'string')) throw new McpAdapterError('MCP_CONFIGURATION_ERROR', `MCP args for ${tool.tool_id} must contain strings only`)
  const args = Array.isArray(argsValue) ? argsValue as string[] : undefined
  const toolName = nonEmptyString(value('toolName')) ?? nonEmptyString(tool.operation) ?? tool.tool_id.split('/').pop() ?? tool.tool_id
  if (!MCP_NAME.test(toolName)) throw new McpAdapterError('MCP_CONFIGURATION_ERROR', `MCP tool operation is malformed for ${tool.tool_id}`)
  const namespace = nonEmptyString(value('namespace')) ?? nonEmptyString(tool.namespace)
  const config: McpServerConfig = {
    ...defaults,
    ...(tool.owner_id?.trim() ? { ownerId: tool.owner_id } : {}),
    transport,
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    ...(args ? { args } : {}),
    ...(nonEmptyString(value('cwd')) ? { cwd: nonEmptyString(value('cwd'))! } : {}),
    ...((Object.keys(object(value('env'))).length > 0) ? { env: object(value('env')) as Record<string, string | { env: string }> } : {}),
    ...((Object.keys(object(value('headers'))).length > 0) ? { headers: object(value('headers')) as Record<string, McpHeaderValue> } : {}),
    ...(namespace ? { namespace } : {}),
    ...(nonEmptyString(value('serverKey')) ? { serverKey: nonEmptyString(value('serverKey'))! } : {}),
    ...(nonEmptyString(value('protocolVersion')) ? { protocolVersion: nonEmptyString(value('protocolVersion'))! } : {}),
    ...(typeof value('timeoutMs') === 'number' ? { timeoutMs: value('timeoutMs') as number } : {}),
    networkPolicy: { ...(defaults.networkPolicy ?? {}), ...networkPolicyFromMetadata({ ...metadata, mcp: nested }) },
  }
  return { config, toolName }
}

export function mcpToolToRegistryDefinition(tool: McpTool, config: McpServerConfig, options: { risk?: McpToolRegistryDefinition['risk']; requiresApproval?: boolean; metadata?: Record<string, unknown> } = {}): McpToolRegistryDefinition {
  const risk = options.risk ?? riskFromAnnotations(tool.annotations)
  const target = config.transport === 'stdio' ? config.command ?? '' : config.url ?? ''
  return {
    tool_id: tool.toolId,
    namespace: tool.namespace ?? config.namespace ?? 'mcp',
    description: tool.description,
    adapter: 'mcp',
    target,
    operation: tool.name,
    input_schema: tool.inputSchema,
    output_schema: tool.outputSchema ?? {},
    risk,
    requires_approval: options.requiresApproval ?? risk !== 'read',
    enabled: true,
    metadata: {
      transport: config.transport,
      toolName: tool.name,
      ...(config.serverKey ? { serverKey: config.serverKey } : {}),
      ...options.metadata,
    },
  }
}

function riskFromAnnotations(annotations: Record<string, unknown> | undefined): McpToolRegistryDefinition['risk'] {
  const item = object(annotations)
  if (item.destructiveHint === true) return 'delete'
  if (item.readOnlyHint === true) return 'read'
  if (item.openWorldHint === true) return 'external'
  return 'write'
}

export function mcpConfigFromToolDefinition(tool: McpToolReference, defaults: Partial<McpServerConfig> = {}): McpServerConfig {
  return resolveMcpToolReference(tool, defaults).config
}
