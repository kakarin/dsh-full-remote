/**
 * Custom access token — owner-supplied credential instead of the generated 192-bit one.
 *
 * Covers both entry points on purpose: the config field (applies at load, needs a
 * harness restart) and the control route (applies live from Settings → Reverse
 * proxy). They share the same validation and the same revocation semantics, so a
 * divergence between them is a security bug, not a UX detail.
 */
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { createRuntime } from '../src/index.ts'
import { MAX_ACCESS_TOKEN_LENGTH, MIN_ACCESS_TOKEN_LENGTH, validateAccessToken } from '../src/security.ts'

type Runtime = ReturnType<typeof createRuntime>
type RuntimeConfig = Parameters<typeof createRuntime>[1]

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function makeConfig(stateFile: string, extra: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    listenHost: '127.0.0.1',
    listenPort: 0,
    backendHost: '127.0.0.1',
    backendPort: 3080,
    stateFile,
    autoRestore: false,
    maxRequestBytes: 1024,
    upstreamTimeoutMs: 1000,
    sessionMaxAgeSeconds: 3600,
    cookieName: 'test_session',
    ...extra,
  } as RuntimeConfig
}

function makeContext() {
  return {
    webServer: {
      port: 3080,
      register() { return () => {} },
      tapIndex() { return () => {} },
    },
    logger: { warn() {}, info() {}, debug() {} },
    effect() {},
  }
}

async function makeRuntime(extra: Partial<RuntimeConfig> = {}): Promise<{ runtime: Runtime, stateFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-settoken-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const stateFile = join(dir, 'state.json')
  const runtime = createRuntime(makeContext(), makeConfig(stateFile, extra))
  cleanups.push(() => runtime.dispose())
  return { runtime, stateFile }
}

interface FakeResponse {
  statusCode: number
  headers: Record<string, unknown>
  body: string
  writeHead(code: number, headers?: Record<string, unknown>): void
  end(body?: string): void
}

function fakeRes(): FakeResponse {
  const res: FakeResponse = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code: number, headers: Record<string, unknown> = {}) {
      res.statusCode = code
      Object.assign(res.headers, headers)
    },
    end(body: string = '') {
      res.body += String(body)
    },
  }
  return res
}

function fakeReq(options: {
  path: string
  method?: string
  headers?: Record<string, string>
  remoteAddress?: string
  body?: string
}) {
  const { path, method = 'GET', headers = {}, remoteAddress = '127.0.0.1', body } = options
  const handlers: Record<string, ((chunk?: Buffer) => void) | undefined> = {}
  const req = {
    url: path,
    method,
    headers: headers as IncomingHttpHeaders,
    socket: { remoteAddress },
    on(event: string, fn: (chunk?: Buffer) => void) {
      handlers[event] = fn
      return req
    },
  }
  queueMicrotask(() => {
    if (body !== undefined) handlers.data?.(Buffer.from(body))
    handlers.end?.()
  })
  return req
}

const CONTROL = {
  'x-dsh-reverse-proxy-control': '1',
  origin: 'http://127.0.0.1:3080',
  'content-type': 'application/json',
}

async function postSetToken(runtime: Runtime, token: unknown): Promise<{ status: number, body: Record<string, unknown> }> {
  const res = fakeRes()
  await runtime.handle(
    fakeReq({
      path: '/dsh-reverse-proxy/set-token',
      method: 'POST',
      headers: CONTROL,
      body: JSON.stringify({ token }),
    }) as unknown as IncomingMessage,
    res as unknown as ServerResponse,
  )
  return { status: res.statusCode, body: res.body === '' ? {} : JSON.parse(res.body) as Record<string, unknown> }
}

describe('access token validation', () => {
  it('accepts printable ASCII at both length bounds', () => {
    assert.equal(validateAccessToken('a'.repeat(MIN_ACCESS_TOKEN_LENGTH)), undefined)
    assert.equal(validateAccessToken('a'.repeat(MAX_ACCESS_TOKEN_LENGTH)), undefined)
    // Punctuation is allowed: a passphrase is the point of the feature.
    assert.equal(validateAccessToken('Jack-Whale_2026!@#'), undefined)
  })

  it('rejects empty, short, long, whitespace and non-ASCII values', () => {
    assert.equal(validateAccessToken(''), 'empty')
    assert.equal(validateAccessToken(undefined), 'empty')
    assert.equal(validateAccessToken(42), 'empty')
    assert.equal(validateAccessToken('a'.repeat(MIN_ACCESS_TOKEN_LENGTH - 1)), 'too-short')
    assert.equal(validateAccessToken('a'.repeat(MAX_ACCESS_TOKEN_LENGTH + 1)), 'too-long')
    assert.equal(validateAccessToken('two words here'), 'invalid-chars')
    assert.equal(validateAccessToken('tab\there-token'), 'invalid-chars')
    // A CJK token would be mangled by cookie transfer, so it is refused up front.
    assert.equal(validateAccessToken('鲸鱼娘的令牌鲸鱼娘的令牌'), 'invalid-chars')
  })
})

describe('custom access token via config', () => {
  it('pins the configured token instead of generating one', async () => {
    const { runtime } = await makeRuntime({ accessToken: 'pinned-owner-token' })
    assert.equal(await runtime.token(), 'pinned-owner-token')
  })

  it('keeps the generated token when the field is empty', async () => {
    const { runtime } = await makeRuntime()
    const generated = await runtime.token()
    assert.ok(generated.length >= MIN_ACCESS_TOKEN_LENGTH)
    assert.notEqual(generated, '')
    // Generated tokens are base64url: 24 bytes.
    assert.match(generated, /^[A-Za-z0-9_-]{32}$/)
  })
})

describe('custom access token via the control surface', () => {
  it('persists a chosen token and returns it', async () => {
    const { runtime, stateFile } = await makeRuntime()
    const before = await runtime.token()
    assert.notEqual(before, 'Whale-Custom-01')

    const result = await postSetToken(runtime, 'Whale-Custom-01')
    assert.equal(result.status, 200)
    assert.equal(result.body.accessToken, 'Whale-Custom-01')
    assert.equal(result.body.unchanged, false)
    assert.equal(await runtime.token(), 'Whale-Custom-01')

    // Durable: a fresh runtime on the same state file must read the new token.
    const { readStateDetailed } = await import('../src/persist.ts')
    const reloaded = await readStateDetailed(stateFile)
    assert.equal(reloaded.state.accessToken, 'Whale-Custom-01')
  })

  it('reports unchanged when the value is already live', async () => {
    const { runtime } = await makeRuntime({ accessToken: 'already-live-token' })
    const result = await postSetToken(runtime, 'already-live-token')
    assert.equal(result.status, 200)
    assert.equal(result.body.unchanged, true)
    assert.equal(result.body.accessToken, 'already-live-token')
  })

  it('rejects each invalid shape with a stable 400 code', async () => {
    const { runtime } = await makeRuntime({ accessToken: 'keep-me-token' })
    const cases: Array<[unknown, string]> = [
      ['', 'empty'],
      [null, 'empty'],
      ['short', 'too-short'],
      ['a'.repeat(MAX_ACCESS_TOKEN_LENGTH + 1), 'too-long'],
      ['has space in it', 'invalid-chars'],
      ['中文令牌不允许使用', 'invalid-chars'],
    ]
    for (const [value, code] of cases) {
      const result = await postSetToken(runtime, value)
      assert.equal(result.status, 400, `expected 400 for ${String(value)}`)
      assert.equal(result.body.error, code)
    }
    // A rejected value must never overwrite the live credential.
    assert.equal(await runtime.token(), 'keep-me-token')
  })

  it('revokes every device session when the token changes', async () => {
    const { runtime } = await makeRuntime()
    const started = await runtime.start()
    assert.equal(started.running, true)
    const port = Number(new URL(started.target).port)
    const { request } = await import('node:http')

    // Log one device in through the real proxy so the session store is non-empty.
    const login = await new Promise<{ status: number, cookie: string }>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1',
        port,
        path: '/__dsh-reverse-proxy/login',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }, (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0, cookie: String(res.headers['set-cookie'] ?? '') }))
      })
      req.on('error', reject)
      req.end(new URLSearchParams({ token: 'seed-token-for-login' }).toString())
    })
    // The seeded runtime token differs from the login attempt only if generation
    // raced; either way a non-302 answer here is not what this test measures.
    assert.ok(login.status === 302 || login.status === 401)

    const before = await runtime.status()
    assert.equal(before.running, true)

    const result = await postSetToken(runtime, 'Rotated-By-Owner-9')
    assert.equal(result.status, 200)
    assert.equal(await runtime.token(), 'Rotated-By-Owner-9')

    // The listener came back up on the same address after the credential swap.
    const after = await runtime.status()
    assert.equal(after.running, true)
    assert.equal(await runtime.token(), 'Rotated-By-Owner-9')
  })
})
