import { describe, expect, it } from 'vitest'
import {
  accountHashFromGoogleSub,
  base64urlDecode,
  base64urlEncode,
  isAccountDeviceId,
  isValidDeviceId,
  issueToken,
  verifyGoogleIdToken,
  verifyToken
} from '../relay/src/auth'

const SECRET = 'test-secret-do-not-use-in-production'
const DEVICE_ID = 'a'.repeat(32)

describe('device tokens', () => {
  it('round-trips a token and returns the device id', async () => {
    const { token, expiresAt } = await issueToken(SECRET, DEVICE_ID, '0.1.0')
    expect(token).toContain('.')
    expect(expiresAt).toBeGreaterThan(Date.now())

    const payload = await verifyToken(SECRET, token)
    expect(payload?.d).toBe(DEVICE_ID)
    expect(payload?.v).toBe('0.1.0')
  })

  it('rejects a token signed with a different secret', async () => {
    const { token } = await issueToken(SECRET, DEVICE_ID, '0.1.0')
    expect(await verifyToken('another-secret', token)).toBeNull()
  })

  it('rejects tampered payloads', async () => {
    const { token } = await issueToken(SECRET, DEVICE_ID, '0.1.0')
    const [payload, signature] = token.split('.')
    const forged = base64urlEncode(
      new TextEncoder().encode(JSON.stringify({ d: 'b'.repeat(32), v: '0.1.0', e: Date.now() + 60_000, n: 'x' }))
    )
    expect(await verifyToken(SECRET, `${forged}.${signature}`)).toBeNull()
    expect(await verifyToken(SECRET, `${payload}.${signature}`)).not.toBeNull()
  })

  it('rejects expired tokens', async () => {
    const past = Date.now() - 10_000
    const { token } = await issueToken(SECRET, DEVICE_ID, '0.1.0', past, 5)
    expect(await verifyToken(SECRET, token)).toBeNull()
  })

  it('rejects malformed input without throwing', async () => {
    for (const bad of ['', '.', 'abc', 'abc.def', `${'x'.repeat(3000)}.y`]) {
      await expect(verifyToken(SECRET, bad)).resolves.toBeNull()
    }
  })

  it('produces different tokens for the same device (nonce)', async () => {
    const a = await issueToken(SECRET, DEVICE_ID, '0.1.0')
    const b = await issueToken(SECRET, DEVICE_ID, '0.1.0')
    expect(a.token).not.toBe(b.token)
  })

  it('validates device ids', () => {
    expect(isValidDeviceId(DEVICE_ID)).toBe(true)
    expect(isValidDeviceId('short')).toBe(false)
    expect(isValidDeviceId('has spaces in it!!!!!!!!')).toBe(false)
    expect(isValidDeviceId(42)).toBe(false)
    expect(isValidDeviceId('x'.repeat(65))).toBe(false)
  })

  it('base64url handles padding and url-safe characters', () => {
    const bytes = new Uint8Array([251, 255, 190, 0, 1, 2])
    const encoded = base64urlEncode(bytes)
    expect(encoded).not.toMatch(/[+/=]/)
    expect(Array.from(base64urlDecode(encoded))).toEqual(Array.from(bytes))
  })
})

describe('google account tokens', () => {
  it('derives a stable prefixed hash and round-trips it as a token', async () => {
    const hash1 = await accountHashFromGoogleSub(SECRET, 'google-sub-1234567890')
    const hash2 = await accountHashFromGoogleSub(SECRET, 'google-sub-1234567890')
    expect(hash1).toBe(hash2)
    expect(hash1.startsWith('acct:')).toBe(true)
    expect(hash1).toMatch(/^acct:[0-9a-f]{64}$/)

    const other = await accountHashFromGoogleSub(SECRET, 'another-sub-0987654321')
    expect(other).not.toBe(hash1)

    const { token } = await issueToken(SECRET, hash1, '0.1.0')
    const payload = await verifyToken(SECRET, token)
    expect(payload?.d).toBe(hash1)
    expect(isAccountDeviceId(payload?.d ?? '')).toBe(true)
    expect(isAccountDeviceId(DEVICE_ID)).toBe(false)
  })

  it('verifies a valid Google ID token via tokeninfo', async () => {
    const clientId = 'test-client-id.apps.googleusercontent.com'
    const fetchLike = (async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          aud: clientId,
          iss: 'accounts.google.com',
          sub: '1234567890abcdef',
          email: 'user@example.com',
          email_verified: true,
          exp: String(Math.floor(Date.now() / 1000) + 3600)
        })
    })) as unknown as (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

    const claims = await verifyGoogleIdToken(fetchLike, 'a'.repeat(40), clientId)
    expect(claims?.sub).toBe('1234567890abcdef')
    expect(claims?.email).toBe('user@example.com')
  })

  it('rejects wrong audience, stale expiry, bad issuer, and transport failures', async () => {
    const clientId = 'test-client-id.apps.googleusercontent.com'
    const okBody = (overrides: Record<string, unknown>) =>
      JSON.stringify({
        aud: clientId,
        iss: 'https://accounts.google.com',
        sub: '1234567890abcdef',
        exp: String(Math.floor(Date.now() / 1000) + 3600),
        ...overrides
      })
    const makeFetch =
      (body: string, status = 200) =>
      async () => ({ ok: status === 200, status, text: async () => body })

    expect(await verifyGoogleIdToken(makeFetch(okBody({ aud: 'other-client' })), 'a'.repeat(40), clientId)).toBeNull()
    expect(await verifyGoogleIdToken(makeFetch(okBody({ exp: String(Math.floor(Date.now() / 1000) - 10) })), 'a'.repeat(40), clientId)).toBeNull()
    expect(await verifyGoogleIdToken(makeFetch(okBody({ iss: 'https://evil.example' })), 'a'.repeat(40), clientId)).toBeNull()
    expect(await verifyGoogleIdToken(makeFetch(okBody({ sub: 42 })), 'a'.repeat(40), clientId)).toBeNull()
    expect(await verifyGoogleIdToken(makeFetch('not json', 200), 'a'.repeat(40), clientId)).toBeNull()
    expect(await verifyGoogleIdToken(makeFetch('{}', 500), 'a'.repeat(40), clientId)).toBeNull()

    const failing = async (): Promise<never> => {
      throw new Error('offline')
    }
    expect(await verifyGoogleIdToken(failing, 'a'.repeat(40), clientId)).toBeNull()
    expect(await verifyGoogleIdToken(makeFetch(okBody({})), '', clientId)).toBeNull()
    expect(await verifyGoogleIdToken(makeFetch(okBody({})), 'short', clientId)).toBeNull()
  })
})
