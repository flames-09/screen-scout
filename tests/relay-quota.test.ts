import { describe, expect, it } from 'vitest'
import {
  dayBucket,
  dayResetAt,
  limitsFromEnv,
  quotaSnapshot,
  releaseGlobal,
  releaseQuestion,
  reserveGlobal,
  reserveQuestion,
  slotBucket,
  slotResetAt,
  type QuotaStore,
  type QuotaLimits
} from '../relay/src/quota'

/** In-memory QuotaStore with the same atomic semantics as the D1 version. */
class MemoryStore implements QuotaStore {
  readonly counts = new Map<string, number>()

  async incrementIfBelow(key: string, limit: number): Promise<number | null> {
    const current = this.counts.get(key) ?? 0
    if (current >= limit) return null
    const next = current + 1
    this.counts.set(key, next)
    return next
  }

  async decrement(key: string): Promise<void> {
    this.counts.set(key, Math.max(0, (this.counts.get(key) ?? 0) - 1))
  }

  async read(key: string): Promise<number> {
    return this.counts.get(key) ?? 0
  }
}

const LIMITS: QuotaLimits = { perDay: 30, perWindow: 10, windowHours: 5 }
const DEVICE = 'device-'.padEnd(24, 'x')

describe('bucket math', () => {
  it('uses UTC day buckets and resets at the next midnight', () => {
    const now = Date.UTC(2026, 10, 6, 14, 30)
    expect(dayBucket(now)).toBe('day:2026-11-06')
    const reset = dayResetAt(now)
    expect(reset).toBe(Date.UTC(2026, 10, 7))
    expect(reset).toBeGreaterThan(now)
  })

  it('aligns 5-hour windows and reports the next boundary', () => {
    const windowMs = 5 * 3600_000
    const now = Date.UTC(2026, 10, 6, 12, 7)
    const slot = slotBucket(now, 5)
    expect(slot).toBe(`slot:${Math.floor(now / windowMs)}`)
    const reset = slotResetAt(now, 5)
    expect(reset % windowMs).toBe(0)
    expect(reset).toBeGreaterThan(now)
    expect(reset - now).toBeLessThanOrEqual(windowMs)
  })

  it('parses limits defensively', () => {
    expect(limitsFromEnv({ DEVICE_PER_DAY: '30', DEVICE_PER_WINDOW: '10', WINDOW_HOURS: '5' })).toEqual(LIMITS)
    const junk = limitsFromEnv({ DEVICE_PER_DAY: 'abc', DEVICE_PER_WINDOW: '', WINDOW_HOURS: 'x' })
    expect(junk.perDay).toBe(30)
    expect(junk.perWindow).toBe(10)
    expect(junk.windowHours).toBe(5)
    const inverted = limitsFromEnv({ DEVICE_PER_DAY: '5', DEVICE_PER_WINDOW: '50', WINDOW_HOURS: '5' })
    expect(inverted.perWindow).toBe(5)
  })
})

describe('reserveQuestion', () => {
  it('counts against both caps and reports remaining', async () => {
    const store = new MemoryStore()
    const now = Date.UTC(2026, 10, 6, 12, 0)
    const first = await reserveQuestion(store, DEVICE, LIMITS, now)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.snapshot.dayUsed).toBe(1)
    expect(first.snapshot.windowUsed).toBe(1)
    expect(first.snapshot.dayRemaining).toBe(29)
    expect(first.snapshot.windowRemaining).toBe(9)
  })

  it('blocks at the 5-hour window cap and rolls the daily counter back', async () => {
    const store = new MemoryStore()
    const now = Date.UTC(2026, 10, 6, 12, 0)
    for (let i = 0; i < LIMITS.perWindow; i++) {
      expect((await reserveQuestion(store, DEVICE, LIMITS, now)).ok).toBe(true)
    }
    const blocked = await reserveQuestion(store, DEVICE, LIMITS, now)
    expect(blocked.ok).toBe(false)
    if (blocked.ok) return
    expect(blocked.reason).toBe('window')
    expect(blocked.snapshot.windowRemaining).toBe(0)
    // The rejected attempt must not consume a daily slot.
    expect(blocked.snapshot.dayUsed).toBe(LIMITS.perWindow)
  })

  it('allows questions again after the window rolls over', async () => {
    const store = new MemoryStore()
    const now = Date.UTC(2026, 10, 6, 12, 0)
    for (let i = 0; i < LIMITS.perWindow; i++) await reserveQuestion(store, DEVICE, LIMITS, now)
    expect((await reserveQuestion(store, DEVICE, LIMITS, now)).ok).toBe(false)
    const nextWindow = now + 5 * 3600_000
    const allowed = await reserveQuestion(store, DEVICE, LIMITS, nextWindow)
    expect(allowed.ok).toBe(true)
    if (allowed.ok) expect(allowed.snapshot.windowUsed).toBe(1)
  })

  it('blocks at the daily cap even when the window has room', async () => {
    const store = new MemoryStore()
    const tight: QuotaLimits = { perDay: 2, perWindow: 10, windowHours: 5 }
    const now = Date.UTC(2026, 10, 6, 12, 0)
    await reserveQuestion(store, DEVICE, tight, now)
    await reserveQuestion(store, DEVICE, tight, now)
    const blocked = await reserveQuestion(store, DEVICE, tight, now)
    expect(blocked.ok).toBe(false)
    if (blocked.ok) return
    expect(blocked.reason).toBe('day')
    expect(blocked.snapshot.dayRemaining).toBe(0)
  })

  it('keeps devices independent', async () => {
    const store = new MemoryStore()
    const now = Date.now()
    const a = await reserveQuestion(store, DEVICE, LIMITS, now)
    const b = await reserveQuestion(store, 'different-device-id-123', LIMITS, now)
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.snapshot.dayUsed).toBe(1)
      expect(b.snapshot.dayUsed).toBe(1)
    }
  })

  it('releaseQuestion returns both counters', async () => {
    const store = new MemoryStore()
    const now = Date.now()
    await reserveQuestion(store, DEVICE, LIMITS, now)
    await releaseQuestion(store, DEVICE, LIMITS, now)
    const snapshot = await quotaSnapshot(store, DEVICE, LIMITS, now)
    expect(snapshot.dayUsed).toBe(0)
    expect(snapshot.windowUsed).toBe(0)
  })
})

describe('account-wide provider budgets', () => {
  it('caps per provider per day and releases on failure', async () => {
    const store = new MemoryStore()
    const now = Date.now()
    expect(await reserveGlobal(store, 'groq', 2, now)).toBe(true)
    expect(await reserveGlobal(store, 'groq', 2, now)).toBe(true)
    expect(await reserveGlobal(store, 'groq', 2, now)).toBe(false)
    // A failed upstream attempt must not burn the budget.
    await releaseGlobal(store, 'groq', now)
    expect(await reserveGlobal(store, 'groq', 2, now)).toBe(true)
    // Providers are separate budgets.
    expect(await reserveGlobal(store, 'cf', 2, now)).toBe(true)
  })
})
