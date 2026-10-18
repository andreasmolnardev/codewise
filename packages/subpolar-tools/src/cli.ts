#!/usr/bin/env bun

type JsonObject = Record<string, unknown>
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>
type ReadText = (path: string) => Promise<string>

export const EXIT_OK = 0
export const EXIT_REMOTE = 1
export const EXIT_USAGE = 2
export const EXIT_TIMEOUT = 3
export const EXIT_CANCELLED = 4

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 10 * 60_000
const MAX_INPUT_BYTES = 1 * 1024 * 1024
const MAX_METADATA_BYTES = 16 * 1024
const MAX_METADATA_KEYS = 64
const MAX_METADATA_DEPTH = 5
const MAX_METADATA_STRING = 2 * 1024
const MIN_TOKEN_REDACTION_LENGTH = 8
const DEFAULT_BASE_URL = 'http://127.0.0.1:4173'

const builtInToolIds = new Set(['search-tool', 'read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'])
const adapters = new Set(['internal', 'http', 'openapi', 'mcp'])
const risks = new Set(['read', 'write', 'delete', 'external'])
const schemaTypes = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'])


export interface CliIo {
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

export interface CliOptions {
  fetch?: Fetcher
  env?: Record<string, string | undefined>
  readFile?: ReadText
  readStdin?: () => Promise<string>
  stdinIsTTY?: () => boolean
  signal?: AbortSignal
}

class CliError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = EXIT_USAGE) {
    super(message)
  }
}

class RemoteError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number, readonly details?: unknown) {
    super(message)
  }
}

interface ParsedOptions {
  baseUrl?: string
  token?: string
  tokenFile?: string
  tokenStdin: boolean
  json: boolean
  input?: string
  inputFile?: string
  wait: boolean
  timeout: number
  userId?: string
  agentName?: string
  sessionId?: string
  cwd?: string
  callId?: string
  permissionOverride?: 'ask' | 'none' | 'allow_all'
}

interface ParsedCommand {
  command: string
  args: string[]
  options: ParsedOptions
}

function runtime(): { process?: { argv?: string[]; env?: Record<string, string | undefined>; stdin?: { isTTY?: boolean }; stdout?: { write: (text: string) => void }; stderr?: { write: (text: string) => void }; on?: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => void; off?: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => void; removeListener?: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => void }; Bun?: { file: (path: string) => { text: () => Promise<string> }; stdin?: ReadableStream<Uint8Array> } } {
  return globalThis as unknown as ReturnType<typeof runtime>
}

function defaultReadFile(path: string): Promise<string> {
  const bun = runtime().Bun
  if (!bun) throw new Error('Token and input files require the Bun runtime')
  return bun.file(path).text()
}

async function defaultReadStdin(): Promise<string> {
  const bun = runtime().Bun
  if (!bun?.stdin) throw new Error('Stdin input requires the Bun runtime')
  return new Response(bun.stdin).text()
}

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init)
}

function fail(message: string): never {
  throw new CliError('CLI_USAGE_ERROR', message)
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) fail(`${option} requires a value`)
  return value
}

function parseTimeout(value: string): number {
  const timeout = Number(value)
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) fail(`--timeout must be an integer from 1 to ${MAX_TIMEOUT_MS}`)
  return timeout
}

function parseOptions(argv: string[]): ParsedCommand {
  const options: ParsedOptions = { tokenStdin: false, json: false, wait: false, timeout: DEFAULT_TIMEOUT_MS }
  const positional: string[] = []
  let command = ''

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') {
      options.json = true
      continue
    }
    if (argument === '--wait') {
      options.wait = true
      continue
    }
    const equal = argument.indexOf('=')
    const name = equal === -1 ? argument : argument.slice(0, equal)
    const inline = equal === -1 ? undefined : argument.slice(equal + 1)
    const option = (value: string | undefined): void => {
      if (!value) fail(`${name} requires a value`)
      if (name === '--base-url') options.baseUrl = value
      else if (name === '--token') options.token = value
      else if (name === '--token-file') options.tokenFile = value
      else if (name === '--input') options.input = value
      else if (name === '--input-file') options.inputFile = value
      else if (name === '--timeout') options.timeout = parseTimeout(value)
      else if (name === '--user-id') options.userId = value
      else if (name === '--agent') options.agentName = value
      else if (name === '--session-id' || name === '--session') options.sessionId = value
      else if (name === '--cwd') options.cwd = value
      else if (name === '--call-id') options.callId = value
      else if (name === '--permission') {
        if (value !== 'ask' && value !== 'none' && value !== 'allow_all') fail('--permission must be ask, none, or allow_all')
        options.permissionOverride = value
      } else if (name === '--token-stdin') {
        if (value !== 'true') fail(`Unknown option: ${argument}`)
      } else {
        fail(`Unknown option: ${name}`)
      }
    }
    if (name === '--token-stdin') {
      if (inline !== undefined) option(inline)
      else options.tokenStdin = true
      continue
    }
    if (name.startsWith('--')) {
      option(inline ?? requiredValue(argv, index++, name))
      continue
    }
    if (!command) command = argument
    else positional.push(argument)
  }

  if (!command) fail('A command is required')
  if (options.input !== undefined && options.inputFile !== undefined) fail('--input and --input-file cannot be combined')
  if (options.token !== undefined && (options.tokenFile !== undefined || options.tokenStdin)) fail('Only one token source may be selected')
  if (options.tokenFile !== undefined && options.tokenStdin) fail('Only one token source may be selected')
  if (options.tokenStdin && (command === 'call' || command === 'add') && options.input === undefined && options.inputFile === undefined) fail('--token-stdin requires --input or --input-file for call and add')
  return { command, args: positional, options }
}

function canonicalToolId(value: unknown, adapter?: unknown, namespace?: unknown): string {
  if (typeof value !== 'string' || !value.trim()) fail('tool ID must be a non-empty string')
  let id = value.trim()
  if (id !== value) fail('tool ID must not have leading or trailing whitespace')

  if (adapter && adapter !== 'internal' && typeof namespace === 'string' && namespace && !id.includes('/')) {
    const operation = id.includes('.') ? id.slice(id.lastIndexOf('.') + 1) : id
    id = `${namespace}/${operation}`
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)?$/.test(id)) fail(`Invalid canonical tool ID: ${value}`)
  return id
}

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseJson(text: string, label: string): unknown {
  const bytes = new TextEncoder().encode(text).byteLength
  if (bytes > MAX_INPUT_BYTES) throw new CliError('INPUT_TOO_LARGE', `${label} exceeds ${MAX_INPUT_BYTES} bytes`)
  try {
    return JSON.parse(text)
  } catch {
    throw new CliError('INVALID_JSON', `${label} must contain valid JSON`)
  }
}

async function inputValue(parsed: ParsedOptions, command: string, options: CliOptions): Promise<unknown> {
  const readFile = options.readFile ?? defaultReadFile
  if (parsed.input !== undefined) return parseJson(parsed.input, '--input')
  if (parsed.inputFile !== undefined) return parseJson(await readFile(parsed.inputFile), parsed.inputFile)
  const stdinIsTTY = options.stdinIsTTY ?? (() => runtime().process?.stdin?.isTTY !== false)
  if ((command === 'call' || command === 'add') && !stdinIsTTY()) return parseJson(await (options.readStdin ?? defaultReadStdin)(), 'stdin')
  return command === 'call' ? {} : undefined
}

async function tokenValue(parsed: ParsedOptions, options: CliOptions): Promise<string> {
  const env = options.env ?? runtime().process?.env ?? {}
  let token = parsed.token
  if (token === undefined && parsed.tokenFile !== undefined) token = await (options.readFile ?? defaultReadFile)(parsed.tokenFile)
  if (token === undefined && parsed.tokenStdin) token = await (options.readStdin ?? defaultReadStdin)()
  if (token === undefined) token = env.SUBPOLAR_TOOLS_TOKEN
  if (!token?.trim()) throw new CliError('TOKEN_REQUIRED', 'An access token is required via --token, --token-file, --token-stdin, or SUBPOLAR_TOOLS_TOKEN')
  return token.trim()
}

function baseUrl(parsed: ParsedOptions, options: CliOptions): string {
  const env = options.env ?? runtime().process?.env ?? {}
  const value = parsed.baseUrl ?? env.SUBPOLAR_TOOLS_BASE_URL ?? DEFAULT_BASE_URL
  let url: URL
  try { url = new URL(value) } catch { throw new CliError('INVALID_BASE_URL', '--base-url must be an absolute HTTP(S) URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CliError('INVALID_BASE_URL', '--base-url must be an absolute HTTP(S) URL')
  if (url.username || url.password) throw new CliError('INVALID_BASE_URL', 'Credentials are not allowed in --base-url')
  return url.toString()
}

function code(value: unknown): string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_.-]{0,63}$/.test(value) ? value : 'REMOTE_ERROR'
}

function credentialKey(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (words.some((word) => ['authorization', 'cookie', 'credential', 'password', 'secret', 'token'].includes(word))) return true
  return words.some((word, index) => {
    const next = words[index + 1]
    return (word === 'access' && next === 'token') || (word === 'api' && next === 'key') || (word === 'auth' && next === 'token') || (word === 'client' && next === 'secret') || (word === 'private' && next === 'key') || (word === 'refresh' && next === 'token') || (word === 'set' && next === 'cookie')
  })
}

function redactString(value: string, secret: string): string {
  if (!secret) return value
  if (value === secret) return '[REDACTED]'
  return secret.length >= MIN_TOKEN_REDACTION_LENGTH ? value.split(secret).join('[REDACTED]') : value
}

function redact(value: unknown, secret: string, key = ''): unknown {
  if (credentialKey(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactString(value, secret)
  if (Array.isArray(value)) return value.map((item) => redact(item, secret))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, redact(item, secret, childKey)]))
  return value
}

function remoteError(response: Response, payload: unknown, token: string): RemoteError {
  const body = object(payload)
  const candidate = body.error
  const error = object(candidate)
  const message = typeof candidate === 'string' ? candidate : typeof error.message === 'string' ? error.message : typeof body.message === 'string' ? body.message : `HTTP ${response.status}`
  const details = error.details === undefined ? undefined : redact(error.details, token)
  return new RemoteError(code(error.code), String(redact(message, token)), response.status, details)
}

async function withRequest<T>(base: string, _token: string, timeout: number, fetcher: Fetcher, path: string, init: RequestInit, consume: (response: Response) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = (): void => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)
  try {
    if (signal?.aborted) throw new CliError('CLI_CANCELLED', 'Request cancelled', EXIT_CANCELLED)
    const response = await fetcher(new URL(path, base).toString(), { ...init, signal: controller.signal })
    return await consume(response)
  } catch (error) {
    if (error instanceof RemoteError) throw error
    if (timedOut) throw new CliError('CLI_TIMEOUT', `Request timed out after ${timeout}ms`, EXIT_TIMEOUT)
    if (signal?.aborted) throw new CliError('CLI_CANCELLED', 'Request cancelled', EXIT_CANCELLED)
    if ((error instanceof DOMException && error.name === 'AbortError') || (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')) {
      throw new CliError('NETWORK_ERROR', 'Unable to reach the Subpolar gateway', EXIT_REMOTE)
    }
    if (error instanceof CliError) throw error
    throw new CliError('NETWORK_ERROR', 'Unable to reach the Subpolar gateway', EXIT_REMOTE)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

async function requestJson(base: string, token: string, timeout: number, fetcher: Fetcher, path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  return withRequest(base, token, timeout, fetcher, path, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, async (response) => {
    const text = await response.text()
    let payload: unknown = {}
    if (text) {
      try { payload = JSON.parse(text) } catch { payload = { message: text } }
    }
    if (!response.ok) throw remoteError(response, payload, token)
    if (object(payload).ok === false && object(payload).approvalRequired !== true && object(payload).status !== 'approval_required' && object(payload).error !== undefined) throw remoteError(response, payload, token)
    return payload
  }, signal)
}

function contextBody(parsed: ParsedOptions): JsonObject {
  return {
    ...(parsed.userId === undefined ? {} : { userId: parsed.userId }),
    ...(parsed.agentName === undefined ? {} : { agentName: parsed.agentName }),
    ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
  }
}

function definitionField(definition: JsonObject, camel: string, snake: string): unknown {
  const camelValue = definition[camel]
  const snakeValue = definition[snake]
  if (camelValue !== undefined && snakeValue !== undefined && JSON.stringify(camelValue) !== JSON.stringify(snakeValue)) fail(`${camel} and ${snake} must match`)
  return camelValue ?? snakeValue
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`)
  if (value !== value.trim()) fail(`${label} must not have leading or trailing whitespace`)
  if (value.length > maxLength) fail(`${label} must not exceed ${maxLength} characters`)
  return value
}

function validateSchema(value: unknown, label: string): JsonObject {
  if (!isObject(value)) fail(`${label} must be a JSON object schema`)
  if (value.type !== undefined && (typeof value.type !== 'string' || !schemaTypes.has(value.type))) fail(`${label}.type must be a valid JSON Schema type`)
  if (value.properties !== undefined && !isObject(value.properties)) fail(`${label}.properties must be an object`)
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((item) => typeof item !== 'string' || !item.trim()))) fail(`${label}.required must be an array of strings`)
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean' && !isObject(value.additionalProperties)) fail(`${label}.additionalProperties must be a boolean or schema object`)
  return value
}

function validateMetadata(value: unknown): JsonObject {
  if (!isObject(value)) fail('metadata must be a JSON object')
  const serialized = JSON.stringify(value)
  if (new TextEncoder().encode(serialized).byteLength > MAX_METADATA_BYTES) fail(`metadata must not exceed ${MAX_METADATA_BYTES} bytes`)
  let keyCount = 0
  const visit = (item: unknown, depth: number): void => {
    if (depth > MAX_METADATA_DEPTH) fail(`metadata nesting must not exceed ${MAX_METADATA_DEPTH} levels`)
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1)
      return
    }
    if (!isObject(item)) {
      if (typeof item === 'string' && item.length > MAX_METADATA_STRING) fail(`metadata strings must not exceed ${MAX_METADATA_STRING} characters`)
      return
    }
    for (const [key, child] of Object.entries(item)) {
      keyCount += 1
      if (keyCount > MAX_METADATA_KEYS) fail(`metadata must not contain more than ${MAX_METADATA_KEYS} fields`)
      if (credentialKey(key)) fail(`metadata field ${key} is reserved for credentials`)
      visit(child, depth + 1)
    }
  }
  visit(value, 0)
  return value
}

function addDefinition(value: unknown): JsonObject {
  if (!isObject(value)) fail('add input must be a JSON object')
  const rawId = definitionField(value, 'toolId', 'tool_id')
  if (typeof rawId === 'string' && builtInToolIds.has(rawId)) fail(`tool ID is reserved: ${rawId}`)
  const namespace = requiredText(value.namespace, 'namespace', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(namespace) || namespace === 'builtin') fail('namespace must be a non-reserved identifier')
  const adapter = requiredText(value.adapter, 'adapter', 32)
  if (!adapters.has(adapter)) fail('adapter must be internal, http, openapi, or mcp')
  if (typeof rawId !== 'string' || !rawId.includes('/')) fail('add requires a canonical namespace/operation tool ID')
  const toolId = canonicalToolId(rawId, adapter, namespace)
  if (!toolId.includes('/') || toolId.split('/')[0] !== namespace || builtInToolIds.has(toolId) || toolId.startsWith('builtin/')) fail('add requires a non-reserved canonical tool ID in namespace/operation form')
  const description = requiredText(value.description, 'description', 4096)
  const target = requiredText(value.target, 'target', 2048)
  const operation = requiredText(value.operation, 'operation', 512)
  const inputSchema = validateSchema(definitionField(value, 'inputSchema', 'input_schema'), 'inputSchema')
  const outputSchema = validateSchema(definitionField(value, 'outputSchema', 'output_schema'), 'outputSchema')
  const risk = requiredText(value.risk, 'risk', 32)
  if (!risks.has(risk)) fail('risk must be read, write, delete, or external')
  const requiresApproval = definitionField(value, 'requiresApproval', 'requires_approval')
  const enabled = value.enabled
  if (typeof requiresApproval !== 'boolean') fail('requiresApproval must be a boolean')
  if (typeof enabled !== 'boolean') fail('enabled must be a boolean')
  const metadata = validateMetadata(value.metadata)
  return { toolId, namespace, description, adapter, target, operation, inputSchema, outputSchema, risk, requiresApproval, enabled, metadata }
}

function requireSession(parsed: ParsedOptions): string {
  if (!parsed.sessionId?.trim()) fail('call and approval commands require --session-id')
  return parsed.sessionId
}

function commandArgs(command: string, args: string[], count: number): void {
  if (args.length !== count) fail(`${command} expects ${count} argument${count === 1 ? '' : 's'}`)
}

function outputEnvelope(command: string, payload: unknown): JsonObject {
  return { ok: true, command, result: payload }
}

function errorEnvelope(command: string, error: unknown, token = ''): JsonObject {
  if (error instanceof RemoteError) return { ok: false, command, error: { code: error.code, message: redact(error.message, token), ...(error.status === undefined ? {} : { status: error.status }), ...(error.details === undefined ? {} : { details: redact(error.details, token) }) } }
  if (error instanceof CliError) return { ok: false, command, error: { code: error.code, message: error.message } }
  return { ok: false, command, error: { code: 'CLI_ERROR', message: 'CLI failed' } }
}

function print(io: CliIo, value: unknown, secret = ''): void {
  ;(io.stdout ?? ((text) => runtime().process?.stdout?.write(text)))(`${JSON.stringify(redact(value, secret))}\n`)
}

const hiddenHumanKeys = /^(?:details?|error|headers?|input|metadata|raw)$/i

function hiddenHumanKey(key: string): boolean {
  return hiddenHumanKeys.test(key) || credentialKey(key)
}

function humanScalar(value: unknown, secret: string): string {
  if (typeof value === 'string') {
    const redacted = redactString(value, secret)
    return redacted.length > 512 ? `${redacted.slice(0, 512)}...` : redacted
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  return ''
}

function appendHuman(lines: string[], key: string, value: unknown, indent: string, depth: number, secret: string): void {
  if (hiddenHumanKey(key) || depth > 3) return
  const scalar = humanScalar(value, secret)
  if (scalar) {
    lines.push(`${indent}${key}: ${scalar}`)
    return
  }
  if (Array.isArray(value)) {
    const scalars = value.map((item) => humanScalar(item, secret)).filter(Boolean).slice(0, 20)
    if (scalars.length === value.length) lines.push(`${indent}${key}: ${scalars.join(', ')}`)
    else if (value.length) {
      lines.push(`${indent}${key}:`)
      for (const item of value.slice(0, 20)) appendHuman(lines, 'item', item, `${indent}  `, depth + 1, secret)
    }
    return
  }
  if (isObject(value)) {
    const entries = Object.entries(value).filter(([childKey]) => !hiddenHumanKey(childKey)).slice(0, 32)
    if (!entries.length) return
    lines.push(`${indent}${key}:`)
    for (const [childKey, child] of entries) appendHuman(lines, childKey, child, `${indent}  `, depth + 1, secret)
  }
}

function humanResult(command: string, payload: unknown, secret: string): string {
  const result = object(payload)
  const pending = result.ok === false && result.approvalRequired === true
  const lines = [pending ? `${command}: approval pending` : `${command}: succeeded`]
  for (const [key, value] of Object.entries(result)) {
    if (key === 'ok' || (pending && key === 'approvalRequired')) continue
    appendHuman(lines, key, value, '', 0, secret)
  }
  return `${lines.join('\n')}\n`
}

function printResult(io: CliIo, json: boolean, command: string, payload: unknown, secret: string): void {
  if (json) print(io, outputEnvelope(command, payload), secret)
  else (io.stdout ?? ((text) => runtime().process?.stdout?.write(text)))(humanResult(command, payload, secret))
}

function approvalPending(payload: unknown): boolean {
  const result = object(payload)
  return result.ok === false && (result.approvalRequired === true || result.status === 'approval_required')
}

async function eventsCommand(parsed: ParsedOptions, base: string, token: string, fetcher: Fetcher, io: CliIo, signal?: AbortSignal): Promise<number> {
  const query = parsed.sessionId ? `?sessionId=${encodeURIComponent(parsed.sessionId)}` : ''
  return withRequest(base, token, parsed.timeout, fetcher, `/api/sse/stream${query}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
  }, async (response) => {
    if (!response.ok) {
      const text = await response.text()
      let payload: unknown = {}
      try { payload = JSON.parse(text) } catch { payload = { message: text } }
      throw remoteError(response, payload, token)
    }
    if (!response.body) throw new CliError('EVENT_STREAM_EMPTY', 'The gateway returned no event stream', EXIT_REMOTE)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let event = 'message'
    let data: string[] = []
    const emit = (): void => {
      if (!data.length) return
      const text = data.join('\n')
      let value: unknown = text
      try { value = JSON.parse(text) } catch { /* JSONL still carries the text as data. */ }
      print(io, { ok: true, command: 'events', event, data: value }, token)
      event = 'message'
      data = []
    }
    while (true) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim() || 'message'
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
        }
        emit()
      }
      if (chunk.done) break
    }
    if (buffer) {
      for (const line of buffer.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim() || 'message'
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      }
      emit()
    }
    return EXIT_OK
  }, signal)
}

function cancellationSetup(options: CliOptions): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const process = runtime().process
  const onCancel = (): void => controller.abort()
  const listeners: Array<'SIGINT' | 'SIGTERM'> = []
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', onCancel, { once: true })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    if (process?.on) {
      process.on(signal, onCancel)
      listeners.push(signal)
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      options.signal?.removeEventListener('abort', onCancel)
      for (const signal of listeners) {
        if (process?.off) process.off(signal, onCancel)
        else process?.removeListener?.(signal, onCancel)
      }
    },
  }
}

export async function runCli(argv: string[], options: CliOptions = {}, io: CliIo = {}): Promise<number> {
  let parsed: ParsedCommand | undefined
  let token = ''
  const cancellation = cancellationSetup(options)
  try {
    parsed = parseOptions(argv)
    token = await tokenValue(parsed.options, options)
    const base = baseUrl(parsed.options, options)
    const fetcher = options.fetch ?? defaultFetch
    const { command, args, options: flags } = parsed

    if (command === 'health') {
      commandArgs(command, args, 0)
      printResult(io, flags.json, command, await requestJson(base, token, flags.timeout, fetcher, '/api/v1/health', 'GET', undefined, cancellation.signal), token)
      return EXIT_OK
    }
    if (command === 'list') {
      commandArgs(command, args, 0)
      printResult(io, flags.json, command, await requestJson(base, token, flags.timeout, fetcher, '/api/subpolar-cli/tools/list', 'POST', contextBody(flags), cancellation.signal), token)
      return EXIT_OK
    }
    if (command === 'query') {
      commandArgs(command, args, 1)
      if (!args[0].trim()) fail('query text must not be empty')
      printResult(io, flags.json, command, await requestJson(base, token, flags.timeout, fetcher, '/api/subpolar-cli/tools/search', 'POST', { ...contextBody(flags), query: args[0] }, cancellation.signal), token)
      return EXIT_OK
    }
    if (command === 'describe') {
      commandArgs(command, args, 1)
      const toolId = canonicalToolId(args[0])
      printResult(io, flags.json, command, await requestJson(base, token, flags.timeout, fetcher, '/api/subpolar-cli/tools/describe', 'POST', { ...contextBody(flags), toolId }, cancellation.signal), token)
      return EXIT_OK
    }
    if (command === 'add') {
      commandArgs(command, args, 0)
      const body = addDefinition(await inputValue(flags, command, options))
      printResult(io, flags.json, command, await requestJson(base, token, flags.timeout, fetcher, '/api/subpolar-cli/tools/register', 'POST', body, cancellation.signal), token)
      return EXIT_OK
    }
    if (command === 'call') {
      commandArgs(command, args, 1)
      const toolId = canonicalToolId(args[0])
      const input = await inputValue(flags, command, options)
      const result = await requestJson(base, token, flags.timeout, fetcher, '/api/subpolar-cli/tools/call', 'POST', {
        ...contextBody(flags),
        toolId,
        input,
        sessionId: requireSession(flags),
        ...(flags.cwd === undefined ? {} : { cwd: flags.cwd }),
        ...(flags.callId === undefined ? {} : { callId: flags.callId }),
        ...(flags.permissionOverride === undefined ? {} : { permissionOverride: flags.permissionOverride }),
        ...(flags.wait ? { waitForApproval: true } : {}),
      }, cancellation.signal)
      printResult(io, flags.json, command, result, token)
      return approvalPending(result) ? EXIT_REMOTE : EXIT_OK
    }
    if (command === 'approvals') {
      if (!args[0]) fail('approvals requires list, continue, or reject')
      if (args[0] === 'list') {
        commandArgs('approvals list', args, 1)
        const query = flags.sessionId ? `?sessionId=${encodeURIComponent(flags.sessionId)}` : ''
        printResult(io, flags.json, command, await requestJson(base, token, flags.timeout, fetcher, `/api/permission${query}`, 'GET', undefined, cancellation.signal), token)
        return EXIT_OK
      }
      if (args[0] === 'continue') {
        commandArgs('approvals continue', args, 2)
        const result = await requestJson(base, token, flags.timeout, fetcher, '/api/subpolar-cli/tools/continue', 'POST', { ...contextBody(flags), approvalId: args[1], sessionId: requireSession(flags), ...(flags.callId === undefined ? {} : { callId: flags.callId }) }, cancellation.signal)
        printResult(io, flags.json, command, result, token)
        return approvalPending(result) ? EXIT_REMOTE : EXIT_OK
      }
      if (args[0] === 'reject') {
        commandArgs('approvals reject', args, 2)
        const sessionId = requireSession(flags)
        if (!args[1].trim()) fail('approvals reject requires an approval ID')
        printResult(io, flags.json, command, await requestJson(base, token, flags.timeout, fetcher, `/api/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(args[1])}`, 'POST', { response: 'reject' }, cancellation.signal), token)
        return EXIT_OK
      }
      fail('approvals requires list, continue, or reject')
    }
    if (command === 'events') {
      commandArgs(command, args, 0)
      return await eventsCommand(flags, base, token, fetcher, io, cancellation.signal)
    }
    fail(`Unknown command: ${command}`)
  } catch (error) {
    const command = parsed?.command ?? 'unknown'
    const exitCode = error instanceof CliError ? error.exitCode : error instanceof RemoteError ? EXIT_REMOTE : EXIT_REMOTE
    const output = errorEnvelope(command, error, token)
    if (parsed?.options.json) {
      if (io.stdout) print(io, output, token)
      else (io.stderr ?? ((text) => runtime().process?.stderr?.write(text)))(`${JSON.stringify(redact(output, token))}\n`)
    } else {
      const message = error instanceof RemoteError ? `${error.code}: ${redact(error.message, token)}` : error instanceof CliError ? error.message : 'CLI failed'
      ;(io.stdout ?? io.stderr ?? ((text) => runtime().process?.stderr?.write(text)))(`${message}\n`)
    }
    return exitCode
  } finally {
    cancellation.cleanup()
  }
}

const entryProcess = runtime().process;
if (entryProcess?.argv && entryProcess.argv[1]?.endsWith('/src/cli.ts')) {
  runCli(entryProcess.argv.slice(2)).then((exitCode) => {
    if (entryProcess) (entryProcess as { exitCode?: number }).exitCode = exitCode
  })
}
