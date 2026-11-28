import { describe, expect, it } from 'vitest'
import {
  decodeIdTokenEmail,
  pkcePair,
  refreshGoogleIdToken,
  runGoogleAuthFlow,
  type GoogleAuthFlowDeps,
  type TokenFetchLike
} from '../src/main/ai/google-auth'

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com'

function makeIdToken(payload: Record<string, unknown>): string {
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`
}

/** Fake Google token endpoint: asserts the form body and returns id/refresh tokens. */
function tokenFetch(): TokenFetchLike {
  return async (url, init) => {
    if (!url.includes('oauth2.googleapis.com/token')) {
      return { ok: false, status: 404, json: async () => ({}) }
    }
    const body = new URLSearchParams(init.body)
    if (body.get('grant_type') !== 'authorization_code') {
      return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id_token: makeIdToken({ sub: 'sub-1', email: 'user@example.com' }),
        refresh_token: 'rt-123',
        access_token: 'at-123'
      })
    }
  }
}

function flowDeps(overrides: Partial<GoogleAuthFlowDeps> = {}): GoogleAuthFlowDeps {
  return {
    clientId: CLIENT_ID,
    openExternal: async () => undefined,
    fetchImpl: tokenFetch(),
    ...overrides
  }
}

/** Simulates the browser: parses the auth URL and hits the flow's loopback redirect. */
function fakeBrowser(outcome: 'ok' | 'denied' | 'evil-state'): GoogleAuthFlowDeps['openExternal'] {
  return async (authUrl) => {
    const u = new URL(authUrl)
    const redirect = u.searchParams.get('redirect_uri') ?? ''
    const state = u.searchParams.get('state') ?? ''
    if (outcome === 'denied') {
      await fetch(`${redirect}?error=access_denied&state=${encodeURIComponent(state)}`)
    } else if (outcome === 'evil-state') {
      await fetch(`${redirect}?code=good-code&state=TAMPERED`)
    } else {
      await fetch(`${redirect}?code=good-code&state=${encodeURIComponent(state)}`)
    }
  }
}

describe('pkcePair', () => {
  it('produces a 43-char verifier and matching S256 challenge', async () => {
    const { verifier, challenge } = pkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(verifier)))
      .toString('base64url')
    expect(challenge).toBe(digest)
  })
})

describe('runGoogleAuthFlow', () => {
  it('signs in end-to-end via the loopback redirect (PKCE verified server-side)', async () => {
    const result = await runGoogleAuthFlow(flowDeps({ openExternal: fakeBrowser('ok') }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.refreshToken).toBe('rt-123')
      expect(decodeIdTokenEmail(result.idToken)).toBe('user@example.com')
    }
  })

  it('reports denial when Google returns access_denied', async () => {
    const result = await runGoogleAuthFlow(flowDeps({ openExternal: fakeBrowser('denied') }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('denied')
  })

  it('rejects a tampered state parameter', async () => {
    const result = await runGoogleAuthFlow(flowDeps({ openExternal: fakeBrowser('evil-state') }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('state-mismatch')
  })

  it('fails with no-client-id when the build ships without one', async () => {
    const result = await runGoogleAuthFlow(flowDeps({ clientId: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('no-client-id')
  })

  it('times out when the browser never redirects', async () => {
    const result = await runGoogleAuthFlow(flowDeps({ timeoutMs: 150 }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('timeout')
  })
})

describe('refreshGoogleIdToken', () => {
  it('exchanges a refresh token for a new id token', async () => {
    const fetchImpl: TokenFetchLike = async (url, init) => {
      expect(url).toContain('oauth2.googleapis.com/token')
      const body = new URLSearchParams(init.body)
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('refresh_token')).toBe('rt-9')
      return { ok: true, status: 200, json: async () => ({ id_token: makeIdToken({ sub: 's' }) }) }
    }
    const result = await refreshGoogleIdToken(CLIENT_ID, 'rt-9', fetchImpl)
    expect(result.ok).toBe(true)
  })

  it('maps a revoked token to a friendly failure', async () => {
    const fetchImpl: TokenFetchLike = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' })
    })
    const result = await refreshGoogleIdToken(CLIENT_ID, 'rt-dead', fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/expired/i)
  })
})

describe('decodeIdTokenEmail', () => {
  it('reads the display email from the payload', () => {
    expect(decodeIdTokenEmail(makeIdToken({ email: 'a@b.c' }))).toBe('a@b.c')
  })
  it('returns null for garbage or missing email', () => {
    expect(decodeIdTokenEmail('not-a-jwt')).toBeNull()
    expect(decodeIdTokenEmail(makeIdToken({ sub: 'x' }))).toBeNull()
  })
})

describe('broker endpoint overrides', () => {
  it('sends the exchange to the relay broker URL when provided', async () => {
    const seen: string[] = []
    const fetchImpl: TokenFetchLike = async (url, init) => {
      seen.push(url)
      const body = new URLSearchParams(init.body)
      expect(body.get('grant_type')).toBe('authorization_code')
      return {
        ok: true,
        status: 200,
        json: async () => ({ id_token: makeIdToken({ sub: 'sub-1', email: 'user@example.com' }) })
      }
    }
    const result = await runGoogleAuthFlow(
      flowDeps({
        openExternal: fakeBrowser('ok'),
        fetchImpl,
        exchangeUrl: 'https://relay.example/v1/auth/google/exchange'
      })
    )
    expect(result.ok).toBe(true)
    expect(seen).toEqual(['https://relay.example/v1/auth/google/exchange'])
  })

  it('keeps hitting Google directly when no override is set', async () => {
    const seen: string[] = []
    const fetchImpl: TokenFetchLike = async (url) => {
      seen.push(url)
      return {
        ok: true,
        status: 200,
        json: async () => ({ id_token: makeIdToken({ sub: 'sub-1' }) })
      }
    }
    const result = await runGoogleAuthFlow(flowDeps({ openExternal: fakeBrowser('ok'), fetchImpl }))
    expect(result.ok).toBe(true)
    expect(seen).toEqual(['https://oauth2.googleapis.com/token'])
  })

  it('refreshes via the relay broker URL when provided', async () => {
    const seen: string[] = []
    const fetchImpl: TokenFetchLike = async (url, init) => {
      seen.push(url)
      const body = new URLSearchParams(init.body)
      expect(body.get('grant_type')).toBe('refresh_token')
      return { ok: true, status: 200, json: async () => ({ id_token: makeIdToken({ sub: 'sub-1' }) }) }
    }
    const result = await refreshGoogleIdToken(
      CLIENT_ID,
      'rt-1',
      fetchImpl,
      'https://relay.example/v1/auth/google/refresh'
    )
    expect(result.ok).toBe(true)
    expect(seen).toEqual(['https://relay.example/v1/auth/google/refresh'])
  })
})
