import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Google sign-in for the hosted free tier (desktop "loopback IP" flow).
 *
 * The app opens the system browser at Google's authorization endpoint with a
 * PKCE challenge, a temporary loopback HTTP server catches the redirect, and
 * the authorization code is exchanged for an id token (plus a refresh token so
 * later relay re-registrations stay silent). Only the id token ever leaves
 * this module's callers — Google's access token is not used for anything.
 *
 * Everything here is plain Node so the flow is unit-testable without Electron:
 * the caller injects `openExternal` (shell.openExternal in production) and
 * `fetchImpl` (the token endpoint client), and the E2E harness injects fakes
 * for both to drive the whole loop without a real Google page.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** Google requires 43–128 chars of URL-safe verifier; 32 random bytes is 43. */
function base64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export interface GoogleTokenEndpointLike {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type TokenFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<GoogleTokenEndpointLike>

export interface GoogleAuthFlowDeps {
  /** Public OAuth client id; empty disables the flow entirely. */
  clientId: string
  /** Opens the system browser (shell.openExternal in production). */
  openExternal: (url: string) => void | Promise<void>
  /** Token endpoint client (net.fetch in production). */
  fetchImpl: TokenFetchLike
  /**
   * Exchange endpoint. Defaults to Google's token endpoint; in production this
   * is the relay's broker endpoint, which holds the client secret the app must
   * never ship.
   */
  exchangeUrl?: string
  /** Bounds the whole flow (browser wait included). Default: 5 minutes. */
  timeoutMs?: number
}

export type GoogleAuthFlowResult =
  | { ok: true; idToken: string; refreshToken: string | null }
  | {
      ok: false
      code: 'no-client-id' | 'timeout' | 'denied' | 'state-mismatch' | 'exchange-failed' | 'server'
      message: string
    }

type CallbackResult = { code: string } | { error: string } | { mismatch: true }

function respondHtml(response: ServerResponse, status: number, title: string, body: string): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(
    `<!doctype html><html><head><title>${title}</title><meta charset="utf-8">` +
      `<style>body{font-family:system-ui,sans-serif;background:#101014;color:#e8e8ee;` +
      `display:flex;align-items:center;justify-content:center;height:100vh;margin:0}` +
      `div{text-align:center;max-width:28rem;padding:2rem}h1{font-size:1.25rem;font-weight:600}` +
      `p{color:#9a9aa8;font-size:.95rem;line-height:1.5}</style></head>` +
      `<body><div><h1>${title}</h1><p>${body}</p></div></body></html>`
  )
}

/** Waits for the loopback redirect and validates the state parameter. */
function waitForCallback(server: Server, expectedState: string): Promise<CallbackResult> {
  return new Promise((resolve) => {
    const handler = (request: IncomingMessage, response: ServerResponse): void => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        respondHtml(response, 404, 'Screen Scout', 'This page is not used. You can close the tab.')
        return
      }
      const error = url.searchParams.get('error')
      if (error) {
        respondHtml(
          response,
          200,
          'Sign-in cancelled',
          'Google sign-in was cancelled. You can close this tab and pick another option in Screen Scout.'
        )
        resolve({ error })
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state') ?? ''
      const expected = Buffer.from(expectedState)
      const got = Buffer.from(state)
      if (!code || got.length !== expected.length || !timingSafeEqual(got, expected)) {
        respondHtml(response, 400, 'Sign-in failed', 'The sign-in response did not match this app. You can close this tab and try again.')
        resolve({ mismatch: true })
        return
      }
      respondHtml(
        response,
        200,
        'Signed in',
        'Screen Scout is ready. You can close this tab and switch back to the app.'
      )
      resolve({ code })
    }
    server.on('request', handler)
    server.once('close', () => {
      // If the server dies before a callback (timeout path), unblock the waiter.
      resolve({ error: 'server-closed' })
    })
  })
}

/** Runs the full interactive flow and returns the Google tokens. */
export async function runGoogleAuthFlow(deps: GoogleAuthFlowDeps): Promise<GoogleAuthFlowResult> {
  if (!deps.clientId) {
    return { ok: false, code: 'no-client-id', message: 'Google sign-in is not available in this build.' }
  }

  const { verifier, challenge } = pkcePair()
  const state = base64url(randomBytes(16))

  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const port = (server.address() as AddressInfo).port
    const redirectUri = `http://127.0.0.1:${port}/callback`

    const authUrl = new URL(AUTH_ENDPOINT)
    authUrl.searchParams.set('client_id', deps.clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', 'openid email')
    authUrl.searchParams.set('code_challenge', challenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('state', state)
    // Offline access yields a refresh token so later relay re-registrations
    // never need the browser again; select_account lets a multi-account user
    // pick explicitly, consent guarantees the refresh token on re-auth.
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('prompt', 'consent select_account')

    // Register the callback waiter BEFORE opening the browser so an instant
    // redirect can never race the listener into existence.
    const waiter = waitForCallback(server, state).then((result): CallbackResult | null => result)
    await deps.openExternal(authUrl.toString())

    const callback = await Promise.race([
      waiter,
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), deps.timeoutMs ?? 5 * 60_000)
        // Never hold the process open just for the sign-in timeout.
        if (typeof timer.unref === 'function') timer.unref()
      })
    ])

    server.close()

    if (!callback) return { ok: false, code: 'timeout', message: 'The sign-in window timed out. Try again.' }
    if ('error' in callback) {
      return { ok: false, code: 'denied', message: 'Google sign-in was cancelled.' }
    }
    if ('mismatch' in callback) {
      return { ok: false, code: 'state-mismatch', message: 'The sign-in response did not match this app. Try again.' }
    }

    const exchanged = await exchangeCode(deps, callback.code, verifier, redirectUri)
    return exchanged
  } catch (error) {
    return {
      ok: false,
      code: 'server',
      message: error instanceof Error ? error.message : 'Could not start the sign-in flow.'
    }
  } finally {
    try {
      if (server.listening) server.close()
    } catch {
      // Closing twice or closing a dead server must never throw here.
    }
  }
}

interface TokenEndpointPayload {
  id_token?: unknown
  refresh_token?: unknown
  error?: unknown
  error_description?: unknown
}

async function exchangeCode(
  deps: GoogleAuthFlowDeps,
  code: string,
  verifier: string,
  redirectUri: string
): Promise<GoogleAuthFlowResult> {
  try {
    const endpoint = deps.exchangeUrl?.trim() ? deps.exchangeUrl.trim() : TOKEN_ENDPOINT
    const response = await deps.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: deps.clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString()
    })
    const parsed = (await response.json().catch(() => ({}))) as TokenEndpointPayload
    if (!response.ok || typeof parsed.id_token !== 'string' || parsed.id_token.length < 20) {
      return { ok: false, code: 'exchange-failed', message: 'Google did not return a sign-in token. Try again.' }
    }
    return {
      ok: true,
      idToken: parsed.id_token,
      refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token ? parsed.refresh_token : null
    }
  } catch {
    return { ok: false, code: 'exchange-failed', message: 'Could not finish sign-in with Google. Check your connection.' }
  }
}

/** Silent refresh: refresh token → fresh id token. */
export async function refreshGoogleIdToken(
  clientId: string,
  refreshToken: string,
  fetchImpl: TokenFetchLike,
  refreshUrl?: string
): Promise<{ ok: true; idToken: string } | { ok: false; message: string }> {
  if (!clientId) return { ok: false, message: 'Google sign-in is not available in this build.' }
  try {
    const endpoint = refreshUrl?.trim() ? refreshUrl.trim() : TOKEN_ENDPOINT
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }).toString()
    })
    const parsed = (await response.json().catch(() => ({}))) as TokenEndpointPayload
    if (!response.ok || typeof parsed.id_token !== 'string' || parsed.id_token.length < 20) {
      return { ok: false, message: 'Your Google session expired. Sign in again from Settings.' }
    }
    return { ok: true, idToken: parsed.id_token }
  } catch {
    return { ok: false, message: 'Could not reach Google to refresh your session.' }
  }
}

/**
 * Decodes the id-token payload for DISPLAY ONLY (the relay verifies the
 * signature server-side). Returns the email when Google disclosed one.
 */
export function decodeIdTokenEmail(idToken: string): string | null {
  const parts = idToken.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { email?: unknown }
    return typeof payload.email === 'string' && payload.email && payload.email.length <= 254 ? payload.email : null
  } catch {
    return null
  }
}
