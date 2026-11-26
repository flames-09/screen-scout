import { describe, expect, it } from 'vitest'
import {
  accountLimitsFromEnv,
  accountQuotaSnapshot,
  dayBucket,
  dayResetAt,
  limitsFromEnv,
  quotaSnapshot,
  releaseAccountQuestion,
  releaseGlobal,
  releaseQuestion,
  reserveAccountQuestion,
  reserveGlobal,
  reserveQuestion,
  slotBucket,
  slotResetAt,
  type AccountLimits,
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

  it('tracks the NVIDIA image pool independently of Cloudflare', async () => {
    const store = new MemoryStore()
    const now = Date.now()
    expect(await reserveGlobal(store, 'nvidia', 2, now)).toBe(true)
    expect(await reserveGlobal(store, 'nvidia', 2, now)).toBe(true)
    expect(await reserveGlobal(store, 'nvidia', 2, now)).toBe(false)
    // Exhausting NVIDIA leaves Cloudflare untouched (fallback stays available).
    expect(await reserveGlobal(store, 'cf', 2, now)).toBe(true)
    await releaseGlobal(store, 'nvidia', now)
    expect(await reserveGlobal(store, 'nvidia', 2, now)).toBe(true)
  })
})

describe('google account quotas', () => {
  it('allows 5 image and 50 chat questions per day, tracked independently', async () => {
    const store = new MemoryStore()
    const limits: AccountLimits = { imagesPerDay: 5, chatsPerDay: 50 }
    const now = Date.UTC(2026, 10, 20, 10)

    for (let i = 0; i < 5; i++) {
      expect((await reserveAccountQuestion(store, 'acct:aa', 'image', limits, now)).ok).toBe(true)
    }
    expect((await reserveAccountQuestion(store, 'acct:aa', 'image', limits, now)).ok).toBe(false)

    // Text budget untouched by the exhausted image budget.
    for (let i = 0; i < 50; i++) {
      expect((await reserveAccountQuestion(store, 'acct:aa', 'chat', limits, now)).ok).toBe(true)
    }
    expect((await reserveAccountQuestion(store, 'acct:aa', 'chat', limits, now)).ok).toBe(false)

    const snapshot = await accountQuotaSnapshot(store, 'acct:aa', limits, now)
    expect(snapshot.imagesUsed).toBe(5)
    expect(snapshot.imagesRemaining).toBe(0)
    expect(snapshot.chatsUsed).toBe(50)
    expect(snapshot.chatsRemaining).toBe(0)
    expect(snapshot.dayResetAt).toBe(Date.UTC(2026, 10, 21))
  })

  it('separates accounts and resets at the UTC day boundary', async () => {
    const store = new MemoryStore()
    const limits: AccountLimits = { imagesPerDay: 5, chatsPerDay: 50 }
    const day1 = Date.UTC(2026, 10, 20, 23, 59)
    const day2 = Date.UTC(2026, 10, 21, 0, 1)

    expect((await reserveAccountQuestion(store, 'acct:aa', 'image', limits, day1)).ok).toBe(true)
    expect((await reserveAccountQuestion(store, 'acct:bb', 'image', limits, day1)).ok).toBe(true)
    expect((await reserveAccountQuestion(store, 'acct:aa', 'image', limits, day2)).ok).toBe(true)

    expect(await accountQuotaSnapshot(store, 'acct:aa', limits, day1)).toMatchObject({ imagesUsed: 1 })
    expect(await accountQuotaSnapshot(store, 'acct:aa', limits, day2)).toMatchObject({ imagesUsed: 1 })
  })

  it('refunds a reservation when no upstream served the request', async () => {
    const store = new MemoryStore()
    const limits: AccountLimits = { imagesPerDay: 5, chatsPerDay: 50 }
    const now = Date.UTC(2026, 10, 20, 10)

    await reserveAccountQuestion(store, 'acct:aa', 'chat', limits, now)
    await reserveAccountQuestion(store, 'acct:aa', 'chat', limits, now)
    await releaseAccountQuestion(store, 'acct:aa', 'chat', now)

    expect(await accountQuotaSnapshot(store, 'acct:aa', limits, now)).toMatchObject({
      chatsUsed: 1,
      chatsRemaining: 49
    })
  })

  it('reads account limits from env with sane clamps', () => {
    expect(accountLimitsFromEnv({})).toEqual({ imagesPerDay: 5, chatsPerDay: 50 })
    expect(accountLimitsFromEnv({ ACCOUNT_IMAGE_PER_DAY: '8', ACCOUNT_CHAT_PER_DAY: '75' })).toEqual({
      imagesPerDay: 8,
      chatsPerDay: 75
    })
    expect(accountLimitsFromEnv({ ACCOUNT_IMAGE_PER_DAY: '9999', ACCOUNT_CHAT_PER_DAY: '-3' })).toEqual({
      imagesPerDay: 200,
      chatsPerDay: 1
    })
  })
})

describe('deleteDeviceData', () => {
  class FakeD1 {
    usage = new Map<string, { count: number; expiresAt: number }>()
    devices = new Map<string, unknown>()
    prepare(sql: string) {
      const exec = (params: unknown[]) => {
        if (sql.startsWith('DELETE FROM usage') && params.length === 2) {
          const [lo, hi] = params as [string, string]
          for (const key of [...this.usage.keys()]) if (key >= lo && key < hi) this.usage.delete(key)
        } else if (sql.startsWith('DELETE FROM usage')) {
          this.usage.delete(params[0] as string)
        } else if (sql.startsWith('INSERT INTO usage')) {
          const [bucket, expiresAt] = params as [string, number]
          this.usage.set(bucket, { count: 1, expiresAt })
        } else if (sql.startsWith('DELETE FROM devices')) {
          this.devices.delete(params[0] as string)
        }
        return Promise.resolve({ success: true })
      }
      return {
        bind: (...params: unknown[]) => ({
          run: async () => exec(params),
          first: async <T>() => {
            if (sql.startsWith('SELECT count FROM usage')) {
              const [bucket, now] = params as [string, number]
              const row = this.usage.get(bucket)
              return (row && row.expiresAt > now ? { count: row.count } : null) as T | null
            }
            return null
          }
        })
      }
    }
    async batch(statements: Array<{ run: () => Promise<unknown> }>): Promise<unknown[]> {
      const out: unknown[] = []
      for (const stmt of statements) out.push(await stmt.run())
      return out
    }
  }

  it('removes the devices row and only that id usage buckets', async () => {
    const { deleteDeviceData } = await import('../relay/src/quota')
    const db = new FakeD1()
    db.devices.set('dev1111111111111111', {})
    db.devices.set('dev2222222222222222', {})
    db.usage.set('dev:dev1111111111111111:day:2026-11-25', { count: 3, expiresAt: 1 })
    db.usage.set('dev:dev1111111111111111:slot:123', { count: 1, expiresAt: 1 })
    db.usage.set('dev:dev2222222222222222:day:2026-11-25', { count: 5, expiresAt: 1 })
    db.usage.set('global:groq:day:2026-11-25', { count: 9, expiresAt: 1 })

    await deleteDeviceData(db as unknown as Parameters<typeof deleteDeviceData>[0], 'dev1111111111111111')

    expect(db.devices.has('dev1111111111111111')).toBe(false)
    expect(db.devices.has('dev2222222222222222')).toBe(true)
    // Other id's counter + global budget + this id's new deletion tombstone.
    expect(db.usage.size).toBe(3)
    expect(db.usage.has('dev:dev2222222222222222:day:2026-11-25')).toBe(true)
    expect(db.usage.has('global:groq:day:2026-11-25')).toBe(true)
    expect(db.usage.has('burn:dev1111111111111111')).toBe(true)
  })

  it('removes the acct counters for a Google-account id', async () => {
    const { deleteDeviceData } = await import('../relay/src/quota')
    const db = new FakeD1()
    db.usage.set('acct:abc123:img:day:2026-11-25', { count: 2, expiresAt: 1 })
    db.usage.set('acct:abc123:txt:day:2026-11-25', { count: 9, expiresAt: 1 })
    db.usage.set('acct:other99:img:day:2026-11-25', { count: 4, expiresAt: 1 })

    await deleteDeviceData(db as unknown as Parameters<typeof deleteDeviceData>[0], 'acct:abc123')

    expect(db.usage.has('acct:abc123:img:day:2026-11-25')).toBe(false)
    expect(db.usage.has('acct:abc123:txt:day:2026-11-25')).toBe(false)
    expect(db.usage.has('acct:other99:img:day:2026-11-25')).toBe(true)
  })

  it('tombstones a deleted device id until a register reclaims it', async () => {
    const { clearDeviceBurn, deleteDeviceData, isDeviceBurned } = await import('../relay/src/quota')
    const db = new FakeD1()
    db.usage.set('dev:dev1111111111111111:day:2026-11-25', { count: 1, expiresAt: 1 })

    await deleteDeviceData(db as unknown as Parameters<typeof deleteDeviceData>[0], 'dev1111111111111111', 1000)
    expect(db.usage.has('dev:dev1111111111111111:day:2026-11-25')).toBe(false)
    expect(await isDeviceBurned(db as unknown as Parameters<typeof isDeviceBurned>[0], 'dev1111111111111111', 2000)).toBe(true)
    // Tombstone expires after 48h.
    expect(await isDeviceBurned(db as unknown as Parameters<typeof isDeviceBurned>[0], 'dev1111111111111111', 1000 + 2 * 24 * 3600 * 1000 + 1)).toBe(false)

    await clearDeviceBurn(db as unknown as Parameters<typeof clearDeviceBurn>[0], 'dev1111111111111111')
    expect(await isDeviceBurned(db as unknown as Parameters<typeof isDeviceBurned>[0], 'dev1111111111111111', 2000)).toBe(false)
  })
})
