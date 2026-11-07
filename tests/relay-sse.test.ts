import { describe, expect, it } from 'vitest'
import {
  drainSseLines,
  openAiChunk,
  openAiDone,
  parseWorkersAiLine,
  sanitizeCfText,
  translateWorkersAiStream
} from '../relay/src/sse'
import { buildCfInput, dataUrlToBytes, parseChatBody } from '../relay/src/upstream'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}

describe('SSE helpers', () => {
  it('encodes OpenAI chunks and done markers', () => {
    const chunk = openAiChunk('hi', 'scout-vision-1', 'id', 123)
    expect(chunk.startsWith('data: ')).toBe(true)
    const parsed = JSON.parse(chunk.slice(5).trim())
    expect(parsed.choices[0].delta.content).toBe('hi')
    expect(parsed.model).toBe('scout-vision-1')
    expect(openAiDone()).toBe('data: [DONE]\n\n')
  })

  it('drains complete lines and keeps the partial remainder', () => {
    const { lines, rest } = drainSseLines('data: a\n\ndata: b\ndata: par')
    expect(lines).toEqual(['data: a', 'data: b'])
    expect(rest).toBe('data: par')
  })

  it('normalizes CRLF line endings', () => {
    const { lines } = drainSseLines('data: a\r\ndata: b\r\n')
    expect(lines).toEqual(['data: a', 'data: b'])
  })

  it('parses Workers AI chunks and ignores junk', () => {
    expect(parseWorkersAiLine('data: {"response":"hello"}')).toBe('hello')
    expect(parseWorkersAiLine('data: {"response":""}')).toBe('')
    expect(parseWorkersAiLine('data: [DONE]')).toBe('')
    expect(parseWorkersAiLine('event: ping')).toBe('')
    expect(parseWorkersAiLine('data: not-json')).toBe('')
  })

  it('strips leaked control tokens', () => {
    expect(sanitizeCfText('Done<|eot_id|>')).toBe('Done')
  })
})

describe('translateWorkersAiStream', () => {
  it('rewrites Workers AI chunks into OpenAI deltas and terminates with [DONE]', async () => {
    const source = streamOf([
      'data: {"response":"The "}\n\n',
      'data: {"response":"answer is 42."}\n\n',
      'data: [DONE]\n\n'
    ])
    const output = await readAll(translateWorkersAiStream(source, 'scout-vision-1', 'id', 1))
    expect(output).toContain('"content":"The "')
    expect(output).toContain('"content":"answer is 42."')
    expect(output.trim().endsWith('data: [DONE]')).toBe(true)
  })

  it('handles chunk boundaries splitting a JSON line', async () => {
    const source = streamOf(['data: {"resp', 'onse":"split"}\n\n'])
    const output = await readAll(translateWorkersAiStream(source, 'm', 'id', 1))
    expect(output).toContain('"content":"split"')
  })

  it('always emits [DONE], even for an empty upstream', async () => {
    const output = await readAll(translateWorkersAiStream(streamOf([]), 'm', 'id', 1))
    expect(output).toBe('data: [DONE]\n\n')
  })
})

describe('request shaping', () => {
  it('validates the public model id and message array', () => {
    expect(parseChatBody('not json', 'scout-vision-1').ok).toBe(false)
    expect(parseChatBody(JSON.stringify({ messages: [] }), 'scout-vision-1').ok).toBe(false)
    expect(parseChatBody(JSON.stringify({ model: 'other', messages: [{ role: 'user', content: 'hi' }] }), 'scout-vision-1').ok).toBe(false)
    expect(parseChatBody(JSON.stringify({ model: 'scout-vision-1', messages: [{ role: 'user', content: 'hi' }] }), 'scout-vision-1').ok).toBe(true)
  })

  it('extracts the image from the last user turn and flattens text', () => {
    const body = {
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'sure' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }
          ]
        }
      ],
      max_tokens: 2048
    }
    const input = buildCfInput(body)
    expect(input).not.toBeNull()
    if (!input) return
    expect(input.messages[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(input.messages[input.messages.length - 1]).toEqual({ role: 'user', content: 'What is this?' })
    expect(input.image?.[0]).toEqual(new Uint8Array([65, 66, 67]))
    expect(input.maxTokens).toBe(1024) // clamped for the small fallback model
  })

  it('rejects data URLs that are not images', () => {
    expect(dataUrlToBytes('data:image/png;base64,QUJD')).toEqual(new Uint8Array([65, 66, 67]))
    expect(dataUrlToBytes('nonsense')).toBeNull()
  })
})
