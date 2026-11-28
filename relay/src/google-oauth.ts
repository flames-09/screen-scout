/**
 * Secret-bearing Google OAuth calls, brokered by the relay.
 *
 * The desktop app performs the interactive PKCE sign-in in the system browser
 * (loopback redirect) but must NOT hold an OAuth client secret. Google's
 * token endpoint requires one on the code exchange regardless of client type
 * (verified empirically 2026-11: desktop-type clients 400 with
 * "client_secret is missing" when the exchange omits it), so the app sends
 * its authorization code here and the relay - the only holder of
 * GOOGLE_CLIENT_SECRET - performs the two server-to-server calls:
 *
 *   exchange: code + verifier + redirect_uri → { id_token, refresh_token? }
 *   refresh:  refresh_token                  → { id_token }
 *
 * Both are stateless pass-throughs: tokens transit over TLS and are never
 * written anywhere. The returned id_token is verified separately by
 * handleGoogleAuth (verifyGoogleIdToken) before any account state is created.
 */

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/**
 * The app always redirects to an ephemeral loopback port with the fixed
 * /callback path. Constraining the shape here stops the relay being used as
 * a general-purpose code exchanger for arbitrary redirect targets.
 */
const LOOPBACK_REDIRECT_RE = /^http:\/\/(127\.0\.0\.1|\[::1\]):\d{1,5}\/callback$/

export function isValidLoopbackRedirect(value: string): boolean {
  return LOOPBACK_REDIRECT_RE.test(value)
}

export function parseFormBody(raw: string): URLSearchParams {
  return new URLSearchParams(raw)
}

interface GoogleTokenResponse {
  id_token?: unknown
  refresh_token?: unknown
}

export type GoogleTokenOutcome =
  | { ok: true; idToken: string; refreshToken: string | null }
  /** Google rejected the input (bad code, revoked session). */
  | { ok: false; kind: 'invalid' }
  /** Google could not be reached or answered unexpectedly. */
  | { ok: false; kind: 'upstream' }

async function callGoogleTokenEndpoint(form: Record<string, string>): Promise<GoogleTokenOutcome> {
  let response: Response
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000)
    })
  } catch {
    return { ok: false, kind: 'upstream' }
  }
  let parsed: GoogleTokenResponse = {}
  try {
    parsed = (await response.json()) as GoogleTokenResponse
  } catch {
    parsed = {}
  }
  if (!response.ok || typeof parsed.id_token !== 'string' || parsed.id_token.length < 20) {
    // 429/5xx are Google-side trouble (throttle/outage): the user's input may
    // be perfectly fine, so treat them as upstream, not as user error.
    return { ok: false, kind: response.status >= 500 || response.status === 429 ? 'upstream' : 'invalid' }
  }
  return {
    ok: true,
    idToken: parsed.id_token,
    refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token ? parsed.refresh_token : null
  }
}

export interface GoogleOAuthEnv {
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
}

/** Authorization-code exchange on behalf of the desktop app (PKCE verifier). */
export async function googleExchangeCode(
  env: GoogleOAuthEnv,
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<GoogleTokenOutcome> {
  return callGoogleTokenEndpoint({
    client_id: (env.GOOGLE_CLIENT_ID ?? '').trim(),
    client_secret: (env.GOOGLE_CLIENT_SECRET ?? '').trim(),
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  })
}

/** Silent refresh: refresh token in, fresh id_token out. */
export async function googleRefreshIdToken(
  env: GoogleOAuthEnv,
  refreshToken: string
): Promise<GoogleTokenOutcome> {
  const out = await callGoogleTokenEndpoint({
    client_id: (env.GOOGLE_CLIENT_ID ?? '').trim(),
    client_secret: (env.GOOGLE_CLIENT_SECRET ?? '').trim(),
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  })
  // Google never re-issues a refresh token on this grant; normalize so
  // callers cannot mistake a passthrough for a rotation.
  return out.ok ? { ok: true, idToken: out.idToken, refreshToken: null } : out
}
