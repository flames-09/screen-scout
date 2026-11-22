import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'

/**
 * Local stand-in for the hosted relay, used ONLY by `--e2e`.
 *
 * It speaks the same wire protocol as relay/src/index.ts (register, quota,
 * OpenAI-compatible SSE chat), so the E2E exercises the real HostedClient,
 * the real IPC, and the real renderer without touching the network. The mock
 * can be flipped into "quota exceeded" mode to prove the 429 path renders the
 * friendly message instead of a raw HTTP error.
 */

export interface E2eRelayState {
  quotaExceeded: boolean
  /** Last chat request the mock received (for assertions). */
  lastChat: { model: string; hasImage: boolean; hasToken: boolean; messages: number } | null
  /** Every path requested, in order. */
  requests: string[]
}

export interface E2eRelayHandle {
  url: string
  state: E2eRelayState
  setQuotaExceeded(value: boolean): void
  close(): Promise<void>
}

function quotaBody(state: E2eRelayState): Record<string, number> {
  const exceeded = state.quotaExceeded
  return {
    dayUsed: exceeded ? 30 : 3,
    dayLimit: 30,
    dayRemaining: exceeded ? 0 : 27,
    dayResetAt: Date.now() + 3_600_000,
    windowUsed: exceeded ? 10 : 3,
    windowLimit: 10,
    windowRemaining: exceeded ? 0 : 7,
    windowResetAt: Date.now() + 1_800_000
  }
}

/** Account-shaped quota info, matching the relay's {kind:'account',quota} wrapper. */
function accountQuotaInfo(): Record<string, unknown> {
  return {
    kind: 'account',
    accountQuota: {
      imagesUsed: 0,
      imagesLimit: 5,
      imagesRemaining: 5,
      chatsUsed: 0,
      chatsLimit: 50,
      chatsRemaining: 50,
      dayResetAt: Date.now() + 3_600_000
    }
  }
}

/** Fake installer served by the mock update feed (deterministic bytes). */
const E2E_INSTALLER = Buffer.alloc(64 * 1024, 7)
const E2E_INSTALLER_SHA = createHash('sha256').update(E2E_INSTALLER).digest('hex')

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 8 * 1024 * 1024) request.destroy()
    })
    request.on('end', () => resolve(body))
    request.on('error', () => resolve(body))
  })
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  response.end(JSON.stringify(body))
}

export async function startE2eRelay(): Promise<E2eRelayHandle> {
  const state: E2eRelayState = { quotaExceeded: false, lastChat: null, requests: [] }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    state.requests.push(`${request.method} ${url.pathname}`)

    if (url.pathname === '/v1/register' && request.method === 'POST') {
      const raw = await readBody(request)
      let parsed: { deviceId?: unknown } = {}
      try {
        parsed = JSON.parse(raw) as typeof parsed
      } catch {
        // fall through to validation
      }
      if (typeof parsed.deviceId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(parsed.deviceId)) {
        json(response, 400, { error: { code: 'bad-request', message: 'deviceId required' } })
        return
      }
      json(response, 200, {
        token: `e2e.${parsed.deviceId}.${Date.now()}`,
        expiresAt: Date.now() + 3_600_000,
        quota: { kind: 'device', quota: quotaBody(state) }
      })
      return
    }

    // Google account sign-in (E2E): any id_token gets an account token whose
    // quota uses the account shape (5 images / 50 chats per day).
    if (url.pathname === '/v1/auth/google' && request.method === 'POST') {
      const raw = await readBody(request)
      try {
        const parsed = JSON.parse(raw) as { idToken?: unknown; appVersion?: unknown }
        state.requests.push(`auth:google idToken=${typeof parsed.idToken === 'string'} appVersion=${typeof parsed.appVersion === 'string'}`)
      } catch {
        // fall through — accept any body in the mock
      }
      json(response, 200, {
        token: `e2e.acct.${Date.now()}`,
        expiresAt: Date.now() + 3_600_000,
        kind: 'account',
        accountQuota: accountQuotaInfo().accountQuota
      })
      return
    }

    if (url.pathname === '/v1/quota' && request.method === 'GET') {
      const raw = request.headers['x-device-token']
      const token = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
      if (!token) {
        json(response, 401, { error: { code: 'unauthorized', message: 'missing token' } })
        return
      }
      if (token.startsWith('e2e.acct.')) {
        json(response, 200, { quota: accountQuotaInfo() })
        return
      }
      json(response, 200, { quota: { kind: 'device', quota: quotaBody(state) } })
      return
    }

    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      if (!request.headers['x-device-token']) {
        json(response, 401, { error: { code: 'unauthorized', message: 'missing token' } })
        return
      }
      const raw = await readBody(request)
      if (state.quotaExceeded) {
        json(
          response,
          429,
          {
            error: {
              code: 'quota-exceeded',
              message: 'The free daily limit is used up.',
              retryAfterSec: 1200
            },
            quota: { kind: 'device', quota: quotaBody(state) }
          },
          { 'Retry-After': '1200' }
        )
        return
      }
      try {
        const parsed = JSON.parse(raw) as { model?: unknown; messages?: unknown }
        state.lastChat = {
          model: typeof parsed.model === 'string' ? parsed.model : '',
          hasImage: raw.includes('data:image/'),
          hasToken: Boolean(request.headers['x-device-token']),
          messages: Array.isArray(parsed.messages) ? parsed.messages.length : 0
        }
      } catch {
        state.lastChat = null
      }

      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'x-scout-provider': 'mock'
      })
      const chunk = (text: string): string =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-e2e',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
        })}\n\n`
      response.write(chunk('The answer '))
      setTimeout(() => {
        response.write(chunk('is 42.'))
        response.write('data: [DONE]\n\n')
        response.end()
      }, 40)
      return
    }

    // Update feed: the mock advertises a newer version and serves a tiny fake
    // installer, so the E2E can exercise check → download → verified without
    // touching the network or running a real installer.
    if (url.pathname === '/updates/latest.json' && request.method === 'GET') {
      json(response, 200, {
        version: '9.9.9',
        url: '/updates/Screen-Scout-9.9.9-setup.exe',
        sha256: E2E_INSTALLER_SHA,
        sizeBytes: E2E_INSTALLER.length,
        notes: 'e2e update'
      })
      return
    }

    if (url.pathname === '/updates/Screen-Scout-9.9.9-setup.exe' && request.method === 'GET') {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(E2E_INSTALLER.length)
      })
      response.end(E2E_INSTALLER)
      return
    }

    json(response, 404, { error: { code: 'not-found', message: 'mock relay: unknown path' } })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    setQuotaExceeded: (value: boolean) => {
      state.quotaExceeded = value
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}
