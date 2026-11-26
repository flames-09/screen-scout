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

import {
  accountHashFromGoogleSub,
  isAccountDeviceId,
  issueToken,
  isValidDeviceId,
  verifyGoogleIdToken,
  verifyToken,
  TOKEN_TTL_SECONDS
} from './auth'
import { isOlderThan } from './version'
import {
  D1QuotaStore,
  accountLimitsFromEnv,
  accountQuotaSnapshot,
  clearDeviceBurn,
  deleteDeviceData,
  isDeviceBurned,
  limitsFromEnv,
  quotaSnapshot,
  reserveDeletion,
  releaseAccountQuestion,
  releaseGlobal,
  releaseQuestion,
  reserveAccountQuestion,
  reserveGlobal,
  reserveQuestion,
  reserveRegistration,
  type AccountQuestionKind,
  type AccountQuotaSnapshot,
  type QuotaSnapshot
} from './quota'
import { guidelinesPage, landingPage, privacyPage, termsPage } from './pages'
import { parseChatBody, requestHasImage, routeProviders, tryGroq, tryNvidia, tryWorkersAi, type ChatRequestBody } from './upstream'
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
  extra: {
    retryAfterSec?: number
    quota?: QuotaSnapshot
    accountQuota?: AccountQuotaSnapshot
    detail?: string
  } = {}
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
      ...(extra.quota ? { quota: extra.quota } : {}),
      ...(extra.accountQuota ? { accountQuota: extra.accountQuota } : {})
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

function sseHeaders(provider: 'groq' | 'cf' | 'nvidia', snapshot: QuotaSnapshot): Headers {
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

function accountQuotaHeaders(snapshot: AccountQuotaSnapshot): Record<string, string> {
  const now = Date.now()
  return {
    'x-scout-kind': 'account',
    'x-scout-images-remaining': String(snapshot.imagesRemaining),
    'x-scout-images-limit': String(snapshot.imagesLimit),
    'x-scout-chats-remaining': String(snapshot.chatsRemaining),
    'x-scout-chats-limit': String(snapshot.chatsLimit),
    'x-scout-day-reset': String(Math.round(snapshot.dayResetAt / 1000)),
    'x-scout-now': String(Math.round(now / 1000))
  }
}

/** Streaming headers for a signed-in account (image/chat split instead of day/window). */
function sseAccountHeaders(provider: 'groq' | 'cf' | 'nvidia', snapshot: AccountQuotaSnapshot): Headers {
  const headers = new Headers({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'x-scout-provider': provider,
    'x-relay-version': RELAY_VERSION
  })
  for (const [key, value] of Object.entries(accountQuotaHeaders(snapshot))) headers.set(key, value)
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
  if (env.HOSTED_ENABLED === 'false') {
    return apiError(503, 'hosted-disabled', 'The free hosted service is paused for maintenance.')
  }
  const body = await readJson(request)
  const deviceId = body?.deviceId
  const appVersion = typeof body?.appVersion === 'string' ? body.appVersion : 'unknown'
  const os = typeof body?.os === 'string' ? body.os.slice(0, 40) : 'unknown'

  if (!isValidDeviceId(deviceId)) {
    return apiError(400, 'bad-request', 'deviceId must be a 16–64 character random identifier.')
  }

  // Version gate: clients older than MIN_APP_VERSION must update before the
  // hosted service will serve them (protects new relay contracts/limits).
  const minimum = (env.MIN_APP_VERSION ?? '').trim()
  if (minimum && minimum !== '0.0.0' && isOlderThan(appVersion, minimum)) {
    return apiError(426, 'update-required', 'This app version is too old for the free hosted service. Update Screen Scout.')
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

  // A fresh registration through the IP-throttled door explicitly reclaims a
  // previously deleted device id (clears its deletion tombstone).
  try {
    await clearDeviceBurn(env.DB, deviceId)
  } catch {
    // Same advisory contract: a stale tombstone only means the id stays 403.
  }

  const { token, expiresAt } = await issueToken(env.TOKEN_SIGNING_SECRET, deviceId, appVersion, now)
  const snapshot = await quotaSnapshot(store, deviceId, limitsFromEnv(env), now)
  return json(
    200,
    { token, expiresAt, ttlSec: TOKEN_TTL_SECONDS, quota: snapshot },
    quotaHeaders(snapshot)
  )
}

/**
 * Google Sign-In exchange: the app obtains an ID token via system-browser
 * OAuth (PKCE, loopback redirect) and trades it here for the same HMAC token
 * devices use. The relay verifies the token with Google, stores ONLY a keyed
 * hash of the subject id, and issues an `acct:<hex>` token. Per-IP throttle
 * shared with anonymous registration stops token farming.
 */
async function handleGoogleAuth(request: Request, env: Env): Promise<Response> {
  if (!env.TOKEN_SIGNING_SECRET) {
    return apiError(500, 'misconfigured', 'The relay is missing its signing secret.')
  }
  // Parse the body BEFORE the service gate: the version claim needed to
  // evaluate MIN_APP_VERSION correctly rides in it ('unknown' would 426
  // every client once a real minimum is set).
  const body = await readJson(request)
  const idToken = typeof body?.idToken === 'string' ? body.idToken : ''
  const appVersion = typeof body?.appVersion === 'string' ? body.appVersion.slice(0, 40) : 'unknown'
  const gated = hostedServiceGates(env, appVersion)
  if (gated) return gated
  const clientId = (env.GOOGLE_CLIENT_ID ?? '').trim()
  if (!clientId) {
    return apiError(503, 'google-not-configured', 'Google sign-in is not enabled on this relay yet.')
  }

  const claims = await verifyGoogleIdToken((url) => fetch(url), idToken, clientId)
  if (!claims) {
    return apiError(401, 'google-token-invalid', 'Google sign-in failed or the credential expired. Try again.')
  }

  const store = new D1QuotaStore(env.DB)
  const registrationLimit = Math.max(1, Number(env.REGISTRATIONS_PER_IP_PER_DAY) || 5)
  if (!(await reserveRegistration(store, clientIp(request), registrationLimit))) {
    return apiError(429, 'rate-limit', 'Too many sign-ins from this network today.', { retryAfterSec: 3600 })
  }

  const hash = await accountHashFromGoogleSub(env.TOKEN_SIGNING_SECRET, claims.sub)
  const { token, expiresAt } = await issueToken(env.TOKEN_SIGNING_SECRET, hash, appVersion)
  const snapshot = await accountQuotaSnapshot(store, hash, accountLimitsFromEnv(env))
  return json(
    200,
    { token, expiresAt, ttlSec: TOKEN_TTL_SECONDS, kind: 'account', accountQuota: snapshot },
    accountQuotaHeaders(snapshot)
  )
}

async function authenticate(request: Request, env: Env): Promise<{ deviceId: string; version: string } | Response> {
  if (!env.TOKEN_SIGNING_SECRET) {
    return apiError(500, 'misconfigured', 'The relay is missing its signing secret.')
  }
  const token = request.headers.get('x-device-token') ?? ''
  const payload = await verifyToken(env.TOKEN_SIGNING_SECRET, token)
  if (!payload) {
    return apiError(401, 'unauthorized', 'Device token is missing, invalid, or expired. Register again.')
  }
  // Deletion tombstone: a deleted id serves nothing until it is explicitly
  // re-claimed through the IP-throttled /v1/register door. This keeps
  // "delete my data" from doubling as a free quota reset.
  if (await isDeviceBurned(env.DB, payload.d)) {
    return apiError(403, 'token-revoked', 'This device was deleted. Register again to continue.')
  }
  return { deviceId: payload.d, version: typeof payload.v === 'string' ? payload.v : 'unknown' }
}

/**
 * Gates shared by every hosted surface: the kill switch pauses the whole free
 * tier, and the version gate protects the wire contract from very old apps
 * (a client's version rides in its signed token's `v` claim).
 */
function hostedServiceGates(env: Env, appVersion: string): Response | null {
  if (env.HOSTED_ENABLED === 'false') {
    return apiError(503, 'hosted-disabled', 'The free hosted service is paused for maintenance.')
  }
  const minimum = (env.MIN_APP_VERSION ?? '').trim()
  if (minimum && minimum !== '0.0.0' && isOlderThan(appVersion, minimum)) {
    return apiError(426, 'update-required', 'This app version is too old for the free hosted service. Update Screen Scout.')
  }
  return null
}

async function handleQuota(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env)
  if (auth instanceof Response) return auth
  const gated = hostedServiceGates(env, auth.version)
  if (gated) return gated
  const store = new D1QuotaStore(env.DB)
  if (isAccountDeviceId(auth.deviceId)) {
    const snapshot = await accountQuotaSnapshot(store, auth.deviceId, accountLimitsFromEnv(env))
    return json(200, { kind: 'account', accountQuota: snapshot }, accountQuotaHeaders(snapshot))
  }
  const snapshot = await quotaSnapshot(store, auth.deviceId, limitsFromEnv(env))
  return json(200, { quota: snapshot }, quotaHeaders(snapshot))
}

/**
 * Account deletion. Removes every stored row tied to the token's id - the
 * devices row (device ids) or the account counters (acct ids) - and reports
 * which kind of id it was. The HMAC token itself is stateless and simply
 * expires; after this call its id owns no data on the relay. Device ids are
 * tombstoned for 48h (a register call reclaims them) so deletion cannot be
 * replayed as a quota reset; the endpoint itself is IP-throttled per day.
 */
async function handleAccountDelete(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env)
  if (auth instanceof Response) return auth
  const store = new D1QuotaStore(env.DB)
  const deleteLimit = Math.max(1, Number(env.DELETES_PER_IP_PER_DAY) || 3)
  if (!(await reserveDeletion(store, clientIp(request), deleteLimit))) {
    return apiError(429, 'rate-limit', 'Too many deletions from this network today.', { retryAfterSec: 3600 })
  }
  await deleteDeviceData(env.DB, auth.deviceId)
  const kind = isAccountDeviceId(auth.deviceId) ? 'account' : 'device'
  return json(200, { ok: true, kind })
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env)
  if (auth instanceof Response) return auth
  const gated = hostedServiceGates(env, auth.version)
  if (gated) return gated

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
  const accountLimits = accountLimitsFromEnv(env)
  const now = Date.now()

  // Local reservation (device quota, or the account daily split) before any
  // upstream contact; shared provider pools are reserved per attempt below.
  const isAccount = isAccountDeviceId(auth.deviceId)
  const wantsImage = requestHasImage(parsed.body)

  type LocalReservation =
    | { kind: 'device'; snapshot: QuotaSnapshot }
    | { kind: 'account'; questionKind: AccountQuestionKind; snapshot: AccountQuotaSnapshot }

  const releaseLocal = async (current: LocalReservation): Promise<void> => {
    if (current.kind === 'account') await releaseAccountQuestion(store, auth.deviceId, current.questionKind, now)
    else await releaseQuestion(store, auth.deviceId, limits, now)
  }
  const quotaExtra = (
    current: LocalReservation
  ): { quota?: QuotaSnapshot; accountQuota?: AccountQuotaSnapshot } =>
    current.kind === 'account' ? { accountQuota: current.snapshot } : { quota: current.snapshot }
  const streamHeaders = (current: LocalReservation, provider: 'groq' | 'cf' | 'nvidia'): Headers =>
    current.kind === 'account' ? sseAccountHeaders(provider, current.snapshot) : sseHeaders(provider, current.snapshot)

  let local: LocalReservation
  if (isAccount) {
    const questionKind: AccountQuestionKind = wantsImage ? 'image' : 'chat'
    const reserved = await reserveAccountQuestion(store, auth.deviceId, questionKind, accountLimits, now)
    if (!reserved.ok) {
      const accountSnapshot = await accountQuotaSnapshot(store, auth.deviceId, accountLimits, now)
      const limit = questionKind === 'image' ? accountLimits.imagesPerDay : accountLimits.chatsPerDay
      const label = questionKind === 'image' ? 'image' : 'chat'
      return apiError(
        429,
        'quota-exceeded',
        `The account ${label} limit (${limit} per day) is used up. It resets at midnight UTC — or switch to your own API key in Settings.`,
        {
          retryAfterSec: Math.max(1, Math.ceil((accountSnapshot.dayResetAt - now) / 1000)),
          accountQuota: accountSnapshot
        }
      )
    }
    local = {
      kind: 'account',
      questionKind,
      snapshot: await accountQuotaSnapshot(store, auth.deviceId, accountLimits, now)
    }
  } else {
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
    local = { kind: 'device', snapshot: reservation.snapshot }
  }

  const body: ChatRequestBody = { ...parsed.body, stream: true }
  const route = routeProviders(env, wantsImage)
  const globalGroq = Math.max(1, Number(env.GLOBAL_GROQ_PER_DAY) || 900)
  const globalCf = Math.max(1, Number(env.GLOBAL_CF_PER_DAY) || 130)
  const globalNvidia = Math.max(1, Number(env.GLOBAL_NVIDIA_PER_DAY) || 400)

  let groqBudgetExhausted = false
  let cfBudgetExhausted = false
  let nvidiaBudgetExhausted = false
  let failureDetail = ''

  if (route === 'nvidia-first') {
    if (await reserveGlobal(store, 'nvidia', globalNvidia, now)) {
      const attempt = await tryNvidia(env, body, request.signal)
      if (attempt.ok) {
        return new Response(attempt.response.body, { headers: streamHeaders(local, 'nvidia') })
      }
      // Same refund discipline as Groq: only a network-level failure (status 0)
      // provably never reached NVIDIA; any HTTP answer stays counted.
      if (attempt.status === 0 && !request.signal.aborted) await releaseGlobal(store, 'nvidia', now)
      failureDetail += `nvidia ${attempt.status}: ${attempt.detail}`
      console.warn('[relay] nvidia upstream failed', { status: attempt.status, detail: attempt.detail.slice(0, 300) })
      // The client is gone — don't spend Workers AI neurons on an answer
      // nobody will read.
      if (request.signal.aborted) {
        await releaseLocal(local)
        return apiError(499, 'client-cancelled', 'The request was cancelled.', quotaExtra(local))
      }
      // An image turn NVIDIA rejected on its merits may still succeed on the
      // Workers AI fallback below (different model, different limits).
    } else {
      nvidiaBudgetExhausted = true
    }
  }

  if (route === 'groq-first') {
    if (await reserveGlobal(store, 'groq', globalGroq, now)) {
      const attempt = await tryGroq(env, body, request.signal)
      if (attempt.ok) {
        return new Response(attempt.response.body, { headers: streamHeaders(local, 'groq') })
      }
      // Refund budget only when the request provably never reached Groq: a
      // network error (status 0) qualifies. A client abort does NOT — the
      // request may already have been delivered — and neither does any HTTP
      // answer, which Groq has already accounted for.
      if (attempt.status === 0 && !request.signal.aborted) await releaseGlobal(store, 'groq', now)
      failureDetail = `groq ${attempt.status}: ${attempt.detail}`
      console.warn('[relay] groq upstream failed', { status: attempt.status, detail: attempt.detail.slice(0, 300) })
      // The client is gone — never spend the scarcest budget (Workers AI
      // neurons) computing an answer nobody will read.
      if (request.signal.aborted) {
        await releaseLocal(local)
        return apiError(499, 'client-cancelled', 'The request was cancelled.', quotaExtra(local))
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
      return new Response(attempt.response.body, { headers: streamHeaders(local, 'cf') })
    }
    // status 400 means buildCfInput rejected the request before calling the
    // model, so no neurons were spent; everything else stays counted.
    if (attempt.status === 0 || attempt.status === 400) await releaseGlobal(store, 'cf', now)
    failureDetail += ` | cf ${attempt.status}: ${attempt.detail}`
    console.warn('[relay] cf upstream failed', { status: attempt.status, detail: attempt.detail.slice(0, 300) })
  } else {
    cfBudgetExhausted = true
  }

  // Nothing served the request: give the quota slot back and report honestly.
  await releaseLocal(local)

  // An image turn has only multimodal providers (NVIDIA when configured, plus
  // Workers AI); when both budgets are gone the service is effectively at
  // capacity, even if the text-only provider still has room.
  const noImageCapacity = wantsImage && cfBudgetExhausted && (!env.NVIDIA_API_KEY || nvidiaBudgetExhausted)
  if ((groqBudgetExhausted && cfBudgetExhausted) || noImageCapacity) {
    const retryAfterSec = Math.max(60, Math.ceil((local.snapshot.dayResetAt - now) / 1000))
    return apiError(
      503,
      'capacity-exhausted',
      'The free service is at capacity for today. It resets at midnight UTC — or switch to your own API key in Settings.',
      { retryAfterSec, ...quotaExtra(local), detail: failureDetail }
    )
  }

  return apiError(502, 'upstream-failed', 'The model provider did not answer. Try again in a moment.', {
    retryAfterSec: 20,
    ...quotaExtra(local),
    detail: failureDetail
  })
}

/**
 * Update feed. Manifest rows live in D1 — one per platform ('win',
 * 'mac-arm64', 'mac-x64') — and point at the installers on GitHub Releases:
 * free hosting, no payment method required (R2 demands a card even on its
 * free tier). latest.json keeps the win manifest at the top level so clients
 * shipped before per-platform feeds keep working, and adds a `platforms`
 * map for platform-aware clients. The desktop client resolves the manifest's
 * absolute URL itself and verifies sha256 after download.
 */
export interface UpdateManifest {
  version: string
  url: string
  sha256: string
  sizeBytes: number
  notes: string
  pubDate: string
}

export interface UpdateManifestRow extends UpdateManifest {
  platform: string
}

const UPDATE_FEED_WIN = 'win'

const UPDATE_FEED_UNCONFIGURED: [number, string, string] = [
  503,
  'updates-unavailable',
  'The update feed is not configured on this relay.'
]

async function readUpdateManifestRows(env: Env): Promise<UpdateManifestRow[]> {
  const result = await env.DB.prepare(
    'SELECT platform, version, url, sha256, size_bytes AS sizeBytes, notes, pub_date AS pubDate FROM update_manifest'
  ).all<UpdateManifestRow>()
  return (result.results ?? []).filter(
    (row) =>
      typeof row.platform === 'string' &&
      row.platform !== '' &&
      typeof row.version === 'string' &&
      typeof row.url === 'string' &&
      typeof row.sha256 === 'string' &&
      typeof row.sizeBytes === 'number'
  )
}

function stripManifestRow(row: UpdateManifestRow): UpdateManifest {
  return {
    version: row.version,
    url: row.url,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    notes: row.notes,
    pubDate: row.pubDate
  }
}

/** latest.json is the version pointer — must never be cached. */
export async function serveUpdateManifest(env: Env): Promise<Response> {
  let rows: UpdateManifestRow[]
  try {
    rows = await readUpdateManifestRows(env)
  } catch {
    return apiError(503, 'updates-unavailable', 'The update feed is temporarily unavailable.')
  }
  const win = rows.find((row) => row.platform === UPDATE_FEED_WIN)
  // The Windows feed is the primary pointer; without it the feed is
  // considered unconfigured even if other platforms exist.
  if (!win) return apiError(...UPDATE_FEED_UNCONFIGURED)
  const platforms: Record<string, UpdateManifest> = {}
  for (const row of rows) platforms[row.platform] = stripManifestRow(row)
  return json(200, { ...stripManifestRow(win), platforms })
}

/** /updates/<file>: humans and relative links land on the real download. */
export async function serveUpdateRedirect(env: Env, requested: string): Promise<Response> {
  let rows: UpdateManifestRow[]
  try {
    rows = await readUpdateManifestRows(env)
  } catch {
    return apiError(503, 'updates-unavailable', 'The update feed is temporarily unavailable.')
  }
  for (const row of rows) {
    const fileName = row.url.split('/').pop() ?? ''
    if (requested === `updates/${fileName}`) {
      return new Response(null, {
        status: 302,
        headers: { Location: row.url, 'Cache-Control': 'no-store' }
      })
    }
  }
  return apiError(404, 'not-found', 'Unknown update asset.')
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (request.method === 'GET' && path === '/') return landingPage()
    if (request.method === 'GET' && path === '/privacy') return privacyPage()
    if (request.method === 'GET' && path === '/terms') return termsPage()
    if (request.method === 'GET' && path === '/guidelines') return guidelinesPage()
    if (request.method === 'GET' && path === '/health') {
      return json(200, {
        ok: true,
        version: RELAY_VERSION,
        groqConfigured: Boolean(env.GROQ_API_KEY),
        nvidiaConfigured: Boolean(env.NVIDIA_API_KEY),
        signingConfigured: Boolean(env.TOKEN_SIGNING_SECRET),
        googleConfigured: Boolean((env.GOOGLE_CLIENT_ID ?? '').trim()),
        limits: limitsFromEnv(env),
        providers: env.NVIDIA_API_KEY
          ? ['nvidia', 'cloudflare-workers-ai', 'groq']
          : ['groq', 'cloudflare-workers-ai']
      })
    }

    // Update feed: manifest from D1, installer bytes on GitHub Releases.
    if (request.method === 'GET' && path === '/updates/latest.json') {
      return serveUpdateManifest(env)
    }
    if (request.method === 'GET' && path.startsWith('/updates/')) {
      return serveUpdateRedirect(env, path.slice(1))
    }

    if (path === '/v1/register' && request.method === 'POST') return handleRegister(request, env)
    if (path === '/v1/auth/google' && request.method === 'POST') return handleGoogleAuth(request, env)
    if (path === '/v1/quota' && request.method === 'GET') return handleQuota(request, env)
    if (path === '/v1/chat/completions' && request.method === 'POST') return handleChat(request, env)
    if (path === '/v1/account/delete' && request.method === 'POST') return handleAccountDelete(request, env)

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
