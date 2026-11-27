import { describe, expect, it } from 'vitest'
import {
  buildNimRequest,
  mapHttpStatus,
  nimError,
  streamNimChat,
  isNetworkError,
  type FetchLike
} from '../src/main/ai/nim-client'

const TEST_KEY = 'nvapi-test-key-123'

function sseStream(chunks: string[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield new TextEncoder().encode(c)
    }
  }
}

function okSse(deltas: string[], split = false): AsyncIterable<Uint8Array> {
  const events = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`)
  events.push('data: [DONE]\n\n')
  const text = events.join('')
  if (!split) return sseStream([text])
  const mid = Math.floor(text.length / 2)
  return sseStream([text.slice(0, mid), text.slice(mid)])
}

describe('buildNimRequest', () => {
  it('builds a vision payload with the documented schema', () => {
    const req = buildNimRequest({
      baseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
      apiKey: TEST_KEY,
      model: 'meta/llama-3.2-90b-vision-instruct',
      userText: 'What is this?',
      imageDataUrl: 'data:image/png;base64,AAA'
    })
    expect(req.url).toBe('https://integrate.api.nvidia.com/v1/chat/completions')
    expect(req.headers.Authorization).toBe(`Bearer ${TEST_KEY}`)
    expect(req.headers.Accept).toBe('text/event-stream')

    const body = JSON.parse(req.body)
    expect(body.model).toBe('meta/llama-3.2-90b-vision-instruct')
    expect(body.stream).toBe(true)
    expect(body.messages[0].role).toBe('system')
    expect(typeof body.messages[0].content).toBe('string')
    const last = body.messages[body.messages.length - 1]
    expect(last.role).toBe('user')
    expect(Array.isArray(last.content)).toBe(true)
    expect(last.content[0]).toEqual({ type: 'text', text: 'What is this?' })
    expect(last.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAA' }
    })
  })

  it('sends text-only prompts as plain string content', () => {
    const req = buildNimRequest({
      baseUrl: 'https://x/v1/chat/completions',
      apiKey: TEST_KEY,
      model: 'm',
      userText: 'hi'
    })
    const body = JSON.parse(req.body)
    expect(body.messages[body.messages.length - 1].content).toBe('hi')
  })

  it('includes prior history between system and the new user turn', () => {
    const req = buildNimRequest({
      baseUrl: 'https://x',
      apiKey: TEST_KEY,
      model: 'm',
      userText: 'follow up',
      history: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' }
      ]
    })
    const body = JSON.parse(req.body)
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
  })

  it('never places the API key in the request body', () => {
    const req = buildNimRequest({ baseUrl: 'https://x', apiKey: TEST_KEY, model: 'm', userText: 'hi' })
    expect(req.body.includes(TEST_KEY)).toBe(false)
  })
})

describe('mapHttpStatus', () => {
  it('maps authorization failures without retry', () => {
    const e = mapHttpStatus(401, '')
    expect(e.code).toBe('invalid-key')
    expect(e.retryable).toBe(false)
    expect(e.message).not.toContain(TEST_KEY)
  })

  it('maps quota, rate limit, and server errors', () => {
    expect(mapHttpStatus(402, '').code).toBe('payment-required')
    expect(mapHttpStatus(429, '').code).toBe('rate-limit')
    const server = mapHttpStatus(503, 'try later')
    expect(server.code).toBe('server')
    expect(server.retryable).toBe(true)
  })

  it('maps a hosted 403 token-revoked to invalid-key (drives re-register)', () => {
    const e = mapHttpStatus(403, '{"error":"token-revoked"}', { hosted: true })
    expect(e.code).toBe('invalid-key')
    expect(e.retryable).toBe(false)
  })

  it('maps other 403s to a generic server error', () => {
    expect(mapHttpStatus(403, '{"error":"token-revoked"}').code).toBe('server')
    expect(mapHttpStatus(403, 'forbidden', { hosted: true }).code).toBe('server')
  })

  it('maps image-related 400/422 to unsupported-image', () => {
    const e = mapHttpStatus(400, '{"detail":"Image is not supported for this model"}')
    expect(e.code).toBe('unsupported-image')
    const e2 = mapHttpStatus(422, '{"title":"Unprocessable Entity"}')
    expect(e2.code).toBe('bad-request')
  })

  it('sanitizes long error bodies into detail', () => {
    const long = 'x'.repeat(5000)
    const e = mapHttpStatus(500, long)
    expect((e.detail ?? '').length).toBeLessThanOrEqual(310)
  })
})

describe('isNetworkError', () => {
  it('recognizes fetch TypeErrors and common socket codes', () => {
    expect(isNetworkError(new TypeError('fetch failed'))).toBe(true)
    expect(isNetworkError(new Error('ENOTFOUND api.nvidia.com'))).toBe(true)
    expect(isNetworkError(new Error('plain'))).toBe(false)
  })
})

describe('streamNimChat', () => {
  function makeRequest(stream = true) {
    return buildNimRequest({
      baseUrl: 'https://x/v1/chat/completions',
      apiKey: TEST_KEY,
      model: 'm',
      userText: 'hi',
      stream
    })
  }

  it('streams deltas and completes with the full text (split chunks)', async () => {
    const deltas: string[] = []
    const out = await streamNimChat(makeRequest(), {
      onDelta: (t) => deltas.push(t),
      fetchImpl: (async () => ({ ok: true, status: 200, body: okSse(['Hello', ' world'], true) })) as FetchLike
    })
    expect(deltas).toEqual(['Hello', ' world'])
    expect(out.text).toBe('Hello world')
  })

  it('retries once on transient 5xx and then succeeds', async () => {
    let attempts = 0
    const out = await streamNimChat(makeRequest(), {
      onDelta: () => {},
      fetchImpl: (async () => {
        attempts++
        if (attempts === 1) {
          return { ok: false, status: 503, body: sseStream(['{"title":"Service Unavailable"}']) }
        }
        return { ok: true, status: 200, body: okSse(['OK']) }
      }) as FetchLike
    })
    expect(attempts).toBe(2)
    expect(out.text).toBe('OK')
  })

  it('does NOT retry 401 authorization failures', async () => {
    let attempts = 0
    await expect(
      streamNimChat(makeRequest(), {
        onDelta: () => {},
        fetchImpl: (async () => {
          attempts++
          return { ok: false, status: 401, body: sseStream(['{"detail":"Unauthorized"}']) }
        }) as FetchLike
      })
    ).rejects.toMatchObject({ code: 'invalid-key' })
    expect(attempts).toBe(1)
  })

  it('does not retry once tokens have started streaming', async () => {
    let attempts = 0
    const streamThatDiesMidResponse = (): AsyncIterable<Uint8Array> => ({
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`
        )
        throw new TypeError('fetch failed')
      }
    })
    await expect(
      streamNimChat(makeRequest(), {
        onDelta: () => {},
        fetchImpl: (async () => {
          attempts++
          return { ok: true, status: 200, body: streamThatDiesMidResponse() }
        }) as FetchLike
      })
    ).rejects.toMatchObject({ code: 'network' })
    expect(attempts).toBe(1)
  })

  it('reports cancellation when the user aborts', async () => {
    const controller = new AbortController()
    const promise = streamNimChat(makeRequest(), {
      onDelta: () => {},
      signal: controller.signal,
      fetchImpl: (async (_url, init) => {
        return {
          ok: true,
          status: 200,
          body: {
            async *[Symbol.asyncIterator]() {
              yield new TextEncoder().encode('data: ')
              controller.abort()
              throw new DOMException('Aborted', 'AbortError')
            }
          }
        }
      }) as FetchLike
    })
    void controller
    await expect(promise).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('maps empty streams to empty-response', async () => {
    await expect(
      streamNimChat(makeRequest(), {
        onDelta: () => {},
        fetchImpl: (async () => ({ ok: true, status: 200, body: sseStream(['data: [DONE]\n\n']) })) as FetchLike
      })
    ).rejects.toMatchObject({ code: 'empty-response' })
  })

  it('never times out a stream that keeps producing data (long answers survive)', async () => {
    // 8 chunks, 60ms apart → ~480ms total, with a 120ms timeout. Under the
    // old total-duration semantics this aborted at 120ms; with progress-based
    // semantics it must complete with the full text.
    const chunks = Array.from({ length: 8 }, (_, i) => `data: {"choices":[{"delta":{"content":"part${i} "}}]}\n\n`)
    let index = 0
    const deltas: string[] = []
    const out = await streamNimChat(makeRequest(), {
      onDelta: (d) => deltas.push(d),
      timeoutMs: 120,
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        body: {
          async *[Symbol.asyncIterator]() {
            while (index < chunks.length) {
              yield new TextEncoder().encode(chunks[index])
              index++
              await new Promise((r) => setTimeout(r, 60))
            }
            yield new TextEncoder().encode('data: [DONE]\n\n')
          }
        }
      })) as FetchLike
    })
    expect(out.text).toBe('part0 part1 part2 part3 part4 part5 part6 part7 ')
    expect(deltas).toHaveLength(8)
  })

  it('maps a mid-stream stall to stalled and does not retry once content was shown', async () => {
    let attempts = 0
    await expect(
      streamNimChat(makeRequest(), {
        onDelta: () => {},
        timeoutMs: 120,
        fetchImpl: (async (_url, init) => {
          attempts++
          const signal = init.signal
          return {
            ok: true,
            status: 200,
            body: {
              async *[Symbol.asyncIterator]() {
                yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"visible part"}}]}\n\n')
                // A real aborted fetch rejects the pending body read.
                await new Promise((resolve, reject) => {
                  const t = setTimeout(resolve, 400)
                  signal.addEventListener(
                    'abort',
                    () => {
                      clearTimeout(t)
                      reject(new DOMException('Aborted', 'AbortError'))
                    },
                    { once: true }
                  )
                })
                yield new TextEncoder().encode('data: [DONE]\n\n') // never reached
              }
            }
          }
        }) as FetchLike
      })
    ).rejects.toMatchObject({ code: 'stalled' })
    expect(attempts).toBe(1) // content was already shown — never restarted
  })

  it('classifies a net.fetch-style reader abort after content as stalled', async () => {
    // Electron's net.fetch surfaces bodies as web streams; a mid-stream abort
    // surfaces as a rejected reader.read() with Node's AbortError shape
    // (premature-close conversion) — pin that the stall mapping holds there.
    let readCount = 0
    const deltas: string[] = []
    await expect(
      streamNimChat(makeRequest(), {
        onDelta: (d) => deltas.push(d),
        fetchImpl: (async () => ({
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
                readCount++
                if (readCount === 1) {
                  return {
                    done: false,
                    value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
                  }
                }
                const err = new Error('The operation was aborted')
                err.name = 'AbortError'
                throw err
              }
            })
          }
        })) as FetchLike
      })
    ).rejects.toMatchObject({ code: 'stalled' })
    expect(deltas).toEqual(['partial'])
  })

  it('maps net.fetch Chromium load failures to network (retryable)', async () => {
    // net.fetch rejects offline/DNS/TLS failures as plain Errors carrying the
    // raw Chromium code — these must map to 'network' and retry once.
    let attempts = 0
    await expect(
      streamNimChat(makeRequest(), {
        onDelta: () => {},
        fetchImpl: (async () => {
          attempts++
          throw new Error('net::ERR_NAME_NOT_RESOLVED')
        }) as FetchLike
      })
    ).rejects.toMatchObject({ code: 'network' })
    expect(attempts).toBe(2) // transient-class failure → single automatic retry
  })

  it('treats a bytes-but-no-content stall as a retryable timeout (nothing was rendered)', async () => {
    // Keep-alive/comment bytes only — no rendered delta — then a stall past
    // the window. Nothing was shown, so this maps to 'timeout' and the single
    // automatic retry succeeds.
    let attempts = 0
    const out = await streamNimChat(makeRequest(), {
      onDelta: () => {},
      timeoutMs: 120,
      fetchImpl: (async (_url, init) => {
        attempts++
        const signal = init.signal
        if (attempts === 1) {
          return {
            ok: true,
            status: 200,
            body: {
              async *[Symbol.asyncIterator]() {
                yield new TextEncoder().encode(': keep-alive\n\n') // comment — no delta
                await new Promise((resolve, reject) => {
                  const t = setTimeout(resolve, 400)
                  signal.addEventListener(
                    'abort',
                    () => {
                      clearTimeout(t)
                      reject(new DOMException('Aborted', 'AbortError'))
                    },
                    { once: true }
                  )
                })
              }
            }
          }
        }
        return {
          ok: true,
          status: 200,
          body: sseStream(['data: {"choices":[{"delta":{"content":"recovered"}}]}\n\n', 'data: [DONE]\n\n'])
        }
      }) as FetchLike
    })
    expect(attempts).toBe(2)
    expect(out.text).toBe('recovered')
  })

  it('parses non-streaming JSON responses (used by Test connection)', async () => {
    const out = await streamNimChat(makeRequest(false), {
      onDelta: () => {},
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'OK' } }] })
      })) as FetchLike
    })
    expect(out.text).toBe('OK')
  })

  it('uses the injected fetch — no network in unit tests', async () => {
    let called = false
    await streamNimChat(makeRequest(), {
      onDelta: () => {},
      fetchImpl: (async () => {
        called = true
        return { ok: true, status: 200, body: okSse(['x']) }
      }) as FetchLike
    })
    expect(called).toBe(true)
  })

  it('nimError produces user-facing copy without technical noise', () => {
    const e = nimError('rate-limit')
    expect(e.message).toBe('NVIDIA is receiving too many requests. Try again shortly.')
    expect(e.retryable).toBe(false)
  })
})

describe('hosted mode', () => {
  it('omits Authorization and forwards the device token header', () => {
    const req = buildNimRequest({
      baseUrl: 'https://relay.example/v1/chat/completions',
      headers: { 'x-device-token': 'tok_123' },
      model: 'scout-vision-1',
      userText: 'hi'
    })
    expect(req.headers.Authorization).toBeUndefined()
    expect(req.headers['x-device-token']).toBe('tok_123')
    expect(req.body).not.toContain('nvapi-')
  })

  it('maps relay 429 to quota-exceeded with the reset hint', () => {
    const e = mapHttpStatus(
      429,
      JSON.stringify({ error: { code: 'quota-exceeded', message: 'limit', retryAfterSec: 1200 } }),
      { hosted: true }
    )
    expect(e.code).toBe('quota-exceeded')
    expect(e.retryAfterSec).toBe(1200)
    expect(e.message).toContain('free limit')
  })

  it('maps relay 503 to hosted-unavailable', () => {
    const e = mapHttpStatus(503, '{"error":{"code":"capacity-exhausted"}}', { hosted: true })
    expect(e.code).toBe('hosted-unavailable')
    expect(e.retryable).toBe(false)
  })

  it('maps 413 to unsupported-image', () => {
    expect(mapHttpStatus(413, '', { hosted: true }).code).toBe('unsupported-image')
  })

  it('keeps BYOK 429 semantics when not hosted', () => {
    expect(mapHttpStatus(429, '').code).toBe('rate-limit')
  })

  it('maps hosted 5xx to hosted-unavailable with one retry allowed', () => {
    const e = mapHttpStatus(502, '{"error":{"code":"upstream-failed"}}', { hosted: true })
    expect(e.code).toBe('hosted-unavailable')
    expect(e.retryable).toBe(true)
  })
})

describe('served model capture', () => {
  function makeStreamRequest(): ReturnType<typeof buildNimRequest> {
    return buildNimRequest({
      baseUrl: 'https://relay.test/v1/chat/completions',
      headers: { 'x-device-token': 'tok' },
      model: 'scout-vision-1',
      userText: 'hi',
      stream: true
    })
  }

  it('reports the real model id and relay provider from the stream', async () => {
    const chunks = [
      `data: ${JSON.stringify({ model: 'openai/gpt-oss-120b', choices: [{ delta: { content: 'Hi' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: ' there' } }] })}\n\n`,
      'data: [DONE]\n\n'
    ]
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'x-scout-provider' ? 'groq' : null) },
      body: sseStream(chunks)
    })) as unknown as FetchLike

    const out = await streamNimChat(makeStreamRequest(), { timeoutMs: 5000, fetchImpl, onDelta: () => {} })

    expect(out.text).toBe('Hi there')
    expect(out.servedModel).toBe('openai/gpt-oss-120b')
    expect(out.servedProvider).toBe('groq')
  })

  it('leaves served fields undefined when the endpoint reports neither', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      body: okSse(['plain'], false)
    })) as unknown as FetchLike

    const out = await streamNimChat(makeStreamRequest(), { timeoutMs: 5000, fetchImpl, onDelta: () => {} })

    expect(out.servedModel).toBeUndefined()
    expect(out.servedProvider).toBeUndefined()
  })
})
