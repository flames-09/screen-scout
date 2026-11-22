/**
 * Upstream providers.
 *
 * Groq is OpenAI-compatible → pure streaming passthrough.
 * Workers AI speaks a different SSE dialect → translate into OpenAI chunks.
 *
 * Failover only happens BEFORE the first byte reaches the client: once a
 * provider has started streaming, switching would duplicate text in the
 * user's answer. `tryGroq` therefore resolves only when headers + body are
 * available (or the connection failed), and the router commits at that point.
 */

import type { Env } from './types'
import type { ProviderId } from './quota'
import { translateWorkersAiStream } from './sse'

export interface ChatRequestBody {
  model?: string
  messages?: Array<{ role?: string; content?: unknown }>
  stream?: boolean
  max_tokens?: number
  temperature?: number
  [key: string]: unknown
}

export interface ParsedChatBody {
  body: ChatRequestBody
}

export function parseChatBody(text: string, publicModelId: string): { ok: true; body: ChatRequestBody } | { ok: false; message: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, message: 'Request body is not valid JSON.' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, message: 'Request body must be an object.' }
  const body = parsed as ChatRequestBody
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, message: 'Request must include a non-empty messages array.' }
  }
  if (body.messages.length > 40) return { ok: false, message: 'Too many messages in context.' }
  if (typeof body.model === 'string' && body.model !== publicModelId) {
    return { ok: false, message: `Model must be "${publicModelId}".` }
  }
  return { ok: true, body }
}

interface TextPart {
  type?: string
  text?: string
  image_url?: { url?: string }
}

export interface CfInput {
  messages: Array<{ role: string; content: string }>
  image: Uint8Array[] | undefined
  maxTokens: number
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'object' && part !== null && typeof (part as TextPart).text === 'string' ? (part as TextPart).text : ''))
      .filter((text) => text !== '')
      .join('\n')
  }
  return ''
}

function lastImage(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const url = (part as TextPart).image_url?.url
    if (typeof url === 'string' && /^data:image\/(png|jpe?g);base64,/.test(url)) return url
  }
  return null
}

/**
 * True when any message carries an image part. The router uses this to decide
 * whether a text-capable upstream may serve the request at all — a text-only
 * provider must never receive (and 400 on) image turns.
 */
export function requestHasImage(body: ChatRequestBody): boolean {
  return (body.messages ?? []).some((m) => lastImage(m.content) !== null)
}

export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  try {
    const binary = atob(dataUrl.slice(comma + 1))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/**
 * Flattens the app's OpenAI request into the shape Workers AI's vision model
 * expects: a messages array plus one image (its own param), no data URLs.
 */
export function buildCfInput(body: ChatRequestBody): CfInput | null {
  const messages = body.messages ?? []
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => messageText(m.content))
    .filter(Boolean)
    .join('\n')

  const turns: Array<{ role: string; content: string }> = []
  let image: Uint8Array[] | undefined

  for (const message of messages) {
    if (!message || typeof message.role !== 'string') continue
    if (message.role === 'system') continue
    const dataUrl = lastImage(message.content)
    if (dataUrl) {
      if (!image) {
        const bytes = dataUrlToBytes(dataUrl)
        if (bytes) image = [bytes]
      }
      const text = messageText(message.content)
      // The current turn carries the image; keep the text as the prompt.
      turns.push({ role: 'user', content: text || 'Describe what is visible in this screenshot.' })
      continue
    }
    const text = messageText(message.content)
    if (!text) continue
    turns.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: text })
  }

  if (turns.length === 0) return null
  const prepared: Array<{ role: string; content: string }> = []
  if (systemText) prepared.push({ role: 'system', content: systemText.slice(0, 4000) })
  // Keep the last few turns to stay inside the small model's context window.
  prepared.push(...turns.slice(-8))
  const maxTokens = Math.min(1024, Math.max(64, Math.round(body.max_tokens ?? 1024)))
  return { messages: prepared, image, maxTokens }
}

/**
 * Decides which provider may serve this request. Image turns must go to a
 * multimodal provider — the Groq account's free tier has no vision model, so
 * a screenshot question would 400 there and burn budget. Text-only turns may
 * use Groq for extra free capacity. When an NVIDIA key is configured, image
 * turns are served by NVIDIA's vision model first (it has no daily hard stop
 * like Workers AI neurons) with Workers AI kept as the fallback.
 */
export function routeProviders(
  env: Pick<Env, 'GROQ_API_KEY' | 'NVIDIA_API_KEY'>,
  wantsImage: boolean
): 'groq-first' | 'nvidia-first' | 'cf-only' {
  if (wantsImage) return env.NVIDIA_API_KEY ? 'nvidia-first' : 'cf-only'
  return env.GROQ_API_KEY ? 'groq-first' : 'cf-only'
}

export type UpstreamAttempt =
  | { ok: true; provider: ProviderId; response: Response }
  | { ok: false; provider: ProviderId; status: number; detail: string }

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions'
const DEFAULT_NVIDIA_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b'
const CONNECT_TIMEOUT_MS = 9000

export async function tryGroq(env: Env, body: ChatRequestBody, signal?: AbortSignal): Promise<UpstreamAttempt> {
  // API keys are whitespace-free by construction; strip any whitespace so a
  // pasted secret with a stray newline (or a wrapped copy) still works.
  const key = (env.GROQ_API_KEY ?? '').replace(/\s+/g, '')
  if (!key) return { ok: false, provider: 'groq', status: 0, detail: 'GROQ_API_KEY is not configured.' }

  // The relay is public, so never forward arbitrary parameters (cost/abuse:
  // `n`, `stop`, `tools`, oversized max_tokens…). Rebuild the payload from a
  // small allow-list that matches what the app actually needs.
  const maxTokens = Math.min(2048, Math.max(64, Math.round(Number(body.max_tokens) || 1024)))
  const temperature = Math.min(1, Math.max(0, Number(body.temperature ?? 0.2) || 0))
  const payload = {
    model: env.GROQ_MODEL,
    messages: body.messages,
    temperature,
    max_tokens: maxTokens,
    stream: true
  }

  const controller = new AbortController()
  const onClientAbort = (): void => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onClientAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)

  try {
    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    clearTimeout(timer)
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300)
      return { ok: false, provider: 'groq', status: response.status, detail: text }
    }
    if (!response.body) return { ok: false, provider: 'groq', status: 502, detail: 'Groq returned an empty body.' }
    return { ok: true, provider: 'groq', response }
  } catch (error) {
    clearTimeout(timer)
    return {
      ok: false,
      provider: 'groq',
      status: 0,
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onClientAbort)
  }
}

/**
 * NVIDIA's build.nvidia.com catalog is OpenAI-compatible and accepts the same
 * message shape the app already sends (text + image_url data-URL parts), so
 * this is a near-clone of the Groq passthrough with a different endpoint and
 * model. Vision model id defaults to the one the BYOK path has always used.
 */
export async function tryNvidia(env: Env, body: ChatRequestBody, signal?: AbortSignal): Promise<UpstreamAttempt> {
  // API keys are whitespace-free by construction; strip any whitespace so a
  // pasted secret with a stray newline (or a wrapped copy) still works.
  const key = (env.NVIDIA_API_KEY ?? '').replace(/\s+/g, '')
  if (!key) return { ok: false, provider: 'nvidia', status: 0, detail: 'NVIDIA_API_KEY is not configured.' }

  // Same allow-list discipline as Groq: the relay is public, so no arbitrary
  // client parameters ever reach the upstream endpoint.
  const maxTokens = Math.min(2048, Math.max(64, Math.round(Number(body.max_tokens) || 1024)))
  const temperature = Math.min(1, Math.max(0, Number(body.temperature ?? 0.2) || 0))
  const payload = {
    model: env.NVIDIA_MODEL || DEFAULT_NVIDIA_MODEL,
    messages: body.messages,
    temperature,
    max_tokens: maxTokens,
    stream: true
  }

  const controller = new AbortController()
  const onClientAbort = (): void => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onClientAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)

  try {
    const response = await fetch(NVIDIA_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    clearTimeout(timer)
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300)
      return { ok: false, provider: 'nvidia', status: response.status, detail: text }
    }
    if (!response.body) return { ok: false, provider: 'nvidia', status: 502, detail: 'NVIDIA returned an empty body.' }
    return { ok: true, provider: 'nvidia', response }
  } catch (error) {
    clearTimeout(timer)
    return {
      ok: false,
      provider: 'nvidia',
      status: 0,
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onClientAbort)
  }
}

export async function tryWorkersAi(env: Env, body: ChatRequestBody): Promise<UpstreamAttempt> {
  const input = buildCfInput(body)
  if (!input) return { ok: false, provider: 'cf', status: 400, detail: 'No usable user message.' }

  try {
    const run = env.AI.run(env.CF_MODEL, {
      messages: input.messages,
      ...(input.image ? { image: input.image } : {}),
      max_tokens: input.maxTokens,
      stream: true
    })
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Workers AI connect timeout')), CONNECT_TIMEOUT_MS)
    )
    const raw = (await Promise.race([run, timeout])) as ReadableStream<Uint8Array> | { response?: string } | null

    if (!raw) return { ok: false, provider: 'cf', status: 502, detail: 'Workers AI returned no stream.' }

    // Defensive: some deployments may return a single JSON object.
    if (typeof (raw as { getReader?: unknown }).getReader !== 'function') {
      const text = typeof (raw as { response?: unknown }).response === 'string' ? String((raw as { response: string }).response) : ''
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: text })}\n\n`))
          controller.close()
        }
      })
      return {
        ok: true,
        provider: 'cf',
        response: new Response(translateWorkersAiStream(stream, env.PUBLIC_MODEL_ID), {
          headers: { 'Content-Type': 'text/event-stream' }
        })
      }
    }

    return {
      ok: true,
      provider: 'cf',
      response: new Response(translateWorkersAiStream(raw as ReadableStream<Uint8Array>, env.PUBLIC_MODEL_ID), {
        headers: { 'Content-Type': 'text/event-stream' }
      })
    }
  } catch (error) {
    return {
      ok: false,
      provider: 'cf',
      status: 502,
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
  }
}
