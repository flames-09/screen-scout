import { net } from 'electron'
import type { HostedQuota } from '@shared/types'

/**
 * Client for the hosted relay.
 *
 * Responsibilities kept here (and out of the renderer):
 *  - resolve the relay URL (baked at build time, overridable by env for tests),
 *  - register a device once and cache its short-lived HMAC token,
 *  - refresh the token before it expires (and once on a 401),
 *  - fetch the free-tier quota for the Settings meter.
 *
 * No prompt, image, or key ever passes through this module — only the device
 * id (random, no PII), app version, and OS are sent at registration.
 */

export interface HostedDeps {
  /** Baked relay URL; empty string means hosted mode is unavailable. */
  relayUrl(): string
  deviceId(): string
  getStoredToken(): string | null
  saveToken(token: string): void
  clearToken(): void
  appVersion(): string
}

export class HostedError extends Error {
  constructor(
    public code: 'network' | 'unavailable' | 'unauthorized' | 'bad-response',
    message: string
  ) {
    super(message)
    this.name = 'HostedError'
  }
}

const EXPIRY_SKEW_MS = 90_000
/** Registration/quota calls must never hang the chat path indefinitely. */
const REQUEST_TIMEOUT_MS = 15_000

function decodeExpiry(token: string): number | null {
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  try {
    const payload = token.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/')
    const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { e?: unknown }
    return typeof json.e === 'number' ? json.e : null
  } catch {
    return null
  }
}

function normalizeQuota(value: unknown): HostedQuota | null {
  if (typeof value !== 'object' || value === null) return null
  const q = value as Record<string, unknown>
  const num = (key: string): number | null =>
    typeof q[key] === 'number' && Number.isFinite(q[key] as number) ? Math.max(0, Math.round(q[key] as number)) : null
  const dayUsed = num('dayUsed')
  const dayLimit = num('dayLimit')
  const dayRemaining = num('dayRemaining')
  const dayResetAt = num('dayResetAt')
  const windowUsed = num('windowUsed')
  const windowLimit = num('windowLimit')
  const windowRemaining = num('windowRemaining')
  const windowResetAt = num('windowResetAt')
  if (
    dayUsed === null ||
    dayLimit === null ||
    dayRemaining === null ||
    dayResetAt === null ||
    windowUsed === null ||
    windowLimit === null ||
    windowRemaining === null ||
    windowResetAt === null
  ) {
    return null
  }
  return { dayUsed, dayLimit, dayRemaining, dayResetAt, windowUsed, windowLimit, windowRemaining, windowResetAt }
}

export class HostedClient {
  private cached: { token: string; expiresAt: number } | null = null
  /** Shared in-flight registration (prevents duplicate per-IP registrations). */
  private registering: Promise<string> | null = null

  constructor(private deps: HostedDeps) {}

  relayUrl(): string {
    return this.deps.relayUrl().trim().replace(/\/+$/, '')
  }

  isAvailable(): boolean {
    return this.relayUrl() !== ''
  }

  chatUrl(): string {
    return `${this.relayUrl()}/v1/chat/completions`
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    if (!this.isAvailable()) throw new HostedError('unavailable', 'Hosted mode is not configured in this build.')
    // Bound every relay call: a half-open connection must not leave the
    // renderer stuck on "Thinking…" (the stream stall timer only starts once
    // streamNimChat owns the request).
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      return await net.fetch(`${this.relayUrl()}${path}`, {
        ...init,
        signal: controller.signal,
        credentials: 'omit'
      })
    } catch (error) {
      if (signal?.aborted) throw new HostedError('network', 'Request cancelled.')
      throw new HostedError(
        'network',
        error instanceof Error ? error.message : 'Could not reach the hosted relay.'
      )
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }

  /** Returns a valid device token, registering the device if needed. */
  async ensureToken(force = false, signal?: AbortSignal): Promise<string> {
    if (!force) {
      if (this.cached && this.cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return this.cached.token
      const stored = this.deps.getStoredToken()
      if (stored) {
        const expiresAt = decodeExpiry(stored)
        if (expiresAt && expiresAt - EXPIRY_SKEW_MS > Date.now()) {
          this.cached = { token: stored, expiresAt }
          return stored
        }
      }
    }
    // Single-flight: the quota fetch and the first chat can race right after
    // the user opts in, and two registrations would waste a per-IP slot.
    if (this.registering) return await this.registering
    const pending = this.register(signal)
    this.registering = pending
    try {
      return await pending
    } finally {
      if (this.registering === pending) this.registering = null
    }
  }

  /** Explicit re-registration — used when the relay rejects a token. */
  async refreshToken(signal?: AbortSignal): Promise<string> {
    this.cached = null
    this.deps.clearToken()
    return await this.ensureToken(true, signal)
  }

  private async register(signal?: AbortSignal): Promise<string> {
    const deviceId = this.deps.deviceId()
    if (!deviceId) throw new HostedError('bad-response', 'The app has no device id yet.')

    const response = await this.request(
      '/v1/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          appVersion: this.deps.appVersion(),
          os: process.platform
        })
      },
      signal
    )

    if (response.status === 429) {
      throw new HostedError('unavailable', 'Too many new devices from this network today.')
    }
    if (!response.ok) {
      throw new HostedError('bad-response', `The relay rejected device registration (HTTP ${response.status}).`)
    }

    let parsed: { token?: unknown; expiresAt?: unknown } = {}
    try {
      parsed = (await response.json()) as typeof parsed
    } catch {
      throw new HostedError('bad-response', 'The relay returned an unreadable registration response.')
    }
    if (typeof parsed.token !== 'string' || parsed.token.length < 16) {
      throw new HostedError('bad-response', 'The relay did not return a device token.')
    }

    const expiresAt =
      typeof parsed.expiresAt === 'number' ? parsed.expiresAt : (decodeExpiry(parsed.token) ?? Date.now() + 7 * 24 * 3600_000)
    this.cached = { token: parsed.token, expiresAt }
    this.deps.saveToken(parsed.token)
    return parsed.token
  }

  /** Headers for a chat request: device token refreshed if necessary. */
  async chatHeaders(force = false, signal?: AbortSignal): Promise<Record<string, string>> {
    return { 'x-device-token': await this.ensureToken(force, signal) }
  }

  /** Free-tier usage for the Settings meter. Never throws. */
  async fetchQuota(signal?: AbortSignal): Promise<HostedQuota | null> {
    if (!this.isAvailable()) return null
    try {
      const token = await this.ensureToken(false, signal)
      const response = await this.request(
        '/v1/quota',
        {
          method: 'GET',
          headers: { 'x-device-token': token }
        },
        signal
      )
      if (!response.ok) return null
      const parsed = (await response.json()) as { quota?: unknown }
      return normalizeQuota(parsed.quota)
    } catch {
      return null
    }
  }

  /** Health probe used by "Test connection" in hosted mode. */
  async testConnection(signal?: AbortSignal): Promise<{ ok: boolean; message: string; detail?: string }> {
    if (!this.isAvailable()) {
      return { ok: false, message: 'Hosted mode is not configured in this build.' }
    }
    try {
      const quota = await this.fetchQuota(signal)
      if (!quota) {
        return { ok: false, message: 'The hosted service did not answer. Try again shortly.' }
      }
      return {
        ok: true,
        message: `Free service reachable — ${quota.dayRemaining} of ${quota.dayLimit} questions left today.`,
        detail: `${quota.windowRemaining} of ${quota.windowLimit} left in the current ${Math.round(
          (quota.windowResetAt - Date.now()) / 60000
        )}-minute window.`
      }
    } catch (error) {
      return {
        ok: false,
        message: 'Could not reach the hosted service.',
        detail: error instanceof Error ? error.message : undefined
      }
    }
  }
}
