/**
 * Quota accounting.
 *
 * Two independent caps per device (daily + a rolling-ish 5-hour window), plus
 * account-wide caps per upstream provider so the free tiers can never be
 * exceeded. Counters live in D1: KV's free tier allows only 1,000 writes/day,
 * which is below the Groq allowance, and D1 supports conditional UPDATE ...
 * WHERE count < limit RETURNING for an atomic check-and-increment.
 */

import type { D1Database } from './types'

export interface QuotaLimits {
  perDay: number
  perWindow: number
  windowHours: number
}

export interface QuotaSnapshot {
  dayUsed: number
  dayLimit: number
  dayRemaining: number
  dayResetAt: number
  windowUsed: number
  windowLimit: number
  windowRemaining: number
  windowResetAt: number
}

export type ReserveOutcome =
  | { ok: true; snapshot: QuotaSnapshot }
  | { ok: false; reason: 'day' | 'window'; snapshot: QuotaSnapshot }

const HOUR_MS = 60 * 60 * 1000

export function dayBucket(now: number): string {
  return `day:${new Date(now).toISOString().slice(0, 10)}`
}

export function slotBucket(now: number, windowHours: number): string {
  const windowMs = Math.max(1, windowHours) * HOUR_MS
  return `slot:${Math.floor(now / windowMs)}`
}

export function dayResetAt(now: number): number {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
}

export function slotResetAt(now: number, windowHours: number): number {
  const windowMs = Math.max(1, windowHours) * HOUR_MS
  return (Math.floor(now / windowMs) + 1) * windowMs
}

/** Anything that can atomically count buckets. D1 in production, a Map in tests. */
export interface QuotaStore {
  /** Increments only while the stored count is below `limit`; null when at the cap. */
  incrementIfBelow(key: string, limit: number, expiresAt: number): Promise<number | null>
  decrement(key: string): Promise<void>
  read(key: string): Promise<number>
}

export class D1QuotaStore implements QuotaStore {
  constructor(private db: D1Database) {}

  async incrementIfBelow(key: string, limit: number, expiresAt: number): Promise<number | null> {
    // New bucket: insert 1. Existing bucket: bump only when under the cap.
    const row = await this.db
      .prepare(
        `INSERT INTO usage (bucket, count, expires_at) VALUES (?, 1, ?)
         ON CONFLICT(bucket) DO UPDATE SET count = count + 1, expires_at = excluded.expires_at
         WHERE usage.count < ?
         RETURNING count`
      )
      .bind(key, expiresAt, limit)
      .first<{ count: number }>()
    return row ? row.count : null
  }

  async decrement(key: string): Promise<void> {
    await this.db.prepare('UPDATE usage SET count = MAX(count - 1, 0) WHERE bucket = ?').bind(key).run()
  }

  async read(key: string): Promise<number> {
    const row = await this.db.prepare('SELECT count FROM usage WHERE bucket = ?').bind(key).first<{ count: number }>()
    return row ? row.count : 0
  }
}

function deviceDayKey(deviceId: string, now: number): string {
  return `dev:${deviceId}:${dayBucket(now)}`
}

function deviceSlotKey(deviceId: string, now: number, windowHours: number): string {
  return `dev:${deviceId}:${slotBucket(now, windowHours)}`
}

function snapshotFrom(
  now: number,
  limits: QuotaLimits,
  dayUsed: number,
  windowUsed: number
): QuotaSnapshot {
  return {
    dayUsed,
    dayLimit: limits.perDay,
    dayRemaining: Math.max(0, limits.perDay - dayUsed),
    dayResetAt: dayResetAt(now),
    windowUsed,
    windowLimit: limits.perWindow,
    windowRemaining: Math.max(0, limits.perWindow - windowUsed),
    windowResetAt: slotResetAt(now, limits.windowHours)
  }
}

/**
 * Reserves one question for this device. Order matters: check the daily cap
 * first, then the shorter window; if the window is full the daily counter is
 * rolled back so a rejected request consumes nothing.
 */
export async function reserveQuestion(
  store: QuotaStore,
  deviceId: string,
  limits: QuotaLimits,
  now = Date.now()
): Promise<ReserveOutcome> {
  const dayKey = deviceDayKey(deviceId, now)
  const slotKey = deviceSlotKey(deviceId, now, limits.windowHours)
  const dayExpiry = now + 2 * 24 * HOUR_MS
  const slotExpiry = now + (limits.windowHours + 1) * HOUR_MS

  const dayCount = await store.incrementIfBelow(dayKey, limits.perDay, dayExpiry)
  if (dayCount === null) {
    const snapshot = await quotaSnapshot(store, deviceId, limits, now)
    return { ok: false, reason: 'day', snapshot }
  }

  const windowCount = await store.incrementIfBelow(slotKey, limits.perWindow, slotExpiry)
  if (windowCount === null) {
    await store.decrement(dayKey)
    const snapshot = await quotaSnapshot(store, deviceId, limits, now)
    return { ok: false, reason: 'window', snapshot }
  }

  return { ok: true, snapshot: snapshotFrom(now, limits, dayCount, windowCount) }
}

/** Rolls back a reservation when no upstream ended up serving the request. */
export async function releaseQuestion(
  store: QuotaStore,
  deviceId: string,
  limits: QuotaLimits,
  now = Date.now()
): Promise<void> {
  await store.decrement(deviceDayKey(deviceId, now))
  await store.decrement(deviceSlotKey(deviceId, now, limits.windowHours))
}

export async function quotaSnapshot(
  store: QuotaStore,
  deviceId: string,
  limits: QuotaLimits,
  now = Date.now()
): Promise<QuotaSnapshot> {
  const [dayUsed, windowUsed] = await Promise.all([
    store.read(deviceDayKey(deviceId, now)),
    store.read(deviceSlotKey(deviceId, now, limits.windowHours))
  ])
  return snapshotFrom(now, limits, dayUsed, windowUsed)
}

/** Account-wide budget for one upstream provider. */
export async function reserveGlobal(
  store: QuotaStore,
  provider: 'groq' | 'cf',
  limit: number,
  now = Date.now()
): Promise<boolean> {
  const key = `global:${provider}:${dayBucket(now)}`
  const count = await store.incrementIfBelow(key, limit, now + 2 * 24 * HOUR_MS)
  return count !== null
}

export async function releaseGlobal(
  store: QuotaStore,
  provider: 'groq' | 'cf',
  now = Date.now()
): Promise<void> {
  await store.decrement(`global:${provider}:${dayBucket(now)}`)
}

/** Per-IP registration throttle (stops trivial token farming). */
export async function reserveRegistration(
  store: QuotaStore,
  ip: string,
  limit: number,
  now = Date.now()
): Promise<boolean> {
  const key = `reg:${ip}:${dayBucket(now)}`
  const count = await store.incrementIfBelow(key, limit, now + 2 * 24 * HOUR_MS)
  return count !== null
}

export function limitsFromEnv(env: {
  DEVICE_PER_DAY: string
  DEVICE_PER_WINDOW: string
  WINDOW_HOURS: string
}): QuotaLimits {
  const perDay = Math.max(1, Math.min(500, Number(env.DEVICE_PER_DAY) || 30))
  const perWindow = Math.max(1, Math.min(perDay, Number(env.DEVICE_PER_WINDOW) || 10))
  const windowHours = Math.max(1, Math.min(24, Number(env.WINDOW_HOURS) || 5))
  return { perDay, perWindow, windowHours }
}
