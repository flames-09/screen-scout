import { describe, expect, it } from 'vitest'
import {
  base64urlDecode,
  base64urlEncode,
  isValidDeviceId,
  issueToken,
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
