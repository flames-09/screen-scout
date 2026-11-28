import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  googleExchangeCode,
  googleRefreshIdToken,
  isValidLoopbackRedirect,
  parseFormBody,
  type GoogleOAuthEnv
} from '../relay/src/google-oauth'

const env = {
  GOOGLE_CLIENT_ID: 'cid',
  GOOGLE_CLIENT_SECRET: 'sec'
} as GoogleOAuthEnv

interface SeenCall {
  url: string
  init: { method: string; headers: Record<string, string>; body: string }
}

/** Installs a fetch stub that records the call and replies with a canned body. */
function stubFetch(status: number, body: unknown, replyError?: Error): { calls: SeenCall[] } {
  const calls: SeenCall[] = []
  const impl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      init: {
        method: (init?.method as string) ?? 'GET',
        headers: (init?.headers as Record<string, string>) ?? {},
        body: (init?.body as string) ?? ''
      }
    })
    if (replyError) throw replyError
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  }
  vi.stubGlobal('fetch', vi.fn(impl))
  return { calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('googleExchangeCode', () => {
  it('sends the secret-bearing form and maps the success payload', async () => {
    const { calls } = stubFetch(200, { id_token: 'tok-abc-1234567890-xyz', refresh_token: 'rt-1' })

    const out = await googleExchangeCode(env, 'auth-code', 'verifier-43-chars-aaaaaaaaaaaaaaaaaaaaaaa', 'http://127.0.0.1:41234/callback')

    expect(out).toEqual({ ok: true, idToken: 'tok-abc-1234567890-xyz', refreshToken: 'rt-1' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(calls[0].init.body)
    expect(form.get('client_id')).toBe('cid')
    expect(form.get('client_secret')).toBe('sec')
    expect(form.get('code')).toBe('auth-code')
    expect(form.get('code_verifier')).toBe('verifier-43-chars-aaaaaaaaaaaaaaaaaaaaaaa')
    expect(form.get('redirect_uri')).toBe('http://127.0.0.1:41234/callback')
    expect(form.get('grant_type')).toBe('authorization_code')
  })

  it('maps a 400 from Google to kind invalid', async () => {
    stubFetch(400, { error: 'invalid_grant' })
    const out = await googleExchangeCode(env, 'bad', 'v'.repeat(43), 'http://127.0.0.1:41234/callback')
    expect(out).toEqual({ ok: false, kind: 'invalid' })
  })

  it('maps a 5xx from Google to kind upstream', async () => {
    stubFetch(503, { error: 'backend_error' })
    const out = await googleExchangeCode(env, 'x', 'v'.repeat(43), 'http://127.0.0.1:41234/callback')
    expect(out).toEqual({ ok: false, kind: 'upstream' })
  })

  it('maps a network throw to kind upstream', async () => {
    stubFetch(200, {}, new Error('dns fail'))
    const out = await googleExchangeCode(env, 'x', 'v'.repeat(43), 'http://127.0.0.1:41234/callback')
    expect(out).toEqual({ ok: false, kind: 'upstream' })
  })

  it('treats a 200 without an id_token as invalid', async () => {
    stubFetch(200, { access_token: 'at' })
    const out = await googleExchangeCode(env, 'x', 'v'.repeat(43), 'http://127.0.0.1:41234/callback')
    expect(out).toEqual({ ok: false, kind: 'invalid' })
  })
})

describe('googleRefreshIdToken', () => {
  it('sends the refresh grant and maps the id token', async () => {
    const { calls } = stubFetch(200, { id_token: 'tok-refresh-1234567890' })

    const out = await googleRefreshIdToken(env, 'rt-xyz')

    expect(out).toEqual({ ok: true, idToken: 'tok-refresh-1234567890', refreshToken: null })
    expect(calls).toHaveLength(1)
    const form = new URLSearchParams(calls[0].init.body)
    expect(form.get('client_id')).toBe('cid')
    expect(form.get('client_secret')).toBe('sec')
    expect(form.get('refresh_token')).toBe('rt-xyz')
    expect(form.get('grant_type')).toBe('refresh_token')
  })

  it('normalizes a missing refresh token in the reply to null', async () => {
    stubFetch(200, { id_token: 'tok-nr-1234567890-xyz', refresh_token: 42 })
    const out = await googleRefreshIdToken(env, 'rt')
    expect(out).toEqual({ ok: true, idToken: 'tok-nr-1234567890-xyz', refreshToken: null })
  })

  it('maps a 401 from Google to kind invalid', async () => {
    stubFetch(401, { error: 'invalid_grant' })
    const out = await googleRefreshIdToken(env, 'expired')
    expect(out).toEqual({ ok: false, kind: 'invalid' })
  })
})

describe('isValidLoopbackRedirect', () => {
  it('accepts loopback IPv4/IPv6 callbacks on any port', () => {
    expect(isValidLoopbackRedirect('http://127.0.0.1:41234/callback')).toBe(true)
    expect(isValidLoopbackRedirect('http://127.0.0.1:1/callback')).toBe(true)
    expect(isValidLoopbackRedirect('http://[::1]:9999/callback')).toBe(true)
  })

  it('rejects non-loopback hosts, schemes, ports, and paths', () => {
    expect(isValidLoopbackRedirect('http://localhost:41234/callback')).toBe(false)
    expect(isValidLoopbackRedirect('https://127.0.0.1:41234/callback')).toBe(false)
    expect(isValidLoopbackRedirect('http://127.0.0.1/callback')).toBe(false)
    expect(isValidLoopbackRedirect('http://127.0.0.1:41234/other')).toBe(false)
    expect(isValidLoopbackRedirect('http://evil.example/callback')).toBe(false)
    expect(isValidLoopbackRedirect('')).toBe(false)
    expect(isValidLoopbackRedirect('http://127.0.0.1:99999999/callback')).toBe(false)
  })
})

describe('parseFormBody', () => {
  it('parses urlencoded fields', () => {
    const form = parseFormBody('code=a%2Fb&code_verifier=' + 'v'.repeat(43))
    expect(form.get('code')).toBe('a/b')
    expect(form.get('code_verifier')).toBe('v'.repeat(43))
  })
})
