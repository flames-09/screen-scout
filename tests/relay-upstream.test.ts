import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestHasImage, routeProviders, tryGroq, tryNvidia } from '../relay/src/upstream'
import type { Env } from '../relay/src/types'

const env = {
  GROQ_API_KEY: 'test-groq-key',
  GROQ_MODEL: 'openai/gpt-oss-120b',
  PUBLIC_MODEL_ID: 'scout-vision-1'
} as unknown as Env

const messages = [{ role: 'user', content: 'What is on screen?' }]

describe('requestHasImage', () => {
  it('detects image parts in any turn', () => {
    expect(requestHasImage({ messages })).toBe(false)
    expect(
      requestHasImage({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] }
        ]
      })
    ).toBe(true)
  })

  it('tolerates junk without throwing', () => {
    expect(requestHasImage({})).toBe(false)
    expect(requestHasImage({ messages: [{ role: 'user' }, { role: 42 } as never] })).toBe(false)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('routeProviders', () => {
  it('sends image questions to NVIDIA first when a key is configured', () => {
    expect(routeProviders({ GROQ_API_KEY: 'k', NVIDIA_API_KEY: 'n' }, true)).toBe('nvidia-first')
  })

  it('sends image questions to the multimodal fallback without an NVIDIA key', () => {
    expect(routeProviders({ GROQ_API_KEY: 'k' }, true)).toBe('cf-only')
  })

  it('tries the text provider for text-only questions when configured', () => {
    expect(routeProviders({ GROQ_API_KEY: 'k', NVIDIA_API_KEY: 'n' }, false)).toBe('groq-first')
  })

  it('never routes anywhere without any key', () => {
    expect(routeProviders({ GROQ_API_KEY: '' }, false)).toBe('cf-only')
    expect(routeProviders({} as Pick<Env, 'GROQ_API_KEY' | 'NVIDIA_API_KEY'>, true)).toBe('cf-only')
    expect(routeProviders({ GROQ_API_KEY: '', NVIDIA_API_KEY: '' }, true)).toBe('cf-only')
  })
})

describe('tryGroq request shaping', () => {
  it('forwards only an allow-listed payload (no cost/abuse knobs)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('data: {"choices":[]}\n\n', { status: 200 }))

    const attempt = await tryGroq(env, {
      messages,
      max_tokens: 999_999,
      temperature: 5,
      n: 9,
      stop: ['\n\n'],
      tools: [{ type: 'function' }],
      response_format: { type: 'json_object' }
    })

    expect(attempt.ok).toBe(true)
    const [, init] = fetchSpy.mock.calls[0]
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(sent.model).toBe(env.GROQ_MODEL)
    expect(sent.messages).toEqual(messages)
    expect(sent.stream).toBe(true)
    expect(sent.max_tokens).toBe(2048)
    expect(sent.temperature).toBe(1)
    expect(sent.n).toBeUndefined()
    expect(sent.stop).toBeUndefined()
    expect(sent.tools).toBeUndefined()
    expect(sent.response_format).toBeUndefined()
  })

  it('clamps tiny max_tokens and negative temperature', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('data: x\n\n', { status: 200 }))

    await tryGroq(env, { messages, max_tokens: 1, temperature: -4 })
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as Record<string, unknown>
    expect(sent.max_tokens).toBe(64)
    expect(sent.temperature).toBe(0)
  })

  it('reports a network failure as status 0 so the budget can be refunded', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    const attempt = await tryGroq(env, { messages })
    expect(attempt.ok).toBe(false)
    if (attempt.ok) return
    expect(attempt.status).toBe(0)
  })

  it('maps a client abort to status 0 and passes an abort signal upstream', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'))
    const attempt = await tryGroq(env, { messages })
    expect(attempt.ok).toBe(false)
    if (attempt.ok) return
    expect(attempt.status).toBe(0)
    const [, init] = fetchSpy.mock.calls[0]
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('reports an HTTP failure with its status so the budget stays counted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"rate limited"}', { status: 429 }))
    const attempt = await tryGroq(env, { messages })
    expect(attempt.ok).toBe(false)
    if (attempt.ok) return
    expect(attempt.status).toBe(429)
  })
})

describe('tryNvidia request shaping', () => {
  const nvidiaEnv = {
    GROQ_API_KEY: 'test-groq-key',
    GROQ_MODEL: 'openai/gpt-oss-120b',
    NVIDIA_API_KEY: 'test-nvidia-key',
    NVIDIA_MODEL: 'meta/llama-3.2-90b-vision-instruct',
    PUBLIC_MODEL_ID: 'scout-vision-1'
  } as unknown as Env

  it('forwards only an allow-listed payload (no cost/abuse knobs)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('data: {"choices":[]}\n\n', { status: 200 }))

    const attempt = await tryNvidia(nvidiaEnv, {
      messages,
      max_tokens: 999_999,
      temperature: 5,
      n: 9,
      stop: ['\n\n'],
      tools: [{ type: 'function' }],
      response_format: { type: 'json_object' }
    })

    expect(attempt.ok).toBe(true)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe('https://integrate.api.nvidia.com/v1/chat/completions')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-nvidia-key')
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(sent.model).toBe('meta/llama-3.2-90b-vision-instruct')
    expect(sent.messages).toEqual(messages)
    expect(sent.stream).toBe(true)
    expect(sent.max_tokens).toBe(2048)
    expect(sent.temperature).toBe(1)
    expect(sent.n).toBeUndefined()
    expect(sent.stop).toBeUndefined()
    expect(sent.tools).toBeUndefined()
    expect(sent.response_format).toBeUndefined()
  })

  it('falls back to the default vision model when NVIDIA_MODEL is unset', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('data: {"choices":[]}\n\n', { status: 200 }))

    await tryNvidia({ ...nvidiaEnv, NVIDIA_MODEL: undefined } as unknown as Env, { messages })
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as Record<string, unknown>
    expect(sent.model).toBe('nvidia/nemotron-3.5-super-vl-120b-a12b')
  })

  it('clamps tiny max_tokens and negative temperature', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('data: x\n\n', { status: 200 }))

    await tryNvidia(nvidiaEnv, { messages, max_tokens: 1, temperature: -4 })
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as Record<string, unknown>
    expect(sent.max_tokens).toBe(64)
    expect(sent.temperature).toBe(0)
  })

  it('bails out without a key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const attempt = await tryNvidia({ ...nvidiaEnv, NVIDIA_API_KEY: '' } as unknown as Env, { messages })
    expect(attempt.ok).toBe(false)
    if (attempt.ok) return
    expect(attempt.provider).toBe('nvidia')
    expect(attempt.status).toBe(0)
    expect(attempt.detail).toBe('NVIDIA_API_KEY is not configured.')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reports a network failure as status 0 so the budget can be refunded', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    const attempt = await tryNvidia(nvidiaEnv, { messages })
    expect(attempt.ok).toBe(false)
    if (attempt.ok) return
    expect(attempt.status).toBe(0)
    expect(attempt.provider).toBe('nvidia')
  })

  it('maps a client abort to status 0 and passes an abort signal upstream', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'))
    const attempt = await tryNvidia(nvidiaEnv, { messages })
    expect(attempt.ok).toBe(false)
    if (attempt.ok) return
    expect(attempt.status).toBe(0)
    const [, init] = fetchSpy.mock.calls[0]
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('reports an HTTP failure with its status so the budget stays counted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"rate limited"}', { status: 429 }))
    const attempt = await tryNvidia(nvidiaEnv, { messages })
    expect(attempt.ok).toBe(false)
    if (attempt.ok) return
    expect(attempt.status).toBe(429)
  })
})
