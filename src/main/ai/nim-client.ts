import type { ChatErrorMessage, ChatTurn } from '@shared/types'
import { SseParser } from './stream-parser'

/**
 * NVIDIA NIM chat-completions client (OpenAI-compatible schema).
 *
 * Runs in the Electron main process ONLY — the renderer never sees the API
 * key or performs network calls. All logic is pure / dependency-free aside
 * from `fetch`, which is injectable for unit tests.
 *
 * Verified payload format (NVIDIA NIM docs, chat.completions):
 *   content: [
 *     { "type": "text", "text": "..." },
 *     { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
 *   ]
 * Streaming uses SSE with a terminal `data: [DONE]` event.
 */

export const DEFAULT_SYSTEM_PROMPT = [
  'You are a helpful desktop visual assistant. The user shows you a screenshot of their screen and asks about it.',
  '',
  'How to answer:',
  '- Lead with the direct answer to the question. No preamble ("Sure!", "Certainly") and no restating the question.',
  '- Be specific: quote the exact text, numbers, filenames, error codes, and UI labels visible in the screenshot whenever they matter. Transcribe visible text exactly rather than paraphrasing it.',
  '- Be concise by default: a few sentences or a short bullet list is usually right. Use bullets when comparing or listing. Go longer only when the question genuinely needs it (debugging, multi-step instructions, explanations that build on each other).',
  '- Explain, do not just describe: if the user asks why something happens or what to do next, give the reasoning and concrete next steps.',
  '- If something is cut off, blurry, or not visible, say what you can see and state plainly what you cannot.',
  '- Never claim to have interacted with the computer beyond what the screenshot shows, and never invent UI elements, buttons, or files that are not visible.',
  '- Reply in the language the question is written in. Use markdown sparingly: short bullet lists where they help, no headers for short answers.'
].join('\n')

export interface NimRequestOptions {
  baseUrl: string
  /** Required in BYOK mode; omitted in hosted mode (the relay holds the key). */
  apiKey?: string
  /** Extra request headers, e.g. the hosted X-Device-Token. */
  headers?: Record<string, string>
  model: string
  systemPrompt?: string
  /** Prior turns (user/assistant) sent as minimal context. */
  history?: ChatTurn[]
  userText: string
  /** PNG/JPEG data URL of the cropped selection. */
  imageDataUrl?: string
  maxTokens?: number
  temperature?: number
  stream?: boolean
}

export interface BuiltRequest {
  url: string
  headers: Record<string, string>
  body: string
}

export function buildNimRequest(options: NimRequestOptions): BuiltRequest {
  const {
    baseUrl,
    apiKey,
    headers: extraHeaders = {},
    model,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    history = [],
    userText,
    imageDataUrl,
    maxTokens = 1024,
    temperature = 0.2,
    stream = true
  } = options

  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    imageDataUrl
      ? {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: imageDataUrl } }
          ]
        }
      : { role: 'user', content: userText }
  ]

  const body = JSON.stringify({
    model,
    messages,
    stream,
    max_tokens: Math.min(8192, Math.max(1, maxTokens)),
    temperature
  })

  return {
    url: baseUrl,
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...extraHeaders,
      Accept: stream ? 'text/event-stream' : 'application/json',
      'Content-Type': 'application/json'
    },
    body
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

const USER_MESSAGES: Record<ChatErrorMessage['code'], string> = {
  'no-key': 'Add your NVIDIA API key in Settings to start asking questions.',
  'invalid-key': 'NVIDIA rejected this API key. Check the key in Settings.',
  'payment-required': 'The NVIDIA API account reports that no usable credits or quota are available.',
  'rate-limit': 'NVIDIA is receiving too many requests. Try again shortly.',
  'quota-exceeded':
    'The free limit is used up for now. It resets automatically — or switch to your own API key in Settings.',
  'hosted-unavailable':
    "Couldn't reach the free hosted service. Check your connection, or switch to your own API key in Settings.",
  'bad-request': 'NVIDIA rejected the request as invalid. Check the model name in Settings.',
  'unsupported-image': 'This model does not support screenshots. Choose a vision-capable model in Settings.',
  network: "Couldn't reach NVIDIA. Check your connection and try again.",
  timeout: 'The request took too long and was stopped. Try again, or pick a faster model.',
  stalled: 'The response stopped streaming before it finished. Try again.',
  server: "NVIDIA's service reported a problem. Try again shortly.",
  'empty-response': 'The model returned an empty response. Try again or choose another model.',
  cancelled: 'Request cancelled.',
  unknown: 'Something went wrong while contacting NVIDIA. Try again.'
}

export function nimError(
  code: ChatErrorMessage['code'],
  opts: { detail?: string; retryable?: boolean; retryAfterSec?: number; message?: string } = {}
): ChatErrorMessage {
  return {
    code,
    message: opts.message ?? USER_MESSAGES[code],
    detail: opts.detail ? sanitizeDetail(opts.detail) : undefined,
    retryable: opts.retryable ?? false,
    ...(opts.retryAfterSec !== undefined ? { retryAfterSec: Math.max(1, Math.round(opts.retryAfterSec)) } : {})
  }
}

/** Reads the relay's `{ error: { retryAfterSec } }` hint when present. */
export function parseRetryAfterSec(bodyText: string): number | undefined {
  try {
    const parsed = JSON.parse(bodyText) as {
      retryAfterSec?: unknown
      error?: { retryAfterSec?: unknown }
    }
    const value = parsed?.error?.retryAfterSec ?? parsed?.retryAfterSec
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.ceil(value)
  } catch {
    // Not JSON — no hint.
  }
  return undefined
}

/** Keeps a short, safe technical detail string (status codes, API error text). */
function sanitizeDetail(detail: string): string {
  return detail.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** Extracts a human-safe message from an HTTP error body without leaking payloads. */
function describeHttpBody(text: string): string {
  try {
    const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown; error?: { message?: unknown } | string; title?: unknown }
    const parts: string[] = []
    if (typeof parsed.title === 'string') parts.push(parsed.title)
    const detail = parsed.detail
    if (typeof detail === 'string') parts.push(detail)
    else if (detail && typeof detail === 'object') {
      const msgs = JSON.stringify(detail).slice(0, 200)
      parts.push(msgs)
    }
    if (typeof parsed.error === 'string') parts.push(parsed.error)
    else if (parsed.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string') {
      parts.push(parsed.error.message)
    }
    if (typeof parsed.message === 'string') parts.push(parsed.message)
    return parts.join(' · ')
  } catch {
    return text.slice(0, 200)
  }
}

export function mapHttpStatus(
  status: number,
  bodyText: string,
  context: { hosted?: boolean } = {}
): ChatErrorMessage {
  const detail = describeHttpBody(bodyText)
  const retryAfterSec = parseRetryAfterSec(bodyText)
  const hosted = context.hosted === true
  switch (status) {
    case 401:
      // In hosted mode this means the device token was rejected; ChatService
      // refreshes once and then rewrites the user-facing message.
      return nimError('invalid-key', { detail: `HTTP 401${detail ? ` — ${detail}` : ''}` })
    case 402:
      return nimError('payment-required', { detail: `HTTP 402${detail ? ` — ${detail}` : ''}` })
    case 404:
      return nimError('bad-request', {
        detail: `HTTP 404 — model not found${detail ? `: ${detail}` : ''}`
      })
    case 413:
      return nimError('unsupported-image', {
        detail: `HTTP 413${detail ? ` — ${detail}` : ''}`,
        ...(hosted
          ? { message: 'That screenshot is too large for the free service. Select a smaller area and try again.' }
          : {})
      })
    case 429:
      return hosted
        ? nimError('quota-exceeded', {
            detail: `HTTP 429${detail ? ` — ${detail}` : ''}`,
            retryAfterSec
          })
        : nimError('rate-limit', { detail: `HTTP 429${detail ? ` — ${detail}` : ''}` })
    case 503:
      return hosted
        ? nimError('hosted-unavailable', {
            detail: `HTTP 503${detail ? ` — ${detail}` : ''}`,
            retryAfterSec
          })
        : nimError('server', { detail: `HTTP 503${detail ? ` — ${detail}` : ''}`, retryable: true })
    case 400:
    case 422: {
      const looksImageRelated = /image|vision|multi.?modal|unsupported media|content part/i.test(detail)
      return nimError(looksImageRelated ? 'unsupported-image' : 'bad-request', {
        detail: `HTTP ${status}${detail ? ` — ${detail}` : ''}`
      })
    }
    default:
      if (hosted && status >= 500) {
        // Relay reported an upstream/provider failure — same friendly copy as
        // an unreachable relay, and one automatic retry is allowed because
        // nothing has been rendered yet.
        return nimError('hosted-unavailable', {
          detail: `HTTP ${status}${detail ? ` — ${detail}` : ''}`,
          retryAfterSec,
          retryable: true
        })
      }
      return nimError('server', { detail: `HTTP ${status}${detail ? ` — ${detail}` : ''}`, retryable: status >= 500 })
  }
}

export function isNetworkError(error: unknown): boolean {
  // Covers both transports: Node/undici (TypeError 'fetch failed',
  // ENOTFOUND/ECONN/EAI_AGAIN) and Electron's net.fetch (Chromium surfaces
  // load failures as plain Errors whose message is the raw net::ERR_* code —
  // e.g. 'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_INTERNET_DISCONNECTED',
  // 'net::ERR_CONNECTION_REFUSED', 'net::ERR_TIMED_OUT').
  return (
    error instanceof TypeError ||
    (error instanceof Error && /fetch|network|net::ERR|ENOTFOUND|ECONN|EAI_AGAIN/i.test(error.message))
  )
}

// ---------------------------------------------------------------------------
// Streaming execution
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init: {
  method: string
  headers: Record<string, string>
  body: string
  signal: AbortSignal
  /** Electron net.fetch: omit so the shared session's cookies never reach the API. */
  credentials?: 'omit' | 'same-origin' | 'include'
}) => Promise<{
  ok: boolean
  status: number
  body?: AsyncIterable<Uint8Array> | { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null
  text?: () => Promise<string>
  /** Optional response headers (real net.fetch always provides them). */
  headers?: { get(name: string): string | null }
}>

export interface StreamCallbacks {
  onDelta: (text: string) => void
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: FetchLike
  /** Hosted mode: 429 means free-quota, 503 means relay capacity. */
  hosted?: boolean
}

export interface StreamOutcome {
  text: string
  /** Real model id reported by the endpoint/relay (when it says one). */
  servedModel?: string
  /** Relay routing hint from `x-scout-provider` ('groq' | 'cf' | ...). */
  servedProvider?: string
}

async function readBodyText(response: NonNullable<Awaited<ReturnType<FetchLike>>>, limit = 4096): Promise<string> {
  if (typeof response.text === 'function') return (await response.text()).slice(0, limit)
  const chunks: string[] = []
  let total = 0
  const body = response.body
  if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    const decoder = new TextDecoder()
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      total += chunk.length
      if (total > limit) break
      chunks.push(decoder.decode(chunk, { stream: true }))
    }
  } else if (body && typeof (body as { getReader(): unknown }).getReader === 'function') {
    const reader = (body as { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } }).getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done || value === undefined) break
      total += value.length
      if (total > limit) break
      chunks.push(decoder.decode(value, { stream: true }))
    }
  }
  return chunks.join('').slice(0, limit)
}

async function collectStreamBody(
  response: NonNullable<Awaited<ReturnType<FetchLike>>>,
  onChunk: (text: string) => void
): Promise<void> {
  const body = response.body
  if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    const decoder = new TextDecoder()
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      onChunk(decoder.decode(chunk, { stream: true }))
    }
    return
  }
  if (body && typeof (body as { getReader(): unknown }).getReader === 'function') {
    const reader = (body as { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } }).getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done || value === undefined) break
      onChunk(decoder.decode(value, { stream: true }))
    }
  }
}

/**
 * Executes a chat request. Streaming responses are forwarded incrementally
 * through `onDelta`. A single conservative retry is attempted for transient
 * failures (network / 5xx / timeout) — only when nothing was streamed yet.
 * Authorization, credit, and rate-limit failures are never retried.
 */
export async function streamNimChat(request: BuiltRequest, callbacks: StreamCallbacks): Promise<StreamOutcome> {
  const { onDelta, signal, timeoutMs = 60_000, fetchImpl = fetch as unknown as FetchLike, hosted = false } = callbacks

  let streamedAnything = false
  let attempt = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++
    let outcome: {
      ok: true
      text: string
      servedModel?: string
      servedProvider?: string
    } | { ok: false; error: ChatErrorMessage; canRetry: boolean }
    try {
      outcome = await attemptOnce(request, { onDelta, signal, timeoutMs, fetchImpl, hosted, onFirstDelta: () => (streamedAnything = true) })
    } catch (error) {
      if (isChatErrorMessage(error)) throw error
      // Defensive: attemptOnce should map everything; keep a safe fallback.
      outcome = {
        ok: false,
        error: nimError('unknown', { detail: error instanceof Error ? error.message : String(error), retryable: false }),
        canRetry: false
      }
    }
    if (outcome.ok) return { text: outcome.text, servedModel: outcome.servedModel, servedProvider: outcome.servedProvider }
    if (outcome.canRetry && !streamedAnything && attempt === 1 && !(signal && signal.aborted)) {
      await delay(600, signal)
      continue
    }
    throw outcome.error
  }
}

async function attemptOnce(
  request: BuiltRequest,
  opts: {
    onDelta: (text: string) => void
    signal?: AbortSignal
    timeoutMs: number
    fetchImpl: FetchLike
    hosted?: boolean
    onFirstDelta: () => void
  }
): Promise<
  | { ok: true; text: string; servedModel?: string; servedProvider?: string }
  | { ok: false; error: ChatErrorMessage; canRetry: boolean }
> {
  const { onDelta, signal, timeoutMs, fetchImpl, hosted = false, onFirstDelta } = opts
  const controller = new AbortController()
  const onUserCancel = () => controller.abort()
  if (signal) {
    if (signal.aborted) throw nimError('cancelled')
    signal.addEventListener('abort', onUserCancel, { once: true })
  }

  // Timeout semantics: `timeoutMs` is the maximum wait WITHOUT PROGRESS.
  // It runs from the request until the first data arrives, then restarts on
  // every received chunk. A response that keeps producing data is NEVER cut
  // off mid-answer, no matter how long the full answer takes — only a
  // genuinely stalled connection (no bytes for the whole window) is aborted.
  let stallTimer: NodeJS.Timeout | null = null
  const disarmStallTimer = (): void => {
    if (stallTimer) {
      clearTimeout(stallTimer)
      stallTimer = null
    }
  }
  const armStallTimer = (): void => {
    disarmStallTimer()
    stallTimer = setTimeout(() => controller.abort(), timeoutMs)
  }
  armStallTimer()

  let firstTokenSeen = false
  try {
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
      // Bearer-token API: no cookies in either direction. Electron's net.fetch
      // defaults to the session's credential mode, which would attach the
      // shared session jar's cookies for the API host and persist Set-Cookie.
      credentials: 'omit'
    })
    armStallTimer() // connected: restart the window for the first data
    // Hosted relay reports which provider pool served this request.
    const servedProvider = response.headers?.get?.('x-scout-provider') ?? undefined

    if (!response.ok) {
      const bodyText = await readBodyText(response)
      const mapped = mapHttpStatus(response.status, bodyText, { hosted })
      return { ok: false, error: mapped, canRetry: mapped.retryable && !firstTokenSeen }
    }

    const wantsStream = request.headers.Accept === 'text/event-stream'
    if (!wantsStream) {
      const text = await readBodyText(response, 512 * 1024)
      const parsed = JSON.parse(text) as {
        model?: unknown
        choices?: Array<{ message?: { content?: unknown } }>
      }
      const content = parsed.choices?.[0]?.message?.content
      if (typeof content !== 'string' || content.trim() === '') {
        return { ok: false, error: nimError('empty-response', { retryable: true }), canRetry: !firstTokenSeen }
      }
      firstTokenSeen = true
      onFirstDelta()
      onDelta(content)
      return {
        ok: true,
        text: content,
        servedModel: typeof parsed.model === 'string' ? parsed.model : undefined,
        servedProvider
      }
    }

    const parser = new SseParser()
    let full = ''
    let servedModel: string | undefined
    await collectStreamBody(response, (chunk) => {
      armStallTimer() // bytes arrived: the connection is alive, restart the window
      for (const payload of parser.feed(chunk)) {
        if (!servedModel) {
          const m = (payload as { model?: unknown }).model
          if (typeof m === 'string' && m !== '') servedModel = m
        }
        const delta = SseParser.deltaText(payload)
        if (delta) {
          if (!firstTokenSeen) {
            firstTokenSeen = true
            onFirstDelta()
          }
          full += delta
          onDelta(delta)
        }
      }
    })
    if (full.trim() === '') {
      return { ok: false, error: nimError('empty-response', { retryable: true }), canRetry: !firstTokenSeen }
    }
    return { ok: true, text: full, servedModel, servedProvider }
  } catch (error) {
    if (signal && signal.aborted) throw nimError('cancelled')
    if (error instanceof Error && error.name === 'AbortError') {
      if (firstTokenSeen) {
        // Rendered content was already on screen, then the connection went
        // silent for the whole window — a stalled stream, not a slow start.
        // Never auto-retried: restarting would duplicate a partial answer.
        return {
          ok: false,
          error: nimError('stalled', { detail: `No data for ${Math.round(timeoutMs / 1000)}s.`, retryable: false }),
          canRetry: false
        }
      }
      return { ok: false, error: nimError('timeout', { detail: `No response within ${Math.round(timeoutMs / 1000)}s.`, retryable: true }), canRetry: true }
    }
    if (isNetworkError(error)) {
      return { ok: false, error: nimError('network', { retryable: true }), canRetry: true }
    }
    return {
      ok: false,
      error: nimError('unknown', { detail: error instanceof Error ? error.message : String(error), retryable: false }),
      canRetry: false
    }
  } finally {
    disarmStallTimer()
    if (signal) signal.removeEventListener('abort', onUserCancel)
  }
}

function isChatErrorMessage(value: unknown): value is ChatErrorMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    typeof (value as { message: unknown }).message === 'string'
  )
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(nimError('cancelled'))
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t)
        reject(nimError('cancelled'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
