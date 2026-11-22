/**
 * Device tokens: stateless, HMAC-signed, short lived.
 *
 * The relay never stores a token — it stores only per-device usage counters.
 * A token proves "this install registered recently"; it is NOT an account and
 * carries no personal data (only a random device id + app version).
 *
 * Format: base64url(payload) "." base64url(HMAC-SHA256(payload))
 */

const encoder = new TextEncoder()

export interface TokenPayload {
  /** Random device id (no PII). */
  d: string
  /** App version that registered. */
  v: string
  /** Expiry, epoch milliseconds. */
  e: number
  /** Random nonce, so two tokens for the same device differ. */
  n: string
}

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function base64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

async function sign(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return new Uint8Array(signature)
}

/** Constant-time-ish comparison (length is public; content is not). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export function randomId(bytes = 16): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return base64urlEncode(buf)
}

export const TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60

export async function issueToken(
  secret: string,
  deviceId: string,
  appVersion: string,
  now = Date.now(),
  ttlSeconds = TOKEN_TTL_SECONDS
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = now + ttlSeconds * 1000
  const payload: TokenPayload = {
    d: deviceId,
    v: appVersion.slice(0, 40),
    e: expiresAt,
    n: randomId(9)
  }
  const encodedPayload = base64urlEncode(encoder.encode(JSON.stringify(payload)))
  const signature = await sign(secret, encodedPayload)
  return { token: `${encodedPayload}.${base64urlEncode(signature)}`, expiresAt }
}

export async function verifyToken(
  secret: string,
  token: string,
  now = Date.now()
): Promise<TokenPayload | null> {
  if (typeof token !== 'string' || token.length > 2048) return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const encodedPayload = token.slice(0, dot)
  const encodedSignature = token.slice(dot + 1)
  let expected: Uint8Array
  let provided: Uint8Array
  try {
    expected = await sign(secret, encodedPayload)
    provided = base64urlDecode(encodedSignature)
  } catch {
    return null
  }
  if (!timingSafeEqual(expected, provided)) return null
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64urlDecode(encodedPayload))) as TokenPayload
    if (typeof parsed.d !== 'string' || parsed.d.length < 8 || parsed.d.length > 128) return null
    if (typeof parsed.e !== 'number' || parsed.e <= now) return null
    return parsed
  } catch {
    return null
  }
}

export function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value)
}

// ---- Google account tokens -------------------------------------------------
//
// A signed-in account uses the SAME HMAC token format, but the "device id" is
// a keyed hash of the Google subject id: acct:<hex>. The relay therefore
// stores nothing personal — never the sub itself, never an email.

const ACCOUNT_PREFIX = 'acct:'

/** True when a token's device id identifies a Google-account registration. */
export function isAccountDeviceId(deviceId: string): boolean {
  return deviceId.startsWith(ACCOUNT_PREFIX)
}

/**
 * Derives the stored account id from a Google subject: HMAC-SHA256 keyed by
 * the signing secret, hex-encoded. Deterministic (so the same Google account
 * maps to the same quota bucket) and one-way (a D1 dump reveals nothing).
 */
export async function accountHashFromGoogleSub(secret: string, sub: string): Promise<string> {
  const mac = await sign(secret, `google:${sub}`)
  let hex = ''
  for (const byte of mac) hex += byte.toString(16).padStart(2, '0')
  return `${ACCOUNT_PREFIX}${hex}`
}

export interface GoogleClaims {
  sub: string
  email?: string
}

interface TokenInfoResponse {
  aud?: unknown
  sub?: unknown
  email?: unknown
  email_verified?: unknown
  exp?: unknown
  iss?: unknown
}

const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com'])

/**
 * Verifies a Google ID token via Google's tokeninfo endpoint. Google validates
 * the signature server-side; this checks the claims that matter to us:
 * audience (our client id), issuer, expiry, and a string subject.
 *
 * The `fetchLike` injection keeps this unit-testable without network access.
 */
export async function verifyGoogleIdToken(
  fetchLike: (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>,
  idToken: string,
  clientId: string,
  now = Date.now()
): Promise<GoogleClaims | null> {
  if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 4096) return null
  if (!clientId) return null
  let response: { ok: boolean; status: number; text: () => Promise<string> }
  try {
    response = await fetchLike(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`)
  } catch {
    return null
  }
  if (!response.ok || response.status !== 200) return null
  let info: TokenInfoResponse
  try {
    info = (JSON.parse(await response.text()) as unknown) as TokenInfoResponse
  } catch {
    return null
  }
  if (info.aud !== clientId) return null
  if (typeof info.iss !== 'string' || !GOOGLE_ISSUERS.has(info.iss)) return null
  if (typeof info.sub !== 'string' || info.sub.length < 8 || info.sub.length > 128) return null
  const exp = typeof info.exp === 'string' ? Number(info.exp) : info.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp * 1000 <= now) return null
  const email = typeof info.email === 'string' && info.email.length <= 254 ? info.email : undefined
  // tokeninfo returns email_verified as a STRING ('true'/'false') — treat
  // both spellings of false as unverified. (Email is display-only and never
  // stored; this guard is defense in depth.)
  if (email && (info.email_verified === false || info.email_verified === 'false')) return { sub: info.sub }
  return { sub: info.sub, ...(email ? { email } : {}) }
}
