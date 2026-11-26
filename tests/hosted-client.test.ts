import { afterEach, describe, expect, it, vi } from 'vitest'

// The client imports `net` from electron; the test drives it with a fake.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))

vi.mock('electron', () => ({ net: { fetch: (...args: unknown[]) => fetchMock(...args) } }))

import { HostedClient, HostedError, type HostedDeps } from '../src/main/ai/hosted-client'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function futureToken(expiresInMs = 3_600_000): string {
  const payload = Buffer.from(JSON.stringify({ d: 'a'.repeat(32), v: '0.1.0', e: Date.now() + expiresInMs })).toString(
    'base64url'
  )
  return `${payload}.signature`
}

function makeClient(overrides: Partial<HostedDeps> = {}): {
  client: HostedClient
  store: { token: string | null; saves: number; clears: number }
} {
  const store = { token: null as string | null, saves: 0, clears: 0 }
  const client = new HostedClient({
    relayUrl: () => 'https://relay.test/',
    deviceId: () => 'a'.repeat(32),
    authMode: () => 'anonymous',
    getGoogleIdToken: async () => {
      throw new Error('no google in this test')
    },
    getStoredToken: () => store.token,
    saveToken: (token) => {
      store.token = token
      store.saves += 1
    },
    clearToken: () => {
      store.token = null
      store.clears += 1
    },
    appVersion: () => '0.1.0',
    ...overrides
  })
  return { client, store }
}

afterEach(() => {
  fetchMock.mockReset()
})

describe('HostedClient', () => {
  it('registers once and reuses the cached token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: futureToken(), expiresAt: Date.now() + 3_600_000 }))
    const { client, store } = makeClient()

    const first = await client.chatHeaders()
    const second = await client.chatHeaders()

    expect(first['x-device-token']).toMatch(/\.signature$/)
    expect(second['x-device-token']).toBe(first['x-device-token'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(store.saves).toBe(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://relay.test/v1/register')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('omit')
  })

  it('uses a stored, unexpired token without registering', async () => {
    const token = futureToken()
    const { client, store } = makeClient()
    store.token = token

    expect(await client.ensureToken()).toBe(token)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('re-registers when the stored token is expired', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: futureToken(), expiresAt: Date.now() + 3_600_000 }))
    const { client, store } = makeClient()
    const expired = futureToken(-60_000)
    store.token = expired

    const token = await client.ensureToken()
    expect(token).not.toBe(expired)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight registration between concurrent callers', async () => {
    let release!: (response: Response) => void
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        })
    )
    const { client } = makeClient()

    const a = client.ensureToken()
    const b = client.ensureToken()
    // Both calls are now waiting on the same registration promise.
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    release(jsonResponse(200, { token: futureToken(), expiresAt: Date.now() + 3_600_000 }))
    expect(await a).toBe(await b)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a registration throttle as unavailable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: { code: 'registration-limit' } }))
    const { client } = makeClient()

    const error = await client.ensureToken().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HostedError)
    expect(error).toMatchObject({ code: 'unavailable' })
  })

  it('normalizes the quota payload', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { token: futureToken(), expiresAt: Date.now() + 3_600_000 }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          quota: {
            dayUsed: 3,
            dayLimit: 30,
            dayRemaining: 27,
            dayResetAt: Date.now() + 3_600_000,
            windowUsed: 3,
            windowLimit: 10,
            windowRemaining: 7,
            windowResetAt: Date.now() + 1_800_000
          }
        })
      )
    const { client } = makeClient()

    const quota = await client.fetchQuota()
    expect(quota?.kind).toBe('device')
    expect(quota?.kind === 'device' && quota.quota.dayRemaining).toBe(27)
    expect(quota?.kind === 'device' && quota.quota.windowRemaining).toBe(7)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns null quota when the relay is unreachable', async () => {
    const { client } = makeClient({ relayUrl: () => '' })
    expect(await client.fetchQuota()).toBeNull()
    await expect(client.ensureToken()).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('re-registers when forced (relay rejected the token)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { token: futureToken(), expiresAt: Date.now() + 3_600_000 }))
      .mockResolvedValueOnce(jsonResponse(200, { token: `refreshed.${futureToken()}`, expiresAt: Date.now() + 3_600_000 }))
    const { client } = makeClient()

    await client.ensureToken()
    const refreshed = await client.chatHeaders(true)

    expect(refreshed['x-device-token']).toContain('refreshed.')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('surfaces a caller abort as "Request cancelled"', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')))
        })
    )
    const { client } = makeClient()
    const controller = new AbortController()

    const pending = client.ensureToken(false, controller.signal).catch((e: unknown) => e)
    await Promise.resolve()
    controller.abort()
    const err = await pending

    expect(err).toBeInstanceOf(HostedError)
    expect(err).toMatchObject({ message: 'Request cancelled.' })
  })

  it('refreshToken clears the stored token before registering again', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { token: futureToken(), expiresAt: Date.now() + 3_600_000 }))
      .mockResolvedValueOnce(jsonResponse(200, { token: futureToken(), expiresAt: Date.now() + 3_600_000 }))
    const { client, store } = makeClient()

    await client.ensureToken()
    expect(store.token).not.toBeNull()
    await client.refreshToken()
    expect(store.clears).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('HostedClient google mode', () => {
  function makeGoogleClient(overrides: Partial<HostedDeps> = {}): ReturnType<typeof makeClient> {
    return makeClient({
      authMode: () => 'google',
      getGoogleIdToken: async () => 'e2e-id-token',
      ...overrides
    })
  }

  it('registers via /v1/auth/google using the fresh id token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: futureToken(), expiresAt: Date.now() + 3_600_000 }))
    const { client, store } = makeGoogleClient()

    const headers = await client.chatHeaders()

    expect(headers['x-device-token']).toMatch(/\.signature$/)
    expect(store.saves).toBe(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://relay.test/v1/auth/google')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ idToken: 'e2e-id-token', appVersion: '0.1.0' })
  })

  it('maps a 401 to google-auth-required so the UI can prompt re-sign-in', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { code: 'google-token-invalid' } }))
    const { client } = makeGoogleClient()

    const error = await client.ensureToken().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HostedError)
    expect(error).toMatchObject({ code: 'google-auth-required' })
  })

  it('parses the account quota shape', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { token: futureToken(), expiresAt: Date.now() + 3_600_000 }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          quota: {
            kind: 'account',
            accountQuota: {
              imagesUsed: 1,
              imagesLimit: 5,
              imagesRemaining: 4,
              chatsUsed: 7,
              chatsLimit: 50,
              chatsRemaining: 43,
              dayResetAt: Date.now() + 3_600_000
            }
          }
        })
      )
    const { client } = makeGoogleClient()

    const quota = await client.fetchQuota()
    expect(quota?.kind).toBe('account')
    if (quota?.kind === 'account') {
      expect(quota.quota.imagesRemaining).toBe(4)
      expect(quota.quota.chatsRemaining).toBe(43)
    }
  })

  it('still parses the legacy device quota (no kind wrapper)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { token: futureToken(), expiresAt: Date.now() + 3_600_000 }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          quota: {
            dayUsed: 3,
            dayLimit: 30,
            dayRemaining: 27,
            dayResetAt: Date.now() + 3_600_000,
            windowUsed: 3,
            windowLimit: 10,
            windowRemaining: 7,
            windowResetAt: Date.now() + 1_800_000
          }
        })
      )
    const { client } = makeGoogleClient()

    const quota = await client.fetchQuota()
    expect(quota?.kind).toBe('device')
  })
})

describe('HostedClient resetAuth + relay wire shapes', () => {
  it('re-registers under the NEW authMode after resetAuth (no stale token reuse)', async () => {
    let mode: 'anonymous' | 'google' = 'anonymous'
    const { client, store } = makeClient({
      authMode: () => mode,
      getGoogleIdToken: async () => 'fresh-id-token'
    })
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { token: futureToken(), expiresAt: Date.now() + 3_600_000 }))
      .mockResolvedValueOnce(jsonResponse(200, { token: futureToken(7_200_000), expiresAt: Date.now() + 7_200_000 }))

    await client.chatHeaders() // anonymous register
    mode = 'google'
    client.resetAuth()

    const headers = await client.chatHeaders()
    expect(headers['x-device-token']).toMatch(/\.signature$/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('https://relay.test/v1/auth/google')
    expect(JSON.parse(String(init.body))).toEqual({ idToken: 'fresh-id-token', appVersion: '0.1.0' })
    expect(store.saves).toBe(2)
  })

  it('parses the REAL relay account quota shape (top-level kind/accountQuota)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { token: futureToken(), expiresAt: Date.now() + 3_600_000 }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          kind: 'account',
          accountQuota: {
            imagesUsed: 0,
            imagesLimit: 5,
            imagesRemaining: 5,
            chatsUsed: 2,
            chatsLimit: 50,
            chatsRemaining: 48,
            dayResetAt: Date.now() + 3_600_000
          }
        })
      )
    const { client } = makeClient({ authMode: () => 'google', getGoogleIdToken: async () => 't' })

    const quota = await client.fetchQuota()
    expect(quota?.kind).toBe('account')
    if (quota?.kind === 'account') {
      expect(quota.quota.imagesRemaining).toBe(5)
      expect(quota.quota.chatsRemaining).toBe(48)
    }
  })
})

describe('deleteAccount', () => {
  it('posts to /v1/account/delete, clears the token, and reports the kind', async () => {
    const token = futureToken()
    const { client, store } = makeClient()
    store.token = token
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, kind: 'account' }))

    const result = await client.deleteAccount()

    expect(result).toEqual({ ok: true, kind: 'account' })
    expect(store.clears).toBe(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://relay.test/v1/account/delete')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-device-token']).toBe(token)
  })

  it('raises HostedError when the relay refuses', async () => {
    const { client } = makeClient()
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}))
    await expect(client.deleteAccount()).rejects.toBeInstanceOf(HostedError)
  })
})
