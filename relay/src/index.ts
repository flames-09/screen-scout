/**
 * Screen Scout relay — a tiny, free-tier-friendly credential broker.
 *
 * Why this exists: a desktop app cannot ship an API key (anything in an asar
 * is extractable), so managed access needs a server that holds the credential.
 * This Worker is that server. It:
 *
 *   - registers anonymous device ids and issues short-lived HMAC tokens,
 *   - enforces a per-device daily + 5-hour quota and account-wide provider
 *     budgets (so the free tiers can never be exceeded by accident),
 *   - forwards to Groq (OpenAI-compatible, passthrough) and fails over to
 *     Cloudflare Workers AI before the first byte reaches the client,
 *   - stores no screenshots, prompts, or answers — only counters.
 *
 * Deploy: see relay/README.md. Secrets: GROQ_API_KEY, TOKEN_SIGNING_SECRET.
 */

import { issueToken, isValidDeviceId, verifyToken, TOKEN_TTL_SECONDS } from './auth'
import {
  D1QuotaStore,
  limitsFromEnv,
  quotaSnapshot,
  releaseGlobal,
  releaseQuestion,
  reserveGlobal,
  reserveQuestion,
  reserveRegistration,
  type QuotaSnapshot
} from './quota'
import { landingPage, privacyPage, termsPage } from './pages'
import { parseChatBody, requestHasImage, routeProviders, tryGroq, tryWorkersAi, type ChatRequestBody } from './upstream'
import type { Env, ExecutionContextLike, ScheduledEventLike } from './types'

const RELAY_VERSION = '1.0.0'

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  })
}

function apiError(
  status: number,
  code: string,
  message: string,
  extra: { retryAfterSec?: number; quota?: QuotaSnapshot; detail?: string } = {}
): Response {
  const headers: Record<string, string> = {}
  if (extra.retryAfterSec !== undefined) headers['Retry-After'] = String(Math.max(1, Math.ceil(extra.retryAfterSec)))
  return json(
    status,
    {
      error: {
        code,
        message,
        ...(extra.detail ? { detail: extra.detail.slice(0, 300) } : {}),
        ...(extra.retryAfterSec !== undefined ? { retryAfterSec: Math.max(1, Math.ceil(extra.retryAfterSec)) } : {})
      },
      ...(extra.quota ? { quota: extra.quota } : {})
    },
    headers
  )
}

/**
 * Reads a request body but aborts as soon as it exceeds `maxBytes`.
 *
 * `request.text()` would buffer the whole body first, so a chunked request
 * with no `content-length` could force a multi-megabyte allocation just to be
 * rejected. Returns null only when the cap is exceeded; read failures REJECT
 * (the caller maps them to 400, distinct from 413).
 */
async function readLimited(request: Request, maxBytes: number): Promise<string | null> {
  const body = request.body
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}

function quotaHeaders(snapshot: QuotaSnapshot): Record<string, string> {
  const now = Date.now()
  return {
    'x-scout-day-remaining': String(snapshot.dayRemaining),
    'x-scout-day-limit': String(snapshot.dayLimit),
    'x-scout-window-remaining': String(snapshot.windowRemaining),
    'x-scout-window-limit': String(snapshot.windowLimit),
    'x-scout-day-reset': String(Math.round(snapshot.dayResetAt / 1000)),
    'x-scout-window-reset': String(Math.round(snapshot.windowResetAt / 1000)),
    'x-scout-now': String(Math.round(now / 1000))
  }
}

function sseHeaders(provider: 'groq' | 'cf', snapshot: QuotaSnapshot): Headers {
  const headers = new Headers({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'x-scout-provider': provider,
    'x-relay-version': RELAY_VERSION
  })
  for (const [key, value] of Object.entries(quotaHeaders(snapshot))) headers.set(key, value)
  return headers
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await request.json()) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
  if (!env.TOKEN_SIGNING_SECRET) {
    return apiError(500, 'misconfigured', 'The relay is missing its signing secret.')
  }
  const body = await readJson(request)
  const deviceId = body?.deviceId
  const appVersion = typeof body?.appVersion === 'string' ? body.appVersion : 'unknown'
  const os = typeof body?.os === 'string' ? body.os.slice(0, 40) : 'unknown'

  if (!isValidDeviceId(deviceId)) {
    return apiError(400, 'bad-request', 'deviceId must be a 16–64 character random identifier.')
  }

  const store = new D1QuotaStore(env.DB)
  const registrationLimit = Math.max(1, Number(env.REGISTRATIONS_PER_IP_PER_DAY) || 5)
  const allowed = await reserveRegistration(store, clientIp(request), registrationLimit)
  if (!allowed) {
    return apiError(429, 'rate-limit', 'Too many registrations from this network today.', { retryAfterSec: 3600 })
  }

  const now = Date.now()
  try {
    await env.DB.prepare(
      `INSERT INTO devices (device_id, created_at, last_seen, version, os) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET last_seen = excluded.last_seen, version = excluded.version, os = excluded.os`
    )
      .bind(deviceId, now, now, appVersion.slice(0, 40), os)
      .run()
  } catch {
    // Device bookkeeping is advisory; never block a registration on it.
  }

  const { token, expiresAt } = await issueToken(env.TOKEN_SIGNING_SECRET, deviceId, appVersion, now)
  const snapshot = await quotaSnapshot(store, deviceId, limitsFromEnv(env), now)
  return json(
    200,
    { token, expiresAt, ttlSec: TOKEN_TTL_SECONDS, quota: snapshot },
    quotaHeaders(snapshot)
  )
}

async function authenticate(request: Request, env: Env): Promise<{ deviceId: string } | Response> {
  if (!env.TOKEN_SIGNING_SECRET) {
    return apiError(500, 'misconfigured', 'The relay is missing its signing secret.')
  }
  const token = request.headers.get('x-device-token') ?? ''
  const payload = await verifyToken(env.TOKEN_SIGNING_SECRET, token)
  if (!payload) {
    return apiError(401, 'unauthorized', 'Device token is missing, invalid, or expired. Register again.')
  }
  return { deviceId: payload.d }
}

async function handleQuota(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env)
  if (auth instanceof Response) return auth
  const snapshot = await quotaSnapshot(new D1QuotaStore(env.DB), auth.deviceId, limitsFromEnv(env))
  return json(200, { quota: snapshot }, quotaHeaders(snapshot))
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env)
  if (auth instanceof Response) return auth

  const maxBody = Math.max(256 * 1024, Number(env.MAX_BODY_BYTES) || 6 * 1024 * 1024)
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > maxBody) {
    return apiError(413, 'too-large', 'The screenshot is too large for the free service.')
  }

  let raw: string
  try {
    const text = await readLimited(request, maxBody)
    if (text === null) {
      return apiError(413, 'too-large', 'The screenshot is too large for the free service.')
    }
    raw = text
  } catch {
    // Genuine read failure (e.g. the client vanished mid-upload) — not a size
    // problem, so it must not be reported as 413.
    return apiError(400, 'bad-request', 'Could not read the request body.')
  }
  if (raw.length > maxBody) {
    return apiError(413, 'too-large', 'The screenshot is too large for the free service.')
  }

  const parsed = parseChatBody(raw, env.PUBLIC_MODEL_ID)
  if (!parsed.ok) return apiError(400, 'bad-request', parsed.message)

  const store = new D1QuotaStore(env.DB)
  const limits = limitsFromEnv(env)
  const now = Date.now()

  const reservation = await reserveQuestion(store, auth.deviceId, limits, now)
  if (!reservation.ok) {
    const resetAt = reservation.reason === 'day' ? reservation.snapshot.dayResetAt : reservation.snapshot.windowResetAt
    const retryAfterSec = Math.max(1, Math.ceil((resetAt - now) / 1000))
    const label = reservation.reason === 'day' ? 'daily' : '5-hour'
    return apiError(
      429,
      'quota-exceeded',
      `The free ${label} limit is used up. It resets automatically — or switch to your own API key in Settings.`,
      { retryAfterSec, quota: reservation.snapshot }
    )
  }

  const body: ChatRequestBody = { ...parsed.body, stream: true }
  const wantsImage = requestHasImage(body)
  const globalGroq = Math.max(1, Number(env.GLOBAL_GROQ_PER_DAY) || 900)
  const globalCf = Math.max(1, Number(env.GLOBAL_CF_PER_DAY) || 130)

  let groqBudgetExhausted = false
  let cfBudgetExhausted = false
  let failureDetail = ''

  if (routeProviders(env, wantsImage) === 'groq-first') {
    if (await reserveGlobal(store, 'groq', globalGroq, now)) {
      const attempt = await tryGroq(env, body, request.signal)
      if (attempt.ok) {
        return new Response(attempt.response.body, { headers: sseHeaders('groq', reservation.snapshot) })
      }
      // Refund budget only when the request provably never reached Groq: a
      // network error (status 0) qualifies. A client abort does NOT — the
      // request may already have been delivered — and neither does any HTTP
      // answer, which Groq has already accounted for.
      if (attempt.status === 0 && !request.signal.aborted) await releaseGlobal(store, 'groq', now)
      failureDetail = `groq ${attempt.status}: ${attempt.detail}`
      // The client is gone — never spend the scarcest budget (Workers AI
      // neurons) computing an answer nobody will read.
      if (request.signal.aborted) {
        await releaseQuestion(store, auth.deviceId, limits, now)
        return apiError(499, 'client-cancelled', 'The request was cancelled.', { quota: reservation.snapshot })
      }
      // A 4xx from Groq that is about the request itself will not get better
      // at Workers AI (different model, but malformed is malformed) — still
      // try the fallback, it costs nothing.
    } else {
      groqBudgetExhausted = true
    }
  }

  if (await reserveGlobal(store, 'cf', globalCf, now)) {
    const attempt = await tryWorkersAi(env, body)
    if (attempt.ok) {
      return new Response(attempt.response.body, { headers: sseHeaders('cf', reservation.snapshot) })
    }
    // status 400 means buildCfInput rejected the request before calling the
    // model, so no neurons were spent; everything else stays counted.
    if (attempt.status === 0 || attempt.status === 400) await releaseGlobal(store, 'cf', now)
    failureDetail += ` | cf ${attempt.status}: ${attempt.detail}`
  } else {
    cfBudgetExhausted = true
  }

  // Nothing served the request: give the quota slot back and report honestly.
  await releaseQuestion(store, auth.deviceId, limits, now)

  // An image turn has exactly one multimodal provider configured; when its
  // budget is gone the service is effectively at capacity, even if the
  // text-only provider still has room.
  const noImageCapacity = wantsImage && cfBudgetExhausted
  if ((groqBudgetExhausted && cfBudgetExhausted) || noImageCapacity) {
    const retryAfterSec = Math.max(60, Math.ceil((reservation.snapshot.dayResetAt - now) / 1000))
    return apiError(
      503,
      'capacity-exhausted',
      'The free service is at capacity for today. It resets at midnight UTC — or switch to your own API key in Settings.',
      { retryAfterSec, quota: reservation.snapshot, detail: failureDetail }
    )
  }

  return apiError(502, 'upstream-failed', 'The model provider did not answer. Try again in a moment.', {
    retryAfterSec: 20,
    quota: reservation.snapshot,
    detail: failureDetail
  })
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (request.method === 'GET' && path === '/') return landingPage()
    if (request.method === 'GET' && path === '/privacy') return privacyPage()
    if (request.method === 'GET' && path === '/terms') return termsPage()
    if (request.method === 'GET' && path === '/health') {
      return json(200, {
        ok: true,
        version: RELAY_VERSION,
        groqConfigured: Boolean(env.GROQ_API_KEY),
        signingConfigured: Boolean(env.TOKEN_SIGNING_SECRET),
        limits: limitsFromEnv(env),
        providers: ['groq', 'cloudflare-workers-ai']
      })
    }

    if (path === '/v1/register' && request.method === 'POST') return handleRegister(request, env)
    if (path === '/v1/quota' && request.method === 'GET') return handleQuota(request, env)
    if (path === '/v1/chat/completions' && request.method === 'POST') return handleChat(request, env)

    return apiError(404, 'not-found', 'Unknown relay endpoint.')
  },

  async scheduled(_event: ScheduledEventLike, env: Env, ctx: ExecutionContextLike): Promise<void> {
    // Old counter rows are useless; drop them so D1 stays tiny. Device rows
    // are tiny too, but idle ones are pruned after 30 days (the privacy page
    // states this retention).
    const now = Date.now()
    const idleCutoff = now - 30 * 24 * 3600_000
    ctx.waitUntil(
      Promise.all([
        env.DB.prepare('DELETE FROM usage WHERE expires_at < ?').bind(now).run().catch(() => undefined),
        env.DB.prepare('DELETE FROM devices WHERE last_seen < ?').bind(idleCutoff).run().catch(() => undefined)
      ]).then(() => undefined)
    )
  }
}
