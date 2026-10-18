import { describe, expect, test } from 'bun:test'
import { EXIT_CANCELLED, EXIT_REMOTE, EXIT_TIMEOUT, EXIT_USAGE, runCli } from '../src/cli.ts'

function fakeFetch(response: Response, seen: { url?: string; init?: RequestInit } = {}) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    seen.url = url
    seen.init = init
    return response
  }
}

function output(): { lines: string[]; io: { stdout: (text: string) => void; stderr: (text: string) => void } } {
  const lines: string[] = []
  return { lines, io: { stdout: (text) => lines.push(text), stderr: () => undefined } }
}

describe('subpolar-tools', () => {
  test('uses authenticated native HTTP for health', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    const captured = output()
    const exitCode = await runCli(['--base-url', 'https://gateway.example/', '--token', 'secret-token', '--json', 'health'], { fetch: fakeFetch(new Response('{"status":"healthy"}'), seen) }, captured.io)

    expect(exitCode).toBe(0)
    expect(seen.url).toBe('https://gateway.example/api/v1/health')
    expect(seen.init?.method).toBe('GET')
    expect((seen.init?.headers as Record<string, string>).authorization).toBe('Bearer secret-token')
    expect(captured.lines.join('')).not.toContain('secret-token')
    expect(JSON.parse(captured.lines[0])).toMatchObject({ ok: true, command: 'health', result: { status: 'healthy' } })
  })

  test('sends canonical call IDs, explicit session context, JSON input, and no implicit allow_all', async () => {
    const seen: { init?: RequestInit } = {}
    const captured = output()
    const exitCode = await runCli(['call', 'read', '--token', 'token', '--session-id', 'session-1', '--user-id', 'user-1', '--agent', 'master', '--cwd', '/project', '--call-id', 'call-1', '--input', '{"path":"README.md"}'], { fetch: fakeFetch(new Response('{"ok":true,"value":"ok"}'), seen) }, captured.io)

    expect(exitCode).toBe(0)
    expect(JSON.parse(String(seen.init?.body))).toEqual({ userId: 'user-1', agentName: 'master', toolId: 'read', input: { path: 'README.md' }, sessionId: 'session-1', cwd: '/project', callId: 'call-1' })
    expect(String(seen.init?.body)).not.toContain('allow_all')
  })

  test('reads piped JSON input', async () => {
    const seen: { init?: RequestInit } = {}
    const captured = output()
    const exitCode = await runCli(['call', 'acme/search', '--token', 'token', '--session-id', 's'], { fetch: fakeFetch(new Response('{"ok":true}'), seen), readStdin: async () => '{"q":"x"}', stdinIsTTY: () => false }, captured.io)

    expect(exitCode).toBe(0)
    expect(JSON.parse(String(seen.init?.body))).toMatchObject({ input: { q: 'x' }, sessionId: 's' })
  })

  test('returns remote structured errors and stable remote exit code', async () => {
    const captured = output()
    const exitCode = await runCli(['describe', 'bad id', '--token', 'token', '--json'], { fetch: fakeFetch(new Response('{"error":{"code":"UNKNOWN_TOOL","message":"no such tool"}}', { status: 404 })) }, captured.io)

    expect(exitCode).toBe(EXIT_USAGE)
    expect(JSON.parse(captured.lines.join(''))).toMatchObject({ ok: false, command: 'describe', error: { code: 'CLI_USAGE_ERROR' } })

    const remote = output()
    const remoteExit = await runCli(['list', '--token', 'token', '--json'], { fetch: fakeFetch(new Response('{"error":{"code":"NOPE","message":"denied"}}', { status: 403 })) }, remote.io)
    expect(remoteExit).toBe(EXIT_REMOTE)
    expect(JSON.parse(remote.lines.join(''))).toMatchObject({ ok: false, command: 'list', error: { code: 'NOPE', status: 403 } })

    const denied = output()
    const deniedExit = await runCli(['call', 'read', '--token', 'token', '--session-id', 's', '--json'], { fetch: fakeFetch(new Response('{"ok":false,"error":{"code":"PERMISSION_DENIED","message":"denied"}}')) }, denied.io)
    expect(deniedExit).toBe(EXIT_REMOTE)
    expect(JSON.parse(denied.lines.join(''))).toMatchObject({ ok: false, command: 'call', error: { code: 'PERMISSION_DENIED' } })
  })

  test('aborts timed out requests without exposing the token', async () => {
    const captured = output()
    const fetcher = async (_url: string, init?: RequestInit): Promise<Response> => await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
    const exitCode = await runCli(['health', '--token', 'timeout-secret', '--timeout', '5', '--json'], { fetch: fetcher }, captured.io)

    expect(exitCode).toBe(EXIT_TIMEOUT)
    expect(JSON.parse(captured.lines.join(''))).toMatchObject({ ok: false, error: { code: 'CLI_TIMEOUT' } })
    expect(captured.lines.join('')).not.toContain('timeout-secret')
  })

  test('emits SSE events as JSONL', async () => {
    const captured = output()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: connected\ndata: {"connected":1}\n\n'))
        controller.close()
      },
    })
    const exitCode = await runCli(['events', '--token', 'token'], { fetch: async () => new Response(body) }, captured.io)

    expect(exitCode).toBe(0)
    expect(captured.lines).toHaveLength(1)
    expect(JSON.parse(captured.lines[0])).toEqual({ ok: true, command: 'events', event: 'connected', data: { connected: 1 } })
  })

  test('prints human-readable output unless --json is selected', async () => {
    const captured = output()
    const exitCode = await runCli(['health', '--token', 'human-secret'], { fetch: fakeFetch(new Response('{"status":"healthy"}')) }, captured.io)

    expect(exitCode).toBe(0)
    expect(captured.lines.join('')).toContain('health: succeeded')
    expect(captured.lines.join('')).toContain('status: healthy')
    expect(captured.lines.join('')).not.toContain('{"ok":true')
    expect(captured.lines.join('')).not.toContain('human-secret')
  })

  test('redacts long tokens from human-readable responses', async () => {
    const captured = output()
    const token = 'human-response-secret'
    const exitCode = await runCli(['health', '--token', token], { fetch: fakeFetch(new Response(JSON.stringify({ message: `received ${token}` }))) }, captured.io)

    expect(exitCode).toBe(0)
    expect(captured.lines.join('')).toContain('message: received [REDACTED]')
    expect(captured.lines.join('')).not.toContain(token)
  })

  test('returns remote exit code while preserving pending approval JSON', async () => {
    const captured = output()
    const exitCode = await runCli(['call', 'read', '--token', 'approval-secret', '--session-id', 's', '--json'], { fetch: fakeFetch(new Response('{"ok":false,"approvalRequired":true,"approvalId":"approval-1"}')) }, captured.io)

    expect(exitCode).toBe(EXIT_REMOTE)
    expect(JSON.parse(captured.lines.join(''))).toMatchObject({ ok: true, result: { ok: false, approvalRequired: true, approvalId: 'approval-1' } })
  })

  test('returns the same pending exit for approval continuation', async () => {
    const captured = output()
    const exitCode = await runCli(['approvals', 'continue', 'approval-1', '--token', 'approval-secret', '--session-id', 's', '--json'], { fetch: fakeFetch(new Response('{"ok":false,"approvalRequired":true,"approvalId":"approval-1"}')) }, captured.io)

    expect(exitCode).toBe(EXIT_REMOTE)
    expect(JSON.parse(captured.lines.join(''))).toMatchObject({ ok: true, command: 'approvals', result: { approvalRequired: true } })
  })

  test('cancels an in-flight request with a stable cancellation result', async () => {
    const controller = new AbortController()
    const captured = output()
    const fetcher = async (_url: string, init?: RequestInit): Promise<Response> => await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
    setTimeout(() => controller.abort(), 5)
    const exitCode = await runCli(['health', '--token', 'cancel-secret', '--json'], { fetch: fetcher, signal: controller.signal }, captured.io)

    expect(exitCode).toBe(EXIT_CANCELLED)
    expect(JSON.parse(captured.lines.join(''))).toMatchObject({ ok: false, error: { code: 'CLI_CANCELLED', message: 'Request cancelled' } })
  })

  test('rejects malformed and reserved add definitions before making a request', async () => {
    const captured = output()
    let requests = 0
    const fetcher = async (): Promise<Response> => {
      requests += 1
      return new Response('{}')
    }
    const valid = { toolId: 'acme/search', namespace: 'acme', description: 'Search', adapter: 'http', target: 'https://example.test', operation: 'GET', inputSchema: {}, outputSchema: {}, risk: 'read', requiresApproval: false, enabled: true, metadata: {} }
    const invalid = { ...valid, toolId: 'read' }
    const exitCode = await runCli(['add', '--token', 'add-secret', '--json', '--input', JSON.stringify(invalid)], { fetch: fetcher }, captured.io)

    expect(exitCode).toBe(EXIT_USAGE)
    expect(requests).toBe(0)
    expect(JSON.parse(captured.lines.join(''))).toMatchObject({ ok: false, error: { code: 'CLI_USAGE_ERROR' } })

    const malformed = output()
    const malformedExit = await runCli(['add', '--token', 'add-secret', '--json', '--input', JSON.stringify({ ...valid, adapter: 'wat' })], { fetch: fetcher }, malformed.io)
    expect(malformedExit).toBe(EXIT_USAGE)
    expect(JSON.parse(malformed.lines.join(''))).toMatchObject({ ok: false, error: { code: 'CLI_USAGE_ERROR' } })

    const malformedSchema = output()
    const malformedSchemaExit = await runCli(['add', '--token', 'add-secret', '--json', '--input', JSON.stringify({ ...valid, inputSchema: [] })], { fetch: fetcher }, malformedSchema.io)
    expect(malformedSchemaExit).toBe(EXIT_USAGE)
    expect(JSON.parse(malformedSchema.lines.join(''))).toMatchObject({ ok: false, error: { code: 'CLI_USAGE_ERROR' } })
  })

  test('does not redact a short token inside ordinary output', async () => {
    const captured = output()
    const exitCode = await runCli(['health', '--token', 'token', '--json'], { fetch: fakeFetch(new Response('{"message":"tokenizer"}')) }, captured.io)

    expect(exitCode).toBe(0)
    expect(JSON.parse(captured.lines.join(''))).toMatchObject({ result: { message: 'tokenizer' } })
    expect(captured.lines.join('')).not.toContain('[REDACTED]')
  })

  test('redacts a short token when it is the exact response value', async () => {
    const captured = output()
    const exitCode = await runCli(['health', '--token', 'token', '--json'], { fetch: fakeFetch(new Response('{"message":"token"}')) }, captured.io)

    expect(exitCode).toBe(0)
    expect(JSON.parse(captured.lines.join(''))).toMatchObject({ result: { message: '[REDACTED]' } })
  })

  test('redacts sensitive keys recursively in JSON output while preserving safe text', async () => {
    const captured = output()
    const response = {
      message: 'tokenizer is safe ordinary text',
      shortCredential: 'token',
      nested: {
        refresh_token: 'refresh-secret',
        refreshToken: 'refresh-secret-camel',
        privateKey: 'private-secret',
        private_key: 'private-secret-snake',
        cookie: 'cookie-secret',
        'set-cookie': 'set-cookie-secret',
        client_secret: 'client-secret',
        access_token: 'access-secret',
        authorization: 'authorization-secret',
        safe: 'ordinary text',
      },
    }
    const exitCode = await runCli(['health', '--token', 'token', '--json'], { fetch: fakeFetch(new Response(JSON.stringify(response))) }, captured.io)

    expect(exitCode).toBe(0)
    expect(JSON.parse(captured.lines.join(''))).toMatchObject({
      result: {
        message: 'tokenizer is safe ordinary text',
        shortCredential: '[REDACTED]',
        nested: {
          refresh_token: '[REDACTED]',
          refreshToken: '[REDACTED]',
          privateKey: '[REDACTED]',
          private_key: '[REDACTED]',
          cookie: '[REDACTED]',
          'set-cookie': '[REDACTED]',
          client_secret: '[REDACTED]',
          access_token: '[REDACTED]',
          authorization: '[REDACTED]',
          safe: 'ordinary text',
        },
      },
    })
  })

  test('omits recursively sensitive keys from human output while preserving safe text', async () => {
    const captured = output()
    const response = {
      message: 'tokenizer is safe ordinary text',
      nested: {
        refresh_token: 'refresh-secret',
        refreshToken: 'refresh-secret-camel',
        privateKey: 'private-secret',
        private_key: 'private-secret-snake',
        cookie: 'cookie-secret',
        'set-cookie': 'set-cookie-secret',
        client_secret: 'client-secret',
        access_token: 'access-secret',
        authorization: 'authorization-secret',
        safe: 'ordinary text',
      },
    }
    const exitCode = await runCli(['health', '--token', 'token'], { fetch: fakeFetch(new Response(JSON.stringify(response))) }, captured.io)
    const text = captured.lines.join('')

    expect(exitCode).toBe(0)
    expect(text).toContain('message: tokenizer is safe ordinary text')
    expect(text).toContain('safe: ordinary text')
    expect(text).not.toContain('refresh-secret')
    expect(text).not.toContain('private-secret')
    expect(text).not.toContain('cookie-secret')
    expect(text).not.toContain('client-secret')
    expect(text).not.toContain('access-secret')
    expect(text).not.toContain('authorization-secret')
  })

  test('redacts prefixed and suffixed credential keys with short and long values', async () => {
    const response = {
      message: 'tokenizer and secretariat are ordinary words',
      'x-api-key': 'short-key',
      'x-auth-token': 'a-very-long-auth-token-value',
      request_password_value: 'short-password',
      privateKeyId: 'a-very-long-private-key-value',
      safe: 'ordinary text',
    }

    const json = output()
    const jsonExit = await runCli(['health', '--token', 'token', '--json'], { fetch: fakeFetch(new Response(JSON.stringify(response))) }, json.io)
    expect(jsonExit).toBe(0)
    expect(JSON.parse(json.lines.join(''))).toMatchObject({
      result: {
        message: 'tokenizer and secretariat are ordinary words',
        'x-api-key': '[REDACTED]',
        'x-auth-token': '[REDACTED]',
        request_password_value: '[REDACTED]',
        privateKeyId: '[REDACTED]',
        safe: 'ordinary text',
      },
    })

    const human = output()
    const humanExit = await runCli(['health', '--token', 'token'], { fetch: fakeFetch(new Response(JSON.stringify(response))) }, human.io)
    const text = human.lines.join('')
    expect(humanExit).toBe(0)
    expect(text).toContain('message: tokenizer and secretariat are ordinary words')
    expect(text).toContain('safe: ordinary text')
    expect(text).not.toContain('short-key')
    expect(text).not.toContain('a-very-long-auth-token-value')
    expect(text).not.toContain('short-password')
    expect(text).not.toContain('a-very-long-private-key-value')
  })

  test('uses environment credentials and has a usage exit code for missing arguments', async () => {
    const captured = output()
    const exitCode = await runCli(['call', 'read', '--session-id', 's'], { env: { SUBPOLAR_TOOLS_TOKEN: 'env-token' }, fetch: fakeFetch(new Response('{"ok":true}')) }, captured.io)
    expect(exitCode).toBe(0)

    const invalid = output()
    const invalidExit = await runCli(['call', 'read', '--token', 'token'], { fetch: fakeFetch(new Response('{}')) }, invalid.io)
    expect(invalidExit).toBe(EXIT_USAGE)
  })

  test('source contains no forbidden runtime imports', async () => {
    const source = await Bun.file(new URL('../src/cli.ts', import.meta.url)).text()
    expect(source).not.toMatch(/from\s+['"](?:[^'"]*subpolar-core|[^'"]*pocketbase|[^'"]*hono|[^'"]*react|[^'"]*pi[^'"]*)['"]/) 
    expect(source).not.toMatch(/import\s+['"](?:[^'"]*subpolar-core|[^'"]*pocketbase|[^'"]*hono|[^'"]*react|[^'"]*pi[^'"]*)['"]/) 
  })
})
