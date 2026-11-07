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
